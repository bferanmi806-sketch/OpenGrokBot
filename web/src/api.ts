import { fileToBase64 } from './attachments'
import type {
  AboutInfo, AppKey, ApprovalEditInput, AttachmentPayload, BackgroundTaskActionResponse, BackgroundTaskView, Bot, BotLlm, BrowserStatus, CheckResult, ComputerInfo, ConnectionsState, ConnectorsSnapshot,
  Conversation, CreateGoalInput, CreateMcpServerInput, CreateSpaceInput, CreateVaultItemInput, DispatchPlanActionResponse, DispatchPlanView, FeedItemStatus, FeedSnapshot, FeedTopic, FieldError, GatewayEvent, GoalMilestone,
  GoalsSnapshot, GoalUpdateItem, GoalView, IdeaItem, IdeaStatus, ImportMcpServersInput, ImportMcpServersResult, LlmPriority, LlmQueueEndpointView, LlmQueueSnapshot, McpServersSnapshot,
  McpServerView, Message, MilestoneStatus, ProviderPreset, QuietDigestBotSummary, QuietDigestFlushResponse, QuietDigestSummary, ResolveRuleProposalResponse, RoutineAction, RuleDuration, RuleProposalStatus, RuleProposalView,
  ServerEvent, SettingsView, SetupInfo, SpaceGrant, SpaceItem, SpaceItemData, SpaceRole, SpacesSnapshot, SpaceView, TeamCharterView, TodoItem, TodoStatus, UpdateGoalPatch, UpdateMcpServerPatch, UpdateSpacePatch, UpdateVaultItemPatch,
  VaultItemView, VaultSnapshot, WikiCreateInput, WikiKind, WikiListResponse, WikiPageResponse, WikiSaveInput, WorkflowDraft, WorkflowTrace, SavedWorkflowTrace,
} from './types'

export type {
  ApprovalEditInput,
  BackgroundTaskActionResponse,
  BackgroundTaskPayload,
  BackgroundTaskStatus,
  BackgroundTaskStep,
  BackgroundTaskView,
  CreateMcpServerInput,
  CreateVaultItemInput,
  DispatchPlanActionResponse,
  DispatchPlanPayload,
  DispatchPlanStatus,
  DispatchPlanView,
  DispatchStepStatus,
  DispatchStepView,
  GatewayEvent,
  ImportMcpServersInput,
  ImportMcpServersResult,
  LlmPriority,
  LlmQueueEndpointView,
  LlmQueueSnapshot,
  QuietDigestBotSummary,
  QuietDigestFlushResponse,
  QuietDigestSummary,
  ResolveRuleProposalResponse,
  RuleProposalStatus,
  RuleProposalView,
  ServerEvent,
  TeamCharterView,
  UpdateMcpServerPatch,
  UpdateVaultItemPatch,
  VaultSnapshot,
  WikiCreateInput,
  WikiKind,
  WikiListResponse,
  WikiPageResponse,
  WikiSaveInput,
} from './types'

/** 网关说「先登录」：界面换成锁屏说明，而不是一片空白。 */
export class SignedOut extends Error {
  constructor() { super('sign in first') }
}

/** 网关拒了：message 是它的英文原话，code + params 让界面换成操作者的语言（认得的话） */
export class ApiError extends Error {
  readonly code: string | undefined
  readonly params: Record<string, string | number> | undefined
  readonly detail: string | undefined
  readonly status: number
  constructor(
    message: string,
    status: number,
    code?: string,
    params?: Record<string, string | number>,
    detail?: string,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.params = params
    this.detail = detail
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init)
  if (res.status === 401) throw new SignedOut()
  return res
}

async function getJson<T>(path: string): Promise<T> {
  const res = await request(path)
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`)
  return res.json() as Promise<T>
}

async function getApiJson<T>(path: string): Promise<T> {
  const res = await request(path)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string
      code?: string
      params?: Record<string, string | number>
      detail?: string
    }
    throw new ApiError(data.error ?? `GET ${path} ${res.status}`, res.status, data.code, data.params, data.detail)
  }
  return res.json() as Promise<T>
}

/**
 * 默认 409 不算失败：审批被别处先定了、问题已经答过，这种「晚了一步」不值得报错。
 * strict 时 409 也抛：开命令行被拒（没沙箱、自检失败）回的就是 409，原因要摆到面板上。
 */
async function send(method: string, path: string, body?: unknown, opts: { strict?: boolean } = {}): Promise<Response> {
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok && (opts.strict || res.status !== 409)) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string
      code?: string
      params?: Record<string, string | number>
      detail?: string
    }
    throw new ApiError(data.error ?? `${method} ${path} ${res.status}`, res.status, data.code, data.params, data.detail)
  }
  return res
}

/** 只有 401 才算「没登录」：网关重启时 dev 代理回的 502 不该把界面锁死 */
export async function checkSession(): Promise<boolean> {
  const res = await fetch('/api/session')
  return res.status !== 401
}

/** 启动时一次拿回界面语言与主题；老网关没有这个路由或没存过就回默认值 */
export async function fetchUiPrefs(): Promise<{ language: string; theme: '' | 'dark' | 'light' | 'system'; themeSaved: boolean }> {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) return { language: '', theme: '', themeSaved: false }
    const body = (await res.json()) as {
      values?: { language?: unknown; theme?: unknown }
      sources?: { theme?: unknown }
    }
    const language = typeof body.values?.language === 'string' ? body.values.language : ''
    const rawTheme = body.values?.theme
    const theme = rawTheme === 'dark' || rawTheme === 'light' || rawTheme === 'system' ? rawTheme : ''
    return { language, theme, themeSaved: body.sources?.theme === 'saved' }
  } catch {
    return { language: '', theme: '', themeSaved: false }
  }
}

/** 设置里存的界面语言；空串 = 跟浏览器。拿不到（老网关没有这个路由）就当没设 */
export async function fetchLanguage(): Promise<string> {
  return (await fetchUiPrefs()).language
}

export const fetchBots = () => getJson<Bot[]>('/api/bots')
export const fetchConversations = () => getJson<Conversation[]>('/api/conversations')
export const fetchMessages = (threadId: string) => getJson<Message[]>(`/api/threads/${encodeURIComponent(threadId)}/messages`)
export const fetchComputer = (botId: string) => getJson<ComputerInfo>(`/api/bots/${encodeURIComponent(botId)}/computer`)

/** mentions：群里点名的同事 id，只叫他们作答，不传就是整个群；attachments：一起发的文件（uploadFile 回的 id） */
export async function sendMessage(threadId: string, text: string, mentions?: string[], attachments?: string[]): Promise<void> {
  await send('POST', `/api/threads/${encodeURIComponent(threadId)}/messages`, {
    text,
    ...(mentions?.length ? { mentions } : {}),
    ...(attachments?.length ? { attachments: attachments.map((id) => ({ id })) } : {}),
  }, { strict: true })
}

/**
 * 把一个文件传到网关，回来的就是线程里那条文件消息的 payload。走 JSON + base64：网关只收 JSON 的改动请求。
 * mime 是我们按类型和扩展名认出来的（见 attachments.ts）；网关会按内容再认一遍，对不上就拒。
 */
export async function uploadFile(file: File, mime: string, signal?: AbortSignal): Promise<AttachmentPayload> {
  const data = await fileToBase64(file)
  signal?.throwIfAborted()
  const res = await request('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mime, data }),
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
    throw new ApiError(body.error ?? `POST /api/uploads ${res.status}`, res.status, body.code)
  }
  return res.json() as Promise<AttachmentPayload>
}

/** 移除一个上传。已经不在了（404）不算失败：要的就是它不在 */
export async function removeUpload(id: string): Promise<void> {
  const res = await request(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new ApiError(`DELETE /api/uploads ${res.status}`, res.status)
}

export async function stopThread(threadId: string): Promise<void> {
  await send('POST', `/api/threads/${encodeURIComponent(threadId)}/stop`)
}

/** 模型连接的表单被网关拒了：每个字段错在哪 */
export class FieldErrors extends Error {
  readonly errors: FieldError[]
  readonly status: number
  constructor(errors: FieldError[], status: number) {
    super(errors.map((e) => `${e.key}: ${e.code}`).join(', ') || `HTTP ${status}`)
    this.name = 'FieldErrors'
    this.errors = errors
    this.status = status
  }
}

async function sendForm<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await res.json().catch(() => ({}))) as T & { errors?: FieldError[] }
  if (!res.ok) throw new FieldErrors(Array.isArray(data.errors) ? data.errors : [], res.status)
  return data
}

export type ConnectionFields = {
  name?: string
  provider?: string
  api?: string
  baseURL?: string
  model?: string
  vision?: boolean
  /** 不传 = 不改；空串 = 删掉 */
  apiKey?: string
}

/** 模型连接和每位同事的选择；老网关没有这个路由就是 null（界面不显示这一块） */
export async function fetchConnections(): Promise<ConnectionsState | null> {
  const res = await request('/api/connections')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /api/connections ${res.status}`)
  return res.json() as Promise<ConnectionsState>
}
export const fetchProviders = () => getJson<ProviderPreset[]>('/api/settings/providers')
export const createConnection = (fields: ConnectionFields) =>
  sendForm<ConnectionsState & { created: string }>('POST', '/api/connections', fields)
export const updateConnection = (id: string, fields: ConnectionFields) =>
  sendForm<ConnectionsState>('PATCH', `/api/connections/${encodeURIComponent(id)}`, fields)
export const deleteConnection = (id: string) =>
  sendForm<ConnectionsState & { moved: string[] }>('DELETE', `/api/connections/${encodeURIComponent(id)}`)
export const setDefaultConnection = (id: string) =>
  sendForm<ConnectionsState>('POST', `/api/connections/${encodeURIComponent(id)}/default`)
/** 测一个连接；connectionId 给了就从存着的那个出发，其余字段是还没存的改动 */
export const testConnection = (fields: ConnectionFields & { connectionId?: string }) =>
  sendForm<CheckResult>('POST', '/api/connections/test', fields)
export const fetchConnectionModels = (id: string) =>
  getJson<{ ok: true; models: string[] } | { ok: false; code: string }>(`/api/connections/${encodeURIComponent(id)}/models`)
export const setBotLlm = (botId: string, choice: { connectionId: string; model: string | null }) =>
  sendForm<BotLlm>('PUT', `/api/bots/${encodeURIComponent(botId)}/llm`, choice)

/** 外部应用连接器与授权快照；老网关没有这个路由就是 null（界面不显示这一块） */
export async function fetchConnectors(): Promise<ConnectorsSnapshot | null> {
  const res = await request('/api/connectors')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /api/connectors ${res.status}`)
  return res.json() as Promise<ConnectorsSnapshot>
}

export async function saveConnectorsKey(apiKey: string | null): Promise<ConnectorsSnapshot> {
  const res = await send('PUT', '/api/connectors/key', { apiKey }, { strict: true })
  return res.json() as Promise<ConnectorsSnapshot>
}

export async function testConnectorsKey(apiKey?: string): Promise<{ ok: boolean; code?: string; detail?: string }> {
  const res = await send('POST', '/api/connectors/key/test', apiKey === undefined ? {} : { apiKey }, { strict: true })
  return res.json() as Promise<{ ok: boolean; code?: string; detail?: string }>
}

export async function startConnectorOAuth(
  app: AppKey,
  botIds: string[],
): Promise<{ connectorId: string; redirectUrl: string; callbackUrl: string; state: ConnectorsSnapshot }> {
  const res = await send('POST', '/api/connectors/connect', { app, botIds }, { strict: true })
  return res.json() as Promise<{ connectorId: string; redirectUrl: string; callbackUrl: string; state: ConnectorsSnapshot }>
}

export async function reconnectConnector(
  id: string,
): Promise<{ connectorId: string; redirectUrl: string; callbackUrl: string }> {
  const res = await send('POST', `/api/connectors/${encodeURIComponent(id)}/reconnect`, undefined, { strict: true })
  return res.json() as Promise<{ connectorId: string; redirectUrl: string; callbackUrl: string }>
}

export async function refreshConnector(id: string): Promise<ConnectorsSnapshot> {
  const res = await send('POST', `/api/connectors/${encodeURIComponent(id)}/refresh`, undefined, { strict: true })
  return res.json() as Promise<ConnectorsSnapshot>
}

export async function deleteConnector(id: string): Promise<ConnectorsSnapshot> {
  const res = await send('DELETE', `/api/connectors/${encodeURIComponent(id)}`, undefined, { strict: true })
  return res.json() as Promise<ConnectorsSnapshot>
}

export async function setBotConnectors(
  botId: string,
  connectorIds: string[],
): Promise<{ botId: string; connectorIds: string[] }> {
  const res = await send('PUT', `/api/bots/${encodeURIComponent(botId)}/connectors`, { connectorIds }, { strict: true })
  return res.json() as Promise<{ botId: string; connectorIds: string[] }>
}

/** MCP 服务与授权快照；老网关没有这个路由就是 null（界面不显示这一块） */
export async function fetchMcpServers(): Promise<McpServersSnapshot | null> {
  const res = await request('/api/mcp/servers')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /api/mcp/servers ${res.status}`)
  return res.json() as Promise<McpServersSnapshot>
}

export async function createMcpServer(input: CreateMcpServerInput): Promise<{ server: McpServerView }> {
  const res = await send('POST', '/api/mcp/servers', input, { strict: true })
  return res.json() as Promise<{ server: McpServerView }>
}

export async function importMcpServers(input: ImportMcpServersInput): Promise<ImportMcpServersResult> {
  const res = await send('POST', '/api/mcp/servers/import', input, { strict: true })
  return res.json() as Promise<ImportMcpServersResult>
}

export async function updateMcpServer(id: string, patch: UpdateMcpServerPatch): Promise<{ server: McpServerView }> {
  const res = await send('PATCH', `/api/mcp/servers/${encodeURIComponent(id)}`, patch, { strict: true })
  return res.json() as Promise<{ server: McpServerView }>
}

export async function testMcpServer(id: string): Promise<{ server: McpServerView }> {
  const res = await send('POST', `/api/mcp/servers/${encodeURIComponent(id)}/test`, undefined, { strict: true })
  return res.json() as Promise<{ server: McpServerView }>
}

export async function deleteMcpServer(id: string): Promise<void> {
  await send('DELETE', `/api/mcp/servers/${encodeURIComponent(id)}`, undefined, { strict: true })
}

export async function setMcpServerBots(id: string, botIds: string[]): Promise<void> {
  await send('PUT', `/api/mcp/servers/${encodeURIComponent(id)}/bots`, { botIds }, { strict: true })
}

export async function setBotMcpServers(botId: string, serverIds: string[]): Promise<void> {
  await send('PUT', `/api/bots/${encodeURIComponent(botId)}/mcp`, { serverIds }, { strict: true })
}

/** 凭证库与授权快照；老网关没有这个路由就是 null */
export async function fetchVault(): Promise<VaultSnapshot | null> {
  const res = await request('/api/vault')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /api/vault ${res.status}`)
  return res.json() as Promise<VaultSnapshot>
}

export async function createVaultItem(input: CreateVaultItemInput): Promise<{ item: VaultItemView; snapshot: VaultSnapshot }> {
  const res = await send('POST', '/api/vault', input, { strict: true })
  return res.json() as Promise<{ item: VaultItemView; snapshot: VaultSnapshot }>
}

export async function updateVaultItem(
  id: string,
  patch: UpdateVaultItemPatch,
): Promise<{ item: VaultItemView; snapshot: VaultSnapshot }> {
  const res = await send('PATCH', `/api/vault/${encodeURIComponent(id)}`, patch, { strict: true })
  return res.json() as Promise<{ item: VaultItemView; snapshot: VaultSnapshot }>
}

export async function deleteVaultItem(id: string): Promise<{ ok: boolean; snapshot: VaultSnapshot }> {
  const res = await send('DELETE', `/api/vault/${encodeURIComponent(id)}`, undefined, { strict: true })
  return res.json() as Promise<{ ok: boolean; snapshot: VaultSnapshot }>
}

export async function setBotVaultItems(
  botId: string,
  itemIds: string[],
): Promise<{ botId: string; itemIds: string[]; snapshot: VaultSnapshot }> {
  const res = await send('PUT', `/api/bots/${encodeURIComponent(botId)}/vault`, { itemIds }, { strict: true })
  return res.json() as Promise<{ botId: string; itemIds: string[]; snapshot: VaultSnapshot }>
}

/** 今日动态与灵感箱快照；老网关没有这个路由就是 null */
export async function fetchFeed(): Promise<FeedSnapshot | null> {
  const res = await request('/api/feed')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`)
  return res.json() as Promise<FeedSnapshot>
}

export async function updateFeedItemStatus(id: string, status: FeedItemStatus): Promise<{ snapshot: FeedSnapshot }> {
  const res = await send('PATCH', `/api/feed/${encodeURIComponent(id)}`, { status }, { strict: true })
  return res.json() as Promise<{ snapshot: FeedSnapshot }>
}

export async function markAllFeedRead(): Promise<{ snapshot: FeedSnapshot }> {
  const res = await send('POST', '/api/feed/read-all', {}, { strict: true })
  return res.json() as Promise<{ snapshot: FeedSnapshot }>
}

export async function deleteFeedItem(id: string): Promise<{ snapshot: FeedSnapshot }> {
  const res = await send('DELETE', `/api/feed/${encodeURIComponent(id)}`, undefined, { strict: true })
  return res.json() as Promise<{ snapshot: FeedSnapshot }>
}

export async function followupFeedItem(
  id: string,
  opts: { botId?: string; note?: string } = {},
): Promise<{ botId: string; threadId: string; snapshot: FeedSnapshot }> {
  const res = await send('POST', `/api/feed/${encodeURIComponent(id)}/followup`, opts, { strict: true })
  return res.json() as Promise<{ botId: string; threadId: string; snapshot: FeedSnapshot }>
}

export async function promoteFeedToIdea(id: string): Promise<{ idea: IdeaItem; snapshot: FeedSnapshot }> {
  const res = await send('POST', `/api/feed/${encodeURIComponent(id)}/idea`, {}, { strict: true })
  return res.json() as Promise<{ idea: IdeaItem; snapshot: FeedSnapshot }>
}

export async function createIdea(input: {
  title: string
  notes?: string
  assignedBotId?: string | null
}): Promise<{ idea: IdeaItem; snapshot: FeedSnapshot }> {
  const res = await send('POST', '/api/ideas', input, { strict: true })
  return res.json() as Promise<{ idea: IdeaItem; snapshot: FeedSnapshot }>
}

export async function updateIdea(
  id: string,
  patch: { title?: string; notes?: string; status?: IdeaStatus; assignedBotId?: string | null },
): Promise<{ idea: IdeaItem; snapshot: FeedSnapshot }> {
  const res = await send('PATCH', `/api/ideas/${encodeURIComponent(id)}`, patch, { strict: true })
  return res.json() as Promise<{ idea: IdeaItem; snapshot: FeedSnapshot }>
}

export async function deleteIdea(id: string): Promise<{ snapshot: FeedSnapshot }> {
  const res = await send('DELETE', `/api/ideas/${encodeURIComponent(id)}`, undefined, { strict: true })
  return res.json() as Promise<{ snapshot: FeedSnapshot }>
}

export async function incubateIdea(
  id: string,
  opts: { botId?: string } = {},
): Promise<{ idea: IdeaItem; botId: string; threadId: string; snapshot: FeedSnapshot }> {
  const res = await send('POST', `/api/ideas/${encodeURIComponent(id)}/incubate`, opts, { strict: true })
  return res.json() as Promise<{ idea: IdeaItem; botId: string; threadId: string; snapshot: FeedSnapshot }>
}

export async function dispatchIdea(
  id: string,
  opts: { botId?: string; instructions?: string } = {},
): Promise<{ idea: IdeaItem; botId: string; threadId: string; snapshot: FeedSnapshot }> {
  const res = await send('POST', `/api/ideas/${encodeURIComponent(id)}/dispatch`, opts, { strict: true })
  return res.json() as Promise<{ idea: IdeaItem; botId: string; threadId: string; snapshot: FeedSnapshot }>
}

export async function createFeedTopic(input: {
  title?: string
  prompt: string
  botId?: string
  cron?: string
  enabled?: boolean
  runNow?: boolean
}): Promise<{ topic: FeedTopic; running: boolean; snapshot: FeedSnapshot }> {
  const res = await send('POST', '/api/feed/topics', input, { strict: true })
  return res.json() as Promise<{ topic: FeedTopic; running: boolean; snapshot: FeedSnapshot }>
}

export async function updateFeedTopic(
  id: string,
  patch: { title?: string; prompt?: string; botId?: string; cron?: string; enabled?: boolean },
): Promise<{ topic: FeedTopic; snapshot: FeedSnapshot }> {
  const res = await send('PATCH', `/api/feed/topics/${encodeURIComponent(id)}`, patch, { strict: true })
  return res.json() as Promise<{ topic: FeedTopic; snapshot: FeedSnapshot }>
}

export async function deleteFeedTopic(id: string): Promise<{ snapshot: FeedSnapshot }> {
  const res = await send('DELETE', `/api/feed/topics/${encodeURIComponent(id)}`, undefined, { strict: true })
  return res.json() as Promise<{ snapshot: FeedSnapshot }>
}

export async function runFeedTopic(id: string): Promise<{ started: boolean; topic: FeedTopic; snapshot: FeedSnapshot }> {
  const res = await send('POST', `/api/feed/topics/${encodeURIComponent(id)}/run`, {}, { strict: true })
  return res.json() as Promise<{ started: boolean; topic: FeedTopic; snapshot: FeedSnapshot }>
}

export async function runAllFeedTopics(): Promise<{ started: string[]; snapshot: FeedSnapshot }> {
  const res = await send('POST', '/api/feed/topics/run-all', {}, { strict: true })
  return res.json() as Promise<{ started: string[]; snapshot: FeedSnapshot }>
}

export async function updateTodo(
  id: string,
  patch: { status?: TodoStatus; title?: string; detail?: string },
): Promise<{ todo: TodoItem; snapshot: FeedSnapshot }> {
  const res = await send('PATCH', `/api/todos/${encodeURIComponent(id)}`, patch, { strict: true })
  return res.json() as Promise<{ todo: TodoItem; snapshot: FeedSnapshot }>
}

export async function deleteTodo(id: string): Promise<{ snapshot: FeedSnapshot }> {
  const res = await send('DELETE', `/api/todos/${encodeURIComponent(id)}`, undefined, { strict: true })
  return res.json() as Promise<{ snapshot: FeedSnapshot }>
}

export async function distillFeedFromChats(): Promise<{
  ideasAdded: number
  todosAdded: number
  todosCompleted: number
  goalsAdded: number
  goalsUpdated: number
  snapshot: FeedSnapshot
}> {
  const res = await send('POST', '/api/feed/distill', {}, { strict: true })
  return res.json() as Promise<{
    ideasAdded: number
    todosAdded: number
    todosCompleted: number
    goalsAdded: number
    goalsUpdated: number
    snapshot: FeedSnapshot
  }>
}

/** 长期目标与里程碑快照；老网关没有这个路由就返回 null */
export async function fetchGoals(): Promise<GoalsSnapshot | null> {
  const res = await request('/api/goals')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<GoalsSnapshot>
}

export async function createGoal(input: CreateGoalInput): Promise<{ goal: GoalView; snapshot: GoalsSnapshot }> {
  const res = await send('POST', '/api/goals', input, { strict: true })
  return res.json() as Promise<{ goal: GoalView; snapshot: GoalsSnapshot }>
}

export async function updateGoal(id: string, patch: UpdateGoalPatch): Promise<{ goal: GoalView; snapshot: GoalsSnapshot }> {
  const res = await send('PATCH', `/api/goals/${encodeURIComponent(id)}`, patch, { strict: true })
  return res.json() as Promise<{ goal: GoalView; snapshot: GoalsSnapshot }>
}

export async function deleteGoal(id: string): Promise<{ snapshot: GoalsSnapshot }> {
  const res = await send('DELETE', `/api/goals/${encodeURIComponent(id)}`, undefined, { strict: true })
  return res.json() as Promise<{ snapshot: GoalsSnapshot }>
}

export async function addGoalMilestone(
  goalId: string,
  input: { title: string; ownerBotId?: string | null; dueDate?: string | null },
): Promise<{ milestone: GoalMilestone; goal: GoalView; snapshot: GoalsSnapshot }> {
  const res = await send('POST', `/api/goals/${encodeURIComponent(goalId)}/milestones`, input, { strict: true })
  return res.json() as Promise<{ milestone: GoalMilestone; goal: GoalView; snapshot: GoalsSnapshot }>
}

export async function updateGoalMilestone(
  goalId: string,
  milestoneId: string,
  patch: { title?: string; status?: MilestoneStatus; ownerBotId?: string | null; dueDate?: string | null },
): Promise<{ milestone: GoalMilestone; goal: GoalView; snapshot: GoalsSnapshot }> {
  const res = await send(
    'PATCH',
    `/api/goals/${encodeURIComponent(goalId)}/milestones/${encodeURIComponent(milestoneId)}`,
    patch,
    { strict: true },
  )
  return res.json() as Promise<{ milestone: GoalMilestone; goal: GoalView; snapshot: GoalsSnapshot }>
}

export async function deleteGoalMilestone(
  goalId: string,
  milestoneId: string,
): Promise<{ goal: GoalView; snapshot: GoalsSnapshot }> {
  const res = await send(
    'DELETE',
    `/api/goals/${encodeURIComponent(goalId)}/milestones/${encodeURIComponent(milestoneId)}`,
    undefined,
    { strict: true },
  )
  return res.json() as Promise<{ goal: GoalView; snapshot: GoalsSnapshot }>
}

export async function addGoalUpdate(
  goalId: string,
  summary: string,
): Promise<{ update: GoalUpdateItem; goal: GoalView; snapshot: GoalsSnapshot }> {
  const res = await send('POST', `/api/goals/${encodeURIComponent(goalId)}/updates`, { summary }, { strict: true })
  return res.json() as Promise<{ update: GoalUpdateItem; goal: GoalView; snapshot: GoalsSnapshot }>
}

export async function checkinGoal(
  goalId: string,
  opts: { botId?: string; note?: string } = {},
): Promise<{ botId: string; threadId: string; snapshot: GoalsSnapshot }> {
  const res = await send('POST', `/api/goals/${encodeURIComponent(goalId)}/checkin`, opts, { strict: true })
  return res.json() as Promise<{ botId: string; threadId: string; snapshot: GoalsSnapshot }>
}

export async function setRoutineGoal(id: number, goalId: string | null): Promise<void> {
  await send('PATCH', `/api/routines/${id}`, { goalId }, { strict: true })
}

/** 声明式空间快照；老网关没有这个路由就返回 null */
export async function fetchSpaces(): Promise<SpacesSnapshot | null> {
  const res = await request('/api/spaces')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<SpacesSnapshot>
}

export async function createSpace(input: CreateSpaceInput): Promise<{ space: SpaceView; snapshot: SpacesSnapshot }> {
  const res = await send('POST', '/api/spaces', input, { strict: true })
  return res.json() as Promise<{ space: SpaceView; snapshot: SpacesSnapshot }>
}

export async function updateSpace(id: string, patch: UpdateSpacePatch): Promise<{ space: SpaceView; snapshot: SpacesSnapshot }> {
  const res = await send('PATCH', `/api/spaces/${encodeURIComponent(id)}`, patch, { strict: true })
  return res.json() as Promise<{ space: SpaceView; snapshot: SpacesSnapshot }>
}

export async function deleteSpace(id: string): Promise<{ snapshot: SpacesSnapshot }> {
  const res = await send('DELETE', `/api/spaces/${encodeURIComponent(id)}`, undefined, { strict: true })
  return res.json() as Promise<{ snapshot: SpacesSnapshot }>
}

export async function setSpaceGrants(id: string, grants: SpaceGrant[]): Promise<{ space: SpaceView; snapshot: SpacesSnapshot }> {
  const res = await send('PUT', `/api/spaces/${encodeURIComponent(id)}/grants`, { grants }, { strict: true })
  return res.json() as Promise<{ space: SpaceView; snapshot: SpacesSnapshot }>
}

export async function setBotSpaceRole(botId: string, spaceId: string, role: SpaceRole | null): Promise<{ snapshot: SpacesSnapshot }> {
  const res = await send('PUT', `/api/bots/${encodeURIComponent(botId)}/spaces/${encodeURIComponent(spaceId)}`, { role }, { strict: true })
  return res.json() as Promise<{ snapshot: SpacesSnapshot }>
}

export async function createSpaceItem(
  spaceId: string,
  input: { blockId: string; title: string; status?: string; data?: SpaceItemData },
): Promise<{ item: SpaceItem; space: SpaceView; snapshot: SpacesSnapshot }> {
  const res = await send('POST', `/api/spaces/${encodeURIComponent(spaceId)}/items`, input, { strict: true })
  return res.json() as Promise<{ item: SpaceItem; space: SpaceView; snapshot: SpacesSnapshot }>
}

export async function updateSpaceItem(
  spaceId: string,
  itemId: string,
  patch: { blockId?: string; title?: string; status?: string; data?: SpaceItemData; sortOrder?: number },
): Promise<{ item: SpaceItem; space: SpaceView; snapshot: SpacesSnapshot }> {
  const res = await send(
    'PATCH',
    `/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}`,
    patch,
    { strict: true },
  )
  return res.json() as Promise<{ item: SpaceItem; space: SpaceView; snapshot: SpacesSnapshot }>
}

export async function deleteSpaceItem(
  spaceId: string,
  itemId: string,
): Promise<{ space: SpaceView; snapshot: SpacesSnapshot }> {
  const res = await send(
    'DELETE',
    `/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}`,
    undefined,
    { strict: true },
  )
  return res.json() as Promise<{ space: SpaceView; snapshot: SpacesSnapshot }>
}

export async function triggerSpaceAction(
  spaceId: string,
  actionId: string,
): Promise<{ botId: string; threadId: string }> {
  const res = await send(
    'POST',
    `/api/spaces/${encodeURIComponent(spaceId)}/actions/${encodeURIComponent(actionId)}`,
    {},
    { strict: true },
  )
  return res.json() as Promise<{ botId: string; threadId: string }>
}

export async function uploadSpaceAsset(
  spaceId: string,
  file: File,
): Promise<{ url: string; name: string; mime: string; size: number }> {
  const data = await fileToBase64(file)
  const res = await send(
    'POST',
    `/api/spaces/${encodeURIComponent(spaceId)}/assets`,
    { name: file.name, data },
    { strict: true },
  )
  return res.json() as Promise<{ url: string; name: string; mime: string; size: number }>
}

/** 团队知识库：按关键词 / 分类检索与列出、读详情与历史、创建、保存、回滚、删除 */
export function fetchWiki(opts?: { q?: string; kind?: WikiKind; limit?: number }): Promise<WikiListResponse> {
  const params = new URLSearchParams()
  const q = opts?.q?.trim()
  if (q) params.set('q', q)
  if (opts?.kind) params.set('kind', opts.kind)
  if (opts?.limit !== undefined && Number.isFinite(opts.limit)) {
    params.set('limit', String(opts.limit))
  }
  const qs = params.toString()
  return getApiJson<WikiListResponse>(qs ? `/api/wiki?${qs}` : '/api/wiki')
}

export function fetchWikiPage(kind: WikiKind, slug: string): Promise<WikiPageResponse> {
  return getApiJson<WikiPageResponse>(`/api/wiki/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`)
}

export async function createWikiPage(input: WikiCreateInput): Promise<WikiPageResponse> {
  const res = await send('POST', '/api/wiki', input, { strict: true })
  return res.json() as Promise<WikiPageResponse>
}

export async function saveWikiPage(kind: WikiKind, slug: string, input: WikiSaveInput): Promise<WikiPageResponse> {
  const res = await send('PUT', `/api/wiki/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`, input, { strict: true })
  return res.json() as Promise<WikiPageResponse>
}

export async function revertWikiPage(kind: WikiKind, slug: string, version: number, note?: string): Promise<WikiPageResponse> {
  const body = note !== undefined ? { version, note } : { version }
  const res = await send('POST', `/api/wiki/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}/revert`, body, { strict: true })
  return res.json() as Promise<WikiPageResponse>
}

export async function deleteWikiPage(kind: WikiKind, slug: string): Promise<void> {
  await send('DELETE', `/api/wiki/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`, undefined, { strict: true })
}

/** 免打扰晨报摘要与待投递数量 */
export function fetchQuietDigest(): Promise<QuietDigestSummary> {
  return getApiJson<QuietDigestSummary>('/api/quiet-digest')
}

/** 本地模型优先级队列快照（并发上限、各端点运行中与排队中数量） */
export function fetchLlmQueue(): Promise<LlmQueueSnapshot> {
  return getApiJson<LlmQueueSnapshot>('/api/llm-queue')
}

/** 查询某位同事的后台任务列表（运行中/排队中在前，最新在前） */
export function fetchBackgroundTasks(botId: string): Promise<{ tasks: BackgroundTaskView[] }> {
  return getApiJson<{ tasks: BackgroundTaskView[] }>(`/api/bots/${encodeURIComponent(botId)}/background-tasks`)
}

/** 向排队中或运行中的后台任务发送纠偏指令 */
export async function steerBackgroundTask(id: string, note: string): Promise<BackgroundTaskActionResponse> {
  const res = await send('POST', `/api/background-tasks/${encodeURIComponent(id)}/steer`, { note }, { strict: true })
  return res.json() as Promise<BackgroundTaskActionResponse>
}

/** 取消排队中或运行中的后台任务 */
export async function cancelBackgroundTask(id: string): Promise<BackgroundTaskActionResponse> {
  const res = await send('POST', `/api/background-tasks/${encodeURIComponent(id)}/cancel`, undefined, { strict: true })
  return res.json() as Promise<BackgroundTaskActionResponse>
}

/** 读取某个群聊的团队章程（team.md） */
export function fetchTeamCharter(threadId: string): Promise<TeamCharterView> {
  return getApiJson<TeamCharterView>(`/api/threads/${encodeURIComponent(threadId)}/team`)
}

/** 保存某个群聊的团队章程（team.md） */
export async function saveTeamCharter(threadId: string, content: string): Promise<TeamCharterView> {
  const res = await send('PUT', `/api/threads/${encodeURIComponent(threadId)}/team`, { content }, { strict: true })
  return res.json() as Promise<TeamCharterView>
}

/** 查询某个群聊的协作流水线列表 */
export function fetchDispatchPlans(threadId: string): Promise<{ plans: DispatchPlanView[] }> {
  return getApiJson<{ plans: DispatchPlanView[] }>(`/api/threads/${encodeURIComponent(threadId)}/dispatch-plans`)
}

/** 启动草稿状态的协作流水线 */
export async function startDispatchPlan(id: string): Promise<DispatchPlanActionResponse> {
  const res = await send('POST', `/api/dispatch-plans/${encodeURIComponent(id)}/start`, undefined, { strict: true })
  return res.json() as Promise<DispatchPlanActionResponse>
}

/** 取消草稿、运行中或暂停中的协作流水线 */
export async function cancelDispatchPlan(id: string): Promise<DispatchPlanActionResponse> {
  const res = await send('POST', `/api/dispatch-plans/${encodeURIComponent(id)}/cancel`, undefined, { strict: true })
  return res.json() as Promise<DispatchPlanActionResponse>
}

/** 立即投递免打扰期间暂存的晨报更新（可按同事筛选） */
export async function flushQuietDigest(botId?: string): Promise<QuietDigestFlushResponse> {
  const res = await send('POST', '/api/quiet-digest/flush', botId ? { botId } : {}, { strict: true })
  return res.json() as Promise<QuietDigestFlushResponse>
}

/** 查询规矩提议列表（可按同事或状态筛选） */
export function fetchRuleProposals(opts?: {
  botId?: string
  status?: RuleProposalStatus
}): Promise<{ proposals: RuleProposalView[] }> {
  const params = new URLSearchParams()
  const botId = opts?.botId?.trim()
  if (botId) params.set('botId', botId)
  if (opts?.status) params.set('status', opts.status)
  const qs = params.toString()
  return getApiJson<{ proposals: RuleProposalView[] }>(qs ? `/api/rule-proposals?${qs}` : '/api/rule-proposals')
}

/** 接受（可内联编辑规矩文本）或忽略一条规矩提议 */
export async function resolveRuleProposal(
  id: number,
  decision: 'accept' | 'dismiss',
  rule?: string,
): Promise<ResolveRuleProposalResponse> {
  const body = decision === 'accept' && rule !== undefined ? { decision, rule } : { decision }
  const res = await send('POST', `/api/rule-proposals/${id}`, body, { strict: true })
  return res.json() as Promise<ResolveRuleProposalResponse>
}

/** 首次启动要不要出向导；老网关没有这个路由（或出了错）就当不用，绝不因此挡住界面 */
export async function fetchSetup(): Promise<SetupInfo | null> {
  const res = await request('/api/setup')
  if (!res.ok) return null
  return res.json() as Promise<SetupInfo>
}

/** 改设置（语言、演示模式、浏览器镜像……）；被拒时抛 FieldErrors */
export const saveSettings = (patch: Record<string, unknown>) => sendForm<SettingsView>('PUT', '/api/settings', patch)
export const fetchSettings = () => getJson<SettingsView>('/api/settings')
export const fetchAbout = () => getJson<AboutInfo>('/api/about')

/** 提前把同事用的浏览器下好；进度经 /ws 的 setup.browser 推过来 */
export async function downloadBrowser(): Promise<BrowserStatus> {
  const res = await send('POST', '/api/setup/browser', {}, { strict: true })
  return ((await res.json()) as { browser: BrowserStatus }).browser
}

export async function createBot(name: string, role: string): Promise<Bot> {
  const res = await send('POST', '/api/bots', { name, role })
  return res.json() as Promise<Bot>
}

/** items：一批对象里只放行这几项（下标）；不传 = 全部；edit：操作者在审批卡片里修改后的参数 */
export async function resolveApproval(
  approvalId: number,
  decision: 'approve' | 'discard',
  remember?: RuleDuration,
  items?: number[],
  edit?: ApprovalEditInput,
): Promise<void> {
  await send('POST', `/api/approvals/${approvalId}`, {
    decision,
    ...(remember ? { remember } : {}),
    ...(items ? { items } : {}),
    ...(edit ? { edit } : {}),
  })
}

export async function answerQuestion(messageId: number, choices: string[]): Promise<void> {
  await send('POST', `/api/questions/${messageId}`, { choices })
}

export async function revokeRule(id: number): Promise<void> {
  await send('DELETE', `/api/rules/${id}`)
}

export async function forgetMemoryRule(botId: string, rule: string): Promise<void> {
  await send('POST', `/api/bots/${encodeURIComponent(botId)}/memory/forget`, { rule })
}

/** 本机电脑：开关这位同事的命令行（开了也在沙箱里，只能写它自己的文件夹） */
export async function setComputerShell(botId: string, enabled: boolean): Promise<void> {
  await send('PATCH', `/api/bots/${encodeURIComponent(botId)}/computer`, { shell: enabled }, { strict: true })
}

/** 本机电脑：登录完了把浏览器窗口收回后台（shown=false），或主动开出来（shown=true） */
export async function setComputerWindow(botId: string, shown: boolean): Promise<void> {
  await send('POST', `/api/bots/${encodeURIComponent(botId)}/computer/window`, { shown }, { strict: true })
}

export const fetchWorkflowTraces = (botId: string) =>
  getJson<SavedWorkflowTrace[]>(`/api/bots/${encodeURIComponent(botId)}/workflows`)

export async function startWorkflowRecording(botId: string, title: string, intent?: string): Promise<void> {
  await send('POST', `/api/bots/${encodeURIComponent(botId)}/workflows/recording`, {
    title,
    ...(intent?.trim() ? { intent: intent.trim() } : {}),
  }, { strict: true })
}

export async function stopWorkflowRecording(botId: string): Promise<WorkflowDraft> {
  const response = await send('POST', `/api/bots/${encodeURIComponent(botId)}/workflows/recording/stop`, undefined, { strict: true })
  return response.json() as Promise<WorkflowDraft>
}

export async function cancelWorkflowRecording(botId: string): Promise<void> {
  await send('DELETE', `/api/bots/${encodeURIComponent(botId)}/workflows/recording`, undefined, { strict: true })
}

export async function updateWorkflowDraft(botId: string, draftId: string, trace: WorkflowTrace): Promise<WorkflowDraft> {
  const response = await send('PATCH', `/api/bots/${encodeURIComponent(botId)}/workflows/drafts/${encodeURIComponent(draftId)}`, { trace }, { strict: true })
  return response.json() as Promise<WorkflowDraft>
}

export async function saveWorkflowDraft(botId: string, draftId: string, trace: WorkflowTrace): Promise<SavedWorkflowTrace> {
  const response = await send('POST', `/api/bots/${encodeURIComponent(botId)}/workflows`, { draftId, trace }, { strict: true })
  return response.json() as Promise<SavedWorkflowTrace>
}

export async function discardWorkflowDraft(botId: string, draftId: string): Promise<void> {
  await send('DELETE', `/api/bots/${encodeURIComponent(botId)}/workflows/drafts/${encodeURIComponent(draftId)}`, undefined, { strict: true })
}

export async function deleteWorkflow(botId: string, workflowId: string): Promise<void> {
  await send('DELETE', `/api/bots/${encodeURIComponent(botId)}/workflows/${encodeURIComponent(workflowId)}`, undefined, { strict: true })
}

export async function runWorkflow(botId: string, workflowId: string, bindings: Record<string, string>): Promise<{ runId: string; status: 'running' }> {
  const response = await send('POST', `/api/bots/${encodeURIComponent(botId)}/workflows/${encodeURIComponent(workflowId)}/run`, { bindings }, { strict: true })
  return response.json() as Promise<{ runId: string; status: 'running' }>
}

export async function stopWorkflowRun(botId: string, runId: string): Promise<void> {
  await send('DELETE', `/api/bots/${encodeURIComponent(botId)}/workflows/runs/${encodeURIComponent(runId)}`, undefined, { strict: true })
}

export async function updateRoutine(id: number, action: RoutineAction): Promise<void> {
  if (action === 'run') await send('POST', `/api/routines/${id}/run`)
  else if (action === 'delete') await send('DELETE', `/api/routines/${id}`)
  else await send('PATCH', `/api/routines/${id}`, { enabled: action === 'resume' })
}

/** 断线自动重连；网关每次连上都会先发一份 hello 快照，调用方据此补拉错过的消息。 */
export function connectEvents(onEvent: (e: GatewayEvent) => void, opts?: { onSignedOut?: () => void }): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let retry = 0
  const open = () => {
    if (closed) return
    let opened = false
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    ws = sock
    sock.onopen = () => {
      opened = true
      retry = 0
    }
    sock.onmessage = (ev) => {
      opened = true
      retry = 0
      try { onEvent(JSON.parse(ev.data)) } catch { /* 忽略脏帧 */ }
    }
    sock.onclose = () => {
      if (ws === sock) ws = null
      if (closed) return
      if (!opened && opts?.onSignedOut) {
        void checkSession().then((ok) => { if (!ok && !closed) opts.onSignedOut?.() }).catch(() => {})
      }
      const delay = Math.min(1500 * 2 ** Math.min(retry++, 3), 12_000)
      timer = setTimeout(open, delay)
    }
  }
  open()
  return () => {
    closed = true
    clearTimeout(timer)
    if (ws) {
      ws.onclose = null
      ws.close()
      ws = null
    }
  }
}
