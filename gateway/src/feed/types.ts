import type { ReportPayload } from '../report.js'

export const FEED_ITEM_KINDS = ['briefing', 'signal', 'proposal'] as const
export type FeedItemKind = (typeof FEED_ITEM_KINDS)[number]

export const FEED_ITEM_STATUSES = ['unread', 'read', 'archived'] as const
export type FeedItemStatus = (typeof FEED_ITEM_STATUSES)[number]

export const IDEA_STATUSES = ['inbox', 'incubating', 'ready', 'promoted', 'archived'] as const
export type IdeaStatus = (typeof IDEA_STATUSES)[number]

export const TODO_STATUSES = ['open', 'done', 'dismissed'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export const MAX_DAILY_CUSTOM_FEED_ITEMS = 15

export type FeedSourceLink = {
  title: string
  url: string
}

export type FeedItemBody = {
  report?: ReportPayload
  suggestedAction?: string
  suggestedBotId?: string
  sources?: FeedSourceLink[]
}

export type FeedItemRow = {
  id: string
  kind: FeedItemKind
  botId: string
  botName: string
  botEmoji: string
  threadId: string
  sourceMessageId: number | null
  topicId: string | null
  title: string
  summary: string
  body: FeedItemBody
  tags: string[]
  tainted: boolean
  sourceLabel: string
  status: FeedItemStatus
  createdAt: number
  updatedAt: number
}

export type FeedTopicRow = {
  id: string
  title: string
  prompt: string
  botId: string
  botName: string
  botEmoji: string
  cron: string
  human: string
  enabled: boolean
  running: boolean
  lastRunAt: number | null
  lastError: string
  createdAt: number
  updatedAt: number
}

export type NeedsYouApprovalItem = {
  kind: 'approval'
  id: string
  approvalId: number
  botId: string
  botName: string
  botEmoji: string
  threadId: string
  threadTitle: string
  createdAt: number
  payload: Record<string, unknown>
}

export type NeedsYouQuestionItem = {
  kind: 'question'
  id: string
  messageId: number
  botId: string
  botName: string
  botEmoji: string
  threadId: string
  threadTitle: string
  createdAt: number
  payload: Record<string, unknown>
}

export type NeedsYouLoginItem = {
  kind: 'login'
  id: string
  messageId: number
  botId: string
  botName: string
  botEmoji: string
  threadId: string
  threadTitle: string
  createdAt: number
  payload: Record<string, unknown>
}

export type NeedsYouItem = NeedsYouApprovalItem | NeedsYouQuestionItem | NeedsYouLoginItem

export type IdeaRow = {
  id: string
  title: string
  notes: string
  origin: 'operator' | 'proposal' | 'conversation'
  sourceFeedId: string | null
  sourceThreadId: string | null
  tainted: boolean
  status: IdeaStatus
  assignedBotId: string | null
  incubationThreadId: string | null
  incubationSummary: string
  promotedGoalId: string | null
  createdAt: number
  updatedAt: number
}

export type TodoRow = {
  id: string
  title: string
  detail: string
  status: TodoStatus
  ownerBotId: string | null
  sourceThreadId: string | null
  origin: 'auto' | 'operator'
  tainted: boolean
  createdAt: number
  updatedAt: number
}

export type FeedSnapshot = {
  needsYou: NeedsYouItem[]
  items: FeedItemRow[]
  ideas: IdeaRow[]
  todos: TodoRow[]
  topics: FeedTopicRow[]
  unreadCount: number
  dailyCustomCount: number
  dailyCustomCap: number
}
