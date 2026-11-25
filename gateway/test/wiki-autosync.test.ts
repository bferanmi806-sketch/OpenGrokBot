import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { recordAction } from '../src/actions.js'
import {
  ensureDmThread,
  ensureGroupThread,
  insertMessage,
  openDb,
  upsertBot,
  type BotRow,
} from '../src/db.js'
import { createHub, type GatewayEvent } from '../src/hub.js'
import type { AssistantTurn, ChatMsg, ChatOptions, LLM, ToolDef } from '../src/llm.js'
import { createLlmQueue } from '../src/llm-queue.js'
import { createApp } from '../src/server.js'
import { mountWiki } from '../src/wiki/api.js'
import {
  MAX_FORCE_BATCHES_PER_THREAD,
  MAX_SYNC_MESSAGES_PER_THREAD,
  markWikiSyncThreadTainted,
  MIN_SUBSTANTIVE_CHARS,
  syncWikiFromChats,
  WIKI_IDLE_QUIET_MS,
} from '../src/wiki/auto-sync.js'
import { archiveWikiPage, getWikiPage, upsertWikiPage } from '../src/wiki/store.js'

const scout: BotRow = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const chief: BotRow = { id: 'chief', name: 'Chief', role: 'staff', emoji: '🎖️', soul_path: '' }

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osb-wiki-autosync-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function transcriptOf(messages: ChatMsg[]): string {
  const full = String(messages.find((m) => m.role === 'user')?.content ?? '')
  const marker = '=== THREAD TRANSCRIPT '
  const idx = full.indexOf(marker)
  return idx >= 0 ? full.slice(idx) : full
}

function jsonTurn(obj: unknown): AssistantTurn {
  const content = JSON.stringify(obj)
  return { content, toolCalls: [], raw: { role: 'assistant', content } }
}

describe('syncWikiFromChats idle P3 pipeline, taint propagation, mutex, and POST /api/wiki/sync', () => {
  it('exports expected constants, skips < 30m active or busy threads when force=false, fast-forwards trivial batches with zero LLM calls, and syncs on force=true with priority="low"', async () => {
    expect(WIKI_IDLE_QUIET_MS).toBe(30 * 60_000)
    expect(MAX_SYNC_MESSAGES_PER_THREAD).toBe(25)
    expect(MIN_SUBSTANTIVE_CHARS).toBe(12)

    const dataDir = makeTempDir()
    const db = openDb(':memory:')
    upsertBot(db, scout)
    upsertBot(db, chief)
    const dmScout = ensureDmThread(db, scout.id)
    const dmChief = ensureDmThread(db, chief.id)
    const groupOps = ensureGroupThread(db, 'group:ops', 'Ops', [scout.id, chief.id])

    const baseNow = Date.UTC(2026, 10, 25, 16, 0, 0)

    // 1. Trivial thread (< 12 chars) -> older than 30m, must advance cursor with ZERO LLM calls!
    const trivialMsg = insertMessage(db, {
      threadId: dmChief,
      sender: 'user',
      kind: 'text',
      content: 'ok thanks!',
      createdAt: baseNow - 60 * 60_000,
    })

    // 2. Recent thread (only 5m old) -> skipped when force=false, synced when force=true!
    const recentMsg = insertMessage(db, {
      threadId: dmScout,
      sender: 'user',
      kind: 'text',
      content: 'Initech signed the $72,000 enterprise agreement with api key sk-1234567890abcdef.',
      createdAt: baseNow - 5 * 60_000,
    })

    // 3. Quiet thread (45m old) -> synced on idle pass (force=false)!
    const quietMsg = insertMessage(db, {
      threadId: groupOps,
      sender: 'user',
      kind: 'text',
      content: 'Project Helios launch target moved to December 12 with lead Nina Patel.',
      createdAt: baseNow - 45 * 60_000,
    })

    const calls: Array<{ messages: ChatMsg[]; tools: ToolDef[]; opts?: ChatOptions }> = []
    const busySet = new Set<string>([groupOps])

    const llm: LLM = {
      async chat(messages, tools, opts) {
        calls.push({ messages, tools, opts })
        const transcript = transcriptOf(messages)
        if (transcript.includes('Project Helios')) {
          return jsonTurn({
            operations: [
              // Include one malformed op (invalid kind) to verify per-op resilience!
              {
                kind: 'bogus_kind',
                title: 'Should Be Ignored',
                keyFacts: { add: [{ text: 'Invalid op' }] },
              },
              {
                kind: 'project',
                slug: 'project-helios',
                title: 'Project Helios',
                summary: 'Launch scheduled for December 12',
                tags: ['launch'],
                overview: {
                  mode: 'rewrite',
                  content: `Project Helios is led by Nina Patel targeting December 12 ([#msg:${quietMsg.id}]).`,
                  reason: 'Extracted launch details from Ops chat',
                },
                keyFacts: {
                  add: [{ text: `Launch date moved to December 12 ([#msg:${quietMsg.id}])` }],
                },
              },
            ],
          })
        }
        return jsonTurn({
          operations: [
            {
              kind: 'client',
              slug: 'initech',
              title: 'Initech',
              summary: 'Enterprise client ($72k)',
              keyFacts: {
                add: [
                  {
                    text: `Signed $72,000 enterprise agreement with key sk-1234567890abcdef ([#msg:${recentMsg.id}])`,
                  },
                ],
              },
            },
          ],
        })
      },
    }

    const hub = createHub()
    const hubEvents: GatewayEvent[] = []
    hub.add({ send: (raw) => hubEvents.push(JSON.parse(raw) as GatewayEvent) })

    // Pass 1: groupOps is busy, dmScout is < 30m recent, dmChief is trivial -> 0 LLM calls, dmChief cursor advances!
    const pass1 = await syncWikiFromChats(
      {
        db,
        dataDir,
        hub,
        llm,
        isThreadBusy: (tid) => busySet.has(tid),
        now: () => baseNow,
      },
      { force: false },
    )
    expect(calls).toHaveLength(0)
    expect(pass1.pagesCreated).toBe(0)
    expect(pass1.pagesUpdated).toBe(0)
    expect(hubEvents).toHaveLength(0)
    const chiefState = db
      .prepare('SELECT last_synced_message_id FROM wiki_sync_state WHERE thread_id = ?')
      .pluck()
      .get(dmChief)
    expect(chiefState).toBe(trivialMsg.id)

    // Pass 2: groupOps is no longer busy, force=false -> syncs groupOps (45m old), still skips dmScout (5m old)!
    busySet.clear()
    const pass2 = await syncWikiFromChats(
      {
        db,
        dataDir,
        hub,
        llm,
        isThreadBusy: (tid) => busySet.has(tid),
        now: () => baseNow,
      },
      { force: false },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.opts?.priority).toBe('low')
    expect(calls[0]!.tools).toEqual([])
    expect(String(calls[0]!.messages[1]?.content)).toContain(`[#msg:${quietMsg.id}]`)
    expect(pass2).toEqual({
      ok: true,
      threadsSynced: 1,
      pagesCreated: 1,
      pagesUpdated: 0,
    })
    const helios = getWikiPage(db, 'project', 'project-helios')!
    expect(helios.updatedBy).toBe('auto-sync')
    expect(helios.sourceTainted).toBe(false)
    expect(helios.body).toContain('Nina Patel')
    expect(hubEvents.filter((e) => e.type === 'wiki_changed')).toHaveLength(1)

    // Pass 3: Re-running idle sync immediately is a complete no-op (cursor idempotency -> no extra LLM call)
    const pass3 = await syncWikiFromChats(
      { db, dataDir, hub, llm, now: () => baseNow },
      { force: false },
    )
    expect(calls).toHaveLength(1)
    expect(pass3.pagesCreated + pass3.pagesUpdated).toBe(0)

    // Pass 4: Manual POST /api/wiki/sync (force=true) syncs recent (< 30m) dmScout immediately & scrubs secrets!
    const gw = createApp({ db, llm, dataDir, hub, now: () => new Date(baseNow) })
    const syncRes = await gw.app.request('/api/wiki/sync', { method: 'POST' })
    expect(syncRes.status).toBe(200)
    const syncJson = await syncRes.json()
    expect(syncJson).toEqual({
      ok: true,
      threadsSynced: 1,
      pagesCreated: 1,
      pagesUpdated: 0,
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.opts?.priority).toBe('low')
    const initech = getWikiPage(db, 'client', 'initech')!
    expect(initech.body).toContain('[REDACTED]')
    expect(initech.body).not.toContain('sk-1234567890abcdef')

    await gw.stopAll()
    db.close()
  })

  it('marks auto-synced pages sourceTainted=true when thread window contains webhook/tainted bot_ref or external read tool actions', async () => {
    const dataDir = makeTempDir()
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const dmScout = ensureDmThread(db, scout.id)
    const groupId = ensureGroupThread(db, 'group:research', 'Research', [scout.id])
    const now = Date.UTC(2026, 10, 25, 18, 0, 0)

    // Thread 1: webhook message in window
    insertMessage(db, {
      threadId: dmScout,
      sender: 'webhook',
      kind: 'webhook',
      payload: { name: 'gh', body: 'external issue body' },
      createdAt: now - 3600_000,
    })
    const m1 = insertMessage(db, {
      threadId: dmScout,
      sender: scout.id,
      kind: 'text',
      content: 'Triaged external GitHub issue for client Cyberdyne Systems.',
      createdAt: now - 3590_000,
    })

    // Thread 2: clean messages, BUT actions window used web_fetch
    const m2 = insertMessage(db, {
      threadId: groupId,
      sender: scout.id,
      kind: 'text',
      content: 'Compiled market overview for client Tyrell Corporation.',
      createdAt: now - 3600_000,
    })
    recordAction(db, {
      botId: scout.id,
      threadId: groupId,
      trigger: 'you',
      tool: 'web_fetch',
      summary: 'https://tyrell.example/about',
      ok: true,
      ms: 120,
      at: now - 3605_000,
    })

    const llm: LLM = {
      async chat(messages) {
        const transcript = transcriptOf(messages)
        if (transcript.includes('Cyberdyne')) {
          return jsonTurn({
            operations: [
              {
                kind: 'client',
                slug: 'cyberdyne',
                title: 'Cyberdyne Systems',
                keyFacts: { add: [{ text: `Issue triaged ([#msg:${m1.id}])` }] },
              },
            ],
          })
        }
        return jsonTurn({
          operations: [
            {
              kind: 'client',
              slug: 'tyrell',
              title: 'Tyrell Corporation',
              keyFacts: { add: [{ text: `Market overview compiled ([#msg:${m2.id}])` }] },
            },
          ],
        })
      },
    }

    const res = await syncWikiFromChats({ db, dataDir, llm, now: () => now }, { force: true })
    expect(res.pagesCreated).toBe(2)
    expect(getWikiPage(db, 'client', 'cyberdyne')?.sourceTainted).toBe(true)
    expect(getWikiPage(db, 'client', 'tyrell')?.sourceTainted).toBe(true)

    db.close()
  })

  it('does not advance cursor on LLM transport failure (returning 502 from POST /api/wiki/sync), returns 501 when unwired, yields on P3 llmQueue, and chains a force pass behind an in-flight idle pass', async () => {
    const dataDir = makeTempDir()
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const dmScout = ensureDmThread(db, scout.id)
    const groupOps = ensureGroupThread(db, 'group:ops', 'Ops', [scout.id])
    const now = Date.UTC(2026, 10, 25, 19, 0, 0)

    // 501 when mountWiki has no syncFromChats wired
    const bareApp = new Hono()
    mountWiki(bareApp, { db, dataDir })
    const unwiredRes = await bareApp.request('/api/wiki/sync', { method: 'POST' })
    expect(unwiredRes.status).toBe(501)

    // Seed an existing page to verify existing index + matched body context is provided
    upsertWikiPage(
      db,
      {
        kind: 'project',
        slug: 'nebula',
        title: 'Project Nebula',
        summary: 'Cloud migration',
        body: '## Key Facts\n- [f1] Initial scope defined ([#msg:1])',
        editedBy: 'operator',
      },
      { dataDir, now: now - 7200_000 },
    )

    // Old thread (idle >= 30m) and recent thread (< 30m)
    const oldMsg = insertMessage(db, {
      threadId: groupOps,
      sender: 'user',
      kind: 'text',
      content: 'Project Nebula phase 2 budget confirmed at $95,000.',
      createdAt: now - 45 * 60_000,
    })
    const recentMsg = insertMessage(db, {
      threadId: dmScout,
      sender: 'user',
      kind: 'text',
      content: 'Project Nebula security review scheduled for Tuesday.',
      createdAt: now - 2 * 60_000,
    })

    // 1. Failing LLM does NOT advance cursor and returns 502 sync_failed
    let failMode = true
    let releaseFirstIdleCall!: () => void
    const firstIdleEntered = new Promise<void>((resolve) => {
      releaseFirstIdleCall = resolve
    })
    let unblockFirstIdleLlm!: () => void
    const firstIdleGate = new Promise<void>((resolve) => {
      unblockFirstIdleLlm = resolve
    })
    let idleBlockedOnce = false

    const rawLlm: LLM = {
      async chat(messages) {
        if (failMode) {
          throw new Error('Upstream provider 503')
        }
        const fullPrompt = String(messages[1]?.content ?? '')
        expect(fullPrompt).toContain('project/nebula')
        const transcript = transcriptOf(messages)
        if (!idleBlockedOnce && transcript.includes(`[#msg:${oldMsg.id}]`)) {
          idleBlockedOnce = true
          releaseFirstIdleCall()
          await firstIdleGate
        }
        if (transcript.includes(`[#msg:${oldMsg.id}]`)) {
          return jsonTurn({
            operations: [
              {
                kind: 'project',
                slug: 'nebula',
                keyFacts: { add: [{ text: `Phase 2 budget confirmed at $95,000 ([#msg:${oldMsg.id}])` }] },
              },
            ],
          })
        }
        return jsonTurn({
          operations: [
            {
              kind: 'project',
              slug: 'nebula',
              openItems: { add: [{ text: `Complete Tuesday security review ([#msg:${recentMsg.id}])` }] },
            },
          ],
        })
      },
    }

    const queue = createLlmQueue({ concurrency: 1 })
    const wrappedLlm = queue.wrap(rawLlm, 'http://127.0.0.1:11434/v1')
    const gw = createApp({
      db,
      llm: wrappedLlm,
      llmQueue: queue,
      dataDir,
      now: () => new Date(now),
    })

    const failRes = await gw.app.request('/api/wiki/sync', { method: 'POST' })
    expect(failRes.status).toBe(502)
    expect(await failRes.json()).toMatchObject({ code: 'sync_failed' })
    expect(db.prepare('SELECT COUNT(*) FROM wiki_sync_state').pluck().get()).toBe(0)

    // 2. Start idle sync (force: false) -> blocks mid-flight on groupOps, having skipped recent dmScout (< 30m).
    // While in-flight, trigger POST /api/wiki/sync (force: true) -> must chain a follow-up force pass so dmScout IS synced!
    failMode = false
    const idlePromise = gw.syncWikiFromChats({ force: false })
    await firstIdleEntered

    const forceHttpPromise = gw.app.request('/api/wiki/sync', { method: 'POST' })
    unblockFirstIdleLlm()

    const [idleResult, forceHttpRes] = await Promise.all([idlePromise, forceHttpPromise])
    expect(idleResult.threadsSynced).toBe(1)
    expect(forceHttpRes.status).toBe(200)
    const forceJson = (await forceHttpRes.json()) as {
      ok: boolean
      threadsSynced: number
      pagesUpdated: number
    }
    expect(forceJson.ok).toBe(true)
    expect(forceJson.threadsSynced).toBe(1)
    expect(forceJson.pagesUpdated).toBe(1)

    const nebula = getWikiPage(db, 'project', 'nebula')!
    expect(nebula.body).toContain('[f1] Initial scope defined')
    expect(nebula.body).toContain('$95,000')
    expect(nebula.body).toContain('Complete Tuesday security review')

    await gw.stopAll()
    db.close()
  })

  it('closes all taint-laundering paths (pending_taint retention across batches, 20m action lookback, archived tainted wiki_read, checkpoints, bg tasks, dispatch plans, feed_items, ideas)', async () => {
    expect(MAX_FORCE_BATCHES_PER_THREAD).toBe(10)
    const dataDir = makeTempDir()
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const now = Date.UTC(2026, 10, 25, 20, 0, 0)

    // 1. pending_taint stays 1 across partial idle batch (when > 25 messages exist) and clears to 0 only when fully caught up!
    const dmScout = ensureDmThread(db, scout.id)
    markWikiSyncThreadTainted(db, dmScout, now - 4000_000)
    for (let i = 1; i <= 27; i++) {
      insertMessage(db, {
        threadId: dmScout,
        sender: 'user',
        kind: 'text',
        content: `Batch item #${i}: Globex infrastructure milestone verified.`,
        createdAt: now - 3600_000 + i * 100,
      })
    }

    let callNum = 0
    const llm: LLM = {
      async chat(messages) {
        callNum += 1
        const transcript = transcriptOf(messages)
        if (transcript.includes('(dm:researcher)')) {
          return jsonTurn({
            operations: [
              {
                kind: 'client',
                slug: `globex-b${callNum}`,
                title: `Globex Batch ${callNum}`,
                keyFacts: { add: [{ text: `Batch ${callNum} synced` }] },
              },
            ],
          })
        }
        const m = /=== THREAD TRANSCRIPT \(([^)]+)\) ===/.exec(transcript)
        const tid = m ? m[1]! : 'unknown'
        const slug = tid.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
        return jsonTurn({
          operations: [
            {
              kind: 'topic',
              slug,
              title: `Topic ${tid}`,
              keyFacts: { add: [{ text: `Extracted from ${tid}` }] },
            },
          ],
        })
      },
    }

    // Idle pass processes 1 batch (first 25 of 27 messages) -> pending_taint MUST remain 1!
    await syncWikiFromChats({ db, dataDir, llm, now: () => now }, { force: false })
    expect(getWikiPage(db, 'client', 'globex-b1')?.sourceTainted).toBe(true)
    const midState = db
      .prepare('SELECT last_synced_message_id, pending_taint FROM wiki_sync_state WHERE thread_id = ?')
      .get(dmScout) as { last_synced_message_id: number; pending_taint: number }
    expect(midState.pending_taint).toBe(1)

    // Next idle pass processes remaining 2 messages -> ALSO tainted, and NOW pending_taint clears to 0!
    await syncWikiFromChats({ db, dataDir, llm, now: () => now }, { force: false })
    expect(getWikiPage(db, 'client', 'globex-b2')?.sourceTainted).toBe(true)
    const endState = db
      .prepare('SELECT pending_taint FROM wiki_sync_state WHERE thread_id = ?')
      .pluck()
      .get(dmScout)
    expect(endState).toBe(0)

    // 2. 20-minute earlier action lookback + archived tainted wiki_read
    const gWikiRead = ensureGroupThread(db, 'group:t-wikiread', 'WikiRead', [scout.id])
    upsertWikiPage(
      db,
      {
        kind: 'client',
        slug: 'archived-tainted',
        title: 'Archived Tainted',
        body: 'Untrusted',
        editedBy: 'researcher',
        sourceTainted: true,
      },
      { dataDir, now: now - 5000_000 },
    )
    archiveWikiPage(db, 'client', 'archived-tainted', { dataDir, now: now - 4900_000 })
    recordAction(db, {
      botId: scout.id,
      threadId: gWikiRead,
      trigger: 'you',
      tool: 'wiki_read',
      summary: 'client/archived-tainted',
      ok: true,
      ms: 10,
      at: now - 3600_000 - 18 * 60_000, // 18 minutes BEFORE the final text message!
    })
    insertMessage(db, {
      threadId: gWikiRead,
      sender: scout.id,
      kind: 'text',
      content: 'Long 18-minute turn finished summarizing client status.',
      createdAt: now - 3600_000,
    })

    // 3. thread_checkpoints.had_webhook = 1
    const gCheckpoint = ensureGroupThread(db, 'group:t-cp', 'CP', [scout.id])
    db.prepare(
      `INSERT INTO thread_checkpoints (thread_id, bot_id, through_message_id, summary, source_count, had_webhook, created_at)
       VALUES (?, ?, 1, 'compressed webhook summary', 5, 1, ?)`,
    ).run(gCheckpoint, scout.id, now - 4000_000)
    insertMessage(db, {
      threadId: gCheckpoint,
      sender: scout.id,
      kind: 'text',
      content: 'Follow-up note after checkpoint with compressed webhook.',
      createdAt: now - 3600_000,
    })

    // 4. background_tasks.source_tainted = 1
    const gBg = ensureGroupThread(db, 'group:t-bg', 'BG', [scout.id])
    db.prepare(
      `INSERT INTO background_tasks (id, bot_id, thread_id, title, instructions, status, source_tainted, created_at)
       VALUES ('bg-t1', ?, ?, 'Task', 'Do work', 'completed', 1, ?)`,
    ).run(scout.id, gBg, now - 4000_000)
    insertMessage(db, {
      threadId: gBg,
      sender: scout.id,
      kind: 'text',
      content: 'Background research summary posted into group thread.',
      createdAt: now - 3600_000,
    })

    // 5. dispatch_plans step output_tainted = 1
    const gPlan = ensureGroupThread(db, 'group:t-plan', 'Plan', [scout.id])
    db.prepare(
      `INSERT INTO dispatch_plans (id, thread_id, created_by, title, status, source_tainted, created_at)
       VALUES ('plan-t1', ?, ?, 'Pipeline', 'completed', 0, ?)`,
    ).run(gPlan, scout.id, now - 4000_000)
    db.prepare(
      `INSERT INTO dispatch_plan_steps (plan_id, step_id, seq, bot_id, title, instructions, status, output_tainted)
       VALUES ('plan-t1', 's1', 0, ?, 'Step 1', 'Fetch external', 'completed', 1)`,
    ).run(scout.id)
    insertMessage(db, {
      threadId: gPlan,
      sender: scout.id,
      kind: 'text',
      content: 'Pipeline completed with downstream synthesis notes.',
      createdAt: now - 3600_000,
    })

    // 6. feed_items.tainted = 1 & ideas.tainted = 1
    const gFeed = ensureGroupThread(db, 'group:t-feed', 'Feed', [scout.id])
    db.prepare(
      `INSERT INTO feed_items (id, kind, bot_id, thread_id, title, tainted, created_at, updated_at)
       VALUES ('feed-t1', 'signal', ?, ?, 'External signal', 1, ?, ?)`,
    ).run(scout.id, gFeed, now - 4000_000, now - 4000_000)
    insertMessage(db, {
      threadId: gFeed,
      sender: 'user',
      kind: 'text',
      content: 'Followed up on the external signal in this thread.',
      createdAt: now - 3600_000,
    })

    const gIdea = ensureGroupThread(db, 'group:t-idea', 'Idea', [scout.id])
    db.prepare(
      `INSERT INTO ideas (id, title, tainted, incubation_thread_id, created_at, updated_at)
       VALUES ('idea-t1', 'External idea', 1, ?, ?, ?)`,
    ).run(gIdea, now - 4000_000, now - 4000_000)
    insertMessage(db, {
      threadId: gIdea,
      sender: scout.id,
      kind: 'text',
      content: 'Incubated external idea into concrete project facts.',
      createdAt: now - 3600_000,
    })

    await syncWikiFromChats({ db, dataDir, llm, now: () => now }, { force: true })

    for (const slug of [
      'group-t-wikiread',
      'group-t-cp',
      'group-t-bg',
      'group-t-plan',
      'group-t-feed',
      'group-t-idea',
    ]) {
      expect(getWikiPage(db, 'topic', slug)?.sourceTainted).toBe(true)
    }

    db.close()
  })

  it('never skips unformatted tail rows on MAX_TOTAL_TRANSCRIPT_CHARS overflow, drains multi-batch threads on force=true, strips prefix noise from RRF context, and aborts cleanly on stopAll()', async () => {
    const dataDir = makeTempDir()
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const dmScout = ensureDmThread(db, scout.id)
    const now = Date.UTC(2026, 10, 25, 21, 0, 0)

    // Seed a page whose only keyword is "Msg" / "Operator" -> must NOT be matched as a false positive from "[#msg:1] Operator:" prefix!
    upsertWikiPage(
      db,
      {
        kind: 'topic',
        slug: 'operator-msg-noise',
        title: 'Operator Msg Noise',
        body: 'Should not match prefix tokens.',
        editedBy: 'operator',
      },
      { dataDir, now: now - 5000_000 },
    )

    // Insert 15 messages of ~1,000 chars each (~15,000 chars > MAX_TOTAL_TRANSCRIPT_CHARS = 12,000)
    const insertedIds: number[] = []
    for (let i = 1; i <= 15; i++) {
      const m = insertMessage(db, {
        threadId: dmScout,
        sender: 'user',
        kind: 'text',
        content: `Segment-${i} Aurora architecture detail ${'x'.repeat(980)}`,
        createdAt: now - 3600_000 + i * 1000,
      })
      insertedIds.push(m.id)
    }

    const seenBatches: string[] = []
    let seenFullUserPrompt = ''
    const batchLlm: LLM = {
      async chat(messages) {
        seenFullUserPrompt = String(messages[1]?.content ?? '')
        seenBatches.push(transcriptOf(messages))
        return jsonTurn({ operations: [] })
      },
    }

    // 1. Idle pass (force=false) runs 1 batch and stops at the last row that fit in 12k chars (NOT jumping to row 15!)
    await syncWikiFromChats({ db, dataDir, llm: batchLlm, now: () => now }, { force: false })
    expect(seenBatches).toHaveLength(1)
    expect(seenFullUserPrompt).not.toContain('### topic/operator-msg-noise')
    const afterFirstPass = Number(
      db.prepare('SELECT last_synced_message_id FROM wiki_sync_state WHERE thread_id = ?').pluck().get(dmScout),
    )
    expect(afterFirstPass).toBeGreaterThan(insertedIds[0]!)
    expect(afterFirstPass).toBeLessThan(insertedIds[14]!)

    // 2. Add 30 more short messages and run force=true -> drains ALL remaining batches in one manual sync!
    let lastId = insertedIds[14]!
    for (let i = 16; i <= 45; i++) {
      lastId = insertMessage(db, {
        threadId: dmScout,
        sender: 'user',
        kind: 'text',
        content: `Follow-up item #${i} for Aurora deployment checklist.`,
        createdAt: now - 60_000 + i * 100,
      }).id
    }
    await syncWikiFromChats({ db, dataDir, llm: batchLlm, now: () => now }, { force: true })
    const afterForcePass = Number(
      db.prepare('SELECT last_synced_message_id FROM wiki_sync_state WHERE thread_id = ?').pluck().get(dmScout),
    )
    expect(afterForcePass).toBe(lastId)

    // 3. Shutdown abort via gateway.stopAll() aborts in-flight LLM call cleanly without advancing cursor
    const slowMsg = insertMessage(db, {
      threadId: dmScout,
      sender: 'user',
      kind: 'text',
      content: 'Pending message during shutdown abort verification.',
      createdAt: now,
    })
    let sawSignal: AbortSignal | undefined
    let notifyEntered!: () => void
    const entered = new Promise<void>((r) => {
      notifyEntered = r
    })
    const abortableLlm: LLM = {
      chat(_messages, _tools, opts) {
        sawSignal = opts?.signal
        notifyEntered()
        return new Promise<AssistantTurn>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      },
    }

    const gw = createApp({ db, llm: abortableLlm, dataDir, now: () => new Date(now) })
    const inFlightSync = gw.syncWikiFromChats({ force: true })
    await entered
    await gw.stopAll()
    const abortedResult = await inFlightSync
    expect(sawSignal?.aborted).toBe(true)
    expect(abortedResult.threadsSynced).toBe(0)
    const cursorAfterAbort = Number(
      db.prepare('SELECT last_synced_message_id FROM wiki_sync_state WHERE thread_id = ?').pluck().get(dmScout),
    )
    expect(cursorAfterAbort).toBe(lastId)
    expect(cursorAfterAbort).toBeLessThan(slowMsg.id)

    db.close()
  })
})
