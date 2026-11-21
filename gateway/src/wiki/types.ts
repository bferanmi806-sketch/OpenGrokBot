export const WIKI_KINDS = ['contact', 'client', 'project', 'topic'] as const

export type WikiKind = (typeof WIKI_KINDS)[number]

const WIKI_KIND_SET: ReadonlySet<string> = new Set(WIKI_KINDS)

export function isWikiKind(value: unknown): value is WikiKind {
  return typeof value === 'string' && WIKI_KIND_SET.has(value)
}

export const WIKI_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isWikiSlug(value: unknown): value is string {
  return typeof value === 'string' && WIKI_SLUG_RE.test(value)
}

export function parseWikiPageId(id: string): { kind: WikiKind; slug: string } | null {
  const slash = id.indexOf('/')
  if (slash <= 0 || id.indexOf('/', slash + 1) !== -1) return null
  const kind = id.slice(0, slash)
  const slug = id.slice(slash + 1)
  if (!isWikiKind(kind) || !WIKI_SLUG_RE.test(slug)) return null
  return { kind, slug }
}

export const MAX_WIKI_SLUG_CHARS = 64
export const MAX_WIKI_TITLE_CHARS = 160
export const MAX_WIKI_SUMMARY_CHARS = 300
export const MAX_WIKI_BODY_CHARS = 64_000
export const MAX_WIKI_NOTE_CHARS = 200
export const MAX_WIKI_TAGS = 12
export const MAX_WIKI_TAG_CHARS = 40
export const MAX_WIKI_REVISIONS = 20
export const MAX_WIKI_SEARCH_TEXT_CHARS = 128_000

export class WikiValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WikiValidationError'
  }
}

export type WikiPageSummary = {
  id: string
  kind: WikiKind
  slug: string
  title: string
  summary: string
  tags: string[]
  sourceTainted: boolean
  updatedBy: string
  version: number
  createdAt: number
  updatedAt: number
}

export type WikiPageDetail = WikiPageSummary & {
  body: string
  archivedAt: number | null
}

export type WikiRevision = {
  id: number
  pageId: string
  version: number
  title: string
  summary: string
  tags: string[]
  body: string
  editedBy: string
  note: string
  sourceTainted: boolean
  createdAt: number
}

export type WikiUpsertInput = {
  kind: WikiKind
  slug?: string
  title: string
  summary?: string
  tags?: string[]
  body: string
  note?: string
  editedBy: string
  sourceTainted?: boolean
}

export type WikiSearchHit = WikiPageSummary & {
  score: number
  snippet: string
}
