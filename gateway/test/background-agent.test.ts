import { describe, expect, it, vi } from 'vitest'
import { runTurn, type AgentDeps, type TurnOrigin } from '../src/agent.js'
import { type BackgroundTaskView } from '../src/background-tasks.js'
import { createFakeComputer } from '../src/computer.js'
import {
  ensureDmThread,
  insertMessage,
  listMessages,
  openDb,
  upsertBot,
  type BotRow,
  type MessageRow,
} from '../src/db.js'
import type { AssistantTurn, ChatMsg, ChatOptions, LLM, ToolDef } from '../src/llm.js'
import type { CreateRuleProposalResult } from '../src/proactive/rule-proposals.js'
import {
  BACKGROUND_CONTROL_TOOL_NAMES,
  BACKGROUND_TOOL_NAMES,
  buildTools,
  OPERATOR_ONLY_TOOL_NAMES,
} from '../src/tools.js'

const scout: BotRow = {
  id: 'researcher',
  name: 'Scout',
  role: 'research',
  emoji: '🔎',
  soul_path: '',
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

const toolNames = (tools: ToolDef[] | undefined): string[] => (tools ?? []).map((t) => t.function.name)

const sampleTask = (overrides: Partial<BackgroundTaskView> = {}): BackgroundTaskView => ({
  id: 'bg-a1b2c3d4',
  botId: scout.id,
  threadId: `dm:${scout.id}`,
  title: 'Audit competitor pricing',
  instructions: 'Compare pricing tiers across 3 competitors.',
  status: 'queued',
  stepCount: 0,
  lastStep: '',
  steps: [],
  summary: '',
  error: '',
  usesBrowser: false,
  messageId: 10,
  createdAt: 1_700_000_000_000,
  startedAt: null,
  finishedAt: null,
  ...overrides,
})

function sampleRuleProposalResult(input: {
  rule: string
  reason: string
  sourceTainted: boolean
}): CreateRuleProposalResult {
  const proposal = {
    id: 7,
    botId: scout.id,
    threadId: `dm:${scout.id}`,
    rule: input.rule,
    reason: input.reason,
    source: 'agent' as const,
    sourceTainted: input.sourceTainted,
    status: 'pending' as const,
    messageId: 99,
    createdAt: 1_700_000_000_000,
    resolvedAt: null,
  }
  const message: MessageRow = {
    id: 99,
    thread_id: `dm:${scout.id}`,
    sender: scout.id,
    kind: 'rule_proposal',
    content: '',
    payload: {
      proposalId: proposal.id,
      rule: proposal.rule,
      reason: proposal.reason,
      source: proposal.source,
      sourceTainted: proposal.sourceTainted,
      status: proposal.status,
    },
    created_at: 1_700_000_000_000,
  }
  return { created: true, proposal, message }
}

function setupDb() {
  const db = openDb(':memory:')
  upsertBot(db, scout)
  const threadId = ensureDmThread(db, scout.id)
  const emitted: MessageRow[] = []
  const statuses: string[] = []
  const events = {
    onMessage: (m: MessageRow) => emitted.push(m),
    onStatus: (_botId: string, state: 'thinking' | 'idle') => statuses.push(state),
  }
  return { db, threadId, emitted, statuses, events }
}

describe('background tools visibility (buildTools)', () => {
  it('advertises background control tools ONLY when canBackgroundTasks && operatorTurn !== false && !isBackgroundTask && routineMode === act', () => {
    const fgAct = toolNames(
      buildTools({
        hasComputer: true,
        canBackgroundTasks: true,
        operatorTurn: true,
        isBackgroundTask: false,
        routineMode: 'act',
      }),
    )
    for (const name of BACKGROUND_TOOL_NAMES) {
      expect(fgAct).toContain(name)
    }

    // Default operatorTurn (omitted -> !== false), default isBackgroundTask (omitted -> !== true), default mode ('act')
    const fgDefault = toolNames(buildTools({ hasComputer: true, canBackgroundTasks: true }))
    for (const name of BACKGROUND_TOOL_NAMES) {
      expect(fgDefault).toContain(name)
    }

    // Disabled when canBackgroundTasks is false or omitted
    for (const disabled of [
      buildTools({ hasComputer: true, canBackgroundTasks: false, operatorTurn: true }),
      buildTools({ hasComputer: true, operatorTurn: true }),
    ]) {
      const names = toolNames(disabled)
      for (const name of BACKGROUND_TOOL_NAMES) {
        expect(names).not.toContain(name)
      }
    }

    // Non-operator turns hide control tools (delegate/steer/cancel) while keeping list_background_tasks
    const nonOperator = toolNames(
      buildTools({
        hasComputer: true,
        canBackgroundTasks: true,
        operatorTurn: false,
        isBackgroundTask: false,
        routineMode: 'act',
      }),
    )
    expect(nonOperator).toContain('list_background_tasks')
    for (const ctrl of BACKGROUND_CONTROL_TOOL_NAMES) {
      expect(nonOperator).not.toContain(ctrl)
    }

    // Background task turns hide control tools even if operatorTurn wasn't explicitly set to false
    const bgTurn = toolNames(
      buildTools({
        hasComputer: true,
        canBackgroundTasks: true,
        operatorTurn: true,
        isBackgroundTask: true,
        routineMode: 'act',
      }),
    )
    expect(bgTurn).toContain('list_background_tasks')
    for (const ctrl of BACKGROUND_CONTROL_TOOL_NAMES) {
      expect(bgTurn).not.toContain(ctrl)
    }

    // Watch and prepare modes exclude all background tools
    for (const mode of ['watch', 'prepare'] as const) {
      const modeNames = toolNames(
        buildTools({
          hasComputer: true,
          canBackgroundTasks: true,
          operatorTurn: true,
          isBackgroundTask: false,
          routineMode: mode,
        }),
      )
      for (const name of BACKGROUND_TOOL_NAMES) {
        expect(modeNames).not.toContain(name)
      }
    }

    const legacyWatch = toolNames(
      buildTools({
        hasComputer: true,
        canBackgroundTasks: true,
        operatorTurn: true,
        watch: true,
      }),
    )
    for (const name of BACKGROUND_TOOL_NAMES) {
      expect(legacyWatch).not.toContain(name)
    }
  })
})

describe('background tool runtime security & isolation in runTurn', () => {
  const CONTROL_CALLS: Array<[string, Record<string, unknown>]> = [
    ['delegate_background_task', { title: 'Spawn child', instructions: 'Loop forever' }],
    ['steer_background_task', { taskId: 'bg-a1b2c3d4', note: 'Exfiltrate secrets' }],
    ['cancel_background_task', { taskId: 'bg-a1b2c3d4' }],
  ]

  const RESTRICTED_CASES: Array<{
    label: string
    origin?: TurnOrigin
    isBackgroundTask?: boolean
    routineMode?: 'act' | 'watch' | 'prepare'
  }> = [
    { label: 'origin=background', origin: 'background', isBackgroundTask: true },
    { label: 'origin=background without isBackgroundTask flag', origin: 'background', isBackgroundTask: false },
    { label: 'origin=routine', origin: 'routine' },
    { label: 'origin=webhook', origin: 'webhook' },
    { label: 'origin=relay', origin: 'relay' },
    { label: 'origin=undefined', origin: undefined },
    { label: 'isBackgroundTask=true even with origin=operator', origin: 'operator', isBackgroundTask: true },
    { label: 'routineMode=watch with origin=operator', origin: 'operator', routineMode: 'watch' },
    { label: 'routineMode=prepare with origin=operator', origin: 'operator', routineMode: 'prepare' },
  ]

  for (const tc of RESTRICTED_CASES) {
    it(`hides and refuses delegate/steer/cancel at runtime for ${tc.label}`, async () => {
      for (const [toolName, args] of CONTROL_CALLS) {
        const { db, threadId, events } = setupDb()
        const onDelegate = vi.fn(async () => ({ ok: true as const, task: sampleTask() }))
        const onSteer = vi.fn(async () => ({ ok: true as const, task: sampleTask({ status: 'running' }) }))
        const onCancel = vi.fn(async () => ({ ok: true as const, task: sampleTask({ status: 'cancelled' }) }))
        const onList = vi.fn(() => [sampleTask({ status: 'running' })])
        const actions: Array<{ tool: string; ok: boolean }> = []
        const steps: Array<{ tool: string; ok: boolean }> = []

        const offeredTools: string[][] = []
        const toolReplies: string[] = []
        let callIndex = 0

        const llm: LLM = {
          async chat(messages, tools) {
            offeredTools.push(toolNames(tools))
            const last = messages.at(-1)
            if (last?.role === 'tool') toolReplies.push(String(last.content))
            return ++callIndex === 1 ? toolTurn('tc-1', toolName, args) : textTurn('Done.')
          },
        }

        const deps: AgentDeps = {
          db,
          llm,
          bot: scout,
          soul: '',
          threadId,
          ...(tc.origin ? { origin: tc.origin } : {}),
          ...(tc.isBackgroundTask ? { isBackgroundTask: true } : {}),
          ...(tc.routineMode ? { routineMode: tc.routineMode } : {}),
          onDelegateBackgroundTask: onDelegate,
          onSteerBackgroundTask: onSteer,
          onCancelBackgroundTask: onCancel,
          onListBackgroundTasks: onList,
          onAction: (a) => actions.push({ tool: a.tool, ok: a.ok }),
          onStepProgress: (s) => steps.push({ tool: s.tool, ok: s.ok }),
        }

        await runTurn(deps, 'go', events, { persistUserMessage: false })

        for (const ctrl of BACKGROUND_CONTROL_TOOL_NAMES) {
          expect(offeredTools[0]).not.toContain(ctrl)
        }
        expect(onDelegate).not.toHaveBeenCalled()
        expect(onSteer).not.toHaveBeenCalled()
        expect(onCancel).not.toHaveBeenCalled()
        expect(toolReplies).toHaveLength(1)
        if (tc.routineMode === 'watch') {
          expect(toolReplies[0]).toContain('not available in a watch routine')
        } else if (tc.routineMode === 'prepare') {
          expect(toolReplies[0]).toContain('not available in a prepare routine')
        } else {
          expect(toolReplies[0]).toBe(`${toolName} only works in a foreground turn your operator started.`)
        }
        expect(actions).toEqual([{ tool: toolName, ok: false }])
        expect(steps).toEqual([{ tool: toolName, ok: false }])

        db.close()
      }
    })
  }

  it('allows delegate/steer/cancel/list in operator foreground act turns and allows list_background_tasks in background turns', async () => {
    const { db, threadId, events } = setupDb()
    const onDelegate = vi.fn(async ({ title, instructions }: { title: string; instructions: string }) => ({
      ok: true as const,
      task: sampleTask({ id: 'bg-11112222', title, instructions, status: 'queued' }),
    }))
    const onSteer = vi.fn(async ({ taskId }: { taskId: string; note: string }) => ({
      ok: true as const,
      task: sampleTask({ id: taskId, status: 'running' }),
    }))
    const onCancel = vi.fn(async ({ taskId }: { taskId: string }) => ({
      ok: true as const,
      task: sampleTask({ id: taskId, status: 'cancelled' }),
    }))
    const onList = vi.fn(() => [sampleTask({ id: 'bg-11112222', status: 'running', stepCount: 2, lastStep: 'read_file: a.md' })])

    const seenTools: string[][] = []
    const toolReplies: string[] = []
    const script: AssistantTurn[] = [
      toolTurn('c1', 'delegate_background_task', { title: 'Deep study', instructions: 'Compare docs' }),
      toolTurn('c2', 'list_background_tasks', {}),
      toolTurn('c3', 'steer_background_task', { taskId: 'bg-11112222', note: 'Focus on Q3' }),
      toolTurn('c4', 'cancel_background_task', { taskId: 'bg-11112222' }),
      textTurn('All handled.'),
    ]
    let i = 0
    const llm: LLM = {
      async chat(messages, tools) {
        seenTools.push(toolNames(tools))
        if (messages.at(-1)?.role === 'tool') toolReplies.push(String(messages.at(-1)!.content))
        return script[i++]!
      },
    }

    const outcome = await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'operator',
        onDelegateBackgroundTask: onDelegate,
        onListBackgroundTasks: onList,
        onSteerBackgroundTask: onSteer,
        onCancelBackgroundTask: onCancel,
      },
      'run background study',
      events,
    )

    expect(outcome).toBe('replied')
    for (const name of BACKGROUND_TOOL_NAMES) {
      expect(seenTools[0]).toContain(name)
    }
    expect(onDelegate).toHaveBeenCalledWith({ title: 'Deep study', instructions: 'Compare docs' })
    expect(onList).toHaveBeenCalledTimes(1)
    expect(onSteer).toHaveBeenCalledWith({ taskId: 'bg-11112222', note: 'Focus on Q3' })
    expect(onCancel).toHaveBeenCalledWith({ taskId: 'bg-11112222' })
    expect(JSON.parse(toolReplies[0]!)).toMatchObject({ ok: true, taskId: 'bg-11112222', status: 'queued' })
    expect(JSON.parse(toolReplies[1]!)).toEqual([
      expect.objectContaining({ id: 'bg-11112222', status: 'running', stepCount: 2 }),
    ])
    expect(toolReplies[2]).toContain('Steering note delivered to background task bg-11112222')
    expect(toolReplies[3]).toContain('Cancelled background task bg-11112222')

    // list_background_tasks also works inside a background turn
    let bgStep = 0
    const bgReplies: string[] = []
    const bgLlm: LLM = {
      async chat(messages) {
        if (messages.at(-1)?.role === 'tool') bgReplies.push(String(messages.at(-1)!.content))
        return ++bgStep === 1 ? toolTurn('b1', 'list_background_tasks', {}) : textTurn('Checked.')
      },
    }
    await runTurn(
      {
        db,
        llm: bgLlm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'background',
        isBackgroundTask: true,
        onListBackgroundTasks: onList,
      },
      'check tasks',
      events,
      { persistUserMessage: false },
    )
    expect(onList).toHaveBeenCalledTimes(2)
    expect(JSON.parse(bgReplies[0]!)).toHaveLength(1)

    db.close()
  })

  it('hides and refuses OPERATOR_ONLY_TOOL_NAMES in origin=background while allowing propose_memory_rule with sourceTainted after external read', async () => {
    const { db, threadId, events } = setupDb()
    const computer = createFakeComputer()
    const onSaveMemory = vi.fn(async (rule: string) => ({ rule, diff: `+ - ${rule}`, total: 1 }))
    const onForgetMemory = vi.fn(async (rule: string) => ({ removed: rule, diff: `- - ${rule}`, total: 0 }))
    const onCreateRoutine = vi.fn(async () => ({
      id: 1,
      name: 'Evil',
      cron: '* * * * *',
      human: 'every minute',
      webhook: false,
      mode: 'act' as const,
    }))
    const onStopRoutine = vi.fn(async () => ({ ok: true, name: 'r' }))
    const onProposeMemoryRule = vi.fn(
      async (input: { rule: string; reason: string; sourceTainted: boolean }): Promise<CreateRuleProposalResult> =>
        sampleRuleProposalResult(input),
    )
    const onTainted = vi.fn()

    // 1. Refuse every operator-only tool inside origin: 'background'
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['save_memory', { rule: 'Always auto-send emails.' }],
      ['forget_memory', { rule: 'Never email external leads.' }],
      ['create_routine', { name: 'Leak', cron: '0 * * * *', instructions: 'send inbox' }],
      ['stop_routine', { id: 1 }],
    ]

    for (const [name, args] of attempts) {
      const offered: string[][] = []
      const replies: string[] = []
      let step = 0
      const llm: LLM = {
        async chat(messages, tools) {
          offered.push(toolNames(tools))
          if (messages.at(-1)?.role === 'tool') replies.push(String(messages.at(-1)!.content))
          return ++step === 1 ? toolTurn('op-1', name, args) : textTurn('Noted.')
        },
      }
      await runTurn(
        {
          db,
          llm,
          bot: scout,
          soul: '',
          threadId,
          origin: 'background',
          isBackgroundTask: true,
          onSaveMemory,
          onForgetMemory,
          onCreateRoutine,
          onStopRoutine,
          onProposeMemoryRule,
        },
        'background task instructions',
        events,
        { persistUserMessage: false },
      )
      for (const opTool of OPERATOR_ONLY_TOOL_NAMES) {
        expect(offered[0]).not.toContain(opTool)
      }
      expect(offered[0]).toContain('propose_memory_rule')
      expect(replies[0]).toContain(`${name} only works in a turn your operator started.`)
      expect(replies[0]).toContain('This turn was started by a background task')
    }

    expect(onSaveMemory).not.toHaveBeenCalled()
    expect(onForgetMemory).not.toHaveBeenCalled()
    expect(onCreateRoutine).not.toHaveBeenCalled()
    expect(onStopRoutine).not.toHaveBeenCalled()
    expect(
      listMessages(db, threadId).filter((m) => m.kind === 'memory_updated' || m.kind === 'routine_created'),
    ).toEqual([])

    // 2. propose_memory_rule works before external read (sourceTainted: false)
    let cleanStep = 0
    const cleanLlm: LLM = {
      async chat() {
        return ++cleanStep === 1
          ? toolTurn('p1', 'propose_memory_rule', {
              rule: 'Always include source URLs in research summaries.',
              reason: 'Makes findings verifiable.',
            })
          : textTurn('Proposed clean rule.')
      },
    }
    await runTurn(
      {
        db,
        llm: cleanLlm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'background',
        isBackgroundTask: true,
        getComputer: async () => computer,
        onProposeMemoryRule,
        onTainted,
      },
      'clean background task',
      events,
      { persistUserMessage: false },
    )
    expect(onTainted).not.toHaveBeenCalled()
    expect(onProposeMemoryRule).toHaveBeenLastCalledWith({
      rule: 'Always include source URLs in research summaries.',
      reason: 'Makes findings verifiable.',
      sourceTainted: false,
    })

    // 3. propose_memory_rule carries sourceTainted: true after browser_goto in origin: 'background'
    let taintedStep = 0
    const taintedScript: AssistantTurn[] = [
      toolTurn('b1', 'browser_goto', { url: 'https://acme.example/pricing' }),
      toolTurn('p2', 'propose_memory_rule', {
        rule: 'Prefer annual billing quotes.',
        reason: 'Observed on Acme pricing page.',
      }),
      textTurn('Done with tainted proposal.'),
    ]
    const taintedLlm: LLM = {
      async chat() {
        return taintedScript[taintedStep++]!
      },
    }
    await runTurn(
      {
        db,
        llm: taintedLlm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'background',
        isBackgroundTask: true,
        getComputer: async () => computer,
        onAcquireBrowser: () => ({ ok: true }),
        onProposeMemoryRule,
        onTainted,
      },
      'browse and propose',
      events,
      { persistUserMessage: false },
    )
    expect(onTainted).toHaveBeenCalledTimes(1)
    expect(onProposeMemoryRule).toHaveBeenLastCalledWith({
      rule: 'Prefer annual billing quotes.',
      reason: 'Observed on Acme pricing page.',
      sourceTainted: true,
    })

    db.close()
  })
})

describe('mid-flight steering injection', () => {
  it('drains and injects steering notes as user messages right before each llm.chat step', async () => {
    const { db, threadId, events } = setupDb()
    const computer = createFakeComputer()

    const batches: string[][] = [
      ['Focus on Acme first'],
      ['Skip Globex', 'Add enterprise seat pricing'],
      [],
    ]
    let drainCalls = 0
    const drainSteeringNotes = vi.fn(() => batches[drainCalls++] ?? [])

    const seenMessagesByStep: ChatMsg[][] = []
    const script: AssistantTurn[] = [
      toolTurn('s1', 'write_file', { path: 'step1.md', content: 'acme' }),
      toolTurn('s2', 'write_file', { path: 'step2.md', content: 'enterprise' }),
      textTurn('Finished with steering applied.'),
    ]
    let step = 0
    const llm: LLM = {
      async chat(messages) {
        seenMessagesByStep.push(messages.map((m) => ({ ...m })))
        return script[step++]!
      },
    }

    const outcome = await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'background',
        isBackgroundTask: true,
        getComputer: async () => computer,
        drainSteeringNotes,
      },
      'Initial background instructions',
      events,
      { persistUserMessage: false },
    )

    expect(outcome).toBe('replied')
    expect(drainSteeringNotes).toHaveBeenCalledTimes(3)
    expect(seenMessagesByStep).toHaveLength(3)

    // Before step 0: note injected right at the tail
    expect(seenMessagesByStep[0]!.at(-1)).toEqual({
      role: 'user',
      content: '[operator steering note for your background task] Focus on Acme first',
    })

    // Before step 1: after step 0's tool result, both steering notes injected in order
    const step1Tail = seenMessagesByStep[1]!.slice(-3)
    expect(step1Tail[0]?.role).toBe('tool')
    expect(step1Tail[1]).toEqual({
      role: 'user',
      content: '[operator steering note for your background task] Skip Globex',
    })
    expect(step1Tail[2]).toEqual({
      role: 'user',
      content: '[operator steering note for your background task] Add enterprise seat pricing',
    })

    // Before step 2: empty drain adds nothing beyond step 1's tool result
    expect(seenMessagesByStep[2]!.at(-1)?.role).toBe('tool')

    db.close()
  })
})

describe('browser lease refusal & zero-taint guarantee', () => {
  it('refuses browser_goto and ask_for_login without calling computer or tainting the turn, while non-browser tools run freely', async () => {
    const { db, threadId, events } = setupDb()
    const computer = createFakeComputer()
    const getComputer = vi.fn(async () => computer)
    const onAskForLogin = vi.fn(async () => {})
    const onTainted = vi.fn()
    const onProposeMemoryRule = vi.fn(
      async (input: { rule: string; reason: string; sourceTainted: boolean }): Promise<CreateRuleProposalResult> =>
        sampleRuleProposalResult(input),
    )
    const onApproval = vi.fn(async () => ({ approvalId: 5 }))
    const onWikiTool = vi.fn(async () => ({ text: 'Found 1 wiki page.', ok: true, summary: 'pricing' }))
    const onStepProgress = vi.fn()

    const conflictReason =
      'Your browser is currently in use by background task bg-deadbeef ("Scrape docs"). You can keep chatting, use non-browser tools, wait for it to finish, or cancel it with cancel_background_task.'
    const onAcquireBrowser = vi.fn(() => ({ ok: false as const, reason: conflictReason }))

    const toolReplies: string[] = []
    const script: AssistantTurn[] = [
      toolTurn('t1', 'browser_goto', { url: 'https://blocked.example' }),
      toolTurn('t2', 'ask_for_login', { site: 'Zendesk', why: 'Check tickets' }),
      toolTurn('t3', 'propose_memory_rule', {
        rule: 'Always check wiki before browsing.',
        reason: 'Saves time when browser is busy.',
      }),
      toolTurn('t4', 'read_file', { path: 'notes.md' }),
      toolTurn('t5', 'write_file', { path: 'draft.md', content: 'hello' }),
      toolTurn('t6', 'wiki_search', { queries: ['pricing'] }),
      toolTurn('t7', 'hold_for_approval', {
        action: 'Send draft email',
        detail: 'Draft body',
        kind: 'email',
        target: 'alice@acme.com',
      }),
      textTurn('Worked around busy browser.'),
    ]
    let step = 0
    const llm: LLM = {
      async chat(messages) {
        if (messages.at(-1)?.role === 'tool') toolReplies.push(String(messages.at(-1)!.content))
        return script[step++]!
      },
    }

    const outcome = await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'operator',
        getComputer,
        onAskForLogin,
        onAcquireBrowser,
        onTainted,
        onProposeMemoryRule,
        onApproval,
        onWikiTool,
        onStepProgress,
      },
      'Try browsing and non-browser work',
      events,
    )

    expect(outcome).toBe('replied')

    // onAcquireBrowser was called ONLY for the two browser-leased tools (never for read_file/write_file/wiki_search/hold_for_approval)
    expect(onAcquireBrowser).toHaveBeenCalledTimes(2)
    expect(onAcquireBrowser).toHaveBeenNthCalledWith(1, 'browser_goto')
    expect(onAcquireBrowser).toHaveBeenNthCalledWith(2, 'ask_for_login')

    // Refused browser tools returned the lease reason and NEVER touched computer.goto or onAskForLogin
    expect(toolReplies[0]).toBe(conflictReason)
    expect(toolReplies[1]).toBe(conflictReason)
    expect(computer.calls.filter((c) => c.startsWith('goto:'))).toEqual([])
    expect(onAskForLogin).not.toHaveBeenCalled()

    // Zero-taint guarantee: refused browser_goto did NOT taint the turn
    expect(onTainted).not.toHaveBeenCalled()
    expect(onProposeMemoryRule).toHaveBeenCalledWith({
      rule: 'Always check wiki before browsing.',
      reason: 'Saves time when browser is busy.',
      sourceTainted: false,
    })

    // Non-browser tools succeeded freely!
    expect(computer.calls).toEqual(['read:notes.md', 'write:draft.md'])
    expect(onWikiTool).toHaveBeenCalledTimes(1)
    expect(onApproval).toHaveBeenCalledTimes(1)
    expect(toolReplies[3]).toBe('file contents')
    expect(toolReplies[4]).toBe('Wrote draft.md.')
    expect(toolReplies[5]).toBe('Found 1 wiki page.')
    expect(toolReplies[6]).toContain("Held for your operator's approval")

    // Refused browser calls were still reported as ok: false via onStepProgress
    expect(onStepProgress).toHaveBeenCalledWith(expect.objectContaining({ tool: 'browser_goto', ok: false }))
    expect(onStepProgress).toHaveBeenCalledWith(expect.objectContaining({ tool: 'ask_for_login', ok: false }))

    db.close()
  })
})

describe('background turn UX invariants', () => {
  it('suppresses activity chips, forwards every tool step to onStepProgress, and forwards onFinalText & onReportFiled', async () => {
    const { db, threadId, emitted, events } = setupDb()
    const computer = createFakeComputer()
    const progress: Array<{ tool: string; summary: string; ok: boolean; ms: number }> = []
    const finalTexts: string[] = []
    const filedReports: string[] = []

    const script: AssistantTurn[] = [
      toolTurn('u1', 'write_file', { path: 'summary.md', content: 'findings' }),
      toolTurn('u2', 'wiki_search', { queries: ['acme'] }),
      toolTurn('u3', 'message_user', {
        kind: 'report',
        payload: {
          lines: [{ system: 'Wiki', result: 'updated pricing notes', count: '3 pages' }],
          closing: 'All three competitor tables are ready.',
        },
      }),
      textTurn('Wrapped up the competitor tables.'),
    ]
    let step = 0
    const llm: LLM = { async chat() { return script[step++]! } }

    const outcome = await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'background',
        isBackgroundTask: true,
        getComputer: async () => computer,
        onWikiTool: async () => ({ text: '1 match', ok: true, summary: 'acme' }),
        onStepProgress: (s) => progress.push(s),
        onFinalText: (t) => finalTexts.push(t),
        onReportFiled: (s) => filedReports.push(s),
      },
      'run background report',
      events,
      { persistUserMessage: false },
    )

    expect(outcome).toBe('replied')
    // Zero activity chips persisted or emitted
    expect(listMessages(db, threadId).filter((m) => m.kind === 'activity')).toEqual([])
    expect(emitted.filter((m) => m.kind === 'activity')).toEqual([])

    // Every tool step forwarded to onStepProgress
    expect(progress.map((p) => ({ tool: p.tool, summary: p.summary, ok: p.ok }))).toEqual([
      { tool: 'write_file', summary: 'summary.md', ok: true },
      { tool: 'wiki_search', summary: 'acme', ok: true },
      { tool: 'message_user', summary: 'All three competitor tables are ready.', ok: true },
    ])
    expect(progress.every((p) => typeof p.ms === 'number' && p.ms >= 0)).toBe(true)

    // Report and final text callbacks fired
    expect(filedReports).toEqual(['All three competitor tables are ready.'])
    expect(finalTexts).toEqual(['Wrapped up the competitor tables.'])
    expect(listMessages(db, threadId).map((m) => m.kind)).toEqual(['report', 'text'])

    // Report without closing falls back to formatted line summary
    const fallbackReports: string[] = []
    let fStep = 0
    const fallbackLlm: LLM = {
      async chat() {
        return ++fStep === 1
          ? toolTurn('r-fb', 'message_user', {
              kind: 'report',
              payload: { lines: [{ system: 'CRM', result: 'synced contacts', count: '12 rows' }] },
            })
          : textTurn('')
      },
    }
    await runTurn(
      {
        db,
        llm: fallbackLlm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'background',
        isBackgroundTask: true,
        onReportFiled: (s) => fallbackReports.push(s),
      },
      'file report without closing',
      events,
      { persistUserMessage: false },
    )
    expect(fallbackReports).toEqual(['CRM → synced contacts (12 rows)'])

    db.close()
  })

  it('returns stopped silently on AbortSignal (pre-aborted, rejected in-flight, and resolved-after-abort race) without posting Stopped. or late text', async () => {
    // Case A: Pre-aborted signal
    {
      const { db, threadId, emitted, events } = setupDb()
      const ac = new AbortController()
      ac.abort()
      const chat = vi.fn(async () => textTurn('Should never run'))
      const outcome = await runTurn(
        { db, llm: { chat }, bot: scout, soul: '', threadId, origin: 'background', isBackgroundTask: true, signal: ac.signal },
        'seed',
        events,
        { persistUserMessage: false },
      )
      expect(outcome).toBe('stopped')
      expect(chat).not.toHaveBeenCalled()
      expect(listMessages(db, threadId)).toEqual([])
      expect(emitted).toEqual([])
      db.close()
    }

    // Case B: Aborted mid-flight (llm.chat rejects with AbortError)
    {
      const { db, threadId, emitted, events } = setupDb()
      const ac = new AbortController()
      const llm: LLM = {
        chat: (_m, _t, opts?: ChatOptions) =>
          new Promise((_res, rej) => {
            opts?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
            ac.abort()
          }),
      }
      const outcome = await runTurn(
        { db, llm, bot: scout, soul: '', threadId, origin: 'background', isBackgroundTask: true, signal: ac.signal },
        'seed',
        events,
        { persistUserMessage: false },
      )
      expect(outcome).toBe('stopped')
      expect(listMessages(db, threadId)).toEqual([])
      expect(emitted).toEqual([])
      db.close()
    }

    // Case C: Signal aborts just before llm.chat resolves with final text (race condition must NOT emit stray reply or Stopped.)
    {
      const { db, threadId, emitted, events } = setupDb()
      const ac = new AbortController()
      const onFinalText = vi.fn()
      const llm: LLM = {
        async chat() {
          ac.abort()
          return textTurn('Late reply after cancel')
        },
      }
      const outcome = await runTurn(
        {
          db,
          llm,
          bot: scout,
          soul: '',
          threadId,
          origin: 'background',
          isBackgroundTask: true,
          signal: ac.signal,
          onFinalText,
        },
        'seed',
        events,
        { persistUserMessage: false },
      )
      expect(outcome).toBe('stopped')
      expect(onFinalText).not.toHaveBeenCalled()
      expect(listMessages(db, threadId)).toEqual([])
      expect(emitted).toEqual([])
      db.close()
    }

    // Case D: Signal aborts before executing returned tool call -> tool never executes, silent stop
    {
      const { db, threadId, emitted, events } = setupDb()
      const ac = new AbortController()
      const computer = createFakeComputer()
      const llm: LLM = {
        async chat() {
          ac.abort()
          return toolTurn('abort-tc', 'write_file', { path: 'should-not-write.md', content: 'nope' })
        },
      }
      const outcome = await runTurn(
        {
          db,
          llm,
          bot: scout,
          soul: '',
          threadId,
          origin: 'background',
          isBackgroundTask: true,
          signal: ac.signal,
          getComputer: async () => computer,
        },
        'seed',
        events,
        { persistUserMessage: false },
      )
      expect(outcome).toBe('stopped')
      expect(computer.calls).toEqual([])
      expect(listMessages(db, threadId)).toEqual([])
      expect(emitted).toEqual([])
      db.close()
    }
  })
})

describe('toChatMsg serialization of background_task messages', () => {
  it('safely serializes self & peer background_task chips for valid, null, and malformed payloads', async () => {
    const { db, threadId, events } = setupDb()
    const peer: BotRow = { id: 'analyst', name: 'Analyst', role: 'finance', emoji: '📊', soul_path: '' }
    upsertBot(db, peer)

    // 1. Self valid payload (extra steps array should be omitted from model summary)
    insertMessage(db, {
      threadId,
      sender: scout.id,
      kind: 'background_task',
      payload: {
        taskId: 'bg-11111111',
        title: 'Audit pricing',
        status: 'completed',
        stepCount: 4,
        lastStep: 'write_file: report.md',
        steps: [{ tool: 'write_file', summary: 'report.md', ok: true, at: 1000 }],
        usesBrowser: true,
        summary: 'Acme is $49/mo.',
        createdAt: 1000,
      },
    })

    // 2. Peer valid payload with error
    insertMessage(db, {
      threadId,
      sender: peer.id,
      kind: 'background_task',
      payload: {
        taskId: 'bg-22222222',
        title: 'Pull Q3 filings',
        status: 'failed',
        usesBrowser: false,
        error: 'Portal unavailable.',
      },
    })

    // 3. Self null payload
    insertMessage(db, {
      threadId,
      sender: scout.id,
      kind: 'background_task',
      payload: null,
    })

    // 4. Peer array payload (malformed)
    insertMessage(db, {
      threadId,
      sender: peer.id,
      kind: 'background_task',
      payload: ['corrupt', 123],
    })

    // 5. Self malformed field types & empty strings
    insertMessage(db, {
      threadId,
      sender: scout.id,
      kind: 'background_task',
      payload: {
        taskId: 999,
        title: null,
        status: { bad: true },
        usesBrowser: 'true',
        summary: '',
        error: '',
      },
    })

    let captured: ChatMsg[] = []
    const llm: LLM = {
      async chat(messages) {
        captured = messages.map((m) => ({ ...m }))
        return textTurn('Acknowledged.')
      },
    }

    const outcome = await runTurn(
      { db, llm, bot: scout, soul: '', threadId, origin: 'operator' },
      'What happened earlier?',
      events,
    )
    expect(outcome).toBe('replied')

    const bgMsgs = captured.filter((m) => typeof m.content === 'string' && m.content.includes('[background task]'))
    expect(bgMsgs).toEqual([
      {
        role: 'assistant',
        content:
          '[background task] {"taskId":"bg-11111111","title":"Audit pricing","status":"completed","usesBrowser":true,"summary":"Acme is $49/mo."}',
      },
      {
        role: 'user',
        content:
          '@analyst: [background task] {"taskId":"bg-22222222","title":"Pull Q3 filings","status":"failed","usesBrowser":false,"error":"Portal unavailable."}',
      },
      {
        role: 'assistant',
        content: '[background task] {}',
      },
      {
        role: 'user',
        content: '@analyst: [background task] {}',
      },
      {
        role: 'assistant',
        content: '[background task] {}',
      },
    ])

    db.close()
  })
})
