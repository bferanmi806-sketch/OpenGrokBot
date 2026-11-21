import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRule } from '../src/approvals.js'
import { createFakeComputer } from '../src/computer.js'
import { loadConfig } from '../src/config.js'
import {
  ensureDmThread,
  listMessages,
  openDb,
  upsertBot,
  type BotRow,
} from '../src/db.js'
import type { AssistantTurn, ChatMsg, ChatOptions, LLM, LlmPriority, ToolDef } from '../src/llm.js'
import { createLlmQueue, type LlmQueueSnapshot } from '../src/llm-queue.js'
import { createPool } from '../src/pool.js'
import { createRoutine } from '../src/routines.js'
import { createApp, type GatewayApp } from '../src/server.js'
import { currentConfig, saveSettings } from '../src/settings.js'

const tempDirs: string[] = []
function makeTempDir(prefix = 'osb-llm-queue-srv-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const textTurn = (content: string): AssistantTurn => ({
  content,
  toolCalls: [],
  raw: { role: 'assistant', content },
})

const toolTurn = (id: string, name: string, args: Record<string, unknown>): AssistantTurn => ({
  content: null,
  toolCalls: [{ id, name, args }],
  raw: {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  },
})

const makeBot = (id: string, name: string): BotRow => ({
  id,
  name,
  role: 'teammate',
  emoji: '🤖',
  soul_path: '',
})

function jsonPost(body: unknown) {
  return {
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function getQueueSnapshot(gw: GatewayApp): Promise<LlmQueueSnapshot> {
  const res = await gw.app.request('/api/llm-queue')
  expect(res.status).toBe(200)
  return (await res.json()) as LlmQueueSnapshot
}

type GateCall = {
  botId: string
  step: number
  priority: LlmPriority | undefined
  toolNames: string[]
  messages: ChatMsg[]
  release: (turn: AssistantTurn) => void
}

function makeGatedLlm(
  botId: string,
  onEnter: (call: GateCall) => void,
): { llm: LLM; calls: GateCall[] } {
  const calls: GateCall[] = []
  const llm: LLM = {
    async chat(messages: ChatMsg[], tools: ToolDef[], opts?: ChatOptions): Promise<AssistantTurn> {
      const gate = deferred<AssistantTurn>()
      const entry: GateCall = {
        botId,
        step: calls.length + 1,
        priority: opts?.priority,
        toolNames: tools.map((t) => t.function.name),
        messages: messages.map((m) => ({ ...m })),
        release: (turn) => gate.resolve(turn),
      }
      calls.push(entry)
      onEnter(entry)
      return gate.promise
    },
  }
  return { llm, calls }
}

describe('local LLM priority queue gateway integration', () => {
  it('preempts between steps in P0 > P1 > P2 order across loopback aliases and reports live /api/llm-queue snapshots', async () => {
    const dataDir = makeTempDir('osb-llmq-preempt-')
    const db = openDb(':memory:')
    const botA = makeBot('bot-a', 'Alpha')
    const botB = makeBot('bot-b', 'Beta')
    const botC = makeBot('bot-c', 'Gamma')
    const botD = makeBot('bot-d', 'Delta')
    for (const bot of [botA, botB, botC, botD]) {
      upsertBot(db, bot)
      ensureDmThread(db, bot.id)
    }

    const llmQueue = createLlmQueue({ concurrency: 1 })
    const entered: string[] = []
    const seenPriorities: Record<string, LlmPriority | undefined> = {}

    const gatedA = makeGatedLlm(botA.id, (c) => {
      const tag = `botA:step${c.step}`
      entered.push(tag)
      seenPriorities[tag] = c.priority
    })
    const gatedB = makeGatedLlm(botB.id, (c) => {
      entered.push('botB:prepare')
      seenPriorities['botB:prepare'] = c.priority
    })
    const gatedC = makeGatedLlm(botC.id, (c) => {
      entered.push('botC:dm')
      seenPriorities['botC:dm'] = c.priority
    })
    const gatedD = makeGatedLlm(botD.id, (c) => {
      entered.push('botD:webhook')
      seenPriorities['botD:webhook'] = c.priority
    })

    // Mix 127.0.0.1 and localhost on port 11434 to verify loopback aliasing end-to-end
    const wrappedByBot: Record<string, LLM> = {
      [botA.id]: llmQueue.wrap(gatedA.llm, 'http://127.0.0.1:11434/v1', { model: 'qwen3:8b' }),
      [botB.id]: llmQueue.wrap(gatedB.llm, 'http://localhost:11434/v1', { model: 'qwen3:8b' }),
      [botC.id]: llmQueue.wrap(gatedC.llm, 'http://127.0.0.1:11434/v1', { model: 'llama3.2' }),
      [botD.id]: llmQueue.wrap(gatedD.llm, 'http://localhost:11434/v1', { model: 'llama3.2' }),
    }

    const gw = createApp({
      db,
      llm: wrappedByBot[botA.id]!,
      llmFor: (id) => ({ llm: wrappedByBot[id]!, vision: false }),
      llmQueue,
      dataDir,
    })

    const watchA = createRoutine(db, {
      botId: botA.id,
      name: 'Hourly Watch',
      cron: '0 * * * *',
      instructions: 'Check wiki for status updates.',
      mode: 'watch',
    })
    const prepareB = createRoutine(db, {
      botId: botB.id,
      name: 'Morning Prep',
      cron: '0 8 * * *',
      instructions: 'Prepare morning brief.',
      mode: 'prepare',
    })
    const webhookD = createRoutine(db, {
      botId: botD.id,
      name: 'Issue Webhook',
      cron: '',
      instructions: 'Triage incoming issue.',
      webhook: true,
    })

    // 1. Bot A starts a 2-step scheduled watch routine (P2) and occupies the single local slot
    const runAPromise = gw.runRoutine(watchA)
    await vi.waitFor(() => expect(gatedA.calls).toHaveLength(1))

    // 2. While Bot A step 1 holds the slot, enqueue Bot B (P2), Bot C (P0 DM), Bot D (P1 webhook)
    const runBPromise = gw.runRoutine(prepareB)
    await vi.waitFor(async () => {
      const snap = await getQueueSnapshot(gw)
      expect(snap.endpoints[0]?.queued).toBe(1)
    })

    const dmRes = await gw.app.request(`/api/threads/dm:${botC.id}/messages`, jsonPost({ text: 'Quick status?' }))
    expect(dmRes.status).toBe(202)
    await vi.waitFor(async () => {
      const snap = await getQueueSnapshot(gw)
      expect(snap.endpoints[0]?.queued).toBe(2)
    })

    const hookRes = await gw.app.request(
      `/hooks/routines/${webhookD.id}?key=${webhookD.webhook_key}`,
      jsonPost({ issue: '#42', severity: 'high' }),
    )
    expect(hookRes.status).toBe(202)
    await vi.waitFor(async () => {
      const snap = await getQueueSnapshot(gw)
      expect(snap.endpoints[0]?.queued).toBe(3)
    })

    // Verify exact live /api/llm-queue snapshot
    expect(await getQueueSnapshot(gw)).toEqual({
      concurrency: 1,
      endpoints: [
        {
          key: 'local:loopback:11434',
          active: 1,
          queued: 3,
          byPriority: { interactive: 1, background: 1, routine: 1, low: 0 },
        },
      ],
    })

    // 3. Release Bot A step 1 with a wiki_search tool call so Bot A will re-enter the queue for step 2 (P2)
    gatedA.calls[0]!.release(toolTurn('tc-wiki', 'wiki_search', { queries: ['status'] }))

    // Bot C (P0 interactive) must enter immediately next, and Bot A step 2 re-queues behind Bot D (P1) and Bot B (P2)
    await vi.waitFor(() => expect(gatedC.calls).toHaveLength(1))
    await vi.waitFor(async () => {
      const snap = await getQueueSnapshot(gw)
      expect(snap.endpoints[0]).toEqual({
        key: 'local:loopback:11434',
        active: 1,
        queued: 3,
        byPriority: { interactive: 0, background: 1, routine: 2, low: 0 },
      })
    })
    expect(entered).toEqual(['botA:step1', 'botC:dm'])

    // 4. Release Bot C -> Bot D (P1 webhook) enters next
    gatedC.calls[0]!.release(textTurn('All green on Gamma.'))
    await vi.waitFor(() => expect(gatedD.calls).toHaveLength(1))
    expect(entered).toEqual(['botA:step1', 'botC:dm', 'botD:webhook'])

    // 5. Release Bot D -> Bot B (P2, queued before Bot A step 2) enters next
    gatedD.calls[0]!.release(textTurn('Webhook triaged.'))
    await vi.waitFor(() => expect(gatedB.calls).toHaveLength(1))
    expect(entered).toEqual(['botA:step1', 'botC:dm', 'botD:webhook', 'botB:prepare'])

    // 6. Release Bot B -> Bot A step 2 (P2 FIFO after Bot B) enters last
    gatedB.calls[0]!.release(textTurn('Nothing to prepare.'))
    await vi.waitFor(() => expect(gatedA.calls).toHaveLength(2))
    expect(entered).toEqual(['botA:step1', 'botC:dm', 'botD:webhook', 'botB:prepare', 'botA:step2'])

    gatedA.calls[1]!.release(textTurn('Nothing new.'))
    await Promise.all([runAPromise, runBPromise])
    await vi.waitFor(() => expect(gw.isBusy(botC.id)).toBe(false))
    await vi.waitFor(() => expect(gw.isBusy(botD.id)).toBe(false))

    expect(seenPriorities).toEqual({
      'botA:step1': 'routine',
      'botC:dm': 'interactive',
      'botD:webhook': 'background',
      'botB:prepare': 'routine',
      'botA:step2': 'routine',
    })
    expect(await getQueueSnapshot(gw)).toEqual({ concurrency: 1, endpoints: [] })
  })

  it('runs manual POST /api/routines/:id/run (force: true) and watch/prepare question answers at P0 while preserving security restrictions', async () => {
    const dataDir = makeTempDir('osb-llmq-manual-q-')
    const db = openDb(':memory:')
    const botA = makeBot('bot-a', 'Alpha')
    const botB = makeBot('bot-b', 'Beta')
    const botC = makeBot('bot-c', 'Gamma')
    for (const bot of [botA, botB, botC]) {
      upsertBot(db, bot)
      ensureDmThread(db, bot.id)
    }

    // Attach a fake computer pool so ordinary turns have shell/write_file, proving watch restrictions stay enforced
    const fakeComputer = createFakeComputer()
    const pool = createPool({
      dataDir,
      makeComputer: async () => fakeComputer,
    })

    // Give botC an active standing rule for email -> replies@acme.com so we can verify origin:'routine' still blocks it
    createRule(db, {
      botId: botC.id,
      kind: 'email',
      target: 'replies@acme.com',
      duration: '24h',
      now: Date.now(),
    })

    const llmQueue = createLlmQueue({ concurrency: 1 })
    const entered: string[] = []
    const gatedA = makeGatedLlm(botA.id, (c) => entered.push(`botA:${c.step}`))
    const gatedB = makeGatedLlm(botB.id, (c) => entered.push(`botB:${c.step}`))
    const gatedC = makeGatedLlm(botC.id, (c) => entered.push(`botC:${c.step}`))

    const wrappedByBot: Record<string, LLM> = {
      [botA.id]: llmQueue.wrap(gatedA.llm, 'http://127.0.0.1:11434/v1', { model: 'qwen3' }),
      [botB.id]: llmQueue.wrap(gatedB.llm, 'http://localhost:11434/v1', { model: 'qwen3' }),
      [botC.id]: llmQueue.wrap(gatedC.llm, 'http://[::1]:11434/v1', { model: 'qwen3' }),
    }

    const gw = createApp({
      db,
      llm: wrappedByBot[botA.id]!,
      llmFor: (id) => ({ llm: wrappedByBot[id]!, vision: false }),
      llmQueue,
      pool,
      dataDir,
    })

    const routineA = createRoutine(db, {
      botId: botA.id,
      name: 'Slot Holder',
      cron: '0 * * * *',
      instructions: 'Hold slot.',
      mode: 'watch',
    })
    const routineB = createRoutine(db, {
      botId: botB.id,
      name: 'Scheduled Watch B',
      cron: '0 * * * *',
      instructions: 'Routine check B.',
      mode: 'watch',
    })
    const routineC = createRoutine(db, {
      botId: botC.id,
      name: 'Manual Watch C',
      cron: '0 * * * *',
      instructions: 'Check alerts and ask operator if needed.',
      mode: 'watch',
    })

    // --- Part A: manual POST /api/routines/:id/run (force: true) preempts scheduled P2 ---
    const hold1 = gw.runRoutine(routineA)
    await vi.waitFor(() => expect(gatedA.calls).toHaveLength(1))

    const schedB1 = gw.runRoutine(routineB)
    await vi.waitFor(async () => {
      expect((await getQueueSnapshot(gw)).endpoints[0]?.queued).toBe(1)
    })

    const manualRes = await gw.app.request(`/api/routines/${routineC.id}/run`, { method: 'POST' })
    expect(manualRes.status).toBe(202)
    await vi.waitFor(async () => {
      expect((await getQueueSnapshot(gw)).endpoints[0]).toEqual({
        key: 'local:loopback:11434',
        active: 1,
        queued: 2,
        byPriority: { interactive: 1, background: 0, routine: 1, low: 0 },
      })
    })

    // Release Bot A -> Bot C (manual force: true -> P0) runs ahead of Bot B (scheduled P2)
    gatedA.calls[0]!.release(textTurn('Nothing new.'))
    await vi.waitFor(() => expect(gatedC.calls).toHaveLength(1))
    expect(entered).toEqual(['botA:1', 'botC:1'])
    expect(gatedC.calls[0]!.priority).toBe('interactive')
    expect(gatedC.calls[0]!.toolNames).not.toContain('shell')
    expect(gatedC.calls[0]!.toolNames).not.toContain('write_file')

    // Have Bot C pose a question in watch mode so we can answer it in Part B.
    // Releasing step 1 immediately hands the free local slot to waiting Bot B (no GPU idle time) while Bot C runs ask_operator.
    gatedC.calls[0]!.release(
      toolTurn('q-1', 'ask_operator', {
        question: 'Escalate anomaly now?',
        options: ['Escalate', 'Ignore'],
      }),
    )
    await vi.waitFor(() => expect(gatedB.calls).toHaveLength(1))
    expect(gatedB.calls[0]!.priority).toBe('routine')
    // Bot C step 2 re-enters the queue at P0 (same manual run) while Bot B is running
    await vi.waitFor(async () => {
      expect((await getQueueSnapshot(gw)).endpoints[0]).toEqual({
        key: 'local:loopback:11434',
        active: 1,
        queued: 1,
        byPriority: { interactive: 1, background: 0, routine: 0, low: 0 },
      })
    })
    gatedB.calls[0]!.release(textTurn('Nothing new.'))

    await vi.waitFor(() => expect(gatedC.calls).toHaveLength(2))
    expect(gatedC.calls[1]!.priority).toBe('interactive')
    gatedC.calls[1]!.release(textTurn('Waiting for your answer.'))

    await Promise.all([hold1, schedB1])
    await vi.waitFor(() => expect(gw.isBusy(botC.id)).toBe(false))

    const questionMsg = listMessages(db, `dm:${botC.id}`).find((m) => m.kind === 'question')
    expect(questionMsg).toBeDefined()
    expect((questionMsg!.payload as { watch?: boolean; status?: string })).toMatchObject({
      watch: true,
      status: 'open',
    })

    // --- Part B: POST /api/questions/:id for a watch question runs at P0 while keeping watch + origin:'routine' restrictions ---
    entered.length = 0
    const hold2 = gw.runRoutine(routineA)
    await vi.waitFor(() => expect(gatedA.calls).toHaveLength(2))

    const schedB2 = gw.runRoutine(routineB)
    await vi.waitFor(async () => {
      expect((await getQueueSnapshot(gw)).endpoints[0]?.queued).toBe(1)
    })

    const answerRes = await gw.app.request(
      `/api/questions/${questionMsg!.id}`,
      jsonPost({ choices: ['Escalate'] }),
    )
    expect(answerRes.status).toBe(202)
    await vi.waitFor(async () => {
      expect((await getQueueSnapshot(gw)).endpoints[0]).toEqual({
        key: 'local:loopback:11434',
        active: 1,
        queued: 2,
        byPriority: { interactive: 1, background: 0, routine: 1, low: 0 },
      })
    })

    // Release Bot A -> Bot C's question-answer turn runs at P0 ahead of Bot B (P2)
    gatedA.calls[1]!.release(textTurn('Nothing new.'))
    await vi.waitFor(() => expect(gatedC.calls).toHaveLength(3))
    expect(entered).toEqual(['botA:2', 'botC:3'])
    const qStep1 = gatedC.calls[2]!
    expect(qStep1.priority).toBe('interactive')
    // Watch tool restrictions still apply (no shell, no write_file, no wiki_upsert, no save_memory)
    expect(qStep1.toolNames).not.toContain('shell')
    expect(qStep1.toolNames).not.toContain('write_file')
    expect(qStep1.toolNames).not.toContain('wiki_upsert')
    expect(qStep1.toolNames).not.toContain('save_memory')

    // Even if model tries to invoke shell AND hold_for_approval (matching a standing rule), both remain restricted.
    // Releasing qStep1 hands the free slot to waiting Bot B while Bot C executes the (refused) shell call.
    qStep1.release(toolTurn('try-shell', 'shell', { cmd: 'echo pwned' }))
    await vi.waitFor(() => expect(gatedB.calls).toHaveLength(2))
    expect(gatedB.calls[1]!.priority).toBe('routine')
    gatedB.calls[1]!.release(textTurn('Nothing new.'))

    await vi.waitFor(() => expect(gatedC.calls).toHaveLength(4))
    expect(gatedC.calls[3]!.priority).toBe('interactive')
    const shellToolMsg = gatedC.calls[3]!.messages.at(-1)
    expect(shellToolMsg?.role).toBe('tool')
    expect(shellToolMsg?.content).toContain('not available in a watch routine')

    gatedC.calls[3]!.release(
      toolTurn('try-approval', 'hold_for_approval', {
        action: 'send escalation email',
        detail: 'Notify ops team',
        kind: 'email',
        target: 'replies@acme.com',
      }),
    )
    await vi.waitFor(() => expect(gatedC.calls).toHaveLength(5))
    expect(gatedC.calls[4]!.priority).toBe('interactive')
    const approvalMsg = listMessages(db, `dm:${botC.id}`).find((m) => m.kind === 'approval_request')
    expect(approvalMsg).toBeDefined()
    expect(approvalMsg!.payload).toMatchObject({
      status: 'pending',
      ruleHeld: 'routine',
    })
    gatedC.calls[4]!.release(textTurn('Held escalation for your approval.'))

    await Promise.all([hold2, schedB2])
    await vi.waitFor(() => expect(gw.isBusy(botC.id)).toBe(false))
    expect(await getQueueSnapshot(gw)).toEqual({ concurrency: 1, endpoints: [] })
  })

  it('removes a queued turn immediately on POST /api/threads/:id/stop without invoking its underlying LLM and keeps subsequent waiters healthy', async () => {
    const dataDir = makeTempDir('osb-llmq-stop-')
    const db = openDb(':memory:')
    const botA = makeBot('bot-a', 'Alpha')
    const botB = makeBot('bot-b', 'Beta')
    const botC = makeBot('bot-c', 'Gamma')
    for (const bot of [botA, botB, botC]) {
      upsertBot(db, bot)
      ensureDmThread(db, bot.id)
    }

    const llmQueue = createLlmQueue({ concurrency: 1 })
    const gatedA = makeGatedLlm(botA.id, () => {})
    const gatedB = makeGatedLlm(botB.id, () => {})
    const gatedC = makeGatedLlm(botC.id, () => {})

    const wrappedByBot: Record<string, LLM> = {
      [botA.id]: llmQueue.wrap(gatedA.llm, 'http://127.0.0.1:11434/v1', { model: 'qwen3' }),
      [botB.id]: llmQueue.wrap(gatedB.llm, 'http://localhost:11434/v1', { model: 'qwen3' }),
      [botC.id]: llmQueue.wrap(gatedC.llm, 'http://127.0.0.1:11434/v1', { model: 'qwen3' }),
    }

    const gw = createApp({
      db,
      llm: wrappedByBot[botA.id]!,
      llmFor: (id) => ({ llm: wrappedByBot[id]!, vision: false }),
      llmQueue,
      dataDir,
    })

    const routineC = createRoutine(db, {
      botId: botC.id,
      name: 'Queued Routine C',
      cron: '0 * * * *',
      instructions: 'Report C status.',
      mode: 'act',
    })

    // Bot A occupies slot 1
    const dmA = await gw.app.request(`/api/threads/dm:${botA.id}/messages`, jsonPost({ text: 'Hold slot' }))
    expect(dmA.status).toBe(202)
    await vi.waitFor(() => expect(gatedA.calls).toHaveLength(1))

    // Bot B queues interactive DM (P0); Bot C queues scheduled routine (P2)
    const dmB = await gw.app.request(`/api/threads/dm:${botB.id}/messages`, jsonPost({ text: 'Cancel me while queued' }))
    expect(dmB.status).toBe(202)
    const runCPromise = gw.runRoutine(routineC)

    await vi.waitFor(async () => {
      expect((await getQueueSnapshot(gw)).endpoints[0]).toEqual({
        key: 'local:loopback:11434',
        active: 1,
        queued: 2,
        byPriority: { interactive: 1, background: 0, routine: 1, low: 0 },
      })
    })

    // Stop Bot B while it is still waiting in the local LLM queue
    const stopRes = await gw.app.request(`/api/threads/dm:${botB.id}/stop`, { method: 'POST' })
    expect(stopRes.status).toBe(200)
    expect(await stopRes.json()).toEqual({ stopped: 1 })

    // Synchronously removed from the local queue; underlying LLM for Bot B was never invoked
    expect(await getQueueSnapshot(gw)).toEqual({
      concurrency: 1,
      endpoints: [
        {
          key: 'local:loopback:11434',
          active: 1,
          queued: 1,
          byPriority: { interactive: 0, background: 0, routine: 1, low: 0 },
        },
      ],
    })
    await vi.waitFor(() => expect(gw.isBusy(botB.id)).toBe(false))
    expect(gatedB.calls).toHaveLength(0)
    const bNotices = listMessages(db, `dm:${botB.id}`).filter(
      (m) => (m.payload as { notice?: string } | null)?.notice === 'stopped',
    )
    expect(bNotices).toHaveLength(1)

    // Releasing Bot A immediately dispatches healthy waiter Bot C
    gatedA.calls[0]!.release(textTurn('Done A.'))
    await vi.waitFor(() => expect(gatedC.calls).toHaveLength(1))
    gatedC.calls[0]!.release(textTurn('Done C.'))

    await runCPromise
    await vi.waitFor(() => expect(gw.isBusy(botA.id)).toBe(false))
    expect(gatedB.calls).toHaveLength(0)
    expect(listMessages(db, `dm:${botC.id}`).some((m) => m.content === 'Done C.')).toBe(true)
    expect(await getQueueSnapshot(gw)).toEqual({ concurrency: 1, endpoints: [] })
  })

  it('dispatches waiting requests immediately when PUT /api/settings increases localLlmConcurrency', async () => {
    const dataDir = makeTempDir('osb-llmq-resize-')
    const db = openDb(':memory:')
    const botA = makeBot('bot-a', 'Alpha')
    const botB = makeBot('bot-b', 'Beta')
    const botC = makeBot('bot-c', 'Gamma')
    for (const bot of [botA, botB, botC]) {
      upsertBot(db, bot)
      ensureDmThread(db, bot.id)
    }

    const startup = loadConfig({ OPENSUPERBOT_DATA: dataDir })
    const live = () => currentConfig(startup, {}, db)
    const llmQueue = createLlmQueue({ concurrency: () => live().localLlmConcurrency })

    const gatedA = makeGatedLlm(botA.id, () => {})
    const gatedB = makeGatedLlm(botB.id, () => {})
    const gatedC = makeGatedLlm(botC.id, () => {})
    const wrappedByBot: Record<string, LLM> = {
      [botA.id]: llmQueue.wrap(gatedA.llm, 'http://127.0.0.1:11434/v1', { model: 'qwen3' }),
      [botB.id]: llmQueue.wrap(gatedB.llm, 'http://localhost:11434/v1', { model: 'qwen3' }),
      [botC.id]: llmQueue.wrap(gatedC.llm, 'http://127.0.0.1:11434/v1', { model: 'qwen3' }),
    }

    const gw = createApp({
      db,
      llm: wrappedByBot[botA.id]!,
      llmFor: (id) => ({ llm: wrappedByBot[id]!, vision: false }),
      llmQueue,
      dataDir,
      settings: { env: {}, startedWith: startup },
    })

    const routineC = createRoutine(db, {
      botId: botC.id,
      name: 'Scheduled C',
      cron: '0 * * * *',
      instructions: 'Routine C.',
      mode: 'act',
    })

    // Occupy slot 1 with Bot A, queue Bot C (P2) and Bot B (P0)
    await gw.app.request(`/api/threads/dm:${botA.id}/messages`, jsonPost({ text: 'Hold 1' }))
    await vi.waitFor(() => expect(gatedA.calls).toHaveLength(1))

    const runCPromise = gw.runRoutine(routineC)
    await gw.app.request(`/api/threads/dm:${botB.id}/messages`, jsonPost({ text: 'Interactive waiter' }))

    await vi.waitFor(async () => {
      expect(await getQueueSnapshot(gw)).toEqual({
        concurrency: 1,
        endpoints: [
          {
            key: 'local:loopback:11434',
            active: 1,
            queued: 2,
            byPriority: { interactive: 1, background: 0, routine: 1, low: 0 },
          },
        ],
      })
    })
    expect(gatedB.calls).toHaveLength(0)
    expect(gatedC.calls).toHaveLength(0)

    // Raise localLlmConcurrency 1 -> 2 via PUT /api/settings: immediately dispatches highest-priority waiter (Bot B, P0)
    const put2 = await gw.app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localLlmConcurrency: 2 }),
    })
    expect(put2.status).toBe(200)
    const put2Body = (await put2.json()) as { values: { localLlmConcurrency: number }; needsRestart: string[] }
    expect(put2Body.values.localLlmConcurrency).toBe(2)
    expect(put2Body.needsRestart).toEqual([])

    await vi.waitFor(() => expect(gatedB.calls).toHaveLength(1))
    expect(gatedC.calls).toHaveLength(0)
    expect(await getQueueSnapshot(gw)).toEqual({
      concurrency: 2,
      endpoints: [
        {
          key: 'local:loopback:11434',
          active: 2,
          queued: 1,
          byPriority: { interactive: 0, background: 0, routine: 1, low: 0 },
        },
      ],
    })

    // Raise localLlmConcurrency 2 -> 0 (unlimited): immediately dispatches Bot C too without waiting for A or B
    const put0 = await gw.app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localLlmConcurrency: 0 }),
    })
    expect(put0.status).toBe(200)
    await vi.waitFor(() => expect(gatedC.calls).toHaveLength(1))
    expect(await getQueueSnapshot(gw)).toEqual({
      concurrency: 0,
      endpoints: [
        {
          key: 'local:loopback:11434',
          active: 3,
          queued: 0,
          byPriority: { interactive: 0, background: 0, routine: 0, low: 0 },
        },
      ],
    })

    gatedA.calls[0]!.release(textTurn('A done.'))
    gatedB.calls[0]!.release(textTurn('B done.'))
    gatedC.calls[0]!.release(textTurn('C done.'))
    await runCPromise
    await vi.waitFor(() => expect(gw.isBusy(botA.id)).toBe(false))
    await vi.waitFor(() => expect(gw.isBusy(botB.id)).toBe(false))
    expect(await getQueueSnapshot(gw)).toEqual({ concurrency: 0, endpoints: [] })
  })

  it('bypasses local queue completely for cloud bots, prioritizes A2A relays as P1, and falls back cleanly on /api/llm-queue without llmQueue', async () => {
    const dataDir = makeTempDir('osb-llmq-cloud-')
    const db = openDb(':memory:')
    const localA = makeBot('local-a', 'LocalA')
    const localB = makeBot('local-b', 'LocalB')
    const localD = makeBot('local-d', 'LocalD')
    const cloudBot = makeBot('chief', 'ChiefCloud')
    for (const bot of [localA, localB, localD, cloudBot]) {
      upsertBot(db, bot)
      ensureDmThread(db, bot.id)
    }

    const llmQueue = createLlmQueue({ concurrency: 1 })
    const enteredLocal: string[] = []
    const gatedA = makeGatedLlm(localA.id, () => enteredLocal.push('localA'))
    const gatedB = makeGatedLlm(localB.id, () => enteredLocal.push('localB:routine'))
    const gatedD = makeGatedLlm(localD.id, () => enteredLocal.push('localD:relay'))
    const gatedCloud = makeGatedLlm(cloudBot.id, () => {})

    const wrappedByBot: Record<string, LLM> = {
      [localA.id]: llmQueue.wrap(gatedA.llm, 'http://127.0.0.1:11434/v1', { model: 'qwen3' }),
      [localB.id]: llmQueue.wrap(gatedB.llm, 'http://localhost:11434/v1', { model: 'qwen3' }),
      [localD.id]: llmQueue.wrap(gatedD.llm, 'http://[::1]:11434/v1', { model: 'qwen3' }),
      [cloudBot.id]: llmQueue.wrap(gatedCloud.llm, 'https://api.openai.com/v1', { model: 'gpt-4o' }),
    }

    const gw = createApp({
      db,
      llm: wrappedByBot[localA.id]!,
      llmFor: (id) => ({ llm: wrappedByBot[id]!, vision: false }),
      llmQueue,
      chiefId: cloudBot.id,
      dataDir,
      maxSteps: 1,
    })

    const routineB = createRoutine(db, {
      botId: localB.id,
      name: 'Local Routine B',
      cron: '0 * * * *',
      instructions: 'Routine work.',
      mode: 'act',
    })

    // Saturate local Ollama slot with localA and queue localB (P2)
    await gw.app.request(`/api/threads/dm:${localA.id}/messages`, jsonPost({ text: 'Hold local GPU' }))
    await vi.waitFor(() => expect(gatedA.calls).toHaveLength(1))
    const runBPromise = gw.runRoutine(routineB)
    await vi.waitFor(async () => {
      expect((await getQueueSnapshot(gw)).endpoints[0]?.queued).toBe(1)
    })

    // Cloud bot runs and finishes IMMEDIATELY while local slot is saturated, and relays work to localD (P1)
    const cloudDm = await gw.app.request(
      `/api/threads/dm:${cloudBot.id}/messages`,
      jsonPost({ text: 'Hand off task to local-d' }),
    )
    expect(cloudDm.status).toBe(202)
    await vi.waitFor(() => expect(gatedCloud.calls).toHaveLength(1))
    // Cloud endpoint does not appear in local queue snapshot
    expect((await getQueueSnapshot(gw)).endpoints.map((e) => e.key)).toEqual(['local:loopback:11434'])

    // Cloud bot relays to localD via message_bot (also exercises maxSteps: 1 closeOut on cloudBot)
    gatedCloud.calls[0]!.release(
      toolTurn('relay-1', 'message_bot', { to: localD.id, content: 'Draft follow-up notes' }),
    )
    await vi.waitFor(() => expect(gatedCloud.calls).toHaveLength(2))
    expect(gatedCloud.calls[1]!.priority).toBe('interactive')
    gatedCloud.calls[1]!.release(textTurn('Handed off to LocalD.'))
    await vi.waitFor(() => expect(gw.isBusy(cloudBot.id)).toBe(false))

    // localD's A2A relay turn is now queued as P1 (background) ahead of localB (P2 routine)
    await vi.waitFor(async () => {
      expect(await getQueueSnapshot(gw)).toEqual({
        concurrency: 1,
        endpoints: [
          {
            key: 'local:loopback:11434',
            active: 1,
            queued: 2,
            byPriority: { interactive: 0, background: 1, routine: 1, low: 0 },
          },
        ],
      })
    })

    // Release localA -> localD (P1 relay) enters BEFORE localB (P2 routine)
    gatedA.calls[0]!.release(textTurn('LocalA done.'))
    await vi.waitFor(() => expect(gatedD.calls).toHaveLength(1))
    expect(gatedD.calls[0]!.priority).toBe('background')
    expect(enteredLocal).toEqual(['localA', 'localD:relay'])
    gatedD.calls[0]!.release(textTurn('LocalD picked up relay.'))

    // Release localD -> localB enters next; make localB hit maxSteps: 1 to verify closeOut also keeps priority: 'routine'
    await vi.waitFor(() => expect(gatedB.calls).toHaveLength(1))
    expect(gatedB.calls[0]!.priority).toBe('routine')
    gatedB.calls[0]!.release(toolTurn('b-wiki', 'wiki_search', { queries: ['notes'] }))
    await vi.waitFor(() => expect(gatedB.calls).toHaveLength(2))
    expect(gatedB.calls[1]!.priority).toBe('routine')
    gatedB.calls[1]!.release(textTurn('Paused after step limit.'))

    await runBPromise
    await vi.waitFor(() => expect(gw.isBusy(localA.id)).toBe(false))
    await vi.waitFor(() => expect(gw.isBusy(localD.id)).toBe(false))
    expect(enteredLocal).toEqual(['localA', 'localD:relay', 'localB:routine', 'localB:routine'])
    expect(await getQueueSnapshot(gw)).toEqual({ concurrency: 1, endpoints: [] })

    // Verify /api/llm-queue fallback when deps.llmQueue is omitted & token auth enforcement
    const db2 = openDb(':memory:')
    saveSettings(db2, { localLlmConcurrency: 3 })
    const gwNoQueue = createApp({
      db: db2,
      llm: { chat: async () => textTurn('ok') },
      token: 'secret-token',
    })
    const unauth = await gwNoQueue.app.request('/api/llm-queue')
    expect(unauth.status).toBe(401)
    const authed = await gwNoQueue.app.request('/api/llm-queue', {
      headers: { Authorization: 'Bearer secret-token' },
    })
    expect(authed.status).toBe(200)
    expect(await authed.json()).toEqual({ concurrency: 3, endpoints: [] })
  })
})
