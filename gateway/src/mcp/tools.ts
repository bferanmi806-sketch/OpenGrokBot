import { randomUUID } from 'node:crypto'
import type { ActionTrigger } from '../actions.js'
import type { AgentEvents } from '../agent.js'
import { buildMcpEditable, formatMcpWriteApprovalDetail } from '../approval-edit.js'
import { blockText, canRemember, createApproval, rememberReason } from '../approvals.js'
import { insertMessage, type Db } from '../db.js'
import type { ToolDef } from '../llm.js'
import { computeExposedToolNames, effectiveToolMode } from './naming.js'
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

export type McpResolvedTool = {
  server: McpServerRow
  tool: McpDiscoveredTool
  mode: McpToolMode
  exposedName: string
}

export function buildMcpToolSet(
  servers: readonly McpServerRow[],
  opts: { watch?: boolean } = {},
): {
  tools: ToolDef[]
  readToolNames: Set<string>
  lookup: Map<string, McpResolvedTool>
} {
  const tools: ToolDef[] = []
  const readToolNames = new Set<string>()
  const lookup = new Map<string, McpResolvedTool>()

  for (const server of servers) {
    if (!server.enabled) continue
    const exposedMap = computeExposedToolNames(server.slug, server.tools)
    for (const tool of server.tools) {
      const exposedName = exposedMap.get(tool.name)
      if (!exposedName || lookup.has(exposedName)) continue

      const mode = effectiveToolMode(server, tool)
      if (opts.watch && mode !== 'read') continue

      if (mode === 'read') {
        readToolNames.add(exposedName)
      }

      const modeLabel = mode === 'write' ? ' · held for operator approval' : ''
      const baseDesc = tool.description.trim() || `Call "${tool.name}" on ${server.name}.`
      const description = `[${server.name} MCP${modeLabel}] ${baseDesc}`

      tools.push({
        type: 'function',
        function: {
          name: exposedName,
          description,
          parameters: normalizeMcpInputSchema(tool.inputSchema),
        },
      })
      lookup.set(exposedName, { server, tool, mode, exposedName })
    }
  }

  return { tools, readToolNames, lookup }
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
