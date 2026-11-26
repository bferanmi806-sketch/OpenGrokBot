import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import os from 'node:os'
import { findBrowser } from './browsers.js'
import type { ComputerKind } from './computer.js'
import type { Config } from './config.js'
import { schemaVersion, type Db } from './db.js'
import { readSavedSettings, resolveSettings } from './settings.js'

export type RedactOptions = {
  redactHomePath?: boolean
}

export type DiagnosticsBundle = {
  generatedAt: string
  summaryText: string
  app: {
    gatewayVersion: string | null
    schemaVersion: number
    port: number | null
    dataDir: string
    logFile: string
    runtime: { node: string; platform: string; arch: string; release: string }
  }
  subsystems: {
    computersMode: string
    browserStatus: string
    localLlmQueue: { maxConcurrency: number; active: number; queued: number } | null
    mcpServers: Array<{ name: string; transport: string; policy: string; enabled: boolean }>
    connectors: Array<{ provider: string; status: string }>
    counts: {
      bots: number
      threads: number
      routines: number
      wikiPages: number
      pendingApprovals: number
      runningBackgroundTasks: number
    }
    recentActionErrors24h: Array<{ at: string; tool: string; trigger: string; summary: string }>
  }
  recentLogs: {
    source: string
    lineCount: number
    lines: string[]
  }
}

export type BuildDiagnosticsDeps = {
  db: Db
  env: Record<string, string | undefined>
  startedWith: Config
  runningKind?: ComputerKind
  getBrowserStatus?: () => string
  getLlmQueueSnapshot?: () => { maxConcurrency: number; active: number; queued: number } | null
  now?: () => Date
}

const MAX_LOG_BYTES = 128 * 1024
const MAX_LOG_LINES = 200
const SUMMARY_LOG_LINES = 30
const RECENT_ERRORS_WINDOW_MS = 24 * 60 * 60 * 1000
const RECENT_ERRORS_LIMIT = 15

const CONTENT_BEARING_TOOLS = new Set([
  'message_user',
  'ask_operator',
  'save_memory',
  'forget_memory',
  'propose_memory_rule',
  'search_history',
  'wiki_upsert',
  'wiki_patch',
  'space_upsert_item',
])

const SENSITIVE_KEY_BODY = '(?:[\\w.-]*?(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|webhook[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|[_-]token|Token|secret|password|passwd|passphrase)|token)'

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private key blocks (complete + dangling chunk-boundary fragments)
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '<hidden-private-key>'],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, '<hidden-private-key>'],
  [/^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '<hidden-private-key>'],

  // Basic Auth credentials embedded in URLs (https://user:pass@host, postgres://user:pass@host)
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'<>]+:)(?!<hidden>)[^/\s@"'<>]+(@)/gi, '$1<hidden>$2'],

  // Slack & Discord incoming webhook URLs
  [/(https:\/\/hooks\.slack\.com\/services\/T[\w]+\/B[\w]+\/)(?!<hidden>)[\w-]+/gi, '$1<hidden>'],
  [/(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)(?!<hidden>)[\w-]+/gi, '$1<hidden>'],

  // HTTP Authorization / Proxy-Authorization / session / API headers
  [/((?:Authorization|Proxy-Authorization)\s*:\s*Digest\s+)(?!\s*<hidden)[^\r\n]+/gi, '$1<hidden>'],
  [/((?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|Token|ApiKey)\s+)(?!\s*<hidden)[^\r\n"',;]+/gi, '$1<hidden>'],
  [/((?:Authorization|Proxy-Authorization)\s*:\s*)(?!\s*(?:Bearer|Basic|Token|Digest|ApiKey)\s)(?!\s*<hidden)[^\r\n"',;]+/gi, '$1<hidden>'],
  [/\b(Bearer\s+)(?!\s*<hidden)[\w.~+/-]{8,}=*/gi, '$1<hidden>'],
  [/((?:X-API-Key|X-Shim-Token|Cookie|Set-Cookie)\s*:\s*)(?!\s*<hidden)[^\r\n"']+/gi, '$1<hidden>'],

  // URL query parameters, CLI flags, and .env / shell assignments
  [/([?&](?:token|key|api_key|apikey|access_token|refresh_token|client_secret|secret|password|code|signature|webhook_key|webhook_secret|auth_token)=)(?!<hidden)[^&\s"']+/gi, '$1<hidden>'],
  [/(--?(?:token|api-key|apikey|password|passwd|secret|client-secret|webhook-key|webhook-secret|auth-token)(?:=|\s+))(?!\s*<hidden)[^\s"']+/gi, '$1<hidden>'],
  [new RegExp(`(\\b(?:${SENSITIVE_KEY_BODY})=")(?!<hidden)([^"]+)(")`, 'gi'), '$1<hidden>$3'],
  [new RegExp(`(\\b(?:${SENSITIVE_KEY_BODY})=')(?!<hidden)([^']+)(')`, 'gi'), '$1<hidden>$3'],
  [new RegExp(`(\\b(?:${SENSITIVE_KEY_BODY})=)(?!<hidden)(?!['"])([^\\s&"',;]+)`, 'gi'), '$1<hidden>'],

  // JSON, single-quoted util.inspect / JS objects, and YAML key-value pairs
  [new RegExp(`("(?:${SENSITIVE_KEY_BODY}|authorization|cookie|set-cookie)"\\s*:\\s*")(?!<hidden)([^"]+)(")`, 'gi'), '$1<hidden>$3'],
  [new RegExp(`((?:['"])?\\b(?:${SENSITIVE_KEY_BODY}|authorization|cookie|set-cookie)(?:['"])?\\s*:\\s*')(?!<hidden)([^']+)(')`, 'gi'), '$1<hidden>$3'],
  [new RegExp(`(\\b(?:${SENSITIVE_KEY_BODY})\\s*:\\s*")(?!<hidden)([^"]+)(")`, 'gi'), '$1<hidden>$3'],
  [new RegExp(`(^[ \\t-]*(?:${SENSITIVE_KEY_BODY})\\s*:\\s*)(?!\\s*<hidden)(?!\\s*(?:true|false|null|~|\\d+|\\[|\\{)\\s*$)([^\\r\\n#"']+?)(?=\\s*(?:#.*)?$)`, 'gim'), '$1<hidden>'],

  // JWTs (header.payload.signature)
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<hidden-jwt>'],

  // Vendor API keys & personal/service tokens
  [/\b(sk-ant-)(?!…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(sk-proj-)(?!…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(sk-svcacct-)(?!…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(sk-[\w-]{4})(?!…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(AIza[\w-]{4})(?!…<hidden>)[\w-]{12,}/g, '$1…<hidden>'],
  [/\b(gsk_[\w-]{4})(?!…<hidden>)[\w-]{12,}/g, '$1…<hidden>'],
  [/\b(xai-[\w-]{4})(?!…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(xai-)(?!…<hidden>|[\w-]{4}…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(cmp_)(?!<hidden>)[\w-]{10,}/g, '$1<hidden>'],
  [/\b(ak_)(?!<hidden>)[\w-]{12,}/g, '$1<hidden>'],
  [/\b(gh[pousr]_)(?!<hidden>)[\w]{16,}/g, '$1<hidden>'],
  [/\b(github_pat_)(?!<hidden>)[\w]{16,}/g, '$1<hidden>'],
  [/\b(glpat-)(?!<hidden>)[\w-]{12,}/g, '$1<hidden>'],
  [/\b(xox[baprs]-)(?!<hidden>)[\w-]{10,}/g, '$1<hidden>'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '$1<hidden>'],
  [/\b(hf_)(?!<hidden>)[A-Za-z0-9]{16,}/g, '$1<hidden>'],
  [/\b(r8_)(?!<hidden>)[A-Za-z0-9]{16,}/g, '$1<hidden>'],
  [/\b(pplx-)(?!<hidden>)[A-Za-z0-9]{16,}/g, '$1<hidden>'],
  [/\b((?:sk|rk)_(?:live|test)_)(?!<hidden>)[A-Za-z0-9]{12,}/g, '$1<hidden>'],
]

const HOME_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Windows drive paths first so C:/Users/name is matched whole before POSIX /Users/name
  [/(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"']+(?=\\|\/|$)/g, '~'],
  [/(?<![A-Za-z0-9._-])\/Users\/[^/\s"']+(?=\/|$)/g, '~'],
  [/(?<![A-Za-z0-9._-])\/home\/[^/\s"']+(?=\/|$)/g, '~'],
]

export function redactSecrets(text: string, opts?: RedactOptions): string {
  let out = SECRET_PATTERNS.reduce((s, [re, to]) => s.replace(re, to), text)
  if (opts?.redactHomePath) {
    out = HOME_PATTERNS.reduce((s, [re, to]) => s.replace(re, to), out)
  }
  return out
}

function hasTable(db: Db, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(name)
  return Boolean(row)
}

function tableColumns(db: Db, table: string): Set<string> {
  if (!hasTable(db, table)) return new Set()
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

function safeCount(db: Db, table: string, whereClause = ''): number {
  if (!hasTable(db, table)) return 0
  const sql = `SELECT COUNT(*) AS n FROM ${table}${whereClause ? ` WHERE ${whereClause}` : ''}`
  return Number(db.prepare(sql).pluck().get() ?? 0)
}

function detectBrowserStatus(
  computersMode: string,
  dataDir: string,
  env: Record<string, string | undefined>,
  override?: () => string,
): string {
  if (override) {
    try {
      return redactSecrets(override(), { redactHomePath: true })
    } catch {
      return 'unknown'
    }
  }
  if (computersMode === 'docker') return 'container'
  try {
    const found = findBrowser({ dataDir, env })
    return found ? `found (${found.source})` : 'missing'
  } catch {
    return 'missing (configured path not found)'
  }
}

function readMcpSummary(db: Db): DiagnosticsBundle['subsystems']['mcpServers'] {
  const cols = tableColumns(db, 'mcp_servers')
  if (cols.size === 0) return []
  const hasPolicyCol = cols.has('policy')
  const hasTrustCol = cols.has('trust_read_only_hint')
  const selectCols = [
    'name',
    'transport',
    'enabled',
    ...(hasPolicyCol ? ['policy'] : []),
    ...(hasTrustCol ? ['trust_read_only_hint'] : []),
  ].join(', ')
  const rows = db.prepare(`SELECT ${selectCols} FROM mcp_servers ORDER BY name ASC`).all() as Array<{
    name?: unknown
    transport?: unknown
    enabled?: unknown
    policy?: unknown
    trust_read_only_hint?: unknown
  }>
  return rows.map((r) => ({
    name: redactSecrets(String(r.name ?? ''), { redactHomePath: true }),
    transport: redactSecrets(String(r.transport ?? ''), { redactHomePath: true }),
    policy: typeof r.policy === 'string' && r.policy
      ? redactSecrets(r.policy, { redactHomePath: true })
      : r.trust_read_only_hint
        ? 'trust-readonly-hint'
        : 'default-write',
    enabled: Boolean(r.enabled),
  }))
}

function readConnectorsSummary(db: Db): DiagnosticsBundle['subsystems']['connectors'] {
  const cols = tableColumns(db, 'connector_accounts')
  if (cols.size === 0) return []
  const providerCol = cols.has('provider') ? 'provider' : cols.has('app') ? 'app' : null
  if (!providerCol || !cols.has('status')) return []
  const rows = db.prepare(`SELECT ${providerCol} AS provider, status FROM connector_accounts ORDER BY rowid ASC`).all() as Array<{
    provider?: unknown
    status?: unknown
  }>
  return rows.map((r) => ({
    provider: redactSecrets(String(r.provider ?? ''), { redactHomePath: true }),
    status: redactSecrets(String(r.status ?? ''), { redactHomePath: true }),
  }))
}

function readRecentActionErrors(db: Db, sinceMs: number): DiagnosticsBundle['subsystems']['recentActionErrors24h'] {
  const cols = tableColumns(db, 'actions')
  if (!cols.has('ok') || !cols.has('created_at') || !cols.has('tool')) return []
  const rows = db.prepare(
    `SELECT created_at, tool, trigger, summary
     FROM actions
     WHERE ok = 0 AND created_at >= ?
     ORDER BY id DESC
     LIMIT ?`,
  ).all(sinceMs, RECENT_ERRORS_LIMIT) as Array<{
    created_at: number
    tool: string
    trigger: string
    summary: string
  }>
  return rows.map((r) => {
    const rawTool = String(r.tool ?? '')
    return {
      at: new Date(Number(r.created_at)).toISOString(),
      tool: redactSecrets(rawTool, { redactHomePath: true }),
      trigger: redactSecrets(String(r.trigger ?? ''), { redactHomePath: true }),
      summary: CONTENT_BEARING_TOOLS.has(rawTool)
        ? '<redacted>'
        : redactSecrets(String(r.summary ?? ''), { redactHomePath: true }),
    }
  })
}

function readTailLogs(rawLogFile: string): DiagnosticsBundle['recentLogs'] {
  if (!rawLogFile || rawLogFile === 'stdout') {
    return { source: 'stdout', lineCount: 0, lines: [] }
  }
  const safeSource = redactSecrets(rawLogFile, { redactHomePath: true })
  if (!existsSync(rawLogFile)) {
    return { source: `${safeSource} (missing)`, lineCount: 0, lines: [] }
  }
  let fd: number | null = null
  try {
    fd = openSync(rawLogFile, 'r')
    const stat = fstatSync(fd)
    if (stat.size <= 0) {
      return { source: safeSource, lineCount: 0, lines: [] }
    }
    const offset = stat.size > MAX_LOG_BYTES ? stat.size - MAX_LOG_BYTES : 0
    const length = stat.size - offset
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(fd, buffer, 0, length, offset)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    if (offset > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline >= 0
        ? text.slice(firstNewline + 1)
        : text.slice(-4000).replace(/^[\uFFFD\uDC00-\uDFFF]+/, '')
    }
    text = redactSecrets(text, { redactHomePath: true })
    const rawLines = text.split(/\r?\n/)
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop()
    }
    const tail = rawLines
      .slice(-MAX_LOG_LINES)
      .map((line) => redactSecrets(line, { redactHomePath: true }))
    return {
      source: safeSource,
      lineCount: tail.length,
      lines: tail,
    }
  } catch {
    return { source: `${safeSource} (unreadable)`, lineCount: 0, lines: [] }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore close error */ }
    }
  }
}

function formatSummaryText(bundle: Omit<DiagnosticsBundle, 'summaryText'>): string {
  const { app, subsystems, recentLogs } = bundle
  const mcpSummary = subsystems.mcpServers.length === 0
    ? 'none'
    : `${subsystems.mcpServers.length} (${subsystems.mcpServers.filter((s) => s.enabled).length} enabled)`
  const connSummary = subsystems.connectors.length === 0
    ? 'none'
    : subsystems.connectors.map((c) => `${c.provider}:${c.status}`).join(', ')
  const queueSummary = subsystems.localLlmQueue
    ? `max=${subsystems.localLlmQueue.maxConcurrency}, active=${subsystems.localLlmQueue.active}, queued=${subsystems.localLlmQueue.queued}`
    : 'n/a'

  const lines: string[] = [
    `OpenSuperBot Diagnostics (${bundle.generatedAt})`,
    `Gateway: ${app.gatewayVersion ?? 'source'} · Schema v${app.schemaVersion} · Port ${app.port ?? 'n/a'}`,
    `Runtime: Node ${app.runtime.node} · ${app.runtime.platform}/${app.runtime.arch} (${app.runtime.release})`,
    `Computers: ${subsystems.computersMode} · Browser: ${subsystems.browserStatus}`,
    `Local LLM Queue: ${queueSummary}`,
    `Data: ${app.dataDir}`,
    `Logs: ${app.logFile}`,
    `Counts: bots=${subsystems.counts.bots}, threads=${subsystems.counts.threads}, routines=${subsystems.counts.routines}, wikiPages=${subsystems.counts.wikiPages}, pendingApprovals=${subsystems.counts.pendingApprovals}, runningBg=${subsystems.counts.runningBackgroundTasks}`,
    `MCP Servers: ${mcpSummary} · Connectors: ${connSummary}`,
  ]

  if (subsystems.recentActionErrors24h.length > 0) {
    lines.push('', `Recent action errors (24h, ${subsystems.recentActionErrors24h.length}):`)
    for (const err of subsystems.recentActionErrors24h.slice(0, 10)) {
      lines.push(`- [${err.at}] ${err.tool} (${err.trigger}): ${err.summary}`)
    }
  } else {
    lines.push('Recent action errors (24h): none')
  }

  const tailLines = recentLogs.lines.slice(-SUMMARY_LOG_LINES)
  if (tailLines.length > 0) {
    lines.push('', `Last ${tailLines.length} log lines (${recentLogs.source}):`, ...tailLines)
  } else {
    lines.push('', `Log tail: none (${recentLogs.source})`)
  }

  return redactSecrets(lines.join('\n'), { redactHomePath: true })
}

export function buildDiagnosticsBundle(deps: BuildDiagnosticsDeps): DiagnosticsBundle {
  const { db, env, startedWith } = deps
  const nowDate = (deps.now ?? (() => new Date()))()
  const generatedAt = nowDate.toISOString()

  const savedSettings = hasTable(db, 'settings') ? readSavedSettings(db) : {}
  const resolved = resolveSettings(env, savedSettings)
  const computersMode = deps.runningKind ?? resolved.values.computers

  const rawLogFile = env.OPENSUPERBOT_LOG_FILE?.trim() || 'stdout'
  const app: DiagnosticsBundle['app'] = {
    gatewayVersion: env.OPENSUPERBOT_VERSION?.trim()
      ? redactSecrets(env.OPENSUPERBOT_VERSION.trim(), { redactHomePath: true })
      : null,
    schemaVersion: schemaVersion(db),
    port: typeof startedWith.port === 'number' ? startedWith.port : null,
    dataDir: redactSecrets(startedWith.dataDir, { redactHomePath: true }),
    logFile: rawLogFile === 'stdout' ? 'stdout' : redactSecrets(rawLogFile, { redactHomePath: true }),
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
    },
  }

  const wikiCols = tableColumns(db, 'wiki_pages')
  const approvalCols = tableColumns(db, 'approvals')
  const bgCols = tableColumns(db, 'background_tasks')

  const liveQueue = deps.getLlmQueueSnapshot?.()
  const localLlmQueue = liveQueue !== undefined
    ? liveQueue
    : { maxConcurrency: resolved.values.localLlmConcurrency, active: 0, queued: 0 }

  const subsystems: DiagnosticsBundle['subsystems'] = {
    computersMode,
    browserStatus: detectBrowserStatus(computersMode, startedWith.dataDir, env, deps.getBrowserStatus),
    localLlmQueue,
    mcpServers: readMcpSummary(db),
    connectors: readConnectorsSummary(db),
    counts: {
      bots: safeCount(db, 'bots'),
      threads: safeCount(db, 'threads'),
      routines: safeCount(db, 'routines'),
      wikiPages: wikiCols.has('archived_at')
        ? safeCount(db, 'wiki_pages', 'archived_at IS NULL')
        : safeCount(db, 'wiki_pages'),
      pendingApprovals: approvalCols.has('status')
        ? safeCount(db, 'approvals', `status = 'pending'`)
        : 0,
      runningBackgroundTasks: bgCols.has('status')
        ? safeCount(db, 'background_tasks', `status = 'running'`)
        : 0,
    },
    recentActionErrors24h: readRecentActionErrors(db, nowDate.getTime() - RECENT_ERRORS_WINDOW_MS),
  }

  const recentLogs = readTailLogs(rawLogFile)
  const partial = { generatedAt, app, subsystems, recentLogs }
  return {
    ...partial,
    summaryText: formatSummaryText(partial),
  }
}
