import { describe, expect, it } from 'vitest'
import { distillThreadContext } from '../src/context-distill.js'
import { insertMessage, openDb } from '../src/db.js'
import { createFeedItem, createFeedTopic } from '../src/feed/store.js'
import { MAX_DAILY_CUSTOM_FEED_ITEMS } from '../src/feed/types.js'
import { createHub } from '../src/hub.js'
import type { LLM } from '../src/llm.js'
import { createApp } from '../src/server.js'

function seedDb() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('chief', 'Chief', 'Chief of Staff', '🧠', '', 1)`).run()
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('scout', 'Scout', 'Research', '🔎', '', 2)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:chief', 'dm', 'chief', 'Chief', 1)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:scout', 'dm', 'scout', 'Scout', 2)`).run()
  return db
}

describe('conversation context auto-distillation and ambient continuous custom Feed', () => {
  it('automatically distills Ideas, Todos, and Goals from chat context with deduplication and milestone updates', async () => {
    const db = seedDb()
    const hub = createHub()
    insertMessage(db, { threadId: 'dm:chief', sender: 'user', kind: 'text', content: 'Maybe we should test a weekly AI pricing digest, and also launch Polery connector before Friday.' })
    insertMessage(db, { threadId: 'dm:chief', sender: 'chief', kind: 'text', content: 'Sounds great — I can track the Polery connector release and check pricing pages tomorrow.' })

    const llm: LLM = {
      async chat() {
        return {
          content: JSON.stringify({
            ideas: [{ title: 'Weekly AI pricing digest', notes: 'Compare GPU & LLM API pricing weekly' }],
            todos: [{ title: 'Check Polery OAuth callback on staging', detail: 'Verify PKCE + token refresh', ownerBotId: 'scout' }],
            goals: [{
              title: 'Ship Polery Docs Connector',
              description: 'Native OAuth 2.1 + MCP connector for Polery cloud documents',
              successCriteria: 'Users connect Polery Docs with one click and read/propose edits safely',
              milestones: ['Finish OAuth 2.1 flow', 'Verify end-to-end tool calls'],
              ownerBotId: 'chief',
            }],
          }),
          toolCalls: [],
          raw: { role: 'assistant', content: '' },
        }
      },
    }

    const first = await distillThreadContext({ db, llm, hub, threadId: 'dm:chief', defaultBotId: 'chief', now: () => 10_000 })
    expect(first).toEqual({ ideasAdded: 1, todosAdded: 1, todosCompleted: 0, goalsAdded: 1, goalsUpdated: 0 })

    // Re-running on same conversation must deduplicate completely!
    const second = await distillThreadContext({ db, llm, hub, threadId: 'dm:chief', defaultBotId: 'chief', now: () => 20_000 })
    expect(second).toEqual({ ideasAdded: 0, todosAdded: 0, todosCompleted: 0, goalsAdded: 0, goalsUpdated: 0 })

    const gw = createApp({ db, llm, now: () => new Date(30_000) })
    const feedSnap = (await (await gw.app.request('/api/feed')).json()) as {
      ideas: Array<{ title: string; origin: string; sourceThreadId: string | null }>
      todos: Array<{ id: string; title: string; status: string; origin: string; sourceThreadId: string | null; ownerBotId: string | null }>
    }
    expect(feedSnap.ideas[0]).toMatchObject({ title: 'Weekly AI pricing digest', origin: 'conversation', sourceThreadId: 'dm:chief' })
    expect(feedSnap.todos[0]).toMatchObject({ title: 'Check Polery OAuth callback on staging', status: 'open', origin: 'auto', sourceThreadId: 'dm:chief', ownerBotId: 'scout' })

    // Mark todo done via PATCH /api/todos/:id
    const doneRes = await gw.app.request(`/api/todos/${feedSnap.todos[0]!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect(doneRes.status).toBe(200)
    expect(((await doneRes.json()) as { todo: { status: string } }).todo.status).toBe('done')

    const goalsSnap = (await (await gw.app.request('/api/goals')).json()) as {
      goals: Array<{ title: string; origin: string; sourceThreadId: string | null; milestones: Array<{ title: string }> }>
    }
    expect(goalsSnap.goals[0]).toMatchObject({ title: 'Ship Polery Docs Connector', origin: 'auto', sourceThreadId: 'dm:chief' })
    expect(goalsSnap.goals[0]!.milestones.map((m) => m.title)).toEqual(['Finish OAuth 2.1 flow', 'Verify end-to-end tool calls'])
  })

  it('enforces the daily ~15-item ambient custom feed cap and deduplicates repeated headlines', async () => {
    const db = seedDb()
    const baseNow = 1_750_000_000_000
    let llmCalls = 0
    const llm: LLM = {
      async chat() {
        llmCalls += 1
        return { content: 'Nothing new.', toolCalls: [], raw: { role: 'assistant', content: 'Nothing new.' } }
      },
    }
    const gw = createApp({ db, llm, now: () => new Date(baseNow) })
    const topic = createFeedTopic(db, { title: 'AI Stream', prompt: 'Track AI news', botId: 'scout', cron: '', now: baseNow })

    // Seed MAX_DAILY_CUSTOM_FEED_ITEMS custom-feed items within last 24h
    for (let i = 0; i < MAX_DAILY_CUSTOM_FEED_ITEMS; i++) {
      createFeedItem(db, {
        kind: 'briefing',
        botId: 'scout',
        threadId: 'dm:scout',
        topicId: topic.id,
        title: `Unique AI News Item #${i + 1}`,
        summary: 'Summary',
        sourceLabel: 'custom-feed',
        tainted: true,
        now: baseNow - i * 1000,
      })
    }

    // Background ambient run (force=false) MUST skip once daily cap is reached
    const skipped = await gw.runFeedTopic(topic)
    expect(skipped).toBe('skipped')
    expect(llmCalls).toBe(0)

    const snap = (await (await gw.app.request('/api/feed')).json()) as { dailyCustomCount: number; dailyCustomCap: number }
    expect(snap.dailyCustomCount).toBe(MAX_DAILY_CUSTOM_FEED_ITEMS)
    expect(snap.dailyCustomCap).toBe(MAX_DAILY_CUSTOM_FEED_ITEMS)
  })
})
