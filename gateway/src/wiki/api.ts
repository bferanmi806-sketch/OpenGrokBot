import type { Hono } from 'hono'
import type { Db } from '../db.js'
import type { Hub } from '../hub.js'
import { searchWikiRrf } from './rrf.js'
import {
  archiveWikiPage,
  getWikiPage,
  listWikiPages,
  listWikiRevisions,
  revertWikiPage,
  upsertWikiPage,
} from './store.js'
import {
  isWikiKind,
  isWikiSlug,
  WikiConflictError,
  WikiValidationError,
  type WikiKind,
} from './types.js'

export type WikiApiDeps = {
  db: Db
  dataDir: string
  hub?: Hub
  now?: () => Date
  syncFromChats?: () => Promise<{
    threadsSynced: number
    pagesCreated: number
    pagesUpdated: number
  }>
}

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LIST_LIMIT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_LIST_LIMIT
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(parsed)))
}

export function mountWiki(app: Hono, deps: WikiApiDeps): void {
  const { db, dataDir, hub } = deps
  const clock = () => (deps.now ? deps.now().getTime() : Date.now())

  app.get('/api/wiki', (c) => {
    const rawKind = c.req.query('kind')
    let kind: WikiKind | undefined
    if (rawKind !== undefined && rawKind.trim() !== '') {
      if (!isWikiKind(rawKind)) {
        return c.json({ error: `Invalid wiki kind: ${rawKind}`, code: 'invalid_kind' }, 400)
      }
      kind = rawKind
    }

    const limit = parseLimit(c.req.query('limit'))
    const rawQ = (c.req.query('q') ?? '').trim()

    if (!rawQ) {
      const result = listWikiPages(db, { ...(kind ? { kind } : {}), limit })
      return c.json(result)
    }

    const queries = rawQ.includes('|') ? rawQ.split('|') : [rawQ]
    const pages = searchWikiRrf(db, {
      queries,
      ...(kind ? { kind } : {}),
      limit,
      maxLimit: MAX_LIST_LIMIT,
      now: clock(),
    })
    return c.json({ pages, total: pages.length })
  })

  app.post('/api/wiki', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) {
      return c.json({ error: 'Invalid JSON request body', code: 'invalid_wiki' }, 400)
    }
    if (!isWikiKind(body.kind)) {
      return c.json({ error: `Invalid wiki kind: ${String(body.kind)}`, code: 'invalid_kind' }, 400)
    }

    let requestedSlug: string | undefined
    if (body.slug !== undefined) {
      if (typeof body.slug !== 'string') {
        return c.json({ error: 'Wiki slug must be a string', code: 'invalid_slug' }, 400)
      }
      const trimmed = body.slug.trim()
      if (trimmed) {
        if (!isWikiSlug(trimmed)) {
          return c.json({ error: `Invalid wiki slug: ${trimmed}`, code: 'invalid_slug' }, 400)
        }
        requestedSlug = trimmed
      }
    }

    try {
      const { page } = upsertWikiPage(
        db,
        {
          kind: body.kind,
          ...(requestedSlug !== undefined ? { slug: requestedSlug } : {}),
          title: body.title as string,
          ...(body.summary !== undefined ? { summary: body.summary as string } : {}),
          ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
          body: body.body as string,
          ...(body.note !== undefined ? { note: body.note as string } : {}),
          editedBy: 'operator',
          sourceTainted: false,
        },
        { dataDir, now: clock(), createOnly: true },
      )
      hub?.broadcast({ type: 'wiki_changed' })
      const revisions = listWikiRevisions(db, page.id)
      return c.json({ page, revisions }, 201)
    } catch (err) {
      if (err instanceof WikiConflictError) {
        return c.json({ error: err.message, code: 'already_exists' }, 409)
      }
      if (err instanceof WikiValidationError) {
        return c.json({ error: err.message, code: 'invalid_wiki' }, 400)
      }
      throw err
    }
  })

  app.post('/api/wiki/sync', async (c) => {
    if (!deps.syncFromChats) {
      return c.json({ error: 'Wiki chat sync is not available on this gateway', code: 'not_implemented' }, 501)
    }
    try {
      const res = await deps.syncFromChats()
      return c.json(
        {
          ok: true,
          threadsSynced: res.threadsSynced,
          pagesCreated: res.pagesCreated,
          pagesUpdated: res.pagesUpdated,
        },
        200,
      )
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : String(err),
          code: 'sync_failed',
        },
        502,
      )
    }
  })

  app.get('/api/wiki/:kind/:slug', (c) => {
    const kind = c.req.param('kind')
    const slug = c.req.param('slug')
    if (!isWikiKind(kind)) {
      return c.json({ error: `Invalid wiki kind: ${kind}`, code: 'invalid_kind' }, 400)
    }
    if (!isWikiSlug(slug)) {
      return c.json({ error: `Invalid wiki slug: ${slug}`, code: 'invalid_slug' }, 400)
    }

    const page = getWikiPage(db, kind, slug)
    if (!page) {
      return c.json({ error: 'Wiki page not found', code: 'not_found' }, 404)
    }
    const revisions = listWikiRevisions(db, page.id)
    return c.json({ page, revisions })
  })

  app.put('/api/wiki/:kind/:slug', async (c) => {
    const kind = c.req.param('kind')
    const slug = c.req.param('slug')
    if (!isWikiKind(kind)) {
      return c.json({ error: `Invalid wiki kind: ${kind}`, code: 'invalid_kind' }, 400)
    }
    if (!isWikiSlug(slug)) {
      return c.json({ error: `Invalid wiki slug: ${slug}`, code: 'invalid_slug' }, 400)
    }

    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) {
      return c.json({ error: 'Invalid JSON request body', code: 'invalid_wiki' }, 400)
    }

    try {
      const { page, created } = upsertWikiPage(
        db,
        {
          kind,
          slug,
          title: body.title as string,
          ...(body.summary !== undefined ? { summary: body.summary as string } : {}),
          ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
          body: body.body as string,
          ...(body.note !== undefined ? { note: body.note as string } : {}),
          editedBy: 'operator',
          sourceTainted: false,
        },
        { dataDir, now: clock() },
      )
      hub?.broadcast({ type: 'wiki_changed' })
      const revisions = listWikiRevisions(db, page.id)
      return c.json({ page, revisions }, created ? 201 : 200)
    } catch (err) {
      if (err instanceof WikiValidationError) {
        return c.json({ error: err.message, code: 'invalid_wiki' }, 400)
      }
      throw err
    }
  })

  app.post('/api/wiki/:kind/:slug/revert', async (c) => {
    const kind = c.req.param('kind')
    const slug = c.req.param('slug')
    if (!isWikiKind(kind)) {
      return c.json({ error: `Invalid wiki kind: ${kind}`, code: 'invalid_kind' }, 400)
    }
    if (!isWikiSlug(slug)) {
      return c.json({ error: `Invalid wiki slug: ${slug}`, code: 'invalid_slug' }, 400)
    }

    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) {
      return c.json({ error: 'Invalid JSON request body', code: 'invalid_wiki' }, 400)
    }

    if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1) {
      return c.json({ error: 'version must be a positive integer', code: 'invalid_version' }, 400)
    }

    try {
      const page = revertWikiPage(db, kind, slug, body.version, {
        editedBy: 'operator',
        ...(body.note !== undefined ? { note: body.note as string } : {}),
        dataDir,
        now: clock(),
      })
      if (!page) {
        return c.json({ error: 'Wiki page or target version not found', code: 'not_found' }, 404)
      }
      hub?.broadcast({ type: 'wiki_changed' })
      const revisions = listWikiRevisions(db, page.id)
      return c.json({ page, revisions })
    } catch (err) {
      if (err instanceof WikiValidationError) {
        return c.json({ error: err.message, code: 'invalid_wiki' }, 400)
      }
      throw err
    }
  })

  app.delete('/api/wiki/:kind/:slug', (c) => {
    const kind = c.req.param('kind')
    const slug = c.req.param('slug')
    if (!isWikiKind(kind)) {
      return c.json({ error: `Invalid wiki kind: ${kind}`, code: 'invalid_kind' }, 400)
    }
    if (!isWikiSlug(slug)) {
      return c.json({ error: `Invalid wiki slug: ${slug}`, code: 'invalid_slug' }, 400)
    }

    const archived = archiveWikiPage(db, kind, slug, { dataDir, now: clock() })
    if (!archived) {
      return c.json({ error: 'Wiki page not found', code: 'not_found' }, 404)
    }
    hub?.broadcast({ type: 'wiki_changed' })
    return c.json({ ok: true })
  })
}
