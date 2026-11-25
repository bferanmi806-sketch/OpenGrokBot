import { ensureDmThread, insertMessage, type Db, type MessageRow } from '../db.js'
import { createFeedItem } from '../feed/store.js'
import { projectReportToFeed } from '../feed/tools.js'
import type { Hub } from '../hub.js'
import { validateReportPayload, type ReportPayload } from '../report.js'
import { normalizeMode, type RoutineMode, type RoutineSurface } from '../routines.js'
import { markWikiSyncThreadTainted } from '../wiki/auto-sync.js'
import { markDreamThreadTainted } from './dreaming.js'
import { enqueueQuietDigestItem } from './quiet-hours.js'

export const DEFAULT_QUIET_CHAT_MS = 3 * 60_000
export const DEFAULT_WEBHOOK_COALESCE_MS = 60_000
export const DEFAULT_DAILY_NON_URGENT_CAP = 5
export const MAX_COALESCED_EVENTS = 10
export const MAX_QUEUED_WEBHOOK_EVENTS = 50
export const MAX_COALESCED_CHARS = 256 * 1024

export type ProactivePacingOptions = {
  quietChatMs?: number
  webhookCoalesceMs?: number
  dailyNonUrgentCap?: number
}

export type ProactivePacingConfig = {
  enabled: boolean
  quietChatMs: number
  webhookCoalesceMs: number
  dailyNonUrgentCap: number
}

function resolveNonNegativeInt(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.trunc(raw)
  }
  return fallback
}

export function normalizeProactivePacing(
  raw?: boolean | ProactivePacingOptions,
): ProactivePacingConfig {
  if (!raw) {
    return {
      enabled: false,
      quietChatMs: 0,
      webhookCoalesceMs: 0,
      dailyNonUrgentCap: 0,
    }
  }
  if (raw === true) {
    return {
      enabled: true,
      quietChatMs: DEFAULT_QUIET_CHAT_MS,
      webhookCoalesceMs: DEFAULT_WEBHOOK_COALESCE_MS,
      dailyNonUrgentCap: DEFAULT_DAILY_NON_URGENT_CAP,
    }
  }
  const quietChatMs = resolveNonNegativeInt(raw.quietChatMs, DEFAULT_QUIET_CHAT_MS)
  const webhookCoalesceMs = resolveNonNegativeInt(raw.webhookCoalesceMs, DEFAULT_WEBHOOK_COALESCE_MS)
  const dailyNonUrgentCap = resolveNonNegativeInt(raw.dailyNonUrgentCap, DEFAULT_DAILY_NON_URGENT_CAP)
  return {
    enabled: quietChatMs > 0 || webhookCoalesceMs > 0 || dailyNonUrgentCap > 0,
    quietChatMs,
    webhookCoalesceMs,
    dailyNonUrgentCap,
  }
}

export function startOfLocalDayMs(now: Date, timeZone?: string): number {
  if (timeZone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
      const read = (d: Date) =>
        Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, Number(p.value)]))
      const p = read(now)
      const pHour = p.hour === 24 ? 0 : (p.hour! % 24)
      const nowUtc = Date.UTC(
        p.year!,
        p.month! - 1,
        p.day!,
        pHour,
        p.minute!,
        p.second!,
        now.getUTCMilliseconds(),
      )
      const approx = Date.UTC(p.year!, p.month! - 1, p.day!, 0, 0, 0, 0) - (nowUtc - now.getTime())
      const mp = read(new Date(approx))
      const mpHour = mp.hour === 24 ? 0 : (mp.hour! % 24)
      const mUtc = Date.UTC(mp.year!, mp.month! - 1, mp.day!, mpHour, mp.minute!, mp.second!, 0)
      return Date.UTC(p.year!, p.month! - 1, p.day!, 0, 0, 0, 0) - (mUtc - approx)
    } catch {
      // Fallback to host local midnight when timezone identifier is unrecognized
    }
  }
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

export type WebhookEnqueueResult =
  | { ok: true }
  | { ok: false; reason: 'queue_full' }

export type WebhookCoalescer = {
  enqueue(routineId: number, payload: string): WebhookEnqueueResult
  notifyRoutineIdle(routineId: number): void
  cancel(routineId: number): void
  stopAll(): void
}

type CoalesceBucket = {
  events: string[]
  timer: ReturnType<typeof setTimeout> | null
  readyWhenIdle: boolean
  inFlightFlush: Promise<void> | null
}

function formatCoalescedBatch(batch: string[]): string {
  if (batch.length === 0) return ''
  if (batch.length === 1) return batch[0]!
  return batch
    .map((body, idx) => `--- Event ${idx + 1}/${batch.length} ---\n${body}`)
    .join('\n\n')
}

export function createWebhookCoalescer(deps: {
  coalesceMs: number
  isRoutineRunning: (routineId: number) => boolean
  onFlush: (
    routineId: number,
    combinedPayload: string,
  ) => Promise<'ran' | 'skipped' | 'gone' | void> | 'ran' | 'skipped' | 'gone' | void
}): WebhookCoalescer {
  const buckets = new Map<number, CoalesceBucket>()
  let stopped = false

  function getBucket(routineId: number): CoalesceBucket {
    let bucket = buckets.get(routineId)
    if (!bucket) {
      bucket = { events: [], timer: null, readyWhenIdle: false, inFlightFlush: null }
      buckets.set(routineId, bucket)
    }
    return bucket
  }

  function clearBucketTimer(bucket: CoalesceBucket): void {
    if (bucket.timer) {
      clearTimeout(bucket.timer)
      bucket.timer = null
    }
  }

  function wouldOverflowCurrentBatch(events: string[]): boolean {
    if (events.length >= MAX_COALESCED_EVENTS) return true
    let approxChars = 0
    for (const ev of events) {
      approxChars += ev.length + 32
      if (approxChars >= MAX_COALESCED_CHARS) return true
    }
    return false
  }

  function popNextBatch(bucket: CoalesceBucket): string[] {
    const batch: string[] = []
    let charsUsed = 0
    while (bucket.events.length > 0 && batch.length < MAX_COALESCED_EVENTS) {
      const next = bucket.events[0]!.slice(0, MAX_COALESCED_CHARS)
      const overhead = batch.length === 0 ? 0 : 32
      if (batch.length > 0 && charsUsed + next.length + overhead > MAX_COALESCED_CHARS) {
        break
      }
      bucket.events.shift()
      batch.push(next)
      charsUsed += next.length + overhead
    }
    return batch
  }

  function tryFlush(routineId: number): void {
    if (stopped) return
    const bucket = buckets.get(routineId)
    if (!bucket) return
    if (bucket.events.length === 0) {
      clearBucketTimer(bucket)
      if (!bucket.inFlightFlush) buckets.delete(routineId)
      return
    }

    if (bucket.inFlightFlush || deps.isRoutineRunning(routineId)) {
      bucket.readyWhenIdle = true
      return
    }

    clearBucketTimer(bucket)
    const batch = popNextBatch(bucket)
    if (batch.length === 0) return

    bucket.readyWhenIdle = bucket.events.length > 0
    const combined = formatCoalescedBatch(batch)

    // Invoke deps.onFlush synchronously before awaiting so routinesInFlight is claimed without microtask race (I3.2)
    let rawOutcome: Promise<'ran' | 'skipped' | 'gone' | void>
    try {
      rawOutcome = Promise.resolve(deps.onFlush(routineId, combined))
    } catch {
      rawOutcome = Promise.resolve()
    }

    const flushTask = rawOutcome
      .then((outcome) => {
        if (stopped) return
        if (outcome === 'skipped' && deps.isRoutineRunning(routineId)) {
          // Concurrent manual/cron run beat us to routinesInFlight: re-queue batch for idle retry without dropping!
          const spaceLeft = Math.max(0, MAX_QUEUED_WEBHOOK_EVENTS - bucket.events.length)
          if (spaceLeft > 0) {
            bucket.events.unshift(...batch.slice(0, spaceLeft))
          }
          bucket.readyWhenIdle = bucket.events.length > 0
        }
      })
      .catch(() => {})
      .finally(() => {
        bucket.inFlightFlush = null
        if (stopped) return
        if (bucket.events.length === 0 && !bucket.timer) {
          buckets.delete(routineId)
          return
        }
        if (bucket.readyWhenIdle && !deps.isRoutineRunning(routineId)) {
          tryFlush(routineId)
        }
      })

    bucket.inFlightFlush = flushTask
  }

  return {
    enqueue(routineId, payload) {
      if (stopped) return { ok: true }
      const bucket = getBucket(routineId)
      if (bucket.events.length >= MAX_QUEUED_WEBHOOK_EVENTS) {
        return { ok: false, reason: 'queue_full' }
      }
      bucket.events.push(payload.slice(0, MAX_COALESCED_CHARS))

      if (wouldOverflowCurrentBatch(bucket.events) || deps.coalesceMs <= 0) {
        clearBucketTimer(bucket)
        tryFlush(routineId)
        return { ok: true }
      }

      if (!bucket.timer && !bucket.readyWhenIdle) {
        bucket.timer = setTimeout(() => {
          bucket.timer = null
          tryFlush(routineId)
        }, deps.coalesceMs)
        bucket.timer.unref?.()
      }
      return { ok: true }
    },

    notifyRoutineIdle(routineId) {
      if (stopped) return
      const bucket = buckets.get(routineId)
      if (!bucket) return
      if (bucket.readyWhenIdle && bucket.events.length > 0 && !bucket.inFlightFlush) {
        tryFlush(routineId)
      }
    },

    cancel(routineId) {
      const bucket = buckets.get(routineId)
      if (!bucket) return
      clearBucketTimer(bucket)
      bucket.events.length = 0
      bucket.readyWhenIdle = false
      if (!bucket.inFlightFlush) buckets.delete(routineId)
    },

    stopAll() {
      stopped = true
      for (const bucket of buckets.values()) {
        clearBucketTimer(bucket)
        bucket.events.length = 0
        bucket.readyWhenIdle = false
      }
      buckets.clear()
    },
  }
}

export type ProactiveDeferredRow = {
  id: number
  bot_id: string
  thread_id: string
  routine_id: number | null
  routine_name: string
  routine_mode: RoutineMode
  kind: 'report' | 'text'
  summary: string
  payload_json: string | null
  source_tainted: number
  created_at: number
  deliver_after: number
  delivered_at: number | null
}

type DeferredPayloadEnvelope = {
  __osbDeferredEnvelope: 1
  payload: unknown
  alreadyInFeed: boolean
}

function serializeDeferredPayload(payload: unknown, alreadyInFeed?: boolean): string | null {
  if (alreadyInFeed) {
    const env: DeferredPayloadEnvelope = {
      __osbDeferredEnvelope: 1,
      payload: payload ?? null,
      alreadyInFeed: true,
    }
    return JSON.stringify(env)
  }
  return payload === undefined ? null : JSON.stringify(payload)
}

function unwrapDeferredPayload(rawJson: string | null): {
  payload: unknown
  alreadyInFeed: boolean
} {
  if (!rawJson) return { payload: null, alreadyInFeed: false }
  try {
    const parsed = JSON.parse(rawJson) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { __osbDeferredEnvelope?: unknown }).__osbDeferredEnvelope === 1
    ) {
      const env = parsed as DeferredPayloadEnvelope
      return {
        payload: env.payload,
        alreadyInFeed: env.alreadyInFeed === true,
      }
    }
    return { payload: parsed, alreadyInFeed: false }
  } catch {
    return { payload: null, alreadyInFeed: false }
  }
}

export function shouldDeferForActiveChat(
  db: Db,
  params: {
    threadId: string
    isThreadBusy?: (threadId: string) => boolean
    nowMs: number
    quietChatMs: number
  },
): { defer: false } | { defer: true; deliverAfter: number } {
  const { threadId, isThreadBusy, nowMs, quietChatMs } = params
  const busy = Boolean(isThreadBusy?.(threadId))

  if (quietChatMs > 0) {
    const lastUserRow = db
      .prepare(
        `SELECT MAX(created_at) AS last_at
         FROM messages
         WHERE thread_id = ? AND sender = 'user'`,
      )
      .get(threadId) as { last_at: number | null } | undefined
    const lastUserAt = lastUserRow?.last_at ?? null
    if (lastUserAt !== null && nowMs - lastUserAt < quietChatMs) {
      return {
        defer: true,
        deliverAfter: Math.max(nowMs + 1, lastUserAt + quietChatMs),
      }
    }
  }

  if (busy) {
    const stepWait = quietChatMs > 0 ? Math.min(15_000, quietChatMs) : 5_000
    return {
      defer: true,
      deliverAfter: nowMs + Math.max(1_000, stepWait),
    }
  }

  return { defer: false }
}

export function enqueueDeferredProactive(
  db: Db,
  input: {
    botId: string
    threadId: string
    routineId?: number | null
    routineName?: string
    routineMode?: RoutineMode
    kind: 'report' | 'text'
    summary: string
    payload?: unknown
    alreadyInFeed?: boolean
    sourceTainted?: boolean
    createdAt: number
    deliverAfter: number
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO proactive_deferred
         (bot_id, thread_id, routine_id, routine_name, routine_mode, kind, summary, payload_json, source_tainted, created_at, deliver_after, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      input.botId,
      input.threadId,
      input.routineId ?? null,
      (input.routineName ?? '').trim(),
      normalizeMode(input.routineMode ?? 'watch'),
      input.kind === 'report' ? 'report' : 'text',
      input.summary.trim(),
      serializeDeferredPayload(input.payload, input.alreadyInFeed),
      input.sourceTainted ? 1 : 0,
      input.createdAt,
      input.deliverAfter,
    )
  return Number(info.lastInsertRowid)
}

export function recordImmediateProactiveDelivery(
  db: Db,
  input: {
    botId: string
    threadId: string
    routineId?: number | null
    routineName?: string
    routineMode?: RoutineMode
    kind: 'report' | 'text'
    summary: string
    sourceTainted?: boolean
    nowMs: number
  },
): void {
  db.prepare(
    `INSERT INTO proactive_deferred
       (bot_id, thread_id, routine_id, routine_name, routine_mode, kind, summary, payload_json, source_tainted, created_at, deliver_after, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    input.botId,
    input.threadId,
    input.routineId ?? null,
    (input.routineName ?? '').trim(),
    normalizeMode(input.routineMode ?? 'watch'),
    input.kind === 'report' ? 'report' : 'text',
    input.summary.trim(),
    input.sourceTainted ? 1 : 0,
    input.nowMs,
    input.nowMs,
    input.nowMs,
  )
}

export function pruneDeferredProactive(db: Db, cutoffMs: number): number {
  if (!db.open) return 0
  return db
    .prepare('DELETE FROM proactive_deferred WHERE delivered_at IS NOT NULL AND delivered_at < ?')
    .run(cutoffMs).changes
}

export function countDeliveredNonUrgentProactiveToday(
  db: Db,
  params: { botId: string; nowMs: number; timeZone?: string },
): number {
  const dayStart = startOfLocalDayMs(new Date(params.nowMs), params.timeZone)
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) FROM proactive_deferred
         WHERE bot_id = ?
           AND delivered_at IS NOT NULL
           AND delivered_at >= ?
           AND kind IN ('text', 'report')`,
      )
      .pluck()
      .get(params.botId, dayStart) ?? 0,
  )
}

export function writeOverflowToFeedAndDigest(
  db: Db,
  params: {
    botId: string
    threadId: string
    routineId?: number | null
    routineName?: string
    routineMode: RoutineMode
    kind: 'report' | 'text'
    summary: string
    payload?: unknown
    alreadyInFeed?: boolean
    nowMs: number
    hub?: Hub
  },
): void {
  enqueueQuietDigestItem(db, {
    botId: params.botId,
    threadId: params.threadId,
    routineId: params.routineId ?? null,
    routineName: params.routineName ?? '',
    routineMode: params.routineMode,
    kind: params.kind,
    summary: params.summary,
    payload: params.payload,
    now: params.nowMs,
    hub: params.hub,
  })

  if (!params.alreadyInFeed) {
    const validReport =
      params.kind === 'report' ? validateReportPayload(params.payload) : null
    const firstLine = validReport?.lines[0]
    const cleanRoutineName = params.routineName?.trim() ?? ''
    const title = validReport
      ? cleanRoutineName
        ? `${cleanRoutineName}${firstLine ? ` · ${firstLine.result}` : ''}`
        : firstLine
          ? `${firstLine.system} → ${firstLine.result}`
          : 'Proactive report'
      : cleanRoutineName || params.summary.trim().slice(0, 80) || 'Proactive update'

    // Routine-originated Feed items always carry tainted: true matching feed/tools.ts (I4.2)
    createFeedItem(db, {
      kind: params.routineMode === 'watch' ? 'signal' : 'briefing',
      botId: params.botId,
      threadId: params.threadId,
      title,
      summary: params.summary.trim().slice(0, 1200),
      body: validReport ? { report: validReport } : {},
      tainted: true,
      sourceLabel: params.routineMode === 'watch' ? 'watch' : 'routine',
      now: params.nowMs,
    })
    params.hub?.broadcast({ type: 'feed_changed' })
  }
}

export function interceptRoutineProactiveOutput(
  db: Db,
  params: {
    pacing: ProactivePacingConfig
    botId: string
    threadId: string
    routineId?: number | null
    routineName?: string
    routineMode: RoutineMode
    kind: 'report' | 'text'
    summary: string
    payload: unknown
    tainted: boolean
    alreadyInFeed?: boolean
    isInteractiveBusy?: (threadId: string) => boolean
    timeZone?: string
    nowMs: number
    hub?: Hub
  },
): { intercepted: boolean; reason?: 'deferred' | 'daily_cap'; deliverAfter?: number } {
  const { pacing } = params
  if (!pacing.enabled) return { intercepted: false }

  // 1. Dimension 2 — 3-minute active-chat deferral
  if (pacing.quietChatMs > 0) {
    const deferCheck = shouldDeferForActiveChat(db, {
      threadId: params.threadId,
      isThreadBusy: params.isInteractiveBusy,
      nowMs: params.nowMs,
      quietChatMs: pacing.quietChatMs,
    })
    if (deferCheck.defer) {
      enqueueDeferredProactive(db, {
        botId: params.botId,
        threadId: params.threadId,
        routineId: params.routineId ?? null,
        routineName: params.routineName ?? '',
        routineMode: params.routineMode,
        kind: params.kind,
        summary: params.summary,
        payload: params.payload,
        alreadyInFeed: params.alreadyInFeed,
        sourceTainted: params.tainted,
        createdAt: params.nowMs,
        deliverAfter: deferCheck.deliverAfter,
      })
      return { intercepted: true, reason: 'deferred', deliverAfter: deferCheck.deliverAfter }
    }
  }

  // 2. Dimension 3 — Daily non-urgent cap
  if (pacing.dailyNonUrgentCap > 0) {
    const deliveredToday = countDeliveredNonUrgentProactiveToday(db, {
      botId: params.botId,
      nowMs: params.nowMs,
      timeZone: params.timeZone,
    })
    if (deliveredToday >= pacing.dailyNonUrgentCap) {
      writeOverflowToFeedAndDigest(db, {
        botId: params.botId,
        threadId: params.threadId,
        routineId: params.routineId ?? null,
        routineName: params.routineName ?? '',
        routineMode: params.routineMode,
        kind: params.kind,
        summary: params.summary,
        payload: params.payload,
        alreadyInFeed: params.alreadyInFeed,
        nowMs: params.nowMs,
        hub: params.hub,
      })
      return { intercepted: true, reason: 'daily_cap' }
    }
  }

  // 3. Deliver immediately to thread -> record in proactive_deferred as settled for today's counter
  recordImmediateProactiveDelivery(db, {
    botId: params.botId,
    threadId: params.threadId,
    routineId: params.routineId ?? null,
    routineName: params.routineName ?? '',
    routineMode: params.routineMode,
    kind: params.kind,
    summary: params.summary,
    sourceTainted: params.tainted,
    nowMs: params.nowMs,
  })
  return { intercepted: false }
}

type RawDeferredRow = Omit<ProactiveDeferredRow, 'routine_mode' | 'kind'> & {
  routine_mode: string
  kind: string
}

export function flushDeferredProactive(
  db: Db,
  deps: {
    pacing: ProactivePacingConfig
    hub?: Hub
    timeZone?: string
    nowMs: number
    isThreadBusy?: (threadId: string) => boolean
    isQuietHoursActive?: (nowMs: number) => boolean
    feedSurfaceForRoutine?: (routineId: number | null, mode: RoutineMode) => RoutineSurface
  },
): number {
  if (!db.open) return 0

  const dueRows = db
    .prepare(
      `SELECT * FROM proactive_deferred
       WHERE delivered_at IS NULL AND deliver_after <= ?
       ORDER BY id ASC`,
    )
    .all(deps.nowMs) as RawDeferredRow[]

  if (dueRows.length === 0) return 0

  let flushed = 0

  for (const rawRow of dueRows) {
    // Skip and drop orphan deferred items if the teammate was deleted before flush (I4.1)
    const botExists = db.prepare('SELECT 1 FROM bots WHERE id = ?').get(rawRow.bot_id)
    if (!botExists) {
      db.prepare(
        `UPDATE proactive_deferred
         SET delivered_at = ?, kind = 'dropped'
         WHERE id = ? AND delivered_at IS NULL`,
      ).run(deps.nowMs, rawRow.id)
      continue
    }

    const routineMode = normalizeMode(rawRow.routine_mode)
    const kind: 'report' | 'text' = rawRow.kind === 'report' ? 'report' : 'text'

    // Re-check whether the thread is still busy or operator spoke within quietChatMs
    const deferCheck = shouldDeferForActiveChat(db, {
      threadId: rawRow.thread_id,
      isThreadBusy: deps.isThreadBusy,
      nowMs: deps.nowMs,
      quietChatMs: deps.pacing.quietChatMs,
    })
    if (deferCheck.defer) {
      db.prepare(
        'UPDATE proactive_deferred SET deliver_after = ? WHERE id = ? AND delivered_at IS NULL',
      ).run(deferCheck.deliverAfter, rawRow.id)
      continue
    }

    const { payload: parsedPayload, alreadyInFeed } = unwrapDeferredPayload(rawRow.payload_json)

    const inQuietHours =
      (routineMode === 'watch' || routineMode === 'prepare') &&
      Boolean(deps.isQuietHoursActive?.(deps.nowMs))

    if (inQuietHours) {
      const claimed = db
        .prepare(
          `UPDATE proactive_deferred
           SET delivered_at = ?, kind = 'quiet_buffered'
           WHERE id = ? AND delivered_at IS NULL`,
        )
        .run(deps.nowMs, rawRow.id)
      if (claimed.changes === 0) continue

      enqueueQuietDigestItem(db, {
        botId: rawRow.bot_id,
        threadId: rawRow.thread_id,
        routineId: rawRow.routine_id ?? null,
        routineName: rawRow.routine_name,
        routineMode,
        kind,
        summary: rawRow.summary,
        payload: parsedPayload ?? undefined,
        now: deps.nowMs,
        hub: deps.hub,
      })
      flushed += 1
      continue
    }

    if (deps.pacing.dailyNonUrgentCap > 0) {
      const deliveredToday = countDeliveredNonUrgentProactiveToday(db, {
        botId: rawRow.bot_id,
        nowMs: deps.nowMs,
        timeZone: deps.timeZone,
      })
      if (deliveredToday >= deps.pacing.dailyNonUrgentCap) {
        const claimed = db
          .prepare(
            `UPDATE proactive_deferred
             SET delivered_at = ?, kind = 'overflow'
             WHERE id = ? AND delivered_at IS NULL`,
          )
          .run(deps.nowMs, rawRow.id)
        if (claimed.changes === 0) continue

        writeOverflowToFeedAndDigest(db, {
          botId: rawRow.bot_id,
          threadId: rawRow.thread_id,
          routineId: rawRow.routine_id ?? null,
          routineName: rawRow.routine_name,
          routineMode,
          kind,
          summary: rawRow.summary,
          payload: parsedPayload ?? undefined,
          alreadyInFeed,
          nowMs: deps.nowMs,
          hub: deps.hub,
        })
        flushed += 1
        continue
      }
    }

    const deliveredMsg = db.transaction((): MessageRow | null => {
      const claimed = db
        .prepare(
          'UPDATE proactive_deferred SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
        )
        .run(deps.nowMs, rawRow.id)
      if (claimed.changes === 0) return null

      if (rawRow.thread_id === `dm:${rawRow.bot_id}`) {
        ensureDmThread(db, rawRow.bot_id)
      }

      let msg: MessageRow
      let validReport: ReportPayload | null = null
      if (kind === 'report') {
        validReport = validateReportPayload(parsedPayload)
      }

      if (validReport) {
        msg = insertMessage(db, {
          threadId: rawRow.thread_id,
          sender: rawRow.bot_id,
          kind: 'report',
          payload: validReport,
          createdAt: deps.nowMs,
        })
        const surface = deps.feedSurfaceForRoutine
          ? deps.feedSurfaceForRoutine(rawRow.routine_id ?? null, routineMode)
          : routineMode === 'watch'
            ? 'both'
            : 'thread'
        if (!alreadyInFeed && (routineMode === 'watch' || surface === 'feed' || surface === 'both')) {
          projectReportToFeed({
            db,
            hub: { add: () => {}, remove: () => {}, broadcast: () => {}, size: () => 0 },
            botId: rawRow.bot_id,
            threadId: rawRow.thread_id,
            message: msg,
            payload: validReport,
            watch: routineMode === 'watch',
            ...(rawRow.routine_name ? { routineName: rawRow.routine_name } : {}),
            ruleBlock: 'routine',
            sourceLabel: routineMode === 'watch' ? 'watch' : 'routine',
            now: deps.nowMs,
          })
        }
      } else {
        const text =
          parsedPayload &&
          typeof parsedPayload === 'object' &&
          typeof (parsedPayload as { text?: unknown }).text === 'string' &&
          (parsedPayload as { text: string }).text.trim()
            ? (parsedPayload as { text: string }).text
            : rawRow.summary
        msg = insertMessage(db, {
          threadId: rawRow.thread_id,
          sender: rawRow.bot_id,
          kind: 'text',
          content: text,
          createdAt: deps.nowMs,
        })
      }

      if (rawRow.source_tainted === 1) {
        markWikiSyncThreadTainted(db, rawRow.thread_id, deps.nowMs)
        markDreamThreadTainted(db, rawRow.thread_id, deps.nowMs, msg.id)
      }

      return msg
    })()

    if (!deliveredMsg) continue
    deps.hub?.broadcast({
      type: 'message',
      threadId: deliveredMsg.thread_id,
      message: deliveredMsg,
    })
    if (deliveredMsg.kind === 'report') {
      deps.hub?.broadcast({ type: 'feed_changed' })
    }
    flushed += 1
  }

  return flushed
}
