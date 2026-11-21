import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listActions, recordAction } from '../src/actions.js'
import {
  createBackgroundTaskManager,
  getBackgroundTask,
  listBackgroundTasks,
  MAX_ACTIVE_TASKS_PER_BOT,
  MAX_BG_ERROR_CHARS,
  MAX_BG_INSTRUCTIONS_CHARS,
  MAX_BG_STEER_CHARS,
  MAX_BG_STEPS,
  MAX_BG_SUMMARY_CHARS,
  MAX_BG_TITLE_CHARS,
  reconcileStaleBackgroundTasks,
  rowToView,
  STALE_RESTART_ERROR,
  type BackgroundSteeringNote,
  type BackgroundTaskPayload,
  type BackgroundTaskRow,
  type BackgroundTaskRunContext,
  type BackgroundTaskView,
} from '../src/background-tasks.js'
import {
  BROWSER_LEASE_TOOL_NAMES,
  createBrowserLeasePool,
  formatBrowserConflict,
} from '../src/browser-lease.js'
import {
  ensureDmThread,
  getMessage,
  insertMessage,
  listMessages,
  openDb,
  SCHEMA_VERSION,
  schemaVersion,
  upsertBot,
} from '../src/db.js'
import { createHub, type GatewayEvent } from '../src/hub.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'osb-bg-'): string {
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

function seedBot(db: ReturnType<typeof openDb>, id: string, name = id): string {
  upsertBot(db, { id, name, role: 'assistant', emoji: '🤖', soul_path: '' })
  return ensureDmThread(db, id)
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

describe('schema v16, background action trigger & hub event', () => {
  it('migrates fresh DB to v16 with background_tasks table, indexes, action trigger & hub event', () => {
    const db = openDb(':memory:')
    expect(SCHEMA_VERSION).toBe(16)
    expect(schemaVersion(db)).toBe(16)

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(tables).toContain('background_tasks')

    const cols = (db.pragma('table_info(background_tasks)') as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual([
      'id',
      'bot_id',
      'thread_id',
      'title',
      'instructions',
      'status',
      'step_count',
      'last_step',
      'steps_json',
      'summary',
      'error',
      'uses_browser',
      'source_tainted',
      'message_id',
      'created_at',
      'started_at',
      'finished_at',
    ])

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_background_tasks_bot',
      'idx_background_tasks_status',
    ]))

    const threadId = seedBot(db, 'scout', 'Scout')
    recordAction(db, {
      botId: 'scout',
      threadId,
      trigger: 'background',
      tool: 'wiki_upsert',
      summary: 'updated report in background',
      ok: true,
      at: 1000,
    })
    expect(listActions(db, 'scout')[0]).toMatchObject({
      trigger: 'background',
      tool: 'wiki_upsert',
      ok: true,
    })

    const { hub, events } = setupHub()
    const sampleTask: BackgroundTaskView = {
      id: 'bg-01020304',
      botId: 'scout',
      threadId,
      title: 'Research competitors',
      instructions: 'Check top 3 sites',
      status: 'queued',
      stepCount: 0,
      lastStep: '',
      steps: [],
      summary: '',
      error: '',
      usesBrowser: false,
      sourceTainted: false,
      messageId: 1,
      createdAt: 1000,
      startedAt: null,
      finishedAt: null,
    }
    hub.broadcast({ type: 'background_task_changed', botId: 'scout', task: sampleTask })
    expect(events).toEqual([{ type: 'background_task_changed', botId: 'scout', task: sampleTask }])

    db.close()
  })

  it('upgrades an existing v15 database file seamlessly to v16', () => {
    const dir = makeTempDir('osb-v15-upgrade-')
    const dbPath = join(dir, 'opensuperbot.db')

    const initial = openDb(dbPath)
    const threadId = seedBot(initial, 'chief', 'Chief')
    insertMessage(initial, { threadId, sender: 'user', kind: 'text', content: 'v15 message' })
    initial.exec(`
      DROP INDEX IF EXISTS idx_background_tasks_bot;
      DROP INDEX IF EXISTS idx_background_tasks_status;
      DROP TABLE IF EXISTS background_tasks;
    `)
    initial.pragma('user_version = 15')
    initial.close()

    const migrated: Array<[number, number]> = []
    const upgraded = openDb(dbPath, { onMigrate: (from, to) => migrated.push([from, to]) })
    expect(migrated).toEqual([[15, 16]])
    expect(schemaVersion(upgraded)).toBe(16)
    expect(listMessages(upgraded, threadId).map((m) => m.content)).toEqual(['v15 message'])

    const indexes = (
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_background_tasks_bot',
      'idx_background_tasks_status',
    ]))
    expect(listBackgroundTasks(upgraded)).toEqual([])
    upgraded.close()
  })

  it('tolerates corrupt steps_json in rowToView and orders/clamps listBackgroundTasks', () => {
    const corruptRow: BackgroundTaskRow = {
      id: 'bg-deadbeef',
      bot_id: 'scout',
      thread_id: 'dm:scout',
      title: 'Corrupt steps test',
      instructions: 'Inspect',
      status: 'running',
      step_count: 2,
      last_step: 'read_file: notes.md',
      steps_json: '{not valid json',
      summary: '',
      error: '',
      uses_browser: 1,
      source_tainted: 0,
      message_id: null,
      created_at: 1000,
      started_at: 1050,
      finished_at: null,
    }
    const view = rowToView(corruptRow)
    expect(view.steps).toEqual([])
    expect(view.usesBrowser).toBe(true)

    const partialRow: BackgroundTaskRow = {
      ...corruptRow,
      steps_json: JSON.stringify([
        { tool: 'read_file', summary: 'ok.txt', ok: true, ms: 12, at: 1010 },
        { bad: 'shape' },
        null,
        { tool: 'shell', summary: 'ls', at: 'not-a-number' },
      ]),
    }
    expect(rowToView(partialRow).steps).toEqual([
      { tool: 'read_file', summary: 'ok.txt', ok: true, ms: 12, at: 1010 },
    ])

    const db = openDb(':memory:')
    const insert = db.prepare(
      `INSERT INTO background_tasks
        (id, bot_id, thread_id, title, instructions, status, step_count, last_step, steps_json, summary, error, uses_browser, message_id, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, '', '[]', '', '', 0, NULL, ?, NULL, NULL)`,
    )
    insert.run('bg-done-new', 'scout', 'dm:scout', 'Done newer', 'x', 'completed', 5000)
    insert.run('bg-done-old', 'scout', 'dm:scout', 'Done older', 'x', 'failed', 2000)
    insert.run('bg-queued', 'scout', 'dm:scout', 'Queued', 'x', 'queued', 1000)
    insert.run('bg-running', 'scout', 'dm:scout', 'Running', 'x', 'running', 3000)
    insert.run('bg-other', 'analyst', 'dm:analyst', 'Other bot', 'x', 'running', 4000)

    const scoutTasks = listBackgroundTasks(db, { botId: 'scout' })
    // Active (running/queued) come first ordered by created_at DESC, then settled ordered by created_at DESC.
    expect(scoutTasks.map((t) => t.id)).toEqual([
      'bg-running',
      'bg-queued',
      'bg-done-new',
      'bg-done-old',
    ])

    expect(listBackgroundTasks(db, { botId: 'scout', status: 'completed' }).map((t) => t.id)).toEqual([
      'bg-done-new',
    ])

    // Limit clamping guards
    expect(listBackgroundTasks(db, { limit: Number.NaN })).toHaveLength(5)
    expect(listBackgroundTasks(db, { limit: Number.POSITIVE_INFINITY })).toHaveLength(5)
    expect(listBackgroundTasks(db, { limit: 0 })).toHaveLength(1)
    expect(listBackgroundTasks(db, { limit: -10 })).toHaveLength(1)
    expect(listBackgroundTasks(db, { limit: 2.9 })).toHaveLength(2)
    expect(listBackgroundTasks(db, { limit: 999 })).toHaveLength(5)

    expect(getBackgroundTask(db, 'bg-nonexistent')).toBeNull()
    expect(getBackgroundTask(db, '')).toBeNull()
    db.close()
  })
})

describe('BrowserLeasePool & formatBrowserConflict', () => {
  it('lists all 9 browser tools in BROWSER_LEASE_TOOL_NAMES', () => {
    expect([...BROWSER_LEASE_TOOL_NAMES].sort()).toEqual([
      'ask_for_login',
      'browser_back',
      'browser_click',
      'browser_extract',
      'browser_goto',
      'browser_press',
      'browser_screenshot',
      'browser_scroll',
      'browser_type',
    ])
    expect(BROWSER_LEASE_TOOL_NAMES.has('wiki_upsert')).toBe(false)
    expect(BROWSER_LEASE_TOOL_NAMES.has('read_file')).toBe(false)
    expect(BROWSER_LEASE_TOOL_NAMES.has('shell')).toBe(false)
  })

  it('acquires, re-acquires idempotently, rejects conflicts in both directions, and protects releases', () => {
    const pool = createBrowserLeasePool()
    const fg1 = { kind: 'foreground' as const, token: 'turn-1', label: 'your active chat' }
    const fg2 = { kind: 'foreground' as const, token: 'turn-2', label: 'workflow recording' }
    const bg1 = { kind: 'background' as const, taskId: 'bg-a1b2c3d4', title: 'Scrape pricing' }
    const bg2 = { kind: 'background' as const, taskId: 'bg-e5f60708', title: 'Draft summary' }

    expect(pool.holder('scout')).toBeNull()
    expect(pool.isHeldByBackground('scout')).toBe(false)

    // Acquire foreground lease
    expect(pool.acquire('scout', fg1)).toEqual({ ok: true, newlyAcquired: true })
    expect(pool.holder('scout')).toEqual(fg1)
    expect(pool.isHeldByBackground('scout')).toBe(false)

    // Same foreground token re-acquires idempotently
    expect(pool.acquire('scout', fg1)).toEqual({ ok: true, newlyAcquired: false })

    // Background hits foreground conflict
    const bgBlocked = pool.acquire('scout', bg1)
    expect(bgBlocked).toEqual({ ok: false, holder: fg1 })
    if (!bgBlocked.ok) {
      expect(formatBrowserConflict('background', bgBlocked.holder)).toBe(
        'Your browser is currently in use by your active chat. Continue with non-browser work or wait until it finishes.',
      )
    }

    // Different foreground token hits foreground conflict
    const fgBlocked = pool.acquire('scout', fg2)
    expect(fgBlocked).toEqual({ ok: false, holder: fg1 })
    if (!fgBlocked.ok) {
      expect(formatBrowserConflict('foreground', fgBlocked.holder)).toContain('your active chat')
    }

    // Mismatched releases are rejected and do not clear the lease
    expect(pool.release('scout', fg2)).toBe(false)
    expect(pool.release('scout', bg1)).toBe(false)
    expect(pool.release('other-bot', fg1)).toBe(false)
    expect(pool.holder('scout')).toEqual(fg1)

    // Matching release clears the lease
    expect(pool.release('scout', fg1)).toBe(true)
    expect(pool.release('scout', fg1)).toBe(false)
    expect(pool.holder('scout')).toBeNull()

    // Background acquires lease
    expect(pool.acquire('scout', bg1)).toEqual({ ok: true, newlyAcquired: true })
    expect(pool.acquire('scout', bg1)).toEqual({ ok: true, newlyAcquired: false })
    expect(pool.isHeldByBackground('scout')).toBe(true)

    // Foreground hits background conflict with exact helpful refusal
    const fgHitBg = pool.acquire('scout', fg1)
    expect(fgHitBg).toEqual({ ok: false, holder: bg1 })
    if (!fgHitBg.ok) {
      expect(formatBrowserConflict('foreground', fgHitBg.holder)).toBe(
        'Your browser is currently in use by background task bg-a1b2c3d4 ("Scrape pricing"). '
        + 'You can keep chatting, use non-browser tools, wait for it to finish, or cancel it with cancel_background_task.',
      )
    }

    // Another background task also blocked
    const bgHitBg = pool.acquire('scout', bg2)
    expect(bgHitBg).toEqual({ ok: false, holder: bg1 })
    if (!bgHitBg.ok) {
      expect(formatBrowserConflict('background', bgHitBg.holder)).toContain('bg-a1b2c3d4')
    }

    // Cross-bot independence: another bot can acquire freely
    expect(pool.acquire('analyst', fg2)).toEqual({ ok: true, newlyAcquired: true })
    expect(pool.isHeldByBackground('analyst')).toBe(false)
    expect(pool.isHeldByBackground('scout')).toBe(true)

    // Background release frees scout's browser without touching analyst
    expect(pool.release('scout', bg2)).toBe(false)
    expect(pool.release('scout', bg1)).toBe(true)
    expect(pool.holder('scout')).toBeNull()
    expect(pool.holder('analyst')).toEqual(fg2)
  })
})

describe('BackgroundTaskManager', () => {
  it('validates title/instructions and enforces per-bot queue cap of 6', async () => {
    const db = openDb(':memory:')
    const scoutThread = seedBot(db, 'scout', 'Scout')
    const analystThread = seedBot(db, 'analyst', 'Analyst')
    const { hub, events } = setupHub()
    const blocker = createDeferred()

    const manager = createBackgroundTaskManager({
      db,
      hub,
      runTask: async () => {
        await blocker.promise
        return { summary: 'done' }
      },
    })

    // Validation failures
    expect(manager.enqueue({ botId: 'scout', threadId: scoutThread, title: '   ', instructions: 'do it' }))
      .toMatchObject({ ok: false, code: 'invalid_title' })
    expect(manager.enqueue({
      botId: 'scout',
      threadId: scoutThread,
      title: 'x'.repeat(MAX_BG_TITLE_CHARS + 1),
      instructions: 'do it',
    })).toMatchObject({ ok: false, code: 'invalid_title' })
    expect(manager.enqueue({ botId: 'scout', threadId: scoutThread, title: 'Valid', instructions: '  \n\t ' }))
      .toMatchObject({ ok: false, code: 'invalid_instructions' })
    expect(manager.enqueue({
      botId: 'scout',
      threadId: scoutThread,
      title: 'Valid',
      instructions: 'a'.repeat(MAX_BG_INSTRUCTIONS_CHARS + 1),
    })).toMatchObject({ ok: false, code: 'invalid_instructions' })

    // Title collapses newlines; multi-line instructions are preserved
    const first = manager.enqueue({
      botId: 'scout',
      threadId: scoutThread,
      title: '  Gather\nQ3\tmetrics  ',
      instructions: 'Line 1\nLine 2',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected ok')
    expect(first.task.id).toMatch(/^bg-[0-9a-f]{8}$/)
    expect(first.task.title).toBe('Gather Q3 metrics')
    expect(first.task.instructions).toBe('Line 1\nLine 2')
    expect(first.task.status).toBe('queued')
    expect(first.task.messageId).toBeGreaterThan(0)

    const msg = getMessage(db, first.task.messageId!)
    expect(msg?.kind).toBe('background_task')
    expect(msg?.payload).toMatchObject({
      taskId: first.task.id,
      title: 'Gather Q3 metrics',
      status: 'queued',
    })
    expect(events.some((e) => e.type === 'message' && e.message.kind === 'background_task')).toBe(true)
    expect(events.some((e) => e.type === 'background_task_changed' && e.task.id === first.task.id)).toBe(true)

    // Fill up to MAX_ACTIVE_TASKS_PER_BOT (6)
    for (let i = 2; i <= MAX_ACTIVE_TASKS_PER_BOT; i++) {
      const res = manager.enqueue({
        botId: 'scout',
        threadId: scoutThread,
        title: `Task ${i}`,
        instructions: `Run job ${i}`,
      })
      expect(res.ok).toBe(true)
    }

    // 7th task for same bot rejected
    const seventh = manager.enqueue({
      botId: 'scout',
      threadId: scoutThread,
      title: 'Task 7',
      instructions: 'Too many',
    })
    expect(seventh).toMatchObject({ ok: false, code: 'queue_full' })

    // Different bot has its own independent capacity
    const otherBot = manager.enqueue({
      botId: 'analyst',
      threadId: analystThread,
      title: 'Analyst job',
      instructions: 'Independent lane',
    })
    expect(otherBot.ok).toBe(true)

    await manager.stopAll()
    blocker.resolve()
    db.close()
  })

  it('executes per-bot tasks serially in FIFO order and runs different bots in parallel', async () => {
    const db = openDb(':memory:')
    const scoutThread = seedBot(db, 'scout', 'Scout')
    const analystThread = seedBot(db, 'analyst', 'Analyst')
    const { hub } = setupHub()

    let clock = 10_000
    const order: string[] = []
    const gates = new Map<string, ReturnType<typeof createDeferred<void>>>()
    const started = new Map<string, ReturnType<typeof createDeferred<void>>>()
    let inFlightScout = 0
    let maxConcurrentScout = 0
    let inFlightTotal = 0
    let maxConcurrentTotal = 0

    const manager = createBackgroundTaskManager({
      db,
      hub,
      now: () => (clock += 100),
      runTask: async (ctx) => {
        order.push(`start:${ctx.task.title}`)
        inFlightTotal++
        maxConcurrentTotal = Math.max(maxConcurrentTotal, inFlightTotal)
        if (ctx.task.botId === 'scout') {
          inFlightScout++
          maxConcurrentScout = Math.max(maxConcurrentScout, inFlightScout)
        }
        started.get(ctx.task.title)?.resolve()
        try {
          await gates.get(ctx.task.title)?.promise
        } finally {
          inFlightTotal--
          if (ctx.task.botId === 'scout') inFlightScout--
          order.push(`end:${ctx.task.title}`)
        }
        return { summary: `Summary for ${ctx.task.title}` }
      },
    })

    for (const name of ['scout-1', 'scout-2', 'analyst-1']) {
      gates.set(name, createDeferred())
      started.set(name, createDeferred())
    }

    const r1 = manager.enqueue({ botId: 'scout', threadId: scoutThread, title: 'scout-1', instructions: 'first' })
    const r2 = manager.enqueue({ botId: 'scout', threadId: scoutThread, title: 'scout-2', instructions: 'second' })
    const r3 = manager.enqueue({ botId: 'analyst', threadId: analystThread, title: 'analyst-1', instructions: 'parallel' })
    expect(r1.ok && r2.ok && r3.ok).toBe(true)
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('enqueue failed')

    // Both scout-1 and analyst-1 start concurrently while scout-2 waits
    await Promise.all([started.get('scout-1')!.promise, started.get('analyst-1')!.promise])
    expect(maxConcurrentTotal).toBe(2)
    expect(maxConcurrentScout).toBe(1)
    expect(getBackgroundTask(db, r1.task.id)?.status).toBe('running')
    expect(getBackgroundTask(db, r2.task.id)?.status).toBe('queued')
    expect(getBackgroundTask(db, r3.task.id)?.status).toBe('running')
    expect(manager.hasActive('scout')).toBe(true)
    expect(manager.hasActive('analyst')).toBe(true)
    expect(manager.activeCount()).toBe(3)
    expect(manager.activeBotIds().sort()).toEqual(['analyst', 'scout'])

    // Release scout-1 → scout-2 starts strictly after scout-1 finishes
    gates.get('scout-1')!.resolve()
    await started.get('scout-2')!.promise
    expect(order.indexOf('end:scout-1')).toBeLessThan(order.indexOf('start:scout-2'))
    expect(maxConcurrentScout).toBe(1)

    // Finish remaining tasks
    gates.get('scout-2')!.resolve()
    gates.get('analyst-1')!.resolve()
    await waitFor(() => !manager.hasActive())

    expect(manager.activeCount()).toBe(0)
    expect(manager.activeBotIds()).toEqual([])

    const done1 = getBackgroundTask(db, r1.task.id)!
    expect(done1.status).toBe('completed')
    expect(done1.summary).toBe('Summary for scout-1')
    expect(done1.startedAt).toBeGreaterThan(done1.createdAt)
    expect(done1.finishedAt).toBeGreaterThan(done1.startedAt!)

    const msg1 = getMessage(db, done1.messageId!)!
    expect(msg1.payload).toMatchObject({
      taskId: done1.id,
      status: 'completed',
      summary: 'Summary for scout-1',
    })

    const actions = listActions(db, 'scout')
    expect(actions.some((a) => a.trigger === 'background' && a.summary === 'completed: scout-1' && a.ok === true)).toBe(true)

    db.close()
  })

  it('records live steps capped at 25, marks usesBrowser idempotently, and handles failures/clamping', async () => {
    const db = openDb(':memory:')
    const threadId = seedBot(db, 'scout', 'Scout')
    const { hub, events } = setupHub()
    let clock = 1000

    let runIdx = 0
    const manager = createBackgroundTaskManager({
      db,
      hub,
      now: () => (clock += 10),
      runTask: async (ctx) => {
        runIdx++
        if (runIdx === 1) {
          for (let i = 1; i <= 30; i++) {
            ctx.recordStep({ tool: 'read_file', summary: `file-${i}.md`, ok: true, ms: i })
          }
          const eventsBeforeBrowser = events.length
          ctx.markUsesBrowser()
          const eventsAfterFirstBrowser = events.length
          ctx.markUsesBrowser() // idempotent no-op
          expect(events.length).toBe(eventsAfterFirstBrowser)
          expect(eventsAfterFirstBrowser).toBeGreaterThan(eventsBeforeBrowser)
          return { summary: 'S'.repeat(MAX_BG_SUMMARY_CHARS + 50) }
        }
        if (runIdx === 2) {
          return { status: 'failed', error: 'E'.repeat(MAX_BG_ERROR_CHARS + 40) }
        }
        throw new Error('unexpected crash')
      },
    })

    const r1 = manager.enqueue({ botId: 'scout', threadId, title: 'Step cap test', instructions: '30 steps' })
    const r2 = manager.enqueue({ botId: 'scout', threadId, title: 'Return failure', instructions: 'fail cleanly' })
    const r3 = manager.enqueue({ botId: 'scout', threadId, title: 'Throw error', instructions: 'throw' })
    expect(r1.ok && r2.ok && r3.ok).toBe(true)
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('enqueue failed')

    await waitFor(() => !manager.hasActive())

    const t1 = getBackgroundTask(db, r1.task.id)!
    expect(t1.status).toBe('completed')
    expect(t1.stepCount).toBe(30)
    expect(t1.steps).toHaveLength(MAX_BG_STEPS)
    expect(t1.steps[0]!.summary).toBe('file-6.md')
    expect(t1.steps[MAX_BG_STEPS - 1]!.summary).toBe('file-30.md')
    expect(t1.lastStep).toBe('read_file: file-30.md')
    expect(t1.usesBrowser).toBe(true)
    expect(t1.summary).toHaveLength(MAX_BG_SUMMARY_CHARS)
    expect(t1.summary.endsWith('...')).toBe(true)

    const chip1 = getMessage(db, t1.messageId!)!.payload as BackgroundTaskPayload
    expect(chip1.stepCount).toBe(30)
    expect(chip1.steps).toHaveLength(MAX_BG_STEPS)
    expect(chip1.usesBrowser).toBe(true)

    const t2 = getBackgroundTask(db, r2.task.id)!
    expect(t2.status).toBe('failed')
    expect(t2.error).toHaveLength(MAX_BG_ERROR_CHARS)
    expect(t2.error.endsWith('...')).toBe(true)

    const t3 = getBackgroundTask(db, r3.task.id)!
    expect(t3.status).toBe('failed')
    expect(t3.error).toBe('unexpected crash')
    expect(listActions(db, 'scout').some((a) => a.summary === 'failed: Throw error' && a.ok === false)).toBe(true)

    db.close()
  })

  it('delivers steering notes for both queued and running tasks and enforces validation & ownership', async () => {
    const db = openDb(':memory:')
    const threadId = seedBot(db, 'scout', 'Scout')
    const { hub, events } = setupHub()

    const t1Started = createDeferred()
    const t1Release = createDeferred()
    const t2Started = createDeferred()
    const t2MidGate = createDeferred()
    const t2Notes: BackgroundSteeringNote[][] = []
    let t2StartTainted: boolean | null = null

    const manager = createBackgroundTaskManager({
      db,
      hub,
      runTask: async (ctx) => {
        if (ctx.task.title === 'First') {
          t1Started.resolve()
          await t1Release.promise
          return { summary: 'first done' }
        }
        t2StartTainted = ctx.task.sourceTainted
        t2Notes.push(ctx.drainSteeringNotes())
        t2Notes.push(ctx.drainSteeringNotes()) // second drain is empty
        t2Started.resolve()
        await t2MidGate.promise
        t2Notes.push(ctx.drainSteeringNotes())
        return { summary: 'second done' }
      },
    })

    const r1 = manager.enqueue({ botId: 'scout', threadId, title: 'First', instructions: 'Run 1', sourceTainted: true })
    const r2 = manager.enqueue({ botId: 'scout', threadId, title: 'Second', instructions: 'Run 2' })
    if (!r1.ok || !r2.ok) throw new Error('enqueue failed')
    expect(r1.task.sourceTainted).toBe(true)
    expect(r2.task.sourceTainted).toBe(false)

    await t1Started.promise

    // Validation & ownership checks
    expect(manager.steer(r2.task.id, '   ')).toMatchObject({ ok: false, code: 'invalid_note' })
    expect(manager.steer(r2.task.id, 'z'.repeat(MAX_BG_STEER_CHARS + 1)))
      .toMatchObject({ ok: false, code: 'invalid_note' })
    expect(manager.steer('bg-missing', 'note')).toMatchObject({ ok: false, code: 'not_found' })
    expect(manager.steer(r2.task.id, 'note', { botId: 'other-bot' }))
      .toMatchObject({ ok: false, code: 'not_found' })

    // Steer queued task r2 with tainted: true before it starts -> durably flips source_tainted = 1
    const queuedSteer = manager.steer(r2.task.id, 'Focus on APAC revenue', { botId: 'scout', tainted: true })
    expect(queuedSteer.ok).toBe(true)
    if (!queuedSteer.ok) throw new Error('expected steer ok')
    expect(queuedSteer.task.status).toBe('queued')
    expect(queuedSteer.task.sourceTainted).toBe(true)
    expect(queuedSteer.task.steps).toHaveLength(1)
    expect(queuedSteer.task.steps[0]).toMatchObject({
      tool: 'steer',
      summary: 'Focus on APAC revenue',
      ok: true,
    })

    // Let r1 finish and r2 start -> r2 starts with sourceTainted === true
    t1Release.resolve()
    await t2Started.promise
    expect(t2StartTainted).toBe(true)

    // Steer running task r2 mid-flight (untainted) -> must NOT clear sourceTainted
    const midSteer = manager.steer(r2.task.id, 'Include YoY delta')
    expect(midSteer.ok).toBe(true)
    if (!midSteer.ok) throw new Error('expected steer ok')
    expect(midSteer.task.sourceTainted).toBe(true)
    expect(events.some(
      (e) => e.type === 'background_task_changed'
        && e.task.id === r2.task.id
        && e.task.lastStep === 'steer: Include YoY delta',
    )).toBe(true)

    t2MidGate.resolve()
    await waitFor(() => !manager.hasActive())

    expect(t2Notes).toEqual([
      [{ note: 'Focus on APAC revenue', tainted: true }],
      [],
      [{ note: 'Include YoY delta', tainted: false }],
    ])
    expect(getBackgroundTask(db, r2.task.id)?.sourceTainted).toBe(true)

    // Settled task cannot be steered
    expect(manager.steer(r2.task.id, 'too late')).toMatchObject({ ok: false, code: 'settled' })

    db.close()
  })

  it('cancels queued and running tasks cleanly, enforces ownership, and never overwrites cancelled status', async () => {
    const db = openDb(':memory:')
    const threadId = seedBot(db, 'scout', 'Scout')
    const { hub, events } = setupHub()

    const r1Started = createDeferred<BackgroundTaskRunContext>()
    const r1Unwind = createDeferred()
    const r3Started = createDeferred()
    const ranTitles: string[] = []

    const manager = createBackgroundTaskManager({
      db,
      hub,
      runTask: async (ctx) => {
        ranTitles.push(ctx.task.title)
        if (ctx.task.title === 'Running task') {
          r1Started.resolve(ctx)
          await r1Unwind.promise
          // Simulate late step/browser/completion after cancel
          ctx.recordStep({ tool: 'shell', summary: 'late step should be ignored', ok: true })
          ctx.markUsesBrowser()
          return { status: 'completed', summary: 'should not overwrite cancelled' }
        }
        if (ctx.task.title === 'Third task') {
          r3Started.resolve()
        }
        return { summary: 'third completed' }
      },
    })

    const r1 = manager.enqueue({ botId: 'scout', threadId, title: 'Running task', instructions: '1' })
    const r2 = manager.enqueue({ botId: 'scout', threadId, title: 'Queued task', instructions: '2' })
    const r3 = manager.enqueue({ botId: 'scout', threadId, title: 'Third task', instructions: '3' })
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('enqueue failed')

    const r1Ctx = await r1Started.promise

    // Ownership & not_found checks
    expect(manager.cancel('bg-missing')).toMatchObject({ ok: false, code: 'not_found' })
    expect(manager.cancel(r2.task.id, { botId: 'wrong-bot' })).toMatchObject({ ok: false, code: 'not_found' })

    // Cancel queued task r2
    const cancelQueued = manager.cancel(r2.task.id, { botId: 'scout' })
    expect(cancelQueued.ok).toBe(true)
    if (!cancelQueued.ok) throw new Error('expected cancel ok')
    expect(cancelQueued.task.status).toBe('cancelled')
    expect(cancelQueued.task.finishedAt).not.toBeNull()
    expect(manager.cancel(r2.task.id)).toMatchObject({ ok: false, code: 'settled' })

    // Cancel running task r1
    expect(r1Ctx.signal.aborted).toBe(false)
    const cancelRunning = manager.cancel(r1.task.id, { botId: 'scout' })
    expect(cancelRunning.ok).toBe(true)
    expect(r1Ctx.signal.aborted).toBe(true)
    expect(getBackgroundTask(db, r1.task.id)?.status).toBe('cancelled')
    const eventsRightAfterCancel = events.filter(
      (e) => e.type === 'background_task_changed' && e.task.id === r1.task.id,
    ).length

    // Allow r1 to unwind; verify it does NOT overwrite cancelled and r3 runs next (r2 never ran)
    r1Unwind.resolve()
    await r3Started.promise
    await waitFor(() => !manager.hasActive())

    expect(ranTitles).toEqual(['Running task', 'Third task'])
    const finalR1 = getBackgroundTask(db, r1.task.id)!
    expect(finalR1.status).toBe('cancelled')
    expect(finalR1.summary).toBe('')
    expect(finalR1.stepCount).toBe(0)
    expect(finalR1.usesBrowser).toBe(false)
    const eventsFinalR1 = events.filter(
      (e) => e.type === 'background_task_changed' && e.task.id === r1.task.id,
    ).length
    expect(eventsFinalR1).toBe(eventsRightAfterCancel)

    expect(getBackgroundTask(db, r2.task.id)?.status).toBe('cancelled')
    expect(getBackgroundTask(db, r3.task.id)?.status).toBe('completed')

    db.close()
  })

  it('stopAll cancels queued tasks, aborts running tasks, and waits for settlement', async () => {
    const db = openDb(':memory:')
    const scoutThread = seedBot(db, 'scout', 'Scout')
    const analystThread = seedBot(db, 'analyst', 'Analyst')

    const startedCount = { n: 0 }
    const bothStarted = createDeferred()
    let settledCleanupCount = 0

    const manager = createBackgroundTaskManager({
      db,
      runTask: async (ctx) => {
        startedCount.n++
        if (startedCount.n === 2) bothStarted.resolve()
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            setTimeout(resolve, 25)
            return
          }
          ctx.signal.addEventListener('abort', () => setTimeout(resolve, 25), { once: true })
        })
        settledCleanupCount++
      },
    })

    const r1 = manager.enqueue({ botId: 'scout', threadId: scoutThread, title: 'Scout running', instructions: '1' })
    const r2 = manager.enqueue({ botId: 'scout', threadId: scoutThread, title: 'Scout queued', instructions: '2' })
    const r3 = manager.enqueue({ botId: 'analyst', threadId: analystThread, title: 'Analyst running', instructions: '3' })
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('enqueue failed')

    await bothStarted.promise
    expect(manager.hasActive()).toBe(true)
    expect(manager.activeCount()).toBe(3)

    await manager.stopAll()

    // Both running tasks actually completed their async cleanup before stopAll resolved; queued task never ran.
    expect(settledCleanupCount).toBe(2)
    expect(startedCount.n).toBe(2)
    expect(manager.hasActive()).toBe(false)
    expect(manager.activeCount()).toBe(0)
    expect(manager.activeBotIds()).toEqual([])
    expect(getBackgroundTask(db, r1.task.id)?.status).toBe('cancelled')
    expect(getBackgroundTask(db, r2.task.id)?.status).toBe('cancelled')
    expect(getBackgroundTask(db, r3.task.id)?.status).toBe('cancelled')

    db.close()
  })

  it('reconcileStaleBackgroundTasks cancels leftover queued/running rows and patches thread chips on startup', () => {
    const db = openDb(':memory:')
    const threadId = seedBot(db, 'scout', 'Scout')

    const mQueued = insertMessage(db, {
      threadId,
      sender: 'scout',
      kind: 'background_task',
      payload: { taskId: 'bg-00000001', title: 'Stale queued', status: 'queued', stepCount: 0, lastStep: '', steps: [], usesBrowser: false, createdAt: 100 },
    })
    const mRunning = insertMessage(db, {
      threadId,
      sender: 'scout',
      kind: 'background_task',
      payload: { taskId: 'bg-00000002', title: 'Stale running', status: 'running', stepCount: 3, lastStep: 'shell: ls', steps: [], usesBrowser: true, createdAt: 200, startedAt: 210 },
    })
    const mDone = insertMessage(db, {
      threadId,
      sender: 'scout',
      kind: 'background_task',
      payload: { taskId: 'bg-00000003', title: 'Already done', status: 'completed', stepCount: 2, lastStep: 'done', steps: [], summary: 'Finished', usesBrowser: false, createdAt: 50, startedAt: 60, finishedAt: 90 },
    })

    const ins = db.prepare(
      `INSERT INTO background_tasks
        (id, bot_id, thread_id, title, instructions, status, step_count, last_step, steps_json, summary, error, uses_browser, message_id, created_at, started_at, finished_at)
       VALUES (?, 'scout', ?, ?, 'do work', ?, ?, ?, '[]', ?, '', ?, ?, ?, ?, ?)`,
    )
    ins.run('bg-00000001', threadId, 'Stale queued', 'queued', 0, '', '', 0, mQueued.id, 100, null, null)
    ins.run('bg-00000002', threadId, 'Stale running', 'running', 3, 'shell: ls', '', 1, mRunning.id, 200, 210, null)
    ins.run('bg-00000003', threadId, 'Already done', 'completed', 2, 'done', 'Finished', 0, mDone.id, 50, 60, 90)
    ins.run('bg-00000004', threadId, 'No chip stale', 'running', 0, '', '', 0, null, 300, 310, null)

    const count = reconcileStaleBackgroundTasks(db, { now: 9999 })
    expect(count).toBe(3)
    expect(reconcileStaleBackgroundTasks(db, { now: 10_000 })).toBe(0)

    const q = getBackgroundTask(db, 'bg-00000001')!
    expect(q.status).toBe('cancelled')
    expect(q.error).toBe(STALE_RESTART_ERROR)
    expect(q.finishedAt).toBe(9999)
    expect(getMessage(db, mQueued.id)!.payload).toMatchObject({
      taskId: 'bg-00000001',
      status: 'cancelled',
      error: STALE_RESTART_ERROR,
      finishedAt: 9999,
    })

    const r = getBackgroundTask(db, 'bg-00000002')!
    expect(r.status).toBe('cancelled')
    expect(r.error).toBe(STALE_RESTART_ERROR)
    expect(r.finishedAt).toBe(9999)
    expect(getMessage(db, mRunning.id)!.payload).toMatchObject({
      taskId: 'bg-00000002',
      status: 'cancelled',
      error: STALE_RESTART_ERROR,
      finishedAt: 9999,
    })

    // Completed task untouched
    const d = getBackgroundTask(db, 'bg-00000003')!
    expect(d.status).toBe('completed')
    expect(d.summary).toBe('Finished')
    expect(d.error).toBe('')
    expect(d.finishedAt).toBe(90)

    // Null message_id row reconciled cleanly
    const noChip = getBackgroundTask(db, 'bg-00000004')!
    expect(noChip.status).toBe('cancelled')
    expect(noChip.error).toBe(STALE_RESTART_ERROR)

    db.close()
  })

  it('releases lane.running and entries cleanly without unhandled rejections if DB closes during task teardown', async () => {
    const db = openDb(':memory:')
    const threadId = seedBot(db, 'scout', 'Scout')
    const started = createDeferred()
    const release = createDeferred()

    const manager = createBackgroundTaskManager({
      db,
      runTask: async () => {
        started.resolve()
        await release.promise
        return { summary: 'finished after db closed' }
      },
    })

    const r1 = manager.enqueue({ botId: 'scout', threadId, title: 'Teardown race', instructions: 'Run' })
    expect(r1.ok).toBe(true)
    await started.promise

    // Simulate DB closing before runTask finishes
    db.close()
    release.resolve()

    await waitFor(() => !manager.hasActive())
    expect(manager.activeCount()).toBe(0)
    expect(manager.activeBotIds()).toEqual([])
  })
})
