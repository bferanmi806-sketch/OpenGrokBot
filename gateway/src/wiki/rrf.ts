import type { Db } from '../db.js'
import { buildFtsQuery } from './tokenize.js'
import { isWikiKind, type WikiKind, type WikiSearchHit } from './types.js'

export const RRF_K = 60
export const RRF_PER_QUERY_LIMIT = 30
export const MAX_RRF_QUERIES = 6
export const DEFAULT_WIKI_SEARCH_LIMIT = 8
export const MAX_WIKI_SEARCH_LIMIT = 20
export const WIKI_SNIPPET_MAX_CHARS = 220

const MS_PER_DAY = 86_400_000
const DECAY_BASE = 0.85
const DECAY_RECENCY = 0.15
const DECAY_HALF_SCALE_DAYS = 90
const OR_FALLBACK_MIN_TOKENS = 3
const OR_FALLBACK_WEIGHT = 0.5

type RawRrfRow = {
  id: string
  kind: string
  slug: string
  title: string
  summary: string
  tags_json: string
  body: string
  source_tainted: number
  updated_by: string
  version: number
  created_at: number
  updated_at: number
  rank_score: number
}

function parseTagsJson(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function findFirstMatch(text: string, tokens: readonly string[]): { index: number; length: number } | null {
  if (!text || tokens.length === 0) return null

  const lower = text.toLowerCase()
  let bestIdx = -1
  let bestLen = 0
  for (const tok of tokens) {
    if (!tok) continue
    const idx = lower.indexOf(tok)
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx || (idx === bestIdx && tok.length > bestLen))) {
      bestIdx = idx
      bestLen = tok.length
    }
  }
  if (bestIdx !== -1) {
    return { index: bestIdx, length: bestLen }
  }

  // Diacritic / NFKC fallback (e.g. matching "cafe" against "Café" or fullwidth Latin)
  let folded = ''
  const origStart: number[] = []
  const origEnd: number[] = []
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!
    const charLen = cp > 0xffff ? 2 : 1
    const piece = text
      .slice(i, i + charLen)
      .normalize('NFKC')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
    for (let j = 0; j < piece.length; j++) {
      folded += piece[j]
      origStart.push(i)
      origEnd.push(i + charLen)
    }
    i += charLen
  }

  for (const tok of tokens) {
    if (!tok) continue
    const fIdx = folded.indexOf(tok)
    if (fIdx !== -1) {
      const start = origStart[fIdx]!
      const end = origEnd[fIdx + tok.length - 1]!
      const len = end - start
      if (bestIdx === -1 || start < bestIdx || (start === bestIdx && len > bestLen)) {
        bestIdx = start
        bestLen = len
      }
    }
  }

  return bestIdx !== -1 ? { index: bestIdx, length: bestLen } : null
}

function sliceCenteredSnippet(
  clean: string,
  match: { index: number; length: number } | null,
  maxChars: number,
): string {
  if (!clean) return ''
  if (clean.length <= maxChars) return clean
  if (maxChars <= 1) return clean.slice(0, Math.max(0, maxChars))

  if (!match) {
    let end = maxChars - 1
    if (end > 0 && isHighSurrogate(clean.charCodeAt(end - 1))) {
      end -= 1
    }
    const lastSpace = clean.lastIndexOf(' ', end)
    if (lastSpace > end - 24 && lastSpace > Math.floor(maxChars * 0.5)) {
      end = lastSpace
    }
    return `${clean.slice(0, end).trimEnd()}…`
  }

  const matchStart = match.index
  const matchEnd = Math.min(clean.length, match.index + match.length)
  const budget = Math.max(1, maxChars - 2)
  const lead = Math.max(0, Math.floor((budget - (matchEnd - matchStart)) / 2))
  let start = Math.max(0, matchStart - lead)
  let end = start + budget
  if (end >= clean.length) {
    end = clean.length
    start = Math.max(0, end - budget)
  }

  if (start > 0) {
    const nextSpace = clean.indexOf(' ', start)
    if (nextSpace !== -1 && nextSpace < matchStart && nextSpace - start <= 20) {
      start = nextSpace + 1
    }
    if (start < clean.length && isLowSurrogate(clean.charCodeAt(start))) {
      start += 1
    }
  }

  if (end < clean.length) {
    const prevSpace = clean.lastIndexOf(' ', end)
    if (prevSpace > matchEnd && end - prevSpace <= 20) {
      end = prevSpace
    }
    if (end > start && isHighSurrogate(clean.charCodeAt(end - 1))) {
      end -= 1
    }
  }

  const slice = clean.slice(start, end).trim()
  const prefix = start > 0 ? '…' : ''
  const suffix = end < clean.length ? '…' : ''
  return `${prefix}${slice}${suffix}`
}

/**
 * Extracts a clean centered excerpt (~220 chars, whitespace-collapsed) from `body`,
 * falling back to `summary` and then `title`, centered around the first case-insensitive
 * match of any extracted query token (supporting both English and CJK terms).
 */
export function extractWikiSnippet(
  page: { title: string; summary: string; body: string },
  tokens: readonly string[],
  maxChars = WIKI_SNIPPET_MAX_CHARS,
): string {
  const body = normalizeWhitespace(page.body)
  const summary = normalizeWhitespace(page.summary)
  const title = normalizeWhitespace(page.title)

  if (body) {
    const match = findFirstMatch(body, tokens)
    if (match) return sliceCenteredSnippet(body, match, maxChars)
  }
  if (summary) {
    const match = findFirstMatch(summary, tokens)
    if (match) return sliceCenteredSnippet(summary, match, maxChars)
  }

  const fallback = body || summary || title
  const fallbackMatch = fallback === title ? findFirstMatch(title, tokens) : null
  return sliceCenteredSnippet(fallback, fallbackMatch, maxChars)
}

export function searchWikiRrf(
  db: Db,
  opts: {
    queries: readonly string[]
    kind?: WikiKind
    limit?: number
    maxLimit?: number
    now?: number
  },
): WikiSearchHit[] {
  if (!Array.isArray(opts.queries) || opts.queries.length === 0) return []
  const hasKind = opts.kind !== undefined
  if (hasKind && !isWikiKind(opts.kind)) return []

  const preparedQueries: Array<{ raw: string; andMatch: string; tokens: string[] }> = []
  const seenRaw = new Set<string>()
  const seenMatch = new Set<string>()

  for (const raw of opts.queries) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    const rawKey = trimmed.normalize('NFKC').toLowerCase()
    if (seenRaw.has(rawKey)) continue
    seenRaw.add(rawKey)

    const andQuery = buildFtsQuery(trimmed, 'and')
    if (!andQuery) continue
    if (seenMatch.has(andQuery.match)) continue
    seenMatch.add(andQuery.match)

    preparedQueries.push({ raw: trimmed, andMatch: andQuery.match, tokens: andQuery.tokens })
    if (preparedQueries.length >= MAX_RRF_QUERIES) break
  }

  if (preparedQueries.length === 0) return []

  const maxLimit =
    typeof opts.maxLimit === 'number' && Number.isFinite(opts.maxLimit)
      ? Math.max(1, Math.min(200, Math.floor(opts.maxLimit)))
      : MAX_WIKI_SEARCH_LIMIT
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit)
      ? Math.max(1, Math.min(maxLimit, Math.floor(opts.limit)))
      : Math.min(DEFAULT_WIKI_SEARCH_LIMIT, maxLimit)
  const perQueryLimit = Math.max(RRF_PER_QUERY_LIMIT, limit)

  const stmt = hasKind
    ? db.prepare(
        `SELECT p.id, p.kind, p.slug, p.title, p.summary, p.tags_json, p.body,
                p.source_tainted, p.updated_by, p.version, p.created_at, p.updated_at,
                bm25(wiki_fts, 0.0, 5.0, 3.0, 2.0, 1.0, 2.0) AS rank_score
         FROM wiki_fts
         JOIN wiki_pages p ON p.id = wiki_fts.page_id
         WHERE wiki_fts MATCH ? AND p.archived_at IS NULL AND p.kind = ?
         ORDER BY rank_score ASC, p.updated_at DESC, p.id ASC
         LIMIT ?`,
      )
    : db.prepare(
        `SELECT p.id, p.kind, p.slug, p.title, p.summary, p.tags_json, p.body,
                p.source_tainted, p.updated_by, p.version, p.created_at, p.updated_at,
                bm25(wiki_fts, 0.0, 5.0, 3.0, 2.0, 1.0, 2.0) AS rank_score
         FROM wiki_fts
         JOIN wiki_pages p ON p.id = wiki_fts.page_id
         WHERE wiki_fts MATCH ? AND p.archived_at IS NULL
         ORDER BY rank_score ASC, p.updated_at DESC, p.id ASC
         LIMIT ?`,
      )

  const runMatch = (matchExpr: string): RawRrfRow[] =>
    (hasKind
      ? stmt.all(matchExpr, opts.kind!, perQueryLimit)
      : stmt.all(matchExpr, perQueryLimit)) as RawRrfRow[]

  const rrfScores = new Map<string, number>()
  const rowsById = new Map<string, RawRrfRow>()

  for (const q of preparedQueries) {
    let rows = runMatch(q.andMatch)
    let weight = 1.0
    if (rows.length === 0 && q.tokens.length >= OR_FALLBACK_MIN_TOKENS) {
      const orQuery = buildFtsQuery(q.raw, 'or')
      if (orQuery) {
        rows = runMatch(orQuery.match)
        weight = OR_FALLBACK_WEIGHT
      }
    }

    const seenInQuery = new Set<string>()
    let rank = 0
    for (const row of rows) {
      if (seenInQuery.has(row.id)) continue
      seenInQuery.add(row.id)
      rank += 1
      rrfScores.set(row.id, (rrfScores.get(row.id) ?? 0) + weight / (RRF_K + rank))
      if (!rowsById.has(row.id)) {
        rowsById.set(row.id, row)
      }
    }
  }

  if (rrfScores.size === 0) return []

  const nowMs = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
  const scored: Array<{ row: RawRrfRow; score: number }> = []
  for (const [id, rrfScore] of rrfScores) {
    const row = rowsById.get(id)!
    const ageDays = Math.max(0, (nowMs - row.updated_at) / MS_PER_DAY)
    const decay = DECAY_BASE + DECAY_RECENCY * Math.exp(-ageDays / DECAY_HALF_SCALE_DAYS)
    scored.push({ row, score: rrfScore * decay })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.row.updated_at !== a.row.updated_at) return b.row.updated_at - a.row.updated_at
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0
  })

  const allTokens: string[] = []
  const seenTokens = new Set<string>()
  for (const q of preparedQueries) {
    for (const tok of q.tokens) {
      if (!seenTokens.has(tok)) {
        seenTokens.add(tok)
        allTokens.push(tok)
      }
    }
  }

  return scored.slice(0, limit).map(({ row, score }) => ({
    id: row.id,
    kind: row.kind as WikiKind,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    tags: parseTagsJson(row.tags_json),
    sourceTainted: row.source_tainted === 1,
    updatedBy: row.updated_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    score,
    snippet: extractWikiSnippet(
      { title: row.title, summary: row.summary, body: row.body },
      allTokens,
      WIKI_SNIPPET_MAX_CHARS,
    ),
  }))
}
