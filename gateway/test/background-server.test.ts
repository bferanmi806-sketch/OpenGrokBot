import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRule } from '../src/approvals.js'
import {
  getBackgroundTask,
  STALE_RESTART_ERROR,
  type BackgroundTaskPayload,
  type BackgroundTaskView,
} from '../src/background-tasks.js'
import { createFakeComputer } from '../src/computer.js'
import {
  ensureDmThread,
  getMessage,
  insertMessage,
  listMessages,
  openDb,
  upsertBot,
  type BotRow,
  type Db,
} from '../src/db.js'
import { createHub, type GatewayEvent } from '../src/hub.js'
import type { AssistantTurn, ChatMsg, ChatOptions, LLM, LlmPriority, ToolDef } from '../src/llm.js'
import { createLlmQueue, type LlmQueueSnapshot } from '../src/llm-queue.js'
import { createPool, type Pool } from '../src/pool.js'
import { createApp, type GatewayApp } from '../src/server.js'
import type { WorkflowRecording } from '../src/workflow-recorder.js'
import { parseWorkflowTrace, saveWorkflowTrace } from '../src/workflows.js'

const tempDirs: string[] = []
const openCleanups: Array<() => Promise<void> | void> = []

function makeTempDir(prefix = 'osb-bg-srv-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function trackCleanup(fn: () => Promise<void> | void): void {
  openCleanups.push(fn)
}

afterEach(async () => {
  while (openCleanups.length > 0) {
    await openCleanups.pop()!()
  }
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

const scout: BotRow = {
  id: 'researcher',
  name: 'Scout',
  role: 'research',
  emoji: '🔎',
  soul_path: '',
}

function jsonPost(body: unknown) {
  return {
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

type LaneCall = {
  seq: number
  lane: 'foreground' | 'background'
  laneStep: number
  priority: LlmPriority | undefined
  signal: AbortSignal | undefined
  toolNames: string[]
  messages: ChatMsg[]
  release: (turn: AssistantTurn) => void
  reject: (err: unknown) => void
}

function isBackgroundMessages(messages: ChatMsg[], priority: LlmPriority | undefined): boolean {
  if (priority === 'background') return true
  return messages.some(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[background task bg-'),
  )
}

function makeDualLaneGatedLlm(onEnter?: (call: LaneCall) => void) {
  const allCalls: LaneCall[] = []
  const fgCalls: LaneCall[] = []
  const bgCalls: LaneCall[] = []

  const llm: LLM = {
    async chat(messages: ChatMsg[], tools: ToolDef[], opts?: ChatOptions): Promise<AssistantTurn> {
      if (opts?.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError')
      }
      const gate = deferred<AssistantTurn>()
      const lane = isBackgroundMessages(messages, opts?.priority) ? 'background' : 'foreground'
      const bucket = lane === 'background' ? bgCalls : fgCalls
      const onAbort = () => {
        gate.reject(new DOMException('aborted', 'AbortError'))
      }
      opts?.signal?.addEventListener('abort', onAbort, { once: true })

      const entry: LaneCall = {
        seq: allCalls.length + 1,
        lane,
        laneStep: bucket.length + 1,
        priority: opts?.priority,
        signal: opts?.signal,
        toolNames: tools.map((t) => t.function.name),
        messages: messages.map((m) => ({ ...m })),
        release: (turn) => {
          opts?.signal?.removeEventListener('abort', onAbort)
          gate.resolve(turn)
        },
        reject: (err) => {
          opts?.signal?.removeEventListener('abort', onAbort)
          gate.reject(err)
        },
      }
      allCalls.push(entry)
      bucket.push(entry)
      onEnter?.(entry)
      return gate.promise
    },
  }

  return { llm, allCalls, fgCalls, bgCalls }
}

async function getSummary(gw: GatewayApp) {
  const res = await gw.app.request('/api/summary')
  expect(res.status).toBe(200)
  return (await res.json()) as { working: number; waiting: number; routines: number; backgroundTasks: number }
}

async function getBotBgTasks(gw: GatewayApp, botId = scout.id): Promise<BackgroundTaskView[]> {
  const res = await gw.app.request(`/api/bots/${botId}/background-tasks`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { tasks: BackgroundTaskView[] }
  return body.tasks
}

async function getQueueSnapshot(gw: GatewayApp): Promise<LlmQueueSnapshot> {
  const res = await gw.app.request('/api/llm-queue')
  expect(res.status).toBe(200)
  return (await res.json()) as LlmQueueSnapshot
}

function makeRecordableComputer() {
  return createFakeComputer({
    startWorkflowRecording: async (title): Promise<WorkflowRecording> => ({
      async reattach() {},
      async stop() {
        return parseWorkflowTrace({ format: 'opensuperbot.workflow', version: 1, title, steps: [] })
      },
    }),
  })
}

function setupGateway(opts: {
  llm: LLM
  llmQueue?: ReturnType<typeof createLlmQueue>
  computer?: ReturnType<typeof createFakeComputer>
  db?: Db
  dataDir?: string
  now?: () => Date
}) {
  const dataDir = opts.dataDir ?? makeTempDir()
  const db = opts.db ?? openDb(':memory:')
  upsertBot(db, scout)
  ensureDmThread(db, scout.id)

  const hub = createHub()
  const events: GatewayEvent[] = []
  hub.add({ send: (raw) => events.push(JSON.parse(raw) as GatewayEvent) })

  const computer = opts.computer ?? makeRecordableComputer()
  const pool: Pool = createPool({ dataDir, makeComputer: async () => computer })

  const gw = createApp({
    db,
    llm: opts.llm,
    ...(opts.llmQueue ? { llmQueue: opts.llmQueue } : {}),
    pool,
    hub,
    dataDir,
    ...(opts.now ? { now: opts.now } : {}),
  })

  trackCleanup(async () => {
    await gw.stopAll()
    await pool.disposeAll()
    db.close()
  })

  return { gw, db, hub, events, computer, pool, dataDir }
}

async function delegateTaskViaDm(
  gw: GatewayApp,
  gated: ReturnType<typeof makeDualLaneGatedLlm>,
  opts: { dmText: string; title: string; instructions: string; fgReply?: string },
): Promise<string> {
  const prevFgCount = gated.fgCalls.length
  const res = await gw.app.request(`/api/threads/dm:${scout.id}/messages`, jsonPost({ text: opts.dmText }))
  expect(res.status).toBe(202)

  await vi.waitFor(() => expect(gated.fgCalls.length).toBeGreaterThanOrEqual(prevFgCount + 1))
  const call1 = gated.fgCalls[prevFgCount]!
  call1.release(toolTurn(`del-${call1.seq}`, 'delegate_background_task', {
    title: opts.title,
    instructions: opts.instructions,
  }))

  await vi.waitFor(() => expect(gated.fgCalls.length).toBeGreaterThanOrEqual(prevFgCount + 2))
  const call2 = gated.fgCalls[prevFgCount + 1]!
  const toolResult = JSON.parse(String(call2.messages.at(-1)!.content)) as { ok: boolean; taskId: string }
  expect(toolResult.ok).toBe(true)
  call2.release(textTurn(opts.fgReply ?? 'Started in background — keep chatting anytime.'))

  await vi.waitFor(() => {
    expect(gw.hello()).toEqual({ type: 'hello', statuses: {} })
  })
  return toolResult.taskId
}

describe('Phase 7 AlterEgo background tasks end-to-end', () => {
  it('runs background work non-blockingly and lets P0 foreground DM preempt P1 background steps on a concurrency-1 local LLM', async () => {
    const llmQueue = createLlmQueue({ concurrency: 1 })
    const entered: string[] = []
    const gated = makeDualLaneGatedLlm((c) => {
      entered.push(`${c.lane === 'foreground' ? 'fg' : 'bg'}:${c.laneStep}`)
    })
    const wrappedLlm = llmQueue.wrap(gated.llm, 'http://127.0.0.1:11434/v1', { model: 'qwen3:8b' })

    const { gw, db, events } = setupGateway({ llm: wrappedLlm, llmQueue })

    // 1. Operator asks Scout to do long research -> foreground delegates and replies immediately
    const taskId = await delegateTaskViaDm(gw, gated, {
      dmText: 'Do a deep pricing study across 5 competitors.',
      title: 'Competitor pricing study',
      instructions: 'Research 5 competitors, save notes, and summarize pricing.',
      fgReply: 'Kicked off in the background — I am still free to chat.',
    })

    // Background task enters running on the secondary lane at P1 while foreground stays idle
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(1))
    expect(gated.bgCalls[0]!.priority).toBe('background')
    expect(gw.hello()).toEqual({ type: 'hello', statuses: {} })
    expect(gw.isBusy(scout.id)).toBe(true)

    const tasksRunning = await getBotBgTasks(gw)
    expect(tasksRunning).toHaveLength(1)
    expect(tasksRunning[0]).toMatchObject({
      id: taskId,
      title: 'Competitor pricing study',
      status: 'running',
    })

    const compRes = await gw.app.request(`/api/bots/${scout.id}/computer`)
    expect(compRes.status).toBe(200)
    const compBody = (await compRes.json()) as { backgroundTasks: BackgroundTaskView[] }
    expect(compBody.backgroundTasks).toHaveLength(1)
    expect(compBody.backgroundTasks[0]).toMatchObject({ id: taskId, status: 'running' })

    expect(await getSummary(gw)).toEqual({
      working: 1,
      waiting: 0,
      routines: 0,
      backgroundTasks: 1,
    })

    // 2. While background task step 1 holds the single local LLM slot, operator sends a SECOND foreground DM
    const dm2 = await gw.app.request(`/api/threads/dm:${scout.id}/messages`, jsonPost({ text: 'Quick question: what is 2+2?' }))
    expect(dm2.status).toBe(202)
    await vi.waitFor(async () => {
      expect(await getQueueSnapshot(gw)).toEqual({
        concurrency: 1,
        endpoints: [
          {
            key: 'local:loopback:11434',
            active: 1,
            queued: 1,
            byPriority: { interactive: 1, background: 0, routine: 0, low: 0 },
          },
        ],
      })
    })

    // Release bg step 1 with a tool call -> P0 foreground immediately preempts bg step 2 (P1)!
    gated.bgCalls[0]!.release(toolTurn('bg-w1', 'write_file', { path: 'pricing.md', content: 'Acme $49' }))

    await vi.waitFor(() => expect(gated.fgCalls).toHaveLength(3))
    expect(gated.fgCalls[2]!.priority).toBe('interactive')
    expect(entered).toEqual(['fg:1', 'fg:2', 'bg:1', 'fg:3'])

    // Background step 2 is queued behind active P0 foreground
    await vi.waitFor(async () => {
      expect(await getQueueSnapshot(gw)).toEqual({
        concurrency: 1,
        endpoints: [
          {
            key: 'local:loopback:11434',
            active: 1,
            queued: 1,
            byPriority: { interactive: 0, background: 1, routine: 0, low: 0 },
          },
        ],
      })
    })

    // Foreground answers immediately without waiting for background task to finish
    gated.fgCalls[2]!.release(textTurn('4.'))
    await vi.waitFor(() => {
      expect(listMessages(db, `dm:${scout.id}`).some((m) => m.kind === 'text' && m.content === '4.')).toBe(true)
    })

    // Background step 2 now gets the local slot while task is still running
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(2))
    expect(gated.bgCalls[1]!.priority).toBe('background')
    expect(entered).toEqual(['fg:1', 'fg:2', 'bg:1', 'fg:3', 'bg:2'])
    expect(getBackgroundTask(db, taskId)?.status).toBe('running')

    // 3. Background task completes -> chip updates, isBusy -> false, summary zeroes out
    gated.bgCalls[1]!.release(textTurn('Pricing study complete: Acme $49/mo, Globex $79/mo.'))
    await vi.waitFor(() => expect(gw.isBusy(scout.id)).toBe(false))

    expect(await getSummary(gw)).toEqual({
      working: 0,
      waiting: 0,
      routines: 0,
      backgroundTasks: 0,
    })

    const tasksDone = await getBotBgTasks(gw)
    expect(tasksDone[0]).toMatchObject({
      id: taskId,
      status: 'completed',
      stepCount: 1,
      summary: 'Pricing study complete: Acme $49/mo, Globex $79/mo.',
    })

    const msgs = listMessages(db, `dm:${scout.id}`)
    const bgChip = msgs.find((m) => m.kind === 'background_task')
    expect(bgChip).toBeDefined()
    expect(bgChip!.payload as BackgroundTaskPayload).toMatchObject({
      taskId,
      status: 'completed',
      stepCount: 1,
      summary: 'Pricing study complete: Acme $49/mo, Globex $79/mo.',
    })
    expect(msgs.some((m) => m.kind === 'text' && m.content === 'Pricing study complete: Acme $49/mo, Globex $79/mo.')).toBe(true)
    expect(msgs.filter((m) => m.kind === 'activity')).toEqual([])

    const bgChangedStatuses = events
      .filter((e): e is Extract<GatewayEvent, { type: 'background_task_changed' }> => e.type === 'background_task_changed')
      .map((e) => e.task.status)
    expect(bgChangedStatuses[0]).toBe('queued')
    expect(bgChangedStatuses).toContain('running')
    expect(bgChangedStatuses.at(-1)).toBe('completed')
  })

  it('enforces the per-bot browser lease mutex in both directions and returns 409 for workflow recording while background holds the browser', async () => {
    const gated = makeDualLaneGatedLlm()
    const { gw, db, computer } = setupGateway({ llm: gated.llm })

    // --- Direction A: Background acquires browser -> blocks foreground browser & workflow recording, allows non-browser tools ---
    const bg1Id = await delegateTaskViaDm(gw, gated, {
      dmText: 'Scrape Acme pricing page in the background.',
      title: 'Scrape Acme pricing',
      instructions: 'Open Acme pricing page and collect tiers.',
    })
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(1))

    // BG step 1 calls browser_goto -> acquires browser lease
    gated.bgCalls[0]!.release(toolTurn('bg-goto-1', 'browser_goto', { url: 'https://acme.example/pricing' }))
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(2))

    expect(computer.calls).toEqual(['goto:https://acme.example/pricing'])
    expect(getBackgroundTask(db, bg1Id)?.usesBrowser).toBe(true)
    const chipHolding = listMessages(db, `dm:${scout.id}`).find((m) => m.kind === 'background_task')
    expect((chipHolding?.payload as BackgroundTaskPayload).usesBrowser).toBe(true)

    // Foreground DM tries browser_goto (blocked), then write_file & wiki_search (succeed freely in parallel!)
    const fgStartIdx = gated.fgCalls.length
    const dmRes = await gw.app.request(`/api/threads/dm:${scout.id}/messages`, jsonPost({ text: 'Check another site and save a note' }))
    expect(dmRes.status).toBe(202)

    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgStartIdx + 1))
    gated.fgCalls[fgStartIdx]!.release(toolTurn('fg-goto-blocked', 'browser_goto', { url: 'https://blocked-fg.example' }))

    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgStartIdx + 2))
    const fgGotoReply = String(gated.fgCalls[fgStartIdx + 1]!.messages.at(-1)!.content)
    expect(fgGotoReply).toContain(`background task ${bg1Id}`)
    expect(fgGotoReply).toContain('Scrape Acme pricing')
    // Fake computer goto was NOT called a second time!
    expect(computer.calls.filter((c) => c.startsWith('goto:'))).toEqual(['goto:https://acme.example/pricing'])

    // Non-browser tools run freely in parallel while background holds the browser
    gated.fgCalls[fgStartIdx + 1]!.release(toolTurn('fg-write', 'write_file', { path: 'fg-note.md', content: 'parallel ok' }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgStartIdx + 3))
    expect(String(gated.fgCalls[fgStartIdx + 2]!.messages.at(-1)!.content)).toBe('Wrote fg-note.md.')
    expect(computer.calls).toContain('write:fg-note.md')

    gated.fgCalls[fgStartIdx + 2]!.release(toolTurn('fg-wiki', 'wiki_search', { queries: ['pricing'] }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgStartIdx + 4))
    expect(String(gated.fgCalls[fgStartIdx + 3]!.messages.at(-1)!.content)).not.toContain('browser is currently in use')

    gated.fgCalls[fgStartIdx + 3]!.release(textTurn('Browser was busy, wrote fg-note.md and searched wiki instead.'))
    await vi.waitFor(() => expect(gw.hello()).toEqual({ type: 'hello', statuses: {} }))

    // Workflow recording returns HTTP 409 { error: 'browser_in_use', taskId, title }
    const recBlocked = await gw.app.request(
      `/api/bots/${scout.id}/workflows/recording`,
      jsonPost({ title: 'Record pricing flow' }),
    )
    expect(recBlocked.status).toBe(409)
    expect(await recBlocked.json()).toEqual({
      error: 'browser_in_use',
      taskId: bg1Id,
      title: 'Scrape Acme pricing',
    })

    // Workflow replay also returns HTTP 409 { error: 'browser_in_use', taskId, title }
    const savedWf = saveWorkflowTrace(
      db,
      scout.id,
      parseWorkflowTrace({
        format: 'opensuperbot.workflow',
        version: 1,
        title: 'Replay pricing flow',
        steps: [{ type: 'navigate', url: 'https://acme.example/pricing' }],
      }),
    )
    const runBlocked = await gw.app.request(
      `/api/bots/${scout.id}/workflows/${savedWf.id}/run`,
      jsonPost({}),
    )
    expect(runBlocked.status).toBe(409)
    expect(await runBlocked.json()).toEqual({
      error: 'browser_in_use',
      taskId: bg1Id,
      title: 'Scrape Acme pricing',
    })

    // Complete BG task 1 -> browser lease is released
    gated.bgCalls[1]!.release(textTurn('Acme pricing collected.'))
    await vi.waitFor(() => expect(gw.isBusy(scout.id)).toBe(false))

    // Foreground browser_goto now succeeds
    const fgAfterIdx = gated.fgCalls.length
    await gw.app.request(`/api/threads/dm:${scout.id}/messages`, jsonPost({ text: 'Now open after-bg.example' }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgAfterIdx + 1))
    gated.fgCalls[fgAfterIdx]!.release(toolTurn('fg-goto-ok', 'browser_goto', { url: 'https://after-bg.example' }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgAfterIdx + 2))
    expect(String(gated.fgCalls[fgAfterIdx + 1]!.messages.at(-1)!.content)).toContain('https://after-bg.example')
    expect(computer.calls).toContain('goto:https://after-bg.example')
    gated.fgCalls[fgAfterIdx + 1]!.release(textTurn('Opened after-bg.example.'))
    await vi.waitFor(() => expect(gw.isBusy(scout.id)).toBe(false))

    // Workflow recording also works again
    const recOk = await gw.app.request(
      `/api/bots/${scout.id}/workflows/recording`,
      jsonPost({ title: 'Record pricing flow' }),
    )
    expect(recOk.status).toBe(202)
    expect(await recOk.json()).toEqual({ ok: true, recording: true })
    const recDel = await gw.app.request(`/api/bots/${scout.id}/workflows/recording`, { method: 'DELETE' })
    expect(recDel.status).toBe(204)

    // --- Direction B: Foreground holds browser -> blocks background browser tool -> FG releases -> BG acquires ---
    const bgBeforeIdx = gated.bgCalls.length
    const bg2Id = await delegateTaskViaDm(gw, gated, {
      dmText: 'Run second background research.',
      title: 'Second browser job',
      instructions: 'Browse example site when free.',
    })
    await vi.waitFor(() => expect(gated.bgCalls.length).toBe(bgBeforeIdx + 1))
    expect(getBackgroundTask(db, bg2Id)?.usesBrowser).toBe(false)

    // Start foreground DM and acquire browser lease first, then pause at FG step 2
    const fgHoldIdx = gated.fgCalls.length
    await gw.app.request(`/api/threads/dm:${scout.id}/messages`, jsonPost({ text: 'Open fg-first.example and hold' }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgHoldIdx + 1))
    gated.fgCalls[fgHoldIdx]!.release(toolTurn('fg-hold-goto', 'browser_goto', { url: 'https://fg-first.example' }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgHoldIdx + 2))
    expect(computer.calls).toContain('goto:https://fg-first.example')

    // While foreground holds browser, background tries browser_goto -> refused, goto NOT called, usesBrowser stays false
    gated.bgCalls[bgBeforeIdx]!.release(toolTurn('bg2-blocked', 'browser_goto', { url: 'https://bg-blocked.example' }))
    await vi.waitFor(() => expect(gated.bgCalls.length).toBe(bgBeforeIdx + 2))
    const bgBlockedReply = String(gated.bgCalls[bgBeforeIdx + 1]!.messages.at(-1)!.content)
    expect(bgBlockedReply).toContain('Your browser is currently in use by foreground chat.')
    expect(computer.calls).not.toContain('goto:https://bg-blocked.example')
    expect(getBackgroundTask(db, bg2Id)?.usesBrowser).toBe(false)

    // Background can still do non-browser work while foreground holds the browser
    gated.bgCalls[bgBeforeIdx + 1]!.release(toolTurn('bg2-write', 'write_file', { path: 'bg-parallel.md', content: 'ok' }))
    await vi.waitFor(() => expect(gated.bgCalls.length).toBe(bgBeforeIdx + 3))
    expect(computer.calls).toContain('write:bg-parallel.md')

    // Release foreground turn -> foreground browser lease is freed
    gated.fgCalls[fgHoldIdx + 1]!.release(textTurn('Done with foreground browser.'))
    await vi.waitFor(() => expect(gw.hello()).toEqual({ type: 'hello', statuses: {} }))

    // Background now retries browser_goto -> succeeds and marks usesBrowser: true
    gated.bgCalls[bgBeforeIdx + 2]!.release(toolTurn('bg2-goto-ok', 'browser_goto', { url: 'https://bg-after-fg.example' }))
    await vi.waitFor(() => expect(gated.bgCalls.length).toBe(bgBeforeIdx + 4))
    expect(computer.calls).toContain('goto:https://bg-after-fg.example')
    expect(getBackgroundTask(db, bg2Id)?.usesBrowser).toBe(true)

    gated.bgCalls[bgBeforeIdx + 3]!.release(textTurn('Second background job done.'))
    await vi.waitFor(() => expect(gw.isBusy(scout.id)).toBe(false))
  })

  it('delivers mid-flight steering notes via REST API and foreground tool, updates chip steps, and validates 400/404/409 errors', async () => {
    const gated = makeDualLaneGatedLlm()
    const { gw, db } = setupGateway({ llm: gated.llm })

    const taskId = await delegateTaskViaDm(gw, gated, {
      dmText: 'Compare Acme, Globex, and Initech.',
      title: 'Three-vendor comparison',
      instructions: 'Research all three vendors.',
    })
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(1))

    // Validation errors on steer & cancel endpoints
    expect((await gw.app.request(`/api/background-tasks/${taskId}/steer`, jsonPost(['not-object']))).status).toBe(400)
    expect((await gw.app.request(`/api/background-tasks/${taskId}/steer`, jsonPost({ note: 42 }))).status).toBe(400)
    expect((await gw.app.request(`/api/background-tasks/${taskId}/steer`, jsonPost({ note: '   ' }))).status).toBe(400)
    expect((await gw.app.request('/api/background-tasks/bg-missing/steer', jsonPost({ note: 'Hello' }))).status).toBe(404)
    expect((await gw.app.request('/api/background-tasks/bg-missing/cancel', { method: 'POST' })).status).toBe(404)

    // 1. Steer via REST API
    const steerRes = await gw.app.request(
      `/api/background-tasks/${taskId}/steer`,
      jsonPost({ note: 'Focus only on Acme' }),
    )
    expect(steerRes.status).toBe(200)
    const steerBody = (await steerRes.json()) as { ok: true; task: BackgroundTaskView }
    expect(steerBody.ok).toBe(true)
    expect(steerBody.task.steps).toEqual([
      expect.objectContaining({ tool: 'steer', summary: 'Focus only on Acme', ok: true }),
    ])

    // Thread chip immediately includes the steer step
    const chipAfterSteer = listMessages(db, `dm:${scout.id}`).find((m) => m.kind === 'background_task')
    expect((chipAfterSteer?.payload as BackgroundTaskPayload).steps).toEqual([
      expect.objectContaining({ tool: 'steer', summary: 'Focus only on Acme', ok: true }),
    ])

    // Release step 1 -> next background LLM call receives the injected steering user message
    gated.bgCalls[0]!.release(toolTurn('bg-s1', 'write_file', { path: 'acme.md', content: 'draft' }))
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(2))
    expect(gated.bgCalls[1]!.messages.at(-1)).toEqual({
      role: 'user',
      content: '[operator steering note for your background task] Focus only on Acme',
    })

    // 2. Steer via foreground steer_background_task tool
    const fgIdx = gated.fgCalls.length
    await gw.app.request(`/api/threads/dm:${scout.id}/messages`, jsonPost({ text: 'Also include annual pricing' }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgIdx + 1))
    gated.fgCalls[fgIdx]!.release(toolTurn('fg-steer', 'steer_background_task', {
      taskId,
      note: 'Include annual discount tiers',
    }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgIdx + 2))
    expect(String(gated.fgCalls[fgIdx + 1]!.messages.at(-1)!.content)).toContain(`Steering note delivered to background task ${taskId}`)
    gated.fgCalls[fgIdx + 1]!.release(textTurn('Sent that note to the background worker.'))
    await vi.waitFor(() => expect(gw.hello()).toEqual({ type: 'hello', statuses: {} }))

    gated.bgCalls[1]!.release(toolTurn('bg-s2', 'write_file', { path: 'acme-annual.md', content: '20% off' }))
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(3))
    expect(gated.bgCalls[2]!.messages.at(-1)).toEqual({
      role: 'user',
      content: '[operator steering note for your background task] Include annual discount tiers',
    })

    // Complete task -> subsequent steer & cancel return HTTP 409
    gated.bgCalls[2]!.release(textTurn('Focused report on Acme finished.'))
    await vi.waitFor(() => expect(gw.isBusy(scout.id)).toBe(false))

    const settledSteer = await gw.app.request(
      `/api/background-tasks/${taskId}/steer`,
      jsonPost({ note: 'Too late' }),
    )
    expect(settledSteer.status).toBe(409)
    expect(await settledSteer.json()).toMatchObject({ code: 'settled' })

    const settledCancel = await gw.app.request(`/api/background-tasks/${taskId}/cancel`, { method: 'POST' })
    expect(settledCancel.status).toBe(409)
    expect(await settledCancel.json()).toMatchObject({ code: 'settled' })
  })

  it('cancels running tasks via REST API and foreground tool, releases browser lease, avoids Stopped. noise, and does not abort active foreground turns', async () => {
    const gated = makeDualLaneGatedLlm()
    const { gw, db, computer } = setupGateway({ llm: gated.llm })

    // --- Part A: Cancel via REST API while background holds browser AND foreground turn is active ---
    const task1Id = await delegateTaskViaDm(gw, gated, {
      dmText: 'Crawl vendor docs in background.',
      title: 'Crawl vendor docs',
      instructions: 'Open docs and crawl pages.',
    })
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(1))

    // Acquire browser lease in background task 1
    gated.bgCalls[0]!.release(toolTurn('bg1-goto', 'browser_goto', { url: 'https://docs.example' }))
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(2))
    expect(getBackgroundTask(db, task1Id)?.usesBrowser).toBe(true)

    // Start an active foreground DM turn and pause it in-flight
    const fgActiveIdx = gated.fgCalls.length
    await gw.app.request(`/api/threads/dm:${scout.id}/messages`, jsonPost({ text: 'Open status page once browser is free' }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgActiveIdx + 1))
    const activeFgCall = gated.fgCalls[fgActiveIdx]!
    expect(activeFgCall.signal?.aborted).toBe(false)

    // Cancel running background task via REST API
    const cancelRes = await gw.app.request(`/api/background-tasks/${task1Id}/cancel`, { method: 'POST' })
    expect(cancelRes.status).toBe(200)
    expect((await cancelRes.json()) as { ok: true; task: BackgroundTaskView }).toMatchObject({
      ok: true,
      task: { id: task1Id, status: 'cancelled' },
    })

    // Wait for cancelled background task to release its browser lease and leave the lane
    await vi.waitFor(async () => {
      expect((await getSummary(gw)).backgroundTasks).toBe(0)
    })

    // Active foreground turn was NOT aborted!
    expect(activeFgCall.signal?.aborted).toBe(false)

    // Active foreground turn can immediately acquire the released browser!
    activeFgCall.release(toolTurn('fg-goto-after-cancel', 'browser_goto', { url: 'https://status.example' }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgActiveIdx + 2))
    expect(computer.calls).toContain('goto:https://status.example')
    gated.fgCalls[fgActiveIdx + 1]!.release(textTurn('Status page looks green.'))
    await vi.waitFor(() => expect(gw.isBusy(scout.id)).toBe(false))

    // Verify NO Stopped. notice polluted the DM thread and chip is cancelled
    const msgsAfterRestCancel = listMessages(db, `dm:${scout.id}`)
    expect(
      msgsAfterRestCancel.filter((m) => (m.payload as { notice?: string } | null)?.notice === 'stopped' || m.content.includes('Stopped.')),
    ).toEqual([])
    const task1Chip = msgsAfterRestCancel.find(
      (m) => m.kind === 'background_task' && (m.payload as BackgroundTaskPayload).taskId === task1Id,
    )
    expect((task1Chip?.payload as BackgroundTaskPayload).status).toBe('cancelled')

    // --- Part B: Cancel a running task via foreground cancel_background_task tool ---
    const bgBeforeIdx = gated.bgCalls.length
    const task2Id = await delegateTaskViaDm(gw, gated, {
      dmText: 'Run a second long scrape.',
      title: 'Second scrape',
      instructions: 'Browse catalog pages.',
    })
    await vi.waitFor(() => expect(gated.bgCalls.length).toBe(bgBeforeIdx + 1))
    gated.bgCalls[bgBeforeIdx]!.release(toolTurn('bg2-goto', 'browser_goto', { url: 'https://catalog.example' }))
    await vi.waitFor(() => expect(gated.bgCalls.length).toBe(bgBeforeIdx + 2))

    const fgCancelIdx = gated.fgCalls.length
    await gw.app.request(`/api/threads/dm:${scout.id}/messages`, jsonPost({ text: 'Cancel the second scrape' }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgCancelIdx + 1))
    gated.fgCalls[fgCancelIdx]!.release(toolTurn('fg-cancel-tool', 'cancel_background_task', { taskId: task2Id }))
    await vi.waitFor(() => expect(gated.fgCalls.length).toBe(fgCancelIdx + 2))
    expect(String(gated.fgCalls[fgCancelIdx + 1]!.messages.at(-1)!.content)).toContain(`Cancelled background task ${task2Id}`)
    gated.fgCalls[fgCancelIdx + 1]!.release(textTurn('Cancelled it for you.'))

    await vi.waitFor(() => expect(gw.isBusy(scout.id)).toBe(false))
    expect(getBackgroundTask(db, task2Id)?.status).toBe('cancelled')
    expect(
      listMessages(db, `dm:${scout.id}`).filter(
        (m) => (m.payload as { notice?: string } | null)?.notice === 'stopped' || m.content.includes('Stopped.'),
      ),
    ).toEqual([])

    // Browser lease is immediately available for workflow recording again
    const recAfterToolCancel = await gw.app.request(
      `/api/bots/${scout.id}/workflows/recording`,
      jsonPost({ title: 'After cancel' }),
    )
    expect(recAfterToolCancel.status).toBe(202)
    await gw.app.request(`/api/bots/${scout.id}/workflows/recording`, { method: 'DELETE' })
  })

  it('cancels a queued second background task immediately without ever invoking its LLM', async () => {
    const gated = makeDualLaneGatedLlm()
    const { gw, db } = setupGateway({ llm: gated.llm })

    // Task 1 enters running and pauses at step 1
    const task1Id = await delegateTaskViaDm(gw, gated, {
      dmText: 'Start task 1',
      title: 'Task 1',
      instructions: 'Do task 1.',
    })
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(1))

    // Task 2 is enqueued on the same bot while Task 1 is running
    const task2Id = await delegateTaskViaDm(gw, gated, {
      dmText: 'Queue task 2',
      title: 'Task 2',
      instructions: 'Do task 2 (should be cancelled before running).',
    })
    expect(getBackgroundTask(db, task2Id)?.status).toBe('queued')
    expect(await getSummary(gw)).toMatchObject({ backgroundTasks: 2, working: 1 })

    // Cancel Task 2 while queued
    const cancelRes = await gw.app.request(`/api/background-tasks/${task2Id}/cancel`, { method: 'POST' })
    expect(cancelRes.status).toBe(200)
    expect(getBackgroundTask(db, task2Id)?.status).toBe('cancelled')
    expect(await getSummary(gw)).toMatchObject({ backgroundTasks: 1, working: 1 })

    const chip2 = listMessages(db, `dm:${scout.id}`).find(
      (m) => m.kind === 'background_task' && (m.payload as BackgroundTaskPayload).taskId === task2Id,
    )
    expect((chip2?.payload as BackgroundTaskPayload).status).toBe('cancelled')

    // Finish Task 1 -> Task 2 NEVER invokes the LLM!
    gated.bgCalls[0]!.release(textTurn('Task 1 complete.'))
    await vi.waitFor(() => expect(gw.isBusy(scout.id)).toBe(false))

    expect(gated.bgCalls).toHaveLength(1)
    expect(getBackgroundTask(db, task1Id)?.status).toBe('completed')
    expect(getBackgroundTask(db, task2Id)?.status).toBe('cancelled')
    expect(await getSummary(gw)).toEqual({ working: 0, waiting: 0, routines: 0, backgroundTasks: 0 })
  })

  it('holds outward actions for operator approval with ruleHeld: "background" even when a standing approval rule exists', async () => {
    const gated = makeDualLaneGatedLlm()
    const { gw, db } = setupGateway({ llm: gated.llm })

    // Standing rule exists for (researcher, 'email', 'alice@acme.com')
    createRule(db, {
      botId: scout.id,
      kind: 'email',
      target: 'alice@acme.com',
      duration: '24h',
      now: Date.now(),
    })

    await delegateTaskViaDm(gw, gated, {
      dmText: 'Research Q3 numbers and send the recap email to Alice.',
      title: 'Q3 recap for Alice',
      instructions: 'Prepare recap and hold email to alice@acme.com.',
    })
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(1))

    gated.bgCalls[0]!.release(
      toolTurn('bg-hold-email', 'hold_for_approval', {
        action: 'Send Q3 recap email to Alice',
        detail: 'To: alice@acme.com\nSubject: Q3 Recap\nNumbers look strong.',
        kind: 'email',
        target: 'alice@acme.com',
      }),
    )

    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(2))
    expect(String(gated.bgCalls[1]!.messages.at(-1)!.content)).toBe(
      "Held for your operator's approval. Stop here — do not perform it.",
    )

    gated.bgCalls[1]!.release(textTurn('Draft held for your approval before emailing Alice.'))
    await vi.waitFor(() => expect(gw.isBusy(scout.id)).toBe(false))

    const approvalMsg = listMessages(db, `dm:${scout.id}`).find((m) => m.kind === 'approval_request')
    expect(approvalMsg).toBeDefined()
    expect(approvalMsg!.payload).toMatchObject({
      status: 'pending',
      kind: 'email',
      target: 'alice@acme.com',
      ruleHeld: 'background',
    })
    expect(await getSummary(gw)).toEqual({ working: 0, waiting: 1, routines: 0, backgroundTasks: 0 })
  })

  it('cancels active and queued background tasks cleanly on gateway.stopAll() and reconciles stale DB rows on startup', async () => {
    // --- Part A: gateway.stopAll() settles active + queued background tasks cleanly ---
    const gated = makeDualLaneGatedLlm()
    const { gw, db } = setupGateway({ llm: gated.llm })

    const activeId = await delegateTaskViaDm(gw, gated, {
      dmText: 'Start active job',
      title: 'Active shutdown job',
      instructions: 'Run until shutdown.',
    })
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(1))
    gated.bgCalls[0]!.release(toolTurn('bg-shut-goto', 'browser_goto', { url: 'https://shutdown.example' }))
    await vi.waitFor(() => expect(gated.bgCalls).toHaveLength(2))

    const queuedId = await delegateTaskViaDm(gw, gated, {
      dmText: 'Start queued job',
      title: 'Queued shutdown job',
      instructions: 'Wait behind active job.',
    })
    expect(getBackgroundTask(db, activeId)?.status).toBe('running')
    expect(getBackgroundTask(db, queuedId)?.status).toBe('queued')

    await gw.stopAll()

    expect(gw.isBusy(scout.id)).toBe(false)
    expect(getBackgroundTask(db, activeId)?.status).toBe('cancelled')
    expect(getBackgroundTask(db, queuedId)?.status).toBe('cancelled')
    expect(await getSummary(gw)).toEqual({ working: 0, waiting: 0, routines: 0, backgroundTasks: 0 })
    expect(
      listMessages(db, `dm:${scout.id}`).filter(
        (m) => (m.payload as { notice?: string } | null)?.notice === 'stopped' || m.content.includes('Stopped.'),
      ),
    ).toEqual([])

    // --- Part B: Fresh createApp against a DB with leftover running/queued rows reconciles them & patches chips ---
    const dir = makeTempDir('osb-bg-restart-')
    const dbPath = join(dir, 'opensuperbot.db')
    const seedDb = openDb(dbPath)
    upsertBot(seedDb, scout)
    const threadId = ensureDmThread(seedDb, scout.id)

    const runningChip = insertMessage(seedDb, {
      threadId,
      sender: scout.id,
      kind: 'background_task',
      payload: {
        taskId: 'bg-aaaa1111',
        title: 'Interrupted crawl',
        status: 'running',
        stepCount: 2,
        lastStep: 'browser_goto: https://example.com',
        steps: [{ tool: 'browser_goto', summary: 'https://example.com', ok: true, at: 1000 }],
        usesBrowser: true,
        createdAt: 900,
        startedAt: 950,
        finishedAt: null,
      },
    })
    const queuedChip = insertMessage(seedDb, {
      threadId,
      sender: scout.id,
      kind: 'background_task',
      payload: {
        taskId: 'bg-bbbb2222',
        title: 'Queued follow-up',
        status: 'queued',
        stepCount: 0,
        lastStep: '',
        steps: [],
        usesBrowser: false,
        createdAt: 1100,
        startedAt: null,
        finishedAt: null,
      },
    })
    const completedChip = insertMessage(seedDb, {
      threadId,
      sender: scout.id,
      kind: 'background_task',
      payload: {
        taskId: 'bg-cccc3333',
        title: 'Finished earlier',
        status: 'completed',
        stepCount: 1,
        lastStep: 'write_file: done.md',
        steps: [{ tool: 'write_file', summary: 'done.md', ok: true, at: 500 }],
        summary: 'Already done.',
        usesBrowser: false,
        createdAt: 400,
        startedAt: 450,
        finishedAt: 600,
      },
    })

    const insertTask = seedDb.prepare(
      `INSERT INTO background_tasks
         (id, bot_id, thread_id, title, instructions, status, step_count, last_step, steps_json, summary, error, uses_browser, message_id, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insertTask.run(
      'bg-aaaa1111',
      scout.id,
      threadId,
      'Interrupted crawl',
      'Crawl docs',
      'running',
      2,
      'browser_goto: https://example.com',
      JSON.stringify([{ tool: 'browser_goto', summary: 'https://example.com', ok: true, at: 1000 }]),
      '',
      '',
      1,
      runningChip.id,
      900,
      950,
      null,
    )
    insertTask.run(
      'bg-bbbb2222',
      scout.id,
      threadId,
      'Queued follow-up',
      'Follow up',
      'queued',
      0,
      '',
      '[]',
      '',
      '',
      0,
      queuedChip.id,
      1100,
      null,
      null,
    )
    insertTask.run(
      'bg-cccc3333',
      scout.id,
      threadId,
      'Finished earlier',
      'Done',
      'completed',
      1,
      'write_file: done.md',
      JSON.stringify([{ tool: 'write_file', summary: 'done.md', ok: true, at: 500 }]),
      'Already done.',
      '',
      0,
      completedChip.id,
      400,
      450,
      600,
    )
    seedDb.close()

    const restartAt = 1_700_000_050_000
    const reopenedDb = openDb(dbPath)
    const noopLlm: LLM = { chat: async () => textTurn('ok') }
    const restartedGw = createApp({
      db: reopenedDb,
      llm: noopLlm,
      dataDir: dir,
      now: () => new Date(restartAt),
    })
    trackCleanup(async () => {
      await restartedGw.stopAll()
      reopenedDb.close()
    })

    const tasksAfterRestart = await getBotBgTasks(restartedGw)
    const byId = new Map(tasksAfterRestart.map((t) => [t.id, t]))

    expect(byId.get('bg-aaaa1111')).toMatchObject({
      status: 'cancelled',
      error: STALE_RESTART_ERROR,
      finishedAt: restartAt,
    })
    expect(byId.get('bg-bbbb2222')).toMatchObject({
      status: 'cancelled',
      error: STALE_RESTART_ERROR,
      finishedAt: restartAt,
    })
    expect(byId.get('bg-cccc3333')).toMatchObject({
      status: 'completed',
      summary: 'Already done.',
      error: '',
      finishedAt: 600,
    })

    expect(getMessage(reopenedDb, runningChip.id)?.payload).toMatchObject({
      taskId: 'bg-aaaa1111',
      status: 'cancelled',
      error: STALE_RESTART_ERROR,
      finishedAt: restartAt,
    })
    expect(getMessage(reopenedDb, queuedChip.id)?.payload).toMatchObject({
      taskId: 'bg-bbbb2222',
      status: 'cancelled',
      error: STALE_RESTART_ERROR,
      finishedAt: restartAt,
    })
    expect(getMessage(reopenedDb, completedChip.id)?.payload).toMatchObject({
      taskId: 'bg-cccc3333',
      status: 'completed',
      summary: 'Already done.',
      finishedAt: 600,
    })

    expect(await getSummary(restartedGw)).toEqual({
      working: 0,
      waiting: 0,
      routines: 0,
      backgroundTasks: 0,
    })
  })
})
