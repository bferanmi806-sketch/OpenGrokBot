import { useEffect, useState } from 'react'
import { ApiError } from '../api'
import { useT } from '../i18n'
import { errorText } from '../i18n/describe'
import type { ComputerInfo, WorkflowApproval, WorkflowApprovalKind, WorkflowStep, WorkflowTrace } from '../types'

type ActionStep = Exclude<WorkflowStep, { type: 'navigate' | 'unrecorded-popup' }>
type ValueStep = Extract<WorkflowStep, { type: 'fill' | 'select' }>
type WorkflowCallbacks = {
  onStartRecording?: (title: string, intent: string) => void | Promise<void>
  onStopRecording?: () => void | Promise<void>
  onCancelRecording?: () => void | Promise<void>
  onUpdateDraft?: (draftId: string, trace: WorkflowTrace) => void | Promise<void>
  onSaveDraft?: (draftId: string, trace: WorkflowTrace) => void | Promise<void>
  onDiscardDraft?: (draftId: string) => void | Promise<void>
  onRun?: (workflowId: string, bindings: Record<string, string>) => void | Promise<void>
  onStopRun?: (runId: string) => void | Promise<void>
}

const APPROVAL_KINDS: WorkflowApprovalKind[] = ['email', 'message', 'post', 'purchase', 'booking', 'other']
const PLACEHOLDER_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/

function isApprovalKind(value: string): value is WorkflowApprovalKind {
  return APPROVAL_KINDS.some((kind) => kind === value)
}

function isActionStep(step: WorkflowStep): step is ActionStep {
  return step.type !== 'navigate' && step.type !== 'unrecorded-popup'
}

function isValueStep(step: WorkflowStep): step is ValueStep {
  return step.type === 'fill' || step.type === 'select'
}

function updateStep(trace: WorkflowTrace, index: number, change: (step: WorkflowStep) => WorkflowStep): WorkflowTrace {
  return { ...trace, steps: trace.steps.map((step, stepIndex) => stepIndex === index ? change(step) : step) }
}

function updateApproval(step: WorkflowStep, approval: WorkflowApproval | null): WorkflowStep {
  if (!isActionStep(step)) return step
  const next = { ...step }
  if (approval) next.approval = approval
  else delete next.approval
  return next
}

function locatorName(step: ActionStep): string {
  const locator = step.target.candidates[0]
  if (!locator) return 'unidentified target'
  if ('role' in locator) return `${locator.role.role}: ${locator.role.name}`
  if ('label' in locator) return locator.label
  if ('placeholder' in locator) return locator.placeholder
  if ('text' in locator) return locator.text
  if ('testId' in locator) return locator.testId
  return locator.css
}

function stepDescription(step: WorkflowStep): string {
  if (step.type === 'navigate') return step.url
  if (step.type === 'unrecorded-popup') return 'unrecorded popup'
  return locatorName(step)
}

function placeholderKeys(trace: WorkflowTrace): string[] {
  const keys = new Set<string>()
  for (const [index, step] of trace.steps.entries()) {
    if (!isValueStep(step)) continue
    if (step.value.kind === 'placeholder') keys.add(step.value.key)
    else if (step.value.kind === 'redacted') keys.add(`step:${index + 1}`)
  }
  return [...keys]
}

function suggestedKey(trace: WorkflowTrace, index: number): string {
  const existing = new Set(placeholderKeys(trace))
  let candidate = `input${index + 1}`
  let suffix = index + 1
  while (existing.has(candidate)) candidate = `input${++suffix}`
  return candidate
}

function validTrace(trace: WorkflowTrace): boolean {
  if (!trace.title.trim() || trace.title.length > 120) return false
  return trace.steps.every((step) => {
    if (isValueStep(step) && step.value.kind === 'placeholder' && !PLACEHOLDER_KEY.test(step.value.key)) return false
    return !isActionStep(step) || !step.approval || Boolean(step.approval.target.trim())
  })
}

export function WorkflowSection({ info, ...callbacks }: { info: ComputerInfo } & WorkflowCallbacks) {
  const t = useT()
  const [recordTitle, setRecordTitle] = useState('')
  const [recordIntent, setRecordIntent] = useState('')
  const [draftTrace, setDraftTrace] = useState<WorkflowTrace | null>(() => info.workflowDraft?.trace ?? null)
  const [draftId, setDraftId] = useState<string | null>(() => info.workflowDraft?.id ?? null)
  const [selectedId, setSelectedId] = useState(info.savedWorkflows?.[0]?.id ?? '')
  const [runInputs, setRunInputs] = useState<Record<string, Record<string, string>>>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    const serverDraft = info.workflowDraft ?? null
    if (serverDraft?.id !== draftId) {
      setDraftId(serverDraft?.id ?? null)
      setDraftTrace(serverDraft?.trace ?? null)
    }
  }, [info.workflowDraft, draftId])

  useEffect(() => {
    const saved = info.savedWorkflows ?? []
    if (!saved.some((workflow) => workflow.id === selectedId)) setSelectedId(saved[0]?.id ?? '')
  }, [info.savedWorkflows, selectedId])

  const run = async (action: () => void | Promise<void>) => {
    setBusy(true)
    setProblem(null)
    try {
      await action()
    } catch (error) {
      setProblem(error instanceof ApiError ? errorText(t, error) : error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (!info.kind || !callbacks.onStartRecording) return null

  const saved = info.savedWorkflows ?? []
  const selected = saved.find((workflow) => workflow.id === selectedId)
  const activeRun = info.workflowRun
  const keys = selected ? placeholderKeys(selected.trace) : []
  const bindings = selected ? (runInputs[selected.id] ?? {}) : {}
  const readyToRun = Boolean(selected)
    && !selected?.trace.truncated
    && !info.workflowRun
    && keys.every((key) => (bindings[key] ?? '').length > 0)
  const readyToSave = Boolean(draftTrace && validTrace(draftTrace))

  return (
    <section className="panel-section panel-workflows" aria-label={t('panel.workflows')}>
      <div className="panel-section-title">{t('panel.workflows')}</div>

      {info.workflowRecording ? (
        <div className="panel-workflow-status" role="status">
          <span>{t('panel.workflowRecording')}</span>
          {info.kind === 'local' ? <span>{t('panel.workflowLocalRecording')}</span> : null}
          <div className="panel-workflow-actions">
            <button type="button" className="panel-copy" disabled={busy || !callbacks.onStopRecording} onClick={() => void run(() => callbacks.onStopRecording?.())}>
              {t('panel.workflowStopRecording')}
            </button>
            <button type="button" className="panel-copy" disabled={busy || !callbacks.onCancelRecording} onClick={() => void run(() => callbacks.onCancelRecording?.())}>
              {t('panel.workflowCancelRecording')}
            </button>
          </div>
        </div>
      ) : null}

      {!info.workflowRecording && !draftId ? (
        <div className="panel-workflow-card">
          <label className="panel-workflow-field">
            <span>{t('panel.workflowRecordTitle')}</span>
            <input value={recordTitle} maxLength={120} onChange={(event) => setRecordTitle(event.target.value)} />
          </label>
          <label className="panel-workflow-field">
            <span>{t('panel.workflowIntent')}</span>
            <input value={recordIntent} maxLength={500} onChange={(event) => setRecordIntent(event.target.value)} />
          </label>
          <button
            type="button"
            className="panel-copy"
            disabled={busy || !recordTitle.trim()}
            onClick={() => void run(() => callbacks.onStartRecording?.(recordTitle.trim(), recordIntent.trim()))}
          >
            {t('panel.workflowStartRecording')}
          </button>
        </div>
      ) : null}

      {draftId && draftTrace ? (
        <div className="panel-workflow-card">
          <div className="panel-workflow-status" role="status">{t('panel.workflowPendingReview')}</div>
          <label className="panel-workflow-field">
            <span>{t('panel.workflowRecordTitle')}</span>
            <input
              value={draftTrace.title}
              maxLength={120}
              onChange={(event) => setDraftTrace((current) => current ? { ...current, title: event.target.value } : current)}
            />
          </label>
          <label className="panel-workflow-field">
            <span>{t('panel.workflowIntent')}</span>
            <input
              value={draftTrace.intent ?? ''}
              maxLength={500}
              onChange={(event) => setDraftTrace((current) => {
                if (!current) return current
                const intent = event.target.value
                const next = { ...current }
                if (intent.trim()) next.intent = intent
                else delete next.intent
                return next
              })}
            />
          </label>
          <div className="panel-workflow-steps" aria-label={t('panel.workflowSteps')}>
            {draftTrace.steps.map((step, index) => (
              <div className="panel-workflow-step" key={`${index}:${step.type}`}>
                <div className="panel-workflow-step-head">
                  <strong>{t('panel.workflowStep', { count: index + 1 })}</strong>
                  <span className="panel-workflow-step-type">{step.type}</span>
                  <button
                    type="button"
                    className="panel-copy"
                    aria-label={t('panel.workflowDropStep', { count: index + 1 })}
                    disabled={busy}
                    onClick={() => setDraftTrace((current) => current ? { ...current, steps: current.steps.filter((_, stepIndex) => stepIndex !== index) } : current)}
                  >
                    {t('panel.workflowDrop')}
                  </button>
                </div>
                <div className="panel-workflow-step-description">{stepDescription(step)}</div>
                {isValueStep(step) ? (
                  <div className="panel-workflow-editor">
                    {step.value.kind === 'redacted' ? (
                      <span className="panel-workflow-muted">{t('panel.workflowSensitiveOmitted')}</span>
                    ) : step.value.kind === 'vault' ? (
                      <span className="panel-workflow-muted">{t('panel.workflowVaultValue')}</span>
                    ) : (
                      <label className="panel-workflow-field">
                        <span>{step.value.kind === 'placeholder' ? t('panel.workflowPlaceholderKey') : t('panel.workflowLiteralValue')}</span>
                        <input
                          value={step.value.kind === 'literal' ? step.value.text : step.value.key}
                          maxLength={step.value.kind === 'literal' ? 2_000 : 64}
                          onChange={(event) => {
                            const nextValue = step.value.kind === 'literal'
                              ? { kind: 'literal' as const, text: event.target.value }
                              : { kind: 'placeholder' as const, key: event.target.value }
                            setDraftTrace((current) => current ? updateStep(current, index, (currentStep) => isValueStep(currentStep) ? { ...currentStep, value: nextValue } : currentStep) : current)
                          }}
                        />
                      </label>
                    )}
                    {step.value.kind !== 'placeholder' ? (
                      <button
                        type="button"
                        className="panel-copy"
                        disabled={busy}
                        onClick={() => {
                          const key = suggestedKey(draftTrace, index)
                          setDraftTrace((current) => current ? updateStep(current, index, (currentStep) => isValueStep(currentStep)
                            ? { ...currentStep, value: { kind: 'placeholder', key } }
                            : currentStep) : current)
                        }}
                      >
                        {t('panel.workflowUsePlaceholder')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {isActionStep(step) ? (
                  <div className="panel-workflow-approval">
                    <label className="panel-workflow-check">
                      <input
                        type="checkbox"
                        checked={Boolean(step.approval)}
                        disabled={busy}
                        onChange={(event) => setDraftTrace((current) => current ? updateStep(current, index, (currentStep) => updateApproval(
                          currentStep,
                          event.target.checked ? { kind: 'other', target: '', action: '' } : null,
                        )) : current)}
                      />
                      <span>{t('panel.workflowApprovalRequired')}</span>
                    </label>
                    {step.approval ? (
                      <>
                        <label className="panel-workflow-field">
                          <span>{t('panel.workflowApprovalKind')}</span>
                          <select
                            value={step.approval.kind}
                            disabled={busy}
                            onChange={(event) => {
                              const kind = event.target.value
                              if (!isApprovalKind(kind)) return
                              setDraftTrace((current) => current ? updateStep(current, index, (currentStep) => isActionStep(currentStep) && currentStep.approval
                                ? updateApproval(currentStep, { ...currentStep.approval, kind })
                                : currentStep) : current)
                            }}
                          >
                            {APPROVAL_KINDS.map((kind) => <option value={kind} key={kind}>{kind}</option>)}
                          </select>
                        </label>
                        <label className="panel-workflow-field">
                          <span>{t('panel.workflowApprovalTarget')}</span>
                          <input
                            value={step.approval.target}
                            maxLength={200}
                            onChange={(event) => setDraftTrace((current) => current ? updateStep(current, index, (currentStep) => isActionStep(currentStep) && currentStep.approval
                              ? updateApproval(currentStep, { ...currentStep.approval, target: event.target.value })
                              : currentStep) : current)}
                          />
                        </label>
                        <label className="panel-workflow-field">
                          <span>{t('panel.workflowApprovalAction')}</span>
                          <input
                            value={step.approval.action ?? ''}
                            maxLength={200}
                            onChange={(event) => setDraftTrace((current) => current ? updateStep(current, index, (currentStep) => isActionStep(currentStep) && currentStep.approval
                              ? updateApproval(currentStep, { ...currentStep.approval, action: event.target.value })
                              : currentStep) : current)}
                          />
                        </label>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
            {draftTrace.steps.length === 0 ? <div className="panel-empty">{t('panel.workflowNoSteps')}</div> : null}
          </div>
          <div className="panel-workflow-actions">
            <button type="button" className="panel-copy" disabled={busy || !readyToSave || !callbacks.onUpdateDraft} onClick={() => void run(() => callbacks.onUpdateDraft?.(draftId, draftTrace))}>
              {t('panel.workflowSaveChanges')}
            </button>
            <button type="button" className="panel-copy" disabled={busy || !readyToSave || !callbacks.onSaveDraft} onClick={() => void run(() => callbacks.onSaveDraft?.(draftId, draftTrace))}>
              {t('panel.workflowSave')}
            </button>
            <button type="button" className="panel-copy" disabled={busy || !callbacks.onDiscardDraft} onClick={() => void run(() => callbacks.onDiscardDraft?.(draftId))}>
              {t('panel.workflowDiscard')}
            </button>
          </div>
        </div>
      ) : null}

      {activeRun ? (
        <div className="panel-workflow-status" role="status">
          <span>{t('panel.workflowRunActive', { id: activeRun.workflowId })}</span>
          <button type="button" className="panel-copy" disabled={busy || !callbacks.onStopRun} onClick={() => void run(() => callbacks.onStopRun?.(activeRun.runId))}>
            {t('panel.workflowStopRun')}
          </button>
        </div>
      ) : null}

      <div className="panel-workflow-card">
        <label className="panel-workflow-field">
          <span>{t('panel.workflowSaved')}</span>
          <select value={selectedId} disabled={saved.length === 0} onChange={(event) => setSelectedId(event.target.value)}>
            {saved.length === 0 ? <option value="">{t('panel.workflowEmpty')}</option> : null}
            {saved.map((workflow) => <option value={workflow.id} key={workflow.id}>{workflow.trace.title}</option>)}
          </select>
        </label>
        {selected?.trace.truncated ? <div className="panel-workflow-muted">{t('panel.workflowTruncated')}</div> : null}
        {keys.map((key) => (
          <label className="panel-workflow-field" key={key}>
            <span>{key.startsWith('step:') ? t('panel.workflowSensitiveInput', { step: key.slice(5) }) : key}</span>
            <input
              type={key.startsWith('step:') || /(?:pass|secret|token|credential|otp|pin)/i.test(key) ? 'password' : 'text'}
              value={bindings[key] ?? ''}
              onChange={(event) => setRunInputs((current) => ({
                ...current,
                [selectedId]: { ...(current[selectedId] ?? {}), [key]: event.target.value },
              }))}
            />
          </label>
        ))}
        {selected ? (
          <div className="panel-workflow-actions">
            <button
              type="button"
              className="panel-copy"
              disabled={busy || !readyToRun || !callbacks.onRun}
              onClick={() => {
                const workflowId = selected.id
                const values = { ...bindings }
                setRunInputs((current) => {
                  const next = { ...current }
                  delete next[workflowId]
                  return next
                })
                void run(() => callbacks.onRun?.(workflowId, values))
              }}
            >
              {t('panel.workflowRun')}
            </button>
          </div>
        ) : <div className="panel-empty">{t('panel.workflowEmpty')}</div>}
      </div>

      {problem ? <div className="panel-problem" role="alert">{problem}</div> : null}
    </section>
  )
}
