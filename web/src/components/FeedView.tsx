import { useMemo, useState } from 'react'
import {
  ApiError,
  SignedOut,
  createFeedTopic,
  createGoal,
  createIdea,
  deleteFeedTopic,
  deleteIdea,
  deleteTodo,
  dispatchIdea,
  distillFeedFromChats,
  fetchFeed,
  followupFeedItem,
  incubateIdea,
  markAllFeedRead,
  promoteFeedToIdea,
  runAllFeedTopics,
  runFeedTopic,
  updateFeedItemStatus,
  updateFeedTopic,
  updateIdea,
  updateRoutine,
  updateTodo,
} from '../api'
import { useT, type MessageKey, type T } from '../i18n'
import { errorText } from '../i18n/describe'
import type {
  ApprovalEditInput,
  FeedItem,
  FeedSnapshot,
  FeedTopic,
  GoalsSnapshot,
  IdeaItem,
  RoutineAction,
  RuleDuration,
  SpacesSnapshot,
} from '../types'
import { ApprovalChip } from './ApprovalChip'
import { BotAvatar } from './BotAvatar'
import type { Roster } from './ConnectorsDialog'
import { GoalsView } from './GoalsView'
import {
  ClockIcon,
  CpuSparkleIcon,
  ExternalLinkIcon,
  InboxIcon,
  LayoutGridIcon,
  LightbulbIcon,
  NewspaperIcon,
  PlusIcon,
  RotateCwIcon,
  SidebarIcon,
  TargetIcon,
  XIcon,
} from './Icons'
import { LoginChip } from './LoginChip'
import { QuestionChip } from './QuestionChip'
import { ReportChip } from './ReportChip'
import { SpacesView } from './SpacesView'

function formatTime(ts: number, t: T, now = new Date()): string {
  if (!ts || ts < 86_400_000) return ''
  const at = new Date(ts)
  const time = at.toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString(t.locale, { month: 'short', day: 'numeric' })} ${time}`
}

export type TodayTab = 'briefings' | 'ideas' | 'goals' | 'spaces'

type FeedFilter = 'all' | 'unread' | 'proposal'

const STARTER_PROMPTS: ReadonlyArray<{ titleKey: MessageKey; promptKey: MessageKey }> = [
  { titleKey: 'feed.custom.starter1Title', promptKey: 'feed.custom.starter1Prompt' },
  { titleKey: 'feed.custom.starter2Title', promptKey: 'feed.custom.starter2Prompt' },
  { titleKey: 'feed.custom.starter3Title', promptKey: 'feed.custom.starter3Prompt' },
]

type TopicFormState = {
  mode: 'create' | 'edit'
  topicId?: string
  title: string
  prompt: string
  botId: string
}

export function FeedView({
  state,
  roster,
  onChange,
  onOpenThread,
  onOpenComputer,
  tab: controlledTab,
  onTabChange,
  goals,
  onGoalsChange,
  onRefreshGoals,
  spaces,
  onSpacesChange,
  selectedSpaceId,
  onSelectSpace,
  onDesignSpaceWithBot,
  onOpenGoals,
  onGoalCreated,
  onDecide,
  onAnswer,
  onToggleSidebar,
  onSignedOut,
}: {
  state: FeedSnapshot
  roster: Roster
  onChange: (next: FeedSnapshot) => void
  onOpenThread: (threadId: string) => void
  onOpenComputer: (botId: string) => void
  /** 可选受控二级标签（默认落于 briefings「动态」） */
  tab?: TodayTab
  onTabChange?: (next: TodayTab) => void
  /** 嵌入在今日顶栏「待办与目标」二级标签下的快照与回调 */
  goals?: GoalsSnapshot | null
  onGoalsChange?: (next: GoalsSnapshot) => void
  onRefreshGoals?: () => Promise<void>
  /** 嵌入在今日顶栏「空间」二级标签下的快照与回调 */
  spaces?: SpacesSnapshot | null
  onSpacesChange?: (next: SpacesSnapshot) => void
  selectedSpaceId?: string | null
  onSelectSpace?: (id: string | null) => void
  onDesignSpaceWithBot?: (botId: string, prompt: string) => Promise<void> | void
  onOpenGoals?: () => void
  onGoalCreated?: (next: GoalsSnapshot) => void
  onDecide: (
    approvalId: number,
    decision: 'approve' | 'discard',
    remember?: RuleDuration,
    items?: number[],
    edit?: ApprovalEditInput,
  ) => void | Promise<void>
  onAnswer: (messageId: number, choices: string[]) => void | Promise<void>
  onToggleSidebar?: () => void
  onSignedOut?: () => void
}) {
  const t = useT()
  const [internalTab, setInternalTab] = useState<TodayTab>('briefings')
  const tab: TodayTab = controlledTab ?? internalTab
  const setTab = (next: TodayTab) => {
    setInternalTab(next)
    onTabChange?.(next)
  }
  const hasGoals = Boolean(goals || onOpenGoals)
  const effectiveTab: TodayTab =
    tab === 'spaces' && !spaces
      ? 'briefings'
      : tab
  const [filter, setFilter] = useState<FeedFilter>('all')
  const [botFilter, setBotFilter] = useState<string>('')
  const [topicFilter, setTopicFilter] = useState<string>('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const topics = state.topics ?? []
  const todos = state.todos ?? []
  const openTodosCount = useMemo(
    () => todos.filter((td) => td.status === 'open').length,
    [todos],
  )
  const topicsById = useMemo(
    () => Object.fromEntries(topics.map((tp) => [tp.id, tp])),
    [topics],
  )

  const botEntries = useMemo(() => Object.entries(roster), [roster])
  const defaultBotId = botEntries.find(([id]) => id === 'chief')?.[0] ?? botEntries[0]?.[0] ?? ''
  const defaultFeedBotId =
    botEntries.find(([id]) => id === 'researcher')?.[0]
    ?? botEntries.find(([id]) => id === 'scout')?.[0]
    ?? botEntries.find(([id]) => id === 'market-watch')?.[0]
    ?? defaultBotId

  // Custom Feed topic composer (inline when no topics yet, or toggled via "+ Add prompt" / "Edit")
  const [topicForm, setTopicForm] = useState<TopicFormState | null>(null)
  const [inlinePrompt, setInlinePrompt] = useState('')
  const [inlineTitle, setInlineTitle] = useState('')
  const [inlineBot, setInlineBot] = useState('')

  // Follow-up drawer per feed item
  const [followupId, setFollowupId] = useState<string | null>(null)
  const [followupBot, setFollowupBot] = useState<string>('')
  const [followupNote, setFollowupNote] = useState<string>('')

  // Idea inbox optional manual composer (hidden by default — ideas are auto-distilled from chats)
  const [showManualIdea, setShowManualIdea] = useState(false)
  const [ideaTitle, setIdeaTitle] = useState('')
  const [ideaNotes, setIdeaNotes] = useState('')
  const [ideaBots, setIdeaBots] = useState<Record<string, string>>({})
  // Idea -> Goal inline promotion box
  const [promoteId, setPromoteId] = useState<string | null>(null)
  const [promoteTitle, setPromoteTitle] = useState('')
  const [promoteDesc, setPromoteDesc] = useState('')
  const [promoteCriteria, setPromoteCriteria] = useState('')
  const [promoteOwner, setPromoteOwner] = useState('')

  const filteredItems = useMemo(() => {
    return state.items.filter((item) => {
      if (filter === 'unread' && item.status !== 'unread') return false
      if (filter === 'proposal' && item.kind !== 'proposal') return false
      if (botFilter && item.botId !== botFilter) return false
      if (topicFilter && item.topicId !== topicFilter) return false
      return true
    })
  }, [state.items, filter, botFilter, topicFilter])

  const runAction = async (key: string, fn: () => Promise<void>) => {
    setBusyId(key)
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
      setBusyId(null)
    }
  }

  const openNewTopicForm = () => {
    setError(null)
    setTopicForm({
      mode: 'create',
      title: '',
      prompt: '',
      botId: defaultFeedBotId,
    })
  }

  const openEditTopicForm = (tp: FeedTopic) => {
    setError(null)
    setTopicForm({
      mode: 'edit',
      topicId: tp.id,
      title: tp.title,
      prompt: tp.prompt,
      botId: tp.botId,
    })
  }

  const submitTopic = async (
    values: { mode: 'create' | 'edit'; topicId?: string; title: string; prompt: string; botId: string },
    runNow: boolean,
  ) => {
    const prompt = values.prompt.trim()
    if (!prompt) return
    await runAction(runNow ? 'topic:save-run' : 'topic:save', async () => {
      if (values.mode === 'create') {
        const res = await createFeedTopic({
          ...(values.title.trim() ? { title: values.title.trim() } : {}),
          prompt,
          cron: '',
          ...(values.botId ? { botId: values.botId } : {}),
          runNow,
        })
        onChange(res.snapshot)
        setTopicForm(null)
        setInlineTitle('')
        setInlinePrompt('')
      } else if (values.topicId) {
        const res = await updateFeedTopic(values.topicId, {
          ...(values.title.trim() ? { title: values.title.trim() } : {}),
          prompt,
          cron: '',
          ...(values.botId ? { botId: values.botId } : {}),
        })
        onChange(res.snapshot)
        if (runNow) {
          const runRes = await runFeedTopic(values.topicId)
          onChange(runRes.snapshot)
        }
        setTopicForm(null)
      }
    })
  }

  const runDistill = async () => {
    await runAction('distill', async () => {
      const res = await distillFeedFromChats()
      onChange(res.snapshot)
      await onRefreshGoals?.()
    })
  }

  const openFollowup = (item: FeedItem) => {
    setFollowupId(item.id)
    setFollowupBot(item.body.suggestedBotId && roster[item.body.suggestedBotId] ? item.body.suggestedBotId : item.botId)
    setFollowupNote('')
  }

  const submitFollowup = async (item: FeedItem) => {
    await runAction(`followup:${item.id}`, async () => {
      const res = await followupFeedItem(item.id, {
        ...(followupBot ? { botId: followupBot } : {}),
        ...(followupNote.trim() ? { note: followupNote.trim() } : {}),
      })
      onChange(res.snapshot)
      setFollowupId(null)
      setFollowupNote('')
      onOpenThread(res.threadId)
    })
  }

  const submitNewIdea = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ideaTitle.trim()) return
    await runAction('idea:new', async () => {
      const res = await createIdea({
        title: ideaTitle.trim(),
        ...(ideaNotes.trim() ? { notes: ideaNotes.trim() } : {}),
      })
      onChange(res.snapshot)
      setIdeaTitle('')
      setIdeaNotes('')
      setShowManualIdea(false)
    })
  }

  const pickedBotForIdea = (idea: IdeaItem): string =>
    ideaBots[idea.id] ?? idea.assignedBotId ?? defaultBotId

  const openPromoteIdea = (idea: IdeaItem) => {
    setPromoteId(idea.id)
    setPromoteTitle(idea.title)
    setPromoteDesc([idea.notes, idea.incubationSummary].filter(Boolean).join('\n\n'))
    setPromoteCriteria('')
    setPromoteOwner(pickedBotForIdea(idea))
  }

  const openGoalsTab = () => {
    setTab('goals')
    onOpenGoals?.()
  }

  const submitPromoteIdea = async (idea: IdeaItem) => {
    if (!promoteTitle.trim()) return
    await runAction(`promote-goal:${idea.id}`, async () => {
      const res = await createGoal({
        title: promoteTitle.trim(),
        description: promoteDesc.trim(),
        successCriteria: promoteCriteria.trim(),
        ...(promoteOwner ? { ownerBotId: promoteOwner } : {}),
        sourceIdeaId: idea.id,
      })
      onGoalsChange?.(res.snapshot)
      onGoalCreated?.(res.snapshot)
      const freshFeed = await fetchFeed()
      if (freshFeed) onChange(freshFeed)
      setPromoteId(null)
      openGoalsTab()
    })
  }

  const actOnTrackingRoutine = async (routineId: number, action: RoutineAction) => {
    await runAction(`track-routine:${routineId}:${action}`, async () => {
      await updateRoutine(routineId, action)
      await onRefreshGoals?.()
    })
  }

  const renderTopicComposer = (
    values: { mode: 'create' | 'edit'; topicId?: string; title: string; prompt: string; botId: string },
    patch: (next: Partial<Pick<TopicFormState, 'title' | 'prompt' | 'botId'>>) => void,
    onCancel?: () => void,
  ) => {
    return (
      <form
        className="feed-custom-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submitTopic(values, true)
        }}
      >
        {values.mode === 'create' && !values.prompt.trim() ? (
          <div className="feed-starter-chips">
            {STARTER_PROMPTS.map((sp) => (
              <button
                key={sp.titleKey}
                type="button"
                className="feed-starter-chip"
                disabled={busyId !== null}
                onClick={() => patch({ title: t(sp.titleKey), prompt: t(sp.promptKey) })}
              >
                + {t(sp.titleKey)}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          className="feed-custom-prompt"
          rows={3}
          maxLength={1500}
          value={values.prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
          placeholder={t('feed.custom.promptPlaceholder')}
          aria-label={t('feed.custom.heading')}
          disabled={busyId !== null}
        />
        <div className="feed-custom-controls">
          <input
            type="text"
            className="feed-custom-title-input"
            maxLength={80}
            value={values.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder={t('feed.custom.titlePlaceholder')}
            disabled={busyId !== null}
          />
          {botEntries.length > 0 ? (
            <select
              className="feed-bot-select"
              aria-label={t('feed.custom.curator')}
              value={values.botId || defaultFeedBotId}
              onChange={(e) => patch({ botId: e.target.value })}
              disabled={busyId !== null}
            >
              {botEntries.map(([id, b]) => (
                <option key={id} value={id}>{b.name}</option>
              ))}
            </select>
          ) : null}
          <span className="spacer" />
          {onCancel ? (
            <button type="button" className="vault-small-btn" onClick={onCancel} disabled={busyId !== null}>
              {t('feed.custom.cancel')}
            </button>
          ) : null}
          <button
            type="button"
            className="vault-small-btn"
            disabled={busyId !== null || !values.prompt.trim()}
            onClick={() => void submitTopic(values, false)}
          >
            {t('feed.custom.save')}
          </button>
          <button
            type="submit"
            className="connector-connect-btn"
            disabled={busyId !== null || !values.prompt.trim()}
          >
            <RotateCwIcon size={12} />
            <span>{t('feed.custom.saveAndFetch')}</span>
          </button>
        </div>
      </form>
    )
  }

  return (
    <main className="thread feed-view">
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
          <InboxIcon size={16} />
          <span>{t('feed.title')}</span>
        </div>
        <div className="today-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === 'briefings'}
            className={`today-tab${effectiveTab === 'briefings' ? ' active' : ''}`}
            onClick={() => setTab('briefings')}
          >
            <NewspaperIcon size={14} className="today-tab-icon" />
            <span>{t('feed.tab.briefings')}</span>
            {state.unreadCount > 0 ? (
              <span className="feed-tab-count">{state.unreadCount}</span>
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === 'ideas'}
            className={`today-tab${effectiveTab === 'ideas' ? ' active' : ''}`}
            onClick={() => setTab('ideas')}
          >
            <LightbulbIcon size={14} className="today-tab-icon" />
            <span>{t('feed.tab.ideas')}</span>
            {state.ideas.length > 0 ? <span className="feed-tab-count subtle">{state.ideas.length}</span> : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === 'goals'}
            className={`today-tab${effectiveTab === 'goals' ? ' active' : ''}`}
            onClick={() => setTab('goals')}
          >
            <TargetIcon size={14} className="today-tab-icon" />
            <span>{t('feed.tab.goals')}</span>
            {state.needsYou.length > 0 ? (
              <span className="feed-tab-count">{state.needsYou.length}</span>
            ) : openTodosCount + (goals?.activeCount ?? 0) > 0 ? (
              <span className="feed-tab-count subtle">{openTodosCount + (goals?.activeCount ?? 0)}</span>
            ) : null}
          </button>
          {spaces ? (
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === 'spaces'}
              className={`today-tab${effectiveTab === 'spaces' ? ' active' : ''}`}
              onClick={() => setTab('spaces')}
            >
              <LayoutGridIcon size={14} className="today-tab-icon" />
              <span>{t('feed.tab.spaces')}</span>
              {spaces.spaces.length > 0 ? <span className="feed-tab-count subtle">{spaces.spaces.length}</span> : null}
            </button>
          ) : null}
        </div>
        <span className="spacer" />
        {effectiveTab === 'briefings' && state.unreadCount > 0 ? (
          <button
            type="button"
            className="vault-small-btn"
            disabled={busyId !== null}
            onClick={() => void runAction('read-all', async () => {
              const res = await markAllFeedRead()
              onChange(res.snapshot)
            })}
          >
            {t('feed.markAllRead')}
          </button>
        ) : null}
      </header>

      <div className="feed-body">
        {error ? <div className="form-error" role="alert">{error}</div> : null}

        {effectiveTab === 'spaces' && spaces ? (
          <SpacesView
            embedded
            state={spaces}
            roster={roster}
            goals={goals?.goals}
            selectedSpaceId={selectedSpaceId}
            onSelectSpace={onSelectSpace}
            onChange={onSpacesChange ?? (() => {})}
            onOpenThread={onOpenThread}
            onDesignWithBot={onDesignSpaceWithBot}
            onOpenGoal={goals ? () => setTab('goals') : undefined}
            onSignedOut={onSignedOut}
          />
        ) : effectiveTab === 'goals' ? (
          <>
            <section className="feed-section" aria-label={t('feed.needsYou')}>
              <div className="feed-section-head">
                <h2 className="feed-section-title">
                  {t('feed.needsYou')}
                  {state.needsYou.length > 0 ? <span className="feed-count-pill amber">{state.needsYou.length}</span> : null}
                </h2>
              </div>

              {state.needsYou.length === 0 ? (
                <div className="feed-needs-empty">✓ {t('feed.needsYouEmpty')}</div>
              ) : (
                <div className="feed-needs-list">
                  {state.needsYou.map((n) => (
                    <div className="feed-need-card" key={n.id}>
                      <div className="feed-card-meta">
                        <span className="feed-card-author">
                          <BotAvatar seed={n.botId} emoji={n.botEmoji} size="sm" />
                          <span className="feed-author-name">{n.botName}</span>
                          {n.threadTitle && n.threadTitle !== n.botName ? (
                            <span className="feed-author-thread">· {n.threadTitle}</span>
                          ) : null}
                        </span>
                        <span className="feed-card-right">
                          <span className="feed-time">{formatTime(n.createdAt, t)}</span>
                          <button type="button" className="vault-small-btn" onClick={() => onOpenThread(n.threadId)}>
                            {t('feed.openThread')}
                          </button>
                        </span>
                      </div>
                      {n.kind === 'approval' ? (
                        <ApprovalChip
                          payload={n.payload}
                          onDecide={onDecide}
                        />
                      ) : n.kind === 'question' ? (
                        <QuestionChip
                          payload={n.payload}
                          onAnswer={(choices) => onAnswer(n.messageId, choices)}
                        />
                      ) : (
                        <LoginChip
                          payload={n.payload}
                          onOpenScreen={() => onOpenComputer(n.botId)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="feed-section" aria-label={t('feed.todos.heading')}>
              <div className="feed-auto-bar">
                <div className="feed-auto-bar-copy">
                  <h2 className="feed-section-title">
                    <span>{t('feed.todos.heading')}</span>
                    {openTodosCount > 0 ? <span className="feed-tab-count subtle">{openTodosCount}</span> : null}
                  </h2>
                  <p className="feed-auto-hint">{t('feed.todos.hint')}</p>
                </div>
                <div className="feed-auto-bar-actions">
                  <button
                    type="button"
                    className="vault-small-btn primary"
                    disabled={busyId !== null}
                    onClick={() => void runDistill()}
                  >
                    <CpuSparkleIcon size={12} />
                    <span>{busyId === 'distill' ? t('feed.distill.running') : t('feed.distill.button')}</span>
                  </button>
                </div>
              </div>

              {todos.length === 0 ? (
                <div className="feed-needs-empty">{t('feed.todos.empty')}</div>
              ) : (
                <ul className="todo-list">
                  {todos.map((td) => (
                    <li key={td.id} className={`todo-row${td.status === 'done' ? ' done' : ''}`}>
                      <label className="todo-check-label">
                        <input
                          type="checkbox"
                          checked={td.status === 'done'}
                          disabled={busyId !== null}
                          onChange={() => void runAction(`todo:${td.id}`, async () => {
                            const res = await updateTodo(td.id, { status: td.status === 'done' ? 'open' : 'done' })
                            onChange(res.snapshot)
                          })}
                        />
                        <span className="todo-body">
                          <span className="todo-title">{td.title}</span>
                          {td.detail ? <span className="todo-detail">{td.detail}</span> : null}
                        </span>
                      </label>
                      <span className="todo-meta">
                        {td.origin === 'auto' ? (
                          <span className="vault-badge subtle">{t('feed.todos.autoBadge')}</span>
                        ) : null}
                        {td.ownerBotId ? <span className="todo-bot">@{roster[td.ownerBotId]?.name ?? td.ownerBotId}</span> : null}
                        {td.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}
                        {td.sourceThreadId ? (
                          <button type="button" className="vault-small-btn" onClick={() => onOpenThread(td.sourceThreadId!)}>
                            {t('feed.openThread')}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="vault-small-btn danger"
                          aria-label={t('feed.todos.dismiss')}
                          title={t('feed.todos.dismiss')}
                          disabled={busyId !== null}
                          onClick={() => void runAction(`del-todo:${td.id}`, async () => {
                            const res = await deleteTodo(td.id)
                            onChange(res.snapshot)
                          })}
                        >
                          <XIcon size={12} />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {goals && goals.unlinkedRoutines.length > 0 ? (
              <section className="feed-section" aria-label={t('feed.tracking.heading')}>
                <div className="feed-section-head">
                  <h2 className="feed-section-title">
                    <ClockIcon size={14} />
                    <span>{t('feed.tracking.heading')}</span>
                    <span className="feed-tab-count subtle">{goals.unlinkedRoutines.length}</span>
                  </h2>
                  <span className="goal-muted-inline">{t('feed.tracking.hint')}</span>
                </div>
                <ul className="goal-routines">
                  {goals.unlinkedRoutines.map((r) => (
                    <li key={r.id} className="goal-routine-row tracking-row">
                      <span className="goal-routine-info">
                        <strong>{r.name}</strong>
                        <span className="goal-muted-inline">
                          @{roster[r.botId]?.name ?? r.botId} · {r.human}
                          {r.mode === 'watch' ? ' · watch' : ''}
                          {r.enabled ? '' : ` · ${t('goals.status.paused')}`}
                        </span>
                      </span>
                      <span className="goal-routine-actions">
                        <button
                          type="button"
                          className="vault-small-btn"
                          disabled={busyId !== null}
                          onClick={() => void actOnTrackingRoutine(r.id, 'run')}
                        >
                          {t('goals.routineRunNow')}
                        </button>
                        <button
                          type="button"
                          className="vault-small-btn"
                          disabled={busyId !== null}
                          onClick={() => void actOnTrackingRoutine(r.id, r.enabled ? 'pause' : 'resume')}
                        >
                          {t(r.enabled ? 'goals.routinePause' : 'goals.routineResume')}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {goals ? (
              <GoalsView
                embedded
                state={goals}
                roster={roster}
                onChange={onGoalsChange ?? (() => {})}
                onRefresh={onRefreshGoals ?? (async () => {})}
                onOpenThread={onOpenThread}
                onOpenSpace={spaces ? (spaceId) => { onSelectSpace?.(spaceId); setTab('spaces') } : undefined}
                onSignedOut={onSignedOut}
              />
            ) : null}
          </>
        ) : effectiveTab === 'briefings' ? (
          <>
            <section className="feed-section feed-custom-card" aria-label={t('feed.custom.heading')}>
              <div className="feed-section-head">
                <div>
                  <h2 className="feed-section-title">
                    <span>{t('feed.custom.heading')}</span>
                    {topics.length > 0 || (state.dailyCustomCount ?? 0) > 0 ? (
                      <span className="feed-quota-pill">
                        {t('feed.custom.dailyQuota', {
                          count: state.dailyCustomCount ?? 0,
                          cap: state.dailyCustomCap ?? 15,
                        })}
                      </span>
                    ) : null}
                  </h2>
                  {topics.length === 0 ? <p className="feed-custom-subtitle">{t('feed.custom.subtitle')}</p> : null}
                </div>
                {topics.length > 0 ? (
                  <div className="feed-filters">
                    <button
                      type="button"
                      className="vault-small-btn"
                      disabled={busyId !== null || !topics.some((tp) => tp.enabled)}
                      onClick={() => void runAction('topics:run-all', async () => {
                        const res = await runAllFeedTopics()
                        onChange(res.snapshot)
                      })}
                    >
                      <RotateCwIcon size={12} />
                      <span>{t('feed.custom.refreshAll')}</span>
                    </button>
                    <button
                      type="button"
                      className="connector-connect-btn"
                      disabled={busyId !== null}
                      onClick={() => (topicForm?.mode === 'create' ? setTopicForm(null) : openNewTopicForm())}
                    >
                      <PlusIcon size={12} />
                      <span>{t('feed.custom.add')}</span>
                    </button>
                  </div>
                ) : null}
              </div>

              {topics.length === 0 && !topicForm
                ? renderTopicComposer(
                    {
                      mode: 'create',
                      title: inlineTitle,
                      prompt: inlinePrompt,
                      botId: inlineBot || defaultFeedBotId,
                    },
                    (p) => {
                      if (p.title !== undefined) setInlineTitle(p.title)
                      if (p.prompt !== undefined) setInlinePrompt(p.prompt)
                      if (p.botId !== undefined) setInlineBot(p.botId)
                    },
                  )
                : null}

              {topicForm
                ? renderTopicComposer(
                    topicForm,
                    (p) => setTopicForm((prev) => (prev ? { ...prev, ...p } : prev)),
                    () => setTopicForm(null),
                  )
                : null}

              {topics.length > 0 ? (
                <div className="feed-topic-grid">
                  {topics.map((tp) => {
                    const selectedTopic = topicFilter === tp.id
                    return (
                      <div key={tp.id} className={`feed-topic-card${selectedTopic ? ' selected' : ''}${tp.enabled ? '' : ' paused'}`}>
                        <div className="feed-topic-head">
                          <button
                            type="button"
                            className="feed-topic-title-btn"
                            onClick={() => setTopicFilter(selectedTopic ? '' : tp.id)}
                          >
                            <span>{tp.title}</span>
                          </button>
                          <span className="feed-topic-badges">
                            {tp.running ? (
                              <span className="feed-running-pill">{t('feed.custom.fetching')}</span>
                            ) : !tp.enabled ? (
                              <span className="vault-badge subtle">{t('feed.custom.paused')}</span>
                            ) : (
                              <span className="feed-live-pill">{t('feed.custom.liveBadge')}</span>
                            )}
                          </span>
                        </div>
                        <p className="feed-topic-prompt">{tp.prompt}</p>
                        {tp.lastError ? <div className="feed-topic-error">{tp.lastError}</div> : null}
                        <div className="feed-topic-foot">
                          <span className="feed-topic-meta">
                            <span>{tp.botEmoji} {tp.botName}</span>
                            <span>·</span>
                            <span>
                              {tp.lastRunAt
                                ? t('feed.custom.lastRun', { time: formatTime(tp.lastRunAt, t) })
                                : t('feed.custom.neverRun')}
                            </span>
                          </span>
                          <span className="feed-topic-actions">
                            <button
                              type="button"
                              className="vault-small-btn primary"
                              disabled={busyId !== null || tp.running}
                              onClick={() => void runAction(`run-topic:${tp.id}`, async () => {
                                const res = await runFeedTopic(tp.id)
                                onChange(res.snapshot)
                              })}
                            >
                              <RotateCwIcon size={11} />
                              <span>{tp.running ? t('feed.custom.fetching') : t('feed.custom.fetchNow')}</span>
                            </button>
                            <button
                              type="button"
                              className="vault-small-btn"
                              disabled={busyId !== null}
                              onClick={() => openEditTopicForm(tp)}
                            >
                              {t('feed.custom.edit')}
                            </button>
                            <button
                              type="button"
                              className="vault-small-btn"
                              disabled={busyId !== null}
                              onClick={() => void runAction(`toggle-topic:${tp.id}`, async () => {
                                const res = await updateFeedTopic(tp.id, { enabled: !tp.enabled })
                                onChange(res.snapshot)
                              })}
                            >
                              {t(tp.enabled ? 'feed.custom.pause' : 'feed.custom.resume')}
                            </button>
                            <button
                              type="button"
                              className="vault-small-btn danger"
                              disabled={busyId !== null}
                              onClick={() => void runAction(`del-topic:${tp.id}`, async () => {
                                const res = await deleteFeedTopic(tp.id)
                                if (topicFilter === tp.id) setTopicFilter('')
                                onChange(res.snapshot)
                              })}
                            >
                              {t('feed.custom.delete')}
                            </button>
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </section>

            <section className="feed-section" aria-label={t('feed.streamTitle')}>
              <div className="feed-section-head">
                <h2 className="feed-section-title">{t('feed.streamTitle')}</h2>
                <div className="feed-filters">
                  {(['all', 'unread', 'proposal'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={`feed-filter-btn${filter === f ? ' active' : ''}`}
                      onClick={() => setFilter(f)}
                    >
                      {t(`feed.filter.${f}` as MessageKey)}
                    </button>
                  ))}
                  {topics.length > 0 ? (
                    <select
                      className="feed-bot-select"
                      aria-label={t('feed.filter.allTopics')}
                      value={topicFilter}
                      onChange={(e) => setTopicFilter(e.target.value)}
                    >
                      <option value="">{t('feed.filter.allTopics')}</option>
                      {topics.map((tp) => (
                        <option key={tp.id} value={tp.id}>{tp.title}</option>
                      ))}
                    </select>
                  ) : null}
                  {botEntries.length > 1 ? (
                    <select
                      className="feed-bot-select"
                      aria-label={t('feed.filter.allTeammates')}
                      value={botFilter}
                      onChange={(e) => setBotFilter(e.target.value)}
                    >
                      <option value="">{t('feed.filter.allTeammates')}</option>
                      {botEntries.map(([id, b]) => (
                        <option key={id} value={id}>{b.name}</option>
                      ))}
                    </select>
                  ) : null}
                </div>
              </div>

              {filteredItems.length === 0 ? (
                <div className="feed-empty">{t('feed.empty')}</div>
              ) : (
                <div className="feed-stream">
                  {filteredItems.map((item) => {
                    const isFollowupOpen = followupId === item.id
                    const matchedTopic = item.topicId ? topicsById[item.topicId] : undefined
                    const sources = item.body.sources ?? []
                    return (
                      <article className={`feed-card${item.status === 'unread' ? ' unread' : ''}`} key={item.id}>
                        <div className="feed-card-meta">
                          <span className="feed-card-author">
                            <BotAvatar seed={item.botId} emoji={item.botEmoji} size="sm" />
                            <span className="feed-author-name">{item.botName}</span>
                            <span className={`feed-kind-badge ${item.kind}`}>{t(`feed.kind.${item.kind}` as MessageKey)}</span>
                            {matchedTopic ? (
                              <span className="vault-badge subtle">{matchedTopic.title}</span>
                            ) : null}
                            {item.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}
                          </span>
                          <span className="feed-time">{formatTime(item.createdAt, t)}</span>
                        </div>

                        <h3 className="feed-card-title">{item.title}</h3>
                        {item.body.report ? (
                          <ReportChip payload={item.body.report} />
                        ) : (
                          <p className="feed-card-summary">{item.summary}</p>
                        )}
                        {sources.length > 0 ? (
                          <div className="feed-sources" aria-label={t('feed.sources')}>
                            {sources.map((src) => (
                              <a
                                key={src.url}
                                href={src.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="feed-source-link"
                              >
                                <ExternalLinkIcon size={11} />
                                <span>{src.title}</span>
                              </a>
                            ))}
                          </div>
                        ) : null}
                        {item.body.suggestedAction ? (
                          <div className="feed-suggested">
                            <strong>{t('feed.suggestedAction')}:</strong> {item.body.suggestedAction}
                          </div>
                        ) : null}
                        {item.tags.length > 0 ? (
                          <div className="feed-tags">
                            {item.tags.map((tag) => <span className="feed-tag" key={tag}>#{tag}</span>)}
                          </div>
                        ) : null}

                        <div className="feed-card-actions">
                          {item.status === 'unread' ? (
                            <button
                              type="button"
                              className="vault-small-btn"
                              disabled={busyId !== null}
                              onClick={() => void runAction(`read:${item.id}`, async () => {
                                const res = await updateFeedItemStatus(item.id, 'read')
                                onChange(res.snapshot)
                              })}
                            >
                              {t('feed.markRead')}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="vault-small-btn"
                            disabled={busyId !== null}
                            onClick={() => (isFollowupOpen ? setFollowupId(null) : openFollowup(item))}
                          >
                            {t('feed.followup')}
                          </button>
                          <button
                            type="button"
                            className="vault-small-btn"
                            disabled={busyId !== null}
                            onClick={() => void runAction(`idea:${item.id}`, async () => {
                              const res = await promoteFeedToIdea(item.id)
                              onChange(res.snapshot)
                              setTab('ideas')
                            })}
                          >
                            {t('feed.saveAsIdea')}
                          </button>
                          <button
                            type="button"
                            className="vault-small-btn"
                            disabled={busyId !== null}
                            onClick={() => void runAction(`arch:${item.id}`, async () => {
                              const res = await updateFeedItemStatus(item.id, 'archived')
                              onChange(res.snapshot)
                            })}
                          >
                            {t('feed.archive')}
                          </button>
                          <button type="button" className="vault-small-btn" onClick={() => onOpenThread(item.threadId)}>
                            {t('feed.openThread')}
                          </button>
                        </div>

                        {isFollowupOpen ? (
                          <div className="feed-followup-box">
                            <select
                              className="feed-bot-select"
                              value={followupBot}
                              onChange={(e) => setFollowupBot(e.target.value)}
                              disabled={busyId !== null}
                            >
                              {botEntries.map(([id, b]) => (
                                <option key={id} value={id}>{b.name}</option>
                              ))}
                            </select>
                            <input
                              type="text"
                              className="feed-followup-input"
                              value={followupNote}
                              onChange={(e) => setFollowupNote(e.target.value)}
                              placeholder={t('feed.followupPlaceholder')}
                              disabled={busyId !== null}
                            />
                            <button
                              type="button"
                              className="vault-small-btn primary"
                              disabled={busyId !== null}
                              onClick={() => void submitFollowup(item)}
                            >
                              {t('feed.followupSend')}
                            </button>
                          </div>
                        ) : null}
                      </article>
                    )
                  })}
                </div>
              )}
            </section>
          </>
        ) : (
          <section className="feed-section" aria-label={t('feed.tab.ideas')}>
            <div className="feed-auto-bar">
              <div className="feed-auto-bar-copy">
                <h2 className="feed-section-title">{t('feed.ideas.autoHeading')}</h2>
                <p className="feed-auto-hint">{t('feed.ideas.autoHint')}</p>
              </div>
              <div className="feed-auto-bar-actions">
                <button
                  type="button"
                  className="vault-small-btn primary"
                  disabled={busyId !== null}
                  onClick={() => void runDistill()}
                >
                  <CpuSparkleIcon size={12} />
                  <span>{busyId === 'distill' ? t('feed.distill.running') : t('feed.distill.button')}</span>
                </button>
                <button
                  type="button"
                  className="vault-small-btn"
                  disabled={busyId !== null}
                  onClick={() => setShowManualIdea((prev) => !prev)}
                >
                  <PlusIcon size={12} />
                  <span>{t('feed.ideas.manualToggle')}</span>
                </button>
              </div>
            </div>

            {showManualIdea ? (
              <form className="idea-composer" onSubmit={(e) => void submitNewIdea(e)}>
                <input
                  type="text"
                  className="idea-title-input"
                  value={ideaTitle}
                  onChange={(e) => setIdeaTitle(e.target.value)}
                  placeholder={t('feed.ideas.titlePlaceholder')}
                  disabled={busyId !== null}
                />
                <div className="idea-composer-row">
                  <input
                    type="text"
                    className="idea-notes-input"
                    value={ideaNotes}
                    onChange={(e) => setIdeaNotes(e.target.value)}
                    placeholder={t('feed.ideas.notesPlaceholder')}
                    disabled={busyId !== null}
                  />
                  <button type="submit" className="connector-connect-btn" disabled={busyId !== null || !ideaTitle.trim()}>
                    <PlusIcon size={12} />
                    <span>{t('feed.ideas.add')}</span>
                  </button>
                </div>
              </form>
            ) : null}

            {state.ideas.length === 0 ? (
              <div className="feed-empty">{t('feed.ideas.empty')}</div>
            ) : (
              <div className="feed-stream">
                {state.ideas.map((idea) => {
                  const chosenBot = pickedBotForIdea(idea)
                  const threadLink = idea.incubationThreadId || idea.sourceThreadId
                  return (
                    <article className="feed-card idea-card" key={idea.id}>
                      <div className="feed-card-meta">
                        <span className="feed-card-author">
                          <span className={`idea-status-badge ${idea.status}`}>
                            {t(`feed.ideas.status.${idea.status}` as MessageKey)}
                          </span>
                          {idea.origin === 'conversation' ? (
                            <span className="vault-badge subtle">{t('feed.ideas.fromConversation')}</span>
                          ) : idea.origin === 'proposal' ? (
                            <span className="vault-badge subtle">{t('feed.ideas.fromProposal')}</span>
                          ) : null}
                          {idea.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}
                        </span>
                        <span className="feed-time">{formatTime(idea.updatedAt, t)}</span>
                      </div>

                      <h3 className="feed-card-title">{idea.title}</h3>
                      {idea.notes ? <p className="feed-card-summary">{idea.notes}</p> : null}

                      {idea.incubationSummary ? (
                        <div className="idea-brief">
                          <div className="idea-brief-head">{t('feed.ideas.researchHeading')}</div>
                          <div className="idea-brief-body">{idea.incubationSummary}</div>
                        </div>
                      ) : null}

                      <div className="feed-card-actions">
                        {botEntries.length > 0 ? (
                          <select
                            className="feed-bot-select"
                            aria-label={idea.title}
                            value={chosenBot}
                            disabled={busyId !== null}
                            onChange={(e) => setIdeaBots((prev) => ({ ...prev, [idea.id]: e.target.value }))}
                          >
                            {botEntries.map(([id, b]) => (
                              <option key={id} value={id}>{b.name}</option>
                            ))}
                          </select>
                        ) : null}
                        <button
                          type="button"
                          className="vault-small-btn"
                          disabled={busyId !== null || idea.status === 'incubating' || !chosenBot}
                          onClick={() => void runAction(`inc:${idea.id}`, async () => {
                            const res = await incubateIdea(idea.id, { botId: chosenBot })
                            onChange(res.snapshot)
                          })}
                        >
                          {t('feed.ideas.incubate')}
                        </button>
                        <button
                          type="button"
                          className="vault-small-btn primary"
                          disabled={busyId !== null || !chosenBot}
                          onClick={() => void runAction(`disp:${idea.id}`, async () => {
                            const res = await dispatchIdea(idea.id, { botId: chosenBot })
                            onChange(res.snapshot)
                            onOpenThread(res.threadId)
                          })}
                        >
                          {t('feed.ideas.dispatch')}
                        </button>
                        {hasGoals ? (
                          idea.promotedGoalId ? (
                            <button
                              type="button"
                              className="vault-small-btn"
                              onClick={openGoalsTab}
                            >
                              {t('feed.ideas.viewGoal')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="vault-small-btn"
                              disabled={busyId !== null || !chosenBot}
                              onClick={() => (promoteId === idea.id ? setPromoteId(null) : openPromoteIdea(idea))}
                            >
                              {t('feed.ideas.promoteGoal')}
                            </button>
                          )
                        ) : null}
                        {threadLink ? (
                          <button type="button" className="vault-small-btn" onClick={() => onOpenThread(threadLink)}>
                            {t('feed.openThread')}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="vault-small-btn"
                          disabled={busyId !== null}
                          onClick={() => void runAction(`arch-idea:${idea.id}`, async () => {
                            const res = await updateIdea(idea.id, { status: 'archived' })
                            onChange(res.snapshot)
                          })}
                        >
                          {t('feed.ideas.archive')}
                        </button>
                        <button
                          type="button"
                          className="vault-small-btn danger"
                          disabled={busyId !== null}
                          onClick={() => void runAction(`del-idea:${idea.id}`, async () => {
                            const res = await deleteIdea(idea.id)
                            onChange(res.snapshot)
                          })}
                        >
                          {t('feed.ideas.delete')}
                        </button>
                      </div>

                      {promoteId === idea.id ? (
                        <div className="idea-promote-box">
                          <div className="idea-promote-head">{t('feed.ideas.promoteTitle')}</div>
                          {idea.tainted ? (
                            <div className="idea-promote-warn" role="note">
                              {t('feed.ideas.promoteTaintedWarning')}
                            </div>
                          ) : null}
                          <input
                            type="text"
                            value={promoteTitle}
                            onChange={(e) => setPromoteTitle(e.target.value)}
                            placeholder={t('goals.form.titlePlaceholder')}
                            disabled={busyId !== null}
                          />
                          <textarea
                            rows={2}
                            value={promoteDesc}
                            onChange={(e) => setPromoteDesc(e.target.value)}
                            placeholder={t('goals.form.descriptionPlaceholder')}
                            disabled={busyId !== null}
                          />
                          <input
                            type="text"
                            value={promoteCriteria}
                            onChange={(e) => setPromoteCriteria(e.target.value)}
                            placeholder={t('goals.form.criteriaPlaceholder')}
                            disabled={busyId !== null}
                          />
                          <div className="idea-promote-footer">
                            <select
                              className="feed-bot-select"
                              aria-label={t('goals.form.owner')}
                              value={promoteOwner}
                              onChange={(e) => setPromoteOwner(e.target.value)}
                              disabled={busyId !== null}
                            >
                              {botEntries.map(([id, b]) => (
                                <option key={id} value={id}>{b.name}</option>
                              ))}
                            </select>
                            <span className="spacer" />
                            <button
                              type="button"
                              className="vault-small-btn"
                              onClick={() => setPromoteId(null)}
                              disabled={busyId !== null}
                            >
                              {t('goals.form.cancel')}
                            </button>
                            <button
                              type="button"
                              className="vault-small-btn primary"
                              disabled={busyId !== null || !promoteTitle.trim()}
                              onClick={() => void submitPromoteIdea(idea)}
                            >
                              {t('feed.ideas.promoteConfirm')}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  )
}
