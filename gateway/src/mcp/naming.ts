import { createHash } from 'node:crypto'
import type { McpDiscoveredTool, McpServerRow, McpToolMode } from './types.js'

export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__')
}

/** 按需加载 MCP 服务工具的唯一轻量入口名（保证 <= 64 字符）。 */
export function mcpLoaderToolName(serverSlug: string): string {
  const suffix = '__load_tools'
  const full = `mcp__${serverSlug}${suffix}`
  if (full.length <= 64) return full
  const maxSlug = Math.max(1, 64 - 'mcp__'.length - suffix.length)
  const stem = serverSlug.slice(0, maxSlug).replace(/_+$/, '') || 'srv'
  return `mcp__${stem}${suffix}`
}

export function computeExposedToolNames(
  serverSlug: string,
  tools: readonly Pick<McpDiscoveredTool, 'name'>[],
): Map<string, string> {
  const prefix = `mcp__${serverSlug}__`
  const out = new Map<string, string>()
  const used = new Set<string>()

  for (const tool of tools) {
    if (out.has(tool.name)) continue
    const rawSlug =
      tool.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'tool'

    const full = `${prefix}${rawSlug}`
    let assigned: string
    if (full.length <= 64 && !used.has(full)) {
      assigned = full
    } else {
      const digest = createHash('sha256').update(tool.name).digest('hex')
      const hash = digest.slice(0, 4)
      const maxToolLen = Math.max(1, 64 - prefix.length - 5)
      const stem = (rawSlug.slice(0, maxToolLen).replace(/_+$/, '') || 'tool').slice(0, maxToolLen)
      assigned = `${prefix}${stem}_${hash}`
      if (used.has(assigned)) {
        for (let n = 2; ; n++) {
          const suffix = `_${hash}${n}`
          const altLen = Math.max(1, 64 - prefix.length - suffix.length)
          const altStem = (rawSlug.slice(0, altLen).replace(/_+$/, '') || 'tool').slice(0, altLen)
          const alt = `${prefix}${altStem}${suffix}`
          if (!used.has(alt)) {
            assigned = alt
            break
          }
        }
      }
    }

    used.add(assigned)
    out.set(tool.name, assigned)
  }

  return out
}

export function effectiveToolMode(
  server: Pick<McpServerRow, 'toolPolicies' | 'trustReadOnlyHint'>,
  tool: Pick<McpDiscoveredTool, 'name' | 'readOnlyHint' | 'destructiveHint'>,
): McpToolMode {
  const o = server.toolPolicies[tool.name]
  if (o === 'read' || o === 'write') return o
  if (server.trustReadOnlyHint && tool.readOnlyHint && !tool.destructiveHint) return 'read'
  return 'write'
}
