import { recordAction } from '../actions.js'
import { insertMessage, type Db, type MessageRow } from '../db.js'
import type { Hub } from '../hub.js'
import { validateReportPayload, type ReportPayload } from '../report.js'
import { normalizeMode, type RoutineMode } from '../routines.js'

export type QuietHoursConfig = {
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
}

export type QuietDigestItemRow = {
  id: number
  bot_id: string
  thread_id: string
  routine_id: number | null
  routine_name: string
  routine_mode: RoutineMode
  kind: 'report' | 'text'
  summary: string
  payload_json: string | null
  created_at: number
  delivered_at: number | null
}

export type QuietDigestEntry = {
  id: number
  routineId: number | null
  routineName: string
  routineMode: RoutineMode
  kind: 'report' | 'text'
  summary: string
  report?: ReportPayload
  text?: string
  createdAt: number
}

export type QuietDigestPayload = {
  windowStart: string
  windowEnd: string
  itemCount: number
  items: QuietDigestEntry[]
  flushedManually?: boolean
}

export type QuietDigestSummary = {
  enabled: boolean
  active: boolean
  start: string
  end: string
  timeZone: string
  pendingCount: number
  byBot: Array<{ botId: string; count: number; latestAt: number }>
}

export type QuietDigestFlushResult = {
  flushed: number
  threads: string[]
  messages: MessageRow[]
}

export type EnqueueQuietDigestInput = {
  botId: string
  threadId: string
  routineId?: number | null
  routineName?: string
  routineMode?: RoutineMode
  kind: 'report' | 'text'
  summary: string
  payload?: unknown
  now?: number
  hub?: Hub
}

const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Parse strict 24-hour "HH:MM" into minutes since midnight [0, 1439], or null if invalid. */
export function parseHhMm(value: string): number | null {
  if (typeof value !== 'string') return null
  const m = HH_MM_RE.exec(value.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** Return minutes since midnight [0, 1439] for `now` in the given IANA timezone (or system local time). */
export function localMinutesOfDay(now: Date, timeZone?: string): number {
  if (timeZone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
      const parts = fmt.formatToParts(now)
      const rawHour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
      const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
      const hour = rawHour === 24 ? 0 : rawHour % 24
      return hour * 60 + minute
    } catch {
      // Unrecognized timezone name: fall back to system local time.
    }
  }
  return now.getHours() * 60 + now.getMinutes()
}

/**
 * Evaluate whether `now` falls inside the half-open quiet window `[start, end)` in `timeZone`.
 * Supports overnight wrap (`start > end`, e.g. `22:00`–`08:00`) and same-day windows (`start < end`).
 * Returns `false` when disabled, invalid, or `start === end`.
 */
export function isInQuietHours(now: Date, cfg: QuietHoursConfig, timeZone?: string): boolean {
  if (!cfg.quietHoursEnabled) return false
  const start = parseHhMm(cfg.quietHoursStart)
  const end = parseHhMm(cfg.quietHoursEnd)
  if (start === null || end === null || start === end) return false
  const minute = localMinutesOfDay(now, timeZone)
  if (start < end) return minute >= start && minute < end
  return minute >= start || minute < end
}

type RawDigestRow = Omit<QuietDigestItemRow, 'routine_mode' | 'kind'> & {
  routine_mode: string
  kind: string
}

function normalizeDigestRow(row: RawDigestRow): QuietDigestItemRow {
  return {
    ...row,
    routine_id: row.routine_id ?? null,
    routine_mode: normalizeMode(row.routine_mode),
    kind: row.kind === 'report' ? 'report' : 'text',
    payload_json: row.payload_json ?? null,
    delivered_at: row.delivered_at ?? null,
  }
}

export function enqueueQuietDigestItem(db: Db, input: EnqueueQuietDigestInput): QuietDigestItemRow {
  const at = input.now ?? Date.now()
  const routineMode = normalizeMode(input.routineMode ?? 'watch')
  const kind: 'report' | 'text' = input.kind === 'report' ? 'report' : 'text'
  const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload)
  const info = db.prepare(
    `INSERT INTO quiet_digest_items
       (bot_id, thread_id, routine_id, routine_name, routine_mode, kind, summary, payload_json, created_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.botId,
    input.threadId,
    input.routineId ?? null,
    (input.routineName ?? '').trim(),
    routineMode,
    kind,
    input.summary.trim(),
    payloadJson,
    at,
  )
  const raw = db.prepare('SELECT * FROM quiet_digest_items WHERE id = ?').get(Number(info.lastInsertRowid)) as RawDigestRow
  input.hub?.broadcast({ type: 'quiet_digest_changed' })
  return normalizeDigestRow(raw)
}

export function listPendingDigestItems(db: Db, botId?: string): QuietDigestItemRow[] {
  const rows = botId
    ? (db.prepare(
      'SELECT * FROM quiet_digest_items WHERE delivered_at IS NULL AND bot_id = ? ORDER BY id ASC',
    ).all(botId) as RawDigestRow[])
    : (db.prepare(
      'SELECT * FROM quiet_digest_items WHERE delivered_at IS NULL ORDER BY id ASC',
    ).all() as RawDigestRow[])
  return rows.map(normalizeDigestRow)
}

export function getQuietDigestSummary(
  db: Db,
  opts: { now?: Date; cfg: QuietHoursConfig; timeZone?: string },
): QuietDigestSummary {
  const now = opts.now ?? new Date()
  const resolvedTimeZone = opts.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const rows = db.prepare(
    `SELECT bot_id, COUNT(*) AS count, MAX(created_at) AS latest_at
     FROM quiet_digest_items
     WHERE delivered_at IS NULL
     GROUP BY bot_id
     ORDER BY latest_at DESC, bot_id ASC`,
  ).all() as Array<{ bot_id: string; count: number; latest_at: number }>
  const byBot = rows.map((r) => ({ botId: r.bot_id, count: r.count, latestAt: r.latest_at }))
  const pendingCount = byBot.reduce((sum, b) => sum + b.count, 0)
  return {
    enabled: opts.cfg.quietHoursEnabled,
    active: isInQuietHours(now, opts.cfg, opts.timeZone),
    start: opts.cfg.quietHoursStart,
    end: opts.cfg.quietHoursEnd,
    timeZone: resolvedTimeZone,
    pendingCount,
    byBot,
  }
}

function parseDigestEntry(row: QuietDigestItemRow): QuietDigestEntry {
  const kind: 'report' | 'text' = row.kind === 'report' ? 'report' : 'text'
  let parsed: unknown = null
  if (row.payload_json) {
    try {
      parsed = JSON.parse(row.payload_json)
    } catch {
      parsed = null
    }
  }
  const entry: QuietDigestEntry = {
    id: row.id,
    routineId: row.routine_id ?? null,
    routineName: row.routine_name,
    routineMode: normalizeMode(row.routine_mode),
    kind,
    summary: row.summary,
    createdAt: row.created_at,
  }
  if (kind === 'report') {
    const report = validateReportPayload(parsed)
      ?? (parsed && typeof parsed === 'object' ? validateReportPayload((parsed as { report?: unknown }).report) : null)
    if (report) entry.report = report
  } else {
    const rawText = parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string'
      ? (parsed as { text: string }).text
      : typeof parsed === 'string'
        ? parsed
        : ''
    const text = rawText.trim() ? rawText : row.summary
    if (text) entry.text = text
  }
  return entry
}

export function flushQuietDigests(
  db: Db,
  opts: { hub?: Hub; now?: number; windowStart: string; windowEnd: string; botId?: string; manual?: boolean },
): QuietDigestFlushResult {
  const at = opts.now ?? Date.now()

  const result = db.transaction((): QuietDigestFlushResult => {
    const pending = listPendingDigestItems(db, opts.botId)
    if (pending.length === 0) return { flushed: 0, threads: [], messages: [] }

    const groups = new Map<string, { botId: string; threadId: string; rows: QuietDigestItemRow[] }>()
    for (const row of pending) {
      const key = `${row.bot_id}\0${row.thread_id}`
      let group = groups.get(key)
      if (!group) {
        group = { botId: row.bot_id, threadId: row.thread_id, rows: [] }
        groups.set(key, group)
      }
      group.rows.push(row)
    }

    const markDelivered = db.prepare(
      'UPDATE quiet_digest_items SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
    )
    let flushed = 0
    const messages: MessageRow[] = []
    const threadSet = new Set<string>()

    for (const group of groups.values()) {
      const claimed: QuietDigestItemRow[] = []
      for (const row of group.rows) {
        if (markDelivered.run(at, row.id).changes > 0) claimed.push(row)
      }
      if (claimed.length === 0) continue

      flushed += claimed.length
      const items = claimed.map(parseDigestEntry)
      const payload: QuietDigestPayload = {
        windowStart: opts.windowStart,
        windowEnd: opts.windowEnd,
        itemCount: items.length,
        items,
        ...(opts.manual ? { flushedManually: true } : {}),
      }
      const message = insertMessage(db, {
        threadId: group.threadId,
        sender: group.botId,
        kind: 'quiet_digest',
        payload,
      })
      messages.push(message)
      threadSet.add(group.threadId)
      recordAction(db, {
        botId: group.botId,
        threadId: group.threadId,
        trigger: 'routine',
        tool: 'quiet_digest',
        summary: `delivered ${items.length} ${items.length === 1 ? 'update' : 'updates'}${opts.manual ? ' (manual)' : ''}`,
        ok: true,
        at,
      })
    }

    return { flushed, threads: [...threadSet], messages }
  })()

  if (result.flushed > 0) {
    for (const message of result.messages) {
      opts.hub?.broadcast({ type: 'message', threadId: message.thread_id, message })
    }
    opts.hub?.broadcast({ type: 'quiet_digest_changed' })
  }

  return result
}
