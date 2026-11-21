import { describe, expect, it } from 'vitest'
import { listMessages, openDb, SCHEMA_VERSION, schemaVersion } from '../src/db.js'
import { createGoal, getGoalView } from '../src/goals/store.js'
import { createHub, type GatewayEvent } from '../src/hub.js'
import type { LLM } from '../src/llm.js'
import { createApp } from '../src/server.js'
import { MAX_ITEMS_PER_SPACE } from '../src/spaces/schema.js'
import { getSpace, upsertSpaceItem } from '../src/spaces/store.js'
import type { SpacesSnapshot, SpaceView } from '../src/spaces/types.js'

const quietLlm: LLM = {
  async chat() {
    return { content: 'Done.', toolCalls: [], raw: { role: 'assistant', content: 'Done.' } }
  },
}

function seedDb() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('chief', 'Chief', 'Chief of Staff', '🧠', '', 1)`).run()
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('scout', 'Scout', 'Research', '🔎', '', 2)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:chief', 'dm', 'chief', 'Chief', 1)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:scout', 'dm', 'scout', 'Scout', 2)`).run()
  return db
}

describe('spaces store & REST API (v17)', () => {
  it('migrates cleanly to v17 and rejects non-declarative space kinds', async () => {
    const db = seedDb()
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(17)
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)

    const gw = createApp({ db, llm: quietLlm })
    const rejected = await gw.app.request('/api/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Unsafe App', kind: 'sandbox' }),
    })
    expect(rejected.status).toBe(400)
  })

  it('supports Space, Item, Grant CRUD, Goal linkage & safe unlink on goal delete, and 200-item cap', async () => {
    const db = seedDb()
    const events: GatewayEvent[] = []
    const hub = createHub()
    hub.add({ send: (raw) => events.push(JSON.parse(raw) as GatewayEvent) })
    const gw = createApp({ db, llm: quietLlm, hub, now: () => new Date(10_000) })

    const goal = createGoal(db, { title: 'Q2 Pricing', ownerBotId: 'chief' })

    const createRes = await gw.app.request('/api/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Competitor Pricing',
        template: 'tracker',
        goalId: goal.id,
        grants: [{ botId: 'scout', role: 'editor' }],
      }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { space: SpaceView; snapshot: SpacesSnapshot }
    expect(created.space.id).toMatch(/^space-[0-9a-f]{8}$/)
    expect(created.space.goalId).toBe(goal.id)
    expect(created.space.goalTitle).toBe('Q2 Pricing')
    expect(created.space.grants).toEqual([{ botId: 'scout', role: 'editor' }])
    expect(events.map((e) => e.type)).toContain('spaces_changed')
    expect(events.map((e) => e.type)).toContain('goals_changed')

    // GoalView includes linked space
    const goalView = getGoalView(db, goal.id)!
    expect(goalView.spaces).toEqual([{ id: created.space.id, title: 'Competitor Pricing', icon: '📊' }])

    // Add item with valid URL, reject javascript: URL
    const badUrl = await gw.app.request(`/api/spaces/${created.space.id}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockId: 'records', title: 'Bad Vendor', data: { link: 'javascript:alert(1)' } }),
    })
    expect(badUrl.status).toBe(400)

    const addItem = await gw.app.request(`/api/spaces/${created.space.id}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        blockId: 'records',
        title: 'Acme Cloud',
        status: 'active',
        data: { category: 'GPU', value: 120, link: 'https://acme.test/pricing' },
      }),
    })
    expect(addItem.status).toBe(201)
    const added = (await addItem.json()) as { item: { id: string }; space: SpaceView }
    expect(added.space.items).toHaveLength(1)

    // Computer panel bot-level grant toggle
    const toggleGrant = await gw.app.request(`/api/bots/chief/spaces/${created.space.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(toggleGrant.status).toBe(200)
    const compRes = await gw.app.request('/api/bots/chief/computer')
    const comp = (await compRes.json()) as { spaces: Array<{ id: string; role: string | null }> }
    expect(comp.spaces.find((s) => s.id === created.space.id)?.role).toBe('viewer')

    // Deleting the goal safely unlinks space.goalId without deleting the space
    const delGoal = await gw.app.request(`/api/goals/${goal.id}`, { method: 'DELETE' })
    expect(delGoal.status).toBe(200)
    expect(getSpace(db, created.space.id)?.goalId).toBeNull()

    // Enforce 200 items cap per space
    for (let i = 1; i < MAX_ITEMS_PER_SPACE; i++) {
      upsertSpaceItem(db, { spaceId: created.space.id, blockId: 'records', title: `Row ${i}`, updatedBy: 'operator' })
    }
    const overflow = await gw.app.request(`/api/spaces/${created.space.id}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockId: 'records', title: 'Row 201' }),
    })
    expect(overflow.status).toBe(400)
  })

  it('executes persisted action_bar buttons safely via POST /api/spaces/:id/actions/:actionId', async () => {
    const db = seedDb()
    const gw = createApp({ db, llm: quietLlm, now: () => new Date(20_000) })

    const createRes = await gw.app.request('/api/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Vendor Watch',
        template: 'tracker',
        grants: [{ botId: 'scout', role: 'editor' }],
      }),
    })
    const { space } = (await createRes.json()) as { space: SpaceView }

    const runAction = await gw.app.request(`/api/spaces/${space.id}/actions/refresh`, { method: 'POST' })
    expect(runAction.status).toBe(202)
    const body = (await runAction.json()) as { botId: string; threadId: string }
    expect(body.botId).toBe('scout')
    expect(body.threadId).toBe('dm:scout')

    await new Promise((r) => setTimeout(r, 30))
    const msgs = listMessages(db, 'dm:scout')
    expect(msgs.some((m) => m.sender === 'user' && m.content.includes('Ask teammate to refresh table'))).toBe(true)

    const missingAction = await gw.app.request(`/api/spaces/${space.id}/actions/nonexistent`, { method: 'POST' })
    expect(missingAction.status).toBe(404)
  })
})
