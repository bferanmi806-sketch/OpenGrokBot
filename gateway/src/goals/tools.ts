import type { RuleBlock } from '../agent.js'
import type { BotRow, Db } from '../db.js'
import type { Hub } from '../hub.js'
import type { ToolDef } from '../llm.js'
import { pauseGoalRoutines } from '../routines.js'
import type { Scheduler } from '../scheduler.js'
import {
  addGoalUpdate,
  addMilestone,
  createGoal,
  deleteMilestone,
  getGoal,
  getMilestone,
  isBotOnGoal,
  isGoalId,
  isIsoDate,
  isMilestoneId,
  updateGoal,
  updateMilestone,
} from './store.js'
import { GOAL_STATUSES, type GoalStatus, type GoalUpdatedPayload } from './types.js'

export const MANAGE_GOAL_TOOL_NAME = 'manage_goal'
export const UPDATE_GOAL_PROGRESS_TOOL_NAME = 'update_goal_progress'
export const MAX_GOAL_PROGRESS_PER_TURN = 2

export const MANAGE_GOAL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: MANAGE_GOAL_TOOL_NAME,
    description:
      'Create or edit a long-term goal or its milestones when your operator explicitly asks. Only available in turns started by your operator; every change posts a visible audit chip in the thread.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'add_milestone', 'complete_milestone', 'reopen_milestone', 'remove_milestone'],
          description: 'The goal management action to perform.',
        },
        goal_id: {
          type: 'string',
          description: 'Existing goal id (e.g. "goal-a1b2c3d4"). Required for every action except "create".',
        },
        title: { type: 'string', description: 'Goal title (1-120 chars), for create or update.' },
        description: { type: 'string', description: 'Goal background/context (<=2000 chars).' },
        success_criteria: { type: 'string', description: 'What "done" looks like for this goal (<=1000 chars).' },
        target_date: { type: 'string', description: 'Optional target date in YYYY-MM-DD format (or empty string to clear).' },
        status: {
          type: 'string',
          enum: [...GOAL_STATUSES],
          description: 'Goal status for update: active, paused, done, or archived.',
        },
        owner_bot_id: { type: 'string', description: 'Teammate id owning the goal (defaults to you on create).' },
        member_bot_ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 16,
          description: 'Optional teammate ids collaborating on this goal.',
        },
        milestones: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 12,
          description: 'Optional initial milestone titles when creating a goal.',
        },
        milestone_id: {
          type: 'string',
          description: 'Milestone id (e.g. "ms-1a2b3c4d") for complete_milestone, reopen_milestone, or remove_milestone.',
        },
        milestone_title: { type: 'string', description: 'Milestone title (1-140 chars) for add_milestone.' },
        due_date: { type: 'string', description: 'Optional milestone due date in YYYY-MM-DD format.' },
      },
      required: ['action'],
    },
  },
}

export const UPDATE_GOAL_PROGRESS_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: UPDATE_GOAL_PROGRESS_TOOL_NAME,
    description:
      'Append a concise progress note to an active goal you participate in (at most 2 per turn). Cannot change goal definitions, success criteria, or milestone completion; ask your operator for those.',
    parameters: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'Active goal id you own or participate in (e.g. "goal-a1b2c3d4").' },
        note: { type: 'string', description: 'Plain progress update in 1-400 characters.' },
      },
      required: ['goal_id', 'note'],
    },
  },
}

export type GoalToolResult = {
  ok: boolean
  text: string
  goalId?: string
  chip?: GoalUpdatedPayload
}

const botExists = (db: Db, id: string): boolean =>
  Boolean(db.prepare('SELECT id FROM bots WHERE id = ?').get(id) as BotRow | undefined)

export function runManageGoalCall(input: {
  db: Db
  hub: Hub
  scheduler?: Scheduler
  botId: string
  threadId: string
  args: Record<string, unknown>
  now?: number
}): GoalToolResult {
  const { db, hub, botId, threadId, args } = input
  const at = input.now ?? Date.now()
  const action = typeof args.action === 'string' ? args.action.trim() : ''

  if (action === 'create') {
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title || title.length > 120) {
      return { ok: false, text: 'manage_goal(create) needs a "title" of 1 to 120 characters.' }
    }
    const ownerBotId = typeof args.owner_bot_id === 'string' && args.owner_bot_id.trim()
      ? args.owner_bot_id.trim()
      : botId
    if (!botExists(db, ownerBotId)) {
      return { ok: false, text: `Unknown owner teammate "${ownerBotId}".` }
    }
    const rawMembers = Array.isArray(args.member_bot_ids)
      ? args.member_bot_ids.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
      : []
    const invalidMember = rawMembers.find((id) => !botExists(db, id))
    if (invalidMember) {
      return { ok: false, text: `Unknown member teammate "${invalidMember}".` }
    }
    const targetDateRaw = typeof args.target_date === 'string' ? args.target_date.trim() : ''
    if (targetDateRaw && !isIsoDate(targetDateRaw)) {
      return { ok: false, text: 'target_date must be a valid YYYY-MM-DD date.' }
    }
    const milestones = Array.isArray(args.milestones)
      ? args.milestones
        .filter((v): v is string => typeof v === 'string')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12)
        .map((t) => ({ title: t }))
      : []

    const goal = createGoal(db, {
      title,
      description: typeof args.description === 'string' ? args.description : '',
      successCriteria: typeof args.success_criteria === 'string' ? args.success_criteria : '',
      ownerBotId,
      memberBotIds: rawMembers,
      targetDate: targetDateRaw || null,
      milestones,
      authorKind: 'bot',
      authorBotId: botId,
      threadId,
      now: at,
    })
    hub.broadcast({ type: 'goals_changed' })
    const diff = [
      `+ Goal: ${goal.title}`,
      ...(goal.successCriteria ? [`+ Criteria: ${goal.successCriteria.slice(0, 160)}`] : []),
      ...milestones.map((m) => `+ [ ] ${m.title}`),
    ].join('\n')
    return {
      ok: true,
      goalId: goal.id,
      text: `Created goal "${goal.title}" (${goal.id}) with ${milestones.length} milestone${milestones.length === 1 ? '' : 's'}.`,
      chip: {
        goalId: goal.id,
        goalTitle: goal.title,
        kind: 'definition',
        summary: `Created goal "${goal.title}"`,
        diff,
        by: 'bot',
      },
    }
  }

  const goalId = typeof args.goal_id === 'string' ? args.goal_id.trim() : ''
  if (!isGoalId(goalId)) {
    return { ok: false, text: `manage_goal(${action || 'unknown'}) needs a valid "goal_id" (e.g. "goal-a1b2c3d4").` }
  }
  const existing = getGoal(db, goalId)
  if (!existing) {
    return { ok: false, text: `No goal found with id "${goalId}".` }
  }

  if (action === 'update') {
    const patch: Parameters<typeof updateGoal>[2] = { now: at }
    const diffs: string[] = []
    if (args.title !== undefined) {
      if (typeof args.title !== 'string' || !args.title.trim() || args.title.trim().length > 120) {
        return { ok: false, text: 'title must be 1 to 120 characters.' }
      }
      patch.title = args.title.trim()
      if (patch.title !== existing.title) diffs.push(`~ Title: ${patch.title}`)
    }
    if (args.description !== undefined) {
      if (typeof args.description !== 'string') return { ok: false, text: 'description must be a string.' }
      patch.description = args.description
      if (patch.description.trim() !== existing.description) diffs.push('~ Updated description')
    }
    if (args.success_criteria !== undefined) {
      if (typeof args.success_criteria !== 'string') return { ok: false, text: 'success_criteria must be a string.' }
      patch.successCriteria = args.success_criteria
      if (patch.successCriteria.trim() !== existing.successCriteria) {
        diffs.push(`~ Criteria: ${patch.successCriteria.trim().slice(0, 160) || '(cleared)'}`)
      }
    }
    if (args.target_date !== undefined) {
      if (args.target_date === null || args.target_date === '') {
        patch.targetDate = null
        if (existing.targetDate !== null) diffs.push('- Target date cleared')
      } else if (typeof args.target_date === 'string' && isIsoDate(args.target_date)) {
        patch.targetDate = args.target_date.trim()
        if (patch.targetDate !== existing.targetDate) diffs.push(`~ Target date: ${patch.targetDate}`)
      } else {
        return { ok: false, text: 'target_date must be YYYY-MM-DD or empty string.' }
      }
    }
    if (args.status !== undefined) {
      if (typeof args.status !== 'string' || !(GOAL_STATUSES as readonly string[]).includes(args.status)) {
        return { ok: false, text: `status must be one of: ${GOAL_STATUSES.join(', ')}.` }
      }
      patch.status = args.status as GoalStatus
      if (patch.status !== existing.status) diffs.push(`~ Status: ${existing.status} → ${patch.status}`)
    }
    if (args.owner_bot_id !== undefined) {
      if (typeof args.owner_bot_id !== 'string' || !botExists(db, args.owner_bot_id.trim())) {
        return { ok: false, text: 'owner_bot_id must be an existing teammate id.' }
      }
      patch.ownerBotId = args.owner_bot_id.trim()
      if (patch.ownerBotId !== existing.ownerBotId) diffs.push(`~ Owner: @${patch.ownerBotId}`)
    }
    if (args.member_bot_ids !== undefined) {
      if (!Array.isArray(args.member_bot_ids)) return { ok: false, text: 'member_bot_ids must be an array.' }
      const members = args.member_bot_ids.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
      const invalid = members.find((id) => !botExists(db, id))
      if (invalid) return { ok: false, text: `Unknown member teammate "${invalid}".` }
      patch.memberBotIds = members
      diffs.push(`~ Members: ${members.length ? members.map((m) => `@${m}`).join(', ') : '(none)'}`)
    }
    if (!diffs.length) {
      return { ok: true, goalId: existing.id, text: `Goal "${existing.title}" is already up to date.` }
    }
    const updated = updateGoal(db, existing.id, patch)!
    if (existing.status === 'active' && updated.status !== 'active') {
      const pausedIds = pauseGoalRoutines(db, updated.id)
      for (const rid of pausedIds) input.scheduler?.remove(rid)
    }
    const kind = patch.status && patch.status !== existing.status && diffs.length === 1 ? 'status' : 'definition'
    const summary = diffs[0]!.replace(/^[+~-]\s*/, '')
    const diff = diffs.join('\n')
    addGoalUpdate(db, {
      goalId: updated.id,
      authorKind: 'bot',
      botId,
      kind,
      summary,
      diff,
      threadId,
      now: at,
    })
    hub.broadcast({ type: 'goals_changed' })
    return {
      ok: true,
      goalId: updated.id,
      text: `Updated goal "${updated.title}" (${updated.id}).`,
      chip: { goalId: updated.id, goalTitle: updated.title, kind, summary, diff, by: 'bot' },
    }
  }

  if (action === 'add_milestone') {
    const mTitle = typeof args.milestone_title === 'string'
      ? args.milestone_title.trim()
      : (typeof args.title === 'string' ? args.title.trim() : '')
    if (!mTitle || mTitle.length > 140) {
      return { ok: false, text: 'add_milestone needs "milestone_title" of 1 to 140 characters.' }
    }
    const owner = typeof args.owner_bot_id === 'string' && args.owner_bot_id.trim() ? args.owner_bot_id.trim() : null
    if (owner && !botExists(db, owner)) return { ok: false, text: `Unknown teammate "${owner}".` }
    const due = typeof args.due_date === 'string' ? args.due_date.trim() : ''
    if (due && !isIsoDate(due)) return { ok: false, text: 'due_date must be YYYY-MM-DD.' }
    const ms = addMilestone(db, { goalId: existing.id, title: mTitle, ownerBotId: owner, dueDate: due || null, now: at })!
    const diff = `+ [ ] ${ms.title}`
    addGoalUpdate(db, {
      goalId: existing.id,
      authorKind: 'bot',
      botId,
      kind: 'milestone',
      summary: `Added milestone "${ms.title}"`,
      diff,
      threadId,
      now: at,
    })
    hub.broadcast({ type: 'goals_changed' })
    return {
      ok: true,
      goalId: existing.id,
      text: `Added milestone "${ms.title}" (${ms.id}) to "${existing.title}".`,
      chip: { goalId: existing.id, goalTitle: existing.title, kind: 'milestone', summary: `Added milestone "${ms.title}"`, diff, by: 'bot' },
    }
  }

  if (action === 'complete_milestone' || action === 'reopen_milestone' || action === 'remove_milestone') {
    const msId = typeof args.milestone_id === 'string' ? args.milestone_id.trim() : ''
    if (!isMilestoneId(msId)) {
      return { ok: false, text: `${action} needs a valid "milestone_id" (e.g. "ms-1a2b3c4d").` }
    }
    const ms = getMilestone(db, msId)
    if (!ms || ms.goalId !== existing.id) {
      return { ok: false, text: `Milestone "${msId}" does not belong to goal "${existing.id}".` }
    }
    if (action === 'remove_milestone') {
      deleteMilestone(db, existing.id, ms.id, at)
      const diff = `- ${ms.title}`
      addGoalUpdate(db, {
        goalId: existing.id,
        authorKind: 'bot',
        botId,
        kind: 'milestone',
        summary: `Removed milestone "${ms.title}"`,
        diff,
        threadId,
        now: at,
      })
      hub.broadcast({ type: 'goals_changed' })
      return {
        ok: true,
        goalId: existing.id,
        text: `Removed milestone "${ms.title}" from "${existing.title}".`,
        chip: { goalId: existing.id, goalTitle: existing.title, kind: 'milestone', summary: `Removed milestone "${ms.title}"`, diff, by: 'bot' },
      }
    }
    const nextStatus = action === 'complete_milestone' ? 'done' : 'open'
    updateMilestone(db, ms.id, { status: nextStatus, now: at })
    const diff = nextStatus === 'done' ? `✓ [x] ${ms.title}` : `~ [ ] ${ms.title}`
    const summary = nextStatus === 'done' ? `Completed milestone "${ms.title}"` : `Reopened milestone "${ms.title}"`
    addGoalUpdate(db, {
      goalId: existing.id,
      authorKind: 'bot',
      botId,
      kind: 'milestone',
      summary,
      diff,
      threadId,
      now: at,
    })
    hub.broadcast({ type: 'goals_changed' })
    return {
      ok: true,
      goalId: existing.id,
      text: `${summary} on "${existing.title}".`,
      chip: { goalId: existing.id, goalTitle: existing.title, kind: 'milestone', summary, diff, by: 'bot' },
    }
  }

  return {
    ok: false,
    text: 'manage_goal action must be one of: create, update, add_milestone, complete_milestone, reopen_milestone, remove_milestone.',
  }
}

export function runUpdateGoalProgressCall(input: {
  db: Db
  hub: Hub
  botId: string
  threadId: string
  args: Record<string, unknown>
  ruleBlock: RuleBlock | null
  now?: number
}): GoalToolResult {
  const { db, hub, botId, threadId, args, ruleBlock } = input
  const at = input.now ?? Date.now()
  const goalId = typeof args.goal_id === 'string' ? args.goal_id.trim() : ''
  if (!isGoalId(goalId)) {
    return { ok: false, text: 'update_goal_progress needs a valid "goal_id" (e.g. "goal-a1b2c3d4").' }
  }
  const goal = getGoal(db, goalId)
  if (!goal) {
    return { ok: false, text: `No goal found with id "${goalId}".` }
  }
  if (goal.status !== 'active') {
    return { ok: false, text: `Goal "${goal.title}" is ${goal.status}; progress notes can only be logged on active goals.` }
  }
  if (!isBotOnGoal(goal, botId)) {
    return { ok: false, text: `You are not assigned to goal "${goal.title}" (${goal.id}).` }
  }
  const note = typeof args.note === 'string' ? args.note.trim() : ''
  if (!note || note.length > 400) {
    return { ok: false, text: 'update_goal_progress needs a "note" of 1 to 400 characters.' }
  }

  // 非操作者发起或上下文已含外部数据时，强标 tainted = true（模型无法清除）
  const tainted = ruleBlock !== null
  const diff = `+ ${note}`
  addGoalUpdate(db, {
    goalId: goal.id,
    authorKind: 'bot',
    botId,
    kind: 'note',
    summary: note,
    diff,
    tainted,
    threadId,
    now: at,
  })
  hub.broadcast({ type: 'goals_changed' })
  return {
    ok: true,
    goalId: goal.id,
    text: `Logged progress on "${goal.title}" (${goal.id}).`,
    chip: {
      goalId: goal.id,
      goalTitle: goal.title,
      kind: 'note',
      summary: note,
      diff,
      ...(tainted ? { tainted: true } : {}),
      by: 'bot',
    },
  }
}
