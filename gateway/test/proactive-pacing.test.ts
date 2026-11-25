import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import {
  ensureDmThread,
  insertMessage,
  listMessages,
  openDb,
  upsertBot,
  type BotRow,
  type Db,
} from '../src/db.js'
import { listFeedItems } from '../src/feed/store.js'
import { createHub, type GatewayEvent } from '../src/hub.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import {
  DEFAULT_DAILY_NON_URGENT_CAP,
  DEFAULT_QUIET_CHAT_MS,
  DEFAULT_WEBHOOK_COALESCE_MS,
  MAX_COALESCED_EVENTS,
  MAX_QUEUED_WEBHOOK_EVENTS,
  normalizeProactivePacing,
  pruneDeferredProactive,
} from '../src/proactive/pacing.js'
import { listPendingDigestItems } from '../src/proactive/quiet-hours.js'
import { listRuleProposals } from '../src/proactive/rule-proposals.js'
import { createRoutine } from '../src/routines.js'
import { createApp } from '../src/server.js'

const scout: BotRow = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }

const tempDirs: string[] = []
function makeTempDir(prefix = 'osb-pacing-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function captureHub() {
  const hub = createHub()
  const events: GatewayEvent[] = []
  hub.add({ send: (raw) => events.push(JSON.parse(raw) as GatewayEvent) })
  return { hub, events }
}

function botNonActivityMessages(db: Db, threadId: string) {
  return listMessages(db, threadId).filter((m) => m.sender !== 'user' && m.kind !== 'activity')
}

describe('normalizeProactivePacing', () => {
  it('defaults to disabled when omitted/false and applies defaults or overrides when enabled', () => {
    expect(normalizeProactivePacing()).toEqual({
      enabled: false,
      quietChatMs: 0,
      webhookCoalesceMs: 0,
      dailyNonUrgentCap: 0,
    })
    expect(normalizeProactivePacing(false)).toEqual({
      enabled: false,
      quietChatMs: 0,
      webhookCoalesceMs: 0,
      dailyNonUrgentCap: 0,
    })
    expect(normalizeProactivePacing(true)).toEqual({
      enabled: true,
      quietChatMs: DEFAULT_QUIET_CHAT_MS,
      webhookCoalesceMs: DEFAULT_WEBHOOK_COALESCE_MS,
      dailyNonUrgentCap: DEFAULT_DAILY_NON_URGENT_CAP,
    })
    expect(normalizeProactivePacing({ webhookCoalesceMs: 0, dailyNonUrgentCap: 3 })).toEqual({
      enabled: true,
      quietChatMs: DEFAULT_QUIET_CHAT_MS,
      webhookCoalesceMs: 0,
      dailyNonUrgentCap: 3,
    })
  })
})

describe('Dimension 1 — 60s multi-event webhook coalescing', () => {
  it('coalesces 3 rapid webhook POSTs within 60s into 1 routine run and queues bursts arriving while running instead of returning 409', async () => {
    vi.useFakeTimers()
    const baseTime = new Date('2026-11-25T10:00:00Z')
    vi.setSystemTime(baseTime)

    const dataDir = makeTempDir('osb-hook-coalesce-')
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    let blockFirstRun = true
    let releaseFirstRun!: () => void
    const firstRunGate = new Promise<void>((r) => {
      releaseFirstRun = r
    })
    let notifyFirstRunStarted!: () => void
    const firstRunStarted = new Promise<void>((r) => {
      notifyFirstRunStarted = r
    })

    const seenWebhookChips: string[] = []
    let turnRuns = 0
    const llm: LLM = {
      async chat() {
        turnRuns += 1
        const webhooks = listMessages(db, threadId).filter((m) => m.kind === 'webhook')
        const latestBody = String((webhooks.at(-1)?.payload as { body?: string } | null)?.body ?? '')
        seenWebhookChips.push(latestBody)
        if (blockFirstRun) {
          blockFirstRun = false
          notifyFirstRunStarted()
          await firstRunGate
        }
        const content = `Processed batch #${turnRuns}`
        return { content, toolCalls: [], raw: { role: 'assistant', content } }
      },
    }

    const gw = createApp({
      db,
      llm,
      dataDir,
      proactivePacing: true,
      now: () => new Date(Date.now()),
    })

    const routine = createRoutine(db, {
      botId: scout.id,
      name: 'Issue Triage',
      cron: '',
      webhook: true,
      instructions: 'Summarize incoming webhook events.',
      mode: 'act',
    })

    const postHook = (body: unknown) =>
      gw.app.request(`/hooks/routines/${routine.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-opensuperbot-key': routine.webhook_key!,
        },
        body: JSON.stringify(body),
      })

    // Send 3 rapid webhook POSTs within 60s window
    const r1 = await postHook({ issue: 101, title: 'Login timeout' })
    const r2 = await postHook({ issue: 102, title: 'CSS misalignment' })
    const r3 = await postHook({ issue: 103, title: 'Export CSV UTF-8' })

    expect(r1.status).toBe(202)
    expect(await r1.json()).toEqual({ ok: true, coalesced: true })
    expect(r2.status).toBe(202)
    expect(r3.status).toBe(202)

    // Before 60s elapses, routine has NOT fired yet
    await vi.advanceTimersByTimeAsync(59_000)
    expect(turnRuns).toBe(0)

    // At 60s, all 3 events flush together as a single routine run!
    await vi.advanceTimersByTimeAsync(1_000)
    await firstRunStarted
    expect(turnRuns).toBe(1)
    expect(seenWebhookChips[0]).toContain('--- Event 1/3 ---')
    expect(seenWebhookChips[0]).toContain('101')
    expect(seenWebhookChips[0]).toContain('--- Event 2/3 ---')
    expect(seenWebhookChips[0]).toContain('102')
    expect(seenWebhookChips[0]).toContain('--- Event 3/3 ---')
    expect(seenWebhookChips[0]).toContain('103')

    // While run #1 is STILL in-flight, send a 4th webhook -> returns 202 (NOT 409!) and queues cleanly!
    const r4 = await postHook({ issue: 104, title: 'Burst during in-flight run' })
    expect(r4.status).toBe(202)
    expect(await r4.json()).toEqual({ ok: true, coalesced: true })

    // Advance 60s while run #1 is still running -> bucket marks readyWhenIdle without dropping
    await vi.advanceTimersByTimeAsync(60_000)
    expect(turnRuns).toBe(1)

    // Release run #1 -> queued bucket #2 immediately runs on idle!
    releaseFirstRun()
    await vi.waitFor(() => expect(turnRuns).toBe(2))
    expect(seenWebhookChips[1]).toContain('104')
    expect(seenWebhookChips[1]).not.toContain('--- Event 1/') // Single event passed cleanly

    await gw.stopAll()
    db.close()
  })

  it('caps a single coalesced batch at MAX_COALESCED_EVENTS (10) and preserves remaining events for the next run', async () => {
    const dataDir = makeTempDir('osb-hook-burst12-')
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    const batches: string[] = []
    const llm: LLM = {
      async chat() {
        const webhooks = listMessages(db, threadId).filter((m) => m.kind === 'webhook')
        batches.push(String((webhooks.at(-1)?.payload as { body?: string } | null)?.body ?? ''))
        return { content: 'Nothing new.', toolCalls: [], raw: { role: 'assistant', content: 'Nothing new.' } }
      },
    }

    const gw = createApp({
      db,
      llm,
      dataDir,
      proactivePacing: { webhookCoalesceMs: 40, quietChatMs: 0, dailyNonUrgentCap: 0 },
    })

    const routine = createRoutine(db, {
      botId: scout.id,
      name: 'Burst Watch',
      cron: '',
      webhook: true,
      instructions: 'Watch burst.',
      mode: 'watch',
    })

    expect(MAX_COALESCED_EVENTS).toBe(10)
    for (let i = 1; i <= 12; i++) {
      const res = await gw.app.request(`/hooks/routines/${routine.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-opensuperbot-key': routine.webhook_key! },
        body: JSON.stringify({ seq: i }),
      })
      expect(res.status).toBe(202)
    }

    await vi.waitFor(() => expect(batches).toHaveLength(2))
    expect(batches[0]).toContain('--- Event 10/10 ---')
    expect(batches[1]).toContain('--- Event 1/2 ---')
    expect(batches[1]).toContain('"seq": 12')

    await gw.stopAll()
    db.close()
  })
})

describe('Dimension 2 — 3-minute active-chat deferral & restart recovery', () => {
  it('defers non-urgent proactive output when operator spoke < 3m ago, survives gateway restart, flushes after 3m quiet, and propagates taint', async () => {
    const dir = makeTempDir('osb-defer-restart-')
    const dbPath = join(dir, 'test.db')
    let db = openDb(dbPath)
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    let nowMs = Date.UTC(2026, 10, 25, 10, 0, 0)

    // Operator sent a message 1 minute ago
    insertMessage(db, {
      threadId,
      sender: 'user',
      kind: 'text',
      content: 'Working on the Q4 deck right now.',
      createdAt: nowMs - 60_000,
    })

    const llm1: LLM = {
      async chat(_msgs, _tools) {
        return {
          content: null,
          toolCalls: [
            {
              id: 'wf_1',
              name: 'web_fetch',
              args: { url: 'https://example.com/news' },
            },
          ],
          raw: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'wf_1', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://example.com/news"}' } }],
          },
        }
      },
    }
    let step = 0
    const scriptedRoutineLlm: LLM = {
      async chat(msgs, tools) {
        step += 1
        if (step === 1) return llm1.chat(msgs, tools)
        const content = 'Competitor announced a minor UI refresh.'
        return { content, toolCalls: [], raw: { role: 'assistant', content } }
      },
    }

    const gw1 = createApp({
      db,
      llm: scriptedRoutineLlm,
      dataDir: dir,
      proactivePacing: true,
      webResearch: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response('Minor UI refresh', { status: 200, headers: { 'content-type': 'text/plain' } }),
      },
      now: () => new Date(nowMs),
    })

    const routine = createRoutine(db, {
      botId: scout.id,
      name: 'Competitor Watch',
      cron: '*/30 * * * *',
      instructions: 'Check competitor news.',
      mode: 'watch',
    })

    // Clear pending_taint before routine to verify flush propagates taint when delivered later
    db.prepare('DELETE FROM wiki_sync_state WHERE thread_id = ?').run(threadId)

    expect(await gw1.runRoutine(routine)).toBe('ran')

    // Because operator spoke 60s ago (< 180s), no bot message was posted to thread yet!
    expect(botNonActivityMessages(db, threadId)).toEqual([])
    const deferredRows = db.prepare('SELECT * FROM proactive_deferred WHERE delivered_at IS NULL').all() as Array<{
      bot_id: string
      summary: string
      source_tainted: number
      deliver_after: number
    }>
    expect(deferredRows).toHaveLength(1)
    expect(deferredRows[0]).toMatchObject({
      bot_id: scout.id,
      summary: 'Competitor announced a minor UI refresh.',
      source_tainted: 1,
    })

    // At T0 + 60s (total 2m since operator message, still < 3m): flush is a no-op
    nowMs += 60_000
    expect(await gw1.flushDeferredProactiveIfDue()).toBe(0)
    expect(botNonActivityMessages(db, threadId)).toEqual([])

    // Simulate gateway shutdown & restart against the same SQLite file!
    await gw1.stopAll()
    db.close()

    db = openDb(dbPath)
    const { hub: hub2, events: events2 } = captureHub()
    const gw2 = createApp({
      db,
      llm: scriptedRoutineLlm,
      dataDir: dir,
      hub: hub2,
      proactivePacing: true,
      now: () => new Date(nowMs),
    })

    // Clear wiki_sync_state on restarted DB to prove deferred flush itself restores pending_taint = 1!
    db.prepare('UPDATE wiki_sync_state SET pending_taint = 0 WHERE thread_id = ?').run(threadId)

    // Still at 2m -> HTTP flush returns flushed: 0
    const earlyRes = await gw2.app.request('/api/proactive/flush-deferred', { method: 'POST' })
    expect(earlyRes.status).toBe(200)
    expect(await earlyRes.json()).toEqual({ ok: true, flushed: 0 })

    // Advance another 65s -> > 3 minutes since operator's last message!
    nowMs += 65_000
    const dueRes = await gw2.app.request('/api/proactive/flush-deferred', { method: 'POST' })
    expect(dueRes.status).toBe(200)
    expect(await dueRes.json()).toEqual({ ok: true, flushed: 1 })

    const delivered = botNonActivityMessages(db, threadId)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      sender: scout.id,
      kind: 'text',
      content: 'Competitor announced a minor UI refresh.',
    })
    expect(events2.some((e) => e.type === 'message' && e.message.id === delivered[0]!.id)).toBe(true)

    // Taint propagated on flush!
    const syncState = db
      .prepare('SELECT pending_taint FROM wiki_sync_state WHERE thread_id = ?')
      .get(threadId) as { pending_taint: number } | undefined
    expect(syncState?.pending_taint).toBe(1)

    // Second flush is idempotent
    expect(await gw2.flushDeferredProactiveIfDue()).toBe(0)

    await gw2.stopAll()
    db.close()
  })
})

describe('Dimension 3 — 5/day non-urgent cap, overflow to Feed + Digest, urgent/manual breakthrough, and /api/proactive/dream route', () => {
  it('allows 5 non-urgent proactive deliveries per local day, routes the 6th to Feed + quiet_digest_items, lets urgent:true and force:true break through immediately, and resets next local day', async () => {
    const dataDir = makeTempDir('osb-daily-cap-')
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    // 2026-11-25 10:00 Asia/Shanghai (02:00 UTC)
    let nowMs = new Date('2026-11-25T02:00:00Z').getTime()

    type Step = AssistantTurn | ((messages: ChatMsg[]) => AssistantTurn)
    const queueSteps: Step[] = []
    const llm: LLM = {
      async chat(messages) {
        const next = queueSteps.shift()
        if (!next) {
          return { content: 'Nothing new.', toolCalls: [], raw: { role: 'assistant', content: 'Nothing new.' } }
        }
        return typeof next === 'function' ? next(messages) : next
      },
    }

    const gw = createApp({
      db,
      llm,
      dataDir,
      timeZone: 'Asia/Shanghai',
      proactivePacing: true,
      settings: { env: {}, startedWith: loadConfig({ OPENSUPERBOT_DATA: dataDir }) },
      now: () => new Date(nowMs),
    })

    const routine = createRoutine(db, {
      botId: scout.id,
      name: 'Market Pulse',
      cron: '0 * * * *',
      instructions: 'Check pulse.',
      mode: 'act',
    })

    // Runs 1..5: non-urgent proactive updates -> all 5 land directly in dm:researcher
    for (let i = 1; i <= 5; i++) {
      nowMs += 10 * 60_000
      const content = `Proactive update #${i}`
      queueSteps.push({ content, toolCalls: [], raw: { role: 'assistant', content } })
      expect(await gw.runRoutine(routine)).toBe('ran')
    }
    expect(botNonActivityMessages(db, threadId)).toHaveLength(5)
    expect(listPendingDigestItems(db, scout.id)).toHaveLength(0)

    // Run 6: 6th non-urgent report on the SAME local day -> capped! Routed to quiet_digest_items + Today Feed, NOT in chat thread!
    nowMs += 10 * 60_000
    const sixthArgs = {
      kind: 'report',
      payload: {
        lines: [{ system: 'Pulse', result: '6th update overflowed', count: '1' }],
        closing: 'Low-priority afternoon note.',
      },
    }
    queueSteps.push(
      {
        content: null,
        toolCalls: [{ id: 'r6', name: 'message_user', args: sixthArgs }],
        raw: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'r6', type: 'function', function: { name: 'message_user', arguments: JSON.stringify(sixthArgs) } }],
        },
      },
      // Empty follow-up content after intercepted message_user in act mode must NOT fail empty-reply check!
      { content: '', toolCalls: [], raw: { role: 'assistant', content: '' } },
    )
    expect(await gw.runRoutine(routine)).toBe('ran')

    expect(botNonActivityMessages(db, threadId)).toHaveLength(5) // Still 5 in thread!
    const digestPending = listPendingDigestItems(db, scout.id)
    expect(digestPending).toHaveLength(1)
    expect(digestPending[0]).toMatchObject({
      kind: 'report',
      summary: 'Low-priority afternoon note.',
    })
    const feedItems = listFeedItems(db, { botId: scout.id })
    expect(feedItems.some((f) => f.summary.includes('Low-priority afternoon note.'))).toBe(true)

    // Run 7: urgent: true report + non-empty closing text -> BOTH break through immediately into thread despite 5/day cap AND recent user message (I1)!
    insertMessage(db, {
      threadId,
      sender: 'user',
      kind: 'text',
      content: 'In a meeting right now.',
      createdAt: nowMs - 10_000, // 10s ago (< 3m!)
    })
    const urgentArgs = {
      kind: 'report',
      urgent: true,
      payload: {
        lines: [{ system: 'Prod API', result: '502 gateway outage', count: '100%' }],
        closing: 'Production API is down right now!',
      },
    }
    queueSteps.push(
      {
        content: null,
        toolCalls: [{ id: 'r7', name: 'message_user', args: urgentArgs }],
        raw: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'r7', type: 'function', function: { name: 'message_user', arguments: JSON.stringify(urgentArgs) } }],
        },
      },
      {
        content: 'Immediate action needed: fail over traffic to eu-west.',
        toolCalls: [],
        raw: { role: 'assistant', content: 'Immediate action needed: fail over traffic to eu-west.' },
      },
    )
    expect(await gw.runRoutine(routine)).toBe('ran')
    const afterUrgent = botNonActivityMessages(db, threadId)
    expect(afterUrgent).toHaveLength(7) // 5 prior + urgent report + urgent closing text!
    expect(afterUrgent.at(-2)?.kind).toBe('report')
    expect(afterUrgent.at(-2)?.payload).toMatchObject({ closing: 'Production API is down right now!' })
    expect(afterUrgent.at(-1)?.content).toBe('Immediate action needed: fail over traffic to eu-west.')

    // Run 8: manual force: true run -> also bypasses both active-chat deferral and 5/day cap!
    queueSteps.push({
      content: 'Manual forced run output.',
      toolCalls: [],
      raw: { role: 'assistant', content: 'Manual forced run output.' },
    })
    expect(await gw.runRoutine(routine, { force: true })).toBe('ran')
    expect(botNonActivityMessages(db, threadId)).toHaveLength(8)
    expect(botNonActivityMessages(db, threadId).at(-1)?.content).toBe('Manual forced run output.')

    // Operator replies to the proactive thread with an explicit standing rule -> POST /api/proactive/dream creates RuleProposalChip!
    insertMessage(db, {
      threadId,
      sender: 'user',
      kind: 'text',
      content: 'From now on only alert me on Market Pulse when variance exceeds 5%.',
      createdAt: nowMs + 1_000,
    })
    queueSteps.push((messages) => {
      const prompt = String(messages[1]?.content ?? '')
      const signals = prompt.includes('variance exceeds 5%')
        ? [
            {
              signalType: 'meta_preference',
              areaKey: 'market-pulse-threshold',
              areaLabel: 'Market Pulse alerts',
              leaning: 'stay_silent',
              explicitRule: true,
              evidence: 'only alert when variance exceeds 5%',
              rule: 'Only send Market Pulse chat alerts when variance exceeds 5%',
              reason: 'Explicit threshold requested in chat',
            },
          ]
        : []
      const content = JSON.stringify({ signals })
      return { content, toolCalls: [], raw: { role: 'assistant', content } }
    })
    queueSteps.push((messages) => {
      const prompt = String(messages[1]?.content ?? '')
      const signals = prompt.includes('variance exceeds 5%')
        ? [
            {
              signalType: 'meta_preference',
              areaKey: 'market-pulse-threshold',
              areaLabel: 'Market Pulse alerts',
              leaning: 'stay_silent',
              explicitRule: true,
              evidence: 'only alert when variance exceeds 5%',
              rule: 'Only send Market Pulse chat alerts when variance exceeds 5%',
              reason: 'Explicit threshold requested in chat',
            },
          ]
        : []
      const content = JSON.stringify({ signals })
      return { content, toolCalls: [], raw: { role: 'assistant', content } }
    })

    const dreamRes = await gw.app.request('/api/proactive/dream', { method: 'POST' })
    expect(dreamRes.status).toBe(200)
    const dreamJson = (await dreamRes.json()) as {
      ok: boolean
      evaluated: number
      proposalsCreated: number
    }
    expect(dreamJson.ok).toBe(true)
    expect(dreamJson.proposalsCreated).toBe(1)
    expect(listRuleProposals(db, { botId: scout.id })[0]).toMatchObject({
      source: 'dreaming',
      rule: 'Only send Market Pulse chat alerts when variance exceeds 5%',
    })

    // Advance clock to next local day in Asia/Shanghai (2026-11-26 09:00 CST == 2026-11-26T01:00:00Z) -> cap resets!
    nowMs = new Date('2026-11-26T01:00:00Z').getTime()
    queueSteps.push({
      content: 'Fresh day update #1.',
      toolCalls: [],
      raw: { role: 'assistant', content: 'Fresh day update #1.' },
    })
    expect(await gw.runRoutine(routine)).toBe('ran')
    expect(botNonActivityMessages(db, threadId).some((m) => m.content === 'Fresh day update #1.')).toBe(true)

    await gw.stopAll()
    db.close()
  })

  it('I1, I3, I4, M2, M3: counts report+closing text as 1 daily slot, caps queued webhooks at 50 (429), drops deleted-bot deferred items cleanly, prunes settled rows, and enforces auth + 502 error handling on /api/proactive/*', async () => {
    expect(MAX_QUEUED_WEBHOOK_EVENTS).toBe(50)
    const dataDir = makeTempDir('osb-pacing-hardening-')
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)
    let nowMs = new Date('2026-11-25T04:00:00Z').getTime()

    let failDream = false
    let holdHookBatch = false
    let releaseHookBatch!: () => void
    const hookBatchGate = new Promise<void>((r) => {
      releaseHookBatch = r
    })
    let stepIdx = 0
    const repArgs = {
      kind: 'report',
      payload: { lines: [{ system: 'Check', result: 'ok', count: '1' }], closing: 'Summary.' },
    }
    const llm: LLM = {
      async chat() {
        if (failDream) throw new Error('Dream model unreachable')
        if (holdHookBatch) await hookBatchGate
        stepIdx += 1
        if (stepIdx % 2 === 1) {
          return {
            content: null,
            toolCalls: [{ id: `rep_${stepIdx}`, name: 'message_user', args: repArgs }],
            raw: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: `rep_${stepIdx}`, type: 'function', function: { name: 'message_user', arguments: JSON.stringify(repArgs) } }],
            },
          }
        }
        return { content: 'Closing follow-up line.', toolCalls: [], raw: { role: 'assistant', content: 'Closing follow-up line.' } }
      },
    }

    const gw = createApp({
      db,
      llm,
      dataDir,
      token: 'secret-token-123',
      proactivePacing: { quietChatMs: 180_000, webhookCoalesceMs: 60_000, dailyNonUrgentCap: 2 },
      now: () => new Date(nowMs),
    })

    // M3: Unauthenticated POST /api/proactive/dream and /api/proactive/flush-deferred return 401
    expect((await gw.app.request('/api/proactive/dream', { method: 'POST' })).status).toBe(401)
    expect((await gw.app.request('/api/proactive/flush-deferred', { method: 'POST' })).status).toBe(401)

    const routine = createRoutine(db, {
      botId: scout.id,
      name: 'Combined Check',
      cron: '0 * * * *',
      webhook: true,
      instructions: 'Run check.',
      mode: 'act',
    })

    // I1: Run 1 emits BOTH report AND closing text -> counts as 1 slot (not 2!), so Run 2 ALSO delivers to thread under cap = 2!
    expect(await gw.runRoutine(routine)).toBe('ran')
    expect(await gw.runRoutine(routine)).toBe('ran')
    // 2 runs * (1 report + 1 closing text) = 4 non-activity messages in thread
    expect(botNonActivityMessages(db, threadId)).toHaveLength(4)

    // Run 3 hits cap = 2 -> overflows to Feed (with tainted = true per I4) + quiet_digest_items without creating 2 Feed cards!
    expect(await gw.runRoutine(routine)).toBe('ran')
    expect(botNonActivityMessages(db, threadId)).toHaveLength(4)
    const overflowFeed = listFeedItems(db, { botId: scout.id })
    expect(overflowFeed).toHaveLength(1)
    expect(overflowFeed[0]!.tainted).toBe(true)

    // I3: Hold batch #1 (events 1..10) in-flight, then queue 50 more events (11..60) -> 61st returns 429 webhook_queue_full!
    holdHookBatch = true
    for (let i = 1; i <= 60; i++) {
      const r = await gw.app.request(`/hooks/routines/${routine.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-opensuperbot-key': routine.webhook_key! },
        body: JSON.stringify({ n: i }),
      })
      expect(r.status).toBe(202)
    }
    const rOverflow = await gw.app.request(`/hooks/routines/${routine.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opensuperbot-key': routine.webhook_key! },
      body: JSON.stringify({ n: 61 }),
    })
    expect(rOverflow.status).toBe(429)
    expect(await rOverflow.json()).toMatchObject({ code: 'webhook_queue_full' })

    // Cancel pending queued webhooks cleanly by disabling the routine, then release the held run
    const authHeaders = { authorization: 'Bearer secret-token-123', 'content-type': 'application/json' }
    await gw.app.request(`/api/routines/${routine.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ enabled: false }),
    })
    holdHookBatch = false
    releaseHookBatch()
    await vi.waitFor(() => expect(gw.isBusy(scout.id)).toBe(false))

    // I4: Deleted bot row in proactive_deferred is marked dropped on flush without creating orphan messages/feed/digest
    db.prepare(
      `INSERT INTO proactive_deferred
         (bot_id, thread_id, routine_id, routine_name, routine_mode, kind, summary, payload_json, source_tainted, created_at, deliver_after, delivered_at)
       VALUES ('deleted-ghost', 'dm:deleted-ghost', NULL, 'Ghost', 'watch', 'text', 'Orphan msg', '{"text":"Orphan msg"}', 0, ?, ?, NULL)`,
    ).run(nowMs - 5_000, nowMs - 1_000)
    const flushGhostRes = await gw.app.request('/api/proactive/flush-deferred', {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    })
    expect(flushGhostRes.status).toBe(200)
    expect(listMessages(db, 'dm:deleted-ghost')).toEqual([])
    expect(
      db.prepare('SELECT kind, delivered_at FROM proactive_deferred WHERE bot_id = ?').get('deleted-ghost'),
    ).toMatchObject({ kind: 'dropped' })

    // M2: pruneDeferredProactive removes settled rows older than cutoff while keeping recent/pending rows
    db.prepare('UPDATE proactive_deferred SET delivered_at = ? WHERE bot_id = ?').run(1_000, 'deleted-ghost')
    expect(pruneDeferredProactive(db, 5_000)).toBe(1)

    // M3: POST /api/proactive/dream returns 502 { code: 'dream_failed' } when LLM throws
    insertMessage(db, {
      threadId,
      sender: 'user',
      kind: 'text',
      content: 'Never send Combined Check on Sundays.',
      createdAt: nowMs + 2_000,
    })
    failDream = true
    const dreamErrRes = await gw.app.request('/api/proactive/dream', {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    })
    expect(dreamErrRes.status).toBe(502)
    expect(await dreamErrRes.json()).toMatchObject({ code: 'dream_failed' })

    await gw.stopAll()
    db.close()
  })
})
