import { describe, expect, it } from 'vitest'
import { attachApprovalMessage, createApproval } from '../src/approvals.js'
import { insertMessage, openDb, pendingCount, SCHEMA_VERSION, schemaVersion } from '../src/db.js'
import { createFeedItem, listNeedsYou } from '../src/feed/store.js'
import type { LLM } from '../src/llm.js'
import { createApp } from '../src/server.js'

const noopLlm: LLM = {
  async chat() {
    return { content: 'Noted.', toolCalls: [], raw: { role: 'assistant', content: 'Noted.' } }
  },
}

function setup() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('chief', 'Chief', 'Chief of Staff', '🧠', '', 1)`).run()
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('scout', 'Scout', 'Research', '🔎', '', 2)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:chief', 'dm', 'chief', 'Chief', 1)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:scout', 'dm', 'scout', 'Scout', 2)`).run()
  const gw = createApp({ db, llm: noopLlm, now: () => new Date(10_000) })
  return { db, gw }
}

describe('feed store, Needs You aggregation, and HTTP API', () => {
  it('migrates cleanly to latest schema version with feed_items, ideas, and routines.surface', () => {
    const db = openDb(':memory:')
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('feed_items', 'ideas')`)
      .all() as { name: string }[]
    expect(tables.map((t) => t.name).sort()).toEqual(['feed_items', 'ideas'])
    const cols = (db.pragma('table_info(routines)') as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('surface')
  })

  it('aggregates pending approvals, open questions, and unaddressed login requests across all teammates', async () => {
    const { db, gw } = setup()

    // 1. Pending approval on scout
    const appr = createApproval(db, {
      threadId: 'dm:scout',
      botId: 'scout',
      action: 'Send weekly summary',
      detail: 'To team@acme.test',
      kind: 'email',
      target: 'team@acme.test',
      now: 100,
    })
    const apprMsg = insertMessage(db, {
      threadId: 'dm:scout',
      sender: 'scout',
      kind: 'approval_request',
      payload: { approvalId: appr.id, action: appr.action, detail: appr.detail, kind: 'email', target: 'team@acme.test', status: 'pending', canRemember: true },
    })
    attachApprovalMessage(db, appr.id, apprMsg.id)

    // 2. Open question on chief
    insertMessage(db, {
      threadId: 'dm:chief',
      sender: 'chief',
      kind: 'question',
      payload: { question: 'Ship v0.8 today?', options: ['Yes', 'Wait'], multi: false, status: 'open' },
    })

    // 3. Open login request on scout (no later user message)
    insertMessage(db, {
      threadId: 'dm:scout',
      sender: 'scout',
      kind: 'login_request',
      payload: { site: 'Zendesk', why: 'Check ticket queue' },
    })

    // 4. Addressed login request on chief (followed by user message — must NOT appear)
    insertMessage(db, {
      threadId: 'dm:chief',
      sender: 'chief',
      kind: 'login_request',
      payload: { site: 'Linear', why: 'Old login' },
    })
    insertMessage(db, {
      threadId: 'dm:chief',
      sender: 'user',
      kind: 'text',
      content: 'Signed in',
    })

    expect(pendingCount(db)).toBe(2) // 1 approval + 1 question
    const needs = listNeedsYou(db)
    expect(needs.map((n) => n.kind).sort()).toEqual(['approval', 'login', 'question'])
    expect(needs.find((n) => n.kind === 'login')).toMatchObject({ botId: 'scout', payload: { site: 'Zendesk' } })

    const res = await gw.app.request('/api/feed')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { needsYou: unknown[]; items: unknown[]; ideas: unknown[]; unreadCount: number }
    expect(body.needsYou).toHaveLength(3)
    expect(body.unreadCount).toBe(0)
  })

  it('supports feed status updates, read-all, delete, and taint-preserving promotion to Ideas', async () => {
    const { db, gw } = setup()

    const item = createFeedItem(db, {
      kind: 'proposal',
      botId: 'scout',
      threadId: 'dm:scout',
      title: 'Track cloud GPU price drops',
      summary: 'Detected a 15% reduction on A100 instances.',
      body: { suggestedAction: 'Set up a weekly watch routine', suggestedBotId: 'scout' },
      tags: ['pricing', 'cloud'],
      tainted: true,
      sourceLabel: 'watch',
      now: 1000,
    })

    // Promote tainted proposal to Idea -> must keep tainted = true and mark feed item read
    const promoRes = await gw.app.request(`/api/feed/${item.id}/idea`, { method: 'POST' })
    expect(promoRes.status).toBe(201)
    const promo = (await promoRes.json()) as {
      idea: { id: string; title: string; origin: string; tainted: boolean; sourceFeedId: string; status: string }
      snapshot: { unreadCount: number }
    }
    expect(promo.idea).toMatchObject({
      title: 'Track cloud GPU price drops',
      origin: 'proposal',
      tainted: true,
      sourceFeedId: item.id,
      status: 'inbox',
    })
    expect(promo.snapshot.unreadCount).toBe(0)

    // Create another unread item and test mark-all-read & archive
    const item2 = createFeedItem(db, {
      kind: 'briefing',
      botId: 'chief',
      threadId: 'dm:chief',
      title: 'Morning briefing',
      summary: 'All systems nominal.',
      now: 2000,
    })
    const readAll = await gw.app.request('/api/feed/read-all', { method: 'POST' })
    expect(readAll.status).toBe(200)
    expect(((await readAll.json()) as { updated: number; snapshot: { unreadCount: number } })).toMatchObject({
      updated: 1,
      snapshot: { unreadCount: 0 },
    })

    const arch = await gw.app.request(`/api/feed/${item2.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    })
    expect(arch.status).toBe(200)
    // Archived items are hidden from default active feed view
    expect(((await arch.json()) as { snapshot: { items: { id: string }[] } }).snapshot.items.some((i) => i.id === item2.id)).toBe(false)

    // Manual idea CRUD
    const ideaCreate = await gw.app.request('/api/ideas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Build weekly competitor matrix', notes: 'Compare top 3 vendors' }),
    })
    expect(ideaCreate.status).toBe(201)
    const { idea } = (await ideaCreate.json()) as { idea: { id: string; tainted: boolean } }
    expect(idea.tainted).toBe(false)

    const del = await gw.app.request(`/api/ideas/${idea.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
  })

  it('supports custom Feed topic CRUD, cron validation, and snapshot inclusion', async () => {
    const { gw } = setup()

    // Invalid cron is rejected
    const bad = await gw.app.request('/api/feed/topics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'AI News', prompt: 'Track AI Agent releases', cron: 'not-a-cron' }),
    })
    expect(bad.status).toBe(400)

    // Create custom topic (defaults to scout/chief and valid cron)
    const createdRes = await gw.app.request('/api/feed/topics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'AI Agent Daily',
        prompt: 'Search the web for new AI Agent frameworks and summarize top 3 updates with links.',
        cron: '0 9 * * *',
      }),
    })
    expect(createdRes.status).toBe(201)
    const created = (await createdRes.json()) as {
      topic: { id: string; title: string; botId: string; cron: string; human: string; enabled: boolean }
      snapshot: { topics: Array<{ id: string }> }
    }
    expect(created.topic).toMatchObject({
      title: 'AI Agent Daily',
      botId: 'scout',
      cron: '0 9 * * *',
      human: 'every day at 09:00',
      enabled: true,
    })
    expect(created.snapshot.topics.map((t) => t.id)).toContain(created.topic.id)

    // Patch topic prompt & pause it
    const patchedRes = await gw.app.request(`/api/feed/topics/${created.topic.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Focus on open-source LLMs too.', enabled: false, cron: '' }),
    })
    expect(patchedRes.status).toBe(200)
    const patched = (await patchedRes.json()) as { topic: { prompt: string; enabled: boolean; cron: string } }
    expect(patched.topic).toMatchObject({ prompt: 'Focus on open-source LLMs too.', enabled: false, cron: '' })

    // Delete topic
    const delRes = await gw.app.request(`/api/feed/topics/${created.topic.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    const afterDel = (await delRes.json()) as { snapshot: { topics: unknown[] } }
    expect(afterDel.snapshot.topics).toHaveLength(0)
  })
})
