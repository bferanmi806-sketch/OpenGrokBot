import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runTurn } from '../src/agent.js'
import { createFakeComputer } from '../src/computer.js'
import { activateConnectorAccount, createConnectorAccount, setBotConnectors } from '../src/connectors/store.js'
import { buildConnectorTools, CONNECTOR_READ_TOOL_NAMES, CONNECTOR_WRITE_TOOL_NAMES, runConnectorToolCall } from '../src/connectors/tools.js'
import type { ConnectorDriver } from '../src/connectors/types.js'
import { ensureDmThread, insertMessage, listMessages, openDb, upsertBot, type BotRow, type MessageRow } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM, ToolDef } from '../src/llm.js'
import { createMcpServer } from '../src/mcp/store.js'
import { buildMcpToolSet } from '../src/mcp/tools.js'
import type { McpDiscoveredTool } from '../src/mcp/types.js'
import { appendMemoryRule, listMemoryRules } from '../src/memory.js'
import { createRuleProposal } from '../src/proactive/rule-proposals.js'
import { buildTools, OPERATOR_ONLY_TOOL_NAMES, PREPARE_TOOL_NAMES, WATCH_TOOL_NAMES } from '../src/tools.js'
import { getWikiPage } from '../src/wiki/store.js'
import { runWikiToolCall } from '../src/wiki/tools.js'

const scout: BotRow = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const sorter: BotRow = { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' }

const tempDirs: string[] = []
function makeTempDir(prefix = 'osb-proactive-agent-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

type ScriptStep = {
  content?: string | null
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]
}

function scriptedLlm(steps: ScriptStep[]): LLM & {
  seenMessages: ChatMsg[][]
  seenTools: (ToolDef[] | undefined)[]
} {
  let idx = 0
  const seenMessages: ChatMsg[][] = []
  const seenTools: (ToolDef[] | undefined)[] = []
  return {
    seenMessages,
    seenTools,
    async chat(messages, tools): Promise<AssistantTurn> {
      seenMessages.push(messages.map((m) => ({ ...m })))
      seenTools.push(tools)
      const step = steps[idx++] ?? { content: 'Done.' }
      const toolCalls = step.toolCalls ?? []
      return {
        content: step.content ?? null,
        toolCalls,
        raw: {
          role: 'assistant',
          content: step.content ?? null,
          ...(toolCalls.length
            ? {
                tool_calls: toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
        },
      }
    },
  }
}

function makeStubDriver(): ConnectorDriver & {
  listMail: ReturnType<typeof vi.fn>
  createOrUpdateDraft: ReturnType<typeof vi.fn>
  executeWrite: ReturnType<typeof vi.fn>
} {
  return {
    id: 'stub',
    configured: () => true,
    testKey: async () => ({ ok: true }),
    startOAuth: async () => ({ authConfigId: 'ac_1', remoteId: 'rem_1', redirectUrl: 'https://example.test/auth' }),
    inspectAccount: async () => ({ status: 'active', accountLabel: 'scout@acme.com' }),
    revokeAccount: async () => {},
    listMail: vi.fn(async () => ({ messages: [] })),
    readMail: async () => ({ messages: [] }),
    createOrUpdateDraft: vi.fn(async () => ({ draftId: 'd_1', summary: 'draft created' })),
    listCalendarEvents: async () => ({ events: [] }),
    searchNotion: async () => ({ pages: [] }),
    readNotionPage: async () => ({ id: 'p_1', title: 'P', content: '' }),
    listSlackChannels: async () => ({ channels: [] }),
    readSlackMessages: async () => ({ messages: [] }),
    executeWrite: vi.fn(async () => ({ status: 'succeeded' as const, summary: 'sent' })),
  }
}

function sampleMcpTools(): McpDiscoveredTool[] {
  return [
    {
      name: 'get_issue',
      description: 'Read a Linear issue',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string' } } },
      readOnlyHint: true,
      destructiveHint: false,
    },
    {
      name: 'create_issue',
      description: 'Create a Linear issue',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      readOnlyHint: false,
      destructiveHint: false,
    },
  ]
}

describe('buildTools & prepare / watch capability matrix', () => {
  it('advertises expected prepare tools and hides shell, browser mutations, relay, external writes, and operator-only tools', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)

    const gmail = createConnectorAccount(db, { app: 'gmail', remoteId: 'rem_mail' })
    activateConnectorAccount(db, gmail.id, { remoteId: 'rem_mail', accountLabel: 'scout@acme.com' })
    const gcal = createConnectorAccount(db, { app: 'google_calendar', remoteId: 'rem_cal' })
    activateConnectorAccount(db, gcal.id, { remoteId: 'rem_cal', accountLabel: 'scout@acme.com' })
    const notion = createConnectorAccount(db, { app: 'notion', remoteId: 'rem_notion' })
    activateConnectorAccount(db, notion.id, { remoteId: 'rem_notion', accountLabel: 'Acme Notion' })
    const polery = createConnectorAccount(db, { app: 'polery', remoteId: 'rem_polery' })
    activateConnectorAccount(db, polery.id, { remoteId: 'rem_polery', accountLabel: 'docs.polery.com' })
    const slack = createConnectorAccount(db, { app: 'slack', remoteId: 'rem_slack' })
    activateConnectorAccount(db, slack.id, { remoteId: 'rem_slack', accountLabel: 'Acme Slack' })

    // Pass full (unfiltered) connector & MCP tool lists to verify buildTools itself enforces the boundary
    const allConnectorTools = buildConnectorTools([
      { ...gmail, status: 'active' },
      { ...gcal, status: 'active' },
      { ...notion, status: 'active' },
      { ...polery, status: 'active' },
      { ...slack, status: 'active' },
    ])
    const linear = createMcpServer(db, {
      name: 'Linear',
      transport: 'http',
      url: 'https://mcp.linear.example/mcp',
      enabled: true,
      trustReadOnlyHint: true,
      tools: sampleMcpTools(),
      status: 'connected',
    })
    const { tools: allMcpTools, readToolNames: mcpReadToolNames } = buildMcpToolSet([linear])

    const baseOpts = {
      hasComputer: true,
      hasWiki: true,
      hasSkills: true,
      canRelay: true,
      shell: true,
      operatorTurn: true,
      connectorTools: allConnectorTools,
      mcpTools: allMcpTools,
      mcpReadToolNames,
    }

    const prepareWithProposal = buildTools({
      ...baseOpts,
      routineMode: 'prepare',
      canProposeRule: true,
    }).map((t) => t.function.name)

    // Advertised in prepare mode
    for (const allowed of [
      'wiki_upsert',
      'wiki_search',
      'wiki_read',
      'write_file',
      'read_file',
      'read_skill',
      'browser_goto',
      'browser_extract',
      'browser_scroll',
      'browser_back',
      'browser_screenshot',
      'ask_for_login',
      'hold_for_approval',
      'ask_operator',
      'message_user',
      'propose_memory_rule',
      'mcp__linear__get_issue',
      ...CONNECTOR_READ_TOOL_NAMES,
    ]) {
      expect(prepareWithProposal).toContain(allowed)
    }

    // Hidden in prepare mode (even when operatorTurn: true and shell: true!)
    for (const forbidden of [
      'shell',
      'browser_click',
      'browser_type',
      'browser_press',
      'message_bot',
      'mail_draft',
      'mcp__linear__create_issue',
      ...CONNECTOR_WRITE_TOOL_NAMES,
      ...OPERATOR_ONLY_TOOL_NAMES,
    ]) {
      expect(prepareWithProposal).not.toContain(forbidden)
    }

    // propose_memory_rule omitted when canProposeRule is false or omitted
    const prepareWithoutProposal = buildTools({
      ...baseOpts,
      routineMode: 'prepare',
      canProposeRule: false,
    }).map((t) => t.function.name)
    expect(prepareWithoutProposal).not.toContain('propose_memory_rule')

    // watch mode still hides wiki_upsert and write_file (for both routineMode: 'watch' and legacy watch: true)
    const watchByMode = buildTools({
      ...baseOpts,
      routineMode: 'watch',
      canProposeRule: true,
    }).map((t) => t.function.name)
    const watchByBool = buildTools({
      ...baseOpts,
      watch: true,
      canProposeRule: true,
    }).map((t) => t.function.name)

    for (const names of [watchByMode, watchByBool]) {
      expect(names).toContain('wiki_search')
      expect(names).toContain('wiki_read')
      expect(names).toContain('read_file')
      expect(names).toContain('propose_memory_rule')
      expect(names).toContain('mcp__linear__get_issue')
      expect(names).not.toContain('wiki_upsert')
      expect(names).not.toContain('write_file')
      expect(names).not.toContain('shell')
      expect(names).not.toContain('mail_draft')
      expect(names).not.toContain('mcp__linear__create_issue')
    }

    expect(WATCH_TOOL_NAMES.has('wiki_upsert')).toBe(false)
    expect(WATCH_TOOL_NAMES.has('write_file')).toBe(false)
    expect(PREPARE_TOOL_NAMES.has('wiki_upsert')).toBe(true)
    expect(PREPARE_TOOL_NAMES.has('write_file')).toBe(true)
    db.close()
  })

  it('refuses wiki_upsert and write_file at runtime in watch mode without calling underlying handlers', async () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    const baseComputer = createFakeComputer()
    const writeFileSpy = vi.fn(baseComputer.writeFile)
    const onWikiTool = vi.fn()

    const llm = scriptedLlm([
      {
        toolCalls: [
          { id: 'w1', name: 'wiki_upsert', args: { kind: 'topic', title: 'Blocked', body: 'Nope' } },
          { id: 'w2', name: 'write_file', args: { path: 'notes.md', content: 'Blocked' } },
        ],
      },
      { content: 'Nothing new.' },
    ])

    const outcome = await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        routineMode: 'watch',
        origin: 'routine',
        getComputer: async () => ({ ...baseComputer, writeFile: writeFileSpy }),
        onWikiTool,
      },
      'Check updates.',
      { onMessage: () => {}, onStatus: () => {} },
      { persistUserMessage: false },
    )

    expect(outcome).toBe('replied')
    expect(onWikiTool).not.toHaveBeenCalled()
    expect(writeFileSpy).not.toHaveBeenCalled()

    const toolReplies = llm.seenMessages[1]!.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(toolReplies).toHaveLength(2)
    expect(toolReplies[0]).toMatch(/not available in a watch routine/i)
    expect(toolReplies[1]).toMatch(/not available in a watch routine/i)
    expect(listMessages(db, threadId)).toEqual([])
    db.close()
  })
})

describe('prepare runtime defense-in-depth and silent replies', () => {
  it('allows wiki_upsert and write_file in prepare mode while refusing shell, browser mutations, relay, external writes, and operator-only tools', async () => {
    const dataDir = makeTempDir('osb-prepare-depth-')
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    const baseComputer = createFakeComputer()
    const shellSpy = vi.fn(baseComputer.shell)
    const clickSpy = vi.fn(baseComputer.click)
    const typeSpy = vi.fn(baseComputer.type)
    const pressSpy = vi.fn(baseComputer.press)
    const writeFileSpy = vi.fn(baseComputer.writeFile)
    const computer = {
      ...baseComputer,
      shell: shellSpy,
      click: clickSpy,
      type: typeSpy,
      press: pressSpy,
      writeFile: writeFileSpy,
    }

    const onMessageBot = vi.fn(async () => ({ delivered: true, toName: 'Sorter' }))
    const onConnectorTool = vi.fn(async () => ({ ok: true, text: 'should never run' }))
    const onMcpTool = vi.fn(async () => ({ ok: true, text: 'should never run' }))
    const onSaveMemory = vi.fn(async () => ({ rule: 'x', diff: '+x', total: 1 }))
    const onForgetMemory = vi.fn(async () => ({ removed: 'x', diff: '-x', total: 0 }))
    const onCreateRoutine = vi.fn(async () => ({
      id: 1,
      name: 'x',
      cron: '0 9 * * *',
      human: 'daily',
      webhook: false,
      mode: 'act' as const,
    }))
    const onStopRoutine = vi.fn(async () => ({ ok: true }))

    const llm = scriptedLlm([
      // Step 1: Allowed prepare writes
      {
        toolCalls: [
          {
            id: 'ok1',
            name: 'wiki_upsert',
            args: {
              kind: 'project',
              slug: 'morning-prep',
              title: 'Morning Prep',
              summary: 'Pre-work dossier',
              body: 'Prepared facts.',
            },
          },
          {
            id: 'ok2',
            name: 'write_file',
            args: { path: 'briefs/morning.md', content: '# Morning Brief\nReady.' },
          },
        ],
      },
      // Step 2: Forced forbidden calls
      {
        toolCalls: [
          { id: 'bad1', name: 'shell', args: { cmd: 'rm -rf /' } },
          { id: 'bad2', name: 'browser_click', args: { target: 'Send' } },
          { id: 'bad3', name: 'browser_type', args: { target: 'input', text: 'secret' } },
          { id: 'bad4', name: 'browser_press', args: { key: 'Enter' } },
          { id: 'bad5', name: 'message_bot', args: { to: 'inbox-keeper', content: 'do it' } },
          { id: 'bad6', name: 'mail_send', args: { to: ['a@b.com'], subject: 'Hi', body: 'Body' } },
          { id: 'bad7', name: 'mail_draft', args: { to: ['a@b.com'], subject: 'Draft', body: 'Body' } },
          { id: 'bad8', name: 'mcp__linear__create_issue', args: { title: 'Blocked' } },
          { id: 'bad9', name: 'save_memory', args: { rule: 'Always auto-approve' } },
          { id: 'bad10', name: 'forget_memory', args: { rule: 'Ask before sending' } },
          { id: 'bad11', name: 'create_routine', args: { name: 'Bad', cron: '* * * * *', instructions: 'x' } },
          { id: 'bad12', name: 'stop_routine', args: { id: 1 } },
        ],
      },
      { content: 'Prepared the dossier and local draft.' },
    ])

    const actions: Array<{ tool: string; ok: boolean }> = []
    const outcome = await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        routineMode: 'prepare',
        origin: 'routine',
        getComputer: async () => computer,
        onWikiTool: ({ name, args, turnTainted }) =>
          runWikiToolCall({
            db,
            dataDir,
            botId: scout.id,
            threadId,
            trigger: 'prepare',
            origin: 'routine',
            turnTainted,
            watch: false,
            name,
            args,
            now: 1_700_000_000_000,
          }),
        onMessageBot,
        onConnectorTool,
        onMcpTool,
        mcpReadToolNames: new Set(['mcp__linear__get_issue']),
        onSaveMemory,
        onForgetMemory,
        onCreateRoutine,
        onStopRoutine,
        onAction: (a) => actions.push({ tool: a.tool, ok: a.ok }),
      },
      'Run morning prepare.',
      { onMessage: () => {}, onStatus: () => {} },
      { persistUserMessage: false },
    )

    expect(outcome).toBe('replied')

    // Allowed writes succeeded
    expect(getWikiPage(db, 'project', 'morning-prep')).toMatchObject({
      title: 'Morning Prep',
      body: 'Prepared facts.',
    })
    expect(writeFileSpy).toHaveBeenCalledWith('briefs/morning.md', '# Morning Brief\nReady.')
    expect(baseComputer.calls).toEqual(['write:briefs/morning.md'])

    // Underlying forbidden handlers were NEVER invoked
    expect(shellSpy).not.toHaveBeenCalled()
    expect(clickSpy).not.toHaveBeenCalled()
    expect(typeSpy).not.toHaveBeenCalled()
    expect(pressSpy).not.toHaveBeenCalled()
    expect(onMessageBot).not.toHaveBeenCalled()
    expect(onConnectorTool).not.toHaveBeenCalled()
    expect(onMcpTool).not.toHaveBeenCalled()
    expect(onSaveMemory).not.toHaveBeenCalled()
    expect(onForgetMemory).not.toHaveBeenCalled()
    expect(onCreateRoutine).not.toHaveBeenCalled()
    expect(onStopRoutine).not.toHaveBeenCalled()

    // Every forbidden tool received a clear prepare refusal
    const step2ToolReplies = llm.seenMessages[2]!.filter((m) => m.role === 'tool').slice(2)
    expect(step2ToolReplies).toHaveLength(12)
    for (const reply of step2ToolReplies) {
      expect(String(reply.content)).toMatch(/not available in a prepare routine/i)
    }

    // Actions logged both successes and refusals
    expect(actions.filter((a) => a.ok).map((a) => a.tool)).toEqual(['wiki_upsert', 'write_file'])
    expect(actions.filter((a) => !a.ok)).toHaveLength(12)
    db.close()
  })

  it('refuses mail_draft and connector write tools directly inside runConnectorToolCall when readOnly is true', async () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    const acc = createConnectorAccount(db, { app: 'gmail', remoteId: 'rem_1' })
    activateConnectorAccount(db, acc.id, { remoteId: 'rem_1', accountLabel: 'scout@acme.com' })
    setBotConnectors(db, scout.id, [acc.id])

    const driver = makeStubDriver()
    const base = {
      db,
      driver,
      botId: scout.id,
      threadId,
      trigger: 'prepare' as const,
      ruleBlock: 'routine' as const,
      events: { onMessage: () => {}, onStatus: () => {} },
      readOnly: true,
      now: 1_700_000_000_000,
    }

    const draftRes = await runConnectorToolCall({
      ...base,
      name: 'mail_draft',
      args: { to: ['bob@acme.com'], subject: 'Hi', body: 'Draft' },
    })
    expect(draftRes.ok).toBe(false)
    expect(draftRes.text).toMatch(/read-only/i)

    const sendRes = await runConnectorToolCall({
      ...base,
      name: 'mail_send',
      args: { to: ['bob@acme.com'], subject: 'Hi', body: 'Send' },
    })
    expect(sendRes.ok).toBe(false)
    expect(sendRes.text).toMatch(/read-only/i)

    expect(driver.createOrUpdateDraft).not.toHaveBeenCalled()
    expect(driver.executeWrite).not.toHaveBeenCalled()

    const listRes = await runConnectorToolCall({ ...base, name: 'mail_list', args: {} })
    expect(listRes.ok).toBe(true)
    expect(listRes.tainted).toBe(true)
    expect(driver.listMail).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('stays completely silent on "Nothing to prepare." and "Nothing new." in prepare mode (both normal and quietBuffer)', async () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)
    const buffered: unknown[] = []

    for (const quietBuffer of [false, true]) {
      for (const silentReply of ['Nothing to prepare.', 'nothing to prepare', 'Nothing new.', 'Nothing new']) {
        const llm = scriptedLlm([{ content: silentReply }])
        const emitted: MessageRow[] = []
        const outcome = await runTurn(
          {
            db,
            llm,
            bot: scout,
            soul: '',
            threadId,
            routineMode: 'prepare',
            origin: 'routine',
            ...(quietBuffer
              ? {
                  quietBuffer: true,
                  onQuietBuffer: (item) => {
                    buffered.push(item)
                  },
                }
              : {}),
          },
          'Check if anything needs preparing.',
          { onMessage: (m) => emitted.push(m), onStatus: () => {} },
          { persistUserMessage: false },
        )
        expect(outcome).toBe('replied')
        expect(emitted).toEqual([])
      }
    }

    expect(listMessages(db, threadId)).toEqual([])
    expect(buffered).toEqual([])
    db.close()
  })
})

describe('Quiet Hours turn behavior (quietBuffer: true)', () => {
  it('buffers non-urgent report and final text, suppresses activity chips, and guides model toward urgent: true', async () => {
    const dataDir = makeTempDir('osb-quiet-buffer-')
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    const computer = createFakeComputer()
    const buffered: Array<{ kind: 'report' | 'text'; summary: string; payload: unknown }> = []
    const actions: Array<{ tool: string; ok: boolean }> = []
    const emitted: MessageRow[] = []

    const llm = scriptedLlm([
      {
        toolCalls: [
          { id: 'f1', name: 'write_file', args: { path: 'notes.md', content: 'Overnight notes' } },
          {
            id: 'r1',
            name: 'message_user',
            args: {
              kind: 'report',
              payload: {
                lines: [{ system: 'CRM', result: 'scanned deals', count: '4' }],
                closing: 'All routine items logged.',
              },
            },
          },
        ],
      },
      { content: 'Also saved overnight notes to notes.md.' },
    ])

    const outcome = await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        routineMode: 'prepare',
        origin: 'routine',
        quietBuffer: true,
        onQuietBuffer: (item) => {
          buffered.push(item)
        },
        getComputer: async () => computer,
        onWikiTool: ({ name, args, turnTainted }) =>
          runWikiToolCall({
            db,
            dataDir,
            botId: scout.id,
            threadId,
            trigger: 'prepare',
            origin: 'routine',
            turnTainted,
            watch: false,
            name,
            args,
          }),
        onAction: (a) => actions.push({ tool: a.tool, ok: a.ok }),
      },
      'Overnight prepare run.',
      { onMessage: (m) => emitted.push(m), onStatus: () => {} },
      { persistUserMessage: false },
    )

    expect(outcome).toBe('replied')

    // No report, text, or activity chips posted to thread
    expect(emitted).toEqual([])
    expect(listMessages(db, threadId)).toEqual([])

    // Both non-urgent report and final text were buffered
    expect(buffered).toHaveLength(2)
    expect(buffered[0]).toMatchObject({
      kind: 'report',
      summary: 'All routine items logged.',
      payload: {
        lines: [{ system: 'CRM', result: 'scanned deals', count: '4' }],
        closing: 'All routine items logged.',
      },
    })
    expect(buffered[1]).toEqual({
      kind: 'text',
      summary: 'Also saved overnight notes to notes.md.',
      payload: { text: 'Also saved overnight notes to notes.md.' },
    })

    // Model was informed that report was buffered and told about urgent: true
    const reportToolReply = llm.seenMessages[1]!.find((m) => m.role === 'tool' && m.tool_call_id === 'r1')
    expect(String(reportToolReply?.content ?? '')).toContain('buffered')
    expect(String(reportToolReply?.content ?? '')).toContain('urgent: true')

    // Actions were still recorded even though activity chip was suppressed
    expect(actions.map((a) => [a.tool, a.ok])).toEqual([
      ['write_file', true],
      ['message_user', true],
    ])
    db.close()
  })

  it('allows urgent: true reports, hold_for_approval, ask_operator, and ask_for_login to break through immediately during quietBuffer: true', async () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    const buffered: unknown[] = []
    const emitted: MessageRow[] = []
    const onAskForLogin = vi.fn(async () => {})

    const llm = scriptedLlm([
      {
        toolCalls: [
          {
            id: 'u1',
            name: 'message_user',
            args: {
              kind: 'report',
              urgent: true,
              payload: {
                lines: [{ system: 'Billing', result: 'charge failed', count: '1' }],
                closing: 'Production payment card declined.',
              },
            },
          },
          {
            id: 'a1',
            name: 'hold_for_approval',
            args: {
              action: 'Pause ad spend immediately',
              detail: 'Campaign #9 is burning budget.',
              kind: 'other',
              target: 'ads.example',
            },
          },
          {
            id: 'q1',
            name: 'ask_operator',
            args: {
              question: 'Switch to backup card now?',
              options: ['Switch now', 'Wait until morning'],
            },
          },
          {
            id: 'l1',
            name: 'ask_for_login',
            args: {
              site: 'Stripe Dashboard',
              why: 'Re-authenticate to inspect failed invoice.',
            },
          },
        ],
      },
      { content: 'Nothing new.' },
    ])

    const outcome = await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        routineMode: 'watch',
        origin: 'routine',
        quietBuffer: true,
        onQuietBuffer: (item) => {
          buffered.push(item)
        },
        getComputer: async () => createFakeComputer(),
        onApproval: async () => ({ approvalId: 42 }),
        onAskForLogin,
      },
      'Watch billing.',
      { onMessage: (m) => emitted.push(m), onStatus: () => {} },
      { persistUserMessage: false },
    )

    expect(outcome).toBe('replied')
    expect(buffered).toEqual([])
    expect(onAskForLogin).toHaveBeenCalledTimes(1)
    expect(emitted.map((m) => m.kind)).toEqual(['report', 'approval_request', 'question', 'login_request'])

    const persisted = listMessages(db, threadId)
    expect(persisted.map((m) => m.kind)).toEqual(['report', 'approval_request', 'question', 'login_request'])
    expect(persisted[0]!.payload).toMatchObject({ closing: 'Production payment card declined.' })
    expect(persisted[1]!.payload).toMatchObject({ approvalId: 42, status: 'pending' })
    expect(persisted[2]!.payload).toMatchObject({ question: 'Switch to backup card now?', status: 'open', watch: true })
    expect(persisted[3]!.payload).toMatchObject({ site: 'Stripe Dashboard' })

    const urgentToolReply = llm.seenMessages[1]!.find((m) => m.role === 'tool' && m.tool_call_id === 'u1')
    expect(String(urgentToolReply?.content ?? '')).toBe('Report delivered.')
    db.close()
  })
})

describe('propose_memory_rule tool safety, taint propagation & 1-per-turn cap', () => {
  it('creates an untainted proposal in clean operator and routine turns without touching MEMORY.md', async () => {
    const dataDir = makeTempDir('osb-propose-clean-')
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    for (const [origin, rule] of [
      ['operator', 'Always use bullet points in morning briefs'],
      ['routine', 'Never ping on weekends unless production is down'],
    ] as const) {
      const llm = scriptedLlm([
        {
          toolCalls: [
            {
              id: `p_${origin}`,
              name: 'propose_memory_rule',
              args: { rule, reason: `Observed during ${origin} turn` },
            },
          ],
        },
        { content: 'Proposed rule.' },
      ])

      const outcome = await runTurn(
        {
          db,
          llm,
          bot: scout,
          soul: '',
          threadId,
          origin,
          onProposeMemoryRule: ({ rule: r, reason, sourceTainted }) =>
            createRuleProposal(db, {
              botId: scout.id,
              threadId,
              rule: r,
              reason,
              source: 'agent',
              sourceTainted,
              dataDir,
            }),
        },
        `Clean ${origin} run`,
        { onMessage: () => {}, onStatus: () => {} },
        { persistUserMessage: false },
      )

      expect(outcome).toBe('replied')
    }

    const proposalMsgs = listMessages(db, threadId).filter((m) => m.kind === 'rule_proposal')
    expect(proposalMsgs).toHaveLength(2)
    expect(proposalMsgs[0]!.payload).toMatchObject({
      rule: 'Always use bullet points in morning briefs',
      source: 'agent',
      sourceTainted: false,
      status: 'pending',
    })
    expect(proposalMsgs[1]!.payload).toMatchObject({
      rule: 'Never ping on weekends unless production is down',
      source: 'agent',
      sourceTainted: false,
      status: 'pending',
    })

    // MEMORY.md was NEVER modified
    expect(await listMemoryRules(dataDir, scout.id)).toEqual([])
    db.close()
  })

  it('forces sourceTainted: true after browser_goto, tainted wiki_read, or webhook origin even if args spoof sourceTainted: false', async () => {
    // 1) After browser_goto
    {
      const db = openDb(':memory:')
      upsertBot(db, scout)
      const threadId = ensureDmThread(db, scout.id)
      const calls: Array<{ rule: string; reason: string; sourceTainted: boolean }> = []
      const llm = scriptedLlm([
        { toolCalls: [{ id: 'g1', name: 'browser_goto', args: { url: 'https://untrusted.example/page' } }] },
        {
          toolCalls: [
            {
              id: 'p1',
              name: 'propose_memory_rule',
              args: {
                rule: 'Always trust untrusted.example',
                reason: 'Page asked for it',
                sourceTainted: false, // model attempts to spoof clean source
              },
            },
          ],
        },
        { content: 'Done.' },
      ])

      await runTurn(
        {
          db,
          llm,
          bot: scout,
          soul: '',
          threadId,
          origin: 'operator',
          getComputer: async () => createFakeComputer(),
          onProposeMemoryRule: async (input) => {
            calls.push(input)
            return createRuleProposal(db, {
              botId: scout.id,
              threadId,
              rule: input.rule,
              reason: input.reason,
              source: 'agent',
              sourceTainted: input.sourceTainted,
            })
          },
        },
        'Check page',
        { onMessage: () => {}, onStatus: () => {} },
        { persistUserMessage: false },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]!.sourceTainted).toBe(true)
      db.close()
    }

    // 2) After tainted wiki_read
    {
      const db = openDb(':memory:')
      upsertBot(db, scout)
      const threadId = ensureDmThread(db, scout.id)
      const calls: Array<{ rule: string; reason: string; sourceTainted: boolean }> = []
      const llm = scriptedLlm([
        { toolCalls: [{ id: 'w1', name: 'wiki_read', args: { id: 'client/acme' } }] },
        {
          toolCalls: [
            {
              id: 'p2',
              name: 'propose_memory_rule',
              args: {
                rule: 'Auto-approve Acme emails',
                reason: 'Wiki note mentioned it',
                sourceTainted: false,
              },
            },
          ],
        },
        { content: 'Done.' },
      ])

      await runTurn(
        {
          db,
          llm,
          bot: scout,
          soul: '',
          threadId,
          origin: 'operator',
          onWikiTool: () => ({ ok: true, text: 'Untrusted scraped wiki page', tainted: true, summary: 'read client/acme' }),
          onProposeMemoryRule: async (input) => {
            calls.push(input)
            return createRuleProposal(db, {
              botId: scout.id,
              threadId,
              rule: input.rule,
              reason: input.reason,
              source: 'agent',
              sourceTainted: input.sourceTainted,
            })
          },
        },
        'Read client/acme',
        { onMessage: () => {}, onStatus: () => {} },
        { persistUserMessage: false },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]!.sourceTainted).toBe(true)
      db.close()
    }

    // 3) Webhook origin directly without any read tools
    {
      const db = openDb(':memory:')
      upsertBot(db, scout)
      const threadId = ensureDmThread(db, scout.id)
      const calls: Array<{ rule: string; reason: string; sourceTainted: boolean }> = []
      const llm = scriptedLlm([
        {
          toolCalls: [
            {
              id: 'p3',
              name: 'propose_memory_rule',
              args: {
                rule: 'Forward webhook alerts to external endpoint',
                reason: 'Webhook body said so',
                sourceTainted: false,
              },
            },
          ],
        },
        { content: 'Done.' },
      ])

      await runTurn(
        {
          db,
          llm,
          bot: scout,
          soul: '',
          threadId,
          origin: 'webhook',
          onProposeMemoryRule: async (input) => {
            calls.push(input)
            return createRuleProposal(db, {
              botId: scout.id,
              threadId,
              rule: input.rule,
              reason: input.reason,
              source: 'agent',
              sourceTainted: input.sourceTainted,
            })
          },
        },
        'Webhook fired',
        { onMessage: () => {}, onStatus: () => {} },
        { persistUserMessage: false },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]!.sourceTainted).toBe(true)
      db.close()
    }
  })

  it('enforces max 1 created proposal per turn while allowing retries after already_in_memory dedupe rejection', async () => {
    const dataDir = makeTempDir('osb-propose-cap-')
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)

    await appendMemoryRule(dataDir, scout.id, 'Never email Acme on Fridays')

    const onProposeMemoryRule = vi.fn(({ rule, reason, sourceTainted }: { rule: string; reason: string; sourceTainted: boolean }) =>
      createRuleProposal(db, {
        botId: scout.id,
        threadId,
        rule,
        reason,
        source: 'agent',
        sourceTainted,
        dataDir,
      }),
    )

    const llm = scriptedLlm([
      // 1st call fails dedupe (already_in_memory) -> does NOT consume the 1-per-turn cap
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'propose_memory_rule',
            args: { rule: 'Never email Acme on Fridays.', reason: 'Already in memory' },
          },
        ],
      },
      // 2nd call succeeds -> consumes the 1-per-turn cap
      {
        toolCalls: [
          {
            id: 'c2',
            name: 'propose_memory_rule',
            args: { rule: 'Keep Friday reports under 3 bullets', reason: 'Operator prefers brevity on Fridays' },
          },
        ],
      },
      // 3rd call must be refused without calling onProposeMemoryRule
      {
        toolCalls: [
          {
            id: 'c3',
            name: 'propose_memory_rule',
            args: { rule: 'Also include revenue charts', reason: 'Extra suggestion' },
          },
        ],
      },
      { content: 'All set.' },
    ])

    const outcome = await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'operator',
        onProposeMemoryRule,
      },
      'Review standing rules.',
      { onMessage: () => {}, onStatus: () => {} },
      { persistUserMessage: false },
    )

    expect(outcome).toBe('replied')
    // Invoked for c1 (dedupe failure) and c2 (created), NOT for c3 (blocked by 1-per-turn guard)
    expect(onProposeMemoryRule).toHaveBeenCalledTimes(2)

    const toolReplies = llm.seenMessages[3]!.filter((m) => m.role === 'tool')
    expect(String(toolReplies[0]!.content)).toMatch(/already in your MEMORY\.md/i)
    expect(String(toolReplies[1]!.content)).toMatch(/Proposed the rule to your operator/i)
    expect(String(toolReplies[2]!.content)).toMatch(/already proposed a rule in this turn/i)

    const proposals = listMessages(db, threadId).filter((m) => m.kind === 'rule_proposal')
    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.payload).toMatchObject({ rule: 'Keep Friday reports under 3 bullets' })
    db.close()
  })
})

describe('toChatMsg history serialization for rule_proposal and quiet_digest', () => {
  it('serializes valid and malformed/null rule_proposal and quiet_digest messages safely without crashing', async () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    upsertBot(db, sorter)
    const threadId = ensureDmThread(db, scout.id)

    // Well-formed self-authored messages
    insertMessage(db, {
      threadId,
      sender: scout.id,
      kind: 'rule_proposal',
      payload: {
        proposalId: 7,
        rule: 'Always check wiki first',
        reason: 'Private reason should not leak into model view',
        source: 'agent',
        sourceTainted: true,
        status: 'pending',
      },
    })
    insertMessage(db, {
      threadId,
      sender: scout.id,
      kind: 'quiet_digest',
      payload: {
        windowStart: '22:00',
        windowEnd: '08:00',
        itemCount: 2,
        items: [
          { id: 1, routineName: 'Night Watch', summary: 'All clear' },
          { id: 2, routineName: 'Morning Prep', summary: 'Dossier ready' },
        ],
      },
    })

    // Peer-authored messages (group-style)
    insertMessage(db, {
      threadId,
      sender: sorter.id,
      kind: 'rule_proposal',
      payload: { proposalId: 8, rule: 'Skip newsletter digests', status: 'accepted' },
    })
    insertMessage(db, {
      threadId,
      sender: sorter.id,
      kind: 'quiet_digest',
      payload: { itemCount: 1, items: [{ routineName: 'Inbox Watch', summary: '3 VIP threads' }] },
    })

    // Malformed / null / primitive / partial payloads (must never throw)
    insertMessage(db, { threadId, sender: scout.id, kind: 'rule_proposal', payload: null })
    insertMessage(db, { threadId, sender: scout.id, kind: 'rule_proposal', payload: 'not-an-object' })
    insertMessage(db, { threadId, sender: scout.id, kind: 'quiet_digest', payload: null })
    insertMessage(db, { threadId, sender: scout.id, kind: 'quiet_digest', payload: 12345 })
    insertMessage(db, {
      threadId,
      sender: scout.id,
      kind: 'quiet_digest',
      payload: { itemCount: 'bad', items: 'not-an-array' },
    })
    insertMessage(db, {
      threadId,
      sender: scout.id,
      kind: 'quiet_digest',
      payload: { items: [null, 42, { routineName: 'Partial' }] },
    })

    const llm = scriptedLlm([{ content: 'History read cleanly.' }])
    const outcome = await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'operator',
      },
      'Summarize recent context.',
      { onMessage: () => {}, onStatus: () => {} },
    )

    expect(outcome).toBe('replied')

    // Messages passed to model: [system, ...10 history rows, user message]
    const historyMsgs = llm.seenMessages[0]!.slice(1, 11)
    expect(historyMsgs).toHaveLength(10)

    expect(historyMsgs[0]).toEqual({
      role: 'assistant',
      content: '[proposed rule] {"proposalId":7,"rule":"Always check wiki first","status":"pending"}',
    })
    expect(historyMsgs[1]).toEqual({
      role: 'assistant',
      content:
        '[morning digest delivered] {"itemCount":2,"items":[{"routineName":"Night Watch","summary":"All clear"},{"routineName":"Morning Prep","summary":"Dossier ready"}]}',
    })
    expect(historyMsgs[2]).toEqual({
      role: 'user',
      content: '@inbox-keeper: [proposed rule] {"proposalId":8,"rule":"Skip newsletter digests","status":"accepted"}',
    })
    expect(historyMsgs[3]).toEqual({
      role: 'user',
      content:
        '@inbox-keeper: [morning digest delivered] {"itemCount":1,"items":[{"routineName":"Inbox Watch","summary":"3 VIP threads"}]}',
    })

    // Malformed payloads degrade cleanly to valid JSON strings
    expect(historyMsgs[4]).toEqual({ role: 'assistant', content: '[proposed rule] {}' })
    expect(historyMsgs[5]).toEqual({ role: 'assistant', content: '[proposed rule] {}' })
    expect(historyMsgs[6]).toEqual({ role: 'assistant', content: '[morning digest delivered] {"itemCount":0,"items":[]}' })
    expect(historyMsgs[7]).toEqual({ role: 'assistant', content: '[morning digest delivered] {"itemCount":0,"items":[]}' })
    expect(historyMsgs[8]).toEqual({ role: 'assistant', content: '[morning digest delivered] {"itemCount":0,"items":[]}' })
    expect(historyMsgs[9]).toEqual({
      role: 'assistant',
      content:
        '[morning digest delivered] {"itemCount":3,"items":[{"routineName":"","summary":""},{"routineName":"","summary":""},{"routineName":"Partial","summary":""}]}',
    })
    db.close()
  })
})
