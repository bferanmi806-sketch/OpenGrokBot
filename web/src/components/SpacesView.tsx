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
  uploadSpaceAsset,
} from '../api'
import { useT, type MessageKey } from '../i18n'
import { errorText } from '../i18n/describe'
import type {
  GoalView,
  SpaceAccent,
  SpaceActionDef,
  SpaceBlock,
  SpaceGrant,
  SpaceHeaderStyle,
  SpaceRole,
  SpacesSnapshot,
  SpaceTemplateId,
  SpaceView,
} from '../types'
import { BotAvatar } from './BotAvatar'
import { ConfirmDialog } from './ConfirmDialog'
import type { Roster } from './ConnectorsDialog'
import { CpuSparkleIcon, LayoutGridIcon, PlusIcon, SidebarIcon, XIcon } from './Icons'
import { SpaceBlockView } from './SpaceBlocks'

const ACCENTS: readonly SpaceAccent[] = ['blue', 'indigo', 'emerald', 'amber', 'rose', 'slate']

const TEMPLATE_DEFAULT_ACCENT: Record<SpaceTemplateId, SpaceAccent> = {
  radar: 'indigo',
  scoreboard: 'amber',
  tracker: 'blue',
  kanban: 'indigo',
  dashboard: 'emerald',
  cards: 'rose',
  html: 'indigo',
  blank: 'slate',
}

const QUICK_ICONS = ['📊', '📋', '📈', '🖼️', '🎨', '🚀', '🔬', '💎']

function TemplatePreview({ id }: { id: SpaceTemplateId }) {
  if (id === 'radar' || id === 'scoreboard') {
    return (
      <div className="space-tmpl-wire" aria-hidden="true">
        <div className="w-row w-kpi"><span /><span /></div>
        <div className="w-row w-cards">
          <span className="w-media-card"><i className="w-line" /><i className="w-img accent" /></span>
          <span className="w-media-card"><i className="w-line" /><i className="w-img" /></span>
        </div>
      </div>
    )
  }
  if (id === 'tracker') {
    return (
      <div className="space-tmpl-wire" aria-hidden="true">
        <div className="w-row w-kpi">
          <span /><span /><span />
        </div>
        <div className="w-table">
          <span className="w-th" />
          <span /><span />
        </div>
        <div className="w-row w-split-75">
          <span className="w-box" /><span className="w-box accent" />
        </div>
      </div>
    )
  }
  if (id === 'kanban') {
    return (
      <div className="space-tmpl-wire" aria-hidden="true">
        <div className="w-row w-kpi">
          <span /><span /><span />
        </div>
        <div className="w-row w-kanban">
          <span className="w-col" /><span className="w-col accent" /><span className="w-col" /><span className="w-col" />
        </div>
        <div className="w-row w-split-55">
          <span className="w-box" /><span className="w-box" />
        </div>
      </div>
    )
  }
  if (id === 'dashboard') {
    return (
      <div className="space-tmpl-wire" aria-hidden="true">
        <div className="w-row w-kpi">
          <span /><span /><span />
        </div>
        <div className="w-row w-split-75">
          <span className="w-chart" /><span className="w-timeline" />
        </div>
        <div className="w-callout" />
      </div>
    )
  }
  if (id === 'cards') {
    return (
      <div className="space-tmpl-wire" aria-hidden="true">
        <div className="w-row w-cards">
          <span className="w-media-card"><i className="w-img accent" /><i className="w-line" /></span>
          <span className="w-media-card"><i className="w-img" /><i className="w-line" /></span>
          <span className="w-media-card"><i className="w-img accent" /><i className="w-line" /></span>
        </div>
      </div>
    )
  }
  if (id === 'html') {
    return (
      <div className="space-tmpl-wire" aria-hidden="true">
        <div className="w-html-hero" />
        <div className="w-row w-kpi">
          <span /><span /><span />
        </div>
      </div>
    )
  }
  return (
    <div className="space-tmpl-wire" aria-hidden="true">
      <div className="w-callout tall" />
    </div>
  )
}

export function SpacesView({
  state,
  roster,
  goals,
  selectedSpaceId,
  onSelectSpace,
  onChange,
  onOpenThread,
  onDesignWithBot,
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
  /** 将空间设计请求发给指定同事（让它先读内置 space-design 技能再调用 manage_space） */
  onDesignWithBot?: (botId: string, prompt: string) => Promise<void> | void
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

  const botEntries = useMemo(() => Object.entries(roster), [roster])
  const defaultDesignerBotId = useMemo(
    () => (roster.chief ? 'chief' : botEntries[0]?.[0] ?? ''),
    [roster, botEntries],
  )

  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newIcon, setNewIcon] = useState('📊')
  const [newTemplate, setNewTemplate] = useState<SpaceTemplateId>('tracker')
  const [newAccent, setNewAccent] = useState<SpaceAccent>('blue')
  const [newStyle, setNewStyle] = useState<SpaceHeaderStyle>('editorial')
  const [newDesc, setNewDesc] = useState('')
  const [newGoalId, setNewGoalId] = useState('')
  const [newGrants, setNewGrants] = useState<Record<string, SpaceRole | ''>>({})

  const [aiDesigning, setAiDesigning] = useState(false)
  const [aiBrief, setAiBrief] = useState('')
  const [aiBotId, setAiBotId] = useState('')

  const [schemaOpen, setSchemaOpen] = useState(false)
  const [htmlView, setHtmlView] = useState<string | null>(null)
  const [schemaText, setSchemaText] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<SpaceView | null>(null)
  const [confirmAction, setConfirmAction] = useState<{ space: SpaceView; action: SpaceActionDef } | null>(null)

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      if (err instanceof SignedOut) {
        onSignedOut?.()
        return false
      }
      setError(err instanceof ApiError ? errorText(t, err) : err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusyKey(null)
    }
  }

  const openNewForm = () => {
    setError(null)
    setAiDesigning(false)
    setCreating(true)
    setNewTitle('')
    setNewTemplate('tracker')
    setNewIcon('📊')
    setNewAccent('blue')
    setNewStyle('editorial')
    setNewDesc('')
    setNewGoalId('')
    setNewGrants({})
  }

  const openAiDesigner = () => {
    setError(null)
    setCreating(false)
    setAiDesigning(true)
    setAiBrief('')
    setAiBotId(defaultDesignerBotId)
  }

  const selectTemplate = (tmpl: SpaceTemplateId) => {
    setNewTemplate(tmpl)
    const found = state.templates.find((x) => x.id === tmpl)
    if (found) setNewIcon(found.icon)
    setNewAccent(TEMPLATE_DEFAULT_ACCENT[tmpl])
    setNewStyle(tmpl === 'blank' ? 'minimal' : 'editorial')
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
        theme: { accent: newAccent, style: newStyle },
        description: newDesc.trim(),
        goalId: newGoalId || null,
        grants,
      })
      onChange(res.snapshot)
      setActiveId(res.space.id)
      setCreating(false)
    })
  }

  const submitAiDesign = async (e: React.FormEvent) => {
    e.preventDefault()
    const brief = aiBrief.trim()
    const targetBot = aiBotId || defaultDesignerBotId
    if (!brief || !targetBot || !onDesignWithBot) return
    const prompt = [
      `Please call read_skill("space-design") first, then design and create a polished Space via manage_space(action="create") for this request:`,
      brief,
      `First choose the output from the brief. Use the radar template for competitor monitoring, the scoreboard template for schedules or scores, and a populated cards block for collections of visual records. Use a full self-contained HTML document if the operator asks for HTML or custom page interactions.`,
      `Keep facts, images and source links in editable space items. Bind the canvas to SPACE_DATA so adding or editing an item refreshes the view. For a scoreboard, use two separate team logo fields, genuine start times and verified scores. Show a clear empty state when sources or data are missing.`,
    ].join('\n\n')
    await run('space:ai-design', async () => {
      await onDesignWithBot(targetBot, prompt)
      setAiDesigning(false)
      setAiBrief('')
    })
  }

  const polishCurrentSpace = async (space: SpaceView) => {
    if (!onDesignWithBot) return
    const editorGrant = space.grants.find((g) => g.role === 'editor')?.botId
    const targetBot = editorGrant ?? defaultDesignerBotId
    if (!targetBot) return
    const prompt = [
      `Please call read_skill("space-design") and space_read("${space.id}") first, then redesign the layout and theme of Space "${space.title}" (${space.id}) via manage_space(action="set_schema") to improve its visual hierarchy, Bento grid composition, semantic metric tones, and chart choices while keeping all existing items compatible.`,
    ].join('\n\n')
    await run(`space:polish:${space.id}`, async () => {
      if (!editorGrant) {
        const res = await setSpaceGrants(space.id, [...space.grants.filter((g) => g.botId !== targetBot), { botId: targetBot, role: 'editor' }])
        onChange(res.snapshot)
      }
      await onDesignWithBot(targetBot, prompt)
    })
  }

  const switchSpaceAccent = async (space: SpaceView, accent: SpaceAccent) => {
    const nextTheme = { accent, style: space.schema.theme?.style ?? 'editorial' as const }
    await run(`theme:${space.id}:${accent}`, async () => {
      const res = await updateSpace(space.id, {
        schema: { ...space.schema, theme: nextTheme },
      })
      onChange(res.snapshot)
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

  const aiButton = onDesignWithBot && defaultDesignerBotId ? (
    <button type="button" className="space-ai-btn" disabled={busyKey !== null} onClick={openAiDesigner}>
      <CpuSparkleIcon size={13} />
      <span>{t('spaces.designWithAi')}</span>
    </button>
  ) : null

  const newButton = (
    <button type="button" className="connector-connect-btn" disabled={busyKey !== null} onClick={openNewForm}>
      <PlusIcon size={12} />
      <span>{t('spaces.new')}</span>
    </button>
  )

  const activeAccent: SpaceAccent = activeSpace?.schema.theme?.accent ?? 'slate'
  const activeHeaderStyle: SpaceHeaderStyle = activeSpace?.schema.theme?.style ?? 'editorial'

  const bodyContent = (
    <>
      <div className="spaces-subbar">
        <div className="spaces-pills" role="list">
          {state.spaces.map((s) => {
            const pillAccent: SpaceAccent = s.schema.theme?.accent ?? 'slate'
            return (
              <button
                key={s.id}
                type="button"
                data-space-accent={pillAccent}
                className={`space-pill${activeSpace?.id === s.id ? ' active' : ''}`}
                onClick={() => { setActiveId(s.id); setSchemaOpen(false) }}
              >
                <span className={`space-pill-dot dot-${pillAccent}`} aria-hidden="true" />
                <span>{s.icon}</span>
                <span>{s.title}</span>
                <span className="feed-tab-count subtle">{s.items.length}</span>
              </button>
            )
          })}
        </div>
        <span className="spacer" />
        <div className="spaces-subbar-actions">
          {aiButton}
          {newButton}
        </div>
      </div>

      {error ? <div className="form-error" role="alert">{error}</div> : null}

      {aiDesigning && onDesignWithBot ? (
        <form className="goal-form-card space-ai-designer" onSubmit={(e) => void submitAiDesign(e)}>
          <div className="goal-form-head">
            <strong className="space-ai-designer-title">
              <CpuSparkleIcon size={14} />
              <span>{t('spaces.designWithAiTitle')}</span>
            </strong>
            <button type="button" className="modal-close" aria-label={t('spaces.form.cancel')} onClick={() => setAiDesigning(false)}>
              <XIcon size={14} />
            </button>
          </div>
          <p className="space-ai-designer-hint">{t('spaces.designWithAiHint')}</p>
          <textarea
            rows={3}
            required
            autoFocus
            value={aiBrief}
            onChange={(e) => setAiBrief(e.target.value)}
            placeholder={t('spaces.designWithAiPlaceholder')}
            disabled={busyKey !== null}
          />
          <div className="space-ai-designer-foot">
            <label className="space-grant-picker">
              <span>{t('spaces.designWithAiBot')}</span>
              <select
                value={aiBotId || defaultDesignerBotId}
                onChange={(e) => setAiBotId(e.target.value)}
                disabled={busyKey !== null}
              >
                {botEntries.map(([id, b]) => (
                  <option key={id} value={id}>{b.name}</option>
                ))}
              </select>
            </label>
            <div className="goal-form-actions">
              <button type="button" className="vault-small-btn" onClick={() => setAiDesigning(false)} disabled={busyKey !== null}>
                {t('spaces.form.cancel')}
              </button>
              <button type="submit" className="connector-connect-btn" disabled={busyKey !== null || !aiBrief.trim()}>
                <CpuSparkleIcon size={12} />
                <span>{t('spaces.designWithAiSubmit')}</span>
              </button>
            </div>
          </div>
        </form>
      ) : null}

      {creating ? (
        <form className="goal-form-card space-create-card" data-space-accent={newAccent} onSubmit={(e) => void submitCreate(e)}>
          <div className="goal-form-head">
            <strong>{t('spaces.form.newTitle')}</strong>
            <button type="button" className="modal-close" aria-label={t('spaces.form.cancel')} onClick={() => setCreating(false)}>
              <XIcon size={14} />
            </button>
          </div>

          <div className="goal-field">
            <span>{t('spaces.form.template')}</span>
            <div className="space-template-gallery" role="radiogroup" aria-label={t('spaces.form.template')}>
              {state.templates.map((tmpl) => {
                const selected = newTemplate === tmpl.id
                const tmplAccent = TEMPLATE_DEFAULT_ACCENT[tmpl.id]
                return (
                  <button
                    key={tmpl.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-space-accent={tmplAccent}
                    className={`space-template-card${selected ? ' active' : ''}`}
                    disabled={busyKey !== null}
                    onClick={() => selectTemplate(tmpl.id)}
                  >
                    <TemplatePreview id={tmpl.id} />
                    <div className="space-template-meta">
                      <strong>{tmpl.icon} {t(`spaces.template.${tmpl.id}` as MessageKey)}</strong>
                      <span>{t(`spaces.template.${tmpl.id}Desc` as MessageKey)}</span>
                    </div>
                  </button>
                )
              })}
            </div>
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
            <div className="goal-field">
              <span>{t('spaces.form.theme')}</span>
              <div className="space-theme-row">
                <div className="space-swatches" role="radiogroup" aria-label={t('spaces.form.theme')}>
                  {ACCENTS.map((accent) => (
                    <button
                      key={accent}
                      type="button"
                      role="radio"
                      aria-checked={newAccent === accent}
                      aria-label={t(`spaces.accent.${accent}` as MessageKey)}
                      title={t(`spaces.accent.${accent}` as MessageKey)}
                      className={`space-swatch dot-${accent}${newAccent === accent ? ' active' : ''}`}
                      disabled={busyKey !== null}
                      onClick={() => setNewAccent(accent)}
                    />
                  ))}
                </div>
                <div className="space-style-toggle">
                  {(['editorial', 'minimal'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      className={`vault-small-btn${newStyle === st ? ' primary' : ''}`}
                      disabled={busyKey !== null}
                      onClick={() => setNewStyle(st)}
                    >
                      {t(`spaces.form.style.${st}` as MessageKey)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
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
            <div className="goal-field">
              <span>{t('spaces.form.icon')}</span>
              <div className="space-icon-row">
                <input
                  type="text"
                  maxLength={8}
                  value={newIcon}
                  onChange={(e) => setNewIcon(e.target.value)}
                  disabled={busyKey !== null}
                />
                <div className="space-quick-icons">
                  {QUICK_ICONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className={`space-quick-icon${newIcon === emoji ? ' active' : ''}`}
                      onClick={() => setNewIcon(emoji)}
                      disabled={busyKey !== null}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            </div>
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
                    <BotAvatar seed={id} emoji={b.emoji} size="xs" />
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
        <div className="feed-empty space-empty-hero">
          <p>{t('spaces.empty')}</p>
          <div className="space-empty-actions">
            {aiButton}
            {newButton}
          </div>
        </div>
      ) : !activeSpace ? (
        <div className="feed-empty">{t('spaces.selectHint')}</div>
      ) : (
        <div className="space-canvas" data-space-accent={activeAccent} data-space-style={activeHeaderStyle}>
          <div className="space-hero">
            <div className="space-meta-top">
              <div className="space-meta-heading">
                <span className="space-hero-badge" aria-hidden="true">{activeSpace.icon}</span>
                <div className="space-meta-copy">
                  <div className="space-meta-title-row">
                    <h3 className="space-hero-title">{activeSpace.title}</h3>
                    {activeSpace.goalTitle && onOpenGoal ? (
                      <button type="button" className="space-goal-pill" onClick={onOpenGoal}>
                        {t('spaces.linkedGoal', { title: activeSpace.goalTitle })}
                      </button>
                    ) : null}
                  </div>
                  {activeSpace.description ? <p className="space-hero-desc">{activeSpace.description}</p> : null}
                </div>
              </div>
              <div className="space-hero-actions">
                <div className="space-swatches compact" aria-label={t('spaces.form.theme')}>
                  {ACCENTS.map((accent) => (
                    <button
                      key={accent}
                      type="button"
                      aria-label={t('spaces.themeSwitch', { accent: t(`spaces.accent.${accent}` as MessageKey) })}
                      title={t(`spaces.accent.${accent}` as MessageKey)}
                      className={`space-swatch dot-${accent}${activeAccent === accent ? ' active' : ''}`}
                      disabled={busyKey !== null}
                      onClick={() => void switchSpaceAccent(activeSpace, accent)}
                    />
                  ))}
                </div>
                {onDesignWithBot && defaultDesignerBotId ? (
                  <button
                    type="button"
                    className="vault-small-btn space-polish-btn"
                    disabled={busyKey !== null}
                    onClick={() => void polishCurrentSpace(activeSpace)}
                  >
                    <CpuSparkleIcon size={12} />
                    <span>{t('spaces.polishWithAi')}</span>
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
                      <label key={id} className={`space-grant-picker${currentRole ? ' granted' : ''}`}>
                        <BotAvatar seed={id} emoji={b.emoji} size="xs" />
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

          <div className="space-bento-grid">
            {activeSpace.schema.blocks.filter((block) => {
              if (block.type === 'html') return !block.viewOf
              return !activeSpace.schema.blocks.some((canvas) =>
                canvas.type === 'html' && canvas.viewOf?.slice(1).includes(block.id)
                && htmlView === `${activeSpace.id}:${canvas.viewOf[0]}`,
              )
            }).map((source) => {
              const canvas = activeSpace.schema.blocks.find(
                (block): block is Extract<SpaceBlock, { type: 'html' }> => block.type === 'html' && block.viewOf?.[0] === source.id,
              )
              const viewKey = `${activeSpace.id}:${source.id}`
              const showHtml = canvas !== undefined && htmlView === viewKey
              const block = showHtml ? canvas : source
              const content = <SpaceBlockView
                key={block.id}
                block={block}
                allItems={activeSpace.items}
                cb={{
                  busy: busyKey !== null,
                  roster,
                  spaceTitle: activeSpace.title,
                  spaceAccent: activeAccent,
                  onCreateItem: (input) =>
                    run(`item:add:${block.id}`, async () => {
                      const res = await createSpaceItem(activeSpace.id, input)
                      onChange(res.snapshot)
                    }),
                  onUpdateItem: (itemId, patch) =>
                    run(`item:upd:${itemId}`, async () => {
                      const res = await updateSpaceItem(activeSpace.id, itemId, patch)
                      onChange(res.snapshot)
                    }),
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
                  onUpdateHtmlBlock: (blockId, html) =>
                    run(`html:${activeSpace.id}:${blockId}`, async () => {
                      const nextBlocks = activeSpace.schema.blocks.map((b) =>
                        b.id === blockId && b.type === 'html' ? { ...b, html } : b,
                      )
                      const res = await updateSpace(activeSpace.id, {
                        schema: { ...activeSpace.schema, blocks: nextBlocks },
                      })
                      onChange(res.snapshot)
                    }),
                  onUploadAsset: async (file) => {
                    let uploadedUrl = ''
                    await run(`asset:${activeSpace.id}`, async () => {
                      const res = await uploadSpaceAsset(activeSpace.id, file)
                      uploadedUrl = res.url
                    })
                    return uploadedUrl
                  },
                }}
              />
              if (!canvas) return content
              return (
                <div className="space-linked-view space-span-full" key={source.id}>
                  <div className="space-view-toggle" role="group" aria-label={t('spaces.view.label')}>
                    <button type="button" aria-pressed={!showHtml} onClick={() => setHtmlView(null)}>{t('spaces.view.cards')}</button>
                    <button type="button" aria-pressed={showHtml} onClick={() => setHtmlView(viewKey)}>{t('spaces.view.html')}</button>
                  </div>
                  {content}
                </div>
              )
            })}
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
        <div className="spaces-subbar-actions">
          {aiButton}
          {newButton}
        </div>
      </header>
      <div className="feed-body">{bodyContent}</div>
      {dialogs}
    </main>
  )
}
