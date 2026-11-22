import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PageLike } from '../src/browser-page.js'
import { createFakeComputer } from '../src/computer.js'
import { createRule, getApproval } from '../src/approvals.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { GatewayEvent, Hub } from '../src/hub.js'
import type { LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createApp } from '../src/server.js'
import { saveWorkflowTrace } from '../src/workflows.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }

function setup(options: { click?: (label: string) => Promise<void>; hub?: Hub } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'osb-workflow-runner-'))
  const db = openDb(':memory:')
  upsertBot(db, bot)
  ensureDmThread(db, bot.id)
  const calls: string[] = []
  const page = {
    async goto(url: string) { calls.push(`goto:${url}`) },
    url: () => 'https://example.test/',
    async title() { return 'Example' },
    async innerText() { return '' },
    async screenshot() { return Buffer.alloc(0) },
    async click() {},
    viewportSize: () => ({ width: 800, height: 600 }),
    getByLabel(label: string) {
      return { first: () => ({
        async waitFor() { calls.push(`visible:${label}`) },
        async fill(value: string) { calls.push(`fill:${label}:${value}`) },
        async click() { calls.push(`click:${label}`); await options.click?.(label) },
        async selectOption(value: string) { calls.push(`select:${label}:${value}`) },
        async check() { calls.push(`check:${label}`) },
        async uncheck() { calls.push(`uncheck:${label}`) },
        async press(key: string) { calls.push(`press:${label}:${key}`) },
      }) }
    },
    on() {},
    off() {},
  } as unknown as PageLike
  const computer = createFakeComputer({ workflowPage: async () => page })
  const pool = createPool({ dataDir, makeComputer: async () => computer })
  const chat = vi.fn(async () => ({ content: 'ok', toolCalls: [], raw: { role: 'assistant' as const, content: 'ok' } }))
  const llm: LLM = { chat }
  const app = createApp({ db, llm, pool, ...(options.hub ? { hub: options.hub } : {}) })
  return { dataDir, db, pool, app, calls, chat, llm }
}

function collectingHub(events: GatewayEvent[]): Hub {
  return { add: () => {}, remove: () => {}, broadcast: (event) => events.push(event), size: () => 0 }
}

function statusStates(events: GatewayEvent[]): string[] {
  return events.flatMap((event) => event.type === 'status' && event.botId === bot.id ? [event.state] : [])
}

const send = (app: ReturnType<typeof createApp>['app'], method: string, path: string, body?: unknown) => app.request(path, {
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

describe('workflow replay API', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())) })

  it('resumes the approved action exactly once and keeps runtime values out of SQLite', async () => {
    const state = setup()
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const runtimeValue = 'runtime-private@example.test'
    createRule(state.db, { botId: bot.id, kind: 'email', target: 'recipient@example.test', duration: 'always', now: Date.now() })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Send message', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Recipient' }] }, value: { kind: 'placeholder', key: 'recipient' } },
        {
          type: 'click', target: { candidates: [{ label: 'Send' }] },
          approval: { kind: 'email', target: 'recipient@example.test', action: 'Send the message' },
        },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { recipient: runtimeValue },
    })
    expect(started.status).toBe(202)
    const startedBody = await started.json() as { runId: string; status: string }
    expect(startedBody.status).toBe('running')
    const computerStatus = await send(state.app.app, 'GET', `/api/bots/${bot.id}/computer`)
    const computerSnapshot = await computerStatus.json()
    expect(computerSnapshot).toMatchObject({ workflowRun: { runId: startedBody.runId, workflowId: saved.id } })
    expect(JSON.stringify(computerSnapshot)).not.toContain(runtimeValue)

    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    expect(state.calls).toContain(`fill:Recipient:${runtimeValue}`)
    expect(state.calls.some((call) => call.startsWith('click:'))).toBe(false)
    expect(state.chat).not.toHaveBeenCalled()
    const queuedTurn = await send(state.app.app, 'POST', `/api/threads/dm:${bot.id}/messages`, { text: 'wait until the workflow ends' })
    expect(queuedTurn.status).toBe(202)
    expect(state.chat).not.toHaveBeenCalled()

    // Even with a standing rule for the reviewed destination, a dynamic recipient is never auto-approved.
    expect(getApproval(state.db, approval.id)?.status).toBe('pending')
    const decision = await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    expect(decision.status).toBe(202)
    await vi.waitFor(() => expect(state.calls.filter((call) => call === 'click:Send')).toHaveLength(1))
    await vi.waitFor(() => expect(state.chat).toHaveBeenCalledTimes(1)) // The queued operator turn runs only after replay releases the lane.

    const persisted = JSON.stringify({
      approvals: state.db.prepare('SELECT * FROM approvals').all(),
      messages: state.db.prepare('SELECT * FROM messages').all(),
      actions: state.db.prepare('SELECT * FROM actions').all(),
      traces: state.db.prepare('SELECT * FROM workflows').all(),
    })
    expect(persisted).not.toContain(runtimeValue)
  })

  it('stops on discard, releases the lane, and does not start an LLM turn', async () => {
    const state = setup()
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Fill form', steps: [
        {
          type: 'fill', target: { candidates: [{ label: 'Password' }] }, value: { kind: 'placeholder', key: 'password' },
          approval: { kind: 'other', target: 'Password field', action: 'Fill the password field' },
        },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, { bindings: { password: 'memory-only' } })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    expect(state.app.isBusy(bot.id)).toBe(true)

    const discarded = await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'discard' })
    expect(discarded.status).toBe(202)
    expect(state.app.isBusy(bot.id)).toBe(false)
    expect(state.calls.some((call) => call.startsWith('fill:'))).toBe(false)
    expect(state.chat).not.toHaveBeenCalled()

    const secondStart = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, { bindings: { password: 'another-memory-only' } })
    const { runId } = await secondStart.json() as { runId: string }
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const pending = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    const stopped = await send(state.app.app, 'DELETE', `/api/bots/${bot.id}/workflows/runs/${runId}`)
    expect(stopped.status).toBe(204)
    expect(getApproval(state.db, pending.id)?.status).toBe('discarded')
    expect(state.app.isBusy(bot.id)).toBe(false)
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('broadcasts workflow presence while running, waiting for approval, resuming, and finishing', async () => {
    const events: GatewayEvent[] = []
    const state = setup({ hub: collectingHub(events) })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Submit form', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Submit' }] },
          approval: { kind: 'email', target: 'recipient@example.test', action: 'Submit the form' },
        },
      ],
    })

    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    expect(state.app.hello()).toEqual({ type: 'hello', statuses: { [bot.id]: 'thinking' } })
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    expect(statusStates(events)).toEqual(['thinking', 'waiting'])
    expect(state.app.hello()).toEqual({ type: 'hello', statuses: { [bot.id]: 'waiting' } })

    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    const approved = await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    expect(approved.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))

    expect(statusStates(events)).toEqual(['thinking', 'waiting', 'thinking', 'idle'])
    expect(state.app.hello()).toEqual({ type: 'hello', statuses: {} })
  })

  it('Thread Stop discards a pending workflow approval and releases its lane', async () => {
    const events: GatewayEvent[] = []
    const state = setup({ hub: collectingHub(events) })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Submit form', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Submit' }] },
          approval: { kind: 'email', target: 'recipient@example.test', action: 'Submit the form' },
        },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }

    const stopped = await send(state.app.app, 'POST', `/api/threads/dm:${bot.id}/stop`)
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({ stopped: 1 })
    expect(getApproval(state.db, approval.id)?.status).toBe('discarded')
    expect(state.app.isBusy(bot.id)).toBe(false)
    expect(state.calls).not.toContain('click:Submit')
    expect(statusStates(events)).toEqual(['thinking', 'waiting', 'idle'])
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('Thread Stop aborts a running workflow and keeps presence until the current action unwinds', async () => {
    let actionStarted!: () => void
    let finishAction!: () => void
    const startedAction = new Promise<void>((resolve) => { actionStarted = resolve })
    const pendingAction = new Promise<void>((resolve) => { finishAction = resolve })
    const events: GatewayEvent[] = []
    const state = setup({
      hub: collectingHub(events),
      click: async (label) => { if (label === 'Continue') { actionStarted(); await pendingAction } },
    })
    cleanups.push(async () => {
      finishAction()
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    createRule(state.db, { botId: bot.id, kind: 'email', target: 'recipient@example.test', duration: 'always', now: Date.now() })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue form', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Continue' }] },
          approval: { kind: 'email', target: 'recipient@example.test', action: 'Continue the form' },
        },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await startedAction
    expect(state.app.isBusy(bot.id)).toBe(true)
    expect(state.app.hello()).toEqual({ type: 'hello', statuses: { [bot.id]: 'thinking' } })
    const summary = await send(state.app.app, 'GET', '/api/summary')
    expect(await summary.json()).toMatchObject({ working: 1 })

    const stopped = await send(state.app.app, 'POST', `/api/threads/dm:${bot.id}/stop`)
    expect(await stopped.json()).toEqual({ stopped: 1 })
    expect(state.app.isBusy(bot.id)).toBe(true)
    finishAction()
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(statusStates(events)).toEqual(['thinking', 'idle'])
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('cancels an in-flight browser operation before starting another step', async () => {
    let actionStarted!: () => void
    let finishAction!: () => void
    const started = new Promise<void>((resolve) => { actionStarted = resolve })
    const pendingAction = new Promise<void>((resolve) => { finishAction = resolve })
    const state = setup({ click: async (label) => { if (label === 'Continue') { actionStarted(); await pendingAction } } })
    cleanups.push(async () => {
      finishAction()
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    createRule(state.db, { botId: bot.id, kind: 'email', target: 'recipient@example.test', duration: 'always', now: Date.now() })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Cancelable run', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Continue' }] },
          approval: { kind: 'email', target: 'recipient@example.test', action: 'Continue the approved operation' },
        },
        { type: 'click', target: { candidates: [{ label: 'Delete' }] } },
      ],
    })
    const response = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(response.status).toBe(202)
    const { runId } = await response.json() as { runId: string }
    await started
    expect(state.app.isBusy(bot.id)).toBe(true)

    const stopping = await send(state.app.app, 'DELETE', `/api/bots/${bot.id}/workflows/runs/${runId}`)
    expect(stopping.status).toBe(202)
    expect(await stopping.json()).toMatchObject({ status: 'stopping_after_current_step' })
    expect(state.app.isBusy(bot.id)).toBe(true)
    finishAction()
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(state.calls.filter((call) => call === 'click:Continue')).toHaveLength(1)
    expect(state.calls).not.toContain('click:Delete')
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('rejects approval after restart but lets the operator discard without an LLM fallback', async () => {
    const state = setup()
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Send form', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Submit' }] },
          approval: { kind: 'other', target: 'Submit button', action: 'Submit the form' },
        },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    state.app.stopAll() // Simulate process shutdown: release the lane and forget runtime continuation.

    const restartedEvents: GatewayEvent[] = []
    const restarted = createApp({ db: state.db, llm: state.llm, pool: state.pool, hub: collectingHub(restartedEvents) })
    cleanups.push(async () => { restarted.stopAll() })
    expect(restarted.hello()).toEqual({ type: 'hello', statuses: { [bot.id]: 'waiting' } })
    const resumed = await send(restarted.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    expect(resumed.status).toBe(409)
    const resumeError = await resumed.json()
    expect(resumeError).toMatchObject({ error: expect.stringContaining('gateway restart') })
    expect(getApproval(state.db, approval.id)?.status).toBe('pending')
    expect(state.calls.some((call) => call.startsWith('click:'))).toBe(false)
    expect(state.chat).not.toHaveBeenCalled()

    const thumbsUp = await send(restarted.app, 'POST', `/api/threads/dm:${bot.id}/messages`, { text: '👍' })
    expect(thumbsUp.status).toBe(409)
    expect(await thumbsUp.json()).toEqual(resumeError)
    expect(getApproval(state.db, approval.id)?.status).toBe('pending')
    expect(state.chat).not.toHaveBeenCalled()

    const discarded = await send(restarted.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'discard' })
    expect(discarded.status).toBe(202)
    expect(getApproval(state.db, approval.id)?.status).toBe('discarded')
    expect(restarted.hello()).toEqual({ type: 'hello', statuses: {} })
    expect(statusStates(restartedEvents)).toEqual(['idle'])
    expect(state.chat).not.toHaveBeenCalled()
  })
})
