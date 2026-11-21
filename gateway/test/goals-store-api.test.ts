import { describe, expect, it, vi } from 'vitest'
import { listGoalActions } from '../src/actions.js'
import { openDb, SCHEMA_VERSION, schemaVersion } from '../src/db.js'
import { createIdea, getIdea } from '../src/feed/store.js'
import { isIsoDate } from '../src/goals/store.js'
import type { GoalsSnapshot, GoalView } from '../src/goals/types.js'
import { createHub, type GatewayEvent } from '../src/hub.js'
import type { LLM } from '../src/llm.js'
import { createRoutine, getRoutine } from '../src/routines.js'
import type { Scheduler } from '../src/scheduler.js'
import { createApp } from '../src/server.js'

const quietLlm: LLM = {
  async chat() {
    return { content: 'Acknowledged.', toolCalls: [], raw: { role: 'assistant', content: 'Acknowledged.' } }
  },
}

function seedDb() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('chief', 'Chief', 'Chief of Staff', '🧠', '', 1)`).run()
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('scout', 'Scout', 'Research', '🔎', '', 2)`).run()
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('writer', 'Writer', 'Docs', '✍️', '', 3)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:chief', 'dm', 'chief', 'Chief', 1)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:scout', 'dm', 'scout', 'Scout', 2)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:writer', 'dm', 'writer', 'Writer', 3)`).run()
  return db
}

describe('goals store & REST API (v16)', () => {
  it('migrates cleanly through v16 and validates strict ISO dates', () => {
    const db = openDb(':memory:')
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(16)
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)

    expect(isIsoDate('2026-06-30')).toBe(true)
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('not-a-date')).toBe(false)
  })

  it('supports full Goal, Milestone, and Update CRUD plus safe cleanup on delete', async () => {
    const db = seedDb()
    const events: GatewayEvent[] = []
    const hub = createHub()
    hub.add({ send: (raw) => events.push(JSON.parse(raw) as GatewayEvent) })
    const gw = createApp({ db, llm: quietLlm, hub, now: () => new Date(10_000) })

    // Invalid date rejected
    const badDate = await gw.app.request('/api/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Bad date', ownerBotId: 'chief', targetDate: '2026-02-31' }),
    })
    expect(badDate.status).toBe(400)

    // Create goal with milestones and members
    const createRes = await gw.app.request('/api/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Q2 Competitor Audit',
        description: 'Map pricing and positioning of top 5 rivals.',
        successCriteria: 'Comparison sheet and exec summary signed off.',
        ownerBotId: 'chief',
        memberBotIds: ['scout', 'chief'], // owner deduped out of members
        targetDate: '2026-06-30',
        milestones: [
          { title: 'Collect pricing pages', ownerBotId: 'scout', dueDate: '2026-05-15' },
          'Draft executive comparison',
        ],
      }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { goal: GoalView; snapshot: GoalsSnapshot }
    expect(created.goal.id).toMatch(/^goal-[0-9a-f]{8}$/)
    expect(created.goal.ownerBotId).toBe('chief')
    expect(created.goal.memberBotIds).toEqual(['scout'])
    expect(created.goal.milestones).toHaveLength(2)
    expect(created.goal.totalMilestones).toBe(2)
    expect(created.goal.doneMilestones).toBe(0)
    expect(created.snapshot.activeCount).toBe(1)
    expect(events.some((e) => e.type === 'goals_changed')).toBe(true)

    const goalId = created.goal.id
    const ms1 = created.goal.milestones[0]!

    // Add milestone, toggle done, delete another
    const addMsRes = await gw.app.request(`/api/goals/${goalId}/milestones`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Review with leadership' }),
    })
    expect(addMsRes.status).toBe(201)
    const msAdded = (await addMsRes.json()) as { milestone: { id: string }; goal: GoalView }
    expect(msAdded.goal.totalMilestones).toBe(3)

    const doneRes = await gw.app.request(`/api/goals/${goalId}/milestones/${ms1.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect(doneRes.status).toBe(200)
    const doneBody = (await doneRes.json()) as { goal: GoalView }
    expect(doneBody.goal.doneMilestones).toBe(1)

    const delMsRes = await gw.app.request(`/api/goals/${goalId}/milestones/${msAdded.milestone.id}`, {
      method: 'DELETE',
    })
    expect(delMsRes.status).toBe(200)
    expect(((await delMsRes.json()) as { goal: GoalView }).goal.totalMilestones).toBe(2)

    // Operator manual update
    const updRes = await gw.app.request(`/api/goals/${goalId}/updates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'Prioritize enterprise tiers first.' }),
    })
    expect(updRes.status).toBe(201)
    const updBody = (await updRes.json()) as { goal: GoalView }
    expect(updBody.goal.recentUpdates[0]?.summary).toBe('Prioritize enterprise tiers first.')
    expect(updBody.goal.recentUpdates[0]?.authorKind).toBe('operator')

    // Attach a routine, then delete the goal -> routine survives with goal_id cleared
    const routine = createRoutine(db, {
      botId: 'scout',
      name: 'Pricing Watch',
      cron: '0 9 * * 1',
      instructions: 'Check pricing pages',
      mode: 'watch',
    })
    const linkRes = await gw.app.request(`/api/routines/${routine.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goalId }),
    })
    expect(linkRes.status).toBe(200)
    expect(getRoutine(db, routine.id)?.goal_id).toBe(goalId)

    const delGoalRes = await gw.app.request(`/api/goals/${goalId}`, { method: 'DELETE' })
    expect(delGoalRes.status).toBe(200)
    expect(getRoutine(db, routine.id)?.goal_id).toBeNull()
    const afterList = (await (await gw.app.request('/api/goals')).json()) as GoalsSnapshot
    expect(afterList.goals).toHaveLength(0)
    expect(afterList.unlinkedRoutines.some((r) => r.id === routine.id)).toBe(true)
  })

  it('promotes an Idea into a Goal atomically and broadcasts both goals_changed and feed_changed', async () => {
    const db = seedDb()
    const events: GatewayEvent[] = []
    const hub = createHub()
    hub.add({ send: (raw) => events.push(JSON.parse(raw) as GatewayEvent) })
    const gw = createApp({ db, llm: quietLlm, hub, now: () => new Date(20_000) })

    const idea = createIdea(db, {
      title: 'Automate weekly release changelog',
      notes: 'Draft from merged PRs every Friday.',
      origin: 'proposal',
      tainted: true,
      assignedBotId: 'writer',
      now: 15_000,
    })

    const res = await gw.app.request('/api/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: idea.title,
        description: idea.notes,
        ownerBotId: 'writer',
        sourceIdeaId: idea.id,
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { goal: GoalView }
    expect(body.goal.sourceIdeaId).toBe(idea.id)

    const promoted = getIdea(db, idea.id)!
    expect(promoted.status).toBe('promoted')
    expect(promoted.promotedGoalId).toBe(body.goal.id)
    expect(events.map((e) => e.type)).toContain('goals_changed')
    expect(events.map((e) => e.type)).toContain('feed_changed')
  })

  it('auto-pauses linked routines when leaving active and skips scheduled runs for non-active goals unless forced', async () => {
    const db = seedDb()
    const removed: number[] = []
    const scheduler: Scheduler = {
      load: vi.fn(),
      add: vi.fn(),
      remove: (id) => removed.push(id),
      stopAll: vi.fn(),
      size: () => 0,
    }
    const gw = createApp({ db, llm: quietLlm, scheduler, now: () => new Date(30_000) })

    const createRes = await gw.app.request('/api/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Release v2', ownerBotId: 'chief' }),
    })
    const { goal } = (await createRes.json()) as { goal: GoalView }
    const routine = createRoutine(db, {
      botId: 'chief',
      name: 'Release check',
      cron: '0 9 * * *',
      instructions: 'Check release blockers',
      goalId: goal.id,
    })

    // Pausing goal pauses linked routines and removes from scheduler
    const pauseRes = await gw.app.request(`/api/goals/${goal.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    })
    expect(pauseRes.status).toBe(200)
    expect(getRoutine(db, routine.id)?.enabled).toBe(0)
    expect(removed).toContain(routine.id)

    // Even if routine is re-enabled manually while goal stays paused, non-forced runRoutine skips
    db.prepare('UPDATE routines SET enabled = 1 WHERE id = ?').run(routine.id)
    expect(await gw.runRoutine(routine)).toBe('skipped')

    // Explicit operator "Run now" (force: true) still executes
    expect(await gw.runRoutine(routine, { force: true })).toBe('ran')
  })

  it('runs goal check-in in owner DM with goal context and tags resulting actions with goal_id', async () => {
    const db = seedDb()
    let seenUserMsg = ''
    const llm: LLM = {
      async chat(messages) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')
        if (typeof lastUser?.content === 'string') seenUserMsg = lastUser.content
        return {
          content: null,
          toolCalls: [{ id: 'c1', name: 'update_goal_progress', args: { goal_id: goalId, note: 'Kickoff started.' } }],
          raw: { role: 'assistant', content: null, tool_calls: [] },
        }
      },
    }
    let step = 0
    const twoStepLlm: LLM = {
      async chat(messages, tools) {
        if (step++ === 0) return llm.chat(messages, tools)
        return { content: 'On it.', toolCalls: [], raw: { role: 'assistant', content: 'On it.' } }
      },
    }

    const gw = createApp({ db, llm: twoStepLlm, now: () => new Date(40_000) })
    const createRes = await gw.app.request('/api/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Launch Partner Portal',
        successCriteria: 'First 3 partners signed in.',
        ownerBotId: 'chief',
        memberBotIds: ['scout'],
        milestones: ['Draft onboarding guide'],
      }),
    })
    const { goal } = (await createRes.json()) as { goal: GoalView }
    const goalId = goal.id

    const checkinRes = await gw.app.request(`/api/goals/${goalId}/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'Focus on onboarding first.' }),
    })
    expect(checkinRes.status).toBe(202)
    const checkinBody = (await checkinRes.json()) as { botId: string; threadId: string }
    expect(checkinBody.botId).toBe('chief')
    expect(checkinBody.threadId).toBe('dm:chief')

    // Wait briefly for background turn
    await new Promise((r) => setTimeout(r, 40))

    expect(seenUserMsg).toContain('Launch Partner Portal')
    expect(seenUserMsg).toContain('Draft onboarding guide')
    expect(seenUserMsg).toContain('@scout')
    expect(seenUserMsg).toContain('Focus on onboarding first.')

    const actions = listGoalActions(db, goalId)
    expect(actions.some((a) => a.tool === 'update_goal_progress' && a.goal_id === goalId)).toBe(true)
  })
})
