import type { Hono } from 'hono'
import type { Db } from '../db.js'
import type { Hub } from '../hub.js'
import type { McpManager } from './client.js'
import { validateMcpHttpConfig } from './http-transport.js'
import { computeExposedToolNames, effectiveToolMode } from './naming.js'
import type { McpSecretVault } from './secrets.js'
import { validateMcpStdioConfig } from './stdio-transport.js'
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listAllBotMcpGrants,
  listMcpServers,
  markMcpServerStatus,
  saveMcpDiscoveredTools,
  setBotMcpServers,
  setMcpServerBots,
  updateMcpServer,
} from './store.js'
import type {
  McpServerRow,
  McpServerView,
  McpToolMode,
  McpToolView,
  McpTransportKind,
} from './types.js'

const MAX_IMPORT_SERVERS = 20
const IMPORT_DISCOVERY_CONCURRENCY = 4
const MAX_SERVER_NAME_CHARS = 120

export type ParsedMcpImportEntry = {
  name: string
  transport: McpTransportKind
  enabled: boolean
  command: string
  args: string[]
  cwd: string
  url: string
  env: Record<string, string>
  headers: Record<string, string>
}

export type McpServersSnapshot = {
  servers: McpServerView[]
  botGrants: Record<string, string[]>
}

export type McpApiDeps = {
  db: Db
  secrets: McpSecretVault
  manager: McpManager
  hub: Hub
  now?: () => number
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function validateServerName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('MCP server name must be a string')
  }
  const name = raw.trim()
  if (!name || name.length > MAX_SERVER_NAME_CHARS || name.includes('\0')) {
    throw new Error(`MCP server name must be 1 to ${MAX_SERVER_NAME_CHARS} characters without NUL bytes`)
  }
  return name
}

function parseSecretPatch(
  raw: unknown,
  kind: 'env' | 'headers',
  allowNull: boolean,
): Record<string, string | null> {
  if (raw === undefined) return {}
  if (!isObject(raw)) {
    throw new Error(`MCP ${kind} must be a JSON object`)
  }
  const out: Record<string, string | null> = {}
  for (const [rawKey, val] of Object.entries(raw)) {
    if (!Object.hasOwn(raw, rawKey)) continue
    const key = rawKey.trim()
    if (
      !key ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype' ||
      key.includes('\0') ||
      (kind === 'env' && key.includes('='))
    ) {
      throw new Error(`Invalid MCP ${kind} key: ${rawKey}`)
    }
    if (val === null) {
      if (!allowNull) {
        throw new Error(`MCP ${kind} value for ${key} must be a string`)
      }
      out[key] = null
    } else if (typeof val === 'string') {
      if (val.includes('\0') || (kind === 'headers' && /[\r\n]/.test(val))) {
        throw new Error(`Invalid MCP ${kind} value for ${key}`)
      }
      out[key] = val === '' ? null : val
    } else {
      throw new Error(`MCP ${kind} value for ${key} must be a string`)
    }
  }
  return out
}

function buildVaultPatchAndPreview(
  existing: Record<string, string>,
  patch: Record<string, string | null>,
  caseInsensitive: boolean,
): { vaultPatch: Record<string, string | null>; preview: Record<string, string> } {
  const preview = { ...existing }
  const vaultPatch: Record<string, string | null> = {}

  for (const [k, v] of Object.entries(patch)) {
    if (caseInsensitive) {
      for (const oldKey of Object.keys(preview)) {
        if (oldKey.toLowerCase() === k.toLowerCase() && oldKey !== k) {
          delete preview[oldKey]
          vaultPatch[oldKey] = null
        }
      }
    }
    if (v === null || v === '') {
      delete preview[k]
      vaultPatch[k] = null
    } else {
      preview[k] = v
      vaultPatch[k] = v
    }
  }

  return { vaultPatch, preview }
}

function parseToolPoliciesPatch(
  existing: Record<string, McpToolMode>,
  raw: unknown,
): Record<string, McpToolMode> {
  if (!isObject(raw)) {
    throw new Error('toolPolicies must be an object')
  }
  const next: Record<string, McpToolMode> = { ...existing }
  for (const [rawName, val] of Object.entries(raw)) {
    const key = rawName.trim()
    if (!key) {
      throw new Error('toolPolicies keys must be non-empty strings')
    }
    if (val === 'read' || val === 'write') {
      next[key] = val
    } else if (val === 'default' || val === null) {
      delete next[key]
    } else {
      throw new Error(`Invalid tool policy for "${key}": must be "read", "write", or "default"`)
    }
  }
  return next
}

export function parseMcpServersImportJson(
  raw: string,
): { entries: ParsedMcpImportEntry[]; errors: { name: string; error: string }[] } {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('MCP import JSON must be a non-empty JSON object')
  }

  let root: unknown
  try {
    root = JSON.parse(raw)
  } catch {
    throw new Error('MCP import payload is not valid JSON')
  }

  if (!isObject(root)) {
    throw new Error('MCP import JSON root must be an object')
  }

  let serverMap: Record<string, unknown>
  if ('mcpServers' in root) {
    if (!isObject(root.mcpServers)) {
      throw new Error('"mcpServers" must be a JSON object')
    }
    serverMap = root.mcpServers
  } else {
    serverMap = root
  }

  const rawEntries = Object.entries(serverMap)
  if (rawEntries.length > MAX_IMPORT_SERVERS) {
    throw new Error(`MCP import supports at most ${MAX_IMPORT_SERVERS} servers per import`)
  }

  const entries: ParsedMcpImportEntry[] = []
  const errors: { name: string; error: string }[] = []

  for (const [rawName, rawCfg] of rawEntries) {
    try {
      const name = validateServerName(rawName)
      if (!isObject(rawCfg)) {
        throw new Error('MCP server configuration must be a JSON object')
      }
      if (rawCfg.enabled !== undefined && typeof rawCfg.enabled !== 'boolean') {
        throw new Error('MCP server "enabled" must be a boolean')
      }
      if (rawCfg.disabled !== undefined && typeof rawCfg.disabled !== 'boolean') {
        throw new Error('MCP server "disabled" must be a boolean')
      }
      const enabled = rawCfg.enabled === false || rawCfg.disabled === true ? false : true

      const hasCommand = rawCfg.command !== undefined
      const hasUrl = rawCfg.url !== undefined || rawCfg.serverUrl !== undefined

      if (hasCommand && hasUrl) {
        throw new Error('MCP server configuration cannot specify both "command" and "url"')
      }

      if (hasCommand) {
        if (typeof rawCfg.command !== 'string') {
          throw new Error('MCP stdio "command" must be a string')
        }
        if (
          rawCfg.args !== undefined &&
          (!Array.isArray(rawCfg.args) || !rawCfg.args.every((item) => typeof item === 'string'))
        ) {
          throw new Error('MCP stdio "args" must be an array of strings')
        }
        if (rawCfg.cwd !== undefined && typeof rawCfg.cwd !== 'string') {
          throw new Error('MCP stdio "cwd" must be a string')
        }

        const validStdio = validateMcpStdioConfig(
          rawCfg.command,
          (rawCfg.args as string[] | undefined) ?? [],
          (rawCfg.cwd as string | undefined) ?? '',
        )
        const envPatch = parseSecretPatch(rawCfg.env, 'env', false)
        const { preview: env } = buildVaultPatchAndPreview({}, envPatch, false)

        entries.push({
          name,
          transport: 'stdio',
          enabled,
          command: validStdio.command,
          args: validStdio.args,
          cwd: validStdio.cwd,
          url: '',
          env,
          headers: {},
        })
      } else if (hasUrl) {
        const rawUrl = rawCfg.url !== undefined ? rawCfg.url : rawCfg.serverUrl
        if (typeof rawUrl !== 'string') {
          throw new Error('MCP HTTP "url" must be a string')
        }
        if (rawCfg.headers !== undefined && !isObject(rawCfg.headers)) {
          throw new Error('MCP HTTP "headers" must be a JSON object')
        }
        // Validate raw headers before case-collapsing so duplicate header names are caught
        const rawHeaders: Record<string, string> = {}
        if (rawCfg.headers) {
          for (const [hk, hv] of Object.entries(rawCfg.headers)) {
            if (typeof hv !== 'string') {
              throw new Error(`MCP headers value for ${hk} must be a string`)
            }
            if (hv.length > 0) {
              rawHeaders[hk] = hv
            }
          }
        }
        const validHttp = validateMcpHttpConfig(rawUrl, rawHeaders)

        entries.push({
          name,
          transport: 'http',
          enabled,
          command: '',
          args: [],
          cwd: '',
          url: rawUrl.trim(),
          env: {},
          headers: validHttp.headers,
        })
      } else {
        throw new Error('MCP server entry must specify either "command" (stdio) or "url" (http)')
      }
    } catch (err) {
      errors.push({
        name: rawName.trim() || '(unnamed)',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { entries, errors }
}

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  let index = 0
  const count = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (index < items.length) {
        const item = items[index++]!
        await worker(item)
      }
    }),
  )
}

function isCancellationError(msg: string): boolean {
  return (
    msg.includes('MCP connection superseded during handshake') ||
    msg.includes('MCP stdio session closed') ||
    msg.includes('MCP HTTP session closed') ||
    msg.includes('MCP legacy SSE session closed')
  )
}

export function mountMcp(
  app: Hono,
  deps: { db: Db; secrets: McpSecretVault; manager: McpManager; hub: Hub; now?: () => number },
): { stop(): void } {
  const { db, secrets, manager, hub } = deps
  const clock = deps.now ?? Date.now

  let apiEpoch = 0
  const serverGens = new Map<string, number>()
  const getGen = (serverId: string): number => serverGens.get(serverId) ?? 0
  const bumpGen = (serverId: string): number => {
    const next = getGen(serverId) + 1
    serverGens.set(serverId, next)
    return next
  }
  const isCurrent = (serverId: string, epoch: number, gen: number): boolean =>
    apiEpoch === epoch && getGen(serverId) === gen

  const serverBotIds = (serverId: string): string[] =>
    (
      db
        .prepare(
          `SELECT b.bot_id FROM bot_mcp_servers b
           JOIN bots ON bots.id = b.bot_id
           WHERE b.server_id = ?
           ORDER BY b.bot_id`,
        )
        .all(serverId) as { bot_id: string }[]
    ).map((r) => r.bot_id)

  const toView = (row: McpServerRow, grantedBotIds: string[]): McpServerView => {
    const { envMasked, headersMasked } = secrets.masked(row.id)
    const exposedNames = computeExposedToolNames(row.slug, row.tools)
    const tools: McpToolView[] = row.tools.map((tool) => {
      const override = row.toolPolicies[tool.name]
      return {
        ...tool,
        overrideMode: override === 'read' || override === 'write' ? override : null,
        effectiveMode: effectiveToolMode(row, tool),
        exposedName: exposedNames.get(tool.name) ?? `mcp__${row.slug}__tool`,
      }
    })

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      transport: row.transport,
      enabled: row.enabled,
      command: row.command,
      args: row.args,
      cwd: row.cwd,
      url: row.url,
      envKeys: row.envKeys,
      headerKeys: row.headerKeys,
      envMasked,
      headersMasked,
      trustReadOnlyHint: row.trustReadOnlyHint,
      tools,
      toolPolicies: row.toolPolicies,
      status: row.status,
      lastError: row.lastError,
      grantedBotIds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  const viewById = (id: string): McpServerView | null => {
    const row = getMcpServer(db, id)
    if (!row) return null
    return toView(row, serverBotIds(id))
  }

  const snapshot = (): McpServersSnapshot => {
    const botGrants = listAllBotMcpGrants(db)
    const botsByServer = new Map<string, string[]>()
    for (const [botId, serverIds] of Object.entries(botGrants)) {
      for (const sid of serverIds) {
        const list = botsByServer.get(sid)
        if (list) list.push(botId)
        else botsByServer.set(sid, [botId])
      }
    }
    const servers = listMcpServers(db).map((row) => toView(row, botsByServer.get(row.id) ?? []))
    return { servers, botGrants }
  }

  const runDiscovery = async (
    serverId: string,
    opts: { allowPaused?: boolean; opEpoch?: number; opGen?: number } = {},
  ): Promise<boolean> => {
    const opEpoch = opts.opEpoch ?? apiEpoch
    const opGen = opts.opGen ?? getGen(serverId)

    try {
      const tools = await manager.discoverTools(serverId)
      if (!isCurrent(serverId, opEpoch, opGen)) return false
      const current = getMcpServer(db, serverId)
      if (!current) return false
      if (!opts.allowPaused && !current.enabled) return false
      saveMcpDiscoveredTools(db, serverId, tools, clock())
      return true
    } catch (err) {
      if (!isCurrent(serverId, opEpoch, opGen)) return false
      const rawMsg = err instanceof Error ? err.message : String(err)
      if (isCancellationError(rawMsg)) return false
      const current = getMcpServer(db, serverId)
      if (!current) return false
      if (!opts.allowPaused && !current.enabled) return false
      const cleanMsg = secrets.redactText(serverId, rawMsg)
      markMcpServerStatus(db, serverId, 'error', cleanMsg, clock())
      return true
    }
  }

  app.get('/api/mcp/servers', (c) => c.json(snapshot()))

  app.post('/api/mcp/servers', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) {
      return c.json({ error: 'invalid request body', code: 'invalid_body' }, 400)
    }

    let name: string
    try {
      name = validateServerName(body.name)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'invalid name', code: 'invalid_name' }, 400)
    }

    if (body.transport !== 'stdio' && body.transport !== 'http') {
      return c.json({ error: 'transport must be "stdio" or "http"', code: 'invalid_transport' }, 400)
    }
    const transport: McpTransportKind = body.transport

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean', code: 'invalid_enabled' }, 400)
    }
    if (body.trustReadOnlyHint !== undefined && typeof body.trustReadOnlyHint !== 'boolean') {
      return c.json({ error: 'trustReadOnlyHint must be a boolean', code: 'invalid_trust_hint' }, 400)
    }
    if (body.connectNow !== undefined && typeof body.connectNow !== 'boolean') {
      return c.json({ error: 'connectNow must be a boolean', code: 'invalid_connect_now' }, 400)
    }
    if (body.botIds !== undefined && (!Array.isArray(body.botIds) || !body.botIds.every((id) => typeof id === 'string'))) {
      return c.json({ error: 'botIds must be an array of strings', code: 'invalid_bots' }, 400)
    }

    let toolPolicies: Record<string, McpToolMode> = {}
    if (body.toolPolicies !== undefined) {
      try {
        toolPolicies = parseToolPoliciesPatch({}, body.toolPolicies)
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'invalid toolPolicies', code: 'invalid_policies' }, 400)
      }
    }

    let command = ''
    let args: string[] = []
    let cwd = ''
    let url = ''
    let envMap: Record<string, string> = {}
    let headersMap: Record<string, string> = {}

    try {
      if (transport === 'stdio') {
        if (typeof body.command !== 'string') {
          return c.json({ error: 'command is required for stdio MCP server', code: 'invalid_stdio' }, 400)
        }
        if (body.args !== undefined && (!Array.isArray(body.args) || !body.args.every((a) => typeof a === 'string'))) {
          return c.json({ error: 'args must be an array of strings', code: 'invalid_stdio' }, 400)
        }
        if (body.cwd !== undefined && typeof body.cwd !== 'string') {
          return c.json({ error: 'cwd must be a string', code: 'invalid_stdio' }, 400)
        }
        const validStdio = validateMcpStdioConfig(body.command, body.args ?? [], body.cwd ?? '')
        command = validStdio.command
        args = validStdio.args
        cwd = validStdio.cwd

        const envPatch = parseSecretPatch(body.env, 'env', true)
        envMap = buildVaultPatchAndPreview({}, envPatch, false).preview
      } else {
        if (typeof body.url !== 'string') {
          return c.json({ error: 'url is required for HTTP MCP server', code: 'invalid_http' }, 400)
        }
        if (body.headers !== undefined && !isObject(body.headers)) {
          return c.json({ error: 'headers must be an object', code: 'invalid_http' }, 400)
        }
        const rawHeaders: Record<string, string> = {}
        if (body.headers) {
          for (const [hk, hv] of Object.entries(body.headers)) {
            if (hv === null || hv === '') continue
            if (typeof hv !== 'string') {
              return c.json({ error: `header value for ${hk} must be a string`, code: 'invalid_http' }, 400)
            }
            rawHeaders[hk] = hv
          }
        }
        const validHttp = validateMcpHttpConfig(body.url, rawHeaders)
        url = body.url.trim()
        headersMap = validHttp.headers
      }
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : 'invalid MCP server configuration',
          code: transport === 'stdio' ? 'invalid_stdio' : 'invalid_http',
        },
        400,
      )
    }

    const at = clock()
    const enabled = body.enabled !== false
    const created = createMcpServer(db, {
      name,
      transport,
      enabled,
      command,
      args,
      cwd,
      url,
      envKeys: Object.keys(envMap),
      headerKeys: Object.keys(headersMap),
      trustReadOnlyHint: Boolean(body.trustReadOnlyHint),
      toolPolicies,
      now: at,
    })

    if (Object.keys(envMap).length > 0 || Object.keys(headersMap).length > 0) {
      secrets.patch(created.id, { env: envMap, headers: headersMap })
    }
    if (body.botIds?.length) {
      setMcpServerBots(db, created.id, body.botIds, at)
    }

    const createEpoch = apiEpoch
    const createGen = getGen(created.id)
    if (enabled && body.connectNow !== false) {
      await runDiscovery(created.id, { opEpoch: createEpoch, opGen: createGen })
    }

    const createdView = viewById(created.id)
    if (!createdView) {
      return c.json({ error: 'unknown MCP server', code: 'not_found' }, 404)
    }
    if (apiEpoch === createEpoch) {
      hub.broadcast({ type: 'mcp_changed' })
    }
    return c.json({ server: createdView }, 201)
  })

  app.post('/api/mcp/servers/import', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isObject(body) || typeof body.json !== 'string') {
      return c.json({ error: 'json string is required', code: 'invalid_body' }, 400)
    }
    if (body.botIds !== undefined && (!Array.isArray(body.botIds) || !body.botIds.every((id) => typeof id === 'string'))) {
      return c.json({ error: 'botIds must be an array of strings', code: 'invalid_bots' }, 400)
    }
    if (body.trustReadOnlyHint !== undefined && typeof body.trustReadOnlyHint !== 'boolean') {
      return c.json({ error: 'trustReadOnlyHint must be a boolean', code: 'invalid_trust_hint' }, 400)
    }
    if (body.connectNow !== undefined && typeof body.connectNow !== 'boolean') {
      return c.json({ error: 'connectNow must be a boolean', code: 'invalid_connect_now' }, 400)
    }

    let parsed: ReturnType<typeof parseMcpServersImportJson>
    try {
      parsed = parseMcpServersImportJson(body.json)
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'invalid MCP import JSON', code: 'invalid_import' },
        400,
      )
    }

    if (parsed.entries.length === 0 && parsed.errors.length === 0) {
      return c.json({ error: 'no MCP servers found in JSON', code: 'empty_import' }, 400)
    }

    const importEpoch = apiEpoch
    const createdIds: string[] = []
    const toDiscover: Array<{ id: string; gen: number }> = []

    for (const entry of parsed.entries) {
      const at = clock()
      const row = createMcpServer(db, {
        name: entry.name,
        transport: entry.transport,
        enabled: entry.enabled,
        command: entry.command,
        args: entry.args,
        cwd: entry.cwd,
        url: entry.url,
        envKeys: Object.keys(entry.env),
        headerKeys: Object.keys(entry.headers),
        trustReadOnlyHint: Boolean(body.trustReadOnlyHint),
        now: at,
      })

      if (Object.keys(entry.env).length > 0 || Object.keys(entry.headers).length > 0) {
        secrets.patch(row.id, { env: entry.env, headers: entry.headers })
      }
      if (body.botIds?.length) {
        setMcpServerBots(db, row.id, body.botIds, at)
      }

      createdIds.push(row.id)
      if (row.enabled && body.connectNow !== false) {
        toDiscover.push({ id: row.id, gen: getGen(row.id) })
      }
    }

    if (toDiscover.length > 0) {
      await runBounded(toDiscover, IMPORT_DISCOVERY_CONCURRENCY, async ({ id, gen }) => {
        await runDiscovery(id, { opEpoch: importEpoch, opGen: gen })
      })
    }

    const imported = createdIds.map((id) => viewById(id)).filter((v): v is McpServerView => v !== null)
    if (imported.length > 0 && apiEpoch === importEpoch) {
      hub.broadcast({ type: 'mcp_changed' })
    }

    return c.json({ imported, errors: parsed.errors })
  })

  app.patch('/api/mcp/servers/:id', async (c) => {
    const id = c.req.param('id')
    if (!getMcpServer(db, id)) {
      return c.json({ error: 'unknown MCP server', code: 'not_found' }, 404)
    }

    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) {
      return c.json({ error: 'invalid request body', code: 'invalid_body' }, 400)
    }

    // Synchronous read -> validate -> persist block (zero awaits before updateMcpServer)
    const existing = getMcpServer(db, id)
    if (!existing) {
      return c.json({ error: 'unknown MCP server', code: 'not_found' }, 404)
    }

    let name = existing.name
    if (body.name !== undefined) {
      try {
        name = validateServerName(body.name)
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'invalid name', code: 'invalid_name' }, 400)
      }
    }

    if (body.transport !== undefined && body.transport !== 'stdio' && body.transport !== 'http') {
      return c.json({ error: 'transport must be "stdio" or "http"', code: 'invalid_transport' }, 400)
    }
    const nextTransport: McpTransportKind = body.transport ?? existing.transport

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean', code: 'invalid_enabled' }, 400)
    }
    const nextEnabled = body.enabled ?? existing.enabled

    if (body.trustReadOnlyHint !== undefined && typeof body.trustReadOnlyHint !== 'boolean') {
      return c.json({ error: 'trustReadOnlyHint must be a boolean', code: 'invalid_trust_hint' }, 400)
    }
    const nextTrustHint = body.trustReadOnlyHint ?? existing.trustReadOnlyHint

    if (body.connectNow !== undefined && typeof body.connectNow !== 'boolean') {
      return c.json({ error: 'connectNow must be a boolean', code: 'invalid_connect_now' }, 400)
    }
    if (body.botIds !== undefined && (!Array.isArray(body.botIds) || !body.botIds.every((b) => typeof b === 'string'))) {
      return c.json({ error: 'botIds must be an array of strings', code: 'invalid_bots' }, 400)
    }

    let nextPolicies = existing.toolPolicies
    if (body.toolPolicies !== undefined) {
      try {
        nextPolicies = parseToolPoliciesPatch(existing.toolPolicies, body.toolPolicies)
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'invalid toolPolicies', code: 'invalid_policies' }, 400)
      }
    }

    const curSecrets = secrets.get(id)
    let envVaultPatch: Record<string, string | null> | undefined
    let headersVaultPatch: Record<string, string | null> | undefined
    let previewEnv = curSecrets.env
    let previewHeaders = curSecrets.headers

    try {
      if (body.env !== undefined) {
        const parsedEnv = parseSecretPatch(body.env, 'env', true)
        const merged = buildVaultPatchAndPreview(curSecrets.env, parsedEnv, false)
        envVaultPatch = merged.vaultPatch
        previewEnv = merged.preview
      }
      if (body.headers !== undefined) {
        const parsedHeaders = parseSecretPatch(body.headers, 'headers', true)
        const merged = buildVaultPatchAndPreview(curSecrets.headers, parsedHeaders, true)
        headersVaultPatch = merged.vaultPatch
        previewHeaders = merged.preview
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'invalid secrets patch', code: 'invalid_secrets' }, 400)
    }

    let nextCommand = existing.command
    let nextArgs = existing.args
    let nextCwd = existing.cwd
    let nextUrl = existing.url

    try {
      if (nextTransport === 'stdio') {
        if (body.command !== undefined && typeof body.command !== 'string') {
          return c.json({ error: 'command must be a string', code: 'invalid_stdio' }, 400)
        }
        if (body.args !== undefined && (!Array.isArray(body.args) || !body.args.every((a) => typeof a === 'string'))) {
          return c.json({ error: 'args must be an array of strings', code: 'invalid_stdio' }, 400)
        }
        if (body.cwd !== undefined && typeof body.cwd !== 'string') {
          return c.json({ error: 'cwd must be a string', code: 'invalid_stdio' }, 400)
        }
        if (
          body.transport !== undefined ||
          body.command !== undefined ||
          body.args !== undefined ||
          body.cwd !== undefined
        ) {
          const validStdio = validateMcpStdioConfig(
            body.command ?? existing.command,
            body.args ?? existing.args,
            body.cwd ?? existing.cwd,
          )
          nextCommand = validStdio.command
          nextArgs = validStdio.args
          nextCwd = validStdio.cwd
        }
        if (existing.transport === 'http') {
          nextUrl = ''
        }
      } else {
        if (body.url !== undefined && typeof body.url !== 'string') {
          return c.json({ error: 'url must be a string', code: 'invalid_http' }, 400)
        }
        if (body.transport !== undefined || body.url !== undefined || body.headers !== undefined) {
          const candidateUrl = body.url ?? existing.url
          const validHttp = validateMcpHttpConfig(candidateUrl, previewHeaders)
          nextUrl = candidateUrl.trim()
          previewHeaders = validHttp.headers
        }
        if (existing.transport === 'stdio') {
          nextCommand = ''
          nextArgs = []
          nextCwd = ''
        }
      }
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : 'invalid MCP server configuration',
          code: nextTransport === 'stdio' ? 'invalid_stdio' : 'invalid_http',
        },
        400,
      )
    }

    if (envVaultPatch !== undefined || headersVaultPatch !== undefined) {
      const saved = secrets.patch(id, {
        ...(envVaultPatch !== undefined ? { env: envVaultPatch } : {}),
        ...(headersVaultPatch !== undefined ? { headers: headersVaultPatch } : {}),
      })
      previewEnv = saved.env
      previewHeaders = saved.headers
    }

    const connectionChanged =
      body.transport !== undefined ||
      body.command !== undefined ||
      body.args !== undefined ||
      body.cwd !== undefined ||
      body.url !== undefined ||
      body.env !== undefined ||
      body.headers !== undefined

    const shouldResetStatus = !nextEnabled || (connectionChanged && existing.status === 'error')

    const at = clock()
    updateMcpServer(
      db,
      id,
      {
        name,
        transport: nextTransport,
        enabled: nextEnabled,
        command: nextCommand,
        args: nextArgs,
        cwd: nextCwd,
        url: nextUrl,
        envKeys: Object.keys(previewEnv),
        headerKeys: Object.keys(previewHeaders),
        trustReadOnlyHint: nextTrustHint,
        toolPolicies: nextPolicies,
        ...(shouldResetStatus ? { status: 'disconnected', lastError: '' } : {}),
      },
      at,
    )

    if (body.botIds !== undefined) {
      setMcpServerBots(db, id, body.botIds, at)
    }

    const patchEpoch = apiEpoch
    const patchGen = bumpGen(id)
    if (apiEpoch === patchEpoch) {
      hub.broadcast({ type: 'mcp_changed' })
    }

    await manager.disconnect(id)

    if (nextEnabled && body.connectNow === true && isCurrent(id, patchEpoch, patchGen)) {
      const discovered = await runDiscovery(id, { opEpoch: patchEpoch, opGen: patchGen })
      if (discovered && isCurrent(id, patchEpoch, patchGen)) {
        hub.broadcast({ type: 'mcp_changed' })
      }
    }

    const patchedView = viewById(id)
    if (!patchedView) {
      return c.json({ error: 'unknown MCP server', code: 'not_found' }, 404)
    }
    return c.json({ server: patchedView })
  })

  app.post('/api/mcp/servers/:id/test', async (c) => {
    const id = c.req.param('id')
    const existing = getMcpServer(db, id)
    if (!existing) {
      return c.json({ error: 'unknown MCP server', code: 'not_found' }, 404)
    }

    const testEpoch = apiEpoch
    const testGen = bumpGen(id)
    await manager.disconnect(id)
    if (isCurrent(id, testEpoch, testGen)) {
      const updated = await runDiscovery(id, { allowPaused: true, opEpoch: testEpoch, opGen: testGen })
      if (updated && isCurrent(id, testEpoch, testGen)) {
        hub.broadcast({ type: 'mcp_changed' })
      }
    }

    const testedView = viewById(id)
    if (!testedView) {
      return c.json({ error: 'unknown MCP server', code: 'not_found' }, 404)
    }
    return c.json({ server: testedView })
  })

  app.put('/api/mcp/servers/:id/bots', async (c) => {
    const id = c.req.param('id')
    const existing = getMcpServer(db, id)
    if (!existing) {
      return c.json({ error: 'unknown MCP server', code: 'not_found' }, 404)
    }

    const body = await c.req.json().catch(() => null)
    if (!isObject(body) || !Array.isArray(body.botIds) || !body.botIds.every((b) => typeof b === 'string')) {
      return c.json({ error: 'botIds must be an array of strings', code: 'invalid_bots' }, 400)
    }

    setMcpServerBots(db, id, body.botIds, clock())
    const server = viewById(id)
    if (!server) {
      return c.json({ error: 'unknown MCP server', code: 'not_found' }, 404)
    }
    hub.broadcast({ type: 'mcp_changed' })
    return c.json({ server, botIds: server.grantedBotIds })
  })

  app.put('/api/bots/:botId/mcp', async (c) => {
    const botId = c.req.param('botId')
    const exists = db.prepare('SELECT 1 FROM bots WHERE id = ?').get(botId)
    if (!exists) {
      return c.json({ error: 'unknown bot' }, 404)
    }

    const body = await c.req.json().catch(() => null)
    if (!isObject(body) || !Array.isArray(body.serverIds) || !body.serverIds.every((s) => typeof s === 'string')) {
      return c.json({ error: 'serverIds must be an array of strings', code: 'invalid_servers' }, 400)
    }

    const updated = setBotMcpServers(db, botId, body.serverIds, clock())
    hub.broadcast({ type: 'mcp_changed' })
    return c.json({ botId, serverIds: updated })
  })

  app.delete('/api/mcp/servers/:id', async (c) => {
    const id = c.req.param('id')
    const existing = getMcpServer(db, id)
    if (!existing) {
      return c.json({ error: 'unknown MCP server', code: 'not_found' }, 404)
    }

    const delEpoch = apiEpoch
    bumpGen(id)
    deleteMcpServer(db, id)
    secrets.remove(id)
    if (apiEpoch === delEpoch) {
      hub.broadcast({ type: 'mcp_changed' })
    }
    await manager.disconnect(id)
    return c.json({ ok: true, state: snapshot() })
  })

  return {
    stop() {
      apiEpoch += 1
    },
  }
}
