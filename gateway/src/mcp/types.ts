export type McpTransportKind = 'stdio' | 'http'

export type McpServerStatus = 'disconnected' | 'connected' | 'error'

export type McpToolMode = 'read' | 'write'

export type McpDiscoveredTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnlyHint: boolean
  destructiveHint: boolean
}

export type McpServerRow = {
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
  trustReadOnlyHint: boolean
  tools: McpDiscoveredTool[]
  toolPolicies: Record<string, McpToolMode>
  status: McpServerStatus
  lastError: string
  createdAt: number
  updatedAt: number
}

export type McpServerSecrets = {
  env: Record<string, string>
  headers: Record<string, string>
}

export type McpSecretVault = {
  get(serverId: string): McpServerSecrets
  patch(
    serverId: string,
    update: { env?: Record<string, string | null>; headers?: Record<string, string | null> },
  ): McpServerSecrets
  remove(serverId: string): void
  masked(serverId: string): { envMasked: Record<string, string>; headersMasked: Record<string, string> }
  redactText(serverId: string, text: string): string
}

export type McpToolView = McpDiscoveredTool & {
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

export type FrozenMcpExecution = {
  kind: 'mcp'
  operationId: string
  serverId: string
  serverName: string
  serverSlug: string
  toolName: string
  exposedToolName: string
  args: Record<string, unknown>
}

export type McpCallResult = {
  content: Array<Record<string, unknown>>
  structuredContent?: unknown
  isError?: boolean
}

export type McpWriteExecutionResult =
  | { status: 'succeeded'; summary: string }
  | { status: 'failed'; error: string }
  | { status: 'uncertain'; detail: string }

export type McpCallErrorCode =
  | 'connect_failed'
  | 'protocol_error'
  | 'timeout'
  | 'uncertain_write'
  | 'not_found'
  | 'disabled'

export class McpCallError extends Error {
  readonly code: McpCallErrorCode
  readonly dispatched: boolean
  constructor(code: McpCallErrorCode, message: string, dispatched = false) {
    super(message)
    this.name = 'McpCallError'
    this.code = code
    this.dispatched = dispatched
  }
}

export type McpManager = {
  discoverTools(serverId: string): Promise<McpDiscoveredTool[]>
  ensureDiscovered(serverId: string): Promise<McpServerRow | null>
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    opts?: { write?: boolean; signal?: AbortSignal },
  ): Promise<McpCallResult>
  disconnect(serverId: string): Promise<void>
  closeAll(): Promise<void>
}
