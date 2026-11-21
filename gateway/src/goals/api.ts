import type { Hono } from 'hono'
import type { BotRow, Db } from '../db.js'
import { getIdea, isIdeaId } from '../feed/store.js'
import type { Hub } from '../hub.js'
import { pauseGoalRoutines } from '../routines.js'
import type { Scheduler } from '../scheduler.js'
import {
  activeGoalsCount,
  addGoalUpdate,
  addMilestone,
  createGoal,
  deleteGoal,
  deleteMilestone,
  getGoal,
  getGoalView,
  getMilestone,
  isGoalId,
  isIsoDate,
  isMilestoneId,
  listGoalViews,
  listUnlinkedRoutines,
  updateGoal,
  updateMilestone,
} from './store.js'
import {
  GOAL_STATUSES,
  MILESTONE_STATUSES,
  type GoalStatus,
  type GoalView,
  type GoalsSnapshot,
  type MilestoneStatus,
} from './types.js'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export type GoalsApiDeps = {
  db: Db
  hub: Hub
  chiefId: string
  scheduler?: Scheduler
  now?: () => number
  startCheckin: (bot: BotRow, goal: GoalView, note?: string) => { threadId: string }
}

export function mountGoals(app: Hono, deps: GoalsApiDeps): { snapshot: () => GoalsSnapshot } {
  const { db, hub, chiefId, scheduler } = deps
  const now = deps.now ?? (() => Date.now())

  const botById = (id: string): BotRow | undefined =>
    db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined

  const defaultBot = (): BotRow | undefined =>
    botById(chiefId) ?? (db.prepare('SELECT * FROM bots ORDER BY created_at ASC, id ASC LIMIT 1').get() as BotRow | undefined)

  const snapshot = (opts?: { status?: GoalStatus | 'all'; includeArchived?: boolean }): GoalsSnapshot => ({
    goals: listGoalViews(db, {
      status: opts?.status ?? 'all',
      includeArchived: opts?.includeArchived ?? true,
    }),
    activeCount: activeGoalsCount(db),
    unlinkedRoutines: listUnlinkedRoutines(db),
  })

  app.get('/api/goals', (c) => {
    const statusRaw = c.req.query('status')
    const includeArchived = c.req.query('includeArchived') !== '0'
    const status: GoalStatus | 'all' =
      statusRaw && (GOAL_STATUSES as readonly string[]).includes(statusRaw)
        ? (statusRaw as GoalStatus)
        : 'all'
    return c.json(snapshot({ status, includeArchived }))
  })

  app.get('/api/goals/:id', (c) => {
    const id = c.req.param('id')
    if (!isGoalId(id)) return c.json({ error: 'invalid goal id' }, 400)
    const goal = getGoalView(db, id)
    if (!goal) return c.json({ error: 'unknown goal' }, 404)
    return c.json({ goal })
  })

  app.post('/api/goals', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title || title.length > 120) return c.json({ error: 'title must be 1 to 120 characters' }, 400)
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 2000) : ''
    const successCriteria = typeof body.successCriteria === 'string' ? body.successCriteria.trim().slice(0, 1000) : ''

    const requestedOwner = typeof body.ownerBotId === 'string' && body.ownerBotId.trim()
      ? body.ownerBotId.trim()
      : (defaultBot()?.id ?? '')
    if (!requestedOwner || !botById(requestedOwner)) {
      return c.json({ error: 'unknown owner teammate' }, 400)
    }

    let memberBotIds: string[] = []
    if (body.memberBotIds !== undefined) {
      if (!Array.isArray(body.memberBotIds)) return c.json({ error: 'memberBotIds must be an array' }, 400)
      memberBotIds = body.memberBotIds.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
      const invalidMember = memberBotIds.find((id) => !botById(id))
      if (invalidMember) return c.json({ error: `unknown member teammate: ${invalidMember}` }, 400)
    }

    let targetDate: string | null = null
    if (body.targetDate !== undefined && body.targetDate !== null && body.targetDate !== '') {
      if (typeof body.targetDate !== 'string' || !isIsoDate(body.targetDate)) {
        return c.json({ error: 'targetDate must be a valid YYYY-MM-DD date' }, 400)
      }
      targetDate = body.targetDate.trim()
    }

    let sourceIdeaId: string | null = null
    if (body.sourceIdeaId !== undefined && body.sourceIdeaId !== null && body.sourceIdeaId !== '') {
      if (typeof body.sourceIdeaId !== 'string' || !isIdeaId(body.sourceIdeaId)) {
        return c.json({ error: 'invalid sourceIdeaId' }, 400)
      }
      if (!getIdea(db, body.sourceIdeaId)) return c.json({ error: 'unknown source idea' }, 404)
      sourceIdeaId = body.sourceIdeaId
    }

    const milestones: Array<{ title: string; ownerBotId?: string | null; dueDate?: string | null }> = []
    if (body.milestones !== undefined) {
      if (!Array.isArray(body.milestones)) return c.json({ error: 'milestones must be an array' }, 400)
      for (const raw of body.milestones.slice(0, 20)) {
        if (typeof raw === 'string') {
          if (raw.trim()) milestones.push({ title: raw.trim().slice(0, 140) })
          continue
        }
        if (isObject(raw) && typeof raw.title === 'string' && raw.title.trim()) {
          const mOwner = typeof raw.ownerBotId === 'string' && raw.ownerBotId.trim() ? raw.ownerBotId.trim() : null
          if (mOwner && !botById(mOwner)) return c.json({ error: `unknown milestone owner: ${mOwner}` }, 400)
          const mDue = typeof raw.dueDate === 'string' && raw.dueDate.trim() ? raw.dueDate.trim() : null
          if (mDue && !isIsoDate(mDue)) return c.json({ error: 'milestone dueDate must be YYYY-MM-DD' }, 400)
          milestones.push({ title: raw.title.trim().slice(0, 140), ownerBotId: mOwner, dueDate: mDue })
        }
      }
    }

    const goal = createGoal(db, {
      title,
      description,
      successCriteria,
      ownerBotId: requestedOwner,
      memberBotIds,
      targetDate,
      sourceIdeaId,
      milestones,
      authorKind: 'operator',
      now: now(),
    })
    hub.broadcast({ type: 'goals_changed' })
    if (sourceIdeaId) hub.broadcast({ type: 'feed_changed' })
    return c.json({ goal: getGoalView(db, goal.id)!, snapshot: snapshot() }, 201)
  })

  app.patch('/api/goals/:id', async (c) => {
    const id = c.req.param('id')
    if (!isGoalId(id)) return c.json({ error: 'invalid goal id' }, 400)
    const existing = getGoal(db, id)
    if (!existing) return c.json({ error: 'unknown goal' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)

    const at = now()
    const patch: Parameters<typeof updateGoal>[2] = { now: at }
    const diffs: string[] = []

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) {
        return c.json({ error: 'title must be 1 to 120 characters' }, 400)
      }
      patch.title = body.title.trim()
      if (patch.title !== existing.title) diffs.push(`~ Title: ${patch.title}`)
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string') return c.json({ error: 'description must be a string' }, 400)
      patch.description = body.description
      if (patch.description.trim() !== existing.description) diffs.push('~ Updated description')
    }
    if (body.successCriteria !== undefined) {
      if (typeof body.successCriteria !== 'string') return c.json({ error: 'successCriteria must be a string' }, 400)
      patch.successCriteria = body.successCriteria
      if (patch.successCriteria.trim() !== existing.successCriteria) {
        diffs.push(`~ Criteria: ${patch.successCriteria.trim().slice(0, 160) || '(cleared)'}`)
      }
    }
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !(GOAL_STATUSES as readonly string[]).includes(body.status)) {
        return c.json({ error: `status must be one of: ${GOAL_STATUSES.join(', ')}` }, 400)
      }
      patch.status = body.status as GoalStatus
      if (patch.status !== existing.status) diffs.push(`~ Status: ${existing.status} → ${patch.status}`)
    }
    if (body.ownerBotId !== undefined) {
      if (typeof body.ownerBotId !== 'string' || !botById(body.ownerBotId.trim())) {
        return c.json({ error: 'unknown owner teammate' }, 400)
      }
      patch.ownerBotId = body.ownerBotId.trim()
      if (patch.ownerBotId !== existing.ownerBotId) diffs.push(`~ Owner: @${patch.ownerBotId}`)
    }
    if (body.memberBotIds !== undefined) {
      if (!Array.isArray(body.memberBotIds)) return c.json({ error: 'memberBotIds must be an array' }, 400)
      const members = body.memberBotIds.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
      const invalid = members.find((mid) => !botById(mid))
      if (invalid) return c.json({ error: `unknown member teammate: ${invalid}` }, 400)
      patch.memberBotIds = members
      const nextOwner = patch.ownerBotId ?? existing.ownerBotId
      const normNext = [...new Set(members.filter((m) => m !== nextOwner))].sort().join(',')
      const normPrev = [...existing.memberBotIds].sort().join(',')
      if (normNext !== normPrev) diffs.push('~ Members updated')
    }
    if (body.targetDate !== undefined) {
      if (body.targetDate === null || body.targetDate === '') {
        patch.targetDate = null
        if (existing.targetDate !== null) diffs.push('- Target date cleared')
      } else if (typeof body.targetDate === 'string' && isIsoDate(body.targetDate)) {
        patch.targetDate = body.targetDate.trim()
        if (patch.targetDate !== existing.targetDate) diffs.push(`~ Target date: ${patch.targetDate}`)
      } else {
        return c.json({ error: 'targetDate must be a valid YYYY-MM-DD date or null' }, 400)
      }
    }

    const updated = updateGoal(db, id, patch)!
    // 离开 active 状态时默认同步暂停挂在该目标下的例行任务，避免静默消耗 token
    const pauseRoutines = body.pauseRoutines !== false
    if (existing.status === 'active' && updated.status !== 'active' && pauseRoutines) {
      const pausedIds = pauseGoalRoutines(db, updated.id)
      for (const rid of pausedIds) scheduler?.remove(rid)
    }

    if (diffs.length > 0) {
      const kind = patch.status && patch.status !== existing.status && diffs.length === 1 ? 'status' : 'definition'
      addGoalUpdate(db, {
        goalId: updated.id,
        authorKind: 'operator',
        kind,
        summary: diffs[0]!.replace(/^[+~-]\s*/, ''),
        diff: diffs.join('\n'),
        now: at,
      })
    }

    hub.broadcast({ type: 'goals_changed' })
    return c.json({ goal: getGoalView(db, updated.id)!, snapshot: snapshot() })
  })

  app.delete('/api/goals/:id', (c) => {
    const id = c.req.param('id')
    if (!isGoalId(id)) return c.json({ error: 'invalid goal id' }, 400)
    const hadIdea = getGoal(db, id)?.sourceIdeaId
    const hadSpaces = Boolean(db.prepare('SELECT 1 FROM spaces WHERE goal_id = ? LIMIT 1').get(id))
    if (!deleteGoal(db, id)) return c.json({ error: 'unknown goal' }, 404)
    hub.broadcast({ type: 'goals_changed' })
    if (hadIdea) hub.broadcast({ type: 'feed_changed' })
    if (hadSpaces) hub.broadcast({ type: 'spaces_changed' })
    return c.json({ ok: true, snapshot: snapshot() })
  })

  app.post('/api/goals/:id/milestones', async (c) => {
    const id = c.req.param('id')
    if (!isGoalId(id)) return c.json({ error: 'invalid goal id' }, 400)
    if (!getGoal(db, id)) return c.json({ error: 'unknown goal' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title || title.length > 140) return c.json({ error: 'title must be 1 to 140 characters' }, 400)

    let ownerBotId: string | null = null
    if (body.ownerBotId !== undefined && body.ownerBotId !== null && body.ownerBotId !== '') {
      if (typeof body.ownerBotId !== 'string' || !botById(body.ownerBotId.trim())) {
        return c.json({ error: 'unknown milestone owner' }, 400)
      }
      ownerBotId = body.ownerBotId.trim()
    }
    let dueDate: string | null = null
    if (body.dueDate !== undefined && body.dueDate !== null && body.dueDate !== '') {
      if (typeof body.dueDate !== 'string' || !isIsoDate(body.dueDate)) {
        return c.json({ error: 'dueDate must be a valid YYYY-MM-DD date' }, 400)
      }
      dueDate = body.dueDate.trim()
    }

    const at = now()
    const milestone = addMilestone(db, { goalId: id, title, ownerBotId, dueDate, now: at })!
    addGoalUpdate(db, {
      goalId: id,
      authorKind: 'operator',
      kind: 'milestone',
      summary: `Added milestone "${milestone.title}"`,
      diff: `+ [ ] ${milestone.title}`,
      now: at,
    })
    hub.broadcast({ type: 'goals_changed' })
    return c.json({ milestone, goal: getGoalView(db, id)!, snapshot: snapshot() }, 201)
  })

  app.patch('/api/goals/:id/milestones/:milestoneId', async (c) => {
    const id = c.req.param('id')
    const milestoneId = c.req.param('milestoneId')
    if (!isGoalId(id) || !isMilestoneId(milestoneId)) return c.json({ error: 'invalid id' }, 400)
    const existing = getMilestone(db, milestoneId)
    if (!existing || existing.goalId !== id) return c.json({ error: 'unknown milestone' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)

    const at = now()
    const patch: Parameters<typeof updateMilestone>[2] = { now: at }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 140) {
        return c.json({ error: 'title must be 1 to 140 characters' }, 400)
      }
      patch.title = body.title.trim()
    }
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !(MILESTONE_STATUSES as readonly string[]).includes(body.status)) {
        return c.json({ error: `status must be one of: ${MILESTONE_STATUSES.join(', ')}` }, 400)
      }
      patch.status = body.status as MilestoneStatus
    }
    if (body.ownerBotId !== undefined) {
      if (body.ownerBotId === null || body.ownerBotId === '') {
        patch.ownerBotId = null
      } else if (typeof body.ownerBotId === 'string' && botById(body.ownerBotId.trim())) {
        patch.ownerBotId = body.ownerBotId.trim()
      } else {
        return c.json({ error: 'unknown milestone owner' }, 400)
      }
    }
    if (body.dueDate !== undefined) {
      if (body.dueDate === null || body.dueDate === '') {
        patch.dueDate = null
      } else if (typeof body.dueDate === 'string' && isIsoDate(body.dueDate)) {
        patch.dueDate = body.dueDate.trim()
      } else {
        return c.json({ error: 'dueDate must be a valid YYYY-MM-DD date or null' }, 400)
      }
    }
    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== 'number' || !Number.isFinite(body.sortOrder)) {
        return c.json({ error: 'sortOrder must be a number' }, 400)
      }
      patch.sortOrder = body.sortOrder
    }

    const updated = updateMilestone(db, milestoneId, patch)!
    if (patch.status && patch.status !== existing.status) {
      const done = patch.status === 'done'
      addGoalUpdate(db, {
        goalId: id,
        authorKind: 'operator',
        kind: 'milestone',
        summary: done ? `Completed milestone "${updated.title}"` : `Reopened milestone "${updated.title}"`,
        diff: done ? `✓ [x] ${updated.title}` : `~ [ ] ${updated.title}`,
        now: at,
      })
    }
    hub.broadcast({ type: 'goals_changed' })
    return c.json({ milestone: updated, goal: getGoalView(db, id)!, snapshot: snapshot() })
  })

  app.delete('/api/goals/:id/milestones/:milestoneId', (c) => {
    const id = c.req.param('id')
    const milestoneId = c.req.param('milestoneId')
    if (!isGoalId(id) || !isMilestoneId(milestoneId)) return c.json({ error: 'invalid id' }, 400)
    const existing = getMilestone(db, milestoneId)
    if (!existing || existing.goalId !== id) return c.json({ error: 'unknown milestone' }, 404)
    const at = now()
    deleteMilestone(db, id, milestoneId, at)
    addGoalUpdate(db, {
      goalId: id,
      authorKind: 'operator',
      kind: 'milestone',
      summary: `Removed milestone "${existing.title}"`,
      diff: `- ${existing.title}`,
      now: at,
    })
    hub.broadcast({ type: 'goals_changed' })
    return c.json({ ok: true, goal: getGoalView(db, id)!, snapshot: snapshot() })
  })

  app.post('/api/goals/:id/updates', async (c) => {
    const id = c.req.param('id')
    if (!isGoalId(id)) return c.json({ error: 'invalid goal id' }, 400)
    if (!getGoal(db, id)) return c.json({ error: 'unknown goal' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const summary = isObject(body) && typeof body.summary === 'string' ? body.summary.trim() : ''
    if (!summary || summary.length > 500) {
      return c.json({ error: 'summary must be 1 to 500 characters' }, 400)
    }
    const update = addGoalUpdate(db, {
      goalId: id,
      authorKind: 'operator',
      kind: 'note',
      summary,
      diff: `+ ${summary}`,
      now: now(),
    })
    hub.broadcast({ type: 'goals_changed' })
    return c.json({ update, goal: getGoalView(db, id)!, snapshot: snapshot() }, 201)
  })

  app.post('/api/goals/:id/checkin', async (c) => {
    const id = c.req.param('id')
    if (!isGoalId(id)) return c.json({ error: 'invalid goal id' }, 400)
    const goal = getGoalView(db, id)
    if (!goal) return c.json({ error: 'unknown goal' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null
    const requestedBotId = isObject(body) && typeof body.botId === 'string' && body.botId.trim()
      ? body.botId.trim()
      : goal.ownerBotId
    const bot = botById(requestedBotId) ?? botById(goal.ownerBotId) ?? defaultBot()
    if (!bot) return c.json({ error: 'no teammate available' }, 404)
    const note = isObject(body) && typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : ''

    const { threadId } = deps.startCheckin(bot, goal, note || undefined)
    hub.broadcast({ type: 'goals_changed' })
    return c.json({ ok: true, botId: bot.id, threadId, snapshot: snapshot() }, 202)
  })

  return { snapshot }
}
