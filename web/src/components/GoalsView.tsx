import { useMemo, useState } from 'react'
import {
  ApiError,
  SignedOut,
  addGoalMilestone,
  addGoalUpdate,
  checkinGoal,
  createGoal,
  deleteGoal,
  deleteGoalMilestone,
  setRoutineGoal,
  updateGoal,
  updateGoalMilestone,
  updateRoutine,
} from '../api'
import { useT, type MessageKey, type T } from '../i18n'
import { errorText } from '../i18n/describe'
import type {
  GoalStatus,
  GoalView,
  GoalsSnapshot,
  RoutineAction,
} from '../types'
import { BotAvatar } from './BotAvatar'
import { ConfirmDialog } from './ConfirmDialog'
import type { Roster } from './ConnectorsDialog'
import { PlusIcon, SidebarIcon, TargetIcon, XIcon } from './Icons'

const STATUS_TABS: readonly GoalStatus[] = ['active', 'paused', 'done', 'archived']

function todayIsoDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatTime(ts: number, t: T, now = new Date()): string {
  if (!ts || ts < 86_400_000) return ''
  const at = new Date(ts)
  const time = at.toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString(t.locale, { month: 'short', day: 'numeric' })} ${time}`
}

type GoalFormState = {
  mode: 'create' | 'edit'
  goalId?: string
  title: string
  description: string
  successCriteria: string
  targetDate: string
  ownerBotId: string
  memberBotIds: string[]
  milestonesText: string
}

export function GoalsView({
  state,
  roster,
  onChange,
  onRefresh,
  onOpenThread,
  onOpenSpace,
  onToggleSidebar,
  onSignedOut,
  embedded,
}: {
  state: GoalsSnapshot
  roster: Roster
  onChange: (next: GoalsSnapshot) => void
  onRefresh: () => Promise<void>
  onOpenThread: (threadId: string) => void
  onOpenSpace?: (spaceId: string) => void
  onToggleSidebar?: () => void
  onSignedOut?: () => void
  /** 嵌入在「今日（Today）」顶栏二级 Tab 内时复用外层顶栏与滚动容器 */
  embedded?: boolean
}) {
  const t = useT()
  const [statusFilter, setStatusFilter] = useState<GoalStatus>('active')
  const [form, setForm] = useState<GoalFormState | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<GoalView | null>(null)

  // Per-goal inline inputs
  const [newMilestone, setNewMilestone] = useState<Record<string, string>>({})
  const [newUpdate, setNewUpdate] = useState<Record<string, string>>({})
  const [linkRoutinePick, setLinkRoutinePick] = useState<Record<string, string>>({})
  const [checkinOpenId, setCheckinOpenId] = useState<string | null>(null)
  const [checkinBot, setCheckinBot] = useState<string>('')
  const [checkinNote, setCheckinNote] = useState<string>('')

  const botEntries = useMemo(() => Object.entries(roster), [roster])
  const defaultOwner = botEntries.find(([id]) => id === 'chief')?.[0] ?? botEntries[0]?.[0] ?? ''
  const today = todayIsoDate()

  const counts = useMemo(() => {
    const map: Record<GoalStatus, number> = { active: 0, paused: 0, done: 0, archived: 0 }
    for (const g of state.goals) map[g.status] = (map[g.status] ?? 0) + 1
    return map
  }, [state.goals])

  const visibleGoals = useMemo(
    () => state.goals.filter((g) => g.status === statusFilter),
    [state.goals, statusFilter],
  )

  const runAction = async (key: string, fn: () => Promise<void>) => {
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

  const openCreateForm = () => {
    setError(null)
    setForm({
      mode: 'create',
      title: '',
      description: '',
      successCriteria: '',
      targetDate: '',
      ownerBotId: defaultOwner,
      memberBotIds: [],
      milestonesText: '',
    })
  }

  const openEditForm = (goal: GoalView) => {
    setError(null)
    setForm({
      mode: 'edit',
      goalId: goal.id,
      title: goal.title,
      description: goal.description,
      successCriteria: goal.successCriteria,
      targetDate: goal.targetDate ?? '',
      ownerBotId: goal.ownerBotId,
      memberBotIds: [...goal.memberBotIds],
      milestonesText: '',
    })
  }

  const toggleFormMember = (botId: string) => {
    setForm((prev) => {
      if (!prev) return prev
      const has = prev.memberBotIds.includes(botId)
      return {
        ...prev,
        memberBotIds: has ? prev.memberBotIds.filter((id) => id !== botId) : [...prev.memberBotIds, botId],
      }
    })
  }

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form || !form.title.trim()) return
    await runAction('goal:form', async () => {
      if (form.mode === 'create') {
        const milestones = form.milestonesText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        const res = await createGoal({
          title: form.title.trim(),
          description: form.description.trim(),
          successCriteria: form.successCriteria.trim(),
          ownerBotId: form.ownerBotId || defaultOwner,
          memberBotIds: form.memberBotIds.filter((id) => id !== (form.ownerBotId || defaultOwner)),
          targetDate: form.targetDate.trim() || null,
          ...(milestones.length ? { milestones } : {}),
        })
        onChange(res.snapshot)
        setStatusFilter('active')
        setForm(null)
      } else if (form.goalId) {
        const res = await updateGoal(form.goalId, {
          title: form.title.trim(),
          description: form.description.trim(),
          successCriteria: form.successCriteria.trim(),
          ownerBotId: form.ownerBotId || defaultOwner,
          memberBotIds: form.memberBotIds.filter((id) => id !== (form.ownerBotId || defaultOwner)),
          targetDate: form.targetDate.trim() || null,
        })
        onChange(res.snapshot)
        setForm(null)
      }
    })
  }

  const openCheckin = (goal: GoalView) => {
    setCheckinOpenId(goal.id)
    setCheckinBot(goal.ownerBotId)
    setCheckinNote('')
  }

  const submitCheckin = async (goal: GoalView) => {
    await runAction(`checkin:${goal.id}`, async () => {
      const res = await checkinGoal(goal.id, {
        ...(checkinBot ? { botId: checkinBot } : {}),
        ...(checkinNote.trim() ? { note: checkinNote.trim() } : {}),
      })
      onChange(res.snapshot)
      setCheckinOpenId(null)
      setCheckinNote('')
      onOpenThread(res.threadId)
    })
  }

  const submitMilestone = async (e: React.FormEvent, goalId: string) => {
    e.preventDefault()
    const title = (newMilestone[goalId] ?? '').trim()
    if (!title) return
    await runAction(`ms:add:${goalId}`, async () => {
      const res = await addGoalMilestone(goalId, { title })
      onChange(res.snapshot)
      setNewMilestone((prev) => ({ ...prev, [goalId]: '' }))
    })
  }

  const submitNote = async (e: React.FormEvent, goalId: string) => {
    e.preventDefault()
    const summary = (newUpdate[goalId] ?? '').trim()
    if (!summary) return
    await runAction(`upd:${goalId}`, async () => {
      const res = await addGoalUpdate(goalId, summary)
      onChange(res.snapshot)
      setNewUpdate((prev) => ({ ...prev, [goalId]: '' }))
    })
  }

  const linkRoutine = async (goalId: string) => {
    const rawId = linkRoutinePick[goalId]
    const routineId = Number(rawId)
    if (!Number.isInteger(routineId) || routineId <= 0) return
    await runAction(`link:${goalId}:${routineId}`, async () => {
      await setRoutineGoal(routineId, goalId)
      setLinkRoutinePick((prev) => ({ ...prev, [goalId]: '' }))
      await onRefresh()
    })
  }

  const actOnRoutine = async (routineId: number, action: RoutineAction | 'unlink') => {
    await runAction(`routine:${routineId}:${action}`, async () => {
      if (action === 'unlink') {
        await setRoutineGoal(routineId, null)
      } else {
        await updateRoutine(routineId, action)
      }
      await onRefresh()
    })
  }

  const statusControls = (
    <div className="feed-tabs" role="tablist">
      {STATUS_TABS.map((s) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={statusFilter === s}
          className={`feed-tab${statusFilter === s ? ' active' : ''}`}
          onClick={() => setStatusFilter(s)}
        >
          <span>{t(`goals.filter.${s}` as MessageKey)}</span>
          {counts[s] > 0 ? (
            <span className={`feed-tab-count${s === 'active' ? '' : ' subtle'}`}>{counts[s]}</span>
          ) : null}
        </button>
      ))}
    </div>
  )

  const newButton = (
    <button
      type="button"
      className="connector-connect-btn"
      disabled={busyKey !== null}
      onClick={openCreateForm}
    >
      <PlusIcon size={12} />
      <span>{t('goals.new')}</span>
    </button>
  )

  const bodyContent = (
    <>
      {embedded ? (
        <div className="goals-subbar">
          <h2 className="feed-section-title">{t('goals.title')}</h2>
          {statusControls}
          <span className="spacer" />
          <button
            type="button"
            className="vault-small-btn"
            disabled={busyKey !== null}
            onClick={openCreateForm}
          >
            <PlusIcon size={12} />
            <span>{t('goals.new')}</span>
          </button>
        </div>
      ) : null}
      {error ? <div className="form-error" role="alert">{error}</div> : null}

        {form ? (
          <form className="goal-form-card" onSubmit={(e) => void submitForm(e)}>
            <div className="goal-form-head">
              <strong>{t(form.mode === 'create' ? 'goals.form.newTitle' : 'goals.form.editTitle')}</strong>
              <button
                type="button"
                className="modal-close"
                aria-label={t('goals.form.cancel')}
                onClick={() => setForm(null)}
              >
                <XIcon size={14} />
              </button>
            </div>

            <div className="goal-form-grid">
              <label className="goal-field">
                <span>{t('goals.form.title')}</span>
                <input
                  type="text"
                  required
                  maxLength={120}
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder={t('goals.form.titlePlaceholder')}
                  disabled={busyKey !== null}
                />
              </label>

              <label className="goal-field">
                <span>{t('goals.form.targetDate')}</span>
                <input
                  type="date"
                  value={form.targetDate}
                  onChange={(e) => setForm({ ...form, targetDate: e.target.value })}
                  disabled={busyKey !== null}
                />
              </label>
            </div>

            <label className="goal-field">
              <span>{t('goals.form.description')}</span>
              <textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder={t('goals.form.descriptionPlaceholder')}
                disabled={busyKey !== null}
              />
            </label>

            <label className="goal-field">
              <span>{t('goals.form.criteria')}</span>
              <textarea
                rows={2}
                value={form.successCriteria}
                onChange={(e) => setForm({ ...form, successCriteria: e.target.value })}
                placeholder={t('goals.form.criteriaPlaceholder')}
                disabled={busyKey !== null}
              />
            </label>

            <div className="goal-form-grid">
              <label className="goal-field">
                <span>{t('goals.form.owner')}</span>
                <select
                  value={form.ownerBotId}
                  onChange={(e) => setForm({
                    ...form,
                    ownerBotId: e.target.value,
                    memberBotIds: form.memberBotIds.filter((id) => id !== e.target.value),
                  })}
                  disabled={busyKey !== null}
                >
                  {botEntries.map(([id, b]) => (
                    <option key={id} value={id}>{b.name}</option>
                  ))}
                </select>
              </label>

              {botEntries.length > 1 ? (
                <div className="goal-field">
                  <span>{t('goals.form.members')}</span>
                  <div className="goal-members-picker">
                    {botEntries
                      .filter(([id]) => id !== form.ownerBotId)
                      .map(([id, b]) => (
                        <label key={id} className="goal-member-check">
                          <input
                            type="checkbox"
                            checked={form.memberBotIds.includes(id)}
                            onChange={() => toggleFormMember(id)}
                            disabled={busyKey !== null}
                          />
                          <span>{b.name}</span>
                        </label>
                      ))}
                  </div>
                </div>
              ) : null}
            </div>

            {form.mode === 'create' ? (
              <label className="goal-field">
                <span>{t('goals.form.milestones')}</span>
                <textarea
                  rows={3}
                  value={form.milestonesText}
                  onChange={(e) => setForm({ ...form, milestonesText: e.target.value })}
                  placeholder={t('goals.form.milestonesPlaceholder')}
                  disabled={busyKey !== null}
                />
              </label>
            ) : null}

            <div className="goal-form-actions">
              <button type="button" className="vault-small-btn" onClick={() => setForm(null)} disabled={busyKey !== null}>
                {t('goals.form.cancel')}
              </button>
              <button type="submit" className="connector-connect-btn" disabled={busyKey !== null || !form.title.trim()}>
                {busyKey === 'goal:form' ? t('goals.form.saving') : t('goals.form.save')}
              </button>
            </div>
          </form>
        ) : null}

        {visibleGoals.length === 0 ? (
          <div className="feed-empty">{t('goals.empty')}</div>
        ) : (
          <div className="goals-list">
            {visibleGoals.map((goal) => {
              const owner = roster[goal.ownerBotId]
              const memberNames = goal.memberBotIds.map((id) => roster[id]?.name ?? id)
              const overdue = goal.status === 'active' && Boolean(goal.targetDate && goal.targetDate < today)
              const pct = goal.totalMilestones > 0 ? Math.round((goal.doneMilestones / goal.totalMilestones) * 100) : 0
              const isCheckinOpen = checkinOpenId === goal.id
              const participatingBotIds = [goal.ownerBotId, ...goal.memberBotIds]

              return (
                <article className={`feed-card goal-card status-${goal.status}`} key={goal.id}>
                  <div className="feed-card-meta">
                    <span className="feed-card-author">
                      <span className={`goal-status-badge ${goal.status}`}>
                        {t(`goals.status.${goal.status}` as MessageKey)}
                      </span>
                      <BotAvatar seed={goal.ownerBotId} emoji={owner?.emoji ?? '🤖'} size="sm" />
                      <span className="feed-author-name">{t('goals.ownerLabel', { name: owner?.name ?? goal.ownerBotId })}</span>
                      {memberNames.length > 0 ? (
                        <span className="feed-author-thread">· {t('goals.membersLabel', { names: memberNames.join(', ') })}</span>
                      ) : null}
                      {goal.origin === 'auto' ? <span className="vault-badge subtle">{t('goals.autoOrganized')}</span> : null}
                      {goal.sourceIdeaId ? <span className="vault-badge subtle">{t('goals.fromIdea')}</span> : null}
                    </span>
                    <span className="feed-card-right">
                      {goal.sourceThreadId ? (
                        <button type="button" className="vault-small-btn" onClick={() => onOpenThread(goal.sourceThreadId!)}>
                          {t('feed.openThread')}
                        </button>
                      ) : null}
                      {goal.targetDate ? (
                        <span className={`goal-date-badge${overdue ? ' overdue' : ''}`}>
                          {t('goals.targetDateLabel', { date: goal.targetDate })}
                          {overdue ? ` · ${t('goals.overdue')}` : ''}
                        </span>
                      ) : null}
                    </span>
                  </div>

                  <h3 className="goal-card-title">{goal.title}</h3>
                  {goal.description ? <p className="feed-card-summary">{goal.description}</p> : null}

                  {goal.successCriteria ? (
                    <div className="goal-criteria-box">
                      <strong>{t('goals.criteriaHeading')}:</strong> {goal.successCriteria}
                    </div>
                  ) : null}

                  {goal.spaces && goal.spaces.length > 0 ? (
                    <div className="goal-linked-spaces">
                      <span className="goal-muted-inline">{t('goals.spacesHeading')}:</span>
                      {goal.spaces.map((sp) => (
                        <button
                          key={sp.id}
                          type="button"
                          className="vault-small-btn"
                          onClick={() => onOpenSpace?.(sp.id)}
                        >
                          <span>{sp.icon}</span> {sp.title}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {goal.totalMilestones > 0 ? (
                    <div className="goal-progress">
                      <div className="goal-progress-bar" aria-hidden="true">
                        <div className="goal-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="goal-progress-text">
                        {t('goals.progressLabel', { done: goal.doneMilestones, total: goal.totalMilestones })}
                      </span>
                    </div>
                  ) : null}

                  <div className="feed-card-actions">
                    {goal.status === 'active' ? (
                      <button
                        type="button"
                        className="vault-small-btn primary"
                        disabled={busyKey !== null}
                        onClick={() => (isCheckinOpen ? setCheckinOpenId(null) : openCheckin(goal))}
                      >
                        {t('goals.checkin')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="vault-small-btn"
                      disabled={busyKey !== null}
                      onClick={() => openEditForm(goal)}
                    >
                      {t('goals.edit')}
                    </button>
                    {goal.status === 'active' ? (
                      <>
                        <button
                          type="button"
                          className="vault-small-btn"
                          disabled={busyKey !== null}
                          onClick={() => void runAction(`pause:${goal.id}`, async () => {
                            const res = await updateGoal(goal.id, { status: 'paused' })
                            onChange(res.snapshot)
                          })}
                        >
                          {t('goals.pause')}
                        </button>
                        <button
                          type="button"
                          className="vault-small-btn"
                          disabled={busyKey !== null}
                          onClick={() => void runAction(`done:${goal.id}`, async () => {
                            const res = await updateGoal(goal.id, { status: 'done' })
                            onChange(res.snapshot)
                          })}
                        >
                          {t('goals.markDone')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="vault-small-btn"
                        disabled={busyKey !== null}
                        onClick={() => void runAction(`resume:${goal.id}`, async () => {
                          const res = await updateGoal(goal.id, { status: 'active' })
                          onChange(res.snapshot)
                        })}
                      >
                        {t('goals.resume')}
                      </button>
                    )}
                    {goal.status !== 'archived' ? (
                      <button
                        type="button"
                        className="vault-small-btn"
                        disabled={busyKey !== null}
                        onClick={() => void runAction(`arch:${goal.id}`, async () => {
                          const res = await updateGoal(goal.id, { status: 'archived' })
                          onChange(res.snapshot)
                        })}
                      >
                        {t('goals.archive')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="vault-small-btn danger"
                      disabled={busyKey !== null}
                      onClick={() => setConfirmDelete(goal)}
                    >
                      {t('goals.delete')}
                    </button>
                  </div>

                  {isCheckinOpen ? (
                    <div className="feed-followup-box">
                      <select
                        className="feed-bot-select"
                        aria-label={t('goals.checkin')}
                        value={checkinBot}
                        onChange={(e) => setCheckinBot(e.target.value)}
                        disabled={busyKey !== null}
                      >
                        {participatingBotIds.map((id) => (
                          <option key={id} value={id}>{roster[id]?.name ?? id}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        className="feed-followup-input"
                        value={checkinNote}
                        onChange={(e) => setCheckinNote(e.target.value)}
                        placeholder={t('goals.checkinPlaceholder')}
                        disabled={busyKey !== null}
                      />
                      <button
                        type="button"
                        className="vault-small-btn primary"
                        disabled={busyKey !== null}
                        onClick={() => void submitCheckin(goal)}
                      >
                        {t('goals.checkinSend')}
                      </button>
                    </div>
                  ) : null}

                  <div className="goal-subsection">
                    <div className="goal-subsection-title">{t('goals.milestonesHeading')}</div>
                    {goal.milestones.length === 0 ? (
                      <div className="goal-muted">{t('goals.milestonesEmpty')}</div>
                    ) : (
                      <ul className="goal-milestones">
                        {goal.milestones.map((ms) => (
                          <li key={ms.id} className={`goal-milestone-row${ms.status === 'done' ? ' done' : ''}`}>
                            <label className="goal-milestone-label">
                              <input
                                type="checkbox"
                                checked={ms.status === 'done'}
                                disabled={busyKey !== null}
                                onChange={() => void runAction(`ms:${ms.id}`, async () => {
                                  const res = await updateGoalMilestone(goal.id, ms.id, {
                                    status: ms.status === 'done' ? 'open' : 'done',
                                  })
                                  onChange(res.snapshot)
                                })}
                              />
                              <span className="goal-milestone-text">{ms.title}</span>
                            </label>
                            <span className="goal-milestone-meta">
                              {ms.ownerBotId ? <span>@{roster[ms.ownerBotId]?.name ?? ms.ownerBotId}</span> : null}
                              {ms.dueDate ? <span>{ms.dueDate}</span> : null}
                              <button
                                type="button"
                                className="goal-icon-btn"
                                aria-label={t('goals.milestoneRemove')}
                                title={t('goals.milestoneRemove')}
                                disabled={busyKey !== null}
                                onClick={() => void runAction(`ms-del:${ms.id}`, async () => {
                                  const res = await deleteGoalMilestone(goal.id, ms.id)
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
                    <form className="goal-inline-form" onSubmit={(e) => void submitMilestone(e, goal.id)}>
                      <input
                        type="text"
                        value={newMilestone[goal.id] ?? ''}
                        onChange={(e) => setNewMilestone((prev) => ({ ...prev, [goal.id]: e.target.value }))}
                        placeholder={t('goals.milestonePlaceholder')}
                        disabled={busyKey !== null}
                      />
                      <button
                        type="submit"
                        className="vault-small-btn"
                        disabled={busyKey !== null || !(newMilestone[goal.id] ?? '').trim()}
                      >
                        {t('goals.milestoneAdd')}
                      </button>
                    </form>
                  </div>

                  <div className="goal-subsection">
                    <div className="goal-subsection-head">
                      <span className="goal-subsection-title">{t('goals.routinesHeading')}</span>
                      <span className="goal-muted-inline">{t('goals.routinesPauseHint')}</span>
                    </div>
                    {goal.routines.length === 0 ? (
                      <div className="goal-muted">{t('goals.routinesEmpty')}</div>
                    ) : (
                      <ul className="goal-routines">
                        {goal.routines.map((r) => (
                          <li key={r.id} className="goal-routine-row">
                            <span className="goal-routine-info">
                              <strong>{r.name}</strong>
                              <span className="goal-muted-inline">
                                @{roster[r.botId]?.name ?? r.botId} · {r.human}{r.mode === 'watch' ? ' · watch' : ''}{r.enabled ? '' : ` · ${t('goals.status.paused')}`}
                              </span>
                            </span>
                            <span className="goal-routine-actions">
                              <button
                                type="button"
                                className="vault-small-btn"
                                disabled={busyKey !== null}
                                onClick={() => void actOnRoutine(r.id, 'run')}
                              >
                                {t('goals.routineRunNow')}
                              </button>
                              <button
                                type="button"
                                className="vault-small-btn"
                                disabled={busyKey !== null}
                                onClick={() => void actOnRoutine(r.id, r.enabled ? 'pause' : 'resume')}
                              >
                                {t(r.enabled ? 'goals.routinePause' : 'goals.routineResume')}
                              </button>
                              <button
                                type="button"
                                className="vault-small-btn"
                                disabled={busyKey !== null}
                                onClick={() => void actOnRoutine(r.id, 'unlink')}
                              >
                                {t('goals.routineUnlink')}
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {state.unlinkedRoutines.length > 0 ? (
                      <div className="goal-inline-form">
                        <select
                          aria-label={t('goals.routineLinkPlaceholder')}
                          value={linkRoutinePick[goal.id] ?? ''}
                          onChange={(e) => setLinkRoutinePick((prev) => ({ ...prev, [goal.id]: e.target.value }))}
                          disabled={busyKey !== null}
                        >
                          <option value="">{t('goals.routineLinkPlaceholder')}</option>
                          {state.unlinkedRoutines.map((r) => (
                            <option key={r.id} value={String(r.id)}>
                              {r.name} (@{roster[r.botId]?.name ?? r.botId})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="vault-small-btn"
                          disabled={busyKey !== null || !linkRoutinePick[goal.id]}
                          onClick={() => void linkRoutine(goal.id)}
                        >
                          {t('goals.routineLinkBtn')}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className="goal-subsection">
                    <div className="goal-subsection-title">{t('goals.updatesHeading')}</div>
                    <form className="goal-inline-form" onSubmit={(e) => void submitNote(e, goal.id)}>
                      <input
                        type="text"
                        value={newUpdate[goal.id] ?? ''}
                        onChange={(e) => setNewUpdate((prev) => ({ ...prev, [goal.id]: e.target.value }))}
                        placeholder={t('goals.updatePlaceholder')}
                        disabled={busyKey !== null}
                      />
                      <button
                        type="submit"
                        className="vault-small-btn"
                        disabled={busyKey !== null || !(newUpdate[goal.id] ?? '').trim()}
                      >
                        {t('goals.updateAdd')}
                      </button>
                    </form>
                    {goal.recentUpdates.length === 0 ? (
                      <div className="goal-muted">{t('goals.updatesEmpty')}</div>
                    ) : (
                      <ul className="goal-updates">
                        {goal.recentUpdates.slice(0, 6).map((u) => (
                          <li key={u.id} className="goal-update-row">
                            <span className="goal-update-author">
                              {u.authorKind === 'operator'
                                ? t('goals.updateByOperator')
                                : (u.botId ? (roster[u.botId]?.name ?? u.botId) : 'Bot')}
                            </span>
                            {u.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}
                            <span className="goal-update-summary">{u.summary}</span>
                            <span className="feed-time">{formatTime(u.createdAt, t)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {goal.recentActions.length > 0 ? (
                    <details className="goal-actions-details">
                      <summary>{t('goals.actionsHeading', { count: goal.recentActions.length })}</summary>
                      <ul className="goal-updates">
                        {goal.recentActions.map((a) => (
                          <li key={a.id} className="goal-update-row">
                            <span className="goal-update-author">{roster[a.botId]?.name ?? a.botId}</span>
                            <code className="goal-action-tool">{a.tool}</code>
                            <span className="goal-update-summary">{a.summary}</span>
                            <span className="feed-time">{formatTime(a.createdAt, t)}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </article>
              )
            })}
          </div>
        )}
    </>
  )

  const deleteDialog = confirmDelete ? (
    <ConfirmDialog
      message={t('goals.deleteConfirm', { title: confirmDelete.title })}
      confirmLabel={t('confirm.delete')}
      cancelLabel={t('confirm.cancel')}
      onConfirm={() => {
        const target = confirmDelete
        setConfirmDelete(null)
        void runAction(`del:${target.id}`, async () => {
          const res = await deleteGoal(target.id)
          onChange(res.snapshot)
        })
      }}
      onCancel={() => setConfirmDelete(null)}
    />
  ) : null

  if (embedded) {
    return (
      <section className="goals-embedded" aria-label={t('goals.title')}>
        {bodyContent}
        {deleteDialog}
      </section>
    )
  }

  return (
    <main className="thread feed-view goals-view">
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
          <TargetIcon size={16} />
          <span>{t('goals.title')}</span>
        </div>
        {statusControls}
        <span className="spacer" />
        {newButton}
      </header>

      <div className="feed-body">{bodyContent}</div>
      {deleteDialog}
    </main>
  )
}
