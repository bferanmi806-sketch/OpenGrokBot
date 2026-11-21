import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api'
import { useT, type MessageKey, type T } from '../i18n'
import { errorText } from '../i18n/describe'
import type { DispatchPlanPayload, DispatchPlanStatus, DispatchStepStatus, DispatchStepView } from '../types'
import { Markdown } from './Markdown'

export const PLAN_STATUS_KEY: Record<DispatchPlanStatus, MessageKey> = {
  draft: 'dispatch.status.draft',
  running: 'dispatch.status.running',
  paused: 'dispatch.status.paused',
  completed: 'dispatch.status.completed',
  failed: 'dispatch.status.failed',
  cancelled: 'dispatch.status.cancelled',
}

export const STEP_STATUS_KEY: Record<DispatchStepStatus, MessageKey> = {
  pending: 'dispatch.stepStatus.pending',
  running: 'dispatch.stepStatus.running',
  waiting_approval: 'dispatch.stepStatus.waiting_approval',
  completed: 'dispatch.stepStatus.completed',
  failed: 'dispatch.stepStatus.failed',
  skipped: 'dispatch.stepStatus.skipped',
  cancelled: 'dispatch.stepStatus.cancelled',
}

export function formatDispatchPlanError(
  err: unknown,
  t: T,
  fallbackKey: 'dispatch.startFailed' | 'dispatch.cancelFailed',
): string {
  if (err instanceof ApiError) {
    if (err.status === 409 || err.code === 'settled' || err.code === 'invalid_state') {
      return t('dispatch.alreadySettled')
    }
    const msg = errorText(t, err).trim()
    if (msg) return msg
  }
  return t(fallbackKey)
}

function safeSteps(raw: unknown): DispatchStepView[] {
  if (!Array.isArray(raw)) return []
  const out: DispatchStepView[] = []
  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx]
    if (!item || typeof item !== 'object') continue
    const s = item as Partial<DispatchStepView>
    if (typeof s.id !== 'string' || typeof s.title !== 'string') continue
    const deps = Array.isArray(s.dependsOn)
      ? s.dependsOn.filter((d): d is string => typeof d === 'string' && d.trim() !== '')
      : []
    out.push({
      id: s.id,
      seq: typeof s.seq === 'number' && Number.isFinite(s.seq) ? s.seq : idx,
      wave: typeof s.wave === 'number' && Number.isFinite(s.wave) ? s.wave : 0,
      botId: typeof s.botId === 'string' ? s.botId : '',
      title: s.title,
      instructions: typeof s.instructions === 'string' ? s.instructions : '',
      dependsOn: deps,
      status: s.status && Object.hasOwn(STEP_STATUS_KEY, s.status) ? s.status : 'pending',
      output: typeof s.output === 'string' ? s.output : '',
      error: typeof s.error === 'string' ? s.error : '',
      outputTainted: Boolean(s.outputTainted),
      waitingApprovalId: typeof s.waitingApprovalId === 'number' ? s.waitingApprovalId : null,
      waitingQuestionId: typeof s.waitingQuestionId === 'number' ? s.waitingQuestionId : null,
      startedAt: typeof s.startedAt === 'number' ? s.startedAt : null,
      finishedAt: typeof s.finishedAt === 'number' ? s.finishedAt : null,
    })
  }
  return out.sort((a, b) => a.seq - b.seq)
}

export function DispatchPlanChip({
  payload,
  roster,
  onStart,
  onCancel,
}: {
  payload: DispatchPlanPayload
  roster?: Record<string, { name: string; emoji: string }>
  onStart?: (planId: string) => void | Promise<void>
  onCancel?: (planId: string) => void | Promise<void>
}) {
  const t = useT()
  const inFlightRef = useRef(false)
  const activePlanIdRef = useRef(payload.planId)
  activePlanIdRef.current = payload.planId

  const [busy, setBusy] = useState<'start' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({})

  const isDraft = payload.status === 'draft'
  const isActive = payload.status === 'running' || payload.status === 'paused'
  const cancellable = isDraft || isActive

  useEffect(() => {
    inFlightRef.current = false
    setBusy(null)
    setError(null)
    setExpandedOutputs({})
  }, [payload.planId])

  useEffect(() => {
    setError(null)
    if (!cancellable) {
      inFlightRef.current = false
      setBusy(null)
    }
  }, [payload.status, cancellable])

  const steps = safeSteps(payload.steps)
  const planStatusKey = PLAN_STATUS_KEY[payload.status] ?? 'dispatch.status.failed'

  const toggleOutput = (stepId: string) => {
    setExpandedOutputs((prev) => ({ ...prev, [stepId]: !prev[stepId] }))
  }

  const handleStart = async () => {
    if (inFlightRef.current || busy !== null || !isDraft || !onStart) return
    const planId = payload.planId
    inFlightRef.current = true
    setError(null)
    setBusy('start')
    try {
      await onStart(planId)
    } catch (err: unknown) {
      if (activePlanIdRef.current === planId) {
        setError(formatDispatchPlanError(err, t, 'dispatch.startFailed'))
      }
    } finally {
      if (activePlanIdRef.current === planId) {
        inFlightRef.current = false
        setBusy(null)
      }
    }
  }

  const handleCancel = async () => {
    if (inFlightRef.current || busy !== null || !cancellable || !onCancel) return
    const planId = payload.planId
    inFlightRef.current = true
    setError(null)
    setBusy('cancel')
    try {
      await onCancel(planId)
    } catch (err: unknown) {
      if (activePlanIdRef.current === planId) {
        setError(formatDispatchPlanError(err, t, 'dispatch.cancelFailed'))
      }
    } finally {
      if (activePlanIdRef.current === planId) {
        inFlightRef.current = false
        setBusy(null)
      }
    }
  }

  return (
    <div className={`dispatch-plan-chip status-${payload.status}`}>
      <div className="dispatch-plan-head">
        <span className="dispatch-plan-label">{t('dispatch.label')}</span>
        <span className={`dispatch-status ${payload.status}`}>
          {payload.status === 'running' ? <span className="dispatch-status-dot" aria-hidden="true" /> : null}
          {t(planStatusKey)}
        </span>
        {payload.sourceTainted ? (
          <span className="dispatch-tainted-pill">{t('dispatch.taintedBadge')}</span>
        ) : null}
      </div>

      <div className="dispatch-plan-title">{payload.title}</div>

      {steps.length > 0 ? (
        <ol className="dispatch-steps">
          {steps.map((step) => {
            const deps = Array.isArray(step.dependsOn) ? step.dependsOn : []
            const member = roster && Object.hasOwn(roster, step.botId) ? roster[step.botId] : undefined
            const assigneeLabel = member
              ? `${member.emoji ? `${member.emoji} ` : ''}${member.name}`
              : `@${step.botId}`
            const stepStatusKey = STEP_STATUS_KEY[step.status] ?? 'dispatch.stepStatus.failed'
            const hasOutput = step.output.trim().length > 0
            const outputExpanded = Boolean(expandedOutputs[step.id])

            return (
              <li key={step.id} className={`dispatch-step status-${step.status}`}>
                <div className="dispatch-step-head">
                  <span className="dispatch-step-wave">{t('dispatch.wave', { wave: step.wave + 1 })}</span>
                  <span className="dispatch-step-assignee">{assigneeLabel}</span>
                  <span className="dispatch-step-id">{step.id}</span>
                  <span className={`dispatch-step-status ${step.status}`}>
                    {step.status === 'running' ? <span className="dispatch-status-dot" aria-hidden="true" /> : null}
                    {t(stepStatusKey)}
                  </span>
                </div>

                <div className="dispatch-step-title">{step.title}</div>

                {deps.length > 0 ? (
                  <div className="dispatch-step-deps">
                    {t('dispatch.after', { deps: deps.join(', ') })}
                  </div>
                ) : null}

                {step.error ? (
                  <div className="dispatch-step-error">{step.error}</div>
                ) : null}

                {hasOutput ? (
                  <div className="dispatch-step-output-wrap">
                    <button
                      type="button"
                      className="dispatch-step-output-toggle"
                      aria-expanded={outputExpanded}
                      onClick={() => toggleOutput(step.id)}
                    >
                      {outputExpanded ? t('dispatch.hideOutput') : t('dispatch.showOutput')}
                    </button>
                    {outputExpanded ? (
                      <div className="dispatch-step-output markdown">
                        <Markdown text={step.output} />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : null}

      {payload.error ? (
        <div className="dispatch-plan-error">{payload.error}</div>
      ) : null}

      {error ? (
        <div className="dispatch-plan-alert" role="alert">{error}</div>
      ) : null}

      {cancellable ? (
        <div className="dispatch-plan-footer">
          {isDraft ? (
            <div className="dispatch-plan-hint">{t('dispatch.draftHint')}</div>
          ) : null}
          <div className="dispatch-plan-actions">
            {isDraft ? (
              <button
                type="button"
                className="dispatch-start-btn"
                disabled={busy !== null || !onStart}
                onClick={() => void handleStart()}
              >
                {busy === 'start' ? t('dispatch.starting') : t('dispatch.start')}
              </button>
            ) : null}
            <button
              type="button"
              className="dispatch-cancel-btn"
              disabled={busy !== null || !onCancel}
              onClick={() => void handleCancel()}
            >
              {busy === 'cancel' ? t('dispatch.cancelling') : t('dispatch.cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
