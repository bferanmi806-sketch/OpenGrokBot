import { randomUUID } from 'node:crypto'
import type { ActionTrigger } from '../actions.js'
import type { AgentEvents } from '../agent.js'
import { buildMcpEditable, formatMcpWriteApprovalDetail } from '../approval-edit.js'
import { blockText, canRemember, createApproval, rememberReason } from '../approvals.js'
import { insertMessage, type Db } from '../db.js'
import type { ToolDef } from '../llm.js'
import { safeSliceHead } from '../spill.js'
import { computeExposedToolNames, effectiveToolMode, mcpLoaderToolName } from './naming.js'
import { isRecord, normalizeMcpInputSchema } from './stdio-transport.js'
import { listEnabledBotMcpServers } from './store.js'
import {
  McpCallError,
  type FrozenMcpExecution,
  type McpCallResult,
  type McpDiscoveredTool,
  type McpManager,
  type McpServerRow,
  type McpToolMode,
  type McpWriteExecutionResult,
} from './types.js'

const MAX_MCP_RESULT_CHARS = 16_000
const MAX_MCP_WRITE_SUMMARY_CHARS = 2_000
const TRUNCATED_MARKER = '\n[…truncated]'

function truncateBounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let keep = Math.max(0, maxChars - TRUNCATED_MARKER.length)
  if (keep > 0) {
    const code = text.charCodeAt(keep - 1)
    if (code >= 0xd800 && code <= 0xdbff) keep -= 1
  }
  return `${text.slice(0, keep)}${TRUNCATED_MARKER}`
}

/** 单服务超过此工具数或 Schema 序列化总长超过此阈值时自动切换按需加载（借鉴 DeepSeek Harness MCP on-demand）。 */
export const MCP_ON_DEMAND_TOOL_COUNT = 8
export const MCP_ON_DEMAND_SCHEMA_CHARS = 12_000
export const MCP_CATALOG_DESC_MAX_CHARS = 120

export type McpResolvedTool = {
  server: McpServerRow
  tool: McpDiscoveredTool
  mode: McpToolMode
  exposedName: string
}

export type McpCatalogEntry = {
  name: string
  rawName: string
  summary: string
  mode: McpToolMode
}

export type McpOnDemandServer = {
  serverId: string
  serverName: string
  serverSlug: string
  loaderName: string
  entries: McpCatalogEntry[]
  defsByExposedName: Map<string, ToolDef>
  exposedByRawName: Map<string, string>
  readNames: Set<string>
}

export type McpToolSet = {
  tools: ToolDef[]
  readToolNames: Set<string>
  lookup: Map<string, McpResolvedTool>
  /** 按 loader 工具名索引的大 MCP 按需加载器 */
  loaders: Map<string, McpOnDemandServer>
  /** 尚未加载的按需 MCP 工具名 -> 所属加载器元信息 */
  deferredTools: Map<string, { loaderName: string; serverName: string }>
  /** 供系统提示词渲染的紧凑按需目录（按 server.id 索引） */
  promptCatalogs: Map<string, { loaderName: string; tools: McpCatalogEntry[] }>
}

function catalogSummary(description: string): string {
  const firstLine = description
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? ''
  if (firstLine.length <= MCP_CATALOG_DESC_MAX_CHARS) return firstLine
  return `${safeSliceHead(firstLine, MCP_CATALOG_DESC_MAX_CHARS)}…`
}

export function buildMcpToolSet(
  servers: readonly McpServerRow[],
  opts: {
    watch?: boolean
    onDemand?: 'auto' | 'always' | 'never'
    toolCountThreshold?: number
    schemaCharsThreshold?: number
  } = {},
): McpToolSet {
  const tools: ToolDef[] = []
  const readToolNames = new Set<string>()
  const lookup = new Map<string, McpResolvedTool>()
  const loaders = new Map<string, McpOnDemandServer>()
  const deferredTools = new Map<string, { loaderName: string; serverName: string }>()
  const promptCatalogs = new Map<string, { loaderName: string; tools: McpCatalogEntry[] }>()

  const onDemandMode = opts.onDemand ?? 'auto'
  const countThreshold = opts.toolCountThreshold ?? MCP_ON_DEMAND_TOOL_COUNT
  const charsThreshold = opts.schemaCharsThreshold ?? MCP_ON_DEMAND_SCHEMA_CHARS

  for (const server of servers) {
    if (!server.enabled) continue
    const exposedMap = computeExposedToolNames(server.slug, server.tools)
    const candidates: { resolved: McpResolvedTool; def: ToolDef }[] = []

    for (const tool of server.tools) {
      const exposedName = exposedMap.get(tool.name)
      if (!exposedName || lookup.has(exposedName)) continue

      const mode = effectiveToolMode(server, tool)
      if (opts.watch && mode !== 'read') continue

      const modeLabel = mode === 'write' ? ' · held for operator approval' : ''
      const baseDesc = tool.description.trim() || `Call "${tool.name}" on ${server.name}.`
      const description = `[${server.name} MCP${modeLabel}] ${baseDesc}`
      const def: ToolDef = {
        type: 'function',
        function: {
          name: exposedName,
          description,
          parameters: normalizeMcpInputSchema(tool.inputSchema),
        },
      }
      const resolved: McpResolvedTool = { server, tool, mode, exposedName }
      lookup.set(exposedName, resolved)
      candidates.push({ resolved, def })
    }

    if (candidates.length === 0) continue

    const schemaChars = candidates.reduce((total, c) => total + JSON.stringify(c.def).length, 0)
    const useOnDemand = onDemandMode === 'always'
      || (onDemandMode === 'auto' && (candidates.length > countThreshold || schemaChars > charsThreshold))

    if (!useOnDemand) {
      for (const { resolved, def } of candidates) {
        if (resolved.mode === 'read') readToolNames.add(resolved.exposedName)
        tools.push(def)
      }
      continue
    }

    const loaderName = mcpLoaderToolName(server.slug)
    if (loaders.has(loaderName)) {
      // 极端 slug 截断冲突时回退 eager，不覆盖已有加载器
      for (const { resolved, def } of candidates) {
        if (resolved.mode === 'read') readToolNames.add(resolved.exposedName)
        tools.push(def)
      }
      continue
    }

    const entries: McpCatalogEntry[] = []
    const defsByExposedName = new Map<string, ToolDef>()
    const exposedByRawName = new Map<string, string>()
    const serverReadNames = new Set<string>()

    for (const { resolved, def } of candidates) {
      // 与加载器本身重名的上游工具不纳入目录，防止遮蔽加载器
      if (resolved.exposedName === loaderName) continue
      entries.push({
        name: resolved.exposedName,
        rawName: resolved.tool.name,
        summary: catalogSummary(resolved.tool.description),
        mode: resolved.mode,
      })
      defsByExposedName.set(resolved.exposedName, def)
      exposedByRawName.set(resolved.tool.name, resolved.exposedName)
      if (resolved.mode === 'read') serverReadNames.add(resolved.exposedName)
      deferredTools.set(resolved.exposedName, { loaderName, serverName: server.name })
    }

    if (entries.length === 0) continue

    const loaderDef: ToolDef = {
      type: 'function',
      function: {
        name: loaderName,
        description: `[${server.name} MCP] Load full parameter schemas for specific ${server.name} tools from the catalog before calling them.`,
        parameters: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Tool names from the catalog (full mcp__ name or raw name) to activate for this turn.',
            },
          },
          required: ['tools'],
        },
      },
    }

    tools.push(loaderDef)
    // 加载器本身只读取本地已发现的 schema，无副作用，watch 巡检回合也允许加载只读工具
    readToolNames.add(loaderName)
    loaders.set(loaderName, {
      serverId: server.id,
      serverName: server.name,
      serverSlug: server.slug,
      loaderName,
      entries,
      defsByExposedName,
      exposedByRawName,
      readNames: serverReadNames,
    })
    promptCatalogs.set(server.id, { loaderName, tools: entries })
  }

  return { tools, readToolNames, lookup, loaders, deferredTools, promptCatalogs }
}

export function formatMcpCallResult(result: McpCallResult): string {
  const parts: string[] = []
  let hasText = false

  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!isRecord(block)) continue
      const kind = typeof block.type === 'string' ? block.type : ''

      if (kind === 'text' && typeof block.text === 'string') {
        hasText = true
        parts.push(block.text)
        continue
      }

      if (kind === 'resource' && isRecord(block.resource)) {
        const uri = typeof block.resource.uri === 'string' && block.resource.uri ? block.resource.uri : 'resource'
        const mime =
          typeof block.resource.mimeType === 'string' && block.resource.mimeType ? block.resource.mimeType : ''
        if (typeof block.resource.text === 'string') {
          hasText = true
          parts.push(block.resource.text ? `[Resource ${uri}]\n${block.resource.text}` : `[Resource ${uri}]`)
        } else {
          parts.push(`[Resource ${uri}${mime ? ` (${mime})` : ''} — binary content omitted]`)
        }
        continue
      }

      if (kind === 'resource_link') {
        const uri = typeof block.uri === 'string' && block.uri ? block.uri : 'resource'
        parts.push(`[Resource ${uri}]`)
        continue
      }

      if (kind === 'image') {
        const mime = typeof block.mimeType === 'string' && block.mimeType ? block.mimeType : 'image/*'
        parts.push(`[Image (${mime}) omitted from text tool output]`)
        continue
      }

      if (kind === 'audio') {
        const mime = typeof block.mimeType === 'string' && block.mimeType ? block.mimeType : 'audio/*'
        parts.push(`[Audio (${mime}) omitted from text tool output]`)
        continue
      }

      if (kind) {
        parts.push(`[Content (${kind}) omitted from text tool output]`)
      }
    }
  }

  if (!hasText && result.structuredContent !== undefined) {
    try {
      const json = JSON.stringify(result.structuredContent, null, 2)
      if (json) parts.push(json)
    } catch {
      // Ignore non-serializable structuredContent
    }
  }

  const joined = parts.join('\n\n').trim()
  if (!joined) return '(empty result)'
  return truncateBounded(joined, MAX_MCP_RESULT_CHARS)
}

export async function runMcpToolCall(input: {
  db: Db
  manager: McpManager
  botId: string
  threadId: string
  trigger: ActionTrigger
  name: string
  args: Record<string, unknown>
  watch?: boolean
  signal?: AbortSignal
  events: AgentEvents
  now: number
}): Promise<{ text: string; ok: boolean; tainted?: boolean }> {
  const { db, manager, botId, threadId, name, watch, signal, events, now } = input
  const cleanArgs = isRecord(input.args) ? input.args : {}

  const enabledServers = listEnabledBotMcpServers(db, botId)
  const { lookup } = buildMcpToolSet(enabledServers)
  const resolved = lookup.get(name)
  if (!resolved) {
    return {
      text: `MCP tool "${name}" is not available or not authorized for this teammate.`,
      ok: false,
    }
  }

  const { server, tool, mode, exposedName } = resolved
  if (watch && mode !== 'read') {
    return {
      text:
        `${name} is not available in a watch routine: this run only looks. ` +
        'If something should be done, hold it for approval and your operator decides.',
      ok: false,
    }
  }

  if (mode === 'read') {
    try {
      const res = await manager.callTool(server.id, tool.name, cleanArgs, {
        write: false,
        ...(signal ? { signal } : {}),
      })
      const text = formatMcpCallResult(res)
      return {
        text: res.isError ? `MCP tool error (${server.name} · ${tool.name}): ${text}` : text,
        ok: !res.isError,
        tainted: true,
      }
    } catch (err) {
      return {
        text: `MCP tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        ok: false,
        tainted: true,
      }
    }
  }

  const operationId = randomUUID()
  const frozen: FrozenMcpExecution = {
    kind: 'mcp',
    operationId,
    serverId: server.id,
    serverName: server.name,
    serverSlug: server.slug,
    toolName: tool.name,
    exposedToolName: exposedName,
    args: cleanArgs,
  }
  const action = `${server.name} · ${tool.name}`
  const detail = formatMcpWriteApprovalDetail(cleanArgs)
  const kind = 'other' as const
  const target = `mcp:${server.slug}/${tool.name}`

  const approval = createApproval(db, {
    threadId,
    botId,
    action,
    detail,
    kind,
    target,
    executionJson: JSON.stringify(frozen),
    operationId,
    now,
  })
  const reason = rememberReason({ kind, target })
  const editable = buildMcpEditable(frozen, tool.inputSchema)
  events.onMessage(
    insertMessage(db, {
      threadId,
      sender: botId,
      kind: 'approval_request',
      payload: {
        approvalId: approval.id,
        action,
        detail,
        kind,
        target,
        status: 'pending',
        canRemember: canRemember({ kind, target }),
        ...(reason ? { rememberBlocked: blockText(reason), rememberReason: reason } : {}),
        ...(editable ? { editable } : {}),
      },
    }),
  )

  return {
    ok: true,
    text: `Held for your operator's approval (#${approval.id}): ${action}. Wait for their decision; do not retry.`,
  }
}

export async function safeExecuteMcpWrite(
  manager: McpManager,
  frozen: FrozenMcpExecution,
): Promise<McpWriteExecutionResult> {
  try {
    const res = await manager.callTool(frozen.serverId, frozen.toolName, frozen.args, { write: true })
    const formatted = formatMcpCallResult(res)
    if (res.isError) {
      return {
        status: 'failed',
        error: truncateBounded(formatted, MAX_MCP_WRITE_SUMMARY_CHARS),
      }
    }
    return {
      status: 'succeeded',
      summary: truncateBounded(formatted, MAX_MCP_WRITE_SUMMARY_CHARS),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof McpCallError && (err.dispatched || err.code === 'uncertain_write')) {
      return {
        status: 'uncertain',
        detail: truncateBounded(msg, MAX_MCP_WRITE_SUMMARY_CHARS),
      }
    }
    return {
      status: 'failed',
      error: truncateBounded(msg, MAX_MCP_WRITE_SUMMARY_CHARS),
    }
  }
}
