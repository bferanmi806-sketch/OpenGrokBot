import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiError,
  SignedOut,
  createWikiPage,
  deleteWikiPage,
  fetchWiki,
  fetchWikiPage,
  revertWikiPage,
  saveWikiPage,
} from '../api'
import { useT, type MessageKey, type T } from '../i18n'
import { en } from '../i18n/en'
import { errorText } from '../i18n/describe'
import type {
  Bot,
  WikiCreateInput,
  WikiKind,
  WikiPageDetail,
  WikiPageSummary,
  WikiRevision,
  WikiSaveInput,
} from '../types'
import { ConfirmDialog, useEscape } from './ConfirmDialog'
import { ChevronRightIcon, PlusIcon, XIcon } from './Icons'
import { Markdown } from './Markdown'

export type WikiRoster = Record<string, { name: string; emoji?: string }> | readonly Pick<Bot, 'id' | 'name'>[]

type KindFilter = 'all' | WikiKind
type Mode = 'view' | 'create' | 'edit'
type PageKey = { id: string; kind: WikiKind; slug: string }

const WIKI_KINDS: WikiKind[] = ['contact', 'client', 'project', 'topic']
const FILTER_OPTIONS: KindFilter[] = ['all', 'contact', 'client', 'project', 'topic']

const knownWikiError = (code: string | undefined): MessageKey | null => {
  if (!code) return null
  const key = `wiki.error.${code}`
  return Object.hasOwn(en, key) ? (key as MessageKey) : null
}

function wikiErrorMessage(t: T, err: unknown, fallbackKey?: MessageKey): string {
  if (err instanceof ApiError) {
    const key = knownWikiError(err.code)
    if (key) return t(key)
    const mapped = errorText(t, err)
    if (mapped) return mapped
  }
  if (err instanceof Error && err.message) return err.message
  return fallbackKey ? t(fallbackKey) : String(err)
}

function resolveEditorName(updatedBy: string, roster: WikiRoster, t: T): string {
  if (updatedBy === 'operator') return t('wiki.byOperator')
  if (Array.isArray(roster)) {
    return roster.find((b) => b.id === updatedBy)?.name ?? updatedBy
  }
  return (roster as Record<string, { name: string; emoji?: string }>)[updatedBy]?.name ?? updatedBy
}

function parseTags(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[,，]/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

function formatWikiTime(ts: number | undefined, locale: string | undefined): string | null {
  if (!ts || ts < 86_400_000) return null
  return new Date(ts).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function WikiDialog({
  roster,
  refreshTick = 0,
  onClose,
  onSignedOut,
}: {
  roster: WikiRoster
  refreshTick?: number
  onClose: () => void
  onSignedOut?: () => void
}) {
  const t = useT()
  const tRef = useRef(t)
  tRef.current = t
  const onSignedOutRef = useRef(onSignedOut)
  onSignedOutRef.current = onSignedOut

  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [queryInput, setQueryInput] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [pages, setPages] = useState<WikiPageSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [selectedKey, setSelectedKey] = useState<PageKey | null>(null)
  const [detail, setDetail] = useState<WikiPageDetail | null>(null)
  const [revisions, setRevisions] = useState<WikiRevision[]>([])
  const [loadingPage, setLoadingPage] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const [mode, setMode] = useState<Mode>('view')
  const [formKind, setFormKind] = useState<WikiKind>('topic')
  const [formTitle, setFormTitle] = useState('')
  const [formSlug, setFormSlug] = useState('')
  const [formSummary, setFormSummary] = useState('')
  const [formTags, setFormTags] = useState('')
  const [formBody, setFormBody] = useState('')
  const [formNote, setFormNote] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [revertingVersion, setRevertingVersion] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<WikiPageDetail | null>(null)
  const [confirmRevert, setConfirmRevert] = useState<{ page: WikiPageDetail; version: number } | null>(null)

  const mountedRef = useRef(true)
  const listSeqRef = useRef(0)
  const pageSeqRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scrimDown = useRef(false)

  const modeRef = useRef(mode)
  modeRef.current = mode
  const selectedKeyRef = useRef(selectedKey)
  selectedKeyRef.current = selectedKey
  const queryRef = useRef(activeQuery)
  queryRef.current = activeQuery
  const kindRef = useRef(kindFilter)
  kindRef.current = kindFilter

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (debounceTimerRef.current !== undefined) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = undefined
      }
    }
  }, [])

  const loadList = useCallback(async (q: string, kind: KindFilter, opts?: { silent?: boolean }) => {
    const seq = ++listSeqRef.current
    if (!opts?.silent) setLoadingList(true)
    setListError(null)
    try {
      const trimmed = q.trim()
      const res = await fetchWiki({
        ...(trimmed ? { q: trimmed } : {}),
        ...(kind !== 'all' ? { kind } : {}),
      })
      if (!mountedRef.current || seq !== listSeqRef.current) return
      setPages(res.pages)
      setTotal(res.total)
    } catch (err) {
      if (!mountedRef.current || seq !== listSeqRef.current) return
      if (err instanceof SignedOut) {
        onSignedOutRef.current?.()
        return
      }
      setListError(wikiErrorMessage(tRef.current, err, 'wiki.error.loadFailed'))
    } finally {
      if (mountedRef.current && seq === listSeqRef.current) {
        setLoadingList(false)
      }
    }
  }, [])

  const loadPage = useCallback(async (kind: WikiKind, slug: string, opts?: { silent?: boolean }) => {
    const seq = ++pageSeqRef.current
    if (!opts?.silent) setLoadingPage(true)
    setPageError(null)
    try {
      const res = await fetchWikiPage(kind, slug)
      if (!mountedRef.current || seq !== pageSeqRef.current) return
      setDetail(res.page)
      setRevisions(res.revisions)
    } catch (err) {
      if (!mountedRef.current || seq !== pageSeqRef.current) return
      if (err instanceof SignedOut) {
        onSignedOutRef.current?.()
        return
      }
      if (err instanceof ApiError && err.status === 404) {
        setDetail(null)
        setRevisions([])
      }
      setPageError(wikiErrorMessage(tRef.current, err, 'wiki.error.loadFailed'))
    } finally {
      if (mountedRef.current && seq === pageSeqRef.current) {
        setLoadingPage(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadList(activeQuery, kindFilter)
  }, [activeQuery, kindFilter, loadList])

  const prevTickRef = useRef(refreshTick)
  useEffect(() => {
    if (refreshTick === prevTickRef.current) return
    prevTickRef.current = refreshTick
    void loadList(queryRef.current, kindRef.current, { silent: true })
    if (modeRef.current === 'view' && selectedKeyRef.current) {
      void loadPage(selectedKeyRef.current.kind, selectedKeyRef.current.slug, { silent: true })
    }
  }, [refreshTick, loadList, loadPage])

  const cancelForm = useCallback(() => {
    if (saving) return
    setMode('view')
    setFormError(null)
  }, [saving])

  useEscape(mode !== 'view' ? cancelForm : onClose)

  const handleQueryChange = (next: string) => {
    setQueryInput(next)
    if (debounceTimerRef.current !== undefined) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = undefined
    }
    if (!next.trim()) {
      setActiveQuery('')
      return
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = undefined
      setActiveQuery(next)
    }, 200)
  }

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (debounceTimerRef.current !== undefined) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = undefined
    }
    if (activeQuery !== queryInput) {
      setActiveQuery(queryInput)
    } else {
      void loadList(queryInput, kindFilter)
    }
  }

  const selectPage = (page: WikiPageSummary) => {
    const switching = selectedKey?.id !== page.id
    setSelectedKey({ id: page.id, kind: page.kind, slug: page.slug })
    if (switching) {
      setDetail(null)
      setRevisions([])
    }
    setMode('view')
    setHistoryOpen(false)
    setFormError(null)
    setPageError(null)
    void loadPage(page.kind, page.slug)
  }

  const openCreate = () => {
    setMode('create')
    setFormKind(kindFilter === 'all' ? 'topic' : kindFilter)
    setFormTitle('')
    setFormSlug('')
    setFormSummary('')
    setFormTags('')
    setFormBody('')
    setFormNote('')
    setFormError(null)
  }

  const openEdit = (page: WikiPageDetail) => {
    setMode('edit')
    setFormKind(page.kind)
    setFormTitle(page.title)
    setFormSlug(page.slug)
    setFormSummary(page.summary)
    setFormTags(page.tags.join(', '))
    setFormBody(page.body)
    setFormNote('')
    setFormError(null)
  }

  const handleSave = async (e: FormEvent) => {
    e.preventDefault()
    const title = formTitle.trim()
    if (!title || !formBody.trim()) return

    setSaving(true)
    setFormError(null)
    try {
      const tags = parseTags(formTags)
      const summary = formSummary.trim()
      const note = formNote.trim()

      let res
      if (mode === 'create') {
        const slug = formSlug.trim()
        const input: WikiCreateInput = {
          kind: formKind,
          title,
          summary,
          tags,
          body: formBody,
          ...(slug ? { slug } : {}),
          ...(note ? { note } : {}),
        }
        res = await createWikiPage(input)
      } else {
        if (!detail) return
        const input: WikiSaveInput = {
          title,
          summary,
          tags,
          body: formBody,
          ...(note ? { note } : {}),
        }
        res = await saveWikiPage(detail.kind, detail.slug, input)
      }

      if (!mountedRef.current) return
      pageSeqRef.current += 1
      setDetail(res.page)
      setRevisions(res.revisions)
      setSelectedKey({ id: res.page.id, kind: res.page.kind, slug: res.page.slug })
      setMode('view')
      setPageError(null)
      setFormError(null)
      void loadList(queryRef.current, kindRef.current, { silent: true })
    } catch (err) {
      if (!mountedRef.current) return
      if (err instanceof SignedOut) {
        onSignedOutRef.current?.()
        return
      }
      setFormError(wikiErrorMessage(tRef.current, err))
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  const handleDelete = async (page: WikiPageDetail) => {
    setDeleting(true)
    setPageError(null)
    try {
      await deleteWikiPage(page.kind, page.slug)
      if (!mountedRef.current) return
      pageSeqRef.current += 1
      setSelectedKey(null)
      setDetail(null)
      setRevisions([])
      setHistoryOpen(false)
      setMode('view')
      setPages((prev) => prev.filter((item) => item.id !== page.id))
      setTotal((prev) => Math.max(0, prev - 1))
      void loadList(queryRef.current, kindRef.current, { silent: true })
    } catch (err) {
      if (!mountedRef.current) return
      if (err instanceof SignedOut) {
        onSignedOutRef.current?.()
        return
      }
      setPageError(wikiErrorMessage(tRef.current, err))
    } finally {
      if (mountedRef.current) setDeleting(false)
    }
  }

  const handleRevert = async (page: WikiPageDetail, version: number) => {
    setRevertingVersion(version)
    setPageError(null)
    try {
      const res = await revertWikiPage(page.kind, page.slug, version)
      if (!mountedRef.current) return
      pageSeqRef.current += 1
      setDetail(res.page)
      setRevisions(res.revisions)
      setSelectedKey({ id: res.page.id, kind: res.page.kind, slug: res.page.slug })
      setMode('view')
      void loadList(queryRef.current, kindRef.current, { silent: true })
    } catch (err) {
      if (!mountedRef.current) return
      if (err instanceof SignedOut) {
        onSignedOutRef.current?.()
        return
      }
      setPageError(wikiErrorMessage(tRef.current, err))
    } finally {
      if (mountedRef.current) setRevertingVersion(null)
    }
  }

  const busy = saving || deleting || revertingVersion !== null
  const hasFilterOrSearch = Boolean(activeQuery.trim()) || kindFilter !== 'all'
  const countLabel = total === 1 ? t('wiki.countOne') : t('wiki.count', { count: total })

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => { scrimDown.current = e.target === e.currentTarget }}
      onClick={(e) => {
        if (e.target === e.currentTarget && scrimDown.current) onClose()
        scrimDown.current = false
      }}
    >
      <div
        className="modal wiki-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('wiki.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">{t('wiki.title')}</div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label={t('wiki.close')}
            title={t('wiki.close')}
          >
            <XIcon size={15} />
          </button>
        </div>

        <p className="wiki-subtitle">{t('wiki.subtitle')}</p>

        <div className="wiki-layout">
          <aside className="wiki-sidebar">
            <div className="wiki-search-row">
              <form className="wiki-search-form" onSubmit={handleSearchSubmit}>
                <input
                  type="search"
                  className="wiki-search-input"
                  value={queryInput}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  placeholder={t('wiki.searchPlaceholder')}
                  aria-label={t('wiki.searchPlaceholder')}
                />
              </form>
              <button
                type="button"
                className="wiki-new-btn"
                disabled={busy}
                onClick={openCreate}
              >
                <PlusIcon size={13} />
                <span>{t('wiki.newPage')}</span>
              </button>
            </div>

            <div className="wiki-filters">
              {FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  aria-pressed={kindFilter === opt}
                  className={`wiki-filter-pill${kindFilter === opt ? ' active' : ''}`}
                  onClick={() => setKindFilter(opt)}
                >
                  {t(`wiki.filter.${opt}` as MessageKey)}
                </button>
              ))}
            </div>

            <div className="wiki-list-meta">
              <span>{loadingList && pages.length === 0 ? t('wiki.loading') : countLabel}</span>
            </div>

            {listError ? (
              <div className="form-error wiki-list-error" role="alert">{listError}</div>
            ) : null}

            <div className="wiki-list">
              {loadingList && pages.length === 0 ? (
                <div className="wiki-list-empty">{t('wiki.loading')}</div>
              ) : pages.length === 0 ? (
                <div className="wiki-list-empty">
                  {hasFilterOrSearch ? t('wiki.noMatches') : t('wiki.empty')}
                </div>
              ) : (
                pages.map((page) => {
                  const active = selectedKey?.id === page.id && mode !== 'create'
                  const preview = page.snippet || page.summary
                  const stamp = formatWikiTime(page.updatedAt, t.locale)
                  return (
                    <button
                      key={page.id}
                      type="button"
                      className={`wiki-item${active ? ' active' : ''}`}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => selectPage(page)}
                    >
                      <div className="wiki-item-head">
                        <span className="wiki-item-title">{page.title}</span>
                        <span className={`wiki-kind-badge kind-${page.kind}`}>
                          {t(`wiki.kind.${page.kind}` as MessageKey)}
                        </span>
                      </div>
                      {preview ? <div className="wiki-item-summary">{preview}</div> : null}
                      <div className="wiki-item-meta">
                        <span>v{page.version}</span>
                        {stamp ? <span>{stamp}</span> : null}
                        {page.sourceTainted ? (
                          <span className="wiki-taint-badge">{t('wiki.externalBadge')}</span>
                        ) : null}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </aside>

          <section className="wiki-main">
            {mode === 'create' || mode === 'edit' ? (
              <form className="conn-form wiki-form" onSubmit={(e) => { void handleSave(e) }}>
                <div className="wiki-form-head">
                  {mode === 'create' ? (
                    <h3 className="wiki-form-title">{t('wiki.newPage')}</h3>
                  ) : detail ? (
                    <div className="wiki-form-edit-head">
                      <span className={`wiki-kind-badge kind-${detail.kind}`}>
                        {t(`wiki.kind.${detail.kind}` as MessageKey)}
                      </span>
                      <code className="wiki-slug-pill">{detail.id}</code>
                    </div>
                  ) : null}
                </div>

                {formError ? <div className="form-error wiki-form-error" role="alert">{formError}</div> : null}

                {mode === 'create' ? (
                  <div className="wiki-form-row">
                    <label>
                      <span className="conn-label">{t('wiki.field.kind')}</span>
                      <select
                        value={formKind}
                        disabled={saving}
                        onChange={(e) => setFormKind(e.target.value as WikiKind)}
                      >
                        {WIKI_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {t(`wiki.kind.${kind}` as MessageKey)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="wiki-field-group">
                      <label>
                        <span className="conn-label">{t('wiki.field.slug')}</span>
                        <input
                          type="text"
                          value={formSlug}
                          disabled={saving}
                          spellCheck={false}
                          onChange={(e) => setFormSlug(e.target.value)}
                        />
                      </label>
                      <span className="wiki-form-hint">{t('wiki.field.slugHint')}</span>
                    </div>
                  </div>
                ) : null}

                <label>
                  <span className="conn-label">{t('wiki.field.title')}</span>
                  <input
                    type="text"
                    required
                    value={formTitle}
                    disabled={saving}
                    onChange={(e) => setFormTitle(e.target.value)}
                  />
                </label>

                <label>
                  <span className="conn-label">{t('wiki.field.summary')}</span>
                  <input
                    type="text"
                    value={formSummary}
                    disabled={saving}
                    onChange={(e) => setFormSummary(e.target.value)}
                  />
                </label>

                <label>
                  <span className="conn-label">{t('wiki.field.tags')}</span>
                  <input
                    type="text"
                    value={formTags}
                    disabled={saving}
                    placeholder={t('wiki.field.tagsPlaceholder')}
                    onChange={(e) => setFormTags(e.target.value)}
                  />
                </label>

                <label>
                  <span className="conn-label">{t('wiki.field.body')}</span>
                  <textarea
                    className="wiki-form-textarea"
                    required
                    rows={9}
                    value={formBody}
                    disabled={saving}
                    onChange={(e) => setFormBody(e.target.value)}
                  />
                </label>

                <label>
                  <span className="conn-label">{t('wiki.field.note')}</span>
                  <input
                    type="text"
                    value={formNote}
                    disabled={saving}
                    placeholder={t('wiki.field.notePlaceholder')}
                    onChange={(e) => setFormNote(e.target.value)}
                  />
                </label>

                <div className="conn-form-buttons">
                  <span className="spacer" />
                  <button type="button" disabled={saving} onClick={cancelForm}>
                    {t('wiki.cancel')}
                  </button>
                  <button
                    type="submit"
                    className="primary"
                    disabled={saving || !formTitle.trim() || !formBody.trim()}
                  >
                    {saving
                      ? t('wiki.saving')
                      : mode === 'create'
                        ? t('wiki.create')
                        : detail?.sourceTainted
                          ? t('wiki.saveAndVerify')
                          : t('wiki.save')}
                  </button>
                </div>
              </form>
            ) : loadingPage && !detail ? (
              <div className="wiki-placeholder">{t('wiki.loading')}</div>
            ) : pageError && !detail ? (
              <div className="wiki-placeholder">
                <div className="form-error" role="alert">{pageError}</div>
              </div>
            ) : !detail ? (
              <div className="wiki-placeholder">{t('wiki.selectPrompt')}</div>
            ) : (
              <div className="wiki-detail">
                {pageError ? <div className="form-error" role="alert">{pageError}</div> : null}

                <div className="wiki-detail-head">
                  <div className="wiki-detail-title-group">
                    <div className="wiki-detail-badges">
                      <span className={`wiki-kind-badge kind-${detail.kind}`}>
                        {t(`wiki.kind.${detail.kind}` as MessageKey)}
                      </span>
                      <code className="wiki-slug-pill">{detail.id}</code>
                    </div>
                    <h2 className="wiki-detail-title">{detail.title}</h2>
                    <div className="wiki-detail-meta">
                      <span>
                        {t('wiki.versionMeta', {
                          version: detail.version,
                          who: resolveEditorName(detail.updatedBy, roster, t),
                        })}
                      </span>
                      {formatWikiTime(detail.updatedAt, t.locale) ? (
                        <span className="wiki-detail-time">
                          {formatWikiTime(detail.updatedAt, t.locale)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="conn-actions wiki-detail-actions">
                    <button type="button" disabled={busy} onClick={() => openEdit(detail)}>
                      {t('wiki.edit')}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => setConfirmDelete(detail)}
                    >
                      {t('wiki.delete')}
                    </button>
                  </div>
                </div>

                {detail.summary ? <p className="wiki-detail-summary">{detail.summary}</p> : null}

                {detail.tags.length > 0 ? (
                  <div className="wiki-tags">
                    {detail.tags.map((tag) => (
                      <span key={tag} className="wiki-tag">{tag}</span>
                    ))}
                  </div>
                ) : null}

                {detail.sourceTainted ? (
                  <div className="wiki-taint-banner" role="status">
                    <div className="wiki-taint-banner-copy">
                      <span className="wiki-taint-badge">{t('wiki.externalBadge')}</span>
                      <span>{t('wiki.externalWarning')}</span>
                    </div>
                    <button
                      type="button"
                      className="wiki-verify-btn"
                      disabled={busy}
                      onClick={() => openEdit(detail)}
                    >
                      {t('wiki.reviewAndVerify')}
                    </button>
                  </div>
                ) : null}

                {detail.body.trim() ? (
                  <div className="wiki-body bubble markdown">
                    <Markdown text={detail.body} />
                  </div>
                ) : (
                  <p className="wiki-empty-body">{t('wiki.emptyBody')}</p>
                )}

                <div className="wiki-history">
                  <button
                    type="button"
                    className="wiki-history-toggle"
                    aria-expanded={historyOpen}
                    onClick={() => setHistoryOpen((open) => !open)}
                  >
                    <ChevronRightIcon
                      size={13}
                      className={`wiki-chevron${historyOpen ? ' open' : ''}`}
                    />
                    <span>{t('wiki.history', { count: revisions.length })}</span>
                  </button>

                  {historyOpen ? (
                    <div className="wiki-history-list">
                      {revisions.map((rev) => {
                        const isCurrent = rev.version === detail.version
                        const revTime = formatWikiTime(rev.createdAt, t.locale)
                        return (
                          <div key={rev.id} className="wiki-rev-item">
                            <div className="wiki-rev-info">
                              <div className="wiki-rev-head">
                                <span className="wiki-rev-ver">v{rev.version}</span>
                                {isCurrent ? (
                                  <span className="wiki-rev-current">{t('wiki.currentVersion')}</span>
                                ) : null}
                                {rev.sourceTainted ? (
                                  <span className="wiki-taint-badge">{t('wiki.externalBadge')}</span>
                                ) : null}
                                <span className="wiki-rev-meta">
                                  {resolveEditorName(rev.editedBy, roster, t)}
                                  {revTime ? ` · ${revTime}` : ''}
                                </span>
                              </div>
                              {rev.note ? <div className="wiki-rev-note">{rev.note}</div> : null}
                            </div>
                            {!isCurrent ? (
                              <button
                                type="button"
                                className="wiki-revert-btn"
                                disabled={busy}
                                onClick={() => setConfirmRevert({ page: detail, version: rev.version })}
                              >
                                {t('wiki.revert')}
                              </button>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          message={t('wiki.confirmDelete', { title: confirmDelete.title })}
          confirmLabel={t('wiki.delete')}
          cancelLabel={t('wiki.cancel')}
          danger
          onConfirm={() => {
            const target = confirmDelete
            setConfirmDelete(null)
            void handleDelete(target)
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}

      {confirmRevert ? (
        <ConfirmDialog
          message={t('wiki.confirmRevert', {
            title: confirmRevert.page.title,
            version: confirmRevert.version,
          })}
          confirmLabel={t('wiki.revert')}
          cancelLabel={t('wiki.cancel')}
          danger={false}
          onConfirm={() => {
            const target = confirmRevert
            setConfirmRevert(null)
            void handleRevert(target.page, target.version)
          }}
          onCancel={() => setConfirmRevert(null)}
        />
      ) : null}
    </div>
  )
}
