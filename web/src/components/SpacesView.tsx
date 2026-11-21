import { useMemo, useState } from 'react'
import {
  ApiError,
  SignedOut,
  createSpace,
  createSpaceItem,
  deleteSpace,
  deleteSpaceItem,
  setSpaceGrants,
  triggerSpaceAction,
  updateSpace,
  updateSpaceItem,
} from '../api'
import { useT, type MessageKey } from '../i18n'
import { errorText } from '../i18n/describe'
import type {
  GoalView,
  SpaceActionDef,
  SpaceGrant,
  SpaceRole,
  SpacesSnapshot,
  SpaceTemplateId,
  SpaceView,
} from '../types'
import { ConfirmDialog } from './ConfirmDialog'
import type { Roster } from './ConnectorsDialog'
import { LayoutGridIcon, PlusIcon, SidebarIcon, XIcon } from './Icons'
import { SpaceBlockView } from './SpaceBlocks'

export function SpacesView({
  state,
  roster,
  goals,
  selectedSpaceId,
  onSelectSpace,
  onChange,
  onOpenThread,
  onOpenGoal,
  onToggleSidebar,
  onSignedOut,
  embedded,
}: {
  state: SpacesSnapshot
  roster: Roster
  goals?: GoalView[]
  selectedSpaceId?: string | null
  onSelectSpace?: (id: string | null) => void
  onChange: (next: SpacesSnapshot) => void
  onOpenThread: (threadId: string) => void
  onOpenGoal?: () => void
  onToggleSidebar?: () => void
  onSignedOut?: () => void
  /** 嵌入在「今日（Today）」顶栏第 4 个二级 Tab 内时复用外层顶栏与滚动容器 */
  embedded?: boolean
}) {
  const t = useT()
  const [internalSelected, setInternalSelected] = useState<string | null>(null)
  const activeId = selectedSpaceId ?? internalSelected
  const setActiveId = (id: string | null) => {
    setInternalSelected(id)
    onSelectSpace?.(id)
  }

  const activeSpace: SpaceView | null = useMemo(() => {
    if (!state.spaces.length) return null
    return state.spaces.find((s) => s.id === activeId) ?? state.spaces[0] ?? null
  }, [state.spaces, activeId])

  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newIcon, setNewIcon] = useState('📊')
  const [newTemplate, setNewTemplate] = useState<SpaceTemplateId>('tracker')
  const [newDesc, setNewDesc] = useState('')
  const [newGoalId, setNewGoalId] = useState('')
  const [newGrants, setNewGrants] = useState<Record<string, SpaceRole | ''>>({})

  const [schemaOpen, setSchemaOpen] = useState(false)
  const [schemaText, setSchemaText] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<SpaceView | null>(null)
  const [confirmAction, setConfirmAction] = useState<{ space: SpaceView; action: SpaceActionDef } | null>(null)

  const botEntries = useMemo(() => Object.entries(roster), [roster])

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key)
    setError(null)
    try {
      await fn()
    } catch (err) {
      if (err instanceof SignedOut) {
        onSignedOut?.()
        return
      }
      setError(err instanceof ApiError ? errorText(t, err) : err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKey(null)
    }
  }

  const openNewForm = () => {
    setError(null)
    setCreating(true)
    setNewTitle('')
    setNewTemplate('tracker')
    setNewIcon('📊')
    setNewDesc('')
    setNewGoalId('')
    setNewGrants({})
  }

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTitle.trim()) return
    const grants: SpaceGrant[] = Object.entries(newGrants)
      .filter(([, role]) => role === 'viewer' || role === 'editor')
      .map(([botId, role]) => ({ botId, role: role as SpaceRole }))
    await run('space:create', async () => {
      const res = await createSpace({
        title: newTitle.trim(),
        icon: newIcon.trim() || '📊',
        template: newTemplate,
        description: newDesc.trim(),
        goalId: newGoalId || null,
        grants,
      })
      onChange(res.snapshot)
      setActiveId(res.space.id)
      setCreating(false)
    })
  }

  const updateBotGrant = async (space: SpaceView, botId: string, role: SpaceRole | '') => {
    const others = space.grants.filter((g) => g.botId !== botId)
    const nextGrants: SpaceGrant[] = role ? [...others, { botId, role }] : others
    await run(`grant:${space.id}:${botId}`, async () => {
      const res = await setSpaceGrants(space.id, nextGrants)
      onChange(res.snapshot)
    })
  }

  const saveSchema = async (space: SpaceView) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(schemaText)
    } catch {
      setError('Invalid JSON syntax.')
      return
    }
    await run(`schema:${space.id}`, async () => {
      const res = await updateSpace(space.id, { schema: parsed as SpaceView['schema'] })
      onChange(res.snapshot)
      setSchemaOpen(false)
    })
  }

  const executeAction = async (space: SpaceView, action: SpaceActionDef) => {
    await run(`action:${space.id}:${action.id}`, async () => {
      const res = await triggerSpaceAction(space.id, action.id)
      onOpenThread(res.threadId)
    })
  }

  const newButton = (
    <button type="button" className="connector-connect-btn" disabled={busyKey !== null} onClick={openNewForm}>
      <PlusIcon size={12} />
      <span>{t('spaces.new')}</span>
    </button>
  )

  const bodyContent = (
    <>
      <div className="spaces-subbar">
        <div className="spaces-pills" role="list">
          {state.spaces.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`space-pill${activeSpace?.id === s.id ? ' active' : ''}`}
              onClick={() => { setActiveId(s.id); setSchemaOpen(false) }}
            >
              <span>{s.icon}</span>
              <span>{s.title}</span>
              <span className="feed-tab-count subtle">{s.items.length}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        {newButton}
      </div>

      {error ? <div className="form-error" role="alert">{error}</div> : null}

      {creating ? (
        <form className="goal-form-card" onSubmit={(e) => void submitCreate(e)}>
          <div className="goal-form-head">
            <strong>{t('spaces.form.newTitle')}</strong>
            <button type="button" className="modal-close" aria-label={t('spaces.form.cancel')} onClick={() => setCreating(false)}>
              <XIcon size={14} />
            </button>
          </div>
          <div className="goal-form-grid">
            <label className="goal-field">
              <span>{t('spaces.form.title')}</span>
              <input
                type="text"
                required
                maxLength={120}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={t('spaces.form.titlePlaceholder')}
                disabled={busyKey !== null}
              />
            </label>
            <label className="goal-field">
              <span>{t('spaces.form.template')}</span>
              <select
                value={newTemplate}
                onChange={(e) => {
                  const tmpl = e.target.value as SpaceTemplateId
                  setNewTemplate(tmpl)
                  const found = state.templates.find((x) => x.id === tmpl)
                  if (found) setNewIcon(found.icon)
                }}
                disabled={busyKey !== null}
              >
                {state.templates.map((tmpl) => (
                  <option key={tmpl.id} value={tmpl.id}>
                    {tmpl.icon} {t(`spaces.template.${tmpl.id}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="goal-form-grid">
            <label className="goal-field">
              <span>{t('spaces.form.description')}</span>
              <input
                type="text"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder={t('spaces.form.descriptionPlaceholder')}
                disabled={busyKey !== null}
              />
            </label>
            <label className="goal-field">
              <span>{t('spaces.form.icon')}</span>
              <input
                type="text"
                maxLength={8}
                value={newIcon}
                onChange={(e) => setNewIcon(e.target.value)}
                disabled={busyKey !== null}
              />
            </label>
          </div>

          {goals && goals.length > 0 ? (
            <label className="goal-field">
              <span>{t('spaces.form.goal')}</span>
              <select value={newGoalId} onChange={(e) => setNewGoalId(e.target.value)} disabled={busyKey !== null}>
                <option value="">{t('spaces.form.noGoal')}</option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>{g.title}</option>
                ))}
              </select>
            </label>
          ) : null}

          {botEntries.length > 0 ? (
            <div className="goal-field">
              <span>{t('spaces.grantsHeading')}</span>
              <div className="space-grants-grid">
                {botEntries.map(([id, b]) => (
                  <label key={id} className="space-grant-picker">
                    <span>{b.name}</span>
                    <select
                      aria-label={`${b.name} access`}
                      value={newGrants[id] ?? ''}
                      onChange={(e) => setNewGrants((prev) => ({ ...prev, [id]: e.target.value as SpaceRole | '' }))}
                      disabled={busyKey !== null}
                    >
                      <option value="">{t('spaces.role.none')}</option>
                      <option value="viewer">{t('spaces.role.viewer')}</option>
                      <option value="editor">{t('spaces.role.editor')}</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          <div className="goal-form-actions">
            <button type="button" className="vault-small-btn" onClick={() => setCreating(false)} disabled={busyKey !== null}>
              {t('spaces.form.cancel')}
            </button>
            <button type="submit" className="connector-connect-btn" disabled={busyKey !== null || !newTitle.trim()}>
              {busyKey === 'space:create' ? t('spaces.form.saving') : t('spaces.form.save')}
            </button>
          </div>
        </form>
      ) : null}

      {state.spaces.length === 0 ? (
        <div className="feed-empty">{t('spaces.empty')}</div>
      ) : !activeSpace ? (
        <div className="feed-empty">{t('spaces.selectHint')}</div>
      ) : (
        <div className="space-canvas">
          <div className="feed-card space-meta-card">
            <div className="space-meta-top">
              <div className="space-meta-heading">
                <span className="space-meta-icon">{activeSpace.icon}</span>
                <div>
                  <h3 className="goal-card-title">{activeSpace.title}</h3>
                  {activeSpace.description ? <p className="feed-card-summary">{activeSpace.description}</p> : null}
                </div>
              </div>
              <div className="feed-card-actions">
                {activeSpace.goalTitle && onOpenGoal ? (
                  <button type="button" className="vault-small-btn" onClick={onOpenGoal}>
                    {t('spaces.linkedGoal', { title: activeSpace.goalTitle })}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="vault-small-btn"
                  disabled={busyKey !== null}
                  onClick={() => {
                    if (schemaOpen) {
                      setSchemaOpen(false)
                    } else {
                      setSchemaText(JSON.stringify(activeSpace.schema, null, 2))
                      setSchemaOpen(true)
                    }
                  }}
                >
                  {t('spaces.editSchema')}
                </button>
                <button
                  type="button"
                  className="vault-small-btn danger"
                  disabled={busyKey !== null}
                  onClick={() => setConfirmDelete(activeSpace)}
                >
                  {t('spaces.delete')}
                </button>
              </div>
            </div>

            {botEntries.length > 0 ? (
              <div className="space-grants-row">
                <span className="goal-subsection-title">{t('spaces.grantsHeading')}</span>
                <div className="space-grants-grid">
                  {botEntries.map(([id, b]) => {
                    const currentRole = activeSpace.grants.find((g) => g.botId === id)?.role ?? ''
                    return (
                      <label key={id} className="space-grant-picker">
                        <span>{b.name}</span>
                        <select
                          aria-label={`${b.name} space role`}
                          value={currentRole}
                          disabled={busyKey !== null}
                          onChange={(e) => void updateBotGrant(activeSpace, id, e.target.value as SpaceRole | '')}
                        >
                          <option value="">{t('spaces.role.none')}</option>
                          <option value="viewer">{t('spaces.role.viewer')}</option>
                          <option value="editor">{t('spaces.role.editor')}</option>
                        </select>
                      </label>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {schemaOpen ? (
              <div className="space-schema-editor">
                <div className="goal-muted">{t('spaces.schemaHint')}</div>
                <textarea
                  rows={10}
                  value={schemaText}
                  onChange={(e) => setSchemaText(e.target.value)}
                  disabled={busyKey !== null}
                />
                <div className="goal-form-actions">
                  <button type="button" className="vault-small-btn" onClick={() => setSchemaOpen(false)} disabled={busyKey !== null}>
                    {t('spaces.form.cancel')}
                  </button>
                  <button
                    type="button"
                    className="connector-connect-btn"
                    disabled={busyKey !== null}
                    onClick={() => void saveSchema(activeSpace)}
                  >
                    {t('spaces.saveSchema')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-blocks-stack">
            {activeSpace.schema.blocks.map((block) => (
              <SpaceBlockView
                key={block.id}
                block={block}
                allItems={activeSpace.items}
                cb={{
                  busy: busyKey !== null,
                  roster,
                  onCreateItem: async (input) => {
                    await run(`item:add:${block.id}`, async () => {
                      const res = await createSpaceItem(activeSpace.id, input)
                      onChange(res.snapshot)
                    })
                  },
                  onUpdateItem: async (itemId, patch) => {
                    await run(`item:upd:${itemId}`, async () => {
                      const res = await updateSpaceItem(activeSpace.id, itemId, patch)
                      onChange(res.snapshot)
                    })
                  },
                  onDeleteItem: async (itemId) => {
                    await run(`item:del:${itemId}`, async () => {
                      const res = await deleteSpaceItem(activeSpace.id, itemId)
                      onChange(res.snapshot)
                    })
                  },
                  onRequestAction: (action) => {
                    if (action.confirm) {
                      setConfirmAction({ space: activeSpace, action })
                    } else {
                      void executeAction(activeSpace, action)
                    }
                  },
                }}
              />
            ))}
          </div>
        </div>
      )}
    </>
  )

  const dialogs = (
    <>
      {confirmDelete ? (
        <ConfirmDialog
          message={t('spaces.deleteConfirm', { title: confirmDelete.title })}
          confirmLabel={t('confirm.delete')}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => {
            const target = confirmDelete
            setConfirmDelete(null)
            void run(`del:${target.id}`, async () => {
              const res = await deleteSpace(target.id)
              onChange(res.snapshot)
              if (activeId === target.id) setActiveId(res.snapshot.spaces[0]?.id ?? null)
            })
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
      {confirmAction ? (
        <ConfirmDialog
          message={t('spaces.actions.confirm', {
            label: confirmAction.action.label,
            bot: roster[confirmAction.action.botId]?.name ?? confirmAction.action.botId,
          })}
          confirmLabel={confirmAction.action.label}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => {
            const pending = confirmAction
            setConfirmAction(null)
            void executeAction(pending.space, pending.action)
          }}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}
    </>
  )

  if (embedded) {
    return (
      <section className="goals-embedded spaces-embedded" aria-label={t('spaces.title')}>
        {bodyContent}
        {dialogs}
      </section>
    )
  }

  return (
    <main className="thread feed-view spaces-view">
      <header className="thread-header feed-header">
        {onToggleSidebar ? (
          <button
            type="button"
            className="mobile-menu-btn"
            onClick={onToggleSidebar}
            aria-label={t('sidebar.toggle')}
            title={t('sidebar.toggle')}
          >
            <SidebarIcon size={15} />
          </button>
        ) : null}
        <div className="feed-header-title">
          <LayoutGridIcon size={16} />
          <span>{t('spaces.title')}</span>
        </div>
        <span className="spacer" />
        {newButton}
      </header>
      <div className="feed-body">{bodyContent}</div>
      {dialogs}
    </main>
  )
}
