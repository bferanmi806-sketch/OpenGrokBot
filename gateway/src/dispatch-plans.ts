import { randomBytes } from 'node:crypto'
import { recordAction } from './actions.js'
import { getMessage, insertMessage, updateMessagePayload, type Db, type MessageRow } from './db.js'
import type { Hub } from './hub.js'

export const MAX_DISPATCH_STEPS = 12
export const MAX_PLAN_TITLE_CHARS = 120
export const MAX_STEP_TITLE_CHARS = 120
export const MAX_STEP_INSTRUCTIONS_CHARS = 4000
export const MAX_STEP_OUTPUT_CHARS = 2000
export const MAX_STEP_ERROR_CHARS = 500
export const STALE_PIPELINE_RESTART_ERROR = 'Gateway restarted before this pipeline finished.'

export type DispatchPlanStatus = 'draft' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type DispatchStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export type DispatchStepInput = {
  id: string
  botId: string
  title: string
  instructions: string
  dependsOn?: string[]
}

export type ValidatedDispatchStep = {
  id: string
  seq: number
  wave: number
  botId: string
  title: string
  instructions: string
  dependsOn: string[]
}

export type ValidateDispatchStepsResult =
  | { ok: true; steps: ValidatedDispatchStep[] }
  | { ok: false; error: string }

export type DispatchStepView = {
  id: string
  seq: number
  wave: number
  botId: string
  title: string
  instructions: string
  dependsOn: string[]
  status: DispatchStepStatus
  output: string
  error: string
  outputTainted: boolean
  waitingApprovalId: number | null
  waitingQuestionId: number | null
  startedAt: number | null
  finishedAt: number | null
}

export type DispatchPlanView = {
  id: string
  threadId: string
  createdBy: string
  title: string
  status: DispatchPlanStatus
  sourceTainted: boolean
  messageId: number | null
  error: string
  steps: DispatchStepView[]
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type DispatchPlanPayload = {
  planId: string
  threadId: string
  createdBy: string
  title: string
  status: DispatchPlanStatus
  sourceTainted: boolean
  error: string
  steps: DispatchStepView[]
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type UpstreamStepOutput = {
  stepId: string
  botId: string
  title: string
  output: string
  tainted: boolean
}

export type DispatchStepRunContext = {
  plan: DispatchPlanView
  step: DispatchStepView
  upstream: UpstreamStepOutput[]
  initialTainted: boolean
  signal: AbortSignal
}

export type DispatchStepRunResult =
  | { status: 'completed'; output: string; tainted: boolean }
  | { status: 'waiting_approval'; approvalId?: number; questionId?: number; output?: string; tainted: boolean }
  | { status: 'failed'; error: string; output?: string; tainted?: boolean }
  | { status: 'cancelled' }

export type CreateDispatchPlanInput = {
  threadId: string
  createdBy: string
  title: string
  steps: unknown
  allowedBotIds: ReadonlySet<string>
  sourceTainted?: boolean
}

export type CreateDispatchPlanResult =
  | { ok: true; plan: DispatchPlanView }
  | { ok: false; code: 'invalid_title' | 'invalid_steps'; error: string }

export type StartDispatchPlanResult =
  | { ok: true; plan: DispatchPlanView }
  | { ok: false; code: 'not_found' | 'invalid_state'; error: string }

export type CancelDispatchPlanResult =
  | { ok: true; plan: DispatchPlanView }
  | { ok: false; code: 'not_found' | 'settled'; error: string }

export type ResumeStepAfterWaitInput = {
  approvalId?: number
  questionId?: number
  outcome: 'completed' | 'failed'
  output?: string
  error?: string
  tainted?: boolean
}

export type DispatchPlanManagerOptions = {
  db: Db
  hub?: Hub
  now?: () => number
  runStep: (ctx: DispatchStepRunContext) => Promise<DispatchStepRunResult>
}

export type DispatchPlanManager = {
  createPlan(input: CreateDispatchPlanInput): CreateDispatchPlanResult
  startPlan(planId: string): StartDispatchPlanResult
  resumeStepAfterWait(input: ResumeStepAfterWaitInput): DispatchPlanView | null
  cancelPlan(planId: string): CancelDispatchPlanResult
  hasActive(botId?: string): boolean
  activeBotIds(): string[]
  activePlanCount(): number
  stopAll(): Promise<void>
}

type DispatchPlanRow = {
  id: string
  thread_id: string
  created_by: string
  title: string
  status: string
  source_tainted: number
  message_id: number | null
  error: string
  created_at: number
  started_at: number | null
  finished_at: number | null
}

type DispatchPlanStepRow = {
  plan_id: string
  step_id: string
  seq: number
  bot_id: string
  title: string
  instructions: string
  depends_on_json: string
  status: string
  output: string
  error: string
  output_tainted: number
  waiting_approval_id: number | null
  waiting_question_id: number | null
  started_at: number | null
  finished_at: number | null
}

const STEP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const CONTROL_CHARS_EXCEPT_WS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

const VALID_PLAN_STATUSES: ReadonlySet<string> = new Set<DispatchPlanStatus>([
  'draft',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
])

const VALID_STEP_STATUSES: ReadonlySet<string> = new Set<DispatchStepStatus>([
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'skipped',
  'cancelled',
])

function normalizePlanStatus(raw: string): DispatchPlanStatus {
  return VALID_PLAN_STATUSES.has(raw) ? (raw as DispatchPlanStatus) : 'failed'
}

function normalizeStepStatus(raw: string): DispatchStepStatus {
  return VALID_STEP_STATUSES.has(raw) ? (raw as DispatchStepStatus) : 'failed'
}

function sanitizeTitle(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const clean = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROL_CHARS_EXCEPT_WS, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean || clean.length > max) return null
  return clean
}

function sanitizeInstructions(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const clean = raw
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_EXCEPT_WS, '')
    .trim()
  if (!clean || clean.length > max) return null
  return clean
}

function clampText(raw: string | undefined, max: number): string {
  if (typeof raw !== 'string') return ''
  const clean = raw
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_EXCEPT_WS, '')
    .trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 3))}...`
}

function parseDependsOn(raw: string): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const id = item.trim().toLowerCase()
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  } catch {
    return []
  }
}

function computeStepWaves(steps: ReadonlyArray<{ id: string; dependsOn: string[] }>): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const memo = new Map<string, number>()
  const visiting = new Set<string>()

  function waveOf(id: string): number {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0
    visiting.add(id)
    const step = byId.get(id)
    let wave = 0
    if (step && step.dependsOn.length > 0) {
      let maxDepWave = -1
      for (const depId of step.dependsOn) {
        if (byId.has(depId)) {
          maxDepWave = Math.max(maxDepWave, waveOf(depId))
        }
      }
      wave = maxDepWave + 1
    }
    visiting.delete(id)
    memo.set(id, wave)
    return wave
  }

  for (const s of steps) {
    waveOf(s.id)
  }
  return memo
}

export function validateDispatchSteps(
  steps: unknown,
  allowedBotIds: ReadonlySet<string>,
): ValidateDispatchStepsResult {
  if (!Array.isArray(steps)) {
    return { ok: false, error: 'steps must be an array.' }
  }
  if (steps.length === 0) {
    return { ok: false, error: 'Dispatch plan must include at least 1 step.' }
  }
  if (steps.length > MAX_DISPATCH_STEPS) {
    return { ok: false, error: `Dispatch plan can have at most ${MAX_DISPATCH_STEPS} steps.` }
  }

  type ParsedStep = {
    id: string
    botId: string
    title: string
    instructions: string
    dependsOn: string[]
    inputIdx: number
  }

  const parsed: ParsedStep[] = []
  const byId = new Map<string, ParsedStep>()

  for (let i = 0; i < steps.length; i++) {
    const item = steps[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `Step at index ${i} must be an object.` }
    }
    const rec = item as Record<string, unknown>

    if (typeof rec.id !== 'string') {
      return { ok: false, error: `Step at index ${i} must have a string id.` }
    }
    const id = rec.id.trim().toLowerCase()
    if (!STEP_ID_RE.test(id)) {
      return {
        ok: false,
        error: `Invalid step id "${rec.id}". Use 1–32 chars matching ^[a-z0-9][a-z0-9_-]{0,31}$.`,
      }
    }
    if (byId.has(id)) {
      return { ok: false, error: `Duplicate step id "${id}".` }
    }

    if (typeof rec.botId !== 'string' || !rec.botId.trim()) {
      return { ok: false, error: `Step "${id}" must specify a valid teammate botId.` }
    }
    const botId = rec.botId.trim()
    if (!allowedBotIds.has(botId)) {
      return {
        ok: false,
        error: `Step "${id}" targets "${botId}", which is not a member of this group thread.`,
      }
    }

    const title = sanitizeTitle(rec.title, MAX_STEP_TITLE_CHARS)
    if (!title) {
      return {
        ok: false,
        error: `Step "${id}" title must be 1–${MAX_STEP_TITLE_CHARS} characters.`,
      }
    }

    const instructions = sanitizeInstructions(rec.instructions, MAX_STEP_INSTRUCTIONS_CHARS)
    if (!instructions) {
      return {
        ok: false,
        error: `Step "${id}" instructions must be 1–${MAX_STEP_INSTRUCTIONS_CHARS} characters.`,
      }
    }

    const dependsOn: string[] = []
    if (rec.dependsOn !== undefined) {
      if (!Array.isArray(rec.dependsOn)) {
        return { ok: false, error: `Step "${id}" dependsOn must be an array of step IDs.` }
      }
      const seenDeps = new Set<string>()
      for (const rawDep of rec.dependsOn) {
        if (typeof rawDep !== 'string') {
          return { ok: false, error: `Step "${id}" dependsOn entries must be strings.` }
        }
        const depId = rawDep.trim().toLowerCase()
        if (!depId) {
          return { ok: false, error: `Step "${id}" dependsOn contains an empty step ID.` }
        }
        if (!seenDeps.has(depId)) {
          seenDeps.add(depId)
          dependsOn.push(depId)
        }
      }
    }

    const entry: ParsedStep = { id, botId, title, instructions, dependsOn, inputIdx: i }
    parsed.push(entry)
    byId.set(id, entry)
  }

  for (const step of parsed) {
    for (const depId of step.dependsOn) {
      if (depId === step.id) {
        return { ok: false, error: `Step "${step.id}" cannot depend on itself.` }
      }
      if (!byId.has(depId)) {
        return { ok: false, error: `Step "${step.id}" depends on unknown step "${depId}".` }
      }
    }
  }

  // Kahn's algorithm layered by wave for deterministic topological seq and wave depth.
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const step of parsed) {
    inDegree.set(step.id, step.dependsOn.length)
    dependents.set(step.id, [])
  }
  for (const step of parsed) {
    for (const depId of step.dependsOn) {
      dependents.get(depId)!.push(step.id)
    }
  }

  let ready = parsed
    .filter((s) => (inDegree.get(s.id) ?? 0) === 0)
    .sort((a, b) => a.inputIdx - b.inputIdx)

  const ordered: ValidatedDispatchStep[] = []
  let wave = 0

  while (ready.length > 0) {
    const nextReady: ParsedStep[] = []
    for (const step of ready) {
      ordered.push({
        id: step.id,
        seq: ordered.length,
        wave,
        botId: step.botId,
        title: step.title,
        instructions: step.instructions,
        dependsOn: step.dependsOn,
      })
      for (const childId of dependents.get(step.id)!) {
        const nextDeg = (inDegree.get(childId) ?? 0) - 1
        inDegree.set(childId, nextDeg)
        if (nextDeg === 0) {
          nextReady.push(byId.get(childId)!)
        }
      }
    }
    nextReady.sort((a, b) => a.inputIdx - b.inputIdx)
    ready = nextReady
    wave += 1
  }

  if (ordered.length < parsed.length) {
    // Identify steps participating in cycles by peeling nodes with no remaining dependents.
    const remaining = new Set(parsed.filter((s) => (inDegree.get(s.id) ?? 0) > 0).map((s) => s.id))
    const outDegree = new Map<string, number>()
    for (const id of remaining) {
      let out = 0
      for (const childId of dependents.get(id)!) {
        if (remaining.has(childId)) out += 1
      }
      outDegree.set(id, out)
    }
    const peelQueue: string[] = []
    for (const [id, out] of outDegree.entries()) {
      if (out === 0) peelQueue.push(id)
    }
    while (peelQueue.length > 0) {
      const leaf = peelQueue.shift()!
      if (!remaining.has(leaf)) continue
      remaining.delete(leaf)
      for (const depId of byId.get(leaf)!.dependsOn) {
        if (!remaining.has(depId)) continue
        const nextOut = (outDegree.get(depId) ?? 0) - 1
        outDegree.set(depId, nextOut)
        if (nextOut === 0) peelQueue.push(depId)
      }
    }
    const cyclicIds = parsed
      .filter((s) => remaining.has(s.id))
      .map((s) => s.id)
    const labelIds = cyclicIds.length > 0
      ? cyclicIds
      : parsed.filter((s) => (inDegree.get(s.id) ?? 0) > 0).map((s) => s.id)
    return {
      ok: false,
      error: `Dispatch plan contains a dependency cycle involving: ${labelIds.join(', ')}.`,
    }
  }

  return { ok: true, steps: ordered }
}

export function formatUpstreamOutputs(upstream: UpstreamStepOutput[]): string {
  if (upstream.length === 0) return ''
  return upstream
    .map((u) => {
      const header = `[upstream step ${u.stepId} by @${u.botId}: ${u.title}]`
      const body = u.output.trim() || '(no output)'
      return `${header}\n${body}\n[/upstream step ${u.stepId}]`
    })
    .join('\n\n')
}

export function viewToPayload(view: DispatchPlanView): DispatchPlanPayload {
  return {
    planId: view.id,
    threadId: view.threadId,
    createdBy: view.createdBy,
    title: view.title,
    status: view.status,
    sourceTainted: view.sourceTainted,
    error: view.error,
    steps: view.steps,
    createdAt: view.createdAt,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt,
  }
}

function buildPlanView(planRow: DispatchPlanRow, stepRows: DispatchPlanStepRow[]): DispatchPlanView {
  const parsedDeps = stepRows.map((row) => ({
    row,
    dependsOn: parseDependsOn(row.depends_on_json),
  }))
  const waves = computeStepWaves(parsedDeps.map((item) => ({ id: item.row.step_id, dependsOn: item.dependsOn })))

  const steps: DispatchStepView[] = parsedDeps.map(({ row, dependsOn }) => ({
    id: row.step_id,
    seq: Number.isFinite(row.seq) ? row.seq : 0,
    wave: waves.get(row.step_id) ?? 0,
    botId: row.bot_id,
    title: row.title,
    instructions: row.instructions,
    dependsOn,
    status: normalizeStepStatus(row.status),
    output: row.output ?? '',
    error: row.error ?? '',
    outputTainted: row.output_tainted === 1,
    waitingApprovalId: row.waiting_approval_id ?? null,
    waitingQuestionId: row.waiting_question_id ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  }))

  return {
    id: planRow.id,
    threadId: planRow.thread_id,
    createdBy: planRow.created_by,
    title: planRow.title,
    status: normalizePlanStatus(planRow.status),
    sourceTainted: planRow.source_tainted === 1,
    messageId: planRow.message_id ?? null,
    error: planRow.error ?? '',
    steps,
    createdAt: planRow.created_at,
    startedAt: planRow.started_at ?? null,
    finishedAt: planRow.finished_at ?? null,
  }
}

function getPlanRow(db: Db, id: string): DispatchPlanRow | null {
  if (typeof id !== 'string' || !id.trim()) return null
  return (db.prepare('SELECT * FROM dispatch_plans WHERE id = ?').get(id) as DispatchPlanRow | undefined) ?? null
}

function getPlanStepRows(db: Db, planId: string): DispatchPlanStepRow[] {
  return db.prepare(
    'SELECT * FROM dispatch_plan_steps WHERE plan_id = ? ORDER BY seq ASC',
  ).all(planId) as DispatchPlanStepRow[]
}

export function getDispatchPlan(db: Db, id: string): DispatchPlanView | null {
  const row = getPlanRow(db, id)
  if (!row) return null
  const steps = getPlanStepRows(db, row.id)
  return buildPlanView(row, steps)
}

export function listDispatchPlans(
  db: Db,
  opts: { threadId?: string; status?: DispatchPlanStatus; limit?: number } = {},
): DispatchPlanView[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.threadId) {
    clauses.push('thread_id = ?')
    params.push(opts.threadId)
  }
  if (opts.status) {
    clauses.push('status = ?')
    params.push(opts.status)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rawLimit = opts.limit !== undefined && Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 20
  const limit = Math.max(1, Math.min(rawLimit, 200))
  params.push(limit)

  const planRows = db.prepare(
    `SELECT * FROM dispatch_plans ${where}
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`,
  ).all(...params) as DispatchPlanRow[]

  if (planRows.length === 0) return []

  const placeholders = planRows.map(() => '?').join(',')
  const stepRows = db.prepare(
    `SELECT * FROM dispatch_plan_steps
     WHERE plan_id IN (${placeholders})
     ORDER BY plan_id ASC, seq ASC`,
  ).all(...planRows.map((p) => p.id)) as DispatchPlanStepRow[]

  const stepsByPlan = new Map<string, DispatchPlanStepRow[]>()
  for (const step of stepRows) {
    const list = stepsByPlan.get(step.plan_id) ?? []
    list.push(step)
    stepsByPlan.set(step.plan_id, list)
  }

  return planRows.map((planRow) => buildPlanView(planRow, stepsByPlan.get(planRow.id) ?? []))
}

export function findWaitingStepByApproval(
  db: Db,
  approvalId: number,
): { planId: string; stepId: string } | null {
  if (!Number.isInteger(approvalId) || approvalId <= 0) return null
  const row = db.prepare(
    `SELECT plan_id, step_id FROM dispatch_plan_steps
     WHERE status = 'waiting_approval' AND waiting_approval_id = ?
     LIMIT 1`,
  ).get(approvalId) as { plan_id: string; step_id: string } | undefined
  return row ? { planId: row.plan_id, stepId: row.step_id } : null
}

export function findWaitingStepByQuestion(
  db: Db,
  questionId: number,
): { planId: string; stepId: string } | null {
  if (!Number.isInteger(questionId) || questionId <= 0) return null
  const row = db.prepare(
    `SELECT plan_id, step_id FROM dispatch_plan_steps
     WHERE status = 'waiting_approval' AND waiting_question_id = ?
     LIMIT 1`,
  ).get(questionId) as { plan_id: string; step_id: string } | undefined
  return row ? { planId: row.plan_id, stepId: row.step_id } : null
}

function collectTransitiveDownstream(
  steps: ReadonlyArray<DispatchPlanStepRow>,
  sourceStepIds: ReadonlyArray<string>,
): string[] {
  const childrenByStep = new Map<string, string[]>()
  for (const step of steps) {
    const deps = parseDependsOn(step.depends_on_json)
    for (const depId of deps) {
      const list = childrenByStep.get(depId) ?? []
      list.push(step.step_id)
      childrenByStep.set(depId, list)
    }
  }

  const visited = new Set<string>(sourceStepIds)
  const queue = [...sourceStepIds]
  const downstream: string[] = []

  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const childId of childrenByStep.get(cur) ?? []) {
      if (visited.has(childId)) continue
      visited.add(childId)
      downstream.push(childId)
      queue.push(childId)
    }
  }
  return downstream
}

function patchPlanMessage(db: Db, view: DispatchPlanView): MessageRow | null {
  if (view.messageId === null) return null
  const existing = getMessage(db, view.messageId)
  if (!existing || existing.kind !== 'dispatch_plan') return null
  updateMessagePayload(db, existing.id, viewToPayload(view))
  return getMessage(db, existing.id)
}

function broadcastUpdate(hub: Hub | undefined, view: DispatchPlanView, message: MessageRow | null): void {
  if (!hub) return
  if (message) {
    hub.broadcast({ type: 'message', threadId: message.thread_id, message })
  }
  hub.broadcast({ type: 'dispatch_plan_changed', threadId: view.threadId, plan: view })
}

function generatePlanId(db: Db): string {
  const exists = db.prepare('SELECT 1 FROM dispatch_plans WHERE id = ?')
  for (let i = 0; i < 16; i++) {
    const candidate = `dp-${randomBytes(4).toString('hex')}`
    if (!exists.get(candidate)) return candidate
  }
  return `dp-${randomBytes(8).toString('hex')}`
}

/**
 * Reconcile leftover `running` dispatch plans after a gateway restart:
 * - Marks any `running` steps as `cancelled` with STALE_PIPELINE_RESTART_ERROR.
 * - Skips their transitive `pending` dependents, and cancels any remaining `pending`/`waiting_approval` steps
 *   inside those affected `running` plans before marking the plan itself `cancelled`.
 * - Preserves `draft` plans and already `paused` plans (whose `waiting_approval` steps can resume after restart).
 */
export function reconcileStaleDispatchPlans(db: Db, opts?: { now?: number }): number {
  const at = opts?.now ?? Date.now()
  return db.transaction(() => {
    const stalePlans = db.prepare(
      `SELECT * FROM dispatch_plans WHERE status = 'running' ORDER BY created_at ASC`,
    ).all() as DispatchPlanRow[]
    if (stalePlans.length === 0) return 0

    const cancelRunningStep = db.prepare(
      `UPDATE dispatch_plan_steps
       SET status = 'cancelled',
           error = ?,
           waiting_approval_id = NULL,
           waiting_question_id = NULL,
           finished_at = ?
       WHERE plan_id = ? AND step_id = ? AND status = 'running'`,
    )
    const skipPendingStep = db.prepare(
      `UPDATE dispatch_plan_steps
       SET status = 'skipped', finished_at = ?
       WHERE plan_id = ? AND step_id = ? AND status = 'pending'`,
    )
    const cancelRemainingSteps = db.prepare(
      `UPDATE dispatch_plan_steps
       SET status = 'cancelled',
           waiting_approval_id = NULL,
           waiting_question_id = NULL,
           finished_at = ?
       WHERE plan_id = ? AND status IN ('pending', 'waiting_approval')`,
    )
    const cancelPlanRow = db.prepare(
      `UPDATE dispatch_plans
       SET status = 'cancelled', error = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )

    let count = 0
    for (const planRow of stalePlans) {
      const steps = getPlanStepRows(db, planRow.id)
      const runningStepIds = steps
        .filter((s) => normalizeStepStatus(s.status) === 'running')
        .map((s) => s.step_id)

      for (const stepId of runningStepIds) {
        cancelRunningStep.run(STALE_PIPELINE_RESTART_ERROR, at, planRow.id, stepId)
      }
      if (runningStepIds.length > 0) {
        const downstream = collectTransitiveDownstream(steps, runningStepIds)
        for (const depStepId of downstream) {
          skipPendingStep.run(at, planRow.id, depStepId)
        }
      }
      cancelRemainingSteps.run(at, planRow.id)

      const res = cancelPlanRow.run(STALE_PIPELINE_RESTART_ERROR, at, planRow.id)
      if (res.changes === 0) continue
      count += 1

      const updated = getDispatchPlan(db, planRow.id)
      if (updated) {
        patchPlanMessage(db, updated)
      }
    }
    return count
  })()
}

type ActiveStepRun = {
  planId: string
  stepId: string
  botId: string
  controller: AbortController
  cancelled: boolean
  promise: Promise<void> | null
}

type LaunchedStepInfo = {
  entry: ActiveStepRun
  planSnapshot: DispatchPlanView
  stepSnapshot: DispatchStepView
  upstream: UpstreamStepOutput[]
  initialTainted: boolean
}

type TransitionOutcome = {
  view: DispatchPlanView
  patchedMessage: MessageRow | null
  toLaunch: LaunchedStepInfo[]
}

export function createDispatchPlanManager(opts: DispatchPlanManagerOptions): DispatchPlanManager {
  const { db, hub, runStep } = opts
  const now = opts.now ?? (() => Date.now())

  const activeRuns = new Map<string, Map<string, ActiveStepRun>>()
  const inFlightPromises = new Set<Promise<void>>()
  let stopping = false

  function registerRuns(planId: string, launched: ReadonlyArray<LaunchedStepInfo>): void {
    if (launched.length === 0) return
    let byStep = activeRuns.get(planId)
    if (!byStep) {
      byStep = new Map()
      activeRuns.set(planId, byStep)
    }
    for (const item of launched) {
      byStep.set(item.entry.stepId, item.entry)
    }
  }

  function unregisterRun(planId: string, stepId: string, entry: ActiveStepRun): void {
    const byStep = activeRuns.get(planId)
    if (!byStep) return
    if (byStep.get(stepId) === entry) {
      byStep.delete(stepId)
    }
    if (byStep.size === 0) {
      activeRuns.delete(planId)
    }
  }

  function skipTransitiveDownstreamInTx(planId: string, sourceStepId: string, at: number): void {
    const steps = getPlanStepRows(db, planId)
    const downstream = collectTransitiveDownstream(steps, [sourceStepId])
    if (downstream.length === 0) return
    const skipStmt = db.prepare(
      `UPDATE dispatch_plan_steps
       SET status = 'skipped', finished_at = ?
       WHERE plan_id = ? AND step_id = ? AND status = 'pending'`,
    )
    for (const depStepId of downstream) {
      skipStmt.run(at, planId, depStepId)
    }
  }

  /**
   * Claims ready `pending` steps (all deps `completed`, 1 concurrent running step per bot per plan),
   * recomputes plan status, patches the thread message, and returns newly launched step metadata.
   * Must be called inside an active `db.transaction`.
   */
  function pumpAndRecomputeInTx(
    planId: string,
    at: number,
    allowLaunch: boolean,
  ): TransitionOutcome | null {
    const planRow = getPlanRow(db, planId)
    if (!planRow) return null
    const currentStatus = normalizePlanStatus(planRow.status)
    if (currentStatus !== 'running' && currentStatus !== 'paused') {
      return null
    }

    let steps = getPlanStepRows(db, planId)
    const statusById = new Map(steps.map((s) => [s.step_id, normalizeStepStatus(s.status)]))
    const runningBots = new Set<string>()
    for (const step of steps) {
      if (normalizeStepStatus(step.status) === 'running') {
        runningBots.add(step.bot_id)
      }
    }

    const launchedIds: string[] = []
    if (allowLaunch) {
      const claimStmt = db.prepare(
        `UPDATE dispatch_plan_steps
         SET status = 'running', started_at = ?
         WHERE plan_id = ? AND step_id = ? AND status = 'pending'`,
      )
      for (const step of steps) {
        if (normalizeStepStatus(step.status) !== 'pending') continue
        if (runningBots.has(step.bot_id)) continue
        const deps = parseDependsOn(step.depends_on_json)
        if (!deps.every((depId) => statusById.get(depId) === 'completed')) continue
        const res = claimStmt.run(at, planId, step.step_id)
        if (res.changes > 0) {
          runningBots.add(step.bot_id)
          statusById.set(step.step_id, 'running')
          launchedIds.push(step.step_id)
        }
      }
    }

    steps = getPlanStepRows(db, planId)
    const finalStatusById = new Map(steps.map((s) => [s.step_id, normalizeStepStatus(s.status)]))
    const anyRunning = steps.some((s) => normalizeStepStatus(s.status) === 'running')
    const anyPending = steps.some((s) => normalizeStepStatus(s.status) === 'pending')
    const anyReady = steps.some((s) => {
      if (normalizeStepStatus(s.status) !== 'pending') return false
      const deps = parseDependsOn(s.depends_on_json)
      return deps.every((depId) => finalStatusById.get(depId) === 'completed')
    })
    const anyWaiting = steps.some((s) => normalizeStepStatus(s.status) === 'waiting_approval')
    const firstFailed = steps.find((s) => normalizeStepStatus(s.status) === 'failed')
    const anyCancelled = steps.some((s) => normalizeStepStatus(s.status) === 'cancelled')

    let nextStatus: DispatchPlanStatus
    let nextError = planRow.error ?? ''
    let finishedAt: number | null = null

    if (anyRunning || (allowLaunch && anyReady)) {
      nextStatus = 'running'
    } else if (anyWaiting) {
      nextStatus = 'paused'
    } else if (anyPending) {
      // Unlaunched pending steps with nothing running/waiting (e.g. during shutdown teardown).
      nextStatus = 'cancelled'
      finishedAt = at
    } else if (firstFailed) {
      nextStatus = 'failed'
      nextError = nextError || firstFailed.error || 'Pipeline step failed.'
      finishedAt = at
    } else if (anyCancelled) {
      nextStatus = 'cancelled'
      finishedAt = at
    } else {
      nextStatus = 'completed'
      finishedAt = at
    }

    db.prepare(
      `UPDATE dispatch_plans
       SET status = ?, error = ?, finished_at = ?
       WHERE id = ?`,
    ).run(nextStatus, clampText(nextError, MAX_STEP_ERROR_CHARS), finishedAt, planId)

    const updatedPlanRow = getPlanRow(db, planId)!
    const view = buildPlanView(updatedPlanRow, steps)
    const patchedMessage = patchPlanMessage(db, view)

    if (nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'cancelled') {
      recordAction(db, {
        botId: view.createdBy,
        threadId: view.threadId,
        trigger: 'pipeline',
        tool: 'dispatch_plan',
        summary: `${nextStatus}: ${view.title}`,
        ok: nextStatus === 'completed' ? true : nextStatus === 'failed' ? false : null,
        ms: view.startedAt !== null ? Math.max(0, at - view.startedAt) : null,
        at,
      })
    }

    const stepViewById = new Map(view.steps.map((s) => [s.id, s]))
    const toLaunch: LaunchedStepInfo[] = launchedIds.map((stepId) => {
      const stepView = stepViewById.get(stepId)!
      const upstream: UpstreamStepOutput[] = stepView.dependsOn
        .map((depId) => stepViewById.get(depId))
        .filter((d): d is DispatchStepView => d !== undefined)
        .map((d) => ({
          stepId: d.id,
          botId: d.botId,
          title: d.title,
          output: d.output,
          tainted: d.outputTainted,
        }))
      const initialTainted = view.sourceTainted || upstream.some((u) => u.tainted)
      const entry: ActiveStepRun = {
        planId,
        stepId,
        botId: stepView.botId,
        controller: new AbortController(),
        cancelled: false,
        promise: null,
      }
      return {
        entry,
        planSnapshot: view,
        stepSnapshot: stepView,
        upstream,
        initialTainted,
      }
    })

    return { view, patchedMessage, toLaunch }
  }

  function scheduleStepRun(launched: LaunchedStepInfo): void {
    const { entry } = launched
    const promise = Promise.resolve()
      .then(() => executeStep(launched))
      .catch(() => {})
      .finally(() => {
        inFlightPromises.delete(promise)
      })
    entry.promise = promise
    inFlightPromises.add(promise)
  }

  async function executeStep(launched: LaunchedStepInfo): Promise<void> {
    const { entry, planSnapshot, stepSnapshot, upstream, initialTainted } = launched
    const { planId, stepId } = entry

    if (entry.cancelled || entry.controller.signal.aborted) {
      unregisterRun(planId, stepId, entry)
      return
    }

    let result: DispatchStepRunResult
    try {
      const raw = await runStep({
        plan: planSnapshot,
        step: stepSnapshot,
        upstream,
        initialTainted,
        signal: entry.controller.signal,
      })
      if (entry.cancelled || entry.controller.signal.aborted) {
        result = { status: 'cancelled' }
      } else {
        result = raw
      }
    } catch (err) {
      if (entry.cancelled || entry.controller.signal.aborted) {
        result = { status: 'cancelled' }
      } else {
        const message = err instanceof Error ? err.message : String(err)
        result = {
          status: 'failed',
          error: clampText(message, MAX_STEP_ERROR_CHARS) || 'Pipeline step failed.',
        }
      }
    }

    let transition: TransitionOutcome | null = null
    try {
      const at = now()
      transition = db.transaction((): TransitionOutcome | null => {
        const planRow = getPlanRow(db, planId)
        if (!planRow) return null
        const planStatus = normalizePlanStatus(planRow.status)
        if (planStatus === 'cancelled' || planStatus === 'completed' || planStatus === 'failed') {
          return null
        }

        const stepRow = db.prepare(
          'SELECT * FROM dispatch_plan_steps WHERE plan_id = ? AND step_id = ?',
        ).get(planId, stepId) as DispatchPlanStepRow | undefined
        if (!stepRow || normalizeStepStatus(stepRow.status) !== 'running') {
          return null
        }

        if (result.status === 'completed') {
          const out = clampText(result.output, MAX_STEP_OUTPUT_CHARS)
          const tainted = (stepRow.output_tainted === 1 || initialTainted || result.tainted) ? 1 : 0
          db.prepare(
            `UPDATE dispatch_plan_steps
             SET status = 'completed',
                 output = ?,
                 error = '',
                 output_tainted = ?,
                 waiting_approval_id = NULL,
                 waiting_question_id = NULL,
                 finished_at = ?
             WHERE plan_id = ? AND step_id = ? AND status = 'running'`,
          ).run(out, tainted, at, planId, stepId)
        } else if (result.status === 'waiting_approval') {
          const approvalId = typeof result.approvalId === 'number' && Number.isInteger(result.approvalId) && result.approvalId > 0
            ? result.approvalId
            : null
          const questionId = typeof result.questionId === 'number' && Number.isInteger(result.questionId) && result.questionId > 0
            ? result.questionId
            : null
          const out = clampText(result.output, MAX_STEP_OUTPUT_CHARS)
          const tainted = (stepRow.output_tainted === 1 || initialTainted || result.tainted) ? 1 : 0

          if (approvalId === null && questionId === null) {
            db.prepare(
              `UPDATE dispatch_plan_steps
               SET status = 'failed',
                   output = ?,
                   error = ?,
                   output_tainted = ?,
                   waiting_approval_id = NULL,
                   waiting_question_id = NULL,
                   finished_at = ?
               WHERE plan_id = ? AND step_id = ? AND status = 'running'`,
            ).run(out, 'Step paused without an approval or question reference.', tainted, at, planId, stepId)
            skipTransitiveDownstreamInTx(planId, stepId, at)
          } else {
            db.prepare(
              `UPDATE dispatch_plan_steps
               SET status = 'waiting_approval',
                   output = ?,
                   output_tainted = ?,
                   waiting_approval_id = ?,
                   waiting_question_id = ?
               WHERE plan_id = ? AND step_id = ? AND status = 'running'`,
            ).run(out, tainted, approvalId, questionId, planId, stepId)
          }
        } else if (result.status === 'failed') {
          const out = clampText(result.output, MAX_STEP_OUTPUT_CHARS)
          const errMsg = clampText(result.error, MAX_STEP_ERROR_CHARS) || 'Pipeline step failed.'
          const tainted = (stepRow.output_tainted === 1 || initialTainted || result.tainted === true) ? 1 : 0
          db.prepare(
            `UPDATE dispatch_plan_steps
             SET status = 'failed',
                 output = ?,
                 error = ?,
                 output_tainted = ?,
                 waiting_approval_id = NULL,
                 waiting_question_id = NULL,
                 finished_at = ?
             WHERE plan_id = ? AND step_id = ? AND status = 'running'`,
          ).run(out, errMsg, tainted, at, planId, stepId)
          skipTransitiveDownstreamInTx(planId, stepId, at)
        } else {
          db.prepare(
            `UPDATE dispatch_plan_steps
             SET status = 'cancelled',
                 waiting_approval_id = NULL,
                 waiting_question_id = NULL,
                 finished_at = ?
             WHERE plan_id = ? AND step_id = ? AND status = 'running'`,
          ).run(at, planId, stepId)
          skipTransitiveDownstreamInTx(planId, stepId, at)
        }

        return pumpAndRecomputeInTx(planId, at, !stopping)
      })()

      // Register newly launched steps BEFORE unregistering the finished step so hasActive() never flickers false.
      if (transition && transition.toLaunch.length > 0 && !stopping) {
        registerRuns(planId, transition.toLaunch)
      }
    } catch {
      // Teardown or closed DB during unwinding must never leak activeRuns entries.
    } finally {
      unregisterRun(planId, stepId, entry)
    }

    if (transition) {
      broadcastUpdate(hub, transition.view, transition.patchedMessage)
      if (transition.toLaunch.length > 0 && !stopping) {
        for (const next of transition.toLaunch) {
          scheduleStepRun(next)
        }
      }
    }
  }

  function createPlan(input: CreateDispatchPlanInput): CreateDispatchPlanResult {
    const cleanTitle = sanitizeTitle(input.title, MAX_PLAN_TITLE_CHARS)
    if (!cleanTitle) {
      return {
        ok: false,
        code: 'invalid_title',
        error: `Plan title must be 1–${MAX_PLAN_TITLE_CHARS} characters.`,
      }
    }

    const validated = validateDispatchSteps(input.steps, input.allowedBotIds)
    if (!validated.ok) {
      return { ok: false, code: 'invalid_steps', error: validated.error }
    }

    const at = now()
    const sourceTainted = input.sourceTainted === true ? 1 : 0

    const txOutcome = db.transaction(() => {
      const id = generatePlanId(db)
      db.prepare(
        `INSERT INTO dispatch_plans
           (id, thread_id, created_by, title, status, source_tainted, message_id, error, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, 'draft', ?, NULL, '', ?, NULL, NULL)`,
      ).run(id, input.threadId, input.createdBy, cleanTitle, sourceTainted, at)

      const insertStep = db.prepare(
        `INSERT INTO dispatch_plan_steps
           (plan_id, step_id, seq, bot_id, title, instructions, depends_on_json, status, output, error, output_tainted, waiting_approval_id, waiting_question_id, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', '', 0, NULL, NULL, NULL, NULL)`,
      )
      for (const step of validated.steps) {
        insertStep.run(
          id,
          step.id,
          step.seq,
          step.botId,
          step.title,
          step.instructions,
          JSON.stringify(step.dependsOn),
        )
      }

      const initialView = getDispatchPlan(db, id)!
      const message = insertMessage(db, {
        threadId: input.threadId,
        sender: input.createdBy,
        kind: 'dispatch_plan',
        payload: viewToPayload(initialView),
      })
      db.prepare('UPDATE dispatch_plans SET message_id = ? WHERE id = ?').run(message.id, id)

      recordAction(db, {
        botId: input.createdBy,
        threadId: input.threadId,
        trigger: 'pipeline',
        tool: 'dispatch_plan',
        summary: `draft: ${cleanTitle}`,
        ok: true,
        at,
      })

      const view = getDispatchPlan(db, id)!
      return { view, message }
    })()

    broadcastUpdate(hub, txOutcome.view, txOutcome.message)
    return { ok: true, plan: txOutcome.view }
  }

  function startPlan(planId: string): StartDispatchPlanResult {
    if (stopping) {
      return {
        ok: false,
        code: 'invalid_state',
        error: 'Cannot start a dispatch plan while the gateway is shutting down.',
      }
    }

    const at = now()
    type StartTxResult =
      | { kind: 'not_found' }
      | { kind: 'invalid_state'; status: DispatchPlanStatus }
      | { kind: 'ok'; outcome: TransitionOutcome }

    const txResult = db.transaction((): StartTxResult => {
      const existing = getPlanRow(db, planId)
      if (!existing) return { kind: 'not_found' }
      const status = normalizePlanStatus(existing.status)
      if (status !== 'draft') {
        return { kind: 'invalid_state', status }
      }

      const res = db.prepare(
        `UPDATE dispatch_plans
         SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'draft'`,
      ).run(at, planId)
      if (res.changes === 0) {
        const refreshed = getPlanRow(db, planId)
        return { kind: 'invalid_state', status: refreshed ? normalizePlanStatus(refreshed.status) : status }
      }

      recordAction(db, {
        botId: existing.created_by,
        threadId: existing.thread_id,
        trigger: 'pipeline',
        tool: 'dispatch_plan',
        summary: `started: ${existing.title}`,
        ok: true,
        at,
      })

      const outcome = pumpAndRecomputeInTx(planId, at, true)!
      return { kind: 'ok', outcome }
    })()

    if (txResult.kind === 'not_found') {
      return { ok: false, code: 'not_found', error: `Dispatch plan ${planId} not found.` }
    }
    if (txResult.kind === 'invalid_state') {
      return {
        ok: false,
        code: 'invalid_state',
        error: `Dispatch plan ${planId} cannot be started from status "${txResult.status}".`,
      }
    }

    const { outcome } = txResult
    registerRuns(planId, outcome.toLaunch)
    broadcastUpdate(hub, outcome.view, outcome.patchedMessage)
    for (const launched of outcome.toLaunch) {
      scheduleStepRun(launched)
    }

    return { ok: true, plan: outcome.view }
  }

  function resumeStepAfterWait(input: ResumeStepAfterWaitInput): DispatchPlanView | null {
    const approvalId = typeof input.approvalId === 'number' && Number.isInteger(input.approvalId) && input.approvalId > 0
      ? input.approvalId
      : null
    const questionId = typeof input.questionId === 'number' && Number.isInteger(input.questionId) && input.questionId > 0
      ? input.questionId
      : null
    if (approvalId === null && questionId === null) return null

    const at = now()
    const outcome = db.transaction((): TransitionOutcome | null => {
      const target = approvalId !== null
        ? findWaitingStepByApproval(db, approvalId)
        : findWaitingStepByQuestion(db, questionId!)
      if (!target) return null

      const planRow = getPlanRow(db, target.planId)
      if (!planRow) return null
      const planStatus = normalizePlanStatus(planRow.status)
      if (planStatus !== 'running' && planStatus !== 'paused') {
        return null
      }

      const stepRow = db.prepare(
        'SELECT * FROM dispatch_plan_steps WHERE plan_id = ? AND step_id = ?',
      ).get(target.planId, target.stepId) as DispatchPlanStepRow | undefined
      if (!stepRow || normalizeStepStatus(stepRow.status) !== 'waiting_approval') {
        return null
      }

      const nextOutput = input.output !== undefined
        ? clampText(input.output, MAX_STEP_OUTPUT_CHARS)
        : (stepRow.output ?? '')
      const nextTainted = (stepRow.output_tainted === 1 || input.tainted === true) ? 1 : 0

      if (input.outcome === 'completed') {
        const res = db.prepare(
          `UPDATE dispatch_plan_steps
           SET status = 'completed',
               output = ?,
               error = '',
               output_tainted = ?,
               waiting_approval_id = NULL,
               waiting_question_id = NULL,
               finished_at = ?
           WHERE plan_id = ? AND step_id = ? AND status = 'waiting_approval'`,
        ).run(nextOutput, nextTainted, at, target.planId, target.stepId)
        if (res.changes === 0) return null
      } else {
        const nextError = clampText(input.error, MAX_STEP_ERROR_CHARS) || 'Approval discarded by operator.'
        const res = db.prepare(
          `UPDATE dispatch_plan_steps
           SET status = 'failed',
               output = ?,
               error = ?,
               output_tainted = ?,
               waiting_approval_id = NULL,
               waiting_question_id = NULL,
               finished_at = ?
           WHERE plan_id = ? AND step_id = ? AND status = 'waiting_approval'`,
        ).run(nextOutput, nextError, nextTainted, at, target.planId, target.stepId)
        if (res.changes === 0) return null
        skipTransitiveDownstreamInTx(target.planId, target.stepId, at)
      }

      return pumpAndRecomputeInTx(target.planId, at, !stopping)
    })()

    if (!outcome) return null

    if (outcome.toLaunch.length > 0 && !stopping) {
      registerRuns(outcome.view.id, outcome.toLaunch)
    }
    broadcastUpdate(hub, outcome.view, outcome.patchedMessage)
    if (outcome.toLaunch.length > 0 && !stopping) {
      for (const launched of outcome.toLaunch) {
        scheduleStepRun(launched)
      }
    }

    return outcome.view
  }

  function cancelPlan(planId: string): CancelDispatchPlanResult {
    const at = now()
    type CancelTxResult =
      | { kind: 'not_found' }
      | { kind: 'settled'; status: DispatchPlanStatus }
      | { kind: 'ok'; view: DispatchPlanView; patchedMessage: MessageRow | null }

    const txResult = db.transaction((): CancelTxResult => {
      const existing = getPlanRow(db, planId)
      if (!existing) return { kind: 'not_found' }
      const status = normalizePlanStatus(existing.status)
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        return { kind: 'settled', status }
      }

      const res = db.prepare(
        `UPDATE dispatch_plans
         SET status = 'cancelled', finished_at = ?
         WHERE id = ? AND status IN ('draft', 'running', 'paused')`,
      ).run(at, planId)
      if (res.changes === 0) {
        const refreshed = getPlanRow(db, planId)
        return { kind: 'settled', status: refreshed ? normalizePlanStatus(refreshed.status) : status }
      }

      db.prepare(
        `UPDATE dispatch_plan_steps
         SET status = 'cancelled',
             waiting_approval_id = NULL,
             waiting_question_id = NULL,
             finished_at = ?
         WHERE plan_id = ? AND status IN ('pending', 'running', 'waiting_approval')`,
      ).run(at, planId)

      const view = getDispatchPlan(db, planId)!
      const patchedMessage = patchPlanMessage(db, view)

      recordAction(db, {
        botId: view.createdBy,
        threadId: view.threadId,
        trigger: 'pipeline',
        tool: 'dispatch_plan',
        summary: `cancelled: ${view.title}`,
        ok: null,
        at,
      })

      return { kind: 'ok', view, patchedMessage }
    })()

    if (txResult.kind === 'not_found') {
      return { ok: false, code: 'not_found', error: `Dispatch plan ${planId} not found.` }
    }
    if (txResult.kind === 'settled') {
      return {
        ok: false,
        code: 'settled',
        error: `Dispatch plan ${planId} is already ${txResult.status}.`,
      }
    }

    const runs = activeRuns.get(planId)
    const controllers: AbortController[] = []
    if (runs) {
      for (const entry of runs.values()) {
        entry.cancelled = true
        controllers.push(entry.controller)
      }
    }

    broadcastUpdate(hub, txResult.view, txResult.patchedMessage)

    for (const controller of controllers) {
      if (!controller.signal.aborted) {
        try {
          controller.abort()
        } catch {
          // Ignore abort listener errors so cancelPlan always completes cleanly.
        }
      }
    }

    return { ok: true, plan: txResult.view }
  }

  function hasActive(botId?: string): boolean {
    if (botId !== undefined) {
      for (const byStep of activeRuns.values()) {
        for (const entry of byStep.values()) {
          if (entry.botId === botId) return true
        }
      }
      return false
    }
    return activeRuns.size > 0
  }

  function activeBotIds(): string[] {
    const ids = new Set<string>()
    for (const byStep of activeRuns.values()) {
      for (const entry of byStep.values()) {
        ids.add(entry.botId)
      }
    }
    return [...ids]
  }

  function activePlanCount(): number {
    return activeRuns.size
  }

  async function stopAll(): Promise<void> {
    stopping = true
    try {
      const planIds = [...activeRuns.keys()]
      for (const planId of planIds) {
        try {
          cancelPlan(planId)
        } catch {
          const runs = activeRuns.get(planId)
          if (runs) {
            for (const entry of runs.values()) {
              entry.cancelled = true
              try {
                entry.controller.abort()
              } catch {
                // Ignore abort listener errors during shutdown.
              }
            }
          }
        }
      }

      while (inFlightPromises.size > 0) {
        const batch = [...inFlightPromises]
        await Promise.allSettled(batch)
      }
    } finally {
      stopping = false
    }
  }

  return {
    createPlan,
    startPlan,
    resumeStepAfterWait,
    cancelPlan,
    hasActive,
    activeBotIds,
    activePlanCount,
    stopAll,
  }
}
