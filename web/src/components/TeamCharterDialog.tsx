import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ApiError, SignedOut, fetchTeamCharter, saveTeamCharter } from '../api'
import { useT, type T } from '../i18n'
import { errorText } from '../i18n/describe'
import { useEscape } from './ConfirmDialog'
import { XIcon } from './Icons'

export const MAX_TEAM_CHARTER_CHARS = 16_384

function formatCharterError(
  err: unknown,
  t: T,
  fallbackKey: 'teamCharter.loadFailed' | 'teamCharter.saveFailed',
): string {
  if (err instanceof ApiError) {
    const msg = errorText(t, err).trim()
    if (msg) return msg
  }
  return t(fallbackKey)
}

export function TeamCharterDialog({
  threadId,
  groupTitle,
  refreshTick = 0,
  onSignedOut,
  onClose,
}: {
  threadId: string
  groupTitle: string
  refreshTick?: number
  onSignedOut: () => void
  onClose: () => void
}) {
  const t = useT()
  const titleId = useId()
  useEscape(onClose)

  const [savedContent, setSavedContent] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = draft !== savedContent
  const normalizedDraftLength = draft.replace(/\r\n?/g, '\n').length
  const overLimit = normalizedDraftLength > MAX_TEAM_CHARTER_CHARS

  const mountedRef = useRef(true)
  const reqSeqRef = useRef(0)
  const inFlightSaveRef = useRef(false)
  const scrimDownRef = useRef(false)
  const activeThreadRef = useRef(threadId)
  activeThreadRef.current = threadId
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const savingRef = useRef(saving)
  savingRef.current = saving
  const tRef = useRef(t)
  tRef.current = t
  const onSignedOutRef = useRef(onSignedOut)
  onSignedOutRef.current = onSignedOut

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadCharter = useCallback(async (targetThreadId: string, opts: { silent: boolean }) => {
    const seq = ++reqSeqRef.current
    if (!opts.silent) {
      setLoading(true)
      setError(null)
      setSavedNotice(false)
    }
    try {
      const res = await fetchTeamCharter(targetThreadId)
      if (!mountedRef.current || seq !== reqSeqRef.current) return
      if (opts.silent && dirtyRef.current) {
        return
      }
      setSavedContent(res.content)
      setDraft(res.content)
      if (!opts.silent) setError(null)
    } catch (err: unknown) {
      if (!mountedRef.current || seq !== reqSeqRef.current) return
      if (err instanceof SignedOut) {
        onSignedOutRef.current()
        return
      }
      if (!opts.silent) {
        setError(formatCharterError(err, tRef.current, 'teamCharter.loadFailed'))
      }
    } finally {
      if (!opts.silent && mountedRef.current && seq === reqSeqRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    inFlightSaveRef.current = false
    setSaving(false)
    setSavedContent('')
    setDraft('')
    void loadCharter(threadId, { silent: false })
  }, [threadId, loadCharter])

  const prevTickRef = useRef(refreshTick)
  useEffect(() => {
    if (refreshTick === prevTickRef.current) return
    prevTickRef.current = refreshTick
    if (inFlightSaveRef.current || savingRef.current) return
    void loadCharter(threadId, { silent: true })
  }, [refreshTick, threadId, loadCharter])

  const handleSave = async () => {
    if (inFlightSaveRef.current || saving || loading || !dirty || overLimit) return
    inFlightSaveRef.current = true
    setSaving(true)
    setError(null)
    setSavedNotice(false)
    const activeThread = threadId
    try {
      const res = await saveTeamCharter(activeThread, draft)
      if (!mountedRef.current || activeThreadRef.current !== activeThread) return
      reqSeqRef.current += 1
      setSavedContent(res.content)
      setDraft(res.content)
      setSavedNotice(true)
    } catch (err: unknown) {
      if (!mountedRef.current || activeThreadRef.current !== activeThread) return
      if (err instanceof SignedOut) {
        onSignedOutRef.current()
        return
      }
      setError(formatCharterError(err, tRef.current, 'teamCharter.saveFailed'))
    } finally {
      if (activeThreadRef.current === activeThread) {
        inFlightSaveRef.current = false
        if (mountedRef.current) {
          setSaving(false)
        }
      }
    }
  }

  const locale = t.locale ?? 'en-US'
  const charCountLabel = `${normalizedDraftLength.toLocaleString(locale)} / ${MAX_TEAM_CHARTER_CHARS.toLocaleString(locale)}`
  const displayError = overLimit ? t('teamCharter.tooLong', { max: MAX_TEAM_CHARTER_CHARS }) : error

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => { scrimDownRef.current = e.target === e.currentTarget }}
      onClick={(e) => {
        if (e.target === e.currentTarget && scrimDownRef.current) onClose()
        scrimDownRef.current = false
      }}
    >
      <div
        className="modal modal-wide team-charter-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={titleId}>{t('teamCharter.title')}</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label={t('teamCharter.close')}
            title={t('teamCharter.close')}
          >
            <XIcon size={15} />
          </button>
        </div>

        <p className="team-charter-subtitle">
          {t('teamCharter.subtitle', { group: groupTitle })}
        </p>

        {loading ? (
          <div className="team-charter-loading" role="status">{t('teamCharter.loading')}</div>
        ) : (
          <div className="team-charter-body">
            <textarea
              className="team-charter-textarea"
              value={draft}
              placeholder={t('teamCharter.placeholder')}
              aria-label={t('teamCharter.title')}
              rows={12}
              disabled={saving}
              onChange={(e) => {
                setDraft(e.target.value)
                if (savedNotice) setSavedNotice(false)
                if (error) setError(null)
              }}
            />
            <div className="team-charter-meta">
              <span className={`team-charter-counter${overLimit ? ' over' : ''}`}>
                {charCountLabel}
              </span>
            </div>
          </div>
        )}

        {savedNotice ? (
          <div className="team-charter-status" role="status">{t('teamCharter.saved')}</div>
        ) : null}

        {displayError ? (
          <div className="team-charter-error" role="alert">{displayError}</div>
        ) : null}

        <div className="team-charter-actions">
          <button
            type="button"
            className="team-charter-cancel-btn"
            disabled={saving}
            onClick={onClose}
          >
            {t('teamCharter.cancel')}
          </button>
          <button
            type="button"
            className="team-charter-save-btn"
            disabled={saving || loading || !dirty || overLimit}
            onClick={() => void handleSave()}
          >
            {saving ? t('teamCharter.saving') : t('teamCharter.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
