import { randomBytes } from 'node:crypto'
import { recordAction } from './actions.js'
import { getMessage, insertMessage, updateMessagePayload, type Db, type MessageRow } from './db.js'
import type { Hub } from './hub.js'

export const MAX_BG_TITLE_CHARS = 120
export const MAX_BG_INSTRUCTIONS_CHARS = 4000
export const MAX_BG_STEER_CHARS = 1000
export const MAX_BG_SUMMARY_CHARS = 1200
export const MAX_BG_ERROR_CHARS = 500
export const MAX_BG_STEPS = 25
export const MAX_ACTIVE_TASKS_PER_BOT = 6

export const STALE_RESTART_ERROR = 'Gateway restarted before this background task finished.'

export type BackgroundTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type BackgroundTaskStep = {
  tool: string
  summary: string
  ok?: boolean
  ms?: number
  at: number
}

export type BackgroundSteeringNote = {
  note: string
  tainted: boolean
}

export type BackgroundTaskRow = {
  id: string
  bot_id: string
  thread_id: string
  title: string
  instructions: string
  status: BackgroundTaskStatus
  step_count: number
  last_step: string
  steps_json: string
  summary: string
  error: string
  uses_browser: number
  source_tainted: number
  message_id: number | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

export type BackgroundTaskView = {
  id: string
  botId: string
  threadId: string
  title: string
  instructions: string
  status: BackgroundTaskStatus
  stepCount: number
  lastStep: string
  steps: BackgroundTaskStep[]
  summary: string
  error: string
  usesBrowser: boolean
  sourceTainted: boolean
  messageId: number | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type BackgroundTaskPayload = {
  taskId: string
  title: string
  status: BackgroundTaskStatus
  stepCount: number
  lastStep: string
  steps: BackgroundTaskStep[]
  summary?: string
  error?: string
  usesBrowser: boolean
  createdAt: number
  startedAt?: number | null
  finishedAt?: number | null
}

export type EnqueueBackgroundTaskInput = {
  botId: string
  threadId: string
  title: string
  instructions: string
  sourceTainted?: boolean
}

export type EnqueueBackgroundTaskResult =
  | { ok: true; task: BackgroundTaskView }
  | { ok: false; code: 'invalid_title' | 'invalid_instructions' | 'queue_full'; error: string }

export type SteerBackgroundTaskResult =
  | { ok: true; task: BackgroundTaskView }
  | { ok: false; code: 'not_found' | 'settled' | 'invalid_note'; error: string }

export type CancelBackgroundTaskResult =
  | { ok: true; task: BackgroundTaskView }
  | { ok: false; code: 'not_found' | 'settled'; error: string }

export type BackgroundTaskRunContext = {
  task: BackgroundTaskView
  signal: AbortSignal
  drainSteeringNotes: () => BackgroundSteeringNote[]
  recordStep: (step: { tool: string; summary: string; ok?: boolean; ms?: number }) => void
  markUsesBrowser: () => void
  markTainted?: () => void
}

export type BackgroundTaskRunnerResult = {
  status?: 'completed' | 'failed' | 'cancelled'
  summary?: string
  error?: string
  tainted?: boolean
}

export type BackgroundTaskManagerOptions = {
  db: Db
  hub?: Hub
  now?: () => number
  runTask: (ctx: BackgroundTaskRunContext) => Promise<BackgroundTaskRunnerResult | void>
}

export type BackgroundTaskManager = {
  enqueue(input: EnqueueBackgroundTaskInput): EnqueueBackgroundTaskResult
  steer(taskId: string, rawNote: string, opts?: { botId?: string; tainted?: boolean }): SteerBackgroundTaskResult
  cancel(taskId: string, opts?: { botId?: string }): CancelBackgroundTaskResult
  hasActive(botId?: string): boolean
  activeCount(): number
  activeBotIds(): string[]
  stopAll(): Promise<void>
}

const VALID_STATUSES: ReadonlySet<string> = new Set<BackgroundTaskStatus>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])

const CONTROL_CHARS_EXCEPT_WS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

function normalizeStatus(raw: string): BackgroundTaskStatus {
  return VALID_STATUSES.has(raw) ? (raw as BackgroundTaskStatus) : 'failed'
}

function sanitizeSingleLine(raw: string, max: number): string {
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROL_CHARS_EXCEPT_WS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function sanitizeTitle(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const clean = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROL_CHARS_EXCEPT_WS, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean || clean.length > MAX_BG_TITLE_CHARS) return null
  return clean
}

function sanitizeInstructions(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const clean = raw.replace(CONTROL_CHARS_EXCEPT_WS, '').trim()
  if (!clean || clean.length > MAX_BG_INSTRUCTIONS_CHARS) return null
  return clean
}

function sanitizeSteerNote(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const clean = raw.replace(CONTROL_CHARS_EXCEPT_WS, '').trim()
  if (!clean || clean.length > MAX_BG_STEER_CHARS) return null
  return clean
}

function clampText(raw: string | undefined, max: number): string {
  if (typeof raw !== 'string') return ''
  const clean = raw.replace(CONTROL_CHARS_EXCEPT_WS, '').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 3))}...`
}

function formatLastStep(tool: string, summary: string): string {
  const combined = summary ? `${tool}: ${summary}` : tool
  return combined.slice(0, 200)
}

function parseSteps(raw: string): BackgroundTaskStep[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const steps: BackgroundTaskStep[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      if (
        typeof rec.tool !== 'string'
        || typeof rec.summary !== 'string'
        || typeof rec.at !== 'number'
        || !Number.isFinite(rec.at)
      ) {
        continue
      }
      const step: BackgroundTaskStep = {
        tool: rec.tool,
        summary: rec.summary,
        at: rec.at,
      }
      if (typeof rec.ok === 'boolean') step.ok = rec.ok
      if (typeof rec.ms === 'number' && Number.isFinite(rec.ms)) step.ms = rec.ms
      steps.push(step)
    }
    return steps
  } catch {
    return []
  }
}

export function rowToView(row: BackgroundTaskRow): BackgroundTaskView {
  return {
    id: row.id,
    botId: row.bot_id,
    threadId: row.thread_id,
    title: row.title,
    instructions: row.instructions,
    status: normalizeStatus(row.status),
    stepCount: Number.isFinite(row.step_count) ? row.step_count : 0,
    lastStep: row.last_step ?? '',
    steps: parseSteps(row.steps_json),
    summary: row.summary ?? '',
    error: row.error ?? '',
    usesBrowser: row.uses_browser === 1,
    sourceTainted: row.source_tainted === 1,
    messageId: row.message_id ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  }
}

export function viewToPayload(view: BackgroundTaskView): BackgroundTaskPayload {
  return {
    taskId: view.id,
    title: view.title,
    status: view.status,
    stepCount: view.stepCount,
    lastStep: view.lastStep,
    steps: view.steps,
    ...(view.summary ? { summary: view.summary } : {}),
    ...(view.error ? { error: view.error } : {}),
    usesBrowser: view.usesBrowser,
    createdAt: view.createdAt,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt,
  }
}

function getTaskRow(db: Db, id: string): BackgroundTaskRow | null {
  if (typeof id !== 'string' || !id.trim()) return null
  return (db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(id) as BackgroundTaskRow | undefined) ?? null
}

export function getBackgroundTask(db: Db, id: string): BackgroundTaskView | null {
  const row = getTaskRow(db, id)
  return row ? rowToView(row) : null
}

export function listBackgroundTasks(
  db: Db,
  opts: { botId?: string; status?: BackgroundTaskStatus; limit?: number } = {},
): BackgroundTaskView[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.botId) {
    clauses.push('bot_id = ?')
    params.push(opts.botId)
  }
  if (opts.status) {
    clauses.push('status = ?')
    params.push(opts.status)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rawLimit = opts.limit !== undefined && Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 20
  const limit = Math.max(1, Math.min(rawLimit, 200))
  params.push(limit)
  const rows = db.prepare(
    `SELECT * FROM background_tasks ${where}
     ORDER BY CASE WHEN status IN ('running', 'queued') THEN 0 ELSE 1 END, created_at DESC, rowid DESC
     LIMIT ?`,
  ).all(...params) as BackgroundTaskRow[]
  return rows.map(rowToView)
}

function patchTaskMessage(db: Db, view: BackgroundTaskView): MessageRow | null {
  if (view.messageId === null) return null
  const existing = getMessage(db, view.messageId)
  if (!existing || existing.kind !== 'background_task') return null
  updateMessagePayload(db, existing.id, viewToPayload(view))
  return getMessage(db, existing.id)
}

function broadcastUpdate(hub: Hub | undefined, view: BackgroundTaskView, message: MessageRow | null): void {
  if (!hub) return
  if (message) {
    hub.broadcast({ type: 'message', threadId: message.thread_id, message })
  }
  hub.broadcast({ type: 'background_task_changed', botId: view.botId, task: view })
}

export function reconcileStaleBackgroundTasks(db: Db, opts?: { now?: number }): number {
  const at = opts?.now ?? Date.now()
  return db.transaction(() => {
    const stale = db.prepare(
      `SELECT * FROM background_tasks WHERE status IN ('queued', 'running') ORDER BY created_at ASC`,
    ).all() as BackgroundTaskRow[]
    if (stale.length === 0) return 0

    const update = db.prepare(
      `UPDATE background_tasks
       SET status = 'cancelled', error = ?, finished_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
    )
    let count = 0
    for (const row of stale) {
      const res = update.run(STALE_RESTART_ERROR, at, row.id)
      if (res.changes === 0) continue
      count++
      const updated = rowToView(getTaskRow(db, row.id)!)
      patchTaskMessage(db, updated)
    }
    return count
  })()
}

function generateTaskId(db: Db): string {
  const exists = db.prepare('SELECT 1 FROM background_tasks WHERE id = ?')
  for (let i = 0; i < 16; i++) {
    const candidate = `bg-${randomBytes(4).toString('hex')}`
    if (!exists.get(candidate)) return candidate
  }
  return `bg-${randomBytes(8).toString('hex')}`
}

type LaneEntry = {
  id: string
  botId: string
  controller: AbortController
  pendingNotes: BackgroundSteeringNote[]
  started: boolean
  cancelled: boolean
  settled: boolean
  usesBrowser: boolean
}

type BotBgLane = {
  queue: LaneEntry[]
  running: LaneEntry | null
  drainPromise: Promise<void> | null
}

export function createBackgroundTaskManager(opts: BackgroundTaskManagerOptions): BackgroundTaskManager {
  const { db, hub, runTask } = opts
  const now = opts.now ?? (() => Date.now())

  const lanes = new Map<string, BotBgLane>()
  const entries = new Map<string, LaneEntry>()
  let stopping = false

  function getOrCreateLane(botId: string): BotBgLane {
    let lane = lanes.get(botId)
    if (!lane) {
      lane = { queue: [], running: null, drainPromise: null }
      lanes.set(botId, lane)
    }
    return lane
  }

  function scheduleDrain(botId: string): void {
    const lane = lanes.get(botId)
    if (!lane || lane.drainPromise) return
    const promise = Promise.resolve()
      .then(() => drainLane(botId, lane))
      .catch(() => {})
      .finally(() => {
        if (lane.drainPromise === promise) {
          lane.drainPromise = null
        }
        if (lane.queue.length > 0 && !stopping) {
          scheduleDrain(botId)
        } else if (lane.queue.length === 0 && !lane.running) {
          lanes.delete(botId)
        }
      })
    lane.drainPromise = promise
  }

  async function drainLane(botId: string, lane: BotBgLane): Promise<void> {
    while (lane.queue.length > 0) {
      const entry = lane.queue.shift()!
      if (entry.cancelled) {
        entry.settled = true
        entry.pendingNotes.length = 0
        entries.delete(entry.id)
        continue
      }

      let startOutcome: { view: BackgroundTaskView; patchedMessage: MessageRow | null } | null = null
      try {
        const startedAt = now()
        startOutcome = db.transaction(() => {
          const res = db.prepare(
            `UPDATE background_tasks
             SET status = 'running', started_at = ?
             WHERE id = ? AND status = 'queued'`,
          ).run(startedAt, entry.id)
          if (res.changes === 0) return null
          const updated = rowToView(getTaskRow(db, entry.id)!)
          const patchedMessage = patchTaskMessage(db, updated)
          return { view: updated, patchedMessage }
        })()
      } catch {
        entry.settled = true
        entry.pendingNotes.length = 0
        entries.delete(entry.id)
        continue
      }

      if (!startOutcome) {
        entry.settled = true
        entry.pendingNotes.length = 0
        entries.delete(entry.id)
        continue
      }

      entry.started = true
      lane.running = entry
      broadcastUpdate(hub, startOutcome.view, startOutcome.patchedMessage)

      if (entry.cancelled) {
        entry.settled = true
        entry.pendingNotes.length = 0
        entries.delete(entry.id)
        if (lane.running === entry) lane.running = null
        continue
      }

      const ctx: BackgroundTaskRunContext = {
        task: startOutcome.view,
        signal: entry.controller.signal,
        drainSteeringNotes: () => {
          if (entry.pendingNotes.length === 0) return []
          return entry.pendingNotes.splice(0, entry.pendingNotes.length)
        },
        recordStep: (step) => {
          if (entry.cancelled || entry.settled) return
          const at = now()
          const cleanTool = sanitizeSingleLine(step.tool || 'step', 60) || 'step'
          const cleanSummary = sanitizeSingleLine(step.summary ?? '', 200)
          const nextStep: BackgroundTaskStep = {
            tool: cleanTool,
            summary: cleanSummary,
            ...(typeof step.ok === 'boolean' ? { ok: step.ok } : {}),
            ...(typeof step.ms === 'number' && Number.isFinite(step.ms) ? { ms: step.ms } : {}),
            at,
          }
          const lastStep = formatLastStep(cleanTool, cleanSummary)

          const stepOutcome = db.transaction(() => {
            const current = getTaskRow(db, entry.id)
            if (!current || current.status !== 'running') return null
            const steps = parseSteps(current.steps_json)
            steps.push(nextStep)
            const bounded = steps.length > MAX_BG_STEPS ? steps.slice(-MAX_BG_STEPS) : steps
            const nextCount = current.step_count + 1
            const res = db.prepare(
              `UPDATE background_tasks
               SET step_count = ?, last_step = ?, steps_json = ?
               WHERE id = ? AND status = 'running'`,
            ).run(nextCount, lastStep, JSON.stringify(bounded), entry.id)
            if (res.changes === 0) return null
            const updated = rowToView(getTaskRow(db, entry.id)!)
            const patchedMessage = patchTaskMessage(db, updated)
            return { view: updated, patchedMessage }
          })()

          if (stepOutcome) {
            broadcastUpdate(hub, stepOutcome.view, stepOutcome.patchedMessage)
          }
        },
        markUsesBrowser: () => {
          if (entry.cancelled || entry.settled || entry.usesBrowser) return
          const browserOutcome = db.transaction(() => {
            const current = getTaskRow(db, entry.id)
            if (!current || current.status !== 'running') return null
            if (current.uses_browser === 1) {
              entry.usesBrowser = true
              return null
            }
            const res = db.prepare(
              `UPDATE background_tasks
               SET uses_browser = 1
               WHERE id = ? AND status = 'running'`,
            ).run(entry.id)
            if (res.changes === 0) return null
            const updated = rowToView(getTaskRow(db, entry.id)!)
            const patchedMessage = patchTaskMessage(db, updated)
            return { view: updated, patchedMessage }
          })()

          if (browserOutcome) {
            entry.usesBrowser = true
            broadcastUpdate(hub, browserOutcome.view, browserOutcome.patchedMessage)
          }
        },
        markTainted: () => {
          if (entry.cancelled || entry.settled) return
          try {
            db.prepare('UPDATE background_tasks SET source_tainted = 1 WHERE id = ? AND source_tainted = 0').run(
              entry.id,
            )
          } catch {
            // Ignore closed DB during shutdown
          }
        },
      }

      let finalStatus: 'completed' | 'failed' | 'cancelled' = 'completed'
      let finalSummary = ''
      let finalError = ''
      let finalTainted = false

      try {
        const result = await runTask(ctx)
        if (result?.tainted === true) finalTainted = true
        if (entry.cancelled || entry.controller.signal.aborted || result?.status === 'cancelled') {
          finalStatus = 'cancelled'
          finalSummary = clampText(result?.summary, MAX_BG_SUMMARY_CHARS)
          finalError = clampText(result?.error, MAX_BG_ERROR_CHARS)
        } else if (result?.status === 'failed') {
          finalStatus = 'failed'
          finalSummary = clampText(result?.summary, MAX_BG_SUMMARY_CHARS)
          finalError = clampText(result?.error, MAX_BG_ERROR_CHARS) || 'Background task failed.'
        } else {
          finalStatus = 'completed'
          finalSummary = clampText(result?.summary, MAX_BG_SUMMARY_CHARS)
          finalError = ''
        }
      } catch (err) {
        if (entry.cancelled || entry.controller.signal.aborted) {
          finalStatus = 'cancelled'
          finalSummary = ''
          finalError = ''
        } else {
          finalStatus = 'failed'
          finalSummary = ''
          const msg = err instanceof Error ? err.message : String(err)
          finalError = clampText(msg, MAX_BG_ERROR_CHARS) || 'Background task failed.'
        }
      } finally {
        let finalizeOutcome: { view: BackgroundTaskView; patchedMessage: MessageRow | null } | null = null
        try {
          const finishedAt = now()
          finalizeOutcome = db.transaction(() => {
            const existing = getTaskRow(db, entry.id)
            if (!existing || (existing.status !== 'queued' && existing.status !== 'running')) {
              return null
            }
            const res = db.prepare(
              `UPDATE background_tasks
               SET status = ?,
                   summary = ?,
                   error = ?,
                   source_tainted = CASE WHEN source_tainted = 1 OR ? = 1 THEN 1 ELSE 0 END,
                   finished_at = ?
               WHERE id = ? AND status IN ('queued', 'running')`,
            ).run(finalStatus, finalSummary, finalError, finalTainted ? 1 : 0, finishedAt, entry.id)
            if (res.changes === 0) return null

            const updated = rowToView(getTaskRow(db, entry.id)!)
            const patchedMessage = patchTaskMessage(db, updated)
            recordAction(db, {
              botId: updated.botId,
              threadId: updated.threadId,
              trigger: 'background',
              tool: 'background_task',
              summary: `${finalStatus}: ${updated.title}`,
              ok: finalStatus === 'completed' ? true : finalStatus === 'failed' ? false : null,
              ms: updated.startedAt !== null ? Math.max(0, finishedAt - updated.startedAt) : null,
              at: finishedAt,
            })
            return { view: updated, patchedMessage }
          })()
        } catch {
          // Teardown or closed DB during unwinding must never strand lane.running or leak entries.
        } finally {
          entry.settled = true
          entry.pendingNotes.length = 0
          entries.delete(entry.id)
          if (lane.running === entry) {
            lane.running = null
          }
        }

        if (finalizeOutcome) {
          broadcastUpdate(hub, finalizeOutcome.view, finalizeOutcome.patchedMessage)
        }
      }
    }

    // Touch botId to keep helper signature clear and debuggable
    void botId
  }

  function enqueue(input: EnqueueBackgroundTaskInput): EnqueueBackgroundTaskResult {
    const cleanTitle = sanitizeTitle(input.title)
    if (!cleanTitle) {
      return {
        ok: false,
        code: 'invalid_title',
        error: `Title must be 1–${MAX_BG_TITLE_CHARS} characters.`,
      }
    }
    const cleanInstructions = sanitizeInstructions(input.instructions)
    if (!cleanInstructions) {
      return {
        ok: false,
        code: 'invalid_instructions',
        error: `Instructions must be 1–${MAX_BG_INSTRUCTIONS_CHARS} characters.`,
      }
    }

    const at = now()
    const existingLane = lanes.get(input.botId)
    const memActive = existingLane
      ? (existingLane.running && !existingLane.running.cancelled ? 1 : 0) + existingLane.queue.length
      : 0

    type TxResult =
      | { ok: true; view: BackgroundTaskView; message: MessageRow }
      | { ok: false; code: 'queue_full'; error: string }

    const txOutcome = db.transaction((): TxResult => {
      const activeRow = db.prepare(
        `SELECT COUNT(*) AS n FROM background_tasks WHERE bot_id = ? AND status IN ('queued', 'running')`,
      ).get(input.botId) as { n: number }
      if (Math.max(activeRow.n, memActive) >= MAX_ACTIVE_TASKS_PER_BOT) {
        return {
          ok: false,
          code: 'queue_full',
          error: `This teammate already has ${MAX_ACTIVE_TASKS_PER_BOT} active background tasks. Wait for one to finish or cancel one first.`,
        }
      }

      const id = generateTaskId(db)
      const sourceTainted = input.sourceTainted === true ? 1 : 0
      db.prepare(
        `INSERT INTO background_tasks
           (id, bot_id, thread_id, title, instructions, status, step_count, last_step, steps_json, summary, error, uses_browser, source_tainted, message_id, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, '', '[]', '', '', 0, ?, NULL, ?, NULL, NULL)`,
      ).run(id, input.botId, input.threadId, cleanTitle, cleanInstructions, sourceTainted, at)

      const initialView = rowToView(getTaskRow(db, id)!)
      const message = insertMessage(db, {
        threadId: input.threadId,
        sender: input.botId,
        kind: 'background_task',
        payload: viewToPayload(initialView),
      })
      db.prepare('UPDATE background_tasks SET message_id = ? WHERE id = ?').run(message.id, id)

      recordAction(db, {
        botId: input.botId,
        threadId: input.threadId,
        trigger: 'background',
        tool: 'background_task',
        summary: `queued: ${cleanTitle}`,
        ok: true,
        at,
      })

      const view = rowToView(getTaskRow(db, id)!)
      return { ok: true, view, message }
    })()

    if (!txOutcome.ok) {
      return txOutcome
    }

    const entry: LaneEntry = {
      id: txOutcome.view.id,
      botId: input.botId,
      controller: new AbortController(),
      pendingNotes: [],
      started: false,
      cancelled: false,
      settled: false,
      usesBrowser: false,
    }
    const lane = getOrCreateLane(input.botId)
    lane.queue.push(entry)
    entries.set(entry.id, entry)

    broadcastUpdate(hub, txOutcome.view, txOutcome.message)
    scheduleDrain(input.botId)

    return { ok: true, task: txOutcome.view }
  }

  function steer(taskId: string, rawNote: string, steerOpts?: { botId?: string; tainted?: boolean }): SteerBackgroundTaskResult {
    const cleanNote = sanitizeSteerNote(rawNote)
    if (!cleanNote) {
      return {
        ok: false,
        code: 'invalid_note',
        error: `Steering note must be 1–${MAX_BG_STEER_CHARS} characters.`,
      }
    }

    const existing = getTaskRow(db, taskId)
    if (!existing || (steerOpts?.botId && existing.bot_id !== steerOpts.botId)) {
      return { ok: false, code: 'not_found', error: `Background task ${taskId} not found.` }
    }
    if (existing.status !== 'queued' && existing.status !== 'running') {
      return {
        ok: false,
        code: 'settled',
        error: `Background task ${taskId} is already ${existing.status}.`,
      }
    }

    const at = now()
    const tainted = steerOpts?.tainted === true
    const stepSummary = sanitizeSingleLine(cleanNote, 120)
    const steerStep: BackgroundTaskStep = {
      tool: 'steer',
      summary: stepSummary,
      ok: true,
      at,
    }
    const lastStep = formatLastStep('steer', stepSummary)

    const txOutcome = db.transaction(() => {
      const current = getTaskRow(db, taskId)
      if (!current || (steerOpts?.botId && current.bot_id !== steerOpts.botId)) {
        return { kind: 'not_found' as const }
      }
      if (current.status !== 'queued' && current.status !== 'running') {
        return { kind: 'settled' as const, status: current.status }
      }
      const steps = parseSteps(current.steps_json)
      steps.push(steerStep)
      const bounded = steps.length > MAX_BG_STEPS ? steps.slice(-MAX_BG_STEPS) : steps
      const res = tainted
        ? db.prepare(
            `UPDATE background_tasks
             SET last_step = ?, steps_json = ?, source_tainted = 1
             WHERE id = ? AND status IN ('queued', 'running')`,
          ).run(lastStep, JSON.stringify(bounded), taskId)
        : db.prepare(
            `UPDATE background_tasks
             SET last_step = ?, steps_json = ?
             WHERE id = ? AND status IN ('queued', 'running')`,
          ).run(lastStep, JSON.stringify(bounded), taskId)
      if (res.changes === 0) {
        return { kind: 'settled' as const, status: current.status }
      }
      const updated = rowToView(getTaskRow(db, taskId)!)
      const patchedMessage = patchTaskMessage(db, updated)
      recordAction(db, {
        botId: updated.botId,
        threadId: updated.threadId,
        trigger: 'background',
        tool: 'steer_background_task',
        summary: `steer ${taskId}: ${stepSummary}`,
        ok: true,
        at,
      })
      return { kind: 'ok' as const, view: updated, patchedMessage }
    })()

    if (txOutcome.kind === 'not_found') {
      return { ok: false, code: 'not_found', error: `Background task ${taskId} not found.` }
    }
    if (txOutcome.kind === 'settled') {
      return {
        ok: false,
        code: 'settled',
        error: `Background task ${taskId} is already ${txOutcome.status}.`,
      }
    }

    const entry = entries.get(taskId)
    if (entry && !entry.cancelled && !entry.settled) {
      entry.pendingNotes.push({ note: cleanNote, tainted })
    }

    broadcastUpdate(hub, txOutcome.view, txOutcome.patchedMessage)
    return { ok: true, task: txOutcome.view }
  }

  function cancel(taskId: string, cancelOpts?: { botId?: string }): CancelBackgroundTaskResult {
    const existing = getTaskRow(db, taskId)
    if (!existing || (cancelOpts?.botId && existing.bot_id !== cancelOpts.botId)) {
      return { ok: false, code: 'not_found', error: `Background task ${taskId} not found.` }
    }
    if (existing.status !== 'queued' && existing.status !== 'running') {
      return {
        ok: false,
        code: 'settled',
        error: `Background task ${taskId} is already ${existing.status}.`,
      }
    }

    const at = now()
    const txOutcome = db.transaction(() => {
      const current = getTaskRow(db, taskId)
      if (!current || (cancelOpts?.botId && current.bot_id !== cancelOpts.botId)) {
        return { kind: 'not_found' as const }
      }
      if (current.status !== 'queued' && current.status !== 'running') {
        return { kind: 'settled' as const, status: current.status }
      }
      const res = db.prepare(
        `UPDATE background_tasks
         SET status = 'cancelled', finished_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      ).run(at, taskId)
      if (res.changes === 0) {
        return { kind: 'settled' as const, status: current.status }
      }
      const updated = rowToView(getTaskRow(db, taskId)!)
      const patchedMessage = patchTaskMessage(db, updated)
      recordAction(db, {
        botId: updated.botId,
        threadId: updated.threadId,
        trigger: 'background',
        tool: 'background_task',
        summary: `cancelled: ${updated.title}`,
        ok: null,
        at,
      })
      return { kind: 'ok' as const, view: updated, patchedMessage }
    })()

    if (txOutcome.kind === 'not_found') {
      return { ok: false, code: 'not_found', error: `Background task ${taskId} not found.` }
    }
    if (txOutcome.kind === 'settled') {
      return {
        ok: false,
        code: 'settled',
        error: `Background task ${taskId} is already ${txOutcome.status}.`,
      }
    }

    const entry = entries.get(taskId)
    let shouldAbort = false
    if (entry) {
      entry.cancelled = true
      entry.pendingNotes.length = 0
      const lane = lanes.get(entry.botId)
      if (lane) {
        const idx = lane.queue.indexOf(entry)
        if (idx >= 0) {
          lane.queue.splice(idx, 1)
          entry.settled = true
          entries.delete(taskId)
        }
      }
      if (entry.started) {
        shouldAbort = true
      }
    }

    broadcastUpdate(hub, txOutcome.view, txOutcome.patchedMessage)

    if (shouldAbort && entry && !entry.controller.signal.aborted) {
      try {
        entry.controller.abort()
      } catch {
        // Ignore abort listener errors so cancel always completes cleanly.
      }
    }

    return { ok: true, task: txOutcome.view }
  }

  function hasActive(botId?: string): boolean {
    if (botId !== undefined) {
      const lane = lanes.get(botId)
      return Boolean(lane && (lane.running !== null || lane.queue.length > 0))
    }
    for (const lane of lanes.values()) {
      if (lane.running !== null || lane.queue.length > 0) return true
    }
    return false
  }

  function activeCount(): number {
    let total = 0
    for (const lane of lanes.values()) {
      if (lane.running !== null) total += 1
      total += lane.queue.length
    }
    return total
  }

  function activeBotIds(): string[] {
    const ids: string[] = []
    for (const [botId, lane] of lanes.entries()) {
      if (lane.running !== null || lane.queue.length > 0) {
        ids.push(botId)
      }
    }
    return ids
  }

  async function stopAll(): Promise<void> {
    stopping = true
    try {
      const queuedIds: string[] = []
      const runningIds: string[] = []
      const drainPromises: Promise<void>[] = []

      for (const lane of lanes.values()) {
        for (const entry of lane.queue) {
          queuedIds.push(entry.id)
        }
        if (lane.running) {
          runningIds.push(lane.running.id)
        }
        if (lane.drainPromise) {
          drainPromises.push(lane.drainPromise)
        }
      }

      for (const id of queuedIds) {
        cancel(id)
      }
      for (const id of runningIds) {
        cancel(id)
      }

      if (drainPromises.length > 0) {
        await Promise.allSettled(drainPromises)
      }
    } finally {
      stopping = false
    }
  }

  return {
    enqueue,
    steer,
    cancel,
    hasActive,
    activeCount,
    activeBotIds,
    stopAll,
  }
}
