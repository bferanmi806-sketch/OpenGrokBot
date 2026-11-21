import { randomBytes } from 'node:crypto'
import { blockText, canRemember, itemsOf, rememberReason, type ApprovalRow } from '../approvals.js'
import type { Db } from '../db.js'
import { describeCron } from '../routines.js'
import {
  FEED_ITEM_KINDS,
  FEED_ITEM_STATUSES,
  IDEA_STATUSES,
  TODO_STATUSES,
  type FeedItemBody,
  type FeedItemKind,
  type FeedItemRow,
  type FeedItemStatus,
  type FeedTopicRow,
  type IdeaRow,
  type IdeaStatus,
  type NeedsYouItem,
  type TodoRow,
  type TodoStatus,
} from './types.js'

const FEED_ID_RE = /^feed-[0-9a-f]{8}$/
const IDEA_ID_RE = /^idea-[0-9a-f]{8}$/
const TOPIC_ID_RE = /^topic-[0-9a-f]{8}$/
const TODO_ID_RE = /^todo-[0-9a-f]{8}$/

export const isFeedItemId = (id: string): boolean => FEED_ID_RE.test(id)
export const isIdeaId = (id: string): boolean => IDEA_ID_RE.test(id)
export const isFeedTopicId = (id: string): boolean => TOPIC_ID_RE.test(id)
export const isTodoId = (id: string): boolean => TODO_ID_RE.test(id)

type RawFeedRow = {
  id: string
  kind: string
  bot_id: string
  bot_name: string | null
  bot_emoji: string | null
  thread_id: string
  source_message_id: number | null
  topic_id?: string | null
  title: string
  summary: string
  body_json: string
  tags_json: string
  tainted: number
  source_label: string
  status: string
  created_at: number
  updated_at: number
}

type RawTopicRow = {
  id: string
  title: string
  prompt: string
  bot_id: string
  bot_name: string | null
  bot_emoji: string | null
  cron: string
  enabled: number
  last_run_at: number | null
  last_error: string
  created_at: number
  updated_at: number
}

type RawIdeaRow = {
  id: string
  title: string
  notes: string
  origin: string
  source_feed_id: string | null
  source_thread_id?: string | null
  tainted: number
  status: string
  assigned_bot_id: string | null
  incubation_thread_id: string | null
  incubation_summary: string
  promoted_goal_id?: string | null
  created_at: number
  updated_at: number
}

type RawTodoRow = {
  id: string
  title: string
  detail: string
  status: string
  owner_bot_id: string | null
  source_thread_id: string | null
  origin: string
  tainted: number
  created_at: number
  updated_at: number
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((v): v is string => typeof v === 'string').map((t) => t.trim().slice(0, 32)).filter(Boolean))].slice(0, 5)
      : []
  } catch {
    return []
  }
}

function normalizeKind(raw: string): FeedItemKind {
  return (FEED_ITEM_KINDS as readonly string[]).includes(raw) ? (raw as FeedItemKind) : 'briefing'
}

function normalizeFeedStatus(raw: string): FeedItemStatus {
  return (FEED_ITEM_STATUSES as readonly string[]).includes(raw) ? (raw as FeedItemStatus) : 'unread'
}

function normalizeIdeaStatus(raw: string): IdeaStatus {
  return (IDEA_STATUSES as readonly string[]).includes(raw) ? (raw as IdeaStatus) : 'inbox'
}

function normalizeTodoStatus(raw: string): TodoStatus {
  return (TODO_STATUSES as readonly string[]).includes(raw) ? (raw as TodoStatus) : 'open'
}

export function normalizeDedupeText(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 64)
}

function mapFeedRow(r: RawFeedRow): FeedItemRow {
  return {
    id: r.id,
    kind: normalizeKind(r.kind),
    botId: r.bot_id,
    botName: r.bot_name || r.bot_id,
    botEmoji: r.bot_emoji || '🤖',
    threadId: r.thread_id,
    sourceMessageId: r.source_message_id,
    topicId: r.topic_id ?? null,
    title: r.title,
    summary: r.summary,
    body: parseJsonObject(r.body_json) as FeedItemBody,
    tags: parseTags(r.tags_json),
    tainted: r.tainted === 1,
    sourceLabel: r.source_label,
    status: normalizeFeedStatus(r.status),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapTopicRow(r: RawTopicRow, isRunning?: (id: string) => boolean): FeedTopicRow {
  const cron = r.cron.trim()
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    botId: r.bot_id,
    botName: r.bot_name || r.bot_id,
    botEmoji: r.bot_emoji || '🤖',
    cron,
    human: cron ? describeCron(cron) : '',
    enabled: r.enabled === 1,
    running: isRunning ? isRunning(r.id) : false,
    lastRunAt: r.last_run_at,
    lastError: r.last_error ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapIdeaRow(r: RawIdeaRow): IdeaRow {
  const origin: IdeaRow['origin'] =
    r.origin === 'proposal' ? 'proposal' : r.origin === 'conversation' ? 'conversation' : 'operator'
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    origin,
    sourceFeedId: r.source_feed_id,
    sourceThreadId: r.source_thread_id ?? null,
    tainted: r.tainted === 1,
    status: normalizeIdeaStatus(r.status),
    assignedBotId: r.assigned_bot_id,
    incubationThreadId: r.incubation_thread_id,
    incubationSummary: r.incubation_summary,
    promotedGoalId: r.promoted_goal_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapTodoRow(r: RawTodoRow): TodoRow {
  return {
    id: r.id,
    title: r.title,
    detail: r.detail,
    status: normalizeTodoStatus(r.status),
    ownerBotId: r.owner_bot_id,
    sourceThreadId: r.source_thread_id,
    origin: r.origin === 'operator' ? 'operator' : 'auto',
    tainted: r.tainted === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function fallbackApprovalPayload(a: ApprovalRow): Record<string, unknown> {
  const items = itemsOf(a)
  const reason = rememberReason({ kind: a.kind, target: a.target })
  return {
    approvalId: a.id,
    action: a.action,
    detail: a.detail,
    kind: a.kind,
    target: a.target,
    status: a.status,
    ...(items ? { items } : {}),
    canRemember: !items && canRemember({ kind: a.kind, target: a.target }),
    ...(reason ? { rememberBlocked: blockText(reason), rememberReason: reason } : {}),
  }
}

/**
 * 跨所有同事与群聊聚合当前「等你拍板」的三类事项：
 * 1) 未决审批（优先读取挂在原消息上的完整 ApprovalPayload，保留可编辑/批量/放行规矩）；
 * 2) 未答问题卡片；
 * 3) 每个同事/对话最近一条尚未由你开口回应的登录接管请求。
 */
export function listNeedsYou(db: Db): NeedsYouItem[] {
  const out: NeedsYouItem[] = []

  const approvals = db
    .prepare(
      `SELECT a.*, b.name AS bot_name, b.emoji AS bot_emoji, t.title AS thread_title, m.payload AS msg_payload
       FROM approvals a
       LEFT JOIN bots b ON b.id = a.bot_id
       LEFT JOIN threads t ON t.id = a.thread_id
       LEFT JOIN messages m ON m.id = a.message_id
       WHERE a.status = 'pending'
       ORDER BY a.created_at DESC, a.id DESC`,
    )
    .all() as Array<
      ApprovalRow & {
        bot_name: string | null
        bot_emoji: string | null
        thread_title: string | null
        msg_payload: string | null
      }
    >
  for (const a of approvals) {
    const payload = a.msg_payload ? parseJsonObject(a.msg_payload) : fallbackApprovalPayload(a)
    out.push({
      kind: 'approval',
      id: `approval:${a.id}`,
      approvalId: a.id,
      botId: a.bot_id,
      botName: a.bot_name || a.bot_id,
      botEmoji: a.bot_emoji || '🤖',
      threadId: a.thread_id,
      threadTitle: a.thread_title || a.bot_name || a.bot_id,
      createdAt: a.created_at,
      payload,
    })
  }

  const questions = db
    .prepare(
      `SELECT m.id, m.thread_id, m.sender, m.payload, m.created_at,
              b.name AS bot_name, b.emoji AS bot_emoji, t.title AS thread_title
       FROM messages m
       LEFT JOIN bots b ON b.id = m.sender
       LEFT JOIN threads t ON t.id = m.thread_id
       WHERE m.kind = 'question' AND json_extract(m.payload, '$.status') = 'open'
       ORDER BY m.created_at DESC, m.id DESC`,
    )
    .all() as Array<{
      id: number
      thread_id: string
      sender: string
      payload: string | null
      created_at: number
      bot_name: string | null
      bot_emoji: string | null
      thread_title: string | null
    }>
  for (const q of questions) {
    out.push({
      kind: 'question',
      id: `question:${q.id}`,
      messageId: q.id,
      botId: q.sender,
      botName: q.bot_name || q.sender,
      botEmoji: q.bot_emoji || '🤖',
      threadId: q.thread_id,
      threadTitle: q.thread_title || q.bot_name || q.sender,
      createdAt: q.created_at,
      payload: q.payload ? parseJsonObject(q.payload) : {},
    })
  }

  const logins = db
    .prepare(
      `SELECT lr.id, lr.thread_id, lr.sender, lr.payload, lr.created_at,
              b.name AS bot_name, b.emoji AS bot_emoji, t.title AS thread_title
       FROM messages lr
       LEFT JOIN bots b ON b.id = lr.sender
       LEFT JOIN threads t ON t.id = lr.thread_id
       WHERE lr.kind = 'login_request'
         AND lr.id = (
           SELECT MAX(lr2.id) FROM messages lr2
           WHERE lr2.thread_id = lr.thread_id AND lr2.sender = lr.sender AND lr2.kind = 'login_request'
         )
         AND NOT EXISTS (
           SELECT 1 FROM messages u
           WHERE u.thread_id = lr.thread_id AND u.sender = 'user' AND u.id > lr.id
         )
       ORDER BY lr.created_at DESC, lr.id DESC`,
    )
    .all() as Array<{
      id: number
      thread_id: string
      sender: string
      payload: string | null
      created_at: number
      bot_name: string | null
      bot_emoji: string | null
      thread_title: string | null
    }>
  for (const l of logins) {
    out.push({
      kind: 'login',
      id: `login:${l.id}`,
      messageId: l.id,
      botId: l.sender,
      botName: l.bot_name || l.sender,
      botEmoji: l.bot_emoji || '🤖',
      threadId: l.thread_id,
      threadTitle: l.thread_title || l.bot_name || l.sender,
      createdAt: l.created_at,
      payload: l.payload ? parseJsonObject(l.payload) : {},
    })
  }

  out.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  return out
}

export function createFeedItem(
  db: Db,
  input: {
    kind: FeedItemKind
    botId: string
    threadId: string
    sourceMessageId?: number | null
    topicId?: string | null
    title: string
    summary?: string
    body?: FeedItemBody
    tags?: string[]
    tainted?: boolean
    sourceLabel?: string
    now?: number
  },
): FeedItemRow {
  const id = `feed-${randomBytes(4).toString('hex')}`
  const at = input.now ?? Date.now()
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim().slice(0, 32)).filter(Boolean))].slice(0, 5)
  db.prepare(
    `INSERT INTO feed_items (
      id, kind, bot_id, thread_id, source_message_id, topic_id, title, summary, body_json, tags_json, tainted, source_label, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?)`,
  ).run(
    id,
    normalizeKind(input.kind),
    input.botId,
    input.threadId,
    input.sourceMessageId ?? null,
    input.topicId ?? null,
    input.title.trim().slice(0, 120),
    (input.summary ?? '').trim().slice(0, 1200),
    JSON.stringify(input.body ?? {}),
    JSON.stringify(tags),
    input.tainted ? 1 : 0,
    (input.sourceLabel ?? '').trim().slice(0, 40),
    at,
    at,
  )
  return getFeedItem(db, id)!
}

export function getFeedItem(db: Db, id: string): FeedItemRow | null {
  if (!isFeedItemId(id)) return null
  const row = db
    .prepare(
      `SELECT f.*, b.name AS bot_name, b.emoji AS bot_emoji
       FROM feed_items f
       LEFT JOIN bots b ON b.id = f.bot_id
       WHERE f.id = ?`,
    )
    .get(id) as RawFeedRow | undefined
  return row ? mapFeedRow(row) : null
}

export function listFeedItems(
  db: Db,
  opts: { status?: FeedItemStatus | 'active'; kind?: FeedItemKind; botId?: string; topicId?: string; limit?: number } = {},
): FeedItemRow[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.status === 'active') {
    clauses.push(`f.status != 'archived'`)
  } else if (opts.status) {
    clauses.push('f.status = ?')
    params.push(opts.status)
  }
  if (opts.kind) {
    clauses.push('f.kind = ?')
    params.push(opts.kind)
  }
  if (opts.botId) {
    clauses.push('f.bot_id = ?')
    params.push(opts.botId)
  }
  if (opts.topicId) {
    clauses.push('f.topic_id = ?')
    params.push(opts.topicId)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(200, Math.max(1, opts.limit ?? 80))
  const rows = db
    .prepare(
      `SELECT f.*, b.name AS bot_name, b.emoji AS bot_emoji
       FROM feed_items f
       LEFT JOIN bots b ON b.id = f.bot_id
       ${where}
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT ?`,
    )
    .all(...params, limit) as RawFeedRow[]
  return rows.map(mapFeedRow)
}

export function unreadFeedCount(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM feed_items WHERE status = 'unread'`).get() as { n: number }
  return row.n
}

export function updateFeedItemStatus(db: Db, id: string, status: FeedItemStatus, now = Date.now()): FeedItemRow | null {
  if (!isFeedItemId(id)) return null
  const info = db
    .prepare('UPDATE feed_items SET status = ?, updated_at = ? WHERE id = ?')
    .run(normalizeFeedStatus(status), now, id)
  return info.changes > 0 ? getFeedItem(db, id) : null
}

export function markAllFeedRead(db: Db, now = Date.now()): number {
  return db
    .prepare(`UPDATE feed_items SET status = 'read', updated_at = ? WHERE status = 'unread'`)
    .run(now).changes
}

export function deleteFeedItem(db: Db, id: string): boolean {
  if (!isFeedItemId(id)) return false
  return db.prepare('DELETE FROM feed_items WHERE id = ?').run(id).changes > 0
}

export function createIdea(
  db: Db,
  input: {
    title: string
    notes?: string
    origin?: 'operator' | 'proposal' | 'conversation'
    sourceFeedId?: string | null
    sourceThreadId?: string | null
    tainted?: boolean
    assignedBotId?: string | null
    now?: number
  },
): IdeaRow {
  const id = `idea-${randomBytes(4).toString('hex')}`
  const at = input.now ?? Date.now()
  const origin: IdeaRow['origin'] =
    input.origin === 'proposal' ? 'proposal' : input.origin === 'conversation' ? 'conversation' : 'operator'
  db.prepare(
    `INSERT INTO ideas (
      id, title, notes, origin, source_feed_id, source_thread_id, tainted, status, assigned_bot_id, incubation_thread_id, incubation_summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'inbox', ?, NULL, '', ?, ?)`,
  ).run(
    id,
    input.title.trim().slice(0, 140),
    (input.notes ?? '').trim().slice(0, 2000),
    origin,
    input.sourceFeedId ?? null,
    input.sourceThreadId ?? null,
    input.tainted ? 1 : 0,
    input.assignedBotId ?? null,
    at,
    at,
  )
  return getIdea(db, id)!
}

export function getIdea(db: Db, id: string): IdeaRow | null {
  if (!isIdeaId(id)) return null
  const row = db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as RawIdeaRow | undefined
  return row ? mapIdeaRow(row) : null
}

export function listIdeas(db: Db, opts: { includeArchived?: boolean; limit?: number } = {}): IdeaRow[] {
  const where = opts.includeArchived ? '' : `WHERE status != 'archived'`
  const limit = Math.min(200, Math.max(1, opts.limit ?? 80))
  const rows = db
    .prepare(`SELECT * FROM ideas ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(limit) as RawIdeaRow[]
  return rows.map(mapIdeaRow)
}

export function updateIdea(
  db: Db,
  id: string,
  patch: {
    title?: string
    notes?: string
    status?: IdeaStatus
    assignedBotId?: string | null
    incubationThreadId?: string | null
    incubationSummary?: string
    promotedGoalId?: string | null
    now?: number
  },
): IdeaRow | null {
  const existing = getIdea(db, id)
  if (!existing) return null
  const title = patch.title !== undefined ? patch.title.trim().slice(0, 140) : existing.title
  const notes = patch.notes !== undefined ? patch.notes.trim().slice(0, 2000) : existing.notes
  const status = patch.status !== undefined ? normalizeIdeaStatus(patch.status) : existing.status
  const assignedBotId = patch.assignedBotId !== undefined ? patch.assignedBotId : existing.assignedBotId
  const incubationThreadId = patch.incubationThreadId !== undefined ? patch.incubationThreadId : existing.incubationThreadId
  const incubationSummary = patch.incubationSummary !== undefined
    ? patch.incubationSummary.trim().slice(0, 4000)
    : existing.incubationSummary
  const promotedGoalId = patch.promotedGoalId !== undefined ? patch.promotedGoalId : existing.promotedGoalId
  const at = patch.now ?? Date.now()
  db.prepare(
    `UPDATE ideas
     SET title = ?, notes = ?, status = ?, assigned_bot_id = ?, incubation_thread_id = ?, incubation_summary = ?, promoted_goal_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(title, notes, status, assignedBotId, incubationThreadId, incubationSummary, promotedGoalId, at, id)
  return getIdea(db, id)
}

export function deleteIdea(db: Db, id: string): boolean {
  if (!isIdeaId(id)) return false
  return db.prepare('DELETE FROM ideas WHERE id = ?').run(id).changes > 0
}

export function createFeedTopic(
  db: Db,
  input: {
    title: string
    prompt: string
    botId: string
    cron?: string
    enabled?: boolean
    now?: number
  },
  isRunning?: (id: string) => boolean,
): FeedTopicRow {
  const id = `topic-${randomBytes(4).toString('hex')}`
  const at = input.now ?? Date.now()
  const title = input.title.trim().slice(0, 80)
  const prompt = input.prompt.trim().slice(0, 1500)
  const cron = (input.cron ?? '0 9 * * *').trim()
  const enabled = input.enabled === false ? 0 : 1
  db.prepare(
    `INSERT INTO feed_topics (id, title, prompt, bot_id, cron, enabled, last_run_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, '', ?, ?)`,
  ).run(id, title, prompt, input.botId, cron, enabled, at, at)
  return getFeedTopic(db, id, isRunning)!
}

export function getFeedTopic(db: Db, id: string, isRunning?: (id: string) => boolean): FeedTopicRow | null {
  if (!isFeedTopicId(id)) return null
  const row = db
    .prepare(
      `SELECT t.*, b.name AS bot_name, b.emoji AS bot_emoji
       FROM feed_topics t
       LEFT JOIN bots b ON b.id = t.bot_id
       WHERE t.id = ?`,
    )
    .get(id) as RawTopicRow | undefined
  return row ? mapTopicRow(row, isRunning) : null
}

export function listFeedTopics(db: Db, isRunning?: (id: string) => boolean): FeedTopicRow[] {
  const rows = db
    .prepare(
      `SELECT t.*, b.name AS bot_name, b.emoji AS bot_emoji
       FROM feed_topics t
       LEFT JOIN bots b ON b.id = t.bot_id
       ORDER BY t.enabled DESC, t.updated_at DESC, t.id DESC`,
    )
    .all() as RawTopicRow[]
  return rows.map((r) => mapTopicRow(r, isRunning))
}

export function updateFeedTopic(
  db: Db,
  id: string,
  patch: {
    title?: string
    prompt?: string
    botId?: string
    cron?: string
    enabled?: boolean
    now?: number
  },
  isRunning?: (id: string) => boolean,
): FeedTopicRow | null {
  const existing = getFeedTopic(db, id, isRunning)
  if (!existing) return null
  const title = patch.title !== undefined ? patch.title.trim().slice(0, 80) : existing.title
  const prompt = patch.prompt !== undefined ? patch.prompt.trim().slice(0, 1500) : existing.prompt
  const botId = patch.botId !== undefined ? patch.botId : existing.botId
  const cron = patch.cron !== undefined ? patch.cron.trim() : existing.cron
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (existing.enabled ? 1 : 0)
  const at = patch.now ?? Date.now()
  db.prepare(
    `UPDATE feed_topics
     SET title = ?, prompt = ?, bot_id = ?, cron = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
  ).run(title, prompt, botId, cron, enabled, at, id)
  return getFeedTopic(db, id, isRunning)
}

export function markFeedTopicRun(db: Db, id: string, at: number, error = ''): void {
  db.prepare('UPDATE feed_topics SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
    .run(at, error.trim().slice(0, 300), at, id)
}

export function setFeedTopicError(db: Db, id: string, error: string, at = Date.now()): void {
  db.prepare('UPDATE feed_topics SET last_error = ?, updated_at = ? WHERE id = ?')
    .run(error.trim().slice(0, 300), at, id)
}

export function deleteFeedTopic(db: Db, id: string): boolean {
  if (!isFeedTopicId(id)) return false
  return db.prepare('DELETE FROM feed_topics WHERE id = ?').run(id).changes > 0
}

export function countRecentCustomFeedItems(db: Db, sinceMs: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM feed_items WHERE source_label = 'custom-feed' AND created_at >= ?`)
    .get(sinceMs) as { n: number }
  return row.n
}

export function listRecentFeedDedupeInfo(
  db: Db,
  sinceMs: number,
  limit = 60,
): { titles: Set<string>; urls: Set<string>; summaryLines: string[] } {
  const rows = db
    .prepare(
      `SELECT title, body_json FROM feed_items WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sinceMs, limit) as Array<{ title: string; body_json: string }>
  const titles = new Set<string>()
  const urls = new Set<string>()
  const summaryLines: string[] = []
  for (const r of rows) {
    const norm = normalizeDedupeText(r.title)
    if (norm.length >= 6) titles.add(norm)
    const body = parseJsonObject(r.body_json) as FeedItemBody
    const itemUrls: string[] = []
    for (const s of body.sources ?? []) {
      if (typeof s?.url === 'string' && s.url.trim()) {
        const normUrl = s.url.trim().replace(/#.*$/, '').replace(/\/$/, '').toLowerCase()
        urls.add(normUrl)
        itemUrls.push(s.url.trim())
      }
    }
    if (summaryLines.length < 25) {
      summaryLines.push(`- ${r.title}${itemUrls[0] ? ` (${itemUrls[0]})` : ''}`)
    }
  }
  return { titles, urls, summaryLines }
}

export function isDuplicateCustomFeedCard(
  db: Db,
  input: { title: string; sources?: Array<{ url: string }>; sinceMs: number },
): boolean {
  const dedupe = listRecentFeedDedupeInfo(db, input.sinceMs)
  const normTitle = normalizeDedupeText(input.title)
  if (normTitle.length >= 6 && dedupe.titles.has(normTitle)) return true
  const srcUrls = (input.sources ?? [])
    .map((s) => s.url.trim().replace(/#.*$/, '').replace(/\/$/, '').toLowerCase())
    .filter(Boolean)
  if (srcUrls.length > 0 && srcUrls.every((u) => dedupe.urls.has(u))) return true
  return false
}

export function createTodo(
  db: Db,
  input: {
    title: string
    detail?: string
    ownerBotId?: string | null
    sourceThreadId?: string | null
    origin?: 'auto' | 'operator'
    tainted?: boolean
    now?: number
  },
): TodoRow {
  const id = `todo-${randomBytes(4).toString('hex')}`
  const at = input.now ?? Date.now()
  db.prepare(
    `INSERT INTO todos (id, title, detail, status, owner_bot_id, source_thread_id, origin, tainted, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title.trim().slice(0, 140),
    (input.detail ?? '').trim().slice(0, 800),
    input.ownerBotId ?? null,
    input.sourceThreadId ?? null,
    input.origin === 'operator' ? 'operator' : 'auto',
    input.tainted ? 1 : 0,
    at,
    at,
  )
  return getTodo(db, id)!
}

export function getTodo(db: Db, id: string): TodoRow | null {
  if (!isTodoId(id)) return null
  const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as RawTodoRow | undefined
  return row ? mapTodoRow(row) : null
}

export function listTodos(db: Db, opts: { includeDismissed?: boolean; limit?: number } = {}): TodoRow[] {
  const where = opts.includeDismissed ? '' : `WHERE status != 'dismissed'`
  const limit = Math.min(200, Math.max(1, opts.limit ?? 80))
  const rows = db
    .prepare(
      `SELECT * FROM todos ${where}
       ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END ASC, updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as RawTodoRow[]
  return rows.map(mapTodoRow)
}

export function updateTodo(
  db: Db,
  id: string,
  patch: { title?: string; detail?: string; status?: TodoStatus; ownerBotId?: string | null; now?: number },
): TodoRow | null {
  const existing = getTodo(db, id)
  if (!existing) return null
  const title = patch.title !== undefined ? patch.title.trim().slice(0, 140) : existing.title
  const detail = patch.detail !== undefined ? patch.detail.trim().slice(0, 800) : existing.detail
  const status = patch.status !== undefined ? normalizeTodoStatus(patch.status) : existing.status
  const ownerBotId = patch.ownerBotId !== undefined ? patch.ownerBotId : existing.ownerBotId
  const at = patch.now ?? Date.now()
  db.prepare('UPDATE todos SET title = ?, detail = ?, status = ?, owner_bot_id = ?, updated_at = ? WHERE id = ?')
    .run(title, detail, status, ownerBotId, at, id)
  return getTodo(db, id)
}

export function deleteTodo(db: Db, id: string): boolean {
  if (!isTodoId(id)) return false
  return db.prepare('DELETE FROM todos WHERE id = ?').run(id).changes > 0
}
