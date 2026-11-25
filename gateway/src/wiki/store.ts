import { createHash } from 'node:crypto'
import type { Db } from '../db.js'
import { removeWikiMirror, writeWikiMirror } from './mirror.js'
import {
  applyWikiSectionPatch,
  containsWikiSecret,
  scrubWikiSecrets,
  stripModelChangeLogSections,
} from './sections.js'
import { buildSearchText } from './tokenize.js'
import {
  isWikiKind,
  isWikiSlug,
  MAX_WIKI_BODY_CHARS,
  MAX_WIKI_NOTE_CHARS,
  MAX_WIKI_REVISIONS,
  MAX_WIKI_SLUG_CHARS,
  MAX_WIKI_SUMMARY_CHARS,
  MAX_WIKI_TAG_CHARS,
  MAX_WIKI_TAGS,
  MAX_WIKI_TITLE_CHARS,
  parseWikiPageId,
  WikiConflictError,
  WikiValidationError,
  type WikiKind,
  type WikiPageDetail,
  type WikiPageSummary,
  type WikiPatchInput,
  type WikiRevision,
  type WikiUpsertInput,
} from './types.js'

type RawWikiPageRow = {
  id: string
  kind: string
  slug: string
  title: string
  summary: string
  tags_json: string
  body: string
  search_text: string
  source_tainted: number
  updated_by: string
  version: number
  created_at: number
  updated_at: number
  archived_at: number | null
}

type RawWikiPageSummaryRow = Omit<RawWikiPageRow, 'body' | 'search_text' | 'archived_at'>

type RawWikiRevisionRow = {
  id: number
  page_id: string
  version: number
  title: string
  summary: string
  tags_json: string
  body: string
  edited_by: string
  note: string
  source_tainted: number
  created_at: number
}

function parseTagsJson(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function mapSummaryRow(r: RawWikiPageSummaryRow): WikiPageSummary {
  return {
    id: r.id,
    kind: r.kind as WikiKind,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    tags: parseTagsJson(r.tags_json),
    sourceTainted: r.source_tainted === 1,
    updatedBy: r.updated_by,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapDetailRow(r: RawWikiPageRow): WikiPageDetail {
  return {
    ...mapSummaryRow(r),
    body: r.body,
    archivedAt: r.archived_at ?? null,
  }
}

function mapRevisionRow(r: RawWikiRevisionRow): WikiRevision {
  return {
    id: r.id,
    pageId: r.page_id,
    version: r.version,
    title: r.title,
    summary: r.summary,
    tags: parseTagsJson(r.tags_json),
    body: r.body,
    editedBy: r.edited_by,
    note: r.note,
    sourceTainted: r.source_tainted === 1,
    createdAt: r.created_at,
  }
}

function normalizeTitleKey(title: string): string {
  return title.trim().normalize('NFKC').toLowerCase()
}

function sanitizeTags(tags?: readonly string[]): string[] {
  if (tags === undefined) return []
  if (!Array.isArray(tags)) {
    throw new WikiValidationError('Wiki tags must be an array of strings')
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') {
      throw new WikiValidationError('Wiki tags must be an array of strings')
    }
    const cleaned = raw.trim()
    if (!cleaned) continue
    if (cleaned.length > MAX_WIKI_TAG_CHARS) {
      throw new WikiValidationError(`Wiki tag exceeds ${MAX_WIKI_TAG_CHARS} characters`)
    }
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length > MAX_WIKI_TAGS) {
      throw new WikiValidationError(`Wiki page exceeds ${MAX_WIKI_TAGS} tags`)
    }
  }
  return out
}

function syncWikiFts(
  db: Db,
  page: { id: string; title: string; tags: string[]; summary: string; body: string; searchText: string },
): void {
  db.prepare('DELETE FROM wiki_fts WHERE page_id = ?').run(page.id)
  db.prepare(
    `INSERT INTO wiki_fts (page_id, title, tags, summary, body, search_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(page.id, page.title, page.tags.join(' '), page.summary, page.body, page.searchText)
}

function pruneRevisions(db: Db, pageId: string): void {
  db.prepare(
    `DELETE FROM wiki_revisions
     WHERE page_id = ?
       AND version NOT IN (
         SELECT version FROM wiki_revisions
         WHERE page_id = ?
         ORDER BY version DESC
         LIMIT ?
       )`,
  ).run(pageId, pageId, MAX_WIKI_REVISIONS)
}

/**
 * Normalizes a raw title or slug into a URL-safe `[a-z0-9][a-z0-9-]{0,63}` slug.
 * Pure non-ASCII titles (e.g. `"极光项目"`) deterministically hash to `p-<8-hex>`.
 * Returns `""` when the input contains no letters or digits.
 */
export function normalizeWikiSlug(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const ascii = trimmed
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WIKI_SLUG_CHARS)
    .replace(/-+$/, '')
  if (ascii) return ascii
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return ''
  const hash = createHash('sha256')
    .update(trimmed.normalize('NFKC').toLowerCase())
    .digest('hex')
    .slice(0, 8)
  return `p-${hash}`
}

/**
 * Allocates a valid slug for `(kind, title)`.
 * - If `requestedSlug` is explicitly provided, validates it (rejecting path separators/`..` or empty slugs)
 *   and returns the normalized slug so callers can target a page directly.
 * - If `requestedSlug` is omitted, derives a deterministic slug from `title`. When a page already exists
 *   under that slug with the same normalized title, reuses it for idempotent upserts; when a different title
 *   owns the slug (e.g. two Chinese titles sharing an ASCII token like `"Q3"`), appends `-2`, `-3`, ...
 */
export function allocateWikiSlug(
  db: Db,
  kind: WikiKind,
  requestedSlug: string | undefined,
  title: string,
): string {
  if (!isWikiKind(kind)) {
    throw new WikiValidationError(`Invalid wiki kind: ${String(kind)}`)
  }
  if (requestedSlug !== undefined) {
    if (typeof requestedSlug !== 'string') {
      throw new WikiValidationError('Wiki slug must be a string')
    }
    const trimmed = requestedSlug.trim()
    if (!trimmed || trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
      throw new WikiValidationError(`Invalid wiki slug: ${requestedSlug}`)
    }
    if (containsWikiSecret(trimmed)) {
      throw new WikiValidationError('Wiki slug must not contain secret tokens or API keys')
    }
    const normalized = normalizeWikiSlug(trimmed)
    if (!isWikiSlug(normalized)) {
      throw new WikiValidationError(`Invalid wiki slug: ${requestedSlug}`)
    }
    return normalized
  }

  const safeTitle = scrubWikiSecrets(title)
  const base = normalizeWikiSlug(safeTitle)
  if (!isWikiSlug(base)) {
    throw new WikiValidationError(`Cannot derive valid wiki slug from title: ${title}`)
  }

  const targetTitleKey = normalizeTitleKey(title)
  const lookup = db.prepare('SELECT title FROM wiki_pages WHERE kind = ? AND slug = ?')

  const first = lookup.get(kind, base) as { title: string } | undefined
  if (!first || normalizeTitleKey(first.title) === targetTitleKey) {
    return base
  }

  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const maxPrefix = Math.max(1, MAX_WIKI_SLUG_CHARS - suffix.length)
    const prefix = base.slice(0, maxPrefix).replace(/-+$/, '') || 'p'
    const candidate = `${prefix}${suffix}`
    const row = lookup.get(kind, candidate) as { title: string } | undefined
    if (!row || normalizeTitleKey(row.title) === targetTitleKey) {
      return candidate
    }
  }
}

export function upsertWikiPage(
  db: Db,
  input: WikiUpsertInput,
  opts: { dataDir?: string; now?: number; createOnly?: boolean } = {},
): { page: WikiPageDetail; created: boolean } {
  if (!isWikiKind(input.kind)) {
    throw new WikiValidationError(`Invalid wiki kind: ${String(input.kind)}`)
  }
  if (input.slug !== undefined && typeof input.slug !== 'string') {
    throw new WikiValidationError('Wiki slug must be a string')
  }

  const editedBy = typeof input.editedBy === 'string' ? input.editedBy.trim() : ''
  if (!editedBy) throw new WikiValidationError('Wiki editedBy is required')
  const isOperator = editedBy === 'operator'

  const rawTitle = typeof input.title === 'string' ? input.title.trim() : ''
  const title = isOperator ? rawTitle : scrubWikiSecrets(rawTitle).trim()
  if (!title) throw new WikiValidationError('Wiki title is required')
  if (title.length > MAX_WIKI_TITLE_CHARS) {
    throw new WikiValidationError(`Wiki title exceeds ${MAX_WIKI_TITLE_CHARS} characters`)
  }

  if (input.summary !== undefined && typeof input.summary !== 'string') {
    throw new WikiValidationError('Wiki summary must be a string')
  }
  const rawSummary = (input.summary ?? '').trim()
  const summary = isOperator ? rawSummary : scrubWikiSecrets(rawSummary).trim()
  if (summary.length > MAX_WIKI_SUMMARY_CHARS) {
    throw new WikiValidationError(`Wiki summary exceeds ${MAX_WIKI_SUMMARY_CHARS} characters`)
  }

  if (typeof input.body !== 'string') {
    throw new WikiValidationError('Wiki body must be a string')
  }
  const body = isOperator
    ? input.body
    : stripModelChangeLogSections(scrubWikiSecrets(input.body))
  if (body.length > MAX_WIKI_BODY_CHARS) {
    throw new WikiValidationError(`Wiki body exceeds ${MAX_WIKI_BODY_CHARS} characters`)
  }

  if (input.note !== undefined && typeof input.note !== 'string') {
    throw new WikiValidationError('Wiki note must be a string')
  }
  const rawNote = (input.note ?? '').trim()
  const note = isOperator ? rawNote : scrubWikiSecrets(rawNote).trim()
  if (note.length > MAX_WIKI_NOTE_CHARS) {
    throw new WikiValidationError(`Wiki note exceeds ${MAX_WIKI_NOTE_CHARS} characters`)
  }

  const rawTags =
    !isOperator && Array.isArray(input.tags)
      ? input.tags.map((t) => (typeof t === 'string' ? scrubWikiSecrets(t) : t))
      : input.tags
  const tags = sanitizeTags(rawTags)
  const tagsJson = JSON.stringify(tags)
  const now = opts.now ?? Date.now()

  const result = db.transaction((): { page: WikiPageDetail; created: boolean } => {
    const slug = allocateWikiSlug(db, input.kind, input.slug, title)
    const id = `${input.kind}/${slug}`
    const existing = db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as RawWikiPageRow | undefined

    if (opts.createOnly && existing && existing.archived_at === null) {
      throw new WikiConflictError(`Wiki page already exists: ${id}`)
    }

    const created = !existing || existing.archived_at !== null
    const nextVersion = existing ? existing.version + 1 : 1
    const nextTainted =
      editedBy === 'operator'
        ? 0
        : (existing && existing.archived_at === null && existing.source_tainted === 1) || Boolean(input.sourceTainted)
          ? 1
          : 0

    const searchText = buildSearchText([title, slug, tags.join(' '), summary, body])

    if (!existing) {
      db.prepare(
        `INSERT INTO wiki_pages (
           id, kind, slug, title, summary, tags_json, body, search_text,
           source_tainted, updated_by, version, created_at, updated_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        id,
        input.kind,
        slug,
        title,
        summary,
        tagsJson,
        body,
        searchText,
        nextTainted,
        editedBy,
        nextVersion,
        now,
        now,
      )
    } else {
      db.prepare(
        `UPDATE wiki_pages
         SET title = ?, summary = ?, tags_json = ?, body = ?, search_text = ?,
             source_tainted = ?, updated_by = ?, version = ?, updated_at = ?, archived_at = NULL
         WHERE id = ?`,
      ).run(
        title,
        summary,
        tagsJson,
        body,
        searchText,
        nextTainted,
        editedBy,
        nextVersion,
        now,
        id,
      )
    }

    db.prepare(
      `INSERT INTO wiki_revisions (
         page_id, version, title, summary, tags_json, body,
         edited_by, note, source_tainted, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, nextVersion, title, summary, tagsJson, body, editedBy, note, nextTainted, now)

    pruneRevisions(db, id)
    syncWikiFts(db, { id, title, tags, summary, body, searchText })

    const row = db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as RawWikiPageRow
    return { page: mapDetailRow(row), created }
  })()

  writeWikiMirror(opts.dataDir, result.page)
  return result
}

export function patchWikiPage(
  db: Db,
  input: WikiPatchInput,
  opts: { dataDir?: string; now?: number } = {},
): { page: WikiPageDetail; created: boolean; changeSummary: string } {
  if (!isWikiKind(input.kind)) {
    throw new WikiValidationError(`Invalid wiki kind: ${String(input.kind)}`)
  }
  if (input.slug !== undefined && typeof input.slug !== 'string') {
    throw new WikiValidationError('Wiki slug must be a string')
  }
  if (input.title !== undefined && typeof input.title !== 'string') {
    throw new WikiValidationError('Wiki title must be a string')
  }
  if (input.summary !== undefined && typeof input.summary !== 'string') {
    throw new WikiValidationError('Wiki summary must be a string')
  }
  if (input.note !== undefined && typeof input.note !== 'string') {
    throw new WikiValidationError('Wiki note must be a string')
  }

  const editedBy = typeof input.editedBy === 'string' ? input.editedBy.trim() : ''
  if (!editedBy) throw new WikiValidationError('Wiki editedBy is required')

  const requestedSlug = input.slug !== undefined && input.slug.trim() !== '' ? input.slug : undefined
  const providedTitle = input.title !== undefined ? scrubWikiSecrets(input.title).trim() : ''
  if (providedTitle.length > MAX_WIKI_TITLE_CHARS) {
    throw new WikiValidationError(`Wiki title exceeds ${MAX_WIKI_TITLE_CHARS} characters`)
  }

  const hasSummary = input.summary !== undefined
  const providedSummary = hasSummary ? scrubWikiSecrets(input.summary!).trim() : ''
  if (providedSummary.length > MAX_WIKI_SUMMARY_CHARS) {
    throw new WikiValidationError(`Wiki summary exceeds ${MAX_WIKI_SUMMARY_CHARS} characters`)
  }

  const providedNote = input.note !== undefined ? scrubWikiSecrets(input.note).trim() : ''
  if (providedNote.length > MAX_WIKI_NOTE_CHARS) {
    throw new WikiValidationError(`Wiki note exceeds ${MAX_WIKI_NOTE_CHARS} characters`)
  }

  const scrubbedTags =
    input.tags !== undefined
      ? Array.isArray(input.tags)
        ? input.tags.map((t) => (typeof t === 'string' ? scrubWikiSecrets(t) : t))
        : input.tags
      : undefined
  const validatedTags = scrubbedTags !== undefined ? sanitizeTags(scrubbedTags) : undefined

  const now = opts.now ?? Date.now()

  const result = db.transaction((): { page: WikiPageDetail; created: boolean; changeSummary: string } => {
    let slug: string
    if (requestedSlug !== undefined) {
      slug = allocateWikiSlug(db, input.kind, requestedSlug, providedTitle || requestedSlug)
    } else {
      if (!providedTitle) {
        throw new WikiValidationError('Wiki patch requires "slug" or "title"')
      }
      slug = allocateWikiSlug(db, input.kind, undefined, providedTitle)
    }

    const id = `${input.kind}/${slug}`
    const existing = db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as RawWikiPageRow | undefined
    const isActiveExisting = Boolean(existing && existing.archived_at === null)
    const created = !isActiveExisting

    const finalTitle = providedTitle || (isActiveExisting ? existing!.title : '')
    if (!finalTitle) {
      throw new WikiValidationError(`Wiki page not found: ${id} (provide "title" to create a new page)`)
    }

    const finalSummary = hasSummary ? providedSummary : isActiveExisting ? existing!.summary : ''
    const finalTags =
      validatedTags !== undefined ? validatedTags : isActiveExisting ? parseTagsJson(existing!.tags_json) : []
    const tagsJson = JSON.stringify(finalTags)

    const metaChanges: string[] = []
    if (created) {
      metaChanges.push('created page')
    } else {
      if (finalTitle !== existing!.title) metaChanges.push('updated title')
      if (finalSummary !== existing!.summary) metaChanges.push('updated summary')
      if (tagsJson !== existing!.tags_json) metaChanges.push('updated tags')
    }

    const patched = applyWikiSectionPatch(
      isActiveExisting ? existing!.body : '',
      {
        ...(input.overview !== undefined ? { overview: input.overview } : {}),
        ...(input.keyFacts !== undefined ? { keyFacts: input.keyFacts } : {}),
        ...(input.openItems !== undefined ? { openItems: input.openItems } : {}),
        ...(input.decisions !== undefined ? { decisions: input.decisions } : {}),
      },
      {
        actor: editedBy,
        at: now,
        ...(providedNote ? { note: providedNote } : {}),
        ...(metaChanges.length > 0 ? { fallbackNote: metaChanges.join(', ') } : {}),
      },
    )

    if (!created && !patched.changed && metaChanges.length === 0) {
      throw new WikiValidationError('Wiki patch contains no changes')
    }

    if (patched.body.length > MAX_WIKI_BODY_CHARS) {
      throw new WikiValidationError(`Wiki body exceeds ${MAX_WIKI_BODY_CHARS} characters`)
    }

    const nextVersion = existing ? existing.version + 1 : 1
    const nextTainted =
      editedBy === 'operator'
        ? 0
        : (isActiveExisting && existing!.source_tainted === 1) || Boolean(input.sourceTainted)
          ? 1
          : 0

    const revNote = (providedNote || patched.changeSummary).slice(0, MAX_WIKI_NOTE_CHARS)
    const searchText = buildSearchText([finalTitle, slug, finalTags.join(' '), finalSummary, patched.body])

    if (!existing) {
      db.prepare(
        `INSERT INTO wiki_pages (
           id, kind, slug, title, summary, tags_json, body, search_text,
           source_tainted, updated_by, version, created_at, updated_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        id,
        input.kind,
        slug,
        finalTitle,
        finalSummary,
        tagsJson,
        patched.body,
        searchText,
        nextTainted,
        editedBy,
        nextVersion,
        now,
        now,
      )
    } else {
      db.prepare(
        `UPDATE wiki_pages
         SET title = ?, summary = ?, tags_json = ?, body = ?, search_text = ?,
             source_tainted = ?, updated_by = ?, version = ?, updated_at = ?, archived_at = NULL
         WHERE id = ?`,
      ).run(
        finalTitle,
        finalSummary,
        tagsJson,
        patched.body,
        searchText,
        nextTainted,
        editedBy,
        nextVersion,
        now,
        id,
      )
    }

    db.prepare(
      `INSERT INTO wiki_revisions (
         page_id, version, title, summary, tags_json, body,
         edited_by, note, source_tainted, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, nextVersion, finalTitle, finalSummary, tagsJson, patched.body, editedBy, revNote, nextTainted, now)

    pruneRevisions(db, id)
    syncWikiFts(db, { id, title: finalTitle, tags: finalTags, summary: finalSummary, body: patched.body, searchText })

    const row = db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as RawWikiPageRow
    return { page: mapDetailRow(row), created, changeSummary: patched.changeSummary }
  })()

  writeWikiMirror(opts.dataDir, result.page)
  return result
}

export function getWikiPage(
  db: Db,
  kind: WikiKind,
  slug: string,
  opts: { includeArchived?: boolean } = {},
): WikiPageDetail | null {
  if (!isWikiKind(kind) || !isWikiSlug(slug)) return null
  const sql = opts.includeArchived
    ? 'SELECT * FROM wiki_pages WHERE kind = ? AND slug = ?'
    : 'SELECT * FROM wiki_pages WHERE kind = ? AND slug = ? AND archived_at IS NULL'
  const row = db.prepare(sql).get(kind, slug) as RawWikiPageRow | undefined
  return row ? mapDetailRow(row) : null
}

export function getWikiPageById(
  db: Db,
  id: string,
  opts: { includeArchived?: boolean } = {},
): WikiPageDetail | null {
  const parsed = parseWikiPageId(id)
  if (!parsed) return null
  return getWikiPage(db, parsed.kind, parsed.slug, opts)
}

export function listWikiPages(
  db: Db,
  opts: { kind?: WikiKind; limit?: number } = {},
): { pages: WikiPageSummary[]; total: number } {
  const rawLimit = opts.limit
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(200, Math.floor(rawLimit)))
      : 50

  if (opts.kind !== undefined) {
    if (!isWikiKind(opts.kind)) return { pages: [], total: 0 }
    const total = Number(
      db.prepare('SELECT COUNT(*) AS n FROM wiki_pages WHERE archived_at IS NULL AND kind = ?').pluck().get(opts.kind),
    )
    const rows = db
      .prepare(
        `SELECT id, kind, slug, title, summary, tags_json, source_tainted, updated_by, version, created_at, updated_at
         FROM wiki_pages
         WHERE archived_at IS NULL AND kind = ?
         ORDER BY updated_at DESC, id ASC
         LIMIT ?`,
      )
      .all(opts.kind, limit) as RawWikiPageSummaryRow[]
    return { pages: rows.map(mapSummaryRow), total }
  }

  const total = Number(
    db.prepare('SELECT COUNT(*) AS n FROM wiki_pages WHERE archived_at IS NULL').pluck().get(),
  )
  const rows = db
    .prepare(
      `SELECT id, kind, slug, title, summary, tags_json, source_tainted, updated_by, version, created_at, updated_at
       FROM wiki_pages
       WHERE archived_at IS NULL
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
    )
    .all(limit) as RawWikiPageSummaryRow[]
  return { pages: rows.map(mapSummaryRow), total }
}

export function listWikiRevisions(db: Db, pageId: string): WikiRevision[] {
  if (!parseWikiPageId(pageId)) return []
  const rows = db
    .prepare('SELECT * FROM wiki_revisions WHERE page_id = ? ORDER BY version DESC')
    .all(pageId) as RawWikiRevisionRow[]
  return rows.map(mapRevisionRow)
}

export function revertWikiPage(
  db: Db,
  kind: WikiKind,
  slug: string,
  targetVersion: number,
  opts: { editedBy: string; note?: string; dataDir?: string; now?: number },
): WikiPageDetail | null {
  if (!isWikiKind(kind) || !isWikiSlug(slug)) return null
  if (!Number.isInteger(targetVersion) || targetVersion < 1) return null

  const editedBy = typeof opts.editedBy === 'string' ? opts.editedBy.trim() : ''
  if (!editedBy) throw new WikiValidationError('Wiki editedBy is required')

  if (opts.note !== undefined && typeof opts.note !== 'string') {
    throw new WikiValidationError('Wiki note must be a string')
  }
  const trimmedNote = (opts.note ?? '').trim()
  const note = trimmedNote || `Reverted to v${targetVersion}`
  if (note.length > MAX_WIKI_NOTE_CHARS) {
    throw new WikiValidationError(`Wiki note exceeds ${MAX_WIKI_NOTE_CHARS} characters`)
  }

  const now = opts.now ?? Date.now()
  const id = `${kind}/${slug}`

  const updated = db.transaction((): WikiPageDetail | null => {
    const page = db
      .prepare('SELECT * FROM wiki_pages WHERE id = ? AND archived_at IS NULL')
      .get(id) as RawWikiPageRow | undefined
    if (!page) return null

    const targetRev = db
      .prepare('SELECT * FROM wiki_revisions WHERE page_id = ? AND version = ?')
      .get(id, targetVersion) as RawWikiRevisionRow | undefined
    if (!targetRev) return null

    const nextVersion = page.version + 1
    const nextTainted =
      editedBy === 'operator'
        ? 0
        : targetRev.source_tainted === 1 || page.source_tainted === 1
          ? 1
          : 0

    const tags = parseTagsJson(targetRev.tags_json)
    const searchText = buildSearchText([targetRev.title, slug, tags.join(' '), targetRev.summary, targetRev.body])

    db.prepare(
      `UPDATE wiki_pages
       SET title = ?, summary = ?, tags_json = ?, body = ?, search_text = ?,
           source_tainted = ?, updated_by = ?, version = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      targetRev.title,
      targetRev.summary,
      targetRev.tags_json,
      targetRev.body,
      searchText,
      nextTainted,
      editedBy,
      nextVersion,
      now,
      id,
    )

    db.prepare(
      `INSERT INTO wiki_revisions (
         page_id, version, title, summary, tags_json, body,
         edited_by, note, source_tainted, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      nextVersion,
      targetRev.title,
      targetRev.summary,
      targetRev.tags_json,
      targetRev.body,
      editedBy,
      note,
      nextTainted,
      now,
    )

    pruneRevisions(db, id)
    syncWikiFts(db, {
      id,
      title: targetRev.title,
      tags,
      summary: targetRev.summary,
      body: targetRev.body,
      searchText,
    })

    const row = db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as RawWikiPageRow
    return mapDetailRow(row)
  })()

  if (updated) {
    writeWikiMirror(opts.dataDir, updated)
  }
  return updated
}

export function archiveWikiPage(
  db: Db,
  kind: WikiKind,
  slug: string,
  opts: { dataDir?: string; now?: number } = {},
): boolean {
  if (!isWikiKind(kind) || !isWikiSlug(slug)) return false
  const id = `${kind}/${slug}`
  const now = opts.now ?? Date.now()

  const archived = db.transaction((): boolean => {
    const info = db
      .prepare('UPDATE wiki_pages SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(now, now, id)
    if (info.changes === 0) return false
    db.prepare('DELETE FROM wiki_fts WHERE page_id = ?').run(id)
    return true
  })()

  if (archived) {
    removeWikiMirror(opts.dataDir, kind, slug)
  }
  return archived
}
