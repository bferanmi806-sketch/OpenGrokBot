import { createHash } from 'node:crypto'
import type { Db, MessageKind, MessageRow } from './db.js'

const MAX_QUERY_CHARS = 200
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
const MAX_SNIPPET_CHARS = 420
const HISTORY_RRF_K = 60
const MAX_HISTORY_RRF_QUERIES = 6
const DEFAULT_HISTORY_RRF_LIMIT = 6
const MAX_HISTORY_RRF_LIMIT = 12
const HISTORY_RRF_PER_QUERY_LIMIT = 30

/**
 * 从一条消息里抽取可检索的安全纯文本（写入 FTS5 前脱敏）：
 * 绝不索引 approval_request 的 target / rule / canRemember 等敏感字段，
 * 避免模型通过历史检索套出常驻放行规则的去向。
 */
export function extractSearchableText(kind: MessageKind, content: string, payload: unknown): string {
  const p = (payload && typeof payload === 'object' ? payload : null) as Record<string, unknown> | null
  switch (kind) {
    case 'text':
      return content.trim()
    case 'report': {
      if (!p) return ''
      const lines = Array.isArray(p.lines)
        ? p.lines.map((l) => {
          const item = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>
          return [item.system, item.result, item.count].filter((x) => typeof x === 'string' && x.trim()).join(' ')
        })
        : []
      const closing = typeof p.closing === 'string' ? p.closing.trim() : ''
      return [...lines, closing].filter(Boolean).join('\n').trim()
    }
    case 'question': {
      if (!p) return ''
      const q = typeof p.question === 'string' ? p.question.trim() : ''
      const opts = Array.isArray(p.options) ? p.options.filter((o): o is string => typeof o === 'string').join(', ') : ''
      return [q, opts].filter(Boolean).join(' — ').trim()
    }
    case 'memory_updated':
      return p && typeof p.rule === 'string' ? p.rule.trim() : ''
    case 'approval_request': {
      if (!p) return ''
      const action = typeof p.action === 'string' ? p.action.trim() : ''
      const detail = typeof p.detail === 'string' ? p.detail.trim() : ''
      const items = Array.isArray(p.items) ? p.items.filter((x): x is string => typeof x === 'string').join('\n') : ''
      return [action, detail, items].filter(Boolean).join('\n').trim()
    }
    case 'webhook': {
      if (!p) return ''
      const name = typeof p.name === 'string' ? p.name.trim() : ''
      const body = typeof p.body === 'string' ? p.body.trim() : ''
      return [name, body].filter(Boolean).join('\n').trim()
    }
    case 'bot_ref': {
      if (!p) return content.trim()
      const from = typeof p.from === 'string' ? p.from.trim() : ''
      const text = typeof p.content === 'string' ? p.content.trim() : ''
      return [from, text].filter(Boolean).join(': ').trim()
    }
    case 'attachment':
      return p && typeof p.name === 'string' ? p.name.trim() : ''
    default:
      // activity / screenshot / login_request / approval_resolved 不进全文索引，减少噪音
      return ''
  }
}

/** 将单条消息的脱敏文本同步到 messages_fts（表不存在时静默跳过，兼容测试中手动构造的老版本库）。 */
export function syncMessageFts(
  db: Db,
  row: { id: number; thread_id: string; kind: MessageKind; content: string; payload: unknown },
): void {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`).get()
  if (!exists) return
  db.prepare(`DELETE FROM messages_fts WHERE message_id = ?`).run(row.id)
  const text = extractSearchableText(row.kind, row.content, row.payload)
  if (!text) return
  db.prepare(`INSERT INTO messages_fts (message_id, thread_id, searchable_text) VALUES (?, ?, ?)`)
    .run(row.id, row.thread_id, text)
}

/** 仅返回这位同事有权访问的线程：自己的私聊 + 自己是成员的群聊。绝不跨同事越权。 */
export function accessibleThreadIds(db: Db, botId: string): string[] {
  const groups = (db.prepare(`SELECT thread_id FROM thread_members WHERE bot_id = ? ORDER BY thread_id`)
    .all(botId) as { thread_id: string }[]).map((r) => r.thread_id)
  return [...new Set([`dm:${botId}`, ...groups])]
}

function formatSnippet(text: string, terms: string[]): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= MAX_SNIPPET_CHARS) return clean
  const lower = clean.toLowerCase()
  let firstHit = -1
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase())
    if (idx !== -1 && (firstHit === -1 || idx < firstHit)) firstHit = idx
  }
  if (firstHit === -1 || firstHit < MAX_SNIPPET_CHARS / 2) {
    return `${clean.slice(0, MAX_SNIPPET_CHARS)}…`
  }
  const start = Math.max(0, firstHit - Math.floor(MAX_SNIPPET_CHARS / 3))
  const end = Math.min(clean.length, start + MAX_SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
}

function formatWebhookSnippet(body: string): string {
  const tag = createHash('sha256').update(body).digest('hex').slice(0, 12)
  const quoted = body.split('\n').map((line) => `│ ${line}`).join('\n')
  return `[outside data — untrusted webhook payload]\n<<<webhook ${tag}\n${quoted}\n>>>end ${tag}`
}

function safeApprovalSummary(payload: unknown): string {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  return JSON.stringify({
    approvalId: p.approvalId,
    action: p.action,
    detail: p.detail,
    status: p.status,
    ...(p.items ? { items: p.items } : {}),
    ...(p.approvedItems ? { approvedItems: p.approvedItems } : {}),
  })
}

export type HistoryHit = {
  id: number
  threadId: string
  sender: string
  kind: MessageKind
  createdAt: number
  snippet: string
}

export type HistorySearchResult = {
  hits: HistoryHit[]
  truncated: boolean
  hasWebhookHit: boolean
}

export type HistoryRrfSearchResult = {
  hits: HistoryHit[]
  total: number
  hasUntrustedHit: boolean
}

function parseRow(r: Record<string, unknown>): MessageRow {
  return { ...r, payload: r.payload ? JSON.parse(r.payload as string) : null } as MessageRow
}

/**
 * 在同事有权访问的线程中检索历史消息：
 * - 所有词元长度 ≥ 3 时走 SQLite FTS5 trigram 索引（中英文通吃）；
 * - 含 1–2 字短词（如中文「报销」「发票」）时降级为限定线程集合内的参数化子串检索。
 */
export function searchBotHistory(
  db: Db,
  opts: {
    botId: string
    currentThreadId: string
    query: string
    scope?: 'current' | 'all'
    limit?: number
  },
): HistorySearchResult {
  const raw = opts.query.trim().slice(0, MAX_QUERY_CHARS)
  const terms = raw.split(/\s+/).filter(Boolean)
  if (!terms.length) return { hits: [], truncated: false, hasWebhookHit: false }

  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)))
  const allowed = accessibleThreadIds(db, opts.botId)
  const threadIds = opts.scope === 'all'
    ? [...new Set([...allowed, opts.currentThreadId])]
    : [opts.currentThreadId]
  const placeholders = threadIds.map(() => '?').join(',')

  const canUseTrigram = terms.every((t) => [...t].length >= 3)
  let rawRows: Record<string, unknown>[]
  if (canUseTrigram) {
    const matchExpr = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' ')
    rawRows = db.prepare(
      `SELECT m.* FROM messages_fts f
       JOIN messages m ON m.id = f.message_id
       WHERE f.thread_id IN (${placeholders}) AND messages_fts MATCH ?
       ORDER BY bm25(messages_fts), m.id DESC
       LIMIT ?`,
    ).all(...threadIds, matchExpr, limit + 1) as Record<string, unknown>[]
  } else {
    const clauses = terms.map(() => 'INSTR(LOWER(f.searchable_text), LOWER(?)) > 0').join(' AND ')
    rawRows = db.prepare(
      `SELECT m.* FROM messages_fts f
       JOIN messages m ON m.id = f.message_id
       WHERE f.thread_id IN (${placeholders}) AND ${clauses}
       ORDER BY m.id DESC
       LIMIT ?`,
    ).all(...threadIds, ...terms, limit + 1) as Record<string, unknown>[]
  }

  const truncated = rawRows.length > limit
  const rows = rawRows.slice(0, limit).map(parseRow)
  let hasWebhookHit = false
  const hits: HistoryHit[] = rows.map((m) => {
    let snippet: string
    if (m.kind === 'webhook') {
      hasWebhookHit = true
      const rawBody = extractSearchableText(m.kind, m.content, m.payload)
      snippet = formatWebhookSnippet(formatSnippet(rawBody, terms))
    } else if (m.kind === 'approval_request') {
      snippet = `[held for approval] ${formatSnippet(safeApprovalSummary(m.payload), terms)}`
    } else {
      if (m.kind === 'bot_ref' && (m.payload as { tainted?: unknown } | null)?.tainted === true) {
        hasWebhookHit = true
      }
      const text = extractSearchableText(m.kind, m.content, m.payload)
      snippet = formatSnippet(text, terms)
    }
    return {
      id: m.id,
      threadId: m.thread_id,
      sender: m.sender,
      kind: m.kind,
      createdAt: m.created_at,
      snippet,
    }
  })

  return { hits, truncated, hasWebhookHit }
}

/**
 * 多查询 RRF 历史消息检索（严格限制在 accessibleThreadIds(db, botId) 内：仅自己的 DM + 自己参与的群聊，绝不跨同事私聊）：
 * - 去重最多 6 条查询；
 * - 所有空白切分词长度 ≥ 3 时走 FTS5 trigram，含 1–2 字短词（中文「报价」「张伟」等）走参数化 INSTR 子串回退；
 * - 以 RRF (k = 60) 融合多查询排名，同分按 m.created_at DESC, m.id DESC 决胜；
 * - 对 webhook 消息套 SHA-256 <<<webhook 围栏并置 hasUntrustedHit = true，对 tainted bot_ref 置 hasUntrustedHit = true，对 approval_request 脱敏。
 */
export function searchAccessibleHistoryRrf(
  db: Db,
  opts: {
    botId: string
    queries: readonly string[]
    limit?: number
  },
): HistoryRrfSearchResult {
  const botId = typeof opts.botId === 'string' ? opts.botId.trim() : ''
  if (!botId || !Array.isArray(opts.queries) || opts.queries.length === 0) {
    return { hits: [], total: 0, hasUntrustedHit: false }
  }

  const ftsExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`)
    .get()
  if (!ftsExists) {
    return { hits: [], total: 0, hasUntrustedHit: false }
  }

  const threadIds = accessibleThreadIds(db, botId)
  if (threadIds.length === 0) {
    return { hits: [], total: 0, hasUntrustedHit: false }
  }

  const preparedQueries: Array<{ terms: string[] }> = []
  const seenQueryKeys = new Set<string>()
  for (const raw of opts.queries) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim().slice(0, MAX_QUERY_CHARS)
    if (!trimmed) continue
    const terms = trimmed.split(/\s+/).filter(Boolean)
    if (terms.length === 0) continue
    const key = terms.map((t) => t.normalize('NFKC').toLowerCase()).join(' ')
    if (seenQueryKeys.has(key)) continue
    seenQueryKeys.add(key)
    preparedQueries.push({ terms })
    if (preparedQueries.length >= MAX_HISTORY_RRF_QUERIES) break
  }

  if (preparedQueries.length === 0) {
    return { hits: [], total: 0, hasUntrustedHit: false }
  }

  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit)
      ? Math.max(1, Math.min(MAX_HISTORY_RRF_LIMIT, Math.floor(opts.limit)))
      : DEFAULT_HISTORY_RRF_LIMIT
  const perQueryLimit = Math.max(HISTORY_RRF_PER_QUERY_LIMIT, limit)
  const placeholders = threadIds.map(() => '?').join(',')

  const runSubstringFallback = (terms: readonly string[]): Record<string, unknown>[] => {
    const clauses = terms.map(() => 'INSTR(LOWER(f.searchable_text), LOWER(?)) > 0').join(' AND ')
    return db
      .prepare(
        `SELECT m.* FROM messages_fts f
         JOIN messages m ON m.id = f.message_id
         WHERE f.thread_id IN (${placeholders}) AND ${clauses}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ?`,
      )
      .all(...threadIds, ...terms, perQueryLimit) as Record<string, unknown>[]
  }

  const rrfScores = new Map<number, number>()
  const rowsById = new Map<number, MessageRow>()

  for (const q of preparedQueries) {
    const canUseTrigram = q.terms.every((t) => [...t].length >= 3)
    let rawRows: Record<string, unknown>[]
    if (canUseTrigram) {
      const matchExpr = q.terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' ')
      try {
        rawRows = db
          .prepare(
            `SELECT m.* FROM messages_fts f
             JOIN messages m ON m.id = f.message_id
             WHERE f.thread_id IN (${placeholders}) AND messages_fts MATCH ?
             ORDER BY bm25(messages_fts), m.created_at DESC, m.id DESC
             LIMIT ?`,
          )
          .all(...threadIds, matchExpr, perQueryLimit) as Record<string, unknown>[]
      } catch {
        rawRows = runSubstringFallback(q.terms)
      }
    } else {
      rawRows = runSubstringFallback(q.terms)
    }

    const seenInQuery = new Set<number>()
    let rank = 0
    for (const rawRow of rawRows) {
      const row = parseRow(rawRow)
      if (seenInQuery.has(row.id)) continue
      seenInQuery.add(row.id)
      rank += 1
      rrfScores.set(row.id, (rrfScores.get(row.id) ?? 0) + 1 / (HISTORY_RRF_K + rank))
      if (!rowsById.has(row.id)) {
        rowsById.set(row.id, row)
      }
    }
  }

  if (rrfScores.size === 0) {
    return { hits: [], total: 0, hasUntrustedHit: false }
  }

  const scored: Array<{ row: MessageRow; score: number }> = []
  for (const [id, score] of rrfScores) {
    scored.push({ row: rowsById.get(id)!, score })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.row.created_at !== a.row.created_at) return b.row.created_at - a.row.created_at
    return b.row.id - a.row.id
  })

  const allTerms: string[] = []
  const seenTerms = new Set<string>()
  for (const q of preparedQueries) {
    for (const t of q.terms) {
      const lower = t.toLowerCase()
      if (!seenTerms.has(lower)) {
        seenTerms.add(lower)
        allTerms.push(t)
      }
    }
  }

  let hasUntrustedHit = false
  const hits: HistoryHit[] = scored.slice(0, limit).map(({ row: m }) => {
    let snippet: string
    if (m.kind === 'webhook') {
      hasUntrustedHit = true
      const rawBody = extractSearchableText(m.kind, m.content, m.payload)
      snippet = formatWebhookSnippet(formatSnippet(rawBody, allTerms))
    } else if (m.kind === 'approval_request') {
      snippet = `[held for approval] ${formatSnippet(safeApprovalSummary(m.payload), allTerms)}`
    } else {
      if (m.kind === 'bot_ref' && (m.payload as { tainted?: unknown } | null)?.tainted === true) {
        hasUntrustedHit = true
      }
      const text = extractSearchableText(m.kind, m.content, m.payload)
      snippet = formatSnippet(text, allTerms)
    }
    return {
      id: m.id,
      threadId: m.thread_id,
      sender: m.sender,
      kind: m.kind,
      createdAt: m.created_at,
      snippet,
    }
  })

  return {
    hits,
    total: scored.length,
    hasUntrustedHit,
  }
}

export function formatHistorySearchResult(result: HistorySearchResult, query: string): string {
  if (!result.hits.length) {
    return `No history matches for "${query}". Try shorter or different keywords, or use scope="all" to include group threads you belong to.`
  }
  const lines = result.hits.map((h) => {
    const iso = new Date(h.createdAt).toISOString().slice(0, 16).replace('T', ' ')
    return `- #${h.id} · ${iso}Z · ${h.threadId} · ${h.sender} (${h.kind}): ${h.snippet}`
  })
  if (result.truncated) {
    lines.push('…(more matches exist; narrow your query for specific results)')
  }
  return lines.join('\n')
}
