import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError, SignedOut, answerQuestion, cancelBackgroundTask, cancelDispatchPlan, checkSession, connectEvents, createBot, fetchBackgroundTasks, fetchBots, fetchComputer, fetchConnections, fetchConnectors, fetchConversations,
  fetchMcpServers, fetchMessages, fetchProviders, fetchSetup, fetchUiPrefs, forgetMemoryRule, removeUpload, resolveApproval, resolveRuleProposal, revokeRule, saveSettings, sendMessage, setBotConnectors, setBotMcpServers,
  setComputerShell, setComputerWindow, startDispatchPlan, steerBackgroundTask, stopThread, updateRoutine, uploadFile,
} from './api'
import { BotModelChip, BotModelPicker, botModel, botSeesImages } from './components/BotModelPicker'
import { ConfirmDialog, useEscape } from './components/ConfirmDialog'
import { ConnectorsDialog } from './components/ConnectorsDialog'
import { DemoBanner } from './components/DemoBanner'
import { ComputerPanel } from './components/ComputerPanel'
import { BookOpenIcon, SidebarIcon, XIcon } from './components/Icons'
import { ModelsDialog } from './components/ModelsDialog'
import { NewBotForm } from './components/NewBotForm'
import { SettingsDialog } from './components/SettingsDialog'
import { SetupWizard, type LanguageSetting } from './components/SetupWizard'
import { Sidebar } from './components/Sidebar'
import { TeamCharterDialog } from './components/TeamCharterDialog'
import { Thread } from './components/Thread'
import { WikiDialog } from './components/WikiDialog'
import { desktopApi } from './desktop'
import { I18nProvider, browserLanguages, pickLang, useT, type Lang } from './i18n'
import { errorText } from './i18n/describe'
import { applyHello, applyStatus, clearDone } from './presence'
import { applyTheme, hasStoredTheme, readStoredTheme, resolveTheme, systemTheme, writeStoredTheme } from './theme'
import type {
  BackgroundTaskPayload, BackgroundTaskView, BotStatus, BrowserStatus, ComputerInfo, ConnectionsState, ConnectorsSnapshot, Conversation, DispatchPlanPayload, DispatchPlanView, McpServersSnapshot, Message, ProviderPreset, ResolvedTheme, RoutineAction, RuleProposalPayload, SetupInfo, ThemeSetting,
} from './types'

const EMPTY_CONNECTORS: ConnectorsSnapshot = {
  key: { set: false, masked: '', source: 'none', locked: false },
  catalog: [],
  accounts: [],
  botGrants: {},
}

const isActiveBgTask = (task: BackgroundTaskView): boolean =>
  task.status === 'queued' || task.status === 'running'

function upsertBackgroundTaskList(list: BackgroundTaskView[] | undefined, task: BackgroundTaskView): BackgroundTaskView[] {
  const next = (list ?? []).filter((item) => item.id !== task.id)
  next.push(task)
  next.sort((a, b) => {
    const aActive = isActiveBgTask(a) ? 0 : 1
    const bActive = isActiveBgTask(b) ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    return b.createdAt - a.createdAt
  })
  return next.slice(0, 20)
}

function overlayLiveBackgroundTasks(
  fetched: BackgroundTaskView[],
  live: ReadonlyMap<string, BackgroundTaskView>,
): BackgroundTaskView[] {
  if (live.size === 0) return fetched
  let merged = fetched
  for (const task of live.values()) {
    merged = upsertBackgroundTaskList(merged, task)
  }
  return merged
}

function bgTaskViewToPayload(task: BackgroundTaskView): BackgroundTaskPayload {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    stepCount: task.stepCount,
    lastStep: task.lastStep,
    steps: task.steps,
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.error ? { error: task.error } : {}),
    usesBrowser: task.usesBrowser,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  }
}

function planToPayload(plan: DispatchPlanView): DispatchPlanPayload {
  return {
    planId: plan.id,
    threadId: plan.threadId,
    createdBy: plan.createdBy,
    title: plan.title,
    status: plan.status,
    sourceTainted: plan.sourceTainted,
    error: plan.error,
    steps: plan.steps,
    createdAt: plan.createdAt,
    startedAt: plan.startedAt,
    finishedAt: plan.finishedAt,
  }
}

/** 网关锁着：告诉人去哪拿登录链接，而不是一片空白。 */
function SignIn() {
  const t = useT()
  return (
    <main className="signin">
      <div className="signin-card">
        <div className="signin-title">{t('signin.title')}</div>
        <p>{withCode(t('signin.body'), 'link', `${location.origin}/auth?token=…`)}</p>
        <p className="signin-hint">{withCode(t('signin.hint'), 'path', 'gateway/data/auth-token')}</p>
      </div>
    </main>
  )
}

/** 句子里有一段要排成代码：按占位切开，代码段放进 <code>，语序由译文决定 */
function withCode(text: string, name: string, code: string) {
  const [before, after = ''] = text.split(`{${name}}`)
  return <>{before}<code>{code}</code>{after}</>
}

/**
 * 语言 = 设置里存的 → 否则跟浏览器。先按浏览器出一版（不等网络），设置拿回来再换；
 * 锁着的网关拿不到设置，登录页就按浏览器的语言。
 */
export default function App() {
  /** 设置里存的语言（空 = 跟系统）和主题（默认深色，支持浅色/跟随系统） */
  const [setting, setSetting] = useState<LanguageSetting>('')
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(readStoredTheme)
  const [sysTheme, setSysTheme] = useState<ResolvedTheme>(systemTheme)
  const lang: Lang = useMemo(() => pickLang(setting, browserLanguages()), [setting])
  const resolvedTheme: ResolvedTheme = useMemo(() => resolveTheme(themeSetting, sysTheme), [themeSetting, sysTheme])

  const changeTheme = useCallback((next: ThemeSetting) => {
    setThemeSetting(next)
    writeStoredTheme(next)
  }, [])

  useEffect(() => {
    let live = true
    void fetchUiPrefs().then(({ language, theme, themeSaved }) => {
      if (!live) return
      if (language === '' || language === 'en' || language === 'zh-CN') setSetting(language)
      if (theme && (themeSaved || !hasStoredTheme())) {
        setThemeSetting(theme)
        writeStoredTheme(theme)
      }
    })
    return () => { live = false }
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSysTheme(media.matches ? 'light' : 'dark')
    onChange()
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])
  useEffect(() => {
    const api = desktopApi()
    if (!api) return
    void Promise.resolve(api.info()).then((d) => {
      if (d?.platform === 'darwin') document.documentElement.dataset.desktop = 'darwin'
    }).catch(() => {})
  }, [])
  useLayoutEffect(() => { applyTheme(resolvedTheme) }, [resolvedTheme])
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  return (
    <I18nProvider lang={lang}>
      <Workspace language={setting} onLanguage={setSetting} theme={themeSetting} resolvedTheme={resolvedTheme} onTheme={changeTheme} />
    </I18nProvider>
  )
}

function Workspace({
  language,
  onLanguage,
  theme,
  resolvedTheme,
  onTheme,
}: {
  language: LanguageSetting
  onLanguage: (next: LanguageSetting) => void
  theme: ThemeSetting
  resolvedTheme: ResolvedTheme
  onTheme: (next: ThemeSetting) => void
}) {
  const t = useT()
  const [signedOut, setSignedOut] = useState<boolean | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [roster, setRoster] = useState<Record<string, { name: string; emoji: string }>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [statuses, setStatuses] = useState<Record<string, BotStatus>>({})
  const [bgTasksByBot, setBgTasksByBot] = useState<Record<string, BackgroundTaskView[]>>({})
  /** 电脑面板开给谁；info 为 null 表示那台电脑还在醒 */
  const [panel, setPanel] = useState<{ botId: string; info: ComputerInfo | null } | null>(null)
  const [hiring, setHiring] = useState(false)
  const [hireError, setHireError] = useState<string | undefined>()
  /** 模型连接和每位同事的选择；老网关没有这块就一直是 null */
  const [llms, setLlms] = useState<ConnectionsState | null>(null)
  const [providers, setProviders] = useState<ProviderPreset[]>([])
  /** 外部应用连接器快照；老网关没有这块就一直是 null */
  const [connectors, setConnectors] = useState<ConnectorsSnapshot | null>(null)
  /** MCP 服务快照；老网关没有这块就一直是 null */
  const [mcpServers, setMcpServers] = useState<McpServersSnapshot | null>(null)
  /** 开着的是哪个窗口：「AI 模型」总表、「连接器」总表、「团队知识库」，或给某位同事选模型 */
  const [modelsOpen, setModelsOpen] = useState(false)
  const [connectorsOpen, setConnectorsOpen] = useState(false)
  const [wikiOpen, setWikiOpen] = useState(false)
  const [wikiRefreshTick, setWikiRefreshTick] = useState(0)
  const [quietDigestTick, setQuietDigestTick] = useState(0)
  const [charterOpen, setCharterOpen] = useState(false)
  const [teamCharterTick, setTeamCharterTick] = useState(0)
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  /** 首次启动向导：网关说要（needsSetup）才出；走完之前一直开着，哪怕中途已经存好了 key */
  const [setup, setSetup] = useState<SetupInfo | null>(null)
  const [wizard, setWizard] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [setupBrowser, setSetupBrowser] = useState<BrowserStatus | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; confirmLabel: string; run: () => void } | null>(null)
  useEscape(hiring ? () => setHiring(false) : undefined)

  // #thread=<id>：打开就是那条对话。桌面版点系统通知、别人发来的链接都走这个
  useEffect(() => {
    const apply = () => {
      const m = /^#thread=(.+)$/.exec(window.location.hash)
      if (!m) return
      try {
        setSelectedId(decodeURIComponent(m[1]!))
      } catch { /* 坏掉的百分号编码不炸页面 */ }
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  const selected = useMemo(
    // 选中的对话不存在（链接点名了一条删掉的对话、同事被移走）：显示第一条，别停在空白页。
    // 在这里算而不是事后改 selectedId：链接变化和列表刷新谁先谁后、被不被合并成一次渲染，结果都一样
    () => conversations.find((c) => c.id === selectedId) ?? conversations[0] ?? null,
    [conversations, selectedId],
  )
  const threadId = selected?.id ?? null
  const threadIdRef = useRef<string | null>(null)
  threadIdRef.current = threadId
  const selectedDmBotId = selected?.kind === 'dm' ? (selected.members[0] ?? null) : null
  const selectedDmBotIdRef = useRef<string | null>(null)
  selectedDmBotIdRef.current = selectedDmBotId
  // 正看着的单聊里有谁：他们干完了你自己看得见，不用再标「done」；点开单聊的那一刻把已有的「done」消掉（打开群聊不清个人单聊的 done）
  const watchingRef = useRef<string[]>([])
  /** 这一轮忙碌里真往线程说过话的同事：只有它们收工时才标「done」 */
  const postedRef = useRef(new Set<string>())
  const watchedDm = selected?.kind === 'dm' ? selected.members.join(',') : ''
  useEffect(() => {
    const ids = watchedDm ? watchedDm.split(',') : []
    watchingRef.current = ids
    if (ids.length) setStatuses((s) => clearDone(s, ids))
  }, [watchedDm])
  // 面板此刻属于谁，同步记在 ref 里：拉起电脑要十几秒，结果回来时人可能早换了线程或关了面板
  const panelFor = useRef<string | null>(null)
  const showPanel = useCallback((next: { botId: string; info: ComputerInfo | null } | null) => {
    panelFor.current = next?.botId ?? null
    setPanel(next)
  }, [])
  // 面板属于某一位同事、团队章程属于某个群聊：换了线程就收起
  useEffect(() => {
    showPanel(null)
    setCharterOpen(false)
  }, [selected?.id, showPanel])

  /** 拉消息期间经 WS 到达的更新先记下来，拉回来后叠在快照上；重叠拉取按序号只认最新那次，绝不让慢快照抹掉刚收到的实时消息 */
  const liveDuringFetch = useRef(new Map<number, Message>())
  const inFlightFetches = useRef(0)
  const msgFetchSeq = useRef(0)
  const loadMessages = useCallback(async (thread: string) => {
    const seq = ++msgFetchSeq.current
    inFlightFetches.current += 1
    try {
      const fetched = await fetchMessages(thread)
      if (seq !== msgFetchSeq.current || threadIdRef.current !== thread) return
      const liveInThread = new Map<number, Message>()
      for (const [id, m] of liveDuringFetch.current) {
        if (m.thread_id === thread) liveInThread.set(id, m)
      }
      setMessages((prev) => {
        const merged = fetched.map((m) => liveInThread.get(m.id) ?? m)
        const known = new Set(merged.map((m) => m.id))
        const maxFetchedId = fetched.reduce((mx, m) => Math.max(mx, m.id), 0)
        for (const m of liveInThread.values()) {
          if (!known.has(m.id)) {
            merged.push(m)
            known.add(m.id)
          }
        }
        for (const m of prev) {
          if (m.thread_id === thread && !known.has(m.id) && m.id > maxFetchedId) {
            merged.push(m)
            known.add(m.id)
          }
        }
        return merged.sort((a, b) => a.id - b.id)
      })
    } finally {
      inFlightFetches.current -= 1
      if (inFlightFetches.current <= 0) {
        inFlightFetches.current = 0
        liveDuringFetch.current.clear()
      }
    }
  }, [])

  const guard = useCallback((err: unknown) => {
    if (err instanceof SignedOut) setSignedOut(true)
    else console.error(err)
  }, [])

  const refreshConversations = useCallback(async () => {
    const cs = await fetchConversations()
    setConversations(cs)
    setSelectedId((id) => id ?? cs[0]?.id ?? null)
  }, [])

  const loadRoster = useCallback(async () => {
    const bs = await fetchBots()
    // 群里要按 id 显示说话人，所以单独拉一份名册
    setRoster(Object.fromEntries(bs.map((b) => [b.id, { name: b.name, emoji: b.emoji }])))
  }, [])

  /** 模型连接是锦上添花：拿不到（老网关、网络抖）不影响别的，界面上那一块不显示就是了 */
  const loadLlms = useCallback(async () => {
    try {
      const [state, presets] = await Promise.all([fetchConnections(), fetchProviders()])
      setLlms(state)
      setProviders(presets)
    } catch (err) {
      if (err instanceof SignedOut) throw err
    }
  }, [])

  /** 外部应用连接器快照；老网关没有这个路由就返回 null，界面上不显示这一块 */
  const loadConnectors = useCallback(async () => {
    try {
      setConnectors(await fetchConnectors())
    } catch (err) {
      if (err instanceof SignedOut) throw err
    }
  }, [])

  /** MCP 服务快照；老网关没有这个路由就返回 null，界面上不显示这一块 */
  const loadMcpServers = useCallback(async () => {
    try {
      setMcpServers(await fetchMcpServers())
    } catch (err) {
      if (err instanceof SignedOut) throw err
    }
  }, [])

  /** 拉取后台任务或电脑面板期间经 WS/200 到达的更新先记下来，回来后叠在快照上；重叠拉取按序号只认最新一次 */
  const bgFetchSeqRef = useRef(new Map<string, number>())
  const panelFetchSeqRef = useRef(new Map<string, number>())
  const bgInFlightRef = useRef(new Map<string, number>())
  const liveBgDuringFetchRef = useRef(new Map<string, Map<string, BackgroundTaskView>>())

  /** 某位同事的后台任务列表；老网关没有这个路由时静默忽略 */
  const loadBackgroundTasks = useCallback(async (botId: string) => {
    const seq = (bgFetchSeqRef.current.get(botId) ?? 0) + 1
    bgFetchSeqRef.current.set(botId, seq)
    bgInFlightRef.current.set(botId, (bgInFlightRef.current.get(botId) ?? 0) + 1)
    try {
      const res = await fetchBackgroundTasks(botId)
      if (bgFetchSeqRef.current.get(botId) !== seq) return
      const liveSnapshot = new Map(liveBgDuringFetchRef.current.get(botId) ?? [])
      const merged = overlayLiveBackgroundTasks(res.tasks, liveSnapshot)
      setBgTasksByBot((prev) => ({ ...prev, [botId]: merged }))
      if (panelFor.current === botId) {
        setPanel((curr) => (
          curr && curr.botId === botId && curr.info
            ? { ...curr, info: { ...curr.info, backgroundTasks: merged } }
            : curr
        ))
      }
    } catch (err) {
      if (err instanceof SignedOut) setSignedOut(true)
    } finally {
      const remaining = (bgInFlightRef.current.get(botId) ?? 1) - 1
      if (remaining <= 0) {
        bgInFlightRef.current.delete(botId)
        liveBgDuringFetchRef.current.delete(botId)
      } else {
        bgInFlightRef.current.set(botId, remaining)
      }
    }
  }, [])

  const applyBackgroundTaskUpdate = useCallback((
    botId: string,
    task: BackgroundTaskView,
    opts?: { patchMessage?: boolean },
  ) => {
    if ((bgInFlightRef.current.get(botId) ?? 0) > 0) {
      let botLive = liveBgDuringFetchRef.current.get(botId)
      if (!botLive) {
        botLive = new Map<string, BackgroundTaskView>()
        liveBgDuringFetchRef.current.set(botId, botLive)
      }
      botLive.set(task.id, task)
    }
    setBgTasksByBot((prev) => ({
      ...prev,
      [botId]: upsertBackgroundTaskList(prev[botId], task),
    }))
    if (panelFor.current === botId) {
      setPanel((curr) => (
        curr && curr.botId === botId && curr.info
          ? { ...curr, info: { ...curr.info, backgroundTasks: upsertBackgroundTaskList(curr.info.backgroundTasks, task) } }
          : curr
      ))
    }
    if (opts?.patchMessage) {
      const nextPayload = bgTaskViewToPayload(task)
      setMessages((ms) => {
        let changed = false
        const next = ms.map((m) => {
          if (m.kind !== 'background_task') return m
          const payload = m.payload as BackgroundTaskPayload | null
          const matchesId = task.messageId !== null && m.id === task.messageId
          const matchesTask = payload?.taskId === task.id
          if (!matchesId && !matchesTask) return m
          changed = true
          const updated: Message = { ...m, payload: nextPayload }
          if (inFlightFetches.current > 0) liveDuringFetch.current.set(updated.id, updated)
          return updated
        })
        return changed ? next : ms
      })
    }
  }, [])

  const applyDispatchPlanUpdate = useCallback((plan: DispatchPlanView) => {
    const nextPayload = planToPayload(plan)
    if (inFlightFetches.current > 0) {
      for (const [id, m] of liveDuringFetch.current) {
        if (m.kind !== 'dispatch_plan' || m.thread_id !== plan.threadId) continue
        const payload = m.payload as DispatchPlanPayload | null
        const matchesId = plan.messageId !== null && m.id === plan.messageId
        const matchesPlan = payload?.planId === plan.id
        if (matchesId || matchesPlan) {
          liveDuringFetch.current.set(id, { ...m, payload: nextPayload })
        }
      }
    }
    setMessages((ms) => {
      let changed = false
      const next = ms.map((m) => {
        if (m.kind !== 'dispatch_plan' || m.thread_id !== plan.threadId) return m
        const payload = m.payload as DispatchPlanPayload | null
        const matchesId = plan.messageId !== null && m.id === plan.messageId
        const matchesPlan = payload?.planId === plan.id
        if (!matchesId && !matchesPlan) return m
        changed = true
        const updated: Message = { ...m, payload: nextPayload }
        if (inFlightFetches.current > 0) liveDuringFetch.current.set(updated.id, updated)
        return updated
      })
      return changed ? next : ms
    })
  }, [])

  /** 首次加载和每次重连都走这里：断线期间错过的消息、审批数、名册一次补齐。 */
  const resync = useCallback(async () => {
    try {
      await Promise.all([refreshConversations(), loadRoster(), loadLlms(), loadConnectors(), loadMcpServers()])
      const current = threadIdRef.current
      if (current) await loadMessages(current)
      const currentBot = selectedDmBotIdRef.current
      if (currentBot) void loadBackgroundTasks(currentBot)
    } catch (err) {
      guard(err)
    }
  }, [guard, loadBackgroundTasks, loadConnectors, loadLlms, loadMcpServers, loadMessages, loadRoster, refreshConversations])

  useEffect(() => {
    checkSession()
      .then((ok) => {
        setSignedOut(!ok)
        if (!ok) return
        void resync()
        // 拿不到（老网关、网关出错）就不出向导：向导是锦上添花，不能把界面挡住
        void fetchSetup().then((s) => {
          setSetup(s)
          if (s?.needsSetup) setWizard(true)
        }).catch(() => {})
      })
      .catch(() => setSignedOut(false)) // 网关没起来：先显示空界面，WS 重连上以后会补拉
  }, [resync])

  useEffect(() => {
    if (!threadId) return
    setMessages([])
    loadMessages(threadId).catch(guard)
  }, [threadId, guard, loadMessages])

  useEffect(() => {
    if (signedOut !== false || !selectedDmBotId) return
    void loadBackgroundTasks(selectedDmBotId)
  }, [signedOut, selectedDmBotId, loadBackgroundTasks])

  const signOut = useCallback(() => setSignedOut(true), [])

  /** 拉一次面板数据；只在面板还开给同一位同事、且未被更新的请求顶掉时才放进去 */
  const loadPanel = useCallback(async (botId: string) => {
    const seq = (panelFetchSeqRef.current.get(botId) ?? 0) + 1
    panelFetchSeqRef.current.set(botId, seq)
    bgInFlightRef.current.set(botId, (bgInFlightRef.current.get(botId) ?? 0) + 1)
    try {
      const info = await fetchComputer(botId)
      if (panelFetchSeqRef.current.get(botId) !== seq) return
      const liveSnapshot = new Map(liveBgDuringFetchRef.current.get(botId) ?? [])
      const mergedTasks = Array.isArray(info.backgroundTasks)
        ? overlayLiveBackgroundTasks(info.backgroundTasks, liveSnapshot)
        : undefined
      const mergedInfo: ComputerInfo = mergedTasks !== undefined
        ? { ...info, backgroundTasks: mergedTasks }
        : info
      if (mergedTasks !== undefined) {
        setBgTasksByBot((prev) => ({ ...prev, [botId]: mergedTasks }))
      }
      if (panelFor.current === botId) showPanel({ botId, info: mergedInfo })
    } catch (err) {
      if (panelFetchSeqRef.current.get(botId) === seq && panelFor.current === botId) showPanel(null)
      guard(err)
    } finally {
      const remaining = (bgInFlightRef.current.get(botId) ?? 1) - 1
      if (remaining <= 0) {
        bgInFlightRef.current.delete(botId)
        liveBgDuringFetchRef.current.delete(botId)
      } else {
        bgInFlightRef.current.set(botId, remaining)
      }
    }
  }, [guard, showPanel])

  useEffect(() => {
    if (signedOut !== false) return
    return connectEvents((e) => {
      if (e.type === 'hello') {
        setStatuses((s) => applyHello(s, e.statuses))
        void resync()
        if (panelFor.current) void loadPanel(panelFor.current)
        setWikiRefreshTick((n) => n + 1)
        setQuietDigestTick((n) => n + 1)
        setTeamCharterTick((n) => n + 1)
        return
      }
      if (e.type === 'status') {
        if (e.state === 'thinking') postedRef.current.delete(e.botId)
        const posted = postedRef.current.has(e.botId)
        if (e.state !== 'thinking') postedRef.current.delete(e.botId)
        setStatuses((s) => applyStatus(s, e.botId, e.state, watchingRef.current.includes(e.botId), posted))
        if (e.state !== 'thinking' && panelFor.current === e.botId) void loadPanel(e.botId)
        return
      }
      if (e.type === 'setup.browser') {
        setSetupBrowser(e.browser)
        return
      }
      if (e.type === 'connectors_changed') {
        void loadConnectors().catch(guard)
        if (panelFor.current) void loadPanel(panelFor.current)
        return
      }
      if (e.type === 'mcp_changed') {
        void loadMcpServers().catch(guard)
        if (panelFor.current) void loadPanel(panelFor.current)
        return
      }
      if (e.type === 'wiki_changed') {
        setWikiRefreshTick((n) => n + 1)
        return
      }
      if (e.type === 'quiet_digest_changed') {
        setQuietDigestTick((n) => n + 1)
        return
      }
      if (e.type === 'background_task_changed') {
        applyBackgroundTaskUpdate(e.botId, e.task, { patchMessage: true })
        return
      }
      if (e.type === 'team_charter_changed') {
        if (e.threadId === threadIdRef.current) setTeamCharterTick((n) => n + 1)
        return
      }
      if (e.type === 'dispatch_plan_changed') {
        applyDispatchPlanUpdate(e.plan)
        if (panelFor.current && (e.plan.status === 'completed' || e.plan.status === 'failed' || e.plan.status === 'cancelled')) {
          void loadPanel(panelFor.current)
        }
        return
      }
      if (e.type !== 'message') return // 更新的网关发来不认识的事件，不归这里管
      if (e.message.sender !== 'user' && e.message.kind !== 'activity') postedRef.current.add(e.message.sender)
      // 就地更新的旧消息（activity 卡片收尾、审批 chip 翻转）不该顶掉更新的那条预览；没变就不换数组引用
      setConversations((cs) => {
        const idx = cs.findIndex((c) => c.id === e.threadId)
        if (idx === -1 || e.message.id < (cs[idx]!.last_message?.id ?? 0)) return cs
        const next = [...cs]
        next[idx] = { ...cs[idx]!, last_message: e.message }
        return next
      })
      // 审批、问题来了或定了，侧栏的「等你」计数要跟着变
      if (['approval_request', 'approval_resolved', 'question'].includes(e.message.kind)) {
        void refreshConversations().catch(guard)
      }
      // 面板开着时，记忆规则变动、规矩提议、晨报汇总、放行规则落地或后台任务/流水线结束都实时刷新（步骤更新由事件就地修补，避免频繁拉 /computer）
      if (panelFor.current) {
        const settledBg = e.message.kind === 'background_task' && (() => {
          const st = (e.message.payload as BackgroundTaskPayload | null)?.status
          return st === 'completed' || st === 'failed' || st === 'cancelled'
        })()
        const settledDispatch = e.message.kind === 'dispatch_plan' && (() => {
          const st = (e.message.payload as DispatchPlanPayload | null)?.status
          return st === 'completed' || st === 'failed' || st === 'cancelled'
        })()
        if (settledBg || settledDispatch || ['memory_updated', 'approval_resolved', 'activity', 'rule_proposal', 'quiet_digest'].includes(e.message.kind)) {
          void loadPanel(panelFor.current)
        }
      }
      if (e.threadId === threadIdRef.current) {
        if (inFlightFetches.current > 0) liveDuringFetch.current.set(e.message.id, e.message)
        // 同 id 就替换：审批 chip 被放行、activity 卡片多了一步，都是就地更新
        setMessages((ms) => {
          const at = ms.findIndex((m) => m.id === e.message.id)
          if (at === -1) return [...ms, e.message]
          const next = [...ms]
          next[at] = e.message
          return next
        })
      }
    }, { onSignedOut: signOut })
  }, [signedOut, resync, refreshConversations, loadConnectors, loadMcpServers, loadPanel, applyBackgroundTaskUpdate, applyDispatchPlanUpdate, guard, signOut])

  const waiting = conversations.reduce((sum, c) => sum + (c.pending ?? 0), 0)
  useEffect(() => {
    document.title = waiting ? `(${waiting}) OpenSuperBot` : 'OpenSuperBot'
  }, [waiting])

  const openScreen = () => {
    if (!selected || selected.kind !== 'dm') return
    const botId = selected.members[0]
    if (!botId) return
    if (panel?.botId === botId && !panel.info) return // 已经在等它醒了
    // 已经开着就原地刷新，不闪回加载态；没开就先把面板亮出来
    showPanel({ botId, info: panel?.botId === botId ? panel.info : null })
    void loadPanel(botId)
  }

  const toggleScreen = () => {
    if (!selected || selected.kind !== 'dm') return
    const botId = selected.members[0]
    if (!botId) return
    if (panel?.botId === botId) {
      showPanel(null)
      return
    }
    openScreen()
  }

  const runRoutine = async (id: number, action: RoutineAction) => {
    try {
      await updateRoutine(id, action)
      if (panel) await loadPanel(panel.botId)
    } catch (err) {
      guard(err)
    }
  }

  const onRoutine = (id: number, action: RoutineAction) => {
    if (action === 'delete') {
      setConfirmDialog({
        message: t('app.confirmDeleteRoutine'),
        confirmLabel: t('confirm.delete'),
        run: () => { void runRoutine(id, action) },
      })
      return
    }
    void runRoutine(id, action)
  }

  const onRevokeRule = async (id: number) => {
    try {
      await revokeRule(id)
      if (panel) await loadPanel(panel.botId)
    } catch (err) {
      guard(err)
    }
  }

  const onResolveRuleProposal = useCallback(
    async (proposalId: number, decision: 'accept' | 'dismiss', rule?: string) => {
      try {
        const res = await resolveRuleProposal(proposalId, decision, rule)
        setMessages((ms) => {
          let changed = false
          const next = ms.map((m) => {
            if (m.kind !== 'rule_proposal') return m
            const payload = m.payload as RuleProposalPayload | null
            if (!payload || payload.proposalId !== proposalId || payload.status !== 'pending') return m
            changed = true
            const originalRule = payload.rule
            const updated: Message = {
              ...m,
              payload: {
                ...payload,
                status: res.proposal.status,
                rule: res.proposal.rule,
                edited: res.proposal.status === 'accepted' && res.proposal.rule !== originalRule,
                resolvedAt: res.proposal.resolvedAt ?? Date.now(),
              },
            }
            if (inFlightFetches.current > 0) liveDuringFetch.current.set(updated.id, updated)
            return updated
          })
          return changed ? next : ms
        })
      } catch (err: unknown) {
        if (err instanceof SignedOut) {
          setSignedOut(true)
          return
        }
        if (err instanceof ApiError && err.status === 409) {
          const current = threadIdRef.current
          if (current) void loadMessages(current).catch(guard)
          else void resync()
          throw err
        }
        guard(err)
        throw err
      }
    },
    [guard, loadMessages, resync],
  )

  const onSteerBackgroundTask = useCallback(
    async (taskId: string, note: string) => {
      try {
        const res = await steerBackgroundTask(taskId, note)
        applyBackgroundTaskUpdate(res.task.botId, res.task, { patchMessage: true })
      } catch (err: unknown) {
        if (err instanceof SignedOut) {
          setSignedOut(true)
          return
        }
        if (err instanceof ApiError && err.status === 409) {
          const currentThread = threadIdRef.current
          const currentBot = panelFor.current ?? selectedDmBotIdRef.current
          if (currentThread) void loadMessages(currentThread).catch(guard)
          else void resync()
          if (currentBot) void loadBackgroundTasks(currentBot)
          throw err
        }
        guard(err)
        throw err
      }
    },
    [applyBackgroundTaskUpdate, guard, loadBackgroundTasks, loadMessages, resync],
  )

  const onCancelBackgroundTask = useCallback(
    async (taskId: string) => {
      try {
        const res = await cancelBackgroundTask(taskId)
        applyBackgroundTaskUpdate(res.task.botId, res.task, { patchMessage: true })
      } catch (err: unknown) {
        if (err instanceof SignedOut) {
          setSignedOut(true)
          return
        }
        if (err instanceof ApiError && err.status === 409) {
          const currentThread = threadIdRef.current
          const currentBot = panelFor.current ?? selectedDmBotIdRef.current
          if (currentThread) void loadMessages(currentThread).catch(guard)
          else void resync()
          if (currentBot) void loadBackgroundTasks(currentBot)
          throw err
        }
        guard(err)
        throw err
      }
    },
    [applyBackgroundTaskUpdate, guard, loadBackgroundTasks, loadMessages, resync],
  )

  const onStartDispatchPlan = useCallback(
    async (planId: string) => {
      try {
        const res = await startDispatchPlan(planId)
        applyDispatchPlanUpdate(res.plan)
      } catch (err: unknown) {
        if (err instanceof SignedOut) {
          setSignedOut(true)
          return
        }
        if (err instanceof ApiError && err.status === 409) {
          const currentThread = threadIdRef.current
          if (currentThread) void loadMessages(currentThread).catch(guard)
          else void resync()
          throw err
        }
        guard(err)
        throw err
      }
    },
    [applyDispatchPlanUpdate, guard, loadMessages, resync],
  )

  const onCancelDispatchPlan = useCallback(
    async (planId: string) => {
      try {
        const res = await cancelDispatchPlan(planId)
        applyDispatchPlanUpdate(res.plan)
      } catch (err: unknown) {
        if (err instanceof SignedOut) {
          setSignedOut(true)
          return
        }
        if (err instanceof ApiError && err.status === 409) {
          const currentThread = threadIdRef.current
          if (currentThread) void loadMessages(currentThread).catch(guard)
          else void resync()
          throw err
        }
        guard(err)
        throw err
      }
    },
    [applyDispatchPlanUpdate, guard, loadMessages, resync],
  )

  const onForgetRule = (rule: string) => {
    if (!panel) return
    const botId = panel.botId
    setConfirmDialog({
      message: t('app.confirmForgetRule', { rule }),
      confirmLabel: t('confirm.forget'),
      run: () => {
        void forgetMemoryRule(botId, rule).then(() => loadPanel(botId)).catch(guard)
      },
    })
  }

  /** 本机模式的两个动作：网关拒了（没沙箱、自检失败）就把原因抛回面板显示；不管成败都刷新面板 */
  const panelAction = async (run: (botId: string) => Promise<void>) => {
    if (!panel) return
    try {
      await run(panel.botId)
    } catch (err) {
      if (err instanceof SignedOut) { setSignedOut(true); return }
      throw err
    } finally {
      await loadPanel(panel.botId)
    }
  }
  const onWindowDone = () => panelAction((botId) => setComputerWindow(botId, false))
  const onShell = (enabled: boolean) => panelAction((botId) => setComputerShell(botId, enabled))
  const onToggleConnector = (connectorId: string, granted: boolean) => panelAction(async (botId) => {
    const current = panel?.botId === botId && panel.info?.connectors
      ? panel.info.connectors.filter((c) => c.granted).map((c) => c.id)
      : (connectors?.botGrants[botId] ?? [])
    const nextIds = granted
      ? (current.includes(connectorId) ? current : [...current, connectorId])
      : current.filter((id) => id !== connectorId)
    const res = await setBotConnectors(botId, nextIds)
    setConnectors((prev) => (prev ? { ...prev, botGrants: { ...prev.botGrants, [botId]: res.connectorIds } } : prev))
  })
  const onToggleMcpServer = (serverId: string, granted: boolean) => panelAction(async (botId) => {
    const current = panel?.botId === botId && panel.info?.mcpServers
      ? panel.info.mcpServers.filter((s) => s.granted).map((s) => s.id)
      : (mcpServers?.botGrants[botId] ?? [])
    const nextIds = granted
      ? (current.includes(serverId) ? current : [...current, serverId])
      : current.filter((id) => id !== serverId)
    await setBotMcpServers(botId, nextIds)
    setMcpServers((prev) => {
      if (!prev) return prev
      const servers = prev.servers.map((s) => {
        const has = s.grantedBotIds.includes(botId)
        const wants = nextIds.includes(s.id)
        if (has === wants) return s
        return {
          ...s,
          grantedBotIds: wants ? [...s.grantedBotIds, botId] : s.grantedBotIds.filter((id) => id !== botId),
        }
      })
      return { servers, botGrants: { ...prev.botGrants, [botId]: nextIds } }
    })
  })

  const hire = async (name: string, role: string) => {
    try {
      const bot = await createBot(name, role)
      setHiring(false)
      setHireError(undefined)
      await refreshConversations()
      setSelectedId(`dm:${bot.id}`)
      await Promise.all([loadRoster(), loadLlms(), loadConnectors(), loadMcpServers()])
    } catch (err) {
      if (err instanceof SignedOut) setSignedOut(true)
      else setHireError(err instanceof ApiError ? errorText(t, err) : err instanceof Error ? err.message : String(err))
    }
  }

  /** 向导走完：进 Chief 的对话；点了示例任务就替人发出去 */
  const finishSetup = (task?: string) => {
    setWizard(false)
    void loadLlms().catch(guard) // 向导里可能换了模型或切到了演示模式：标题栏的模型标签要跟上
    const chief = `dm:${setup?.chiefId ?? 'chief'}`
    setSelectedId(chief)
    if (task) sendMessage(chief, task).catch(guard)
  }

  /** 从设置页重开向导：先拿最新的电脑情况，拿不到就不开（老网关） */
  const reopenWizard = async () => {
    try {
      const s = await fetchSetup()
      if (!s) return
      setSetup(s)
      setSettingsOpen(false)
      setWizard(true)
    } catch (err) {
      guard(err)
    }
  }
  const selectConversation = useCallback((id: string) => {
    setSelectedId(id)
    // 清掉旧的 #thread=，否则桌面端下次再点同一条通知时 hash 没变，hashchange 就不会触发
    if (window.location.hash.startsWith('#thread=')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])
  const toggleTheme = useCallback(() => {
    const next: ThemeSetting = resolvedTheme === 'dark' ? 'light' : 'dark'
    onTheme(next)
    void saveSettings({ theme: next }).catch(() => {})
  }, [onTheme, resolvedTheme])
  const hireScrimDown = useRef(false)

  if (signedOut) return <SignIn />
  if (wizard && setup) {
    return (
      <SetupWizard
        setup={setup}
        providers={providers}
        browser={setupBrowser ?? setup.computers.browser}
        language={language}
        onLanguage={onLanguage}
        onBrowser={setSetupBrowser}
        onConnections={setLlms}
        onDone={finishSetup}
        main={llms?.connections.find((c) => c.builtIn)}
        {...(setup.needsSetup ? {} : { onCancel: () => { setWizard(false); void loadLlms().catch(guard) } })}
      />
    )
  }

  const hasConnectors = Boolean(connectors || mcpServers)
  const connectorsAttention = Boolean(
    connectors?.accounts.some((a) => a.status === 'expired' || a.status === 'failed')
    || mcpServers?.servers.some((s) => s.enabled && s.status === 'error'),
  )
  const thinking = selected ? selected.members.some((id) => statuses[id] === 'thinking') : false
  // 单聊里才说得出「这位同事看不看得了图」；群里各人各样，不提
  const seesImages = llms && selected?.kind === 'dm' && selected.members[0] ? botSeesImages(llms, selected.members[0]) : undefined
  // 这个对话里谁在用演示模型：按每位同事实际用的模型算；老网关没有连接信息就看 /api/setup 的 demo
  const inDemo = selected
    ? selected.members.filter((id) => (llms ? botModel(llms, id) === 'stub' : Boolean(setup?.demo)))
    : []
  const demoBanner = selected && inDemo.length ? (
    <DemoBanner
      {...(inDemo.length < selected.members.length ? { names: inDemo.map((id) => roster[id]?.name ?? id) } : {})}
      onConnect={() => void reopenWizard()}
    />
  ) : null
  const activeBgCount = selectedDmBotId
    ? (bgTasksByBot[selectedDmBotId] ?? []).filter(isActiveBgTask).length
    : 0
  const dmHeaderExtra = selected?.kind === 'dm' && selectedDmBotId && (activeBgCount > 0 || llms) ? (
    <>
      {activeBgCount > 0 ? (
        <button
          type="button"
          className="header-bg-pill"
          onClick={openScreen}
          title={t('thread.openComputer')}
        >
          <span className="header-bg-pill-dot" aria-hidden="true" />
          <span>
            ⚡ {activeBgCount === 1
              ? t('bgTask.activePillOne')
              : t('bgTask.activePillMany', { count: activeBgCount })}
          </span>
        </button>
      ) : null}
      {llms ? (
        <BotModelChip botId={selectedDmBotId} state={llms} providers={providers} onOpen={() => setPickerFor(selectedDmBotId)} />
      ) : null}
    </>
  ) : null
  const groupHeaderExtra = selected?.kind === 'group' ? (
    <button
      type="button"
      className="header-charter-btn"
      onClick={() => setCharterOpen(true)}
      title={t('teamCharter.title')}
    >
      <BookOpenIcon size={14} />
      <span>{t('teamCharter.button')}</span>
    </button>
  ) : null

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        selectedId={selected?.id ?? null}
        statuses={statuses}
        onSelect={selectConversation}
        onNewBot={() => { setHireError(undefined); setHiring(true) }}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        resolvedTheme={resolvedTheme}
        onToggleTheme={toggleTheme}
        {...(llms ? { onModels: () => setModelsOpen(true) } : {})}
        {...(hasConnectors ? { onConnectors: () => setConnectorsOpen(true), connectorsAttention } : {})}
        onWiki={() => setWikiOpen(true)}
        {...(setup ? { onSettings: () => setSettingsOpen(true) } : {})}
      />
      {selected ? (
        <Thread
          conversation={selected}
          messages={messages}
          thinking={thinking}
          roster={roster}
          // 没发出去要让输入框知道（它会把字和文件放回来、说明原因），所以登记完错误再抛回去
          onSend={(text, mentions, attachments) => (threadId
            ? sendMessage(threadId, text, mentions, attachments).catch((err: unknown) => { guard(err); throw err })
            : undefined)}
          files={{
            upload: (file, mime, signal) => uploadFile(file, mime, signal).catch((err: unknown) => {
              if (err instanceof SignedOut) setSignedOut(true)
              throw err
            }),
            discard: (id) => { removeUpload(id).catch(guard) },
            remove: (id) => { removeUpload(id).catch(guard) },
            ...(seesImages === undefined ? {} : { seesImages }),
          }}
          onDecide={(approvalId, decision, remember, items, edit) => (
            resolveApproval(approvalId, decision, remember, items, edit).catch((err: unknown) => {
              if (err instanceof SignedOut) { setSignedOut(true); return }
              if (edit !== undefined) throw err
              guard(err)
            })
          )}
          onAnswer={(messageId, choices) => answerQuestion(messageId, choices).catch((err) => { guard(err); throw err })}
          onResolveRuleProposal={onResolveRuleProposal}
          onSteerBackgroundTask={onSteerBackgroundTask}
          onCancelBackgroundTask={onCancelBackgroundTask}
          onStartDispatchPlan={onStartDispatchPlan}
          onCancelDispatchPlan={onCancelDispatchPlan}
          onOpenScreen={openScreen}
          onToggleScreen={toggleScreen}
          panelOpen={Boolean(selected.kind === 'dm' && selected.members[0] && panel?.botId === selected.members[0])}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onStop={() => { if (threadId) stopThread(threadId).catch(guard) }}
          banner={demoBanner}
          headerExtra={selected.kind === 'group' ? groupHeaderExtra : dmHeaderExtra}
        />
      ) : (
        <main className="thread thread-empty">
          <button
            type="button"
            className="mobile-menu-btn"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label={t('sidebar.toggle')}
            title={t('sidebar.toggle')}
            style={{ position: 'absolute', top: 14, left: 14 }}
          >
            <SidebarIcon size={15} />
          </button>
          {t('app.noTeammates')}
        </main>
      )}
      {panel && selected?.kind === 'dm' && selected.members[0] === panel.botId ? (
        <ComputerPanel
          info={panel.info}
          botName={selected?.title ?? ''}
          onClose={() => showPanel(null)}
          onRoutine={onRoutine}
          onRevokeRule={(id) => { void onRevokeRule(id) }}
          onForgetRule={onForgetRule}
          onWindowDone={onWindowDone}
          onShell={onShell}
          onToggleConnector={onToggleConnector}
          onToggleMcpServer={onToggleMcpServer}
          onSteerBackgroundTask={onSteerBackgroundTask}
          onCancelBackgroundTask={onCancelBackgroundTask}
        />
      ) : null}
      {settingsOpen && !modelsOpen && !connectorsOpen && !wikiOpen ? (
        <SettingsDialog
          llms={llms}
          providers={providers}
          browser={setupBrowser}
          language={language}
          onLanguage={onLanguage}
          theme={theme}
          onTheme={onTheme}
          onBrowser={setSetupBrowser}
          onModels={() => setModelsOpen(true)}
          onWizard={() => void reopenWizard()}
          quietDigestTick={quietDigestTick}
          onSignedOut={signOut}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {llms && modelsOpen ? (
        <ModelsDialog state={llms} providers={providers} roster={roster} onChange={setLlms} onSignedOut={signOut} onClose={() => setModelsOpen(false)} />
      ) : null}
      {hasConnectors && connectorsOpen ? (
        <ConnectorsDialog
          state={connectors ?? EMPTY_CONNECTORS}
          roster={roster}
          onChange={(next) => {
            setConnectors(next)
            if (panelFor.current) void loadPanel(panelFor.current)
          }}
          mcpState={mcpServers}
          onMcpChange={(next) => {
            setMcpServers(next)
            if (panelFor.current) void loadPanel(panelFor.current)
          }}
          {...(!connectors && mcpServers ? { initialTab: 'mcp' as const } : {})}
          onSignedOut={signOut}
          onClose={() => setConnectorsOpen(false)}
        />
      ) : null}
      {wikiOpen ? (
        <WikiDialog
          roster={roster}
          refreshTick={wikiRefreshTick}
          onClose={() => setWikiOpen(false)}
          onSignedOut={signOut}
        />
      ) : null}
      {charterOpen && selected?.kind === 'group' ? (
        <TeamCharterDialog
          threadId={selected.id}
          groupTitle={selected.title}
          refreshTick={teamCharterTick}
          onSignedOut={signOut}
          onClose={() => setCharterOpen(false)}
        />
      ) : null}
      {llms && pickerFor && !modelsOpen && !connectorsOpen && !wikiOpen ? (
        <BotModelPicker
          botId={pickerFor}
          botName={roster[pickerFor]?.name ?? pickerFor}
          state={llms}
          providers={providers}
          onSaved={(botId, llm) => setLlms((s) => (s ? { ...s, bots: { ...s.bots, [botId]: llm } } : s))}
          onManage={() => { setPickerFor(null); setModelsOpen(true) }}
          onSignedOut={signOut}
          onClose={() => setPickerFor(null)}
        />
      ) : null}
      {hiring ? (
        <div
          className="modal-scrim"
          onMouseDown={(e) => { hireScrimDown.current = e.target === e.currentTarget }}
          onClick={(e) => { if (e.target === e.currentTarget && hireScrimDown.current) setHiring(false); hireScrimDown.current = false }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label={t('app.hireTitle')} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">{t('app.hireTitle')}</div>
              <button type="button" className="modal-close" onClick={() => setHiring(false)} aria-label={t('hire.cancel')} title={t('hire.cancel')}>
                <XIcon size={15} />
              </button>
            </div>
            <NewBotForm onCreate={(n, r) => void hire(n, r)} onCancel={() => setHiring(false)} error={hireError} />
          </div>
        </div>
      ) : null}
      {confirmDialog ? (
        <ConfirmDialog
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => {
            const run = confirmDialog.run
            setConfirmDialog(null)
            run()
          }}
          onCancel={() => setConfirmDialog(null)}
        />
      ) : null}
    </div>
  )
}
