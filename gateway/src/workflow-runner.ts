import type { PageLike, WorkflowElementLike } from './browser-page.js'
import type { ApprovalKind } from './approvals.js'
import { sanitizeWorkflowUrl, type WorkflowApproval, type WorkflowStep, type WorkflowTarget, type WorkflowTrace } from './workflows.js'

export const MAX_WORKFLOW_BINDINGS_BYTES = 1_000_000
export const MAX_WORKFLOW_RUN_REQUEST_BYTES = 6_500_000
const MAX_WORKFLOW_BINDINGS = 1_000
const MAX_WORKFLOW_BINDING_CHARS = 2_000
const LOCATOR_TIMEOUT_MS = 3_000
const ACTION_TIMEOUT_MS = 10_000

export type WorkflowBindings = ReadonlyMap<string, string>

export type WorkflowApprovalRequest = {
  step: number
  steps: number
  action: string
  kind: ApprovalKind
  target: string
  rulesAllowed: boolean
}

export type WorkflowApprovalDecision =
  | { status: 'approved' }
  | { status: 'waiting'; approvalId: number }

export type WorkflowStepEvent = { index: number; type: WorkflowStep['type']; ok: boolean; durationMs: number }

export type WorkflowFailureCode =
  | 'cancelled'
  | 'browser_unavailable'
  | 'unsupported_browser'
  | 'target_not_found'
  | 'action_failed'
  | 'url_mismatch'
  | 'popup_opened'

export type WorkflowRunResult =
  | { status: 'completed'; stepsCompleted: number }
  | { status: 'waiting'; approvalId: number; step: number; stepsCompleted: number }
  | { status: 'failed'; step: number; code: WorkflowFailureCode; stepsCompleted: number }

export class WorkflowReplayValidationError extends TypeError {
  constructor(readonly code: 'invalid_bindings' | 'missing_bindings' | 'unexpected_bindings' | 'trace_truncated' | 'unsupported_reference' | 'unrecorded_popup') {
    super(code)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse call-time values into memory only; no caller-supplied value is returned in an error. */
export function parseWorkflowBindings(trace: WorkflowTrace, value: unknown): { bindings: Map<string, string>; hasDynamicValues: boolean } {
  const needed = new Set<string>()
  for (const [index, step] of trace.steps.entries()) {
    if (step.type !== 'fill' && step.type !== 'select') continue
    if (step.value.kind === 'placeholder') needed.add(step.value.key)
    if (step.value.kind === 'redacted') needed.add(`step:${index + 1}`)
  }
  if (needed.size > MAX_WORKFLOW_BINDINGS) throw new WorkflowReplayValidationError('invalid_bindings')

  const raw = value === undefined ? {} : value
  if (!isRecord(raw) || Object.keys(raw).length > MAX_WORKFLOW_BINDINGS) {
    throw new WorkflowReplayValidationError('invalid_bindings')
  }
  const keys = Object.keys(raw)
  if (keys.some((key) => !needed.has(key))) throw new WorkflowReplayValidationError('unexpected_bindings')
  if ([...needed].some((key) => !Object.hasOwn(raw, key))) throw new WorkflowReplayValidationError('missing_bindings')

  const bindings = new Map<string, string>()
  let bytes = 0
  for (const key of needed) {
    const input = raw[key]
    if (typeof input !== 'string' || input.length > MAX_WORKFLOW_BINDING_CHARS) {
      throw new WorkflowReplayValidationError('invalid_bindings')
    }
    bytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(input, 'utf8')
    if (bytes > MAX_WORKFLOW_BINDINGS_BYTES) throw new WorkflowReplayValidationError('invalid_bindings')
    bindings.set(key, input)
  }
  return { bindings, hasDynamicValues: needed.size > 0 }
}

/** Reject trace shapes whose effect cannot yet be replayed without guessing. */
export function assertWorkflowReplayable(trace: WorkflowTrace): void {
  if (trace.truncated) throw new WorkflowReplayValidationError('trace_truncated')
  for (const step of trace.steps) {
    if (step.type === 'unrecorded-popup') throw new WorkflowReplayValidationError('unrecorded_popup')
    if (step.page !== undefined || step.frame !== undefined) {
      throw new WorkflowReplayValidationError('unsupported_reference')
    }
  }
}

function targetLocator(page: PageLike, candidate: WorkflowTarget['candidates'][number]): WorkflowElementLike | null {
  let locator
  if ('role' in candidate) locator = page.getByRole?.(candidate.role.role, { name: candidate.role.name, exact: true })
  else if ('label' in candidate) locator = page.getByLabel?.(candidate.label, { exact: true })
  else if ('placeholder' in candidate) locator = page.getByPlaceholder?.(candidate.placeholder, { exact: true })
  else if ('text' in candidate) locator = page.getByText?.(candidate.text, { exact: true })
  else if ('testId' in candidate) locator = page.getByTestId?.(candidate.testId)
  else locator = page.locator?.(candidate.css)
  return locator?.first() ?? null
}

async function firstVisibleTarget(page: PageLike, target: WorkflowTarget): Promise<WorkflowElementLike> {
  let hasLocator = false
  for (const candidate of target.candidates) {
    const locator = targetLocator(page, candidate)
    if (!locator) continue
    hasLocator = true
    if (!locator.waitFor) throw new RunnerError('unsupported_browser')
    try {
      await locator.waitFor({ state: 'visible', timeout: LOCATOR_TIMEOUT_MS })
      return locator
    } catch {
      // Visibility checks have no action side effects, so trying the next recorded strategy is safe.
    }
  }
  throw new RunnerError(hasLocator ? 'target_not_found' : 'unsupported_browser')
}

class RunnerError extends Error {
  constructor(readonly code: WorkflowFailureCode) { super(code) }
}

function approvalFor(step: WorkflowStep, index: number, total: number, rulesAllowed: boolean): WorkflowApprovalRequest | null {
  if (step.type === 'navigate' || step.type === 'unrecorded-popup') return null
  const metadata: WorkflowApproval | undefined = step.approval
  return {
    step: index + 1,
    steps: total,
    action: metadata?.action ?? `run workflow step ${index + 1}: ${step.type}`,
    kind: metadata?.kind ?? 'other',
    target: metadata?.target ?? '',
    rulesAllowed: rulesAllowed && metadata !== undefined,
  }
}

async function executeStep(
  step: WorkflowStep,
  index: number,
  getPage: () => Promise<PageLike>,
  bindings: WorkflowBindings,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new RunnerError('cancelled')
  const page = await getPage().catch(() => { throw new RunnerError('browser_unavailable') })
  let popupOpened = false
  const onPopup = () => { popupOpened = true }
  page.on?.('popup', onPopup)
  try {
    if (step.type === 'navigate') {
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    } else if (step.type !== 'unrecorded-popup') {
      const target = await firstVisibleTarget(page, step.target)
      switch (step.type) {
        case 'click':
          if (!target.click) throw new RunnerError('unsupported_browser')
          await target.click({ timeout: ACTION_TIMEOUT_MS })
          break
        case 'check':
          if (!target.check) throw new RunnerError('unsupported_browser')
          await target.check({ timeout: ACTION_TIMEOUT_MS })
          break
        case 'uncheck':
          if (!target.uncheck) throw new RunnerError('unsupported_browser')
          await target.uncheck({ timeout: ACTION_TIMEOUT_MS })
          break
        case 'press':
          if (!target.press) throw new RunnerError('unsupported_browser')
          await target.press(step.key, { timeout: ACTION_TIMEOUT_MS })
          break
        case 'fill': {
          if (!target.fill) throw new RunnerError('unsupported_browser')
          const key = step.value.kind === 'placeholder' ? step.value.key
            : step.value.kind === 'redacted' ? `step:${index + 1}` : null
          const text = step.value.kind === 'literal' ? step.value.text : key === null ? '' : bindings.get(key)
          if (text === undefined) throw new RunnerError('action_failed')
          await target.fill(text, { timeout: ACTION_TIMEOUT_MS })
          break
        }
        case 'select': {
          if (!target.selectOption) throw new RunnerError('unsupported_browser')
          const key = step.value.kind === 'placeholder' ? step.value.key
            : step.value.kind === 'redacted' ? `step:${index + 1}` : null
          const value = step.value.kind === 'literal' ? step.value.text : key === null ? '' : bindings.get(key)
          if (value === undefined) throw new RunnerError('action_failed')
          await target.selectOption(value, { timeout: ACTION_TIMEOUT_MS })
          break
        }
      }
    }
    if (signal?.aborted) throw new RunnerError('cancelled')
    if (popupOpened) throw new RunnerError('popup_opened')
    if (step.type !== 'navigate' && step.type !== 'unrecorded-popup' && step.expect) {
      const current = await getPage().catch(() => { throw new RunnerError('browser_unavailable') })
      if (sanitizeWorkflowUrl(current.url()) !== step.expect.url) throw new RunnerError('url_mismatch')
    }
  } catch (error) {
    if (error instanceof RunnerError) throw error
    if (signal?.aborted) throw new RunnerError('cancelled')
    throw new RunnerError('action_failed')
  } finally {
    page.off?.('popup', onPopup)
  }
}

export async function runWorkflow(trace: WorkflowTrace, options: {
  getPage: () => Promise<PageLike>
  bindings: WorkflowBindings
  rulesAllowed: boolean
  authorize: (request: WorkflowApprovalRequest) => Promise<WorkflowApprovalDecision>
  startIndex?: number
  approvedStepIndex?: number
  signal?: AbortSignal
  onStep?: (event: WorkflowStepEvent) => void | Promise<void>
}): Promise<WorkflowRunResult> {
  assertWorkflowReplayable(trace)
  const startIndex = options.startIndex ?? 0
  let stepsCompleted = startIndex
  for (let index = startIndex; index < trace.steps.length; index++) {
    if (options.signal?.aborted) return { status: 'failed', step: index + 1, code: 'cancelled', stepsCompleted }
    const step = trace.steps[index]!
    const approval = approvalFor(step, index, trace.steps.length, options.rulesAllowed)
    if (approval && index !== options.approvedStepIndex) {
      const decision = await options.authorize(approval)
      if (decision.status === 'waiting') {
        return { status: 'waiting', approvalId: decision.approvalId, step: index + 1, stepsCompleted }
      }
    }
    const started = Date.now()
    try {
      await executeStep(step, index, options.getPage, options.bindings, options.signal)
      await reportStep(options.onStep, { index: index + 1, type: step.type, ok: true, durationMs: Date.now() - started })
      stepsCompleted++
    } catch (error) {
      const code = error instanceof RunnerError ? error.code : 'action_failed'
      await reportStep(options.onStep, { index: index + 1, type: step.type, ok: false, durationMs: Date.now() - started })
      return { status: 'failed', step: index + 1, code, stepsCompleted }
    }
  }
  return { status: 'completed', stepsCompleted }
}

async function reportStep(callback: ((event: WorkflowStepEvent) => void | Promise<void>) | undefined, event: WorkflowStepEvent): Promise<void> {
  try {
    await callback?.(event)
  } catch {
    // Observability must not change whether a browser action is considered complete.
  }
}
