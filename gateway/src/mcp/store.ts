import { randomBytes } from 'node:crypto'
import type { Db } from '../db.js'
import type { McpDiscoveredTool, McpServerRow, McpServerStatus, McpToolMode, McpTransportKind } from './types.js'

const ID_RE = /^mcp-[0-9a-f]{8}$/

export const isMcpServerId = (id: string): boolean => ID_RE.test(id)

export function normalizeMcpSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20)
    .replace(/_+$/, '')
  return cleaned || 'server'
}

function uniqueMcpSlug(db: Db, raw: string): string {
  const base = normalizeMcpSlug(raw)
  const exists = db.prepare('SELECT 1 FROM mcp_servers WHERE slug = ?')
  if (!exists.get(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `_${n}`
    const headLen = Math.min(17, Math.max(1, 20 - suffix.length))
    const prefix = (base.slice(0, headLen).replace(/_+$/, '') || 'server').slice(0, headLen)
    const candidate = `${prefix}${suffix}`
    if (!exists.get(candidate)) return candidate
  }
}

type RawMcpServerRow = {
  id: string
  name: string
  slug: string
  transport: string
  enabled: number
  command: string
  args_json: string
  cwd: string
  url: string
  env_keys_json: string
  header_keys_json: string
  trust_read_only_hint: number
  tools_json: string
  tool_policies_json: string
  status: string
  last_error: string
  created_at: number
  updated_at: number
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function parseTools(json: string): McpDiscoveredTool[] {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    const out: McpDiscoveredTool[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || typeof (item as { name?: unknown }).name !== 'string') continue
      const t = item as Partial<McpDiscoveredTool>
      out.push({
        name: t.name!,
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema:
          t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
            ? t.inputSchema
            : { type: 'object', properties: {} },
        readOnlyHint: Boolean(t.readOnlyHint),
        destructiveHint: Boolean(t.destructiveHint),
      })
    }
    return out
  } catch {
    return []
  }
}

function parseToolPolicies(json: string): Record<string, McpToolMode> {
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, McpToolMode> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === 'read' || v === 'write') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function sanitizeSortedKeys(keys?: readonly string[]): string[] {
  if (!keys) return []
  return [...new Set(keys.map((k) => k.trim()).filter(Boolean))].sort()
}

function sanitizeToolPolicies(policies?: Record<string, McpToolMode>): Record<string, McpToolMode> {
  if (!policies) return {}
  const out: Record<string, McpToolMode> = {}
  for (const [k, v] of Object.entries(policies)) {
    if (k && (v === 'read' || v === 'write')) out[k] = v
  }
  return out
}

function mapRow(r: RawMcpServerRow): McpServerRow {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    transport: r.transport === 'http' ? 'http' : 'stdio',
    enabled: r.enabled === 1,
    command: r.command,
    args: parseStringArray(r.args_json),
    cwd: r.cwd,
    url: r.url,
    envKeys: parseStringArray(r.env_keys_json),
    headerKeys: parseStringArray(r.header_keys_json),
    trustReadOnlyHint: r.trust_read_only_hint === 1,
    tools: parseTools(r.tools_json),
    toolPolicies: parseToolPolicies(r.tool_policies_json),
    status: r.status === 'connected' || r.status === 'error' ? r.status : 'disconnected',
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export type CreateMcpServerInput = {
  name: string
  slug?: string
  transport: McpTransportKind
  enabled?: boolean
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  envKeys?: string[]
  headerKeys?: string[]
  trustReadOnlyHint?: boolean
  tools?: McpDiscoveredTool[]
  toolPolicies?: Record<string, McpToolMode>
  status?: McpServerStatus
  lastError?: string
  now?: number
}

export type UpdateMcpServerPatch = {
  name?: string
  transport?: McpTransportKind
  enabled?: boolean
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  envKeys?: string[]
  headerKeys?: string[]
  trustReadOnlyHint?: boolean
  tools?: McpDiscoveredTool[]
  toolPolicies?: Record<string, McpToolMode>
  status?: McpServerStatus
  lastError?: string
}

export function createMcpServer(db: Db, input: CreateMcpServerInput): McpServerRow {
  const at = input.now ?? Date.now()
  const existsId = db.prepare('SELECT 1 FROM mcp_servers WHERE id = ?')
  let id = `mcp-${randomBytes(4).toString('hex')}`
  while (existsId.get(id)) {
    id = `mcp-${randomBytes(4).toString('hex')}`
  }
  const slug = uniqueMcpSlug(db, input.slug ?? input.name)
  const enabled = input.enabled === false ? 0 : 1
  const trustReadOnlyHint = input.trustReadOnlyHint ? 1 : 0
  const envKeys = sanitizeSortedKeys(input.envKeys)
  const headerKeys = sanitizeSortedKeys(input.headerKeys)
  const toolPolicies = sanitizeToolPolicies(input.toolPolicies)

  db.prepare(
    `INSERT INTO mcp_servers (
       id, name, slug, transport, enabled, command, args_json, cwd, url,
       env_keys_json, header_keys_json, trust_read_only_hint, tools_json,
       tool_policies_json, status, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    slug,
    input.transport,
    enabled,
    input.command ?? '',
    JSON.stringify(input.args ?? []),
    input.cwd ?? '',
    input.url ?? '',
    JSON.stringify(envKeys),
    JSON.stringify(headerKeys),
    trustReadOnlyHint,
    JSON.stringify(input.tools ?? []),
    JSON.stringify(toolPolicies),
    input.status ?? 'disconnected',
    (input.lastError ?? '').slice(0, 1000),
    at,
    at,
  )
  return getMcpServer(db, id)!
}

export function getMcpServer(db: Db, id: string): McpServerRow | null {
  if (!isMcpServerId(id)) return null
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as RawMcpServerRow | undefined
  return row ? mapRow(row) : null
}

export function listMcpServers(db: Db): McpServerRow[] {
  const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC, id ASC').all() as RawMcpServerRow[]
  return rows.map(mapRow)
}

export function updateMcpServer(
  db: Db,
  id: string,
  patch: UpdateMcpServerPatch,
  now = Date.now(),
): McpServerRow | null {
  const existing = getMcpServer(db, id)
  if (!existing) return null

  const name = patch.name ?? existing.name
  const transport = patch.transport ?? existing.transport
  const enabled = (patch.enabled ?? existing.enabled) ? 1 : 0
  const command = patch.command ?? existing.command
  const args = patch.args ?? existing.args
  const cwd = patch.cwd ?? existing.cwd
  const url = patch.url ?? existing.url
  const envKeys = patch.envKeys ? sanitizeSortedKeys(patch.envKeys) : existing.envKeys
  const headerKeys = patch.headerKeys ? sanitizeSortedKeys(patch.headerKeys) : existing.headerKeys
  const trustReadOnlyHint = (patch.trustReadOnlyHint ?? existing.trustReadOnlyHint) ? 1 : 0
  const tools = patch.tools ?? existing.tools
  const toolPolicies = patch.toolPolicies ? sanitizeToolPolicies(patch.toolPolicies) : existing.toolPolicies
  const status = patch.status ?? existing.status
  const lastError = (patch.lastError ?? existing.lastError).slice(0, 1000)

  db.prepare(
    `UPDATE mcp_servers
     SET name = ?, transport = ?, enabled = ?, command = ?, args_json = ?, cwd = ?, url = ?,
         env_keys_json = ?, header_keys_json = ?, trust_read_only_hint = ?, tools_json = ?,
         tool_policies_json = ?, status = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    name,
    transport,
    enabled,
    command,
    JSON.stringify(args),
    cwd,
    url,
    JSON.stringify(envKeys),
    JSON.stringify(headerKeys),
    trustReadOnlyHint,
    JSON.stringify(tools),
    JSON.stringify(toolPolicies),
    status,
    lastError,
    now,
    id,
  )
  return getMcpServer(db, id)
}

export function saveMcpDiscoveredTools(
  db: Db,
  id: string,
  tools: McpDiscoveredTool[],
  now = Date.now(),
): McpServerRow | null {
  if (!isMcpServerId(id)) return null
  const info = db.prepare(
    `UPDATE mcp_servers
     SET tools_json = ?, status = 'connected', last_error = '', updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(tools), now, id)
  return info.changes === 0 ? null : getMcpServer(db, id)
}

export function markMcpServerStatus(
  db: Db,
  id: string,
  status: McpServerStatus,
  lastError = '',
  now = Date.now(),
): boolean {
  if (!isMcpServerId(id)) return false
  const info = db.prepare(
    `UPDATE mcp_servers SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(status, lastError.slice(0, 1000), now, id)
  return info.changes > 0
}

export function deleteMcpServer(db: Db, id: string): boolean {
  if (!isMcpServerId(id)) return false
  let removed = false
  db.transaction(() => {
    db.prepare('DELETE FROM bot_mcp_servers WHERE server_id = ?').run(id)
    removed = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0
  })()
  return removed
}

export function setBotMcpServers(db: Db, botId: string, serverIds: string[], now = Date.now()): string[] {
  const valid = [...new Set(serverIds)].filter((id) => Boolean(getMcpServer(db, id)))
  db.transaction(() => {
    db.prepare('DELETE FROM bot_mcp_servers WHERE bot_id = ?').run(botId)
    const ins = db.prepare('INSERT INTO bot_mcp_servers (bot_id, server_id, created_at) VALUES (?, ?, ?)')
    for (const sid of valid) ins.run(botId, sid, now)
  })()
  return listBotMcpServerIds(db, botId)
}

export function setMcpServerBots(db: Db, serverId: string, botIds: string[], now = Date.now()): void {
  if (!getMcpServer(db, serverId)) return
  const existingBots = new Set((db.prepare('SELECT id FROM bots').all() as { id: string }[]).map((r) => r.id))
  const valid = [...new Set(botIds)].filter((b) => existingBots.has(b))
  db.transaction(() => {
    db.prepare('DELETE FROM bot_mcp_servers WHERE server_id = ?').run(serverId)
    const ins = db.prepare('INSERT INTO bot_mcp_servers (bot_id, server_id, created_at) VALUES (?, ?, ?)')
    for (const bid of valid) ins.run(bid, serverId, now)
  })()
}

export function listBotMcpServerIds(db: Db, botId: string): string[] {
  return (
    db.prepare('SELECT server_id FROM bot_mcp_servers WHERE bot_id = ? ORDER BY server_id').all(botId) as {
      server_id: string
    }[]
  ).map((r) => r.server_id)
}

export function listAllBotMcpGrants(db: Db): Record<string, string[]> {
  const bots = (db.prepare('SELECT id FROM bots ORDER BY id').all() as { id: string }[]).map((r) => r.id)
  const out: Record<string, string[]> = Object.fromEntries(bots.map((id) => [id, []]))
  const rows = db.prepare('SELECT bot_id, server_id FROM bot_mcp_servers ORDER BY server_id').all() as {
    bot_id: string
    server_id: string
  }[]
  for (const r of rows) {
    if (out[r.bot_id]) out[r.bot_id]!.push(r.server_id)
  }
  return out
}

export function listEnabledBotMcpServers(db: Db, botId: string): McpServerRow[] {
  const rows = db.prepare(
    `SELECT s.* FROM mcp_servers s
     JOIN bot_mcp_servers b ON b.server_id = s.id
     WHERE b.bot_id = ? AND s.enabled = 1
     ORDER BY s.created_at ASC, s.id ASC`,
  ).all(botId) as RawMcpServerRow[]
  return rows.map(mapRow)
}

export function listBotMcpServersAllStatuses(db: Db, botId: string): McpServerRow[] {
  const rows = db.prepare(
    `SELECT s.* FROM mcp_servers s
     JOIN bot_mcp_servers b ON b.server_id = s.id
     WHERE b.bot_id = ?
     ORDER BY s.created_at ASC, s.id ASC`,
  ).all(botId) as RawMcpServerRow[]
  return rows.map(mapRow)
}
