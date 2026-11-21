import { useEffect, useId, useRef, useState } from 'react'
import { ApiError } from '../api'
import { useT } from '../i18n'
import { errorText } from '../i18n/describe'
import type { RuleProposalPayload } from '../types'

export const MAX_RULE_CHARS = 300

function normalizeRuleDraft(raw: string): string {
  let clean = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  while (/^-\s*/.test(clean)) {
    clean = clean.replace(/^-+\s*/, '').trim()
  }
  return clean
}

export function RuleProposalChip({
  payload,
  onResolve,
}: {
  payload: RuleProposalPayload
  onResolve?: (proposalId: number, decision: 'accept' | 'dismiss', rule?: string) => void | Promise<void>
}) {
  const t = useT()
  const inputId = useId()
  const inFlightRef = useRef(false)
  const activeIdRef = useRef(payload.proposalId)
  activeIdRef.current = payload.proposalId
  const [draft, setDraft] = useState(payload.rule)
  const [busy, setBusy] = useState<'accept' | 'dismiss' | null>(null)
  const [settledLocal, setSettledLocal] = useState<'accepted' | 'dismissed' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    inFlightRef.current = false
    setDraft(payload.rule)
    setBusy(null)
    setSettledLocal(null)
    setError(null)
  }, [payload.proposalId])

  useEffect(() => {
    if (payload.status !== 'pending') {
      inFlightRef.current = false
      setBusy(null)
      setSettledLocal(null)
      setError(null)
    }
  }, [payload.status])

  const sourceLabel = t(
    payload.source === 'discard_pattern'
      ? 'ruleProposal.sourceDiscard'
      : 'ruleProposal.sourceAgent',
  )

  if (payload.status !== 'pending') {
    const resolvedLabel = payload.status === 'accepted'
      ? t(payload.edited ? 'ruleProposal.acceptedEdited' : 'ruleProposal.accepted')
      : t('ruleProposal.dismissed')
    return (
      <div className={`rule-proposal-chip resolved ${payload.status}`}>
        <div className="rule-proposal-head">
          <div className="rule-proposal-label">{resolvedLabel}</div>
          <span className="rule-proposal-source">{sourceLabel}</span>
          {payload.sourceTainted ? (
            <span className="rule-proposal-tainted-pill">{t('ruleProposal.taintedBadge')}</span>
          ) : null}
        </div>
        <div className={`rule-proposal-rule${payload.status === 'dismissed' ? ' dismissed' : ''}`}>
          {payload.rule}
        </div>
        {payload.reason ? <div className="rule-proposal-reason">{payload.reason}</div> : null}
      </div>
    )
  }

  const normalized = normalizeRuleDraft(draft)
  const overLimit = normalized.length > MAX_RULE_CHARS
  const locked = busy !== null || settledLocal !== null

  const formatFailure = (err: unknown): string => {
    if (err instanceof ApiError) {
      const msg = errorText(t, err).trim()
      if (msg) return msg
    }
    return t('ruleProposal.failed')
  }

  const handleAccept = async () => {
    if (inFlightRef.current || locked) return
    if (!normalized) {
      setError(t('ruleProposal.emptyError'))
      return
    }
    if (overLimit) {
      setError(t('ruleProposal.tooLongError', { max: MAX_RULE_CHARS }))
      return
    }
    if (!onResolve) return
    const proposalId = payload.proposalId
    inFlightRef.current = true
    setError(null)
    setBusy('accept')
    try {
      await onResolve(proposalId, 'accept', normalized)
      if (activeIdRef.current === proposalId) {
        setSettledLocal('accepted')
      }
    } catch (err: unknown) {
      if (activeIdRef.current === proposalId) {
        inFlightRef.current = false
        setBusy(null)
        setSettledLocal(null)
        setError(formatFailure(err))
      }
    }
  }

  const handleDismiss = async () => {
    if (inFlightRef.current || locked || !onResolve) return
    const proposalId = payload.proposalId
    inFlightRef.current = true
    setError(null)
    setBusy('dismiss')
    try {
      await onResolve(proposalId, 'dismiss')
      if (activeIdRef.current === proposalId) {
        setSettledLocal('dismissed')
      }
    } catch (err: unknown) {
      if (activeIdRef.current === proposalId) {
        inFlightRef.current = false
        setBusy(null)
        setSettledLocal(null)
        setError(formatFailure(err))
      }
    }
  }

  return (
    <div className={`rule-proposal-chip${payload.sourceTainted ? ' tainted' : ''}`}>
      <div className="rule-proposal-head">
        <div className="rule-proposal-label">{t('ruleProposal.title')}</div>
        <span className="rule-proposal-source">{sourceLabel}</span>
      </div>

      {payload.sourceTainted ? (
        <div className="rule-proposal-tainted" role="note">
          <span className="rule-proposal-tainted-icon" aria-hidden="true">⚠</span>
          <span>{t('ruleProposal.taintedBadge')}</span>
        </div>
      ) : null}

      {payload.reason ? <div className="rule-proposal-reason">{payload.reason}</div> : null}

      <div className="rule-proposal-field">
        <div className="rule-proposal-field-head">
          <label htmlFor={inputId}>{t('ruleProposal.ruleLabel')}</label>
          <span className={`rule-proposal-counter${overLimit ? ' over' : ''}`}>
            {normalized.length} / {MAX_RULE_CHARS}
          </span>
        </div>
        <textarea
          id={inputId}
          className="rule-proposal-input"
          rows={2}
          value={draft}
          placeholder={t('ruleProposal.rulePlaceholder')}
          disabled={locked}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
        />
      </div>

      {error ? <div className="rule-proposal-error" role="alert">{error}</div> : null}

      <div className="rule-proposal-actions">
        <button
          type="button"
          className="rule-proposal-accept"
          disabled={locked || !onResolve}
          onClick={() => void handleAccept()}
        >
          {busy === 'accept' || settledLocal === 'accepted' ? t('ruleProposal.saving') : t('ruleProposal.accept')}
        </button>
        <button
          type="button"
          className="rule-proposal-dismiss"
          disabled={locked || !onResolve}
          onClick={() => void handleDismiss()}
        >
          {busy === 'dismiss' || settledLocal === 'dismissed' ? t('ruleProposal.dismissing') : t('ruleProposal.dismiss')}
        </button>
      </div>

      <div className="rule-proposal-hint">{t('ruleProposal.hint')}</div>
    </div>
  )
}
