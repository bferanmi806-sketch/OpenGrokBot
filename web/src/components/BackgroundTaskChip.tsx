import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../api'
import { useT, type MessageKey, type T } from '../i18n'
import { errorText } from '../i18n/describe'
import type { BackgroundTaskPayload, BackgroundTaskStatus, BackgroundTaskStep } from '../types'
import { CpuSparkleIcon } from './Icons'
import { Markdown } from './Markdown'

export const MAX_BG_STEER_CHARS = 1000
const RECENT_STEPS_SHOWN = 3

const CONTROL_CHARS_EXCEPT_WS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export const BG_STATUS_KEY: Record<BackgroundTaskStatus, MessageKey> = {
  queued: 'bgTask.status.queued',
  running: 'bgTask.status.running',
  completed: 'bgTask.status.completed',
  failed: 'bgTask.status.failed',
  cancelled: 'bgTask.status.cancelled',
}

export function normalizeSteerNote(raw: string): string {
  return raw.replace(CONTROL_CHARS_EXCEPT_WS, '').trim()
}

export function formatBgTaskError(
  err: unknown,
  t: T,
  fallbackKey: 'bgTask.steerFailed' | 'bgTask.cancelFailed',
): string {
  if (err instanceof ApiError) {
    if (err.code === 'settled') return t('bgTask.alreadySettled')
    const msg = errorText(t, err).trim()
    if (msg) return msg
  }
  return t(fallbackKey)
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function safeSteps(raw: unknown): BackgroundTaskStep[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (s): s is BackgroundTaskStep =>
      Boolean(s && typeof s === 'object' && typeof (s as BackgroundTaskStep).tool === 'string' && typeof (s as BackgroundTaskStep).summary === 'string'),
  )
}

export function BackgroundTaskChip({
  payload,
  onSteer,
  onCancel,
}: {
  payload: BackgroundTaskPayload
  onSteer?: (taskId: string, note: string) => void | Promise<void>
  onCancel?: (taskId: string) => void | Promise<void>
}) {
  const t = useT()
  const inFlightRef = useRef(false)
  const activeTaskIdRef = useRef(payload.taskId)
  activeTaskIdRef.current = payload.taskId

  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'steer' | 'cancel' | null>(null)
  const [cancelPending, setCancelPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const active = payload.status === 'queued' || payload.status === 'running'

  useEffect(() => {
    inFlightRef.current = false
    setNote('')
    setBusy(null)
    setCancelPending(false)
    setError(null)
    setExpanded(false)
  }, [payload.taskId])

  useEffect(() => {
    if (!active) {
      inFlightRef.current = false
      setBusy(null)
      setCancelPending(false)
      setError(null)
    }
  }, [active])

  const steps = safeSteps(payload.steps)
  const stepCount = Number.isFinite(payload.stepCount) && payload.stepCount > 0 ? payload.stepCount : 0
  const statusKey = BG_STATUS_KEY[payload.status] ?? 'bgTask.status.failed'
  const showToggle = steps.length > RECENT_STEPS_SHOWN
  const visibleSteps = expanded || !showToggle ? steps : steps.slice(-RECENT_STEPS_SHOWN)
  const locked = busy !== null || cancelPending

  const handleSteer = async (e: FormEvent) => {
    e.preventDefault()
    if (inFlightRef.current || locked || !active) return
    const cleaned = normalizeSteerNote(note)
    if (!cleaned) {
      setError(t('bgTask.emptyNote'))
      return
    }
    if (cleaned.length > MAX_BG_STEER_CHARS) {
      setError(t('bgTask.noteTooLong', { max: MAX_BG_STEER_CHARS }))
      return
    }
    if (!onSteer) return
    const taskId = payload.taskId
    inFlightRef.current = true
    setError(null)
    setBusy('steer')
    try {
      await onSteer(taskId, cleaned)
      if (activeTaskIdRef.current === taskId) {
        setNote('')
      }
    } catch (err: unknown) {
      if (activeTaskIdRef.current === taskId) {
        setError(formatBgTaskError(err, t, 'bgTask.steerFailed'))
      }
    } finally {
      if (activeTaskIdRef.current === taskId) {
        inFlightRef.current = false
        setBusy(null)
      }
    }
  }

  const handleCancel = async () => {
    if (inFlightRef.current || locked || !active || !onCancel) return
    const taskId = payload.taskId
    inFlightRef.current = true
    setError(null)
    setBusy('cancel')
    try {
      await onCancel(taskId)
      if (activeTaskIdRef.current === taskId) {
        setCancelPending(true)
      }
    } catch (err: unknown) {
      if (activeTaskIdRef.current === taskId) {
        inFlightRef.current = false
        setBusy(null)
        setCancelPending(false)
        setError(formatBgTaskError(err, t, 'bgTask.cancelFailed'))
      }
    }
  }

  return (
    <div className={`bg-task-chip status-${payload.status}`}>
      <div className="bg-task-header">
        <div className="bg-task-head">
          <span className="bg-task-label"><CpuSparkleIcon size={15} />{t('bgTask.label')}</span>
          <span className={`bg-task-status ${payload.status}`}>
            {payload.status === 'running' ? <span className="bg-task-dot" aria-hidden="true" /> : null}
            {t(statusKey)}
          </span>
          {payload.usesBrowser && active ? (
            <span className="bg-task-browser-tag">{t('bgTask.usingBrowser')}</span>
          ) : null}
        </div>
        <div className="bg-task-title">{payload.title}</div>
      </div>

      {stepCount > 0 || (steps.length === 0 && payload.lastStep) ? (
        <div className="bg-task-meta">
          {stepCount > 0 ? (
            <span className="bg-task-step-count">
              {stepCount === 1 ? t('bgTask.stepsOne') : t('bgTask.stepsMany', { count: stepCount })}
            </span>
          ) : null}
          {steps.length === 0 && payload.lastStep ? (
            <span className="bg-task-last-step">{payload.lastStep}</span>
          ) : null}
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div className="bg-task-steps-wrap">
          {showToggle ? (
            <button
              type="button"
              className="bg-task-steps-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t('bgTask.hideSteps') : t('bgTask.showSteps', { count: steps.length })}
            </button>
          ) : null}
          <ol className="bg-task-steps">
            {visibleSteps.map((s, idx) => {
              const isSteer = s.tool === 'steer'
              const itemClass = isSteer ? 'steer' : s.ok === false ? 'failed' : undefined
              return (
                <li key={`${s.at ?? idx}-${idx}`} className={itemClass}>
                  <span className="bg-task-step-mark" aria-hidden="true">
                    {isSteer ? '↪' : s.ok === undefined ? '·' : s.ok ? '✓' : '✕'}
                  </span>
                  <span className="bg-task-step-tool">{s.tool}</span>
                  <span className="bg-task-step-summary">{s.summary}</span>
                  {typeof s.ms === 'number' && Number.isFinite(s.ms) ? (
                    <span className="bg-task-step-ms">{formatMs(s.ms)}</span>
                  ) : null}
                </li>
              )
            })}
          </ol>
        </div>
      ) : null}

      {active ? (
        <>
          {error ? <div className="bg-task-error-alert" role="alert">{error}</div> : null}
          <div className="bg-task-controls">
            <form className="bg-task-steer" onSubmit={(e) => void handleSteer(e)}>
              <input
                type="text"
                className="bg-task-steer-input"
                value={note}
                placeholder={t('bgTask.steerPlaceholder')}
                aria-label={t('bgTask.steerPlaceholder')}
                disabled={locked || !onSteer}
                onChange={(e) => {
                  setNote(e.target.value)
                  if (error) setError(null)
                }}
              />
              <button
                type="submit"
                className="bg-task-steer-btn"
                disabled={locked || !onSteer}
              >
                {busy === 'steer' ? t('bgTask.steering') : t('bgTask.steerSend')}
              </button>
            </form>
            <button
              type="button"
              className="bg-task-cancel-btn"
              disabled={locked || !onCancel}
              onClick={() => void handleCancel()}
            >
              {busy === 'cancel' || cancelPending ? t('bgTask.cancelling') : t('bgTask.cancel')}
            </button>
          </div>
        </>
      ) : (
        <>
          {payload.summary ? (
            <div className="bg-task-summary markdown">
              <Markdown text={payload.summary} />
            </div>
          ) : null}
          {(payload.status === 'failed' || payload.status === 'cancelled') && payload.error ? (
            <div className="bg-task-error-text">{payload.error}</div>
          ) : null}
        </>
      )}
    </div>
  )
}
