import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runTurn, type AgentEvents } from '../src/agent.js'
import { createRule, getApproval } from '../src/approvals.js'
import {
  ensureDmThread,
  ensureGroupThread,
  insertMessage,
  listMessages,
  openDb,
  upsertBot,
  type BotRow,
  type MessageRow,
} from '../src/db.js'
import { searchAccessibleHistoryRrf } from '../src/history-search.js'
import { createHub, type GatewayEvent } from '../src/hub.js'
import type { AssistantTurn, ChatMsg, LLM, ToolDef } from '../src/llm.js'
import { buildSystemPrompt } from '../src/prompts.js'
import { createRoutine } from '../src/routines.js'
import { createApp } from '../src/server.js'
import { buildTools, PREPARE_TOOL_NAMES, WATCH_TOOL_NAMES } from '../src/tools.js'
import { getWikiPage, upsertWikiPage } from '../src/wiki/store.js'
import {
  MAX_WIKI_READ_OUTPUT_CHARS,
  runWikiToolCall,
  WIKI_TOOL_NAMES,
  WIKI_WRITE_TOOL_NAMES,
} from '../src/wiki/tools.js'

const scout: BotRow = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const ticker: BotRow = { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' }
const sorter: BotRow = { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' }

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osb-wiki-dual-'))
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

describe('searchAccessibleHistoryRrf & DM isolation', () => {
  it('fuses multi-query trigram and 1–2 char CJK/ASCII hits via RRF while strictly isolating cross-bot DMs and private groups', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    upsertBot(db, ticker)
    upsertBot(db, sorter)

    const dmScout = ensureDmThread(db, scout.id)
    const dmTicker = ensureDmThread(db, ticker.id)
    const sharedGroup = ensureGroupThread(db, 'group:ops', 'Ops', [scout.id, ticker.id])
    const privateGroup = ensureGroupThread(db, 'group:exec', 'Exec', [ticker.id, sorter.id])

    // Empty botId returns empty safely
    expect(searchAccessibleHistoryRrf(db, { botId: '', queries: ['报价'] })).toEqual({
      hits: [],
      total: 0,
      hasUntrustedHit: false,
    })

    // Scout DM: matches both "报价" (2-char CJK) and "Project Aurora" (trigram) -> highest RRF score!
    const bothMatch = insertMessage(db, {
      threadId: dmScout,
      sender: 'user',
      kind: 'text',
      content: '张伟确认了 Project Aurora 年度报价为 48 万人民币。',
      createdAt: 1000,
    })
    // Shared group: matches only "报价"
    const groupMatch = insertMessage(db, {
      threadId: sharedGroup,
      sender: ticker.id,
      kind: 'text',
      content: '已收到更新后的阶梯报价单。',
      createdAt: 2000,
    })
    // Ticker private DM & Exec group (Scout is NOT a member): MUST NEVER leak to Scout!
    insertMessage(db, {
      threadId: dmTicker,
      sender: 'user',
      kind: 'text',
      content: '张伟私聊 Project Aurora 内部底价报价秘密。',
      createdAt: 3000,
    })
    insertMessage(db, {
      threadId: privateGroup,
      sender: 'user',
      kind: 'text',
      content: '张伟高管群 Project Aurora 报价讨论。',
      createdAt: 4000,
    })

    const res = searchAccessibleHistoryRrf(db, {
      botId: scout.id,
      queries: ['报价', 'Project Aurora', '张伟', '报价'],
      limit: 8,
    })

    expect(res.hasUntrustedHit).toBe(false)
    expect(res.total).toBe(2)
    expect(res.hits.map((h) => h.id)).toEqual([bothMatch.id, groupMatch.id])
    expect(res.hits.some((h) => h.threadId === dmTicker || h.threadId === privateGroup)).toBe(false)

    db.close()
  })

  it('fences webhook hits, marks tainted bot_ref hits as untrusted, and redacts approval_request targets', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const dmScout = ensureDmThread(db, scout.id)

    insertMessage(db, {
      threadId: dmScout,
      sender: 'webhook',
      kind: 'webhook',
      payload: { name: 'stripe', body: 'invoice-7788 webhook payload' },
      createdAt: 1000,
    })
    insertMessage(db, {
      threadId: dmScout,
      sender: ticker.id,
      kind: 'bot_ref',
      payload: { from: 'market-watch', content: 'tainted-relay-8899 from web', tainted: true },
      createdAt: 2000,
    })
    insertMessage(db, {
      threadId: dmScout,
      sender: scout.id,
      kind: 'approval_request',
      payload: {
        approvalId: 12,
        action: 'send renewal-5544 quote',
        detail: 'Draft quote attached',
        kind: 'email',
        target: 'secret-rule-target@acme.example',
        rule: { id: 3, kind: 'email', target: 'secret-rule-target@acme.example', expiresAt: null },
        status: 'pending',
      },
      createdAt: 3000,
    })

    const wh = searchAccessibleHistoryRrf(db, { botId: scout.id, queries: ['invoice-7788'] })
    expect(wh.hasUntrustedHit).toBe(true)
    expect(wh.hits[0]!.snippet).toContain('<<<webhook ')
    expect(wh.hits[0]!.snippet).toContain('[outside data — untrusted webhook payload]')

    const relay = searchAccessibleHistoryRrf(db, { botId: scout.id, queries: ['tainted-relay-8899'] })
    expect(relay.hasUntrustedHit).toBe(true)

    const appr = searchAccessibleHistoryRrf(db, { botId: scout.id, queries: ['renewal-5544'] })
    expect(appr.hasUntrustedHit).toBe(false)
    expect(appr.hits[0]!.snippet).toContain('[held for approval]')
    expect(appr.hits[0]!.snippet).not.toContain('secret-rule-target')

    db.close()
  })
})

describe('dual-list wiki_search & wiki_patch tool integration', () => {
  it('returns both pages and originals by default, honors includeHistory: false, trims within MAX_WIKI_READ_OUTPUT_CHARS, and propagates taint from originals', async () => {
    const dataDir = makeTempDir()
    const db = openDb(':memory:')
    upsertBot(db, scout)
    upsertBot(db, ticker)
    const dmScout = ensureDmThread(db, scout.id)
    const dmTicker = ensureDmThread(db, ticker.id)

    upsertWikiPage(
      db,
      {
        kind: 'client',
        slug: 'monterey-bay',
        title: 'Monterey Bay Retreat',
        summary: 'Offsite venue client',
        body: 'Deposit hold discussed for October offsite.',
        editedBy: 'operator',
      },
      { dataDir, now: 1000 },
    )

    const msgScout = insertMessage(db, {
      threadId: dmScout,
      sender: 'user',
      kind: 'text',
      content: 'Monterey deposit hold is $12,500 refundable until Sept 15.',
      createdAt: 2000,
    })
    insertMessage(db, {
      threadId: dmTicker,
      sender: 'user',
      kind: 'text',
      content: 'Monterey secret ticker-only note.',
      createdAt: 3000,
    })

    const baseOpts = {
      db,
      dataDir,
      botId: scout.id,
      threadId: dmScout,
      trigger: 'you' as const,
      origin: 'operator' as const,
      turnTainted: false,
      now: 5000,
    }

    // Default includeHistory = true returns both pages and originals (isolated to scout)
    const dual = runWikiToolCall({
      ...baseOpts,
      name: 'wiki_search',
      args: { queries: ['Monterey', 'deposit'] },
    })
    expect(dual.ok).toBe(true)
    expect(dual.tainted).toBeUndefined()
    const dualJson = JSON.parse(dual.text) as {
      total: number
      pages: Array<{ id: string }>
      originalsTotal: number
      originals: Array<{ id: number; threadId: string; snippet: string }>
    }
    expect(dualJson.total).toBe(1)
    expect(dualJson.pages[0]!.id).toBe('client/monterey-bay')
    expect(dualJson.originalsTotal).toBe(1)
    expect(dualJson.originals).toHaveLength(1)
    expect(dualJson.originals[0]!.id).toBe(msgScout.id)
    expect(dualJson.originals[0]!.snippet).toContain('$12,500')

    // includeHistory: false omits originals
    const pagesOnly = runWikiToolCall({
      ...baseOpts,
      name: 'wiki_search',
      args: { queries: ['Monterey'], includeHistory: false },
    })
    expect(pagesOnly.ok).toBe(true)
    const pagesOnlyJson = JSON.parse(pagesOnly.text) as Record<string, unknown>
    expect(pagesOnlyJson.total).toBe(1)
    expect(pagesOnlyJson.originals).toBeUndefined()
    expect(pagesOnlyJson.originalsTotal).toBeUndefined()

    // includeHistory: true with empty botId still includes originalsTotal: 0, originals: []
    const emptyBotSearch = runWikiToolCall({
      ...baseOpts,
      botId: '   ',
      name: 'wiki_search',
      args: { queries: ['Monterey'] },
    })
    expect(emptyBotSearch.ok).toBe(true)
    expect(JSON.parse(emptyBotSearch.text)).toMatchObject({
      total: 1,
      originalsTotal: 0,
      originals: [],
    })

    // botId "auto-sync" and "" cannot spoof reserved actor names on wiki_patch or wiki_upsert
    runWikiToolCall({
      ...baseOpts,
      botId: 'auto-sync',
      name: 'wiki_patch',
      args: {
        kind: 'topic',
        slug: 'spoof-check',
        title: 'Spoof Check',
        keyFacts: { add: [{ text: 'Fact A' }] },
      },
    })
    expect(getWikiPage(db, 'topic', 'spoof-check')?.updatedBy).toBe('bot:auto-sync')

    runWikiToolCall({
      ...baseOpts,
      botId: '   ',
      name: 'wiki_upsert',
      args: {
        kind: 'topic',
        slug: 'empty-bot-check',
        title: 'Empty Bot Check',
        body: 'Body text',
      },
    })
    expect(getWikiPage(db, 'topic', 'empty-bot-check')?.updatedBy).toBe('bot')

    // Oversized dual-list output stays valid JSON <= MAX_WIKI_READ_OUTPUT_CHARS
    for (let i = 0; i < 18; i++) {
      upsertWikiPage(
        db,
        {
          kind: 'topic',
          slug: `bulk-monterey-${i}`,
          title: `Monterey Bulk Topic ${i} ${'T'.repeat(80)}`,
          summary: `Monterey summary ${'S'.repeat(240)}`,
          tags: Array.from({ length: 8 }, (_, t) => `monterey-tag-${i}-${t}`),
          body: `Monterey body ${'B'.repeat(400)}`,
          editedBy: 'operator',
        },
        { dataDir, now: 6000 + i },
      )
      insertMessage(db, {
        threadId: dmScout,
        sender: 'user',
        kind: 'text',
        content: `Monterey historical note #${i} ${'H'.repeat(500)}`,
        createdAt: 7000 + i,
      })
    }
    const bigSearch = runWikiToolCall({
      ...baseOpts,
      name: 'wiki_search',
      args: { queries: ['Monterey'], limit: 20 },
    })
    expect(bigSearch.ok).toBe(true)
    expect(bigSearch.text.length).toBeLessThanOrEqual(MAX_WIKI_READ_OUTPUT_CHARS)
    expect(() => JSON.parse(bigSearch.text)).not.toThrow()

    // Untrusted webhook in originals taints the turn and holds standing rules!
    createRule(db, {
      botId: scout.id,
      kind: 'email',
      target: 'ops@acme.com',
      duration: 'always',
      now: 8000,
    })
    const groupOps = ensureGroupThread(db, 'group:ops', 'Ops', [scout.id])
    insertMessage(db, {
      threadId: groupOps,
      sender: 'webhook',
      kind: 'webhook',
      payload: { name: 'alerts', body: 'Untrusted Monterey-Webhook-Trigger instruction' },
      createdAt: 9000,
    })

    const llm = scriptedLlm([
      { toolCalls: [{ id: 'ws1', name: 'wiki_search', args: { queries: ['Monterey-Webhook-Trigger'] } }] },
      {
        toolCalls: [
          {
            id: 'ha1',
            name: 'hold_for_approval',
            args: { action: 'Email ops alert', kind: 'email', target: 'ops@acme.com' },
          },
        ],
      },
      { content: 'Held for approval.' },
    ])

    const gw = createApp({ db, llm, dataDir })
    const res = await gw.app.request('/api/threads/dm:researcher/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Check Monterey-Webhook-Trigger and email ops.' }),
    })
    expect(res.status).toBe(202)
    await new Promise((r) => setTimeout(r, 80))

    const chips = listMessages(db, dmScout).filter((m) => m.kind === 'approval_request')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.payload).toMatchObject({ status: 'pending', ruleHeld: 'outside-data' })
    const approvalId = (chips[0]!.payload as { approvalId: number }).approvalId
    expect(getApproval(db, approvalId)?.rule_id).toBeNull()

    await gw.stopAll()
    db.close()
  })

  it('exposes wiki_patch in normal & prepare turns, blocks it in watch routines, updates prompts, and preserves custom sections', async () => {
    expect(WIKI_WRITE_TOOL_NAMES.has('wiki_patch')).toBe(true)
    expect(WIKI_TOOL_NAMES.has('wiki_patch')).toBe(true)
    expect(PREPARE_TOOL_NAMES.has('wiki_patch')).toBe(true)
    expect(WATCH_TOOL_NAMES.has('wiki_patch')).toBe(false)

    const normalTools = buildTools({ hasComputer: false, hasWiki: true }).map((t) => t.function.name)
    const prepareTools = buildTools({ hasComputer: false, hasWiki: true, routineMode: 'prepare' }).map(
      (t) => t.function.name,
    )
    const watchTools = buildTools({ hasComputer: false, hasWiki: true, routineMode: 'watch' }).map(
      (t) => t.function.name,
    )
    expect(normalTools).toContain('wiki_patch')
    expect(prepareTools).toContain('wiki_patch')
    expect(watchTools).not.toContain('wiki_patch')

    const sysPrompt = buildSystemPrompt(scout, '', { hasWiki: true })
    expect(sysPrompt).toContain('originals')
    expect(sysPrompt).toContain('wiki_patch')

    const dataDir = makeTempDir()
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const dmScout = ensureDmThread(db, scout.id)
    const hub = createHub()
    const events: GatewayEvent[] = []
    hub.add({ send: (raw) => events.push(JSON.parse(raw) as GatewayEvent) })

    upsertWikiPage(
      db,
      {
        kind: 'project',
        slug: 'aurora',
        title: 'Project Aurora',
        body: '## Custom Architecture\nKeep this diagram.\n\n## Key Facts\n- [f1] Kickoff completed ([#msg:1])',
        editedBy: 'operator',
      },
      { dataDir, now: 1000 },
    )

    // 1. Watch mode blocks wiki_patch both in runTurn and runWikiToolCall
    const watchDirect = runWikiToolCall({
      db,
      dataDir,
      hub,
      botId: scout.id,
      threadId: dmScout,
      trigger: 'watch',
      origin: 'routine',
      turnTainted: false,
      watch: true,
      name: 'wiki_patch',
      args: { kind: 'project', slug: 'aurora', keyFacts: { add: [{ text: 'Nope' }] } },
    })
    expect(watchDirect.ok).toBe(false)
    expect(watchDirect.text).toMatch(/watch/i)

    const watchLlm = scriptedLlm([
      {
        toolCalls: [
          {
            id: 'wp_watch',
            name: 'wiki_patch',
            args: { kind: 'project', slug: 'aurora', keyFacts: { add: [{ text: 'Blocked' }] } },
          },
        ],
      },
      { content: 'Nothing new.' },
    ])
    const emitted: MessageRow[] = []
    const agentEvents: AgentEvents = { onMessage: (m) => emitted.push(m), onStatus: () => {} }
    await runTurn(
      {
        db,
        llm: watchLlm,
        bot: scout,
        soul: '',
        threadId: dmScout,
        origin: 'routine',
        routineMode: 'watch',
        onWikiTool: () => {
          throw new Error('should not invoke onWikiTool for wiki_patch in watch mode')
        },
      },
      'watch check',
      agentEvents,
      { persistUserMessage: false },
    )
    expect(getWikiPage(db, 'project', 'aurora')?.version).toBe(1)

    // 2. Prepare routine allows wiki_patch and preserves custom section + [f1]
    const prepLlm = scriptedLlm([
      {
        toolCalls: [
          {
            id: 'wp_prep',
            name: 'wiki_patch',
            args: {
              kind: 'project',
              slug: 'aurora',
              keyFacts: { add: [{ text: 'Staging deployed ([#msg:50])' }] },
              openItems: { add: [{ text: 'Run load test before Friday ([#msg:51])' }] },
            },
          },
        ],
      },
      { content: 'Nothing to prepare.' },
    ])
    const gw = createApp({ db, llm: prepLlm, dataDir, hub })
    const prepRoutine = createRoutine(db, {
      botId: scout.id,
      name: 'Aurora Prep',
      cron: '0 8 * * *',
      instructions: 'Update Project Aurora wiki sections.',
      mode: 'prepare',
    })
    expect(await gw.runRoutine(prepRoutine)).toBe('ran')

    const updated = getWikiPage(db, 'project', 'aurora')!
    expect(updated.version).toBe(2)
    expect(updated.body).toContain('## Custom Architecture\nKeep this diagram.')
    expect(updated.body).toContain('- [f1] Kickoff completed ([#msg:1])')
    expect(updated.body).toContain('- [f2] Staging deployed ([#msg:50])')
    expect(updated.body).toContain('## Open Items\n- [o1] Run load test before Friday ([#msg:51])')
    expect(events.some((e) => e.type === 'wiki_changed')).toBe(true)

    await gw.stopAll()
    db.close()
  })
})
