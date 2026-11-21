import { MAX_WIKI_SEARCH_TEXT_CHARS } from './types.js'

const MAX_QUERY_TOKENS = 24
const TOKEN_RE = /([\u3400-\u9FFF\uF900-\uFAFF]+)|([a-z0-9]+(?:[._-][a-z0-9]+)*)/gi

function normalizeForTokenize(text: string): string {
  return text
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
}

/**
 * Builds an FTS5-friendly `search_text` column combining lowercased Latin/alphanumeric tokens
 * (preserving compound tokens like `acme-corp` and also emitting sub-tokens split on `.` / `_` / `-`)
 * and CJK 2-character bigrams (plus unigrams for runs of length 1..4 so short terms match cleanly).
 * Adjacent duplicate tokens are deduplicated and total length is bounded to `MAX_WIKI_SEARCH_TEXT_CHARS`.
 */
export function buildSearchText(parts: readonly string[]): string {
  const out: string[] = []
  let totalLen = 0
  let last = ''

  const push = (tok: string): boolean => {
    if (!tok || tok === last) return true
    const added = (out.length > 0 ? 1 : 0) + tok.length
    if (totalLen + added > MAX_WIKI_SEARCH_TEXT_CHARS) return false
    out.push(tok)
    totalLen += added
    last = tok
    return true
  }

  for (const raw of parts) {
    if (!raw) continue
    const normalized = normalizeForTokenize(raw)
    TOKEN_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TOKEN_RE.exec(normalized)) !== null) {
      const cjk = m[1]
      const latin = m[2]
      if (cjk) {
        if (cjk.length >= 2) {
          for (let i = 0; i < cjk.length - 1; i++) {
            if (!push(cjk.slice(i, i + 2))) return out.join(' ')
          }
        }
        if (cjk.length <= 4) {
          for (let i = 0; i < cjk.length; i++) {
            if (!push(cjk[i]!)) return out.join(' ')
          }
        }
      } else if (latin) {
        if (!push(latin)) return out.join(' ')
        if (/[._-]/.test(latin)) {
          for (const sub of latin.split(/[._-]+/)) {
            if (sub && sub !== latin) {
              if (!push(sub)) return out.join(' ')
            }
          }
        }
      }
    }
  }

  return out.join(' ')
}

/**
 * Extracts normalized unique query tokens using the same Latin + CJK bigram rules:
 * - Latin/alphanumeric words are lowercased, diacritic-folded, and split on `.` / `_` / `-`.
 * - CJK runs of length >= 2 emit adjacent 2-character bigrams; runs of length 1 emit the unigram.
 * - Punctuation and raw FTS5 syntax characters are stripped; capped at 24 unique tokens.
 */
export function extractQueryTokens(rawQuery: string): string[] {
  if (!rawQuery) return []
  const normalized = normalizeForTokenize(rawQuery)
  const seen = new Set<string>()
  const out: string[] = []

  const add = (tok: string): boolean => {
    if (!tok || seen.has(tok)) return out.length < MAX_QUERY_TOKENS
    seen.add(tok)
    out.push(tok)
    return out.length < MAX_QUERY_TOKENS
  }

  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(normalized)) !== null) {
    const cjk = m[1]
    const latin = m[2]
    if (cjk) {
      if (cjk.length === 1) {
        if (!add(cjk)) break
      } else {
        for (let i = 0; i < cjk.length - 1; i++) {
          if (!add(cjk.slice(i, i + 2))) break
        }
        if (out.length >= MAX_QUERY_TOKENS) break
      }
    } else if (latin) {
      for (const sub of latin.split(/[._-]+/)) {
        if (!sub) continue
        if (!add(sub)) break
      }
      if (out.length >= MAX_QUERY_TOKENS) break
    }
  }

  return out
}

export type FtsQuery = {
  match: string
  tokens: string[]
}

/**
 * Builds a safe FTS5 MATCH expression by quoting every extracted token and joining with
 * ` AND ` (default) or ` OR `. Guarantees zero FTS5 syntax errors for arbitrary user input.
 */
export function buildFtsQuery(rawQuery: string, mode: 'and' | 'or' = 'and'): FtsQuery | null {
  const tokens = extractQueryTokens(rawQuery)
  if (tokens.length === 0) return null
  const joiner = mode === 'or' ? ' OR ' : ' AND '
  const match = tokens.map((tok) => `"${tok.replace(/"/g, '""')}"`).join(joiner)
  return { match, tokens }
}
