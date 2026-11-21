import type { RoutineMode, RoutineSurface } from '../routines.js'

export const GOAL_STATUSES = ['active', 'paused', 'done', 'archived'] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

export const MILESTONE_STATUSES = ['open', 'done'] as const
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]

export const GOAL_UPDATE_KINDS = ['note', 'milestone', 'definition', 'status'] as const
export type GoalUpdateKind = (typeof GOAL_UPDATE_KINDS)[number]

export type GoalRow = {
  id: string
  title: string
  description: string
  successCriteria: string
  status: GoalStatus
  ownerBotId: string
  memberBotIds: string[]
  targetDate: string | null
  sourceIdeaId: string | null
  sourceThreadId: string | null
  origin: 'operator' | 'auto'
  createdAt: number
  updatedAt: number
}

export type GoalMilestoneRow = {
  id: string
  goalId: string
  title: string
  status: MilestoneStatus
  ownerBotId: string | null
  dueDate: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type GoalUpdateRow = {
  id: number
  goalId: string
  authorKind: 'operator' | 'bot'
  botId: string | null
  kind: GoalUpdateKind
  summary: string
  diff: string
  tainted: boolean
  threadId: string | null
  createdAt: number
}

export type GoalRoutineSummary = {
  id: number
  botId: string
  name: string
  cron: string
  human: string
  mode: RoutineMode
  surface: RoutineSurface
  enabled: boolean
  lastRunAt: number | null
  goalId: string | null
}

export type GoalActionSummary = {
  id: number
  botId: string
  threadId: string
  trigger: string
  tool: string
  summary: string
  ok: boolean | null
  ms: number | null
  createdAt: number
}

export type GoalSpaceRef = {
  id: string
  title: string
  icon: string
}

export type GoalView = GoalRow & {
  milestones: GoalMilestoneRow[]
  doneMilestones: number
  totalMilestones: number
  recentUpdates: GoalUpdateRow[]
  routines: GoalRoutineSummary[]
  recentActions: GoalActionSummary[]
  spaces: GoalSpaceRef[]
}

export type GoalsSnapshot = {
  goals: GoalView[]
  activeCount: number
  unlinkedRoutines: GoalRoutineSummary[]
}

/** 对话里落库的 goal_updated 变更卡片载荷（对齐 MemoryChip 的审计样式） */
export type GoalUpdatedPayload = {
  goalId: string
  goalTitle: string
  kind: GoalUpdateKind
  summary: string
  diff: string
  tainted?: boolean
  by?: 'operator' | 'bot'
}
