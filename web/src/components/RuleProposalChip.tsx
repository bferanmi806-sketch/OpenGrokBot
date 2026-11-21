import { useEffect, useId, useState } from 'react'
import { ApiError } from '../api'
import { useT } from '../i18n'
import { errorText } from '../i18n/describe'
import type { RuleProposalPayload } from '../types'

export const MAX_RULE_CHARS = 300

function normalizeRuleDraft(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
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
  const [draft, setDraft] = useState(payload.rule)
  const [busy, setBusy] = useState<'accept' | 'dismiss' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(payload.rule)
    setBusy(null)
    setError(null)
  }, [payload.proposalId])

  useEffect(() => {
    if (payload.status !== 'pending') {
      setBusy(null)
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

  const formatFailure = (err: unknown): string => {
    if (err instanceof ApiError) {
      const msg = errorText(t, err).trim()
      if (msg) return msg
    }
    return t('ruleProposal.failed')
  }

  const handleAccept = async () => {
    if (busy !== null) return
    if (!normalized) {
      setError(t('ruleProposal.emptyError'))
      return
    }
    if (overLimit) {
      setError(t('ruleProposal.tooLongError', { max: MAX_RULE_CHARS }))
      return
    }
    if (!onResolve) return
    setError(null)
    setBusy('accept')
    try {
      await onResolve(payload.proposalId, 'accept', normalized)
    } catch (err: unknown) {
      setError(formatFailure(err))
    } finally {
      setBusy(null)
    }
  }

  const handleDismiss = async () => {
    if (busy !== null || !onResolve) return
    setError(null)
    setBusy('dismiss')
    try {
      await onResolve(payload.proposalId, 'dismiss')
    } catch (err: unknown) {
      setError(formatFailure(err))
    } finally {
      setBusy(null)
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
          disabled={busy !== null}
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
          disabled={busy !== null}
          onClick={() => void handleAccept()}
        >
          {busy === 'accept' ? t('ruleProposal.saving') : t('ruleProposal.accept')}
        </button>
        <button
          type="button"
          className="rule-proposal-dismiss"
          disabled={busy !== null}
          onClick={() => void handleDismiss()}
        >
          {busy === 'dismiss' ? t('ruleProposal.dismissing') : t('ruleProposal.dismiss')}
        </button>
      </div>

      <div className="rule-proposal-hint">{t('ruleProposal.hint')}</div>
    </div>
  )
}
