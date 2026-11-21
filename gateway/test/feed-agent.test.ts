import { describe, expect, it } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { openDb } from '../src/db.js'
import type { LLM, ToolCall } from '../src/llm.js'
import type { Pool } from '../src/pool.js'
import { createRoutine } from '../src/routines.js'
import { createApp } from '../src/server.js'

function scriptedLlm(steps: Array<{ content?: string; toolCalls?: ToolCall[] }>): {
  llm: LLM
  seenTools: string[][]
  seenToolResults: string[]
} {
  let idx = 0
  const seenTools: string[][] = []
  const seenToolResults: string[] = []
  const llm: LLM = {
    async chat(messages, tools) {
      seenTools.push((tools ?? []).map((t) => t.function.name))
      for (const m of messages) {
        if (m.role === 'tool' && typeof m.content === 'string') seenToolResults.push(m.content)
      }
      const next = steps[idx++] ?? { content: 'Done.' }
      const toolCalls = next.toolCalls ?? []
      return {
        content: next.content ?? (toolCalls.length ? null : 'Done.'),
        toolCalls,
        raw: { role: 'assistant', content: next.content ?? null, ...(toolCalls.length ? { tool_calls: [] } : {}) },
      }
    },
  }
  return { llm, seenTools, seenToolResults }
}

function makePool(): Pool {
  const computer = createFakeComputer()
  return {
    async get() { return computer },
    peek() { return Promise.resolve(computer) },
    async disposeAll() {},
    lastUsed: () => undefined,
    async forget() {},
    async retire() {},
  }
}

function seedDb() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('chief', 'Chief', 'Chief of Staff', '🧠', '', 1)`).run()
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('scout', 'Scout', 'Research', '🔎', '', 2)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:chief', 'dm', 'chief', 'Chief', 1)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:scout', 'dm', 'scout', 'Scout', 2)`).run()
  return db
}

describe('feed agent integration: watch projection, publish_feed limits/taint, and read-only idea incubation', () => {
  it('auto-projects watch routine reports to Feed as tainted signals and allows publish_feed in watch mode with a 3-item cap', async () => {
    const db = seedDb()
    const { llm, seenTools, seenToolResults } = scriptedLlm([
      {
        toolCalls: [
          {
            id: 'r1',
            name: 'message_user',
            args: {
              kind: 'report',
              payload: {
                lines: [{ system: 'Status Page', result: 'degraded API latency', count: 'p99 1.8s' }],
                closing: 'Worth watching over the next hour.',
              },
            },
          },
          { id: 'f1', name: 'publish_feed', args: { kind: 'proposal', title: 'Proposal 1', summary: 'Summary 1', suggested_action: 'Inspect logs' } },
          { id: 'f2', name: 'publish_feed', args: { kind: 'signal', title: 'Signal 2', summary: 'Summary 2' } },
          { id: 'f3', name: 'publish_feed', args: { kind: 'briefing', title: 'Briefing 3', summary: 'Summary 3' } },
          { id: 'f4', name: 'publish_feed', args: { kind: 'signal', title: 'Signal 4 overflow', summary: 'Should be blocked' } },
        ],
      },
      { content: 'Nothing new.' },
    ])
    const gw = createApp({ db, llm, pool: makePool(), now: () => new Date(20_000) })
    const routine = createRoutine(db, {
      botId: 'scout',
      name: 'API Watch',
      cron: '*/15 * * * *',
      instructions: 'Check API status page',
      mode: 'watch',
    })
    await gw.runRoutine(routine)

    // watch routine has publish_feed but no write tools (shell, write_file, browser_click)
    expect(seenTools[0]).toContain('publish_feed')
    expect(seenTools[0]).not.toContain('shell')
    expect(seenTools[0]).not.toContain('write_file')

    // 4th publish_feed in the same turn is refused
    expect(seenToolResults.some((t) => t.includes('already published 3 feed cards'))).toBe(true)

    const res = await gw.app.request('/api/feed')
    const snap = (await res.json()) as {
      items: Array<{ kind: string; title: string; tainted: boolean; body: { report?: unknown; suggestedAction?: string } }>
    }
    // 1 projected report + 3 publish_feed items = 4 total (overflow blocked)
    expect(snap.items).toHaveLength(4)
    // Every item from a watch/routine turn MUST be marked tainted = true
    expect(snap.items.every((i) => i.tainted === true)).toBe(true)
    const projected = snap.items.find((i) => i.body.report)
    expect(projected).toBeDefined()
    expect(projected?.kind).toBe('signal')
    expect(projected?.title).toContain('API Watch')
  })

  it('incubates an idea in strict read-only watch mode and writes the findings back to ready status, then dispatches to chat', async () => {
    const db = seedDb()
    const { llm, seenTools } = scriptedLlm([
      { content: 'Feasibility: High.\n1. Use public pricing API.\n2. Run weekly watch routine.' },
      { content: 'On it! Starting execution now.' },
    ])
    const gw = createApp({ db, llm, pool: makePool(), now: () => new Date(30_000) })

    const createdRes = await gw.app.request('/api/ideas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Track competitor pricing', notes: 'Focus on top 3 SaaS rivals' }),
    })
    const { idea } = (await createdRes.json()) as { idea: { id: string } }

    // Incubate with scout -> MUST run in read-only watch mode!
    const incRes = await gw.app.request(`/api/ideas/${idea.id}/incubate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'scout' }),
    })
    expect(incRes.status).toBe(202)
    await new Promise((r) => setTimeout(r, 50))

    // Verify incubation ran strictly read-only (no shell, no write_file, no browser_click, no create_routine)
    expect(seenTools[0]).toBeDefined()
    expect(seenTools[0]).not.toContain('shell')
    expect(seenTools[0]).not.toContain('write_file')
    expect(seenTools[0]).not.toContain('browser_click')
    expect(seenTools[0]).not.toContain('create_routine')

    const feedAfterInc = await gw.app.request('/api/feed')
    const snapAfterInc = (await feedAfterInc.json()) as {
      ideas: Array<{ id: string; status: string; incubationSummary: string; assignedBotId: string }>
    }
    const incubated = snapAfterInc.ideas.find((i) => i.id === idea.id)!
    expect(incubated.status).toBe('ready')
    expect(incubated.assignedBotId).toBe('scout')
    expect(incubated.incubationSummary).toContain('Feasibility: High.')

    // Dispatch to chief -> marks promoted and posts message into dm:chief
    const dispRes = await gw.app.request(`/api/ideas/${idea.id}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'chief', instructions: 'Kick off phase 1' }),
    })
    expect(dispRes.status).toBe(202)
    const disp = (await dispRes.json()) as { threadId: string; botId: string; idea: { status: string } }
    expect(disp.threadId).toBe('dm:chief')
    expect(disp.botId).toBe('chief')
    expect(disp.idea.status).toBe('promoted')
    await new Promise((r) => setTimeout(r, 50))

    // Operator dispatch turn has full tools
    expect(seenTools[1]).toContain('create_routine')
    const msgs = db.prepare(`SELECT content FROM messages WHERE thread_id = 'dm:chief' AND sender = 'user'`).all() as { content: string }[]
    expect(msgs.some((m) => m.content.includes('Track competitor pricing') && m.content.includes('Feasibility: High.'))).toBe(true)
  })

  it('runs a custom Feed topic in read-only watch mode with web_search, publishes cited tainted cards, and filters unsafe source URLs', async () => {
    const db = seedDb()
    const { llm, seenTools } = scriptedLlm([
      {
        toolCalls: [
          { id: 'ws1', name: 'web_search', args: { query: 'AI Agent releases' } },
        ],
      },
      {
        toolCalls: [
          {
            id: 'pf1',
            name: 'publish_feed',
            args: {
              kind: 'briefing',
              title: 'Open Agent Runtime v3 ships',
              summary: 'Faster tool orchestration with built-in sandboxing.',
              tags: ['ai', 'agents'],
              sources: [
                { title: 'Release Post', url: 'https://news.example.com/agent-v3' },
                { title: 'Bad XSS', url: 'javascript:alert(1)' },
              ],
            },
          },
        ],
      },
      { content: 'Nothing new.' },
    ])

    const gw = createApp({
      db,
      llm,
      now: () => new Date(40_000),
      webResearch: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async (url) => {
          if (url.includes('bing.com/news')) {
            return new Response(
              `<rss><channel><item><title>Open Agent Runtime v3 ships</title><link>https://news.example.com/agent-v3</link><description>New release</description></item></channel></rss>`,
              { headers: { 'content-type': 'application/rss+xml' } },
            )
          }
          return new Response('', { status: 404 })
        },
      },
    })

    const createdRes = await gw.app.request('/api/feed/topics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'AI Agent Radar',
        prompt: 'Fetch latest AI Agent framework releases with links.',
        runNow: true,
      }),
    })
    expect(createdRes.status).toBe(201)
    const { topic } = (await createdRes.json()) as { topic: { id: string } }
    await new Promise((r) => setTimeout(r, 80))

    // Custom feed run MUST expose web_search, web_fetch, publish_feed — and NEVER write tools
    expect(seenTools[0]).toContain('web_search')
    expect(seenTools[0]).toContain('web_fetch')
    expect(seenTools[0]).toContain('publish_feed')
    expect(seenTools[0]).not.toContain('shell')
    expect(seenTools[0]).not.toContain('write_file')
    expect(seenTools[0]).not.toContain('create_routine')

    const snap = (await (await gw.app.request('/api/feed')).json()) as {
      items: Array<{ topicId: string | null; title: string; tainted: boolean; body: { sources?: Array<{ title: string; url: string }> } }>
      topics: Array<{ id: string; lastRunAt: number | null; running: boolean; lastError: string }>
    }
    expect(snap.items).toHaveLength(1)
    expect(snap.items[0]).toMatchObject({
      topicId: topic.id,
      title: 'Open Agent Runtime v3 ships',
      tainted: true,
      body: {
        sources: [{ title: 'Release Post', url: 'https://news.example.com/agent-v3' }],
      },
    })
    expect(snap.topics[0]).toMatchObject({ id: topic.id, lastRunAt: 40_000, running: false, lastError: '' })
  })

  it('falls back to a briefing card if a model replies in plain text without calling publish_feed during a topic fetch', async () => {
    const db = seedDb()
    const { llm } = scriptedLlm([
      { content: 'Top update today: Cloud GPU spot prices fell 12% across US regions.' },
    ])
    const gw = createApp({ db, llm, now: () => new Date(50_000) })

    const createdRes = await gw.app.request('/api/feed/topics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Cloud GPU Watch',
        prompt: 'Check cloud GPU price drops.',
      }),
    })
    const { topic } = (await createdRes.json()) as { topic: { id: string } }
    const runRes = await gw.app.request(`/api/feed/topics/${topic.id}/run`, { method: 'POST' })
    expect(runRes.status).toBe(202)
    await new Promise((r) => setTimeout(r, 80))

    const snap = (await (await gw.app.request('/api/feed')).json()) as {
      items: Array<{ topicId: string | null; title: string; summary: string; tainted: boolean }>
    }
    expect(snap.items).toHaveLength(1)
    expect(snap.items[0]).toMatchObject({
      topicId: topic.id,
      title: 'Cloud GPU Watch',
      summary: 'Top update today: Cloud GPU spot prices fell 12% across US regions.',
      tainted: true,
    })
  })
})
