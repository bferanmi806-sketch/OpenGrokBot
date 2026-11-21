import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listActions, recordAction } from '../src/actions.js'
import {
  ensureGroupThread,
  getMessage,
  insertMessage,
  listMessages,
  openDb,
  SCHEMA_VERSION,
  schemaVersion,
  upsertBot,
} from '../src/db.js'
import {
  createDispatchPlanManager,
  findWaitingStepByApproval,
  findWaitingStepByQuestion,
  formatUpstreamOutputs,
  getDispatchPlan,
  listDispatchPlans,
  MAX_DISPATCH_STEPS,
  MAX_PLAN_TITLE_CHARS,
  MAX_STEP_ERROR_CHARS,
  MAX_STEP_INSTRUCTIONS_CHARS,
  MAX_STEP_OUTPUT_CHARS,
  reconcileStaleDispatchPlans,
  STALE_PIPELINE_RESTART_ERROR,
  validateDispatchSteps,
  type DispatchPlanPayload,
  type DispatchPlanView,
  type DispatchStepRunContext,
} from '../src/dispatch-plans.js'
import { createHub, type GatewayEvent } from '../src/hub.js'
import {
  MAX_TEAM_CHARTER_CHARS,
  readTeamCharter,
  safeThreadDirName,
  teamCharterPath,
  writeTeamCharter,
} from '../src/team-charter.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'osb-dispatch-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function setupHub() {
  const hub = createHub()
  const events: GatewayEvent[] = []
  hub.add({ send: (raw) => events.push(JSON.parse(raw) as GatewayEvent) })
  return { hub, events }
}

function seedGroup(db: ReturnType<typeof openDb>, threadId = 'group:offsite-crew') {
  for (const [id, name] of [
    ['chief', 'Chief'],
    ['scout', 'Scout'],
    ['analyst', 'Analyst'],
    ['writer', 'Writer'],
    ['ops', 'Ops'],
  ] as const) {
    upsertBot(db, { id, name, role: 'teammate', emoji: '🤖', soul_path: '' })
  }
  const members = ['chief', 'scout', 'analyst', 'writer', 'ops']
  ensureGroupThread(db, threadId, 'Offsite Crew', members)
  return { threadId, allowedBotIds: new Set(members) }
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('schema v17, pipeline trigger & hub events', () => {
  it('migrates a fresh DB to v17 with dispatch_plans, dispatch_plan_steps & all 4 indexes', () => {
    const db = openDb(':memory:')
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(17)
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(tables).toEqual(expect.arrayContaining(['dispatch_plans', 'dispatch_plan_steps']))

    const planCols = (db.pragma('table_info(dispatch_plans)') as { name: string }[]).map((c) => c.name)
    expect(planCols).toEqual([
      'id',
      'thread_id',
      'created_by',
      'title',
      'status',
      'source_tainted',
      'message_id',
      'error',
      'created_at',
      'started_at',
      'finished_at',
    ])

    const stepCols = (db.pragma('table_info(dispatch_plan_steps)') as { name: string }[]).map((c) => c.name)
    expect(stepCols).toEqual([
      'plan_id',
      'step_id',
      'seq',
      'bot_id',
      'title',
      'instructions',
      'depends_on_json',
      'status',
      'output',
      'error',
      'output_tainted',
      'waiting_approval_id',
      'waiting_question_id',
      'started_at',
      'finished_at',
    ])

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_dispatch_plans_thread',
      'idx_dispatch_plans_status',
      'idx_dispatch_plan_steps_plan',
      'idx_dispatch_plan_steps_wait',
    ]))

    const { threadId } = seedGroup(db)
    recordAction(db, {
      botId: 'chief',
      threadId,
      trigger: 'pipeline',
      tool: 'dispatch_plan',
      summary: 'draft: Q4 offsite',
      ok: true,
      at: 1000,
    })
    expect(listActions(db, 'chief')[0]).toMatchObject({
      trigger: 'pipeline',
      tool: 'dispatch_plan',
      ok: true,
    })

    const { hub, events } = setupHub()
    const samplePlan: DispatchPlanView = {
      id: 'dp-01020304',
      threadId,
      createdBy: 'chief',
      title: 'Offsite prep',
      status: 'draft',
      sourceTainted: false,
      messageId: 1,
      error: '',
      steps: [],
      createdAt: 1000,
      startedAt: null,
      finishedAt: null,
    }
    hub.broadcast({ type: 'dispatch_plan_changed', threadId, plan: samplePlan })
    hub.broadcast({ type: 'team_charter_changed', threadId })
    expect(events).toEqual([
      { type: 'dispatch_plan_changed', threadId, plan: samplePlan },
      { type: 'team_charter_changed', threadId },
    ])

    db.close()
  })

  it('upgrades an existing v16 database file seamlessly to v17', () => {
    const dir = makeTempDir('osb-v16-upgrade-')
    const dbPath = join(dir, 'opensuperbot.db')

    const initial = openDb(dbPath)
    const { threadId } = seedGroup(initial)
    insertMessage(initial, { threadId, sender: 'user', kind: 'text', content: 'v16 group message' })
    initial.exec(`
      DROP INDEX IF EXISTS idx_dispatch_plan_steps_wait;
      DROP INDEX IF EXISTS idx_dispatch_plan_steps_plan;
      DROP TABLE IF EXISTS dispatch_plan_steps;
      DROP INDEX IF EXISTS idx_dispatch_plans_status;
      DROP INDEX IF EXISTS idx_dispatch_plans_thread;
      DROP TABLE IF EXISTS dispatch_plans;
    `)
    initial.pragma('user_version = 16')
    initial.close()

    const migrated: Array<[number, number]> = []
    const upgraded = openDb(dbPath, { onMigrate: (from, to) => migrated.push([from, to]) })
    expect(migrated).toEqual([[16, SCHEMA_VERSION]])
    expect(schemaVersion(upgraded)).toBe(SCHEMA_VERSION)
    expect(listMessages(upgraded, threadId).map((m) => m.content)).toEqual(['v16 group message'])

    const indexes = (
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_dispatch_plans_thread',
      'idx_dispatch_plans_status',
      'idx_dispatch_plan_steps_plan',
      'idx_dispatch_plan_steps_wait',
    ]))
    expect(listDispatchPlans(upgraded)).toEqual([])
    upgraded.close()
  })
})

describe('team-charter store', () => {
  it('generates Windows-safe, traversal-safe, collision-free directory names', () => {
    const crew = safeThreadDirName('group:offsite-crew')
    expect(crew).toMatch(/^group_offsite-crew-[0-9a-f]{8}$/)
    expect(crew).not.toContain(':')

    // Windows reserved device names (including dotted forms)
    for (const reserved of ['con', 'CON', 'con.txt', 'prn', 'aux', 'nul', 'com1', 'COM9', 'lpt1', 'lpt9.md']) {
      const safe = safeThreadDirName(reserved)
      expect(safe).toMatch(/^group_[a-zA-Z0-9._-]+-[0-9a-f]{8}$/)
      expect(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)).toBe(false)
    }

    // Path traversal attempts stay strictly under groups/
    const root = makeTempDir('osb-charter-safe-')
    const groupsRoot = resolve(root, 'groups')
    for (const tricky of ['../escape', '../../etc/passwd', '..\\..\\win', '...', '   ', '---']) {
      const dirName = safeThreadDirName(tricky)
      expect(dirName).not.toContain('..')
      expect(dirName).not.toMatch(/[/\\:]/)
      expect(dirName).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*-[0-9a-f]{8}$/)
      const fullPath = resolve(teamCharterPath(root, tricky))
      expect(fullPath.startsWith(`${groupsRoot}/`) || fullPath.startsWith(`${groupsRoot}\\`)).toBe(true)
    }

    // Distinct thread IDs with identical sanitized prefixes do not collide
    expect(safeThreadDirName('group:a/b')).not.toBe(safeThreadDirName('group:a:b'))

    // Long prefixes are clamped to <= 40 chars (+ '-' + 8-char hash <= 49)
    const longDir = safeThreadDirName(`group:${'x'.repeat(120)}`)
    expect(longDir.length).toBeLessThanOrEqual(49)
    expect(longDir).toMatch(/-[0-9a-f]{8}$/)
  })

  it('reads, atomically writes, updates, validates size limits, and clears team.md', async () => {
    const dataDir = makeTempDir('osb-charter-')
    const threadId = 'group:offsite-crew'

    // Missing charter reads as empty
    expect(await readTeamCharter(dataDir, threadId)).toEqual({ content: '', updatedAt: null })

    // Non-string & oversized content rejected
    expect(await writeTeamCharter(dataDir, threadId, 123 as unknown as string))
      .toMatchObject({ ok: false, code: 'invalid_content' })
    expect(await writeTeamCharter(dataDir, threadId, 'a'.repeat(MAX_TEAM_CHARTER_CHARS + 1)))
      .toMatchObject({ ok: false, code: 'invalid_content' })

    // Exact max size succeeds
    const maxRes = await writeTeamCharter(dataDir, threadId, 'm'.repeat(MAX_TEAM_CHARTER_CHARS))
    expect(maxRes.ok).toBe(true)
    if (!maxRes.ok) throw new Error('expected max-size write to succeed')
    expect(maxRes.content).toHaveLength(MAX_TEAM_CHARTER_CHARS)
    expect(maxRes.updatedAt).toBeTypeOf('number')

    // CRLF normalized to LF and overwrites atomically without leaving temp files
    const written = await writeTeamCharter(dataDir, threadId, '# Team Charter\r\n- Scout researches\r\n- Writer drafts\r\n')
    expect(written.ok).toBe(true)
    if (!written.ok) throw new Error('expected write ok')
    expect(written.content).toBe('# Team Charter\n- Scout researches\n- Writer drafts\n')
    expect(written.updatedAt).toBeTypeOf('number')

    const readBack = await readTeamCharter(dataDir, threadId)
    expect(readBack.content).toBe('# Team Charter\n- Scout researches\n- Writer drafts\n')
    expect(readBack.updatedAt).toBe(written.updatedAt)

    const charterFile = teamCharterPath(dataDir, threadId)
    expect(existsSync(charterFile)).toBe(true)
    expect(readdirSync(dirname(charterFile))).toEqual(['team.md'])

    // Clearing with whitespace removes team.md cleanly
    const cleared = await writeTeamCharter(dataDir, threadId, '   \r\n\t ')
    expect(cleared).toEqual({ ok: true, content: '', updatedAt: null })
    expect(existsSync(charterFile)).toBe(false)
    expect(await readTeamCharter(dataDir, threadId)).toEqual({ content: '', updatedAt: null })
  })
})

describe('validateDispatchSteps', () => {
  const allowed = new Set(['chief', 'scout', 'analyst', 'writer', 'ops'])

  it('orders linear and diamond DAGs topologically and computes exact wave depths', () => {
    const linear = validateDispatchSteps(
      [
        { id: 'S3', botId: 'writer', title: 'Draft', instructions: 'Write summary', dependsOn: ['S2'] },
        { id: 's1', botId: 'scout', title: 'Research', instructions: 'Gather data' },
        { id: 's2', botId: 'analyst', title: 'Price', instructions: 'Compare pricing', dependsOn: ['s1', 's1'] },
      ],
      allowed,
    )
    expect(linear.ok).toBe(true)
    if (!linear.ok) throw new Error('expected valid linear DAG')
    expect(linear.steps.map((s) => ({ id: s.id, seq: s.seq, wave: s.wave, dependsOn: s.dependsOn }))).toEqual([
      { id: 's1', seq: 0, wave: 0, dependsOn: [] },
      { id: 's2', seq: 1, wave: 1, dependsOn: ['s1'] },
      { id: 's3', seq: 2, wave: 2, dependsOn: ['s2'] },
    ])

    // Diamond + asymmetric join: s1(w0), s2(w0) -> s3(w1 on s1,s2) -> s4(w2 on s1,s3)
    const diamond = validateDispatchSteps(
      [
        { id: 's4', botId: 'ops', title: 'Publish', instructions: 'Ship it', dependsOn: ['s1', 's3'] },
        { id: 's3', botId: 'writer', title: 'Synthesize', instructions: 'Combine', dependsOn: ['s1', 's2'] },
        { id: 's1', botId: 'scout', title: 'Venues', instructions: 'Find venues' },
        { id: 's2', botId: 'analyst', title: 'Budget', instructions: 'Model budget' },
      ],
      allowed,
    )
    expect(diamond.ok).toBe(true)
    if (!diamond.ok) throw new Error('expected valid diamond DAG')
    expect(diamond.steps.map((s) => ({ id: s.id, seq: s.seq, wave: s.wave }))).toEqual([
      { id: 's1', seq: 0, wave: 0 },
      { id: 's2', seq: 1, wave: 0 },
      { id: 's3', seq: 2, wave: 1 },
      { id: 's4', seq: 3, wave: 2 },
    ])
  })

  it('rejects malformed steps, invalid IDs, duplicates, non-members, unknown/self deps, cycles, and > 12 steps', () => {
    expect(validateDispatchSteps('not-array', allowed).ok).toBe(false)
    expect(validateDispatchSteps([], allowed).ok).toBe(false)

    // > 12 steps rejected
    const tooMany = Array.from({ length: MAX_DISPATCH_STEPS + 1 }, (_, i) => ({
      id: `s${i + 1}`,
      botId: 'scout',
      title: `Step ${i + 1}`,
      instructions: 'Do work',
    }))
    const tooManyRes = validateDispatchSteps(tooMany, allowed)
    expect(tooManyRes.ok).toBe(false)
    if (!tooManyRes.ok) expect(tooManyRes.error).toContain(String(MAX_DISPATCH_STEPS))

    // Invalid step IDs
    for (const badId of ['', '   ', '_lead', '-lead', 'has space', 'a'.repeat(33)]) {
      expect(
        validateDispatchSteps([{ id: badId, botId: 'scout', title: 'T', instructions: 'I' }], allowed).ok,
      ).toBe(false)
    }

    // Duplicate IDs (case-insensitive)
    const dupRes = validateDispatchSteps(
      [
        { id: 'step_1', botId: 'scout', title: 'A', instructions: 'Do A' },
        { id: 'STEP_1', botId: 'analyst', title: 'B', instructions: 'Do B' },
      ],
      allowed,
    )
    expect(dupRes.ok).toBe(false)
    if (!dupRes.ok) expect(dupRes.error).toContain('Duplicate')

    // Non-member botId
    const nonMember = validateDispatchSteps(
      [{ id: 's1', botId: 'outsider', title: 'A', instructions: 'Do A' }],
      allowed,
    )
    expect(nonMember.ok).toBe(false)
    if (!nonMember.ok) expect(nonMember.error).toContain('outsider')

    // Invalid instructions length
    expect(
      validateDispatchSteps(
        [{ id: 's1', botId: 'scout', title: 'A', instructions: 'x'.repeat(MAX_STEP_INSTRUCTIONS_CHARS + 1) }],
        allowed,
      ).ok,
    ).toBe(false)

    // Unknown dependency
    const unknownDep = validateDispatchSteps(
      [{ id: 's1', botId: 'scout', title: 'A', instructions: 'Do A', dependsOn: ['missing'] }],
      allowed,
    )
    expect(unknownDep.ok).toBe(false)
    if (!unknownDep.ok) expect(unknownDep.error).toContain('missing')

    // Self-dependency
    const selfDep = validateDispatchSteps(
      [{ id: 's1', botId: 'scout', title: 'A', instructions: 'Do A', dependsOn: ['s1'] }],
      allowed,
    )
    expect(selfDep.ok).toBe(false)
    if (!selfDep.ok) expect(selfDep.error).toContain('itself')

    // 2-node cycle
    const cycle2 = validateDispatchSteps(
      [
        { id: 'a', botId: 'scout', title: 'A', instructions: 'Do A', dependsOn: ['b'] },
        { id: 'b', botId: 'analyst', title: 'B', instructions: 'Do B', dependsOn: ['a'] },
      ],
      allowed,
    )
    expect(cycle2.ok).toBe(false)
    if (!cycle2.ok) {
      expect(cycle2.error).toContain('cycle')
      expect(cycle2.error).toContain('a')
      expect(cycle2.error).toContain('b')
    }

    // 3-node cycle with extra downstream node 'step_d' (should specifically name step_a, step_b, step_c)
    const cycle3 = validateDispatchSteps(
      [
        { id: 'step_a', botId: 'scout', title: 'A', instructions: 'Do A', dependsOn: ['step_c'] },
        { id: 'step_b', botId: 'analyst', title: 'B', instructions: 'Do B', dependsOn: ['step_a'] },
        { id: 'step_c', botId: 'writer', title: 'C', instructions: 'Do C', dependsOn: ['step_b'] },
        { id: 'step_d', botId: 'ops', title: 'D', instructions: 'Do D', dependsOn: ['step_c'] },
      ],
      allowed,
    )
    expect(cycle3.ok).toBe(false)
    if (!cycle3.ok) {
      expect(cycle3.error).toContain('step_a')
      expect(cycle3.error).toContain('step_b')
      expect(cycle3.error).toContain('step_c')
      expect(cycle3.error).not.toContain('step_d')
    }
  })
})

describe('createDispatchPlanManager', () => {
  it('creates draft plans without running them and rejects double-start or invalid inputs', async () => {
    const db = openDb(':memory:')
    const { threadId, allowedBotIds } = seedGroup(db)
    const { hub, events } = setupHub()
    const ran: string[] = []
    const release = createDeferred()

    const manager = createDispatchPlanManager({
      db,
      hub,
      runStep: async (ctx) => {
        ran.push(ctx.step.id)
        await release.promise
        return { status: 'completed', output: 'done', tainted: false }
      },
    })

    // Validation failures
    expect(
      manager.createPlan({
        threadId,
        createdBy: 'chief',
        title: '   ',
        steps: [{ id: 's1', botId: 'scout', title: 'Research', instructions: 'Go' }],
        allowedBotIds,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_title' })

    expect(
      manager.createPlan({
        threadId,
        createdBy: 'chief',
        title: 'T'.repeat(MAX_PLAN_TITLE_CHARS + 1),
        steps: [{ id: 's1', botId: 'scout', title: 'Research', instructions: 'Go' }],
        allowedBotIds,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_title' })

    expect(
      manager.createPlan({
        threadId,
        createdBy: 'chief',
        title: 'Bad steps',
        steps: [],
        allowedBotIds,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_steps' })

    // Create valid draft plan
    const created = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: '  Q4\nOffsite\tPlan  ',
      steps: [{ id: 's1', botId: 'scout', title: 'Find venues', instructions: 'Check 3 cities' }],
      allowedBotIds,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('expected draft creation ok')

    expect(created.plan.id).toMatch(/^dp-[0-9a-f]{8}$/)
    expect(created.plan.title).toBe('Q4 Offsite Plan')
    expect(created.plan.status).toBe('draft')
    expect(created.plan.messageId).toBeGreaterThan(0)
    expect(created.plan.steps[0]!.status).toBe('pending')

    // Confirm nothing runs while in draft
    await new Promise((r) => setTimeout(r, 20))
    expect(ran).toEqual([])
    expect(manager.hasActive()).toBe(false)

    // Thread chip message & WS events emitted
    const msg = getMessage(db, created.plan.messageId!)
    expect(msg?.kind).toBe('dispatch_plan')
    expect((msg?.payload as DispatchPlanPayload).planId).toBe(created.plan.id)
    expect((msg?.payload as DispatchPlanPayload).status).toBe('draft')
    expect(events.some((e) => e.type === 'message' && e.message.kind === 'dispatch_plan')).toBe(true)
    expect(events.some((e) => e.type === 'dispatch_plan_changed' && e.plan.id === created.plan.id)).toBe(true)

    // Missing plan -> not_found
    expect(manager.startPlan('dp-missing')).toMatchObject({ ok: false, code: 'not_found' })

    // Start plan -> transitions draft -> running and rejects double-start
    const started = manager.startPlan(created.plan.id)
    expect(started.ok).toBe(true)
    if (!started.ok) throw new Error('expected startPlan ok')
    expect(started.plan.status).toBe('running')
    expect(started.plan.steps[0]!.status).toBe('running')
    expect(manager.hasActive()).toBe(true)
    expect(manager.hasActive('scout')).toBe(true)
    expect(manager.hasActive('analyst')).toBe(false)
    expect(manager.activePlanCount()).toBe(1)
    expect(manager.activeBotIds()).toEqual(['scout'])

    expect(manager.startPlan(created.plan.id)).toMatchObject({ ok: false, code: 'invalid_state' })

    release.resolve()
    await waitFor(() => !manager.hasActive())
    expect(ran).toEqual(['s1'])
    expect(getDispatchPlan(db, created.plan.id)?.status).toBe('completed')
    expect(manager.startPlan(created.plan.id)).toMatchObject({ ok: false, code: 'invalid_state' })

    db.close()
  })

  it('executes diamond DAG in parallel across bots, serializes same-bot steps, and propagates fenced upstream outputs & taint', async () => {
    const db = openDb(':memory:')
    const { threadId, allowedBotIds } = seedGroup(db)
    const { hub } = setupHub()

    const s1Started = createDeferred()
    const s2Started = createDeferred()
    const s1Gate = createDeferred()
    const s2Gate = createDeferred()
    let s3Ctx: DispatchStepRunContext | null = null
    let s4Ctx: DispatchStepRunContext | null = null
    let maxScoutConcurrent = 0
    let activeScout = 0
    const order: string[] = []

    const manager = createDispatchPlanManager({
      db,
      hub,
      runStep: async (ctx) => {
        order.push(`start:${ctx.step.id}`)
        if (ctx.step.botId === 'scout') {
          activeScout++
          maxScoutConcurrent = Math.max(maxScoutConcurrent, activeScout)
        }
        try {
          if (ctx.step.id === 's1') {
            s1Started.resolve()
            await s1Gate.promise
            return { status: 'completed', output: 'Clean internal hotel notes', tainted: false }
          }
          if (ctx.step.id === 's2') {
            s2Started.resolve()
            await s2Gate.promise
            return { status: 'completed', output: 'External web pricing: $420/night', tainted: true }
          }
          if (ctx.step.id === 's3') {
            s3Ctx = ctx
            // Returns tainted: false, but MUST inherit outputTainted: true from initialTainted!
            return { status: 'completed', output: 'Combined proposal ready', tainted: false }
          }
          if (ctx.step.id === 's4') {
            s4Ctx = ctx
            return { status: 'completed', output: 'Internal logistics checklist', tainted: false }
          }
          return { status: 'completed', output: 'Second scout root finished', tainted: false }
        } finally {
          if (ctx.step.botId === 'scout') activeScout--
          order.push(`end:${ctx.step.id}`)
        }
      },
    })

    const created = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Offsite Venue & Budget',
      steps: [
        { id: 's1', botId: 'scout', title: 'Internal venue shortlist', instructions: 'List venues' },
        { id: 's1b', botId: 'scout', title: 'Backup dates', instructions: 'Check calendar' },
        { id: 's2', botId: 'analyst', title: 'Market pricing', instructions: 'Check rates' },
        { id: 's3', botId: 'writer', title: 'Draft proposal', instructions: 'Merge shortlist + pricing', dependsOn: ['s1', 's2'] },
        { id: 's4', botId: 'ops', title: 'Logistics check', instructions: 'Check internal ops only', dependsOn: ['s1'] },
      ],
      allowedBotIds,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('expected createPlan ok')

    const started = manager.startPlan(created.plan.id)
    expect(started.ok).toBe(true)

    // s1 (scout) and s2 (analyst) start concurrently; s1b (also scout) waits for s1
    await Promise.all([s1Started.promise, s2Started.promise])
    expect(manager.activeBotIds().sort()).toEqual(['analyst', 'scout'])
    const midPlan = getDispatchPlan(db, created.plan.id)!
    expect(midPlan.steps.find((s) => s.id === 's1b')?.status).toBe('pending')
    expect(midPlan.steps.find((s) => s.id === 's3')?.status).toBe('pending')

    // Release s1 -> s4 and s1b can start, while s3 STILL waits for s2
    s1Gate.resolve()
    await waitFor(() => order.includes('end:s4') && order.includes('end:s1b'))
    expect(s3Ctx).toBeNull()
    expect(maxScoutConcurrent).toBe(1)
    expect(order.indexOf('end:s1')).toBeLessThan(order.indexOf('start:s1b'))

    // Release s2 -> s3 runs with both upstream outputs and inherits taint from s2
    s2Gate.resolve()
    await waitFor(() => !manager.hasActive())

    expect(s3Ctx).not.toBeNull()
    expect(s3Ctx!.initialTainted).toBe(true)
    expect(s3Ctx!.upstream).toEqual([
      { stepId: 's1', botId: 'scout', title: 'Internal venue shortlist', output: 'Clean internal hotel notes', tainted: false },
      { stepId: 's2', botId: 'analyst', title: 'Market pricing', output: 'External web pricing: $420/night', tainted: true },
    ])
    const formatted = formatUpstreamOutputs(s3Ctx!.upstream)
    expect(formatted).toContain('[upstream step s1 by @scout: Internal venue shortlist]')
    expect(formatted).toContain('Clean internal hotel notes')
    expect(formatted).toContain('[upstream step s2 by @analyst: Market pricing]')
    expect(formatted).toContain('External web pricing: $420/night')

    // s4 only depended on clean s1 -> stays untainted!
    expect(s4Ctx).not.toBeNull()
    expect(s4Ctx!.initialTainted).toBe(false)

    const done = getDispatchPlan(db, created.plan.id)!
    expect(done.status).toBe('completed')
    expect(done.finishedAt).not.toBeNull()
    expect(done.steps.find((s) => s.id === 's1')?.outputTainted).toBe(false)
    expect(done.steps.find((s) => s.id === 's2')?.outputTainted).toBe(true)
    expect(done.steps.find((s) => s.id === 's3')?.outputTainted).toBe(true)
    expect(done.steps.find((s) => s.id === 's4')?.outputTainted).toBe(false)

    // Verify sourceTainted propagates even to Wave 0 steps
    const taintedPlan = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Tainted source plan',
      sourceTainted: true,
      steps: [{ id: 't1', botId: 'ops', title: 'Check', instructions: 'Run' }],
      allowedBotIds,
    })
    expect(taintedPlan.ok).toBe(true)
    if (!taintedPlan.ok) throw new Error('expected createPlan ok')
    manager.startPlan(taintedPlan.plan.id)
    await waitFor(() => !manager.hasActive())
    expect(getDispatchPlan(db, taintedPlan.plan.id)?.steps[0]?.outputTainted).toBe(true)

    // Verify listDispatchPlans filtering & clamping
    expect(listDispatchPlans(db, { threadId })).toHaveLength(2)
    expect(listDispatchPlans(db, { threadId, status: 'completed' })).toHaveLength(2)
    expect(listDispatchPlans(db, { threadId, limit: 1 })).toHaveLength(1)
    expect(listDispatchPlans(db, { threadId, limit: Number.NaN })).toHaveLength(2)
    expect(listDispatchPlans(db, { threadId: 'group:other' })).toEqual([])

    db.close()
  })

  it('pauses on waiting_approval and waiting_question, then resumes downstream with propagated taint', async () => {
    const db = openDb(':memory:')
    const { threadId, allowedBotIds } = seedGroup(db)
    const { hub } = setupHub()

    let s2Ctx: DispatchStepRunContext | null = null
    let s3Ctx: DispatchStepRunContext | null = null

    const manager = createDispatchPlanManager({
      db,
      hub,
      runStep: async (ctx) => {
        if (ctx.step.id === 's1') {
          return { status: 'waiting_approval', approvalId: 77, output: 'Draft queued for approval', tainted: false }
        }
        if (ctx.step.id === 's2') {
          s2Ctx = ctx
          return { status: 'waiting_approval', questionId: 88, tainted: false }
        }
        s3Ctx = ctx
        return { status: 'completed', output: 'X'.repeat(MAX_STEP_OUTPUT_CHARS + 50), tainted: false }
      },
    })

    const created = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Approval & Question Pipeline',
      steps: [
        { id: 's1', botId: 'scout', title: 'Send vendor inquiry', instructions: 'Email vendor' },
        { id: 's2', botId: 'analyst', title: 'Confirm budget cap', instructions: 'Ask operator', dependsOn: ['s1'] },
        { id: 's3', botId: 'writer', title: 'Finalize memo', instructions: 'Summarize', dependsOn: ['s2'] },
      ],
      allowedBotIds,
    })
    if (!created.ok) throw new Error('createPlan failed')

    manager.startPlan(created.plan.id)
    await waitFor(() => getDispatchPlan(db, created.plan.id)?.status === 'paused')
    expect(manager.hasActive()).toBe(false)

    const paused1 = getDispatchPlan(db, created.plan.id)!
    expect(paused1.steps[0]).toMatchObject({
      id: 's1',
      status: 'waiting_approval',
      waitingApprovalId: 77,
      waitingQuestionId: null,
      finishedAt: null,
    })
    expect(paused1.steps[1]?.status).toBe('pending')
    expect(findWaitingStepByApproval(db, 77)).toEqual({ planId: created.plan.id, stepId: 's1' })
    expect(findWaitingStepByApproval(db, 999)).toBeNull()

    // Approve s1 with tainted: true -> unblocks s2 with initialTainted: true
    const resumed1 = manager.resumeStepAfterWait({
      approvalId: 77,
      outcome: 'completed',
      output: 'Vendor replied with external link',
      tainted: true,
    })
    expect(resumed1?.status).toBe('running')
    expect(findWaitingStepByApproval(db, 77)).toBeNull()

    // Wait for s2 to pause on question 88
    await waitFor(() => getDispatchPlan(db, created.plan.id)?.status === 'paused')
    expect(s2Ctx).not.toBeNull()
    expect(s2Ctx!.initialTainted).toBe(true)
    expect(s2Ctx!.upstream[0]?.output).toBe('Vendor replied with external link')
    expect(findWaitingStepByQuestion(db, 88)).toEqual({ planId: created.plan.id, stepId: 's2' })

    // Answer question 88 -> unblocks s3 and completes plan (taint persists through s2 -> s3!)
    const resumed2 = manager.resumeStepAfterWait({
      questionId: 88,
      outcome: 'completed',
      output: 'Operator approved $15k cap',
      tainted: false,
    })
    expect(resumed2?.status).toBe('running')

    await waitFor(() => !manager.hasActive())
    expect(s3Ctx).not.toBeNull()
    expect(s3Ctx!.initialTainted).toBe(true)

    const finalPlan = getDispatchPlan(db, created.plan.id)!
    expect(finalPlan.status).toBe('completed')
    expect(finalPlan.steps[0]?.outputTainted).toBe(true)
    expect(finalPlan.steps[1]?.outputTainted).toBe(true)
    expect(finalPlan.steps[2]?.outputTainted).toBe(true)
    expect(finalPlan.steps[2]?.output).toHaveLength(MAX_STEP_OUTPUT_CHARS)
    expect(finalPlan.steps[2]?.output.endsWith('...')).toBe(true)

    db.close()
  })

  it('marks step failed and skips transitive dependents on discard/error while allowing independent branches to finish', async () => {
    const db = openDb(':memory:')
    const { threadId, allowedBotIds } = seedGroup(db)
    const { hub } = setupHub()

    const s2Started = createDeferred()
    const s2Gate = createDeferred()

    const manager = createDispatchPlanManager({
      db,
      hub,
      runStep: async (ctx) => {
        if (ctx.step.id === 's1') {
          return { status: 'waiting_approval', approvalId: 99, tainted: false }
        }
        if (ctx.step.id === 's2') {
          s2Started.resolve()
          await s2Gate.promise
          return { status: 'completed', output: 'Independent branch succeeded', tainted: false }
        }
        throw new Error('should not execute skipped step')
      },
    })

    const created = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Branching failure test',
      steps: [
        { id: 's1', botId: 'scout', title: 'External send', instructions: 'Send email' },
        { id: 's2', botId: 'analyst', title: 'Independent audit', instructions: 'Audit numbers' },
        { id: 's3', botId: 'writer', title: 'Follow-up', instructions: 'Draft follow-up', dependsOn: ['s1'] },
        { id: 's4', botId: 'ops', title: 'Archive', instructions: 'Archive thread', dependsOn: ['s3'] },
      ],
      allowedBotIds,
    })
    if (!created.ok) throw new Error('createPlan failed')

    manager.startPlan(created.plan.id)
    await s2Started.promise
    await waitFor(() => getDispatchPlan(db, created.plan.id)?.steps.find((s) => s.id === 's1')?.status === 'waiting_approval')

    // Discard s1 while s2 is still running -> s3 & s4 skipped immediately, plan stays running for s2
    const afterDiscard = manager.resumeStepAfterWait({
      approvalId: 99,
      outcome: 'failed',
      error: 'Approval discarded by operator.',
    })
    expect(afterDiscard).not.toBeNull()
    expect(afterDiscard!.status).toBe('running')
    expect(afterDiscard!.steps.find((s) => s.id === 's1')).toMatchObject({
      status: 'failed',
      error: 'Approval discarded by operator.',
      waitingApprovalId: null,
    })
    expect(afterDiscard!.steps.find((s) => s.id === 's3')?.status).toBe('skipped')
    expect(afterDiscard!.steps.find((s) => s.id === 's4')?.status).toBe('skipped')

    // Let independent s2 finish -> plan settles as failed while preserving s2's completed result
    s2Gate.resolve()
    await waitFor(() => !manager.hasActive())

    const settled = getDispatchPlan(db, created.plan.id)!
    expect(settled.status).toBe('failed')
    expect(settled.error).toBe('Approval discarded by operator.')
    expect(settled.finishedAt).not.toBeNull()
    expect(settled.steps.find((s) => s.id === 's2')?.status).toBe('completed')
    expect(settled.steps.find((s) => s.id === 's2')?.output).toBe('Independent branch succeeded')
    expect(settled.steps.find((s) => s.id === 's3')?.status).toBe('skipped')
    expect(settled.steps.find((s) => s.id === 's4')?.status).toBe('skipped')

    // Also test direct thrown error clamping
    const crashManager = createDispatchPlanManager({
      db,
      hub,
      runStep: async () => {
        throw new Error('E'.repeat(MAX_STEP_ERROR_CHARS + 40))
      },
    })
    const crashPlan = crashManager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Throw error test',
      steps: [
        { id: 'c1', botId: 'scout', title: 'Crash', instructions: 'Fail' },
        { id: 'c2', botId: 'writer', title: 'Never runs', instructions: 'Wait', dependsOn: ['c1'] },
      ],
      allowedBotIds,
    })
    if (!crashPlan.ok) throw new Error('createPlan failed')
    crashManager.startPlan(crashPlan.plan.id)
    await waitFor(() => !crashManager.hasActive())
    const crashed = getDispatchPlan(db, crashPlan.plan.id)!
    expect(crashed.status).toBe('failed')
    expect(crashed.steps[0]?.status).toBe('failed')
    expect(crashed.steps[0]?.error).toHaveLength(MAX_STEP_ERROR_CHARS)
    expect(crashed.steps[0]?.error.endsWith('...')).toBe(true)
    expect(crashed.steps[1]?.status).toBe('skipped')

    db.close()
  })

  it('cancels draft, running, and paused plans cleanly without allowing late overwrites', async () => {
    const db = openDb(':memory:')
    const { threadId, allowedBotIds } = seedGroup(db)
    const { hub, events } = setupHub()

    const s2Started = createDeferred<DispatchStepRunContext>()
    const s2Unwind = createDeferred()

    const manager = createDispatchPlanManager({
      db,
      hub,
      runStep: async (ctx) => {
        if (ctx.step.id === 's1') {
          return { status: 'completed', output: 'Stage 1 done', tainted: false }
        }
        if (ctx.step.id === 's2') {
          s2Started.resolve(ctx)
          await s2Unwind.promise
          return { status: 'completed', output: 'Should never overwrite cancelled', tainted: false }
        }
        return { status: 'waiting_approval', approvalId: 123, tainted: false }
      },
    })

    // 1. Cancel draft plan
    const draft = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Draft to cancel',
      steps: [{ id: 'd1', botId: 'scout', title: 'Wait', instructions: 'Wait' }],
      allowedBotIds,
    })
    if (!draft.ok) throw new Error('createPlan failed')
    expect(manager.cancelPlan('dp-missing')).toMatchObject({ ok: false, code: 'not_found' })
    const cancelDraft = manager.cancelPlan(draft.plan.id)
    expect(cancelDraft.ok).toBe(true)
    if (!cancelDraft.ok) throw new Error('cancel draft failed')
    expect(cancelDraft.plan.status).toBe('cancelled')
    expect(cancelDraft.plan.steps[0]?.status).toBe('cancelled')
    expect(manager.cancelPlan(draft.plan.id)).toMatchObject({ ok: false, code: 'settled' })
    expect(manager.startPlan(draft.plan.id)).toMatchObject({ ok: false, code: 'invalid_state' })

    // 2. Cancel running plan mid-flight
    const running = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Running to cancel',
      steps: [
        { id: 's1', botId: 'scout', title: 'Step 1', instructions: 'Fast' },
        { id: 's2', botId: 'analyst', title: 'Step 2', instructions: 'Slow', dependsOn: ['s1'] },
        { id: 's3', botId: 'writer', title: 'Step 3', instructions: 'Downstream', dependsOn: ['s2'] },
      ],
      allowedBotIds,
    })
    if (!running.ok) throw new Error('createPlan failed')
    manager.startPlan(running.plan.id)
    const s2Ctx = await s2Started.promise
    expect(s2Ctx.signal.aborted).toBe(false)

    const cancelledRunning = manager.cancelPlan(running.plan.id)
    expect(cancelledRunning.ok).toBe(true)
    expect(s2Ctx.signal.aborted).toBe(true)

    const eventsAfterCancel = events.filter(
      (e) => e.type === 'dispatch_plan_changed' && e.plan.id === running.plan.id,
    ).length

    s2Unwind.resolve()
    await waitFor(() => !manager.hasActive())

    const finalRunning = getDispatchPlan(db, running.plan.id)!
    expect(finalRunning.status).toBe('cancelled')
    expect(finalRunning.steps[0]?.status).toBe('completed') // already finished before cancel
    expect(finalRunning.steps[1]?.status).toBe('cancelled')
    expect(finalRunning.steps[1]?.output).toBe('')
    expect(finalRunning.steps[2]?.status).toBe('cancelled')
    expect(
      events.filter((e) => e.type === 'dispatch_plan_changed' && e.plan.id === running.plan.id).length,
    ).toBe(eventsAfterCancel)

    // 3. Cancel paused plan -> late resumeStepAfterWait returns null
    const paused = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Paused to cancel',
      steps: [{ id: 'p1', botId: 'ops', title: 'Wait approval', instructions: 'Pause' }],
      allowedBotIds,
    })
    if (!paused.ok) throw new Error('createPlan failed')
    manager.startPlan(paused.plan.id)
    await waitFor(() => getDispatchPlan(db, paused.plan.id)?.status === 'paused')

    expect(manager.cancelPlan(paused.plan.id)).toMatchObject({ ok: true })
    expect(findWaitingStepByApproval(db, 123)).toBeNull()
    expect(manager.resumeStepAfterWait({ approvalId: 123, outcome: 'completed', output: 'late' })).toBeNull()

    db.close()
  })

  it('reconciles stale running plans on startup while preserving draft and paused plans for post-restart resume', async () => {
    const db = openDb(':memory:')
    const { threadId, allowedBotIds } = seedGroup(db)
    const { hub } = setupHub()

    const runningStepStarted = createDeferred()
    const neverResolves = createDeferred()

    // Old manager simulates gateway process before crash/restart
    const oldManager = createDispatchPlanManager({
      db,
      hub,
      runStep: async (ctx) => {
        if (ctx.step.id === 'p1') {
          return { status: 'waiting_approval', approvalId: 501, output: 'Pending signoff', tainted: false }
        }
        if (ctx.step.id === 'r1') {
          return { status: 'completed', output: 'Done before crash', tainted: false }
        }
        if (ctx.step.id === 'r2') {
          runningStepStarted.resolve()
          await neverResolves.promise
        }
        return { status: 'completed', output: 'unused', tainted: false }
      },
    })

    const draftRes = oldManager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Surviving draft',
      steps: [{ id: 'd1', botId: 'scout', title: 'Not started', instructions: 'Wait' }],
      allowedBotIds,
    })
    const pausedRes = oldManager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Surviving paused plan',
      steps: [
        { id: 'p1', botId: 'scout', title: 'Needs approval', instructions: 'Ask approval' },
        { id: 'p2', botId: 'writer', title: 'After approval', instructions: 'Finish', dependsOn: ['p1'] },
      ],
      allowedBotIds,
    })
    const runningRes = oldManager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'In-flight plan during crash',
      steps: [
        { id: 'r1', botId: 'scout', title: 'Done step', instructions: 'Fast' },
        { id: 'r2', botId: 'analyst', title: 'Running step', instructions: 'In-flight', dependsOn: ['r1'] },
        { id: 'r3', botId: 'writer', title: 'Downstream pending', instructions: 'Later', dependsOn: ['r2'] },
      ],
      allowedBotIds,
    })
    if (!draftRes.ok || !pausedRes.ok || !runningRes.ok) throw new Error('createPlan failed')

    oldManager.startPlan(pausedRes.plan.id)
    oldManager.startPlan(runningRes.plan.id)
    await waitFor(() => getDispatchPlan(db, pausedRes.plan.id)?.status === 'paused')
    await runningStepStarted.promise

    // Simulate hard restart: run reconcileStaleDispatchPlans directly on persisted DB
    const reconciled = reconcileStaleDispatchPlans(db, { now: 99_999 })
    expect(reconciled).toBe(1)

    // Running plan was cancelled, running step cancelled with restart error, downstream skipped, chip patched
    const afterRunning = getDispatchPlan(db, runningRes.plan.id)!
    expect(afterRunning.status).toBe('cancelled')
    expect(afterRunning.error).toBe(STALE_PIPELINE_RESTART_ERROR)
    expect(afterRunning.finishedAt).toBe(99_999)
    expect(afterRunning.steps.find((s) => s.id === 'r1')?.status).toBe('completed')
    expect(afterRunning.steps.find((s) => s.id === 'r2')).toMatchObject({
      status: 'cancelled',
      error: STALE_PIPELINE_RESTART_ERROR,
      finishedAt: 99_999,
    })
    expect(afterRunning.steps.find((s) => s.id === 'r3')?.status).toBe('skipped')

    const runningChip = getMessage(db, afterRunning.messageId!)!.payload as DispatchPlanPayload
    expect(runningChip.status).toBe('cancelled')
    expect(runningChip.error).toBe(STALE_PIPELINE_RESTART_ERROR)

    // Draft plan preserved untouched
    const afterDraft = getDispatchPlan(db, draftRes.plan.id)!
    expect(afterDraft.status).toBe('draft')
    expect(afterDraft.steps[0]?.status).toBe('pending')

    // Paused plan preserved untouched and resumable on a brand-new manager instance!
    const afterPaused = getDispatchPlan(db, pausedRes.plan.id)!
    expect(afterPaused.status).toBe('paused')
    expect(afterPaused.steps[0]).toMatchObject({ status: 'waiting_approval', waitingApprovalId: 501 })
    expect(afterPaused.steps[1]?.status).toBe('pending')

    const resumedOutputs: string[] = []
    const newManager = createDispatchPlanManager({
      db,
      hub,
      runStep: async (ctx) => {
        resumedOutputs.push(`${ctx.step.id}:${ctx.upstream[0]?.output ?? ''}`)
        return { status: 'completed', output: 'Resumed and finished after reboot', tainted: false }
      },
    })

    const resumed = newManager.resumeStepAfterWait({
      approvalId: 501,
      outcome: 'completed',
      output: 'Approved after restart',
      tainted: false,
    })
    expect(resumed?.status).toBe('running')
    await waitFor(() => !newManager.hasActive())

    expect(resumedOutputs).toEqual(['p2:Approved after restart'])
    const completedPaused = getDispatchPlan(db, pausedRes.plan.id)!
    expect(completedPaused.status).toBe('completed')
    expect(completedPaused.steps[1]?.output).toBe('Resumed and finished after reboot')

    // Cleanly unwind oldManager's deferred promise before closing DB
    neverResolves.resolve()
    await oldManager.stopAll()
    db.close()
  })

  it('stopAll cancels and awaits all active step runners while preserving draft and paused plans', async () => {
    const db = openDb(':memory:')
    const { threadId, allowedBotIds } = seedGroup(db)
    const { hub } = setupHub()

    const startedA = createDeferred()
    const startedB = createDeferred()
    let settledCount = 0

    const manager = createDispatchPlanManager({
      db,
      hub,
      runStep: async (ctx) => {
        if (ctx.step.id === 'p1') {
          return { status: 'waiting_approval', approvalId: 601, tainted: false }
        }
        if (ctx.step.id === 'a1') startedA.resolve()
        if (ctx.step.id === 'b1') startedB.resolve()
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            setTimeout(() => {
              settledCount += 1
              resolve()
            }, 15)
          }, { once: true })
        })
        return { status: 'cancelled' }
      },
    })

    const draft = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Draft survives stopAll',
      steps: [{ id: 'd1', botId: 'scout', title: 'Wait', instructions: 'Wait' }],
      allowedBotIds,
    })
    const paused = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Paused survives stopAll',
      steps: [{ id: 'p1', botId: 'ops', title: 'Wait approval', instructions: 'Wait' }],
      allowedBotIds,
    })
    const active = manager.createPlan({
      threadId,
      createdBy: 'chief',
      title: 'Active cancelled by stopAll',
      steps: [
        { id: 'a1', botId: 'scout', title: 'Run A', instructions: 'Go A' },
        { id: 'b1', botId: 'analyst', title: 'Run B', instructions: 'Go B' },
      ],
      allowedBotIds,
    })
    if (!draft.ok || !paused.ok || !active.ok) throw new Error('createPlan failed')

    manager.startPlan(paused.plan.id)
    await waitFor(() => getDispatchPlan(db, paused.plan.id)?.status === 'paused')

    manager.startPlan(active.plan.id)
    await Promise.all([startedA.promise, startedB.promise])
    expect(manager.hasActive()).toBe(true)
    expect(manager.activePlanCount()).toBe(1)
    expect(manager.activeBotIds().sort()).toEqual(['analyst', 'scout'])

    await manager.stopAll()
    expect(settledCount).toBe(2)
    expect(manager.hasActive()).toBe(false)
    expect(manager.activePlanCount()).toBe(0)
    expect(manager.activeBotIds()).toEqual([])

    expect(getDispatchPlan(db, active.plan.id)?.status).toBe('cancelled')
    expect(getDispatchPlan(db, draft.plan.id)?.status).toBe('draft')
    expect(getDispatchPlan(db, paused.plan.id)?.status).toBe('paused')

    db.close()
  })
})
