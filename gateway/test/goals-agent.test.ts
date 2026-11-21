import { describe, expect, it } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { listMessages, openDb } from '../src/db.js'
import { createGoal, getGoalView, listMilestones, updateGoal } from '../src/goals/store.js'
import type { LLM, ToolCall } from '../src/llm.js'
import type { Pool } from '../src/pool.js'
import { goalsSection, MAX_GOALS_PROMPT_CHARS, type PromptGoal } from '../src/prompts.js'
import { createRoutine, listRoutines } from '../src/routines.js'
import { createApp } from '../src/server.js'

function scriptedLlm(steps: Array<{ content?: string; toolCalls?: ToolCall[] }>): {
  llm: LLM
  seenSystems: string[]
  seenTools: string[][]
  seenToolResults: string[]
} {
  let idx = 0
  const seenSystems: string[] = []
  const seenTools: string[][] = []
  const seenToolResults: string[] = []
  const llm: LLM = {
    async chat(messages, tools) {
      const sys = messages.find((m) => m.role === 'system')
      if (typeof sys?.content === 'string') seenSystems.push(sys.content)
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
  return { llm, seenSystems, seenTools, seenToolResults }
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
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('other', 'Other', 'Ops', '🛠', '', 3)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:chief', 'dm', 'chief', 'Chief', 1)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:scout', 'dm', 'scout', 'Scout', 2)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:other', 'dm', 'other', 'Other', 3)`).run()
  return db
}

describe('goals agent integration: prompt budget, tool authority split, taint & watch isolation', () => {
  it('enforces MAX_GOALS_PROMPT_CHARS hard cap and marks tainted notes', () => {
    const many: PromptGoal[] = Array.from({ length: 10 }, (_, i) => ({
      id: `goal-0000000${i}`,
      title: `Long Project Goal Number ${i} with Detailed Scope`,
      role: i % 2 === 0 ? 'owner' : 'member',
      targetDate: `2026-0${(i % 9) + 1}-15`,
      successCriteria: 'Deliver full report, automated checks, and executive sign-off across every region.',
      doneMilestones: 1,
      totalMilestones: 4,
      openMilestones: [
        { id: `ms-000000${i}1`, title: `Milestone A for goal ${i}`, ownerBotId: 'scout', dueDate: '2026-05-01' },
        { id: `ms-000000${i}2`, title: `Milestone B for goal ${i}` },
      ],
      recentNotes: [
        { summary: `Routine update ${i} from external page`, tainted: true },
      ],
    }))
    const section = goalsSection(many)
    expect(section.length).toBeLessThanOrEqual(MAX_GOALS_PROMPT_CHARS)
    expect(section).toContain('[outside-data]')
    expect(section).toContain('omitted for prompt budget')
  })

  it('injects active goals only for participating teammates and hides paused goals', async () => {
    const db = seedDb()
    const activeGoal = createGoal(db, {
      title: 'Enterprise Launch',
      successCriteria: 'SOC2 checklist done',
      ownerBotId: 'chief',
      memberBotIds: ['scout'],
      milestones: [{ title: 'Audit vendor list' }],
    })
    const pausedGoal = createGoal(db, {
      title: 'Paused Side Project',
      ownerBotId: 'scout',
    })
    updateGoal(db, pausedGoal.id, { status: 'paused' })

    const scoutRec = scriptedLlm([{ content: 'Ready.' }])
    const gwScout = createApp({ db, llm: scoutRec.llm, pool: makePool() })
    await gwScout.app.request('/api/threads/dm:scout/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Status?' }),
    })
    await new Promise((r) => setTimeout(r, 40))

    expect(scoutRec.seenSystems[0]).toContain(activeGoal.title)
    expect(scoutRec.seenSystems[0]).not.toContain('Paused Side Project')
    expect(scoutRec.seenTools[0]).toContain('manage_goal')
    expect(scoutRec.seenTools[0]).toContain('update_goal_progress')

    // Unassigned teammate sees neither the goal nor update_goal_progress
    const otherRec = scriptedLlm([{ content: 'No goals.' }])
    const gwOther = createApp({ db, llm: otherRec.llm, pool: makePool() })
    await gwOther.app.request('/api/threads/dm:other/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Status?' }),
    })
    await new Promise((r) => setTimeout(r, 40))

    expect(otherRec.seenSystems[0]).not.toContain(activeGoal.title)
    expect(otherRec.seenTools[0]).toContain('manage_goal')
    expect(otherRec.seenTools[0]).not.toContain('update_goal_progress')
  })

  it('allows manage_goal and goal-linked create_routine in operator turns and posts goal_updated chips', async () => {
    const db = seedDb()
    const rec = scriptedLlm([
      {
        toolCalls: [
          {
            id: 'g1',
            name: 'manage_goal',
            args: {
              action: 'create',
              title: 'Ship API v3',
              success_criteria: 'Zero breaking changes in beta',
              member_bot_ids: ['scout'],
              milestones: ['Write migration guide', 'Run beta canary'],
            },
          },
        ],
      },
      { content: 'Goal created.' },
    ])
    const gw = createApp({ db, llm: rec.llm, pool: makePool(), now: () => new Date(10_000) })
    await gw.app.request('/api/threads/dm:chief/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Create a goal to ship API v3.' }),
    })
    await new Promise((r) => setTimeout(r, 50))

    const messages = listMessages(db, 'dm:chief')
    const chip = messages.find((m) => m.kind === 'goal_updated')
    expect(chip).toBeDefined()
    const payload = chip!.payload as { goalId: string; goalTitle: string; diff: string }
    expect(payload.goalTitle).toBe('Ship API v3')
    expect(payload.diff).toContain('Write migration guide')
    expect(listMilestones(db, payload.goalId)).toHaveLength(2)

    // Operator turn can also link a routine to that active goal
    const rec2 = scriptedLlm([
      {
        toolCalls: [
          {
            id: 'r1',
            name: 'create_routine',
            args: {
              name: 'Canary Check',
              cron: '0 9 * * *',
              instructions: 'Verify canary metrics',
              goal_id: payload.goalId,
            },
          },
        ],
      },
      { content: 'Routine scheduled.' },
    ])
    const gw2 = createApp({ db, llm: rec2.llm, pool: makePool(), now: () => new Date(20_000) })
    await gw2.app.request('/api/threads/dm:chief/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Add a daily canary check to that goal.' }),
    })
    await new Promise((r) => setTimeout(r, 50))

    const routines = listRoutines(db, 'chief')
    expect(routines[0]?.goal_id).toBe(payload.goalId)
  })

  it('blocks manage_goal in routine turns, taints update_goal_progress with a 2-call cap, and hides both in watch turns', async () => {
    const db = seedDb()
    const goal = createGoal(db, {
      title: 'Monitor Churn',
      ownerBotId: 'chief',
      memberBotIds: ['scout'],
      milestones: [{ title: 'Review top 10 accounts' }],
    })
    const unassignedGoal = createGoal(db, {
      title: 'Secret Chief Goal',
      ownerBotId: 'chief',
    })

    // 1. Act routine turn: manage_goal is absent and refused; update_goal_progress works up to 2 times and is tainted
    const actRec = scriptedLlm([
      {
        toolCalls: [
          { id: 'bad-def', name: 'manage_goal', args: { action: 'update', goal_id: goal.id, title: 'Hijacked!' } },
          { id: 'bad-unassigned', name: 'update_goal_progress', args: { goal_id: unassignedGoal.id, note: 'Sneaking in' } },
          { id: 'ok1', name: 'update_goal_progress', args: { goal_id: goal.id, note: 'Checked 5 accounts.' } },
          { id: 'ok2', name: 'update_goal_progress', args: { goal_id: goal.id, note: 'Flagged 1 renewal risk.' } },
          { id: 'over3', name: 'update_goal_progress', args: { goal_id: goal.id, note: 'Third note should be blocked.' } },
        ],
      },
      { content: 'Routine complete.' },
    ])
    const gwAct = createApp({ db, llm: actRec.llm, pool: makePool(), now: () => new Date(30_000) })
    const actRoutine = createRoutine(db, {
      botId: 'scout',
      name: 'Daily Churn Audit',
      cron: '0 9 * * *',
      instructions: 'Audit churn signals',
      mode: 'act',
      goalId: goal.id,
    })
    await gwAct.runRoutine(actRoutine)

    expect(actRec.seenTools[0]).not.toContain('manage_goal')
    expect(actRec.seenTools[0]).toContain('update_goal_progress')
    expect(actRec.seenToolResults.some((t) => t.includes('manage_goal only works in a turn your operator started'))).toBe(true)
    expect(actRec.seenToolResults.some((t) => t.includes('not assigned to goal'))).toBe(true)
    expect(actRec.seenToolResults.some((t) => t.includes('already logged 2 goal progress notes'))).toBe(true)

    const view = getGoalView(db, goal.id)!
    expect(view.title).toBe('Monitor Churn') // unchanged!
    const botNotes = view.recentUpdates.filter((u) => u.kind === 'note' && u.botId === 'scout')
    expect(botNotes).toHaveLength(2)
    expect(botNotes.every((u) => u.tainted)).toBe(true)

    // Visible tainted goal_updated chips landed in scout's thread
    const scoutMsgs = listMessages(db, 'dm:scout').filter((m) => m.kind === 'goal_updated')
    expect(scoutMsgs).toHaveLength(2)
    expect((scoutMsgs[0]!.payload as { tainted?: boolean }).tainted).toBe(true)

    // 2. Watch routine turn: NEITHER manage_goal NOR update_goal_progress is exposed, and calling either is refused
    const watchRec = scriptedLlm([
      {
        toolCalls: [
          { id: 'w1', name: 'update_goal_progress', args: { goal_id: goal.id, note: 'Should be blocked in watch' } },
        ],
      },
      { content: 'Nothing new.' },
    ])
    const gwWatch = createApp({ db, llm: watchRec.llm, pool: makePool(), now: () => new Date(40_000) })
    const watchRoutine = createRoutine(db, {
      botId: 'scout',
      name: 'Read-only Watch',
      cron: '*/30 * * * *',
      instructions: 'Look only',
      mode: 'watch',
      goalId: goal.id,
    })
    await gwWatch.runRoutine(watchRoutine)

    expect(watchRec.seenTools[0]).not.toContain('manage_goal')
    expect(watchRec.seenTools[0]).not.toContain('update_goal_progress')
    expect(watchRec.seenToolResults.some((t) => t.includes('not available in a watch routine'))).toBe(true)
  })
})
