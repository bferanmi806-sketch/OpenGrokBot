import type { Db } from '../db.js'
import type { Hub } from '../hub.js'
import { createHttpSession } from './http-transport.js'
import type { McpSecretVault } from './secrets.js'
import {
  MAX_TOOLS_PER_SERVER,
  createStdioSession,
  normalizeMcpDiscoveredTool,
  type McpSession,
} from './stdio-transport.js'
import { getMcpServer, markMcpServerStatus, saveMcpDiscoveredTools } from './store.js'
import {
  McpCallError,
  type McpCallResult,
  type McpDiscoveredTool,
  type McpManager,
  type McpServerRow,
} from './types.js'

export type { McpSession } from './stdio-transport.js'
export type { McpManager } from './types.js'

export type McpManagerDeps = {
  db: Db
  secrets: McpSecretVault
  hub?: Hub
  hostEnv?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  handshakeTimeoutMs?: number
  callTimeoutMs?: number
  now?: () => number
}

function sanitizeToolsList(tools: readonly McpDiscoveredTool[]): McpDiscoveredTool[] {
  const out: McpDiscoveredTool[] = []
  const seen = new Set<string>()
  for (const t of tools) {
    const normalized = normalizeMcpDiscoveredTool({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: {
        readOnlyHint: t.readOnlyHint,
        destructiveHint: t.destructiveHint,
      },
    })
    if (!normalized || seen.has(normalized.name)) continue
    seen.add(normalized.name)
    out.push(normalized)
    if (out.length >= MAX_TOOLS_PER_SERVER) break
  }
  return out
}

export function createMcpManager(deps: McpManagerDeps): McpManager {
  const { db, secrets, hub } = deps
  const now = deps.now ?? (() => Date.now())

  const sessions = new Map<string, McpSession>()
  const inflightConnects = new Map<string, Promise<McpSession>>()
  const serverGenerations = new Map<string, number>()
  const activeRefreshes = new Map<string, Promise<void>>()
  const queuedRefreshes = new Set<string>()
  let globalEpoch = 0

  const getGen = (serverId: string): number => serverGenerations.get(serverId) ?? 0
  const bumpGen = (serverId: string): number => {
    const next = getGen(serverId) + 1
    serverGenerations.set(serverId, next)
    return next
  }

  const toRedactedCallError = (
    serverId: string,
    err: unknown,
    fallbackCode: McpCallError['code'] = 'connect_failed',
  ): McpCallError => {
    const rawMsg = err instanceof Error ? err.message : String(err)
    const cleanMsg = secrets.redactText(serverId, rawMsg)
    if (err instanceof McpCallError) {
      return new McpCallError(err.code, cleanMsg, err.dispatched)
    }
    return new McpCallError(fallbackCode, cleanMsg, false)
  }

  const evictIfUnhealthy = (serverId: string): boolean => {
    const cur = sessions.get(serverId)
    if (!cur) return true
    if (cur.isHealthy()) return false
    sessions.delete(serverId)
    void cur.close().catch(() => {})
    return true
  }

  const scheduleToolsChangedRefresh = (serverId: string): void => {
    if (activeRefreshes.has(serverId)) {
      queuedRefreshes.add(serverId)
      return
    }
    const task = (async () => {
      try {
        for (;;) {
          queuedRefreshes.delete(serverId)
          const srv = getMcpServer(db, serverId)
          if (!srv || !srv.enabled || !sessions.get(serverId)?.isHealthy()) {
            queuedRefreshes.delete(serverId)
            break
          }
          await discoverTools(serverId).catch(() => {})
          if (!queuedRefreshes.has(serverId)) break
        }
      } finally {
        activeRefreshes.delete(serverId)
      }
    })()
    activeRefreshes.set(serverId, task)
  }

  const connect = (serverId: string): Promise<McpSession> => {
    const server = getMcpServer(db, serverId)
    if (!server) {
      return Promise.reject(new McpCallError('not_found', `MCP server not found: ${serverId}`, false))
    }

    const existing = sessions.get(serverId)
    if (existing) {
      if (existing.isHealthy()) {
        return Promise.resolve(existing)
      }
      sessions.delete(serverId)
      void existing.close().catch(() => {})
    }

    const inflight = inflightConnects.get(serverId)
    if (inflight) {
      return inflight
    }

    const startEpoch = globalEpoch
    const startGen = getGen(serverId)
    const serverSecrets = secrets.get(serverId)
    const redact = (text: string): string => secrets.redactText(serverId, text)
    const onToolsChanged = (): void => {
      scheduleToolsChangedRefresh(serverId)
    }

    let connectTask: Promise<McpSession> | undefined
    connectTask = (async () => {
      try {
        const session =
          server.transport === 'http'
            ? await createHttpSession({
                url: server.url,
                headers: serverSecrets.headers,
                fetchImpl: deps.fetchImpl,
                redact,
                onToolsChanged,
                handshakeTimeoutMs: deps.handshakeTimeoutMs,
                callTimeoutMs: deps.callTimeoutMs,
              })
            : await createStdioSession({
                command: server.command,
                args: server.args,
                cwd: server.cwd,
                hostEnv: deps.hostEnv ?? process.env,
                serverEnv: serverSecrets.env,
                redact,
                onToolsChanged,
                handshakeTimeoutMs: deps.handshakeTimeoutMs,
                callTimeoutMs: deps.callTimeoutMs,
              })

        if (globalEpoch !== startEpoch || getGen(serverId) !== startGen) {
          await session.close().catch(() => {})
          throw new McpCallError('connect_failed', 'MCP connection superseded during handshake', false)
        }

        sessions.set(serverId, session)
        return session
      } catch (err) {
        throw toRedactedCallError(serverId, err, 'connect_failed')
      } finally {
        if (connectTask && inflightConnects.get(serverId) === connectTask) {
          inflightConnects.delete(serverId)
        }
      }
    })()

    inflightConnects.set(serverId, connectTask)
    return connectTask
  }

  const discoverTools = async (serverId: string): Promise<McpDiscoveredTool[]> => {
    const server = getMcpServer(db, serverId)
    if (!server) {
      throw new McpCallError('not_found', `MCP server not found: ${serverId}`, false)
    }

    try {
      const session = await connect(serverId)
      const rawTools = await session.listTools()
      const normalized = sanitizeToolsList(rawTools)
      saveMcpDiscoveredTools(db, serverId, normalized, now())
      hub?.broadcast({ type: 'mcp_changed' })

      const latest = getMcpServer(db, serverId)
      if (!latest || !latest.enabled) {
        await disconnect(serverId)
      }
      return normalized
    } catch (err) {
      evictIfUnhealthy(serverId)
      const callErr = toRedactedCallError(serverId, err, 'connect_failed')
      markMcpServerStatus(db, serverId, 'error', callErr.message, now())
      hub?.broadcast({ type: 'mcp_changed' })
      throw callErr
    }
  }

  const ensureDiscovered = async (serverId: string): Promise<McpServerRow | null> => {
    const server = getMcpServer(db, serverId)
    if (!server) return null
    if (server.enabled && server.tools.length === 0 && server.status === 'disconnected') {
      await discoverTools(serverId).catch(() => {})
      return getMcpServer(db, serverId)
    }
    return server
  }

  const callTool: McpManager['callTool'] = async (serverId, toolName, args, opts) => {
    const server = getMcpServer(db, serverId)
    if (!server) {
      throw new McpCallError('not_found', `MCP server not found: ${serverId}`, false)
    }
    if (!server.enabled) {
      throw new McpCallError('disabled', `MCP server "${server.name}" is paused`, false)
    }

    try {
      const session = await connect(serverId)
      const result = await session.callTool(toolName, args, opts)
      if (getMcpServer(db, serverId)?.status !== 'connected') {
        markMcpServerStatus(db, serverId, 'connected', '', now())
        hub?.broadcast({ type: 'mcp_changed' })
      }
      return result
    } catch (err) {
      const sessionDied = evictIfUnhealthy(serverId)
      const callErr = toRedactedCallError(serverId, err, 'connect_failed')
      if (sessionDied || callErr.code === 'connect_failed') {
        markMcpServerStatus(db, serverId, 'error', callErr.message, now())
        hub?.broadcast({ type: 'mcp_changed' })
      }
      throw callErr
    }
  }

  const disconnect = async (serverId: string): Promise<void> => {
    bumpGen(serverId)
    queuedRefreshes.delete(serverId)
    const active = sessions.get(serverId)
    sessions.delete(serverId)
    const inflight = inflightConnects.get(serverId)
    inflightConnects.delete(serverId)
    await Promise.allSettled([
      active ? active.close() : Promise.resolve(),
      inflight ? inflight.then((s) => s.close(), () => {}) : Promise.resolve(),
    ])
  }

  const closeAll = async (): Promise<void> => {
    globalEpoch += 1
    queuedRefreshes.clear()
    const activeList = [...sessions.values()]
    sessions.clear()
    const inflightList = [...inflightConnects.values()]
    inflightConnects.clear()
    await Promise.allSettled([
      ...activeList.map((s) => s.close()),
      ...inflightList.map((p) => p.then((s) => s.close(), () => {})),
    ])
  }

  return {
    discoverTools,
    ensureDiscovered,
    callTool,
    disconnect,
    closeAll,
  }
}
