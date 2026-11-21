import { randomBytes } from 'node:crypto'
import { listGoalActions } from '../actions.js'
import type { Db } from '../db.js'
import { isIdeaId } from '../feed/store.js'
import type { PromptGoal } from '../prompts.js'
import {
  clearGoalFromRoutines,
  describeRoutine,
  listGoalRoutines,
  normalizeSurface,
  type RoutineRow,
} from '../routines.js'
import {
  GOAL_STATUSES,
  GOAL_UPDATE_KINDS,
  MILESTONE_STATUSES,
  type GoalMilestoneRow,
  type GoalRoutineSummary,
  type GoalRow,
  type GoalStatus,
  type GoalUpdateKind,
  type GoalUpdateRow,
  type GoalView,
  type MilestoneStatus,
} from './types.js'

const GOAL_ID_RE = /^goal-[0-9a-f]{8}$/
const MILESTONE_ID_RE = /^ms-[0-9a-f]{8}$/
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export const MAX_PROMPT_GOALS = 8
export const MAX_PROMPT_MILESTONES = 6
export const MAX_PROMPT_UPDATES = 3
export const MAX_PROMPT_NOTE_CHARS = 180

export const isGoalId = (id: string): boolean => GOAL_ID_RE.test(id)
export const isMilestoneId = (id: string): boolean => MILESTONE_ID_RE.test(id)

export function isIsoDate(raw: string): boolean {
  const m = ISO_DATE_RE.exec(raw.trim())
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const dt = new Date(Date.UTC(year, month - 1, day))
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
}

export function normalizeGoalStatus(raw: unknown): GoalStatus {
  return typeof raw === 'string' && (GOAL_STATUSES as readonly string[]).includes(raw)
    ? (raw as GoalStatus)
    : 'active'
}

export function normalizeMilestoneStatus(raw: unknown): MilestoneStatus {
  return typeof raw === 'string' && (MILESTONE_STATUSES as readonly string[]).includes(raw)
    ? (raw as MilestoneStatus)
    : 'open'
}

export function normalizeUpdateKind(raw: unknown): GoalUpdateKind {
  return typeof raw === 'string' && (GOAL_UPDATE_KINDS as readonly string[]).includes(raw)
    ? (raw as GoalUpdateKind)
    : 'note'
}

export function normalizeMemberBotIds(raw: readonly string[] | undefined, ownerBotId: string): string[] {
  if (!raw?.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const id = item.trim()
    if (!id || id === ownerBotId || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= 16) break
  }
  return out
}

export function isBotOnGoal(goal: Pick<GoalRow, 'ownerBotId' | 'memberBotIds'>, botId: string): boolean {
  return goal.ownerBotId === botId || goal.memberBotIds.includes(botId)
}

type RawGoalRow = {
  id: string
  title: string
  description: string
  success_criteria: string
  status: string
  owner_bot_id: string
  member_bots_json: string
  target_date: string | null
  source_idea_id: string | null
  source_thread_id?: string | null
  origin?: string | null
  created_at: number
  updated_at: number
}

type RawMilestoneRow = {
  id: string
  goal_id: string
  title: string
  status: string
  owner_bot_id: string | null
  due_date: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

type RawUpdateRow = {
  id: number
  goal_id: string
  author_kind: string
  bot_id: string | null
  kind: string
  summary: string
  diff: string
  tainted: number
  thread_id: string | null
  created_at: number
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
      : []
  } catch {
    return []
  }
}

function mapGoalRow(r: RawGoalRow): GoalRow {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    successCriteria: r.success_criteria,
    status: normalizeGoalStatus(r.status),
    ownerBotId: r.owner_bot_id,
    memberBotIds: normalizeMemberBotIds(parseStringArray(r.member_bots_json), r.owner_bot_id),
    targetDate: r.target_date,
    sourceIdeaId: r.source_idea_id,
    sourceThreadId: r.source_thread_id ?? null,
    origin: r.origin === 'auto' ? 'auto' : 'operator',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapMilestoneRow(r: RawMilestoneRow): GoalMilestoneRow {
  return {
    id: r.id,
    goalId: r.goal_id,
    title: r.title,
    status: normalizeMilestoneStatus(r.status),
    ownerBotId: r.owner_bot_id,
    dueDate: r.due_date,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapUpdateRow(r: RawUpdateRow): GoalUpdateRow {
  return {
    id: r.id,
    goalId: r.goal_id,
    authorKind: r.author_kind === 'bot' ? 'bot' : 'operator',
    botId: r.bot_id,
    kind: normalizeUpdateKind(r.kind),
    summary: r.summary,
    diff: r.diff,
    tainted: r.tainted === 1,
    threadId: r.thread_id,
    createdAt: r.created_at,
  }
}

function toRoutineSummary(r: RoutineRow): GoalRoutineSummary {
  return {
    id: r.id,
    botId: r.bot_id,
    name: r.name,
    cron: r.cron,
    human: describeRoutine({ cron: r.cron, webhook_key: r.webhook_key }),
    mode: r.mode,
    surface: normalizeSurface(r.surface, r.mode),
    enabled: r.enabled === 1,
    lastRunAt: r.last_run_at,
    goalId: r.goal_id ?? null,
  }
}

export function createGoal(
  db: Db,
  input: {
    title: string
    description?: string
    successCriteria?: string
    ownerBotId: string
    memberBotIds?: string[]
    targetDate?: string | null
    sourceIdeaId?: string | null
    sourceThreadId?: string | null
    origin?: 'operator' | 'auto'
    tainted?: boolean
    milestones?: Array<{ title: string; ownerBotId?: string | null; dueDate?: string | null }>
    authorKind?: 'operator' | 'bot'
    authorBotId?: string | null
    threadId?: string | null
    now?: number
  },
): GoalRow {
  const id = `goal-${randomBytes(4).toString('hex')}`
  const at = input.now ?? Date.now()
  const title = input.title.trim().slice(0, 120)
  const description = (input.description ?? '').trim().slice(0, 2000)
  const successCriteria = (input.successCriteria ?? '').trim().slice(0, 1000)
  const ownerBotId = input.ownerBotId.trim()
  const memberBotIds = normalizeMemberBotIds(input.memberBotIds, ownerBotId)
  const targetDate = input.targetDate && isIsoDate(input.targetDate) ? input.targetDate.trim() : null
  const sourceIdeaId = input.sourceIdeaId && isIdeaId(input.sourceIdeaId) ? input.sourceIdeaId : null
  const sourceThreadId = input.sourceThreadId?.trim() || input.threadId?.trim() || null
  const origin = input.origin === 'auto' ? 'auto' : 'operator'
  const tainted = input.tainted ? 1 : 0

  db.transaction(() => {
    db.prepare(
      `INSERT INTO goals (
        id, title, description, success_criteria, status, owner_bot_id, member_bots_json, target_date, source_idea_id, source_thread_id, origin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      title,
      description,
      successCriteria,
      ownerBotId,
      JSON.stringify(memberBotIds),
      targetDate,
      sourceIdeaId,
      sourceThreadId,
      origin,
      at,
      at,
    )

    const initialMilestones = (input.milestones ?? []).slice(0, 20)
    const insertMs = db.prepare(
      `INSERT INTO goal_milestones (
        id, goal_id, title, status, owner_bot_id, due_date, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    )
    initialMilestones.forEach((m, index) => {
      const mTitle = m.title.trim().slice(0, 140)
      if (!mTitle) return
      const msId = `ms-${randomBytes(4).toString('hex')}`
      const mDue = m.dueDate && isIsoDate(m.dueDate) ? m.dueDate.trim() : null
      insertMs.run(msId, id, mTitle, m.ownerBotId?.trim() || null, mDue, index, at, at)
    })

    const diffLines = [
      `+ Goal: ${title}`,
      ...(successCriteria ? [`+ Criteria: ${successCriteria.slice(0, 160)}`] : []),
      ...initialMilestones
        .map((m) => m.title.trim().slice(0, 140))
        .filter(Boolean)
        .map((mTitle) => `+ [ ] ${mTitle}`),
    ]
    db.prepare(
      `INSERT INTO goal_updates (goal_id, author_kind, bot_id, kind, summary, diff, tainted, thread_id, created_at)
       VALUES (?, ?, ?, 'definition', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.authorKind ?? 'operator',
      input.authorBotId ?? null,
      origin === 'auto' ? `Auto-organized from chat: "${title}"` : `Created goal "${title}"`,
      diffLines.join('\n').slice(0, 1000),
      tainted,
      sourceThreadId,
      at,
    )

    if (sourceIdeaId) {
      db.prepare(
        `UPDATE ideas SET status = 'promoted', promoted_goal_id = ?, updated_at = ? WHERE id = ?`,
      ).run(id, at, sourceIdeaId)
    }
  })()

  return getGoal(db, id)!
}

export function getGoal(db: Db, id: string): GoalRow | null {
  if (!isGoalId(id)) return null
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as RawGoalRow | undefined
  return row ? mapGoalRow(row) : null
}

export function listGoals(db: Db, opts: { status?: GoalStatus | 'all'; includeArchived?: boolean } = {}): GoalRow[] {
  let where = ''
  const params: unknown[] = []
  if (opts.status && opts.status !== 'all') {
    where = 'WHERE status = ?'
    params.push(normalizeGoalStatus(opts.status))
  } else if (!opts.includeArchived) {
    where = `WHERE status != 'archived'`
  }
  const rows = db
    .prepare(
      `SELECT * FROM goals ${where}
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                CASE WHEN target_date IS NULL THEN 1 ELSE 0 END,
                target_date ASC,
                updated_at DESC`,
    )
    .all(...params) as RawGoalRow[]
  return rows.map(mapGoalRow)
}

export function activeGoalsCount(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM goals WHERE status = 'active'`).get() as { n: number }
  return row.n
}

export function updateGoal(
  db: Db,
  id: string,
  patch: {
    title?: string
    description?: string
    successCriteria?: string
    status?: GoalStatus
    ownerBotId?: string
    memberBotIds?: string[]
    targetDate?: string | null
    now?: number
  },
): GoalRow | null {
  const existing = getGoal(db, id)
  if (!existing) return null
  const title = patch.title !== undefined ? patch.title.trim().slice(0, 120) : existing.title
  const description = patch.description !== undefined ? patch.description.trim().slice(0, 2000) : existing.description
  const successCriteria = patch.successCriteria !== undefined
    ? patch.successCriteria.trim().slice(0, 1000)
    : existing.successCriteria
  const status = patch.status !== undefined ? normalizeGoalStatus(patch.status) : existing.status
  const ownerBotId = patch.ownerBotId !== undefined ? patch.ownerBotId.trim() : existing.ownerBotId
  const memberBotIds = patch.memberBotIds !== undefined
    ? normalizeMemberBotIds(patch.memberBotIds, ownerBotId)
    : normalizeMemberBotIds(existing.memberBotIds, ownerBotId)
  const targetDate = patch.targetDate !== undefined
    ? (patch.targetDate && isIsoDate(patch.targetDate) ? patch.targetDate.trim() : null)
    : existing.targetDate
  const at = patch.now ?? Date.now()
  db.prepare(
    `UPDATE goals
     SET title = ?, description = ?, success_criteria = ?, status = ?, owner_bot_id = ?, member_bots_json = ?, target_date = ?, updated_at = ?
     WHERE id = ?`,
  ).run(title, description, successCriteria, status, ownerBotId, JSON.stringify(memberBotIds), targetDate, at, id)
  return getGoal(db, id)
}

export function deleteGoal(db: Db, id: string): boolean {
  if (!isGoalId(id)) return false
  return db.transaction(() => {
    const info = db.prepare('DELETE FROM goals WHERE id = ?').run(id)
    if (info.changes === 0) return false
    db.prepare('DELETE FROM goal_milestones WHERE goal_id = ?').run(id)
    db.prepare('DELETE FROM goal_updates WHERE goal_id = ?').run(id)
    clearGoalFromRoutines(db, id)
    db.prepare('UPDATE ideas SET promoted_goal_id = NULL WHERE promoted_goal_id = ?').run(id)
    db.prepare('UPDATE spaces SET goal_id = NULL WHERE goal_id = ?').run(id)
    return true
  })()
}

export function listMilestones(db: Db, goalId: string): GoalMilestoneRow[] {
  const rows = db
    .prepare('SELECT * FROM goal_milestones WHERE goal_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC')
    .all(goalId) as RawMilestoneRow[]
  return rows.map(mapMilestoneRow)
}

export function getMilestone(db: Db, milestoneId: string): GoalMilestoneRow | null {
  if (!isMilestoneId(milestoneId)) return null
  const row = db.prepare('SELECT * FROM goal_milestones WHERE id = ?').get(milestoneId) as RawMilestoneRow | undefined
  return row ? mapMilestoneRow(row) : null
}

export function addMilestone(
  db: Db,
  input: {
    goalId: string
    title: string
    ownerBotId?: string | null
    dueDate?: string | null
    now?: number
  },
): GoalMilestoneRow | null {
  const goal = getGoal(db, input.goalId)
  if (!goal) return null
  const at = input.now ?? Date.now()
  const maxRow = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM goal_milestones WHERE goal_id = ?')
    .get(input.goalId) as { max_order: number }
  const id = `ms-${randomBytes(4).toString('hex')}`
  const title = input.title.trim().slice(0, 140)
  const dueDate = input.dueDate && isIsoDate(input.dueDate) ? input.dueDate.trim() : null
  db.prepare(
    `INSERT INTO goal_milestones (id, goal_id, title, status, owner_bot_id, due_date, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).run(id, input.goalId, title, input.ownerBotId?.trim() || null, dueDate, maxRow.max_order + 1, at, at)
  db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(at, input.goalId)
  return getMilestone(db, id)
}

export function updateMilestone(
  db: Db,
  milestoneId: string,
  patch: {
    title?: string
    status?: MilestoneStatus
    ownerBotId?: string | null
    dueDate?: string | null
    sortOrder?: number
    now?: number
  },
): GoalMilestoneRow | null {
  const existing = getMilestone(db, milestoneId)
  if (!existing) return null
  const title = patch.title !== undefined ? patch.title.trim().slice(0, 140) : existing.title
  const status = patch.status !== undefined ? normalizeMilestoneStatus(patch.status) : existing.status
  const ownerBotId = patch.ownerBotId !== undefined ? (patch.ownerBotId?.trim() || null) : existing.ownerBotId
  const dueDate = patch.dueDate !== undefined
    ? (patch.dueDate && isIsoDate(patch.dueDate) ? patch.dueDate.trim() : null)
    : existing.dueDate
  const sortOrder = patch.sortOrder !== undefined && Number.isFinite(patch.sortOrder)
    ? Math.floor(patch.sortOrder)
    : existing.sortOrder
  const at = patch.now ?? Date.now()
  db.prepare(
    `UPDATE goal_milestones
     SET title = ?, status = ?, owner_bot_id = ?, due_date = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`,
  ).run(title, status, ownerBotId, dueDate, sortOrder, at, milestoneId)
  db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(at, existing.goalId)
  return getMilestone(db, milestoneId)
}

export function deleteMilestone(db: Db, goalId: string, milestoneId: string, now = Date.now()): boolean {
  if (!isGoalId(goalId) || !isMilestoneId(milestoneId)) return false
  const info = db.prepare('DELETE FROM goal_milestones WHERE id = ? AND goal_id = ?').run(milestoneId, goalId)
  if (info.changes > 0) db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(now, goalId)
  return info.changes > 0
}

export function addGoalUpdate(
  db: Db,
  input: {
    goalId: string
    authorKind: 'operator' | 'bot'
    botId?: string | null
    kind: GoalUpdateKind
    summary: string
    diff?: string
    tainted?: boolean
    threadId?: string | null
    now?: number
  },
): GoalUpdateRow {
  const at = input.now ?? Date.now()
  const info = db.prepare(
    `INSERT INTO goal_updates (goal_id, author_kind, bot_id, kind, summary, diff, tainted, thread_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.goalId,
    input.authorKind,
    input.botId ?? null,
    normalizeUpdateKind(input.kind),
    input.summary.trim().slice(0, 500),
    (input.diff ?? '').trim().slice(0, 1000),
    input.tainted ? 1 : 0,
    input.threadId ?? null,
    at,
  )
  db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(at, input.goalId)
  const row = db.prepare('SELECT * FROM goal_updates WHERE id = ?').get(Number(info.lastInsertRowid)) as RawUpdateRow
  return mapUpdateRow(row)
}

export function listGoalUpdates(db: Db, goalId: string, limit = 20): GoalUpdateRow[] {
  const capped = Math.max(1, Math.min(limit, 100))
  const rows = db
    .prepare('SELECT * FROM goal_updates WHERE goal_id = ? ORDER BY id DESC LIMIT ?')
    .all(goalId, capped) as RawUpdateRow[]
  return rows.map(mapUpdateRow)
}

export function listUnlinkedRoutines(db: Db): GoalRoutineSummary[] {
  const rows = db
    .prepare('SELECT * FROM routines WHERE goal_id IS NULL ORDER BY enabled DESC, id DESC')
    .all() as RoutineRow[]
  return rows.map(toRoutineSummary)
}

export function getGoalView(db: Db, goalId: string): GoalView | null {
  const goal = getGoal(db, goalId)
  if (!goal) return null
  const milestones = listMilestones(db, goal.id)
  const doneMilestones = milestones.filter((m) => m.status === 'done').length
  const recentUpdates = listGoalUpdates(db, goal.id, 20)
  const routines = listGoalRoutines(db, goal.id).map(toRoutineSummary)
  const recentActions = listGoalActions(db, goal.id, 15).map((a) => ({
    id: a.id,
    botId: a.bot_id,
    threadId: a.thread_id,
    trigger: a.trigger,
    tool: a.tool,
    summary: a.summary,
    ok: a.ok,
    ms: a.ms,
    createdAt: a.created_at,
  }))
  const spaces = db
    .prepare('SELECT id, title, icon FROM spaces WHERE goal_id = ? ORDER BY updated_at DESC, id ASC')
    .all(goal.id) as Array<{ id: string; title: string; icon: string }>
  return {
    ...goal,
    milestones,
    doneMilestones,
    totalMilestones: milestones.length,
    recentUpdates,
    routines,
    recentActions,
    spaces,
  }
}

export function listGoalViews(db: Db, opts: { status?: GoalStatus | 'all'; includeArchived?: boolean } = {}): GoalView[] {
  return listGoals(db, opts)
    .map((g) => getGoalView(db, g.id))
    .filter((v): v is GoalView => v !== null)
}

/**
 * 为某位同事构造 System Prompt 中受预算约束的活跃目标清单：
 * 仅含该同事担任负责人或协作成员的 active 目标，最多 8 条、每条最多 6 个未完成里程碑与最近 3 条进展备注。
 */
export function listActivePromptGoalsForBot(db: Db, botId: string): PromptGoal[] {
  const active = listGoals(db, { status: 'active' }).filter((g) => isBotOnGoal(g, botId))
  return active.slice(0, MAX_PROMPT_GOALS).map((g) => {
    const allMs = listMilestones(db, g.id)
    const openMs = allMs
      .filter((m) => m.status === 'open')
      .slice(0, MAX_PROMPT_MILESTONES)
      .map((m) => ({
        id: m.id,
        title: m.title,
        ...(m.ownerBotId ? { ownerBotId: m.ownerBotId } : {}),
        ...(m.dueDate ? { dueDate: m.dueDate } : {}),
      }))
    const recentNotes = listGoalUpdates(db, g.id, MAX_PROMPT_UPDATES)
      .filter((u) => u.kind === 'note' || u.kind === 'milestone')
      .slice(0, MAX_PROMPT_UPDATES)
      .map((u) => ({
        summary: u.summary.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_NOTE_CHARS),
        tainted: u.tainted,
      }))
    return {
      id: g.id,
      title: g.title,
      role: g.ownerBotId === botId ? 'owner' : 'member',
      ...(g.targetDate ? { targetDate: g.targetDate } : {}),
      ...(g.successCriteria ? { successCriteria: g.successCriteria.slice(0, 240) } : {}),
      doneMilestones: allMs.filter((m) => m.status === 'done').length,
      totalMilestones: allMs.length,
      openMilestones: openMs,
      recentNotes,
    }
  })
}
