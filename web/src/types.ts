export type ReportLine = { system: string; result: string; count?: string }
export type ReportPayload = { lines: ReportLine[]; closing?: string }
export type ScreenshotPayload = { url: string; width: number; height: number; caption?: string }
/** 「以后这类都放」能管多久：一小时、一天、直到你撤销 */
export type RuleDuration = '1h' | '24h' | 'always'
/** 为什么这次放行不能记成规则（和网关 approvals.ts 的 BlockReason 对应） */
export type BlockReason =
  | { code: 'no_destination' | 'always_asks' | 'batch' }
  | { code: 'too_long'; max: number }
  | { code: 'wildcard' | 'several' | 'everyone' | 'whole_service' | 'not_one_email' | 'whole_site' | 'vague_post'; target: string }

/** 这台机器为什么没有沙箱 */
export type SandboxMissing = 'install_bwrap' | 'userns_blocked' | 'no_sandbox_exec' | 'unsupported_os'

/** 网关替同事说的固定话（kind 还是 text，content 是英文；有这个 payload 就按语言重说） */
export type NoticePayload =
  | { notice: 'stopped' }
  | { notice: 'error'; params: { name: string; detail: string } }
  | { notice: 'budget'; params: { name: string; used: number; budget: number } }
  | { notice: 'paused'; params: { limit: 'steps' | 'minutes' | 'seconds'; count: number }; lead?: string }
  | { notice: 'connector_expired'; params: { app: string; account: string } }
  | { notice: 'connector_execution'; params: { status: 'failed' | 'uncertain'; action: string; detail: string } }

export type EditableMailSend = {
  kind: 'connector'
  tool: 'mail_send'
  accountLabel: string
  draftId?: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
}

export type EditableMailReply = {
  kind: 'connector'
  tool: 'mail_reply'
  accountLabel: string
  to: string[]
  /** Extra recipients that will be CC'd when replyAll is true */
  replyAllCc: string[]
  subject: string
  body: string
  replyAll: boolean
}

export type EditableSlackMessage = {
  kind: 'connector'
  tool: 'slack_send_message'
  accountLabel: string
  channelId: string
  threadTs?: string
  text: string
}

export type EditableNotionCreatePage = {
  kind: 'connector'
  tool: 'notion_create_page'
  accountLabel: string
  parentPageId: string
  title: string
  markdown: string
}

export type EditableNotionAppend = {
  kind: 'connector'
  tool: 'notion_append'
  accountLabel: string
  pageId: string
  markdown: string
}

export type EditableCalendarCreateEvent = {
  kind: 'connector'
  tool: 'calendar_create_event'
  accountLabel: string
  title: string
  start: string
  end: string
  location: string
  attendees: string[]
  description: string
}

export type EditableCalendarUpdateEvent = {
  kind: 'connector'
  tool: 'calendar_update_event'
  accountLabel: string
  eventId: string
  title?: string
  start?: string
  end?: string
  location?: string
  attendees?: string[]
  description?: string
}

export type EditableMcp = {
  kind: 'mcp'
  serverName: string
  toolName: string
  args: Record<string, unknown>
  /** Compact JSON Schema (omitted if serialized size exceeds 32 KB) */
  inputSchema?: Record<string, unknown>
}

export type EditablePrompt = {
  kind: 'prompt'
  action: string
  detail: string
}

export type ApprovalEditable =
  | EditableMailSend
  | EditableMailReply
  | EditableSlackMessage
  | EditableNotionCreatePage
  | EditableNotionAppend
  | EditableCalendarCreateEvent
  | EditableCalendarUpdateEvent
  | EditableMcp
  | EditablePrompt

export type MailSendEditInput = {
  kind: 'connector'
  tool: 'mail_send'
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
}

export type MailReplyEditInput = {
  kind: 'connector'
  tool: 'mail_reply'
  body: string
  replyAll?: boolean
}

export type SlackMessageEditInput = {
  kind: 'connector'
  tool: 'slack_send_message'
  channelId: string
  text: string
}

export type NotionCreatePageEditInput = {
  kind: 'connector'
  tool: 'notion_create_page'
  title: string
  markdown: string
}

export type NotionAppendEditInput = {
  kind: 'connector'
  tool: 'notion_append'
  markdown: string
}

export type CalendarCreateEventEditInput = {
  kind: 'connector'
  tool: 'calendar_create_event'
  title: string
  start: string
  end: string
  location?: string
  attendees?: string[]
  description?: string
}

export type CalendarUpdateEventEditInput = {
  kind: 'connector'
  tool: 'calendar_update_event'
  title?: string
  start?: string
  end?: string
  location?: string
  attendees?: string[]
  description?: string
}

export type ConnectorEditInput =
  | MailSendEditInput
  | MailReplyEditInput
  | SlackMessageEditInput
  | NotionCreatePageEditInput
  | NotionAppendEditInput
  | CalendarCreateEventEditInput
  | CalendarUpdateEventEditInput

export type McpEditInput = {
  kind: 'mcp'
  args: Record<string, unknown>
}

export type PromptEditInput = {
  kind: 'prompt'
  action: string
  detail: string
}

export type ApprovalEditInput = ConnectorEditInput | McpEditInput | PromptEditInput

export type ApprovalPayload = {
  approvalId: number
  action: string
  detail?: string
  status: 'pending' | 'approved' | 'discarded'
  /** bot 申报的类别和去向；老 chip 没有 */
  kind?: string
  target?: string
  /** 这次放行能不能顺手记成规则（花钱、订东西、没有去向的都不行） */
  canRemember?: boolean
  /** 一条已有的规则直接放行了它 */
  rule?: { id: number; kind: string; target: string; expiresAt: number | null }
  /** 你放行时顺手留下的规则 */
  remembered?: { id: number; expiresAt: number | null }
  /** 类别可以记规则、但去向不是一个确定的地方：为什么不给「Always allow」 */
  rememberBlocked?: string
  /** 同一个原因的代码和插值，界面按语言说；老 chip 只有上面那句英文 */
  rememberReason?: BlockReason
  /** 有规则本来能放行它，但这一回合不是你开的头（或眼前有外部数据），所以还是问了你 */
  ruleHeld?: 'routine' | 'webhook' | 'relay' | 'outside-data' | 'unknown'
  /** 一批对象，一项一行 */
  items?: string[]
  /** 你勾留下、放行了的那几项的下标 */
  approvedItems?: number[]
  /** 连接器写操作由网关在批准后直接执行：结果记在审批卡片上 */
  executionStatus?: 'succeeded' | 'failed' | 'uncertain'
  executionDetail?: string
  /** 可在审批卡片内直接编辑的草稿/参数投影；仅 pending 非批量、非工作流审批携带 */
  editable?: ApprovalEditable
  /** 操作者修改内容后再批准 */
  edited?: boolean
}
export type ApprovalResolvedPayload = {
  approvalId: number
  action: string
  decision: 'approve' | 'discard'
  remembered?: { id: number; expiresAt: number | null; kind: string; target: string }
  /** 一批对象时：放行了几项、一共几项 */
  count?: { approved: number; of: number }
  /** 操作者修改内容后再批准 */
  edited?: boolean
}
export type MemoryPayload = { rule: string; diff: string; total: number; removed?: boolean; by?: 'operator' }
export type RoutineMode = 'act' | 'watch' | 'prepare'
export type RoutinePayload = {
  routineId: number
  name: string
  cron: string
  human: string
  webhook?: boolean
  mode?: RoutineMode
}
export type QuestionPayload = {
  question: string
  options: string[]
  multi: boolean
  /** skipped = 你没点选项、直接打字回了 */
  status: 'open' | 'answered' | 'skipped'
  answer?: string[]
}
export type BotRefPayload = { from: string; fromName: string; content: string; tainted?: boolean }
export type LoginPayload = { site: string; why?: string }
/** webhook 带来的东西，网关已排好版、截过长 */
export type WebhookPayload = { routineId: number; name: string; body: string }
/** 操作者发给同事的文件；deleted = 之后被移除了，线程里只剩名字 */
export type AttachmentPayload = {
  id: string; url: string; name: string; mime: string; size: number
  width?: number; height?: number
  /** PDF：页数，和它的文字能不能读 */
  pages?: number; text?: 'ok' | 'truncated' | 'none' | 'failed'
  deleted?: boolean
}
export type ActivityStep = { tool: string; summary: string; ok?: boolean; ms?: number }
export type ActivityPayload = { steps: ActivityStep[]; done: boolean }

export type ComputerRoutine = {
  id: number
  name: string
  cron: string
  human: string
  last_run_at: number | null
  enabled: number
  /** 带密钥的 webhook 路径（以 / 开头）；没有 webhook 就是 null */
  webhook_path?: string | null
  /** 同一个密钥，单独给 GitHub 当 Secret 用来签名 */
  webhook_secret?: string | null
  mode?: RoutineMode
}

export type Skill = { name: string; description: string }

/** 动作日志里的一笔：哪个工具、对什么、成没成、谁叫它开始的 */
export type ActionEntry = {
  id: number
  thread_id: string
  trigger: string
  tool: string
  summary: string
  ok: boolean | null
  ms: number | null
  created_at: number
}

export type ApprovalRule = {
  id: number
  kind: string
  target: string
  expiresAt: number | null
  createdAt: number
  /** false：去向校验收紧之前留下的模糊规则，还列着但不再放行任何东西 */
  applies?: boolean
  whyNot?: string
  whyNotReason?: BlockReason
}

export type UsageTotals = { prompt: number; completion: number; cached: number; total: number }

export type ComputerInfo = {
  botId: string
  running: boolean
  /** 这台电脑是什么做的：容器（sealed）还是本机沙箱 */
  kind?: 'docker' | 'local'
  /** 网关给的 noVNC 页面地址，连接参数（含口令）都已带好 */
  vncUrl: string | null
  /** 屏幕怎么看：容器是 noVNC 页面，本机是浏览器截屏流 */
  screen?: { kind: 'vnc'; url: string } | { kind: 'cdp'; url: string } | null
  /** 本机模式：浏览器此刻以窗口开在桌面上（接管登录中） */
  window?: boolean
  /** 命令行：开没开、这台机器有没有沙箱可用（没有就说明为什么） */
  shell?: { enabled: boolean; available: boolean; why?: string; whyCode?: SandboxMissing }
  error?: string
  /** 认得出的故障（Docker 没开、镜像没建……）带代码，界面按语言说；认不出的只有 error 原文 */
  errorCode?: string
  errorParams?: Record<string, string | number>
  routines: ComputerRoutine[]
  usage?: { today: UsageTotals; budget: number }
  /** 还在生效的「以后都放行」 */
  rules?: ApprovalRule[]
  /** MEMORY.md 里的规矩，一条一行 */
  memory?: string[]
  /** 所有同事共用的技能（做事手册） */
  skills?: Skill[]
  /** 最近做过的动作，最新的在前 */
  actions?: ActionEntry[]
  /** 已连接的外部账号，以及这位同事有没有获得访问授权 */
  connectors?: ComputerConnectorItem[]
  /** 已配置的 MCP 服务，以及这位同事有没有获得访问授权 */
  mcpServers?: BotMcpServerItem[]
}

export type ComputerView = ComputerInfo

export type RoutineAction = 'run' | 'pause' | 'resume' | 'delete'

export type MessageKind =
  | 'text'
  | 'report'
  | 'screenshot'
  | 'approval_request'
  | 'approval_resolved'
  | 'memory_updated'
  | 'routine_created'
  | 'bot_ref'
  | 'login_request'
  | 'activity'
  | 'question'
  | 'webhook'
  | 'attachment'
  | 'quiet_digest'
  | 'rule_proposal'

export type Message = {
  id: number
  thread_id: string
  sender: string // 'user' | bot id | 'webhook'
  kind: MessageKind
  content: string
  payload:
    | ReportPayload
    | ScreenshotPayload
    | ApprovalPayload
    | ApprovalResolvedPayload
    | MemoryPayload
    | RoutinePayload
    | BotRefPayload
    | LoginPayload
    | ActivityPayload
    | QuestionPayload
    | WebhookPayload
    | AttachmentPayload
    | NoticePayload
    | QuietDigestPayload
    | RuleProposalPayload
    | null
  created_at: number
}

export type Conversation = {
  id: string
  kind: 'dm' | 'group'
  title: string
  emoji: string
  subtitle: string
  members: string[]
  last_message: Message | null
  /** 还等着你拍板的审批数 */
  pending: number
}

export type Bot = {
  id: string
  name: string
  role: string
  emoji: string
  thread_id: string
  last_message: Message | null
}

/**
 * 网关给的：thinking 在干活、waiting 在等你、blocked 卡住了、idle 闲着。
 * done 是界面自己记的：它在你没看着的时候干完了一件事，点开它的线程就消掉。
 */
export type BotStatus = 'thinking' | 'waiting' | 'blocked' | 'idle' | 'done'

export type GatewayEvent =
  | { type: 'message'; threadId: string; message: Message }
  | { type: 'status'; botId: string; state: BotStatus }
  | { type: 'hello'; statuses: Record<string, BotStatus> }
  /** 本机模式的浏览器：找到了、缺着、下载中（进度）、下载失败。向导里用 */
  | { type: 'setup.browser'; browser: BrowserStatus }
  | { type: 'connectors_changed' }
  | { type: 'mcp_changed' }
  | { type: 'wiki_changed' }
  | { type: 'quiet_digest_changed' }

export type ServerEvent = GatewayEvent

export type BrowserStatus =
  | { state: 'found'; executablePath: string; source: 'env' | 'system' | 'downloaded' }
  | { state: 'missing' }
  /** item：在下哪一样（chromium、ffmpeg……），每样都从 0% 走起 */
  | { state: 'downloading'; item: string | null; percent: number | null; totalMiB: number | null }
  | { state: 'failed'; error: string }

/** 自动选电脑时为什么落在这一种（网关的 BackendWhy） */
export type BackendWhy = 'chosen' | 'docker_running' | 'docker_not_running' | 'docker_image_missing' | 'no_local_mode'

/** /api/setup：要不要出首次启动向导，以及同事的电脑有什么可用 */
export type SetupInfo = {
  needsSetup: boolean
  /** 向导最后一步把人领进它的对话；老网关不给就当 chief */
  chiefId?: string
  demo: boolean
  computers: {
    kind: 'local' | 'docker'
    choice: 'auto' | 'docker' | 'local'
    why?: BackendWhy
    reason?: string
    docker: { reachable: boolean; imageReady: boolean | null }
    browser: BrowserStatus
    download: { approxMB: number; onDiskMB: number }
    browserMirror: { current: string; suggested: { url: string; owner: string } | null }
    sandbox: { available: boolean; why?: string; whyCode?: SandboxMissing }
  }
}

export type ThemeSetting = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

/** /api/settings：生效的设置、每项来自哪（env 的在界面上锁定）、改了哪些要重启网关 */
export type SettingsView = {
  values: {
    provider: string
    baseURL: string
    model: string
    vision: boolean
    language: '' | 'en' | 'zh-CN'
    theme?: ThemeSetting
    computers: 'auto' | 'docker' | 'local'
    browserMirror: string
    checkUpdates: boolean
    quietHoursEnabled?: boolean
    quietHoursStart?: string
    quietHoursEnd?: string
    localLlmConcurrency?: number
  }
  sources: Record<string, 'env' | 'saved' | 'default'>
  apiKey: { set: boolean; masked: string; source: 'env' | 'file' | 'none' }
  needsRestart: string[]
}

/** /api/about：设置页的「关于」。version 为 null = 源码版；logs 'stdout' = 打在运行网关的终端里 */
export type AboutInfo = {
  version: string | null
  dataDir: string
  /** 网关在听的端口（老网关不给） */
  port?: number
  logs: string
  runtime: { node: string; platform: string; arch: string }
  computers: 'local' | 'docker' | null
}

/** 模型接口的说法：chat = OpenAI 兼容；anthropic = Claude 原生；responses = OpenAI 的 Responses */
export type LlmApi = 'chat' | 'anthropic' | 'responses'

/** 网关的服务商预设（/api/settings/providers）；说明文字由界面按 id 翻 */
export type ProviderPreset = {
  id: string
  name: string
  region: 'cn' | 'global' | 'local' | 'custom'
  api: LlmApi
  /** 订阅套餐的 key（编程套餐之类）：先讲清楚条款再让人用 */
  plan?: true
  baseURL: string
  needsKey: boolean
  keyUrl: string
  defaultModel: string
  vision: boolean
  docsUrl: string
}

/** 一个模型连接：一家服务商 + 一个 key + 默认模型。builtIn 是内置槽位；isDefault 是当前默认连接 */
export type ModelConnection = {
  id: string
  name: string
  provider: string
  api: LlmApi
  baseURL: string
  model: string
  vision: boolean
  builtIn: boolean
  /** 没单独选过连接的同事都会用这一条（老网关不回此字段时退回 builtIn） */
  isDefault?: boolean
  key: { set: boolean; masked: string; source: 'env' | 'file' | 'none' }
  /** 被环境变量定死、界面上改不了的字段 */
  locked: string[]
}

/** 同事选的模型连接；model 为空 = 用连接自己的默认模型 */
export type BotLlm = { connectionId: string; model: string | null }

export type ConnectionsState = { connections: ModelConnection[]; bots: Record<string, BotLlm> }

/** 网关拒收的字段：key 是字段名，code 由界面翻 */
export type FieldError = { key: string; code: string }

export type CheckCode = 'bad_key' | 'quota' | 'rate_limited' | 'model_not_found' | 'unreachable' | 'timeout' | 'provider_error'
export type CheckResult =
  | { ok: true; models: string[]; modelListed: boolean | null }
  | { ok: false; code: CheckCode; status?: number; detail?: string; step?: 'models' | 'chat'; models?: string[] }

export type AppKey = 'gmail' | 'outlook' | 'google_calendar' | 'outlook_calendar' | 'notion' | 'slack'
export type AppGroupId = 'mail_calendar' | 'productivity' | 'messaging'
export type ConnectorDomain = 'mail' | 'calendar' | 'notion' | 'slack'
export type ConnectorStatus = 'pending' | 'active' | 'expired' | 'failed'

export type CatalogApp = {
  app: AppKey
  name: string
  group: AppGroupId
  domain: ConnectorDomain
  toolkitSlug: string
  authScheme: 'OAUTH2'
}

export type ConnectorAccountView = {
  id: string
  app: AppKey
  accountLabel: string
  status: ConnectorStatus
  lastError: string
  createdAt: number
  updatedAt: number
}

export type ConnectorsSnapshot = {
  key: { set: boolean; masked: string; source: 'env' | 'file' | 'none'; locked: boolean }
  catalog: CatalogApp[]
  accounts: ConnectorAccountView[]
  botGrants: Record<string, string[]>
}

export type ComputerConnectorItem = {
  id: string
  app: AppKey
  name: string
  accountLabel: string
  status: ConnectorStatus
  granted: boolean
}

export type McpTransportKind = 'stdio' | 'http'

export type McpServerStatus = 'disconnected' | 'connected' | 'error'

export type McpToolMode = 'read' | 'write'

export type McpToolPolicyChoice = McpToolMode | 'default' | null

export type McpToolView = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnlyHint: boolean
  destructiveHint: boolean
  overrideMode: McpToolMode | null
  effectiveMode: McpToolMode
  exposedName: string
}

export type McpServerView = {
  id: string
  name: string
  slug: string
  transport: McpTransportKind
  enabled: boolean
  command: string
  args: string[]
  cwd: string
  url: string
  envKeys: string[]
  headerKeys: string[]
  envMasked: Record<string, string>
  headersMasked: Record<string, string>
  trustReadOnlyHint: boolean
  tools: McpToolView[]
  toolPolicies: Record<string, McpToolMode>
  status: McpServerStatus
  lastError: string
  grantedBotIds: string[]
  createdAt: number
  updatedAt: number
}

export type McpServersSnapshot = {
  servers: McpServerView[]
  botGrants: Record<string, string[]>
}

export type BotMcpServerItem = {
  id: string
  name: string
  slug: string
  transport: McpTransportKind
  enabled: boolean
  status: McpServerStatus
  toolCount: number
  granted: boolean
}

export type CreateMcpServerInput = {
  name: string
  transport: McpTransportKind
  enabled?: boolean
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  env?: Record<string, string | null>
  headers?: Record<string, string | null>
  trustReadOnlyHint?: boolean
  toolPolicies?: Record<string, McpToolPolicyChoice>
  botIds?: string[]
  connectNow?: boolean
}

export type UpdateMcpServerPatch = {
  name?: string
  transport?: McpTransportKind
  enabled?: boolean
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  env?: Record<string, string | null>
  headers?: Record<string, string | null>
  trustReadOnlyHint?: boolean
  toolPolicies?: Record<string, McpToolPolicyChoice>
  botIds?: string[]
  connectNow?: boolean
}

export type ImportMcpServersInput = {
  json: string
  botIds?: string[]
  trustReadOnlyHint?: boolean
  connectNow?: boolean
}

export type ImportMcpServersResult = {
  imported: McpServerView[]
  errors: { name: string; error: string }[]
}

export type WikiKind = 'contact' | 'client' | 'project' | 'topic'

export type WikiPageSummary = {
  id: string
  kind: WikiKind
  slug: string
  title: string
  summary: string
  tags: string[]
  sourceTainted: boolean
  updatedBy: string
  version: number
  createdAt: number
  updatedAt: number
  snippet?: string
  score?: number
}

export type WikiPageDetail = WikiPageSummary & {
  body: string
}

export type WikiRevision = {
  id: number
  pageId: string
  version: number
  title: string
  summary: string
  tags: string[]
  body: string
  editedBy: string
  note: string
  sourceTainted: boolean
  createdAt: number
}

export type WikiListResponse = {
  pages: WikiPageSummary[]
  total: number
}

export type WikiPageResponse = {
  page: WikiPageDetail
  revisions: WikiRevision[]
}

export type WikiSaveInput = {
  title: string
  summary?: string
  tags?: string[]
  body: string
  note?: string
}

export type WikiCreateInput = WikiSaveInput & {
  kind: WikiKind
  slug?: string
}

export type QuietDigestEntry = {
  id: number
  routineId: number | null
  routineName: string
  routineMode: RoutineMode
  kind: 'report' | 'text'
  summary: string
  report?: ReportPayload
  text?: string
  createdAt: number
}

export type QuietDigestPayload = {
  windowStart: string
  windowEnd: string
  itemCount: number
  items: QuietDigestEntry[]
  flushedManually?: boolean
}

export type QuietDigestBotSummary = {
  botId: string
  count: number
  latestAt: number
}

export type QuietDigestSummary = {
  enabled: boolean
  active: boolean
  start: string
  end: string
  timeZone: string
  pendingCount: number
  byBot: QuietDigestBotSummary[]
}

export type QuietDigestFlushResponse = {
  flushed: number
  threads: string[]
}

export type RuleProposalSource = 'agent' | 'discard_pattern'
export type RuleProposalStatus = 'pending' | 'accepted' | 'dismissed'

export type RuleProposalPayload = {
  proposalId: number
  rule: string
  reason: string
  source: RuleProposalSource
  sourceTainted: boolean
  status: RuleProposalStatus
  edited?: boolean
  resolvedAt?: number
}

export type RuleProposalView = {
  id: number
  botId: string
  threadId: string
  rule: string
  reason: string
  source: RuleProposalSource
  sourceTainted: boolean
  status: RuleProposalStatus
  messageId: number | null
  createdAt: number
  resolvedAt: number | null
}

export type ResolveRuleProposalResponse = {
  ok: true
  proposal: RuleProposalView
  memoryUpdated: boolean
}

export type LlmPriority = 'interactive' | 'background' | 'routine' | 'low'

export type LlmQueueEndpointView = {
  key: string
  active: number
  queued: number
  byPriority: Record<LlmPriority, number>
}

export type LlmQueueSnapshot = {
  concurrency: number
  endpoints: LlmQueueEndpointView[]
}
