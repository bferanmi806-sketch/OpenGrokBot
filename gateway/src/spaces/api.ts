import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { readBodyUpTo } from '../body.js'
import type { BotRow, Db } from '../db.js'
import { getGoal, isGoalId } from '../goals/store.js'
import type { Hub } from '../hub.js'
import { parseSpaceSchema, parseSpaceTheme, SpaceSchemaError } from './schema.js'
import {
  createSpace,
  deleteSpace,
  deleteSpaceItem,
  getSpace,
  getSpaceItem,
  getSpaceView,
  isSpaceId,
  isSpaceItemId,
  listSpaceViews,
  normalizeSpaceRole,
  setBotSpaceGrant,
  setSpaceGrants,
  updateSpace,
  upsertSpaceItem,
} from './store.js'
import { buildTemplateSchema, defaultIconForTemplate, SPACE_TEMPLATES } from './templates.js'
import {
  SPACE_TEMPLATE_IDS,
  type SpaceActionDef,
  type SpaceGrant,
  type SpaceRole,
  type SpacesSnapshot,
  type SpaceTemplateId,
  type SpaceView,
} from './types.js'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const ASSET_FILE_RE = /^[0-9a-f]{16}\.(?:png|jpg|webp|gif)$/
const MAX_SPACE_ASSET_BYTES = 6 * 1024 * 1024
const MAX_SPACE_ASSET_REQUEST_BYTES = 9 * 1024 * 1024

function detectImageType(buf: Buffer): { ext: 'png' | 'jpg' | 'webp' | 'gif'; mime: string } | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' }
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' }
  }
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { ext: 'gif', mime: 'image/gif' }
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' }
  }
  return null
}

function assetMimeByExt(file: string): string {
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.jpg')) return 'image/jpeg'
  if (file.endsWith('.webp')) return 'image/webp'
  return 'image/gif'
}

export type SpacesApiDeps = {
  db: Db
  hub: Hub
  chiefId: string
  dataDir?: string
  now?: () => number
  startSpaceAction: (bot: BotRow, space: SpaceView, action: SpaceActionDef) => { threadId: string }
}

export function mountSpaces(app: Hono, deps: SpacesApiDeps): { snapshot: () => SpacesSnapshot } {
  const { db, hub, chiefId, dataDir } = deps
  const now = deps.now ?? (() => Date.now())

  const botById = (id: string): BotRow | undefined =>
    db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined

  const defaultBotId = (): string =>
    botById(chiefId)?.id
    ?? (db.prepare('SELECT id FROM bots ORDER BY created_at ASC, id ASC LIMIT 1').get() as { id: string } | undefined)?.id
    ?? ''

  const validateGrants = (raw: unknown): { ok: true; grants: SpaceGrant[] } | { ok: false; error: string } => {
    if (!Array.isArray(raw)) return { ok: false, error: 'grants must be an array' }
    const seen = new Set<string>()
    const grants: SpaceGrant[] = []
    for (const item of raw) {
      if (!isObject(item) || typeof item.botId !== 'string') {
        return { ok: false, error: 'each grant must have botId and role' }
      }
      const botId = item.botId.trim()
      const role = normalizeSpaceRole(item.role)
      if (!role) return { ok: false, error: 'grant role must be "viewer" or "editor"' }
      if (!botById(botId)) return { ok: false, error: `unknown teammate: ${botId}` }
      if (seen.has(botId)) continue
      seen.add(botId)
      grants.push({ botId, role })
    }
    return { ok: true, grants }
  }

  const validateActionBots = (schema: ReturnType<typeof parseSpaceSchema>): string | null => {
    for (const b of schema.blocks) {
      if (b.type !== 'action_bar') continue
      for (const a of b.actions) {
        if (!botById(a.botId)) return `action "${a.id}" references unknown teammate "${a.botId}"`
      }
    }
    return null
  }

  const snapshot = (): SpacesSnapshot => ({
    spaces: listSpaceViews(db),
    templates: [...SPACE_TEMPLATES],
  })

  app.get('/api/spaces', (c) => c.json(snapshot()))

  app.get('/api/spaces/:id', (c) => {
    const id = c.req.param('id')
    if (!isSpaceId(id)) return c.json({ error: 'invalid space id' }, 400)
    const space = getSpaceView(db, id)
    if (!space) return c.json({ error: 'unknown space' }, 404)
    return c.json({ space })
  })

  app.post('/api/spaces', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    // Phase D.1 严守零任意 JS 红线：显式拒绝非 declarative 类型
    if (body.kind !== undefined && body.kind !== 'declarative') {
      return c.json({ error: 'Only declarative spaces are supported in this release' }, 400)
    }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title || title.length > 120) return c.json({ error: 'title must be 1 to 120 characters' }, 400)
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 1000) : ''

    let goalId: string | null = null
    if (body.goalId !== undefined && body.goalId !== null && body.goalId !== '') {
      if (typeof body.goalId !== 'string' || !isGoalId(body.goalId) || !getGoal(db, body.goalId)) {
        return c.json({ error: 'unknown goalId' }, 400)
      }
      goalId = body.goalId
    }

    let grants: SpaceGrant[] = []
    if (body.grants !== undefined) {
      const parsed = validateGrants(body.grants)
      if (!parsed.ok) return c.json({ error: parsed.error }, 400)
      grants = parsed.grants
    }

    const templateRaw = typeof body.template === 'string' ? body.template.trim() : ''
    const template: SpaceTemplateId = (SPACE_TEMPLATE_IDS as readonly string[]).includes(templateRaw)
      ? (templateRaw as SpaceTemplateId)
      : 'blank'
    const icon = typeof body.icon === 'string' && body.icon.trim()
      ? body.icon.trim().slice(0, 8)
      : defaultIconForTemplate(template)

    let schema
    try {
      const themeOverride = body.theme !== undefined ? parseSpaceTheme(body.theme) : undefined
      schema = body.schema !== undefined
        ? parseSpaceSchema(body.schema)
        : parseSpaceSchema(buildTemplateSchema(template, grants[0]?.botId ?? defaultBotId(), themeOverride))
    } catch (err) {
      return c.json({ error: err instanceof SpaceSchemaError ? err.message : 'invalid space schema' }, 400)
    }
    const badAction = validateActionBots(schema)
    if (badAction) return c.json({ error: badAction }, 400)

    const space = createSpace(db, {
      title,
      ...(typeof body.slug === 'string' ? { slug: body.slug } : {}),
      description,
      icon,
      goalId,
      schema,
      grants,
      now: now(),
    })
    hub.broadcast({ type: 'spaces_changed' })
    if (goalId) hub.broadcast({ type: 'goals_changed' })
    return c.json({ space: getSpaceView(db, space.id)!, snapshot: snapshot() }, 201)
  })

  app.patch('/api/spaces/:id', async (c) => {
    const id = c.req.param('id')
    if (!isSpaceId(id)) return c.json({ error: 'invalid space id' }, 400)
    const existing = getSpace(db, id)
    if (!existing) return c.json({ error: 'unknown space' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    if (body.kind !== undefined && body.kind !== 'declarative') {
      return c.json({ error: 'Only declarative spaces are supported in this release' }, 400)
    }

    const patch: Parameters<typeof updateSpace>[2] = { now: now() }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) {
        return c.json({ error: 'title must be 1 to 120 characters' }, 400)
      }
      patch.title = body.title.trim()
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string') return c.json({ error: 'description must be a string' }, 400)
      patch.description = body.description
    }
    if (body.icon !== undefined) {
      if (typeof body.icon !== 'string' || !body.icon.trim()) return c.json({ error: 'icon must be non-empty' }, 400)
      patch.icon = body.icon.trim()
    }
    if (body.goalId !== undefined) {
      if (body.goalId === null || body.goalId === '') {
        patch.goalId = null
      } else if (typeof body.goalId === 'string' && isGoalId(body.goalId) && getGoal(db, body.goalId)) {
        patch.goalId = body.goalId
      } else {
        return c.json({ error: 'unknown goalId' }, 400)
      }
    }
    if (body.schema !== undefined) {
      try {
        const schema = parseSpaceSchema(body.schema)
        const badAction = validateActionBots(schema)
        if (badAction) return c.json({ error: badAction }, 400)
        patch.schema = schema
      } catch (err) {
        return c.json({ error: err instanceof SpaceSchemaError ? err.message : 'invalid space schema' }, 400)
      }
    }
    if (body.grants !== undefined) {
      const parsed = validateGrants(body.grants)
      if (!parsed.ok) return c.json({ error: parsed.error }, 400)
      patch.grants = parsed.grants
    }

    const updated = updateSpace(db, id, patch)!
    hub.broadcast({ type: 'spaces_changed' })
    if (existing.goalId !== updated.goalId) hub.broadcast({ type: 'goals_changed' })
    return c.json({ space: getSpaceView(db, updated.id)!, snapshot: snapshot() })
  })

  app.delete('/api/spaces/:id', async (c) => {
    const id = c.req.param('id')
    if (!isSpaceId(id)) return c.json({ error: 'invalid space id' }, 400)
    const hadGoal = getSpace(db, id)?.goalId
    if (!deleteSpace(db, id)) return c.json({ error: 'unknown space' }, 404)
    if (dataDir) {
      await rm(join(dataDir, 'spaces', id), { recursive: true, force: true }).catch(() => {})
    }
    hub.broadcast({ type: 'spaces_changed' })
    if (hadGoal) hub.broadcast({ type: 'goals_changed' })
    return c.json({ ok: true, snapshot: snapshot() })
  })

  app.post('/api/spaces/:id/assets', async (c) => {
    const id = c.req.param('id')
    if (!isSpaceId(id)) return c.json({ error: 'invalid space id' }, 400)
    if (!getSpace(db, id)) return c.json({ error: 'unknown space' }, 404)
    if (!dataDir) return c.json({ error: 'space assets need a data folder' }, 503)
    const raw = await readBodyUpTo(c.req.raw.body, MAX_SPACE_ASSET_REQUEST_BYTES).catch(() => null)
    if (raw === null) return c.json({ error: 'image exceeds 6 MB limit' }, 413)
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return c.json({ error: 'JSON object body required' }, 400)
    }
    if (!isObject(body) || typeof body.data !== 'string') {
      return c.json({ error: 'send { name, data } as JSON with base64 image data' }, 400)
    }
    const cleanB64 = body.data.trim().replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
    const bytes = Buffer.from(cleanB64, 'base64')
    if (!bytes.length || bytes.length > MAX_SPACE_ASSET_BYTES) {
      return c.json({ error: 'image must be 1 byte to 6 MB' }, 400)
    }
    const detected = detectImageType(bytes)
    if (!detected) {
      return c.json({ error: 'only PNG, JPEG, WebP, and GIF images are supported' }, 400)
    }
    const file = `${randomBytes(8).toString('hex')}.${detected.ext}`
    const dir = join(dataDir, 'spaces', id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), bytes)
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : file
    return c.json({
      url: `/api/spaces/${id}/assets/${file}`,
      name,
      mime: detected.mime,
      size: bytes.length,
    }, 201)
  })

  app.get('/api/spaces/:id/assets/:file', async (c) => {
    const id = c.req.param('id')
    const file = c.req.param('file')
    if (!isSpaceId(id) || !ASSET_FILE_RE.test(file)) return c.json({ error: 'invalid asset' }, 400)
    if (!dataDir) return c.json({ error: 'not found' }, 404)
    try {
      const bytes = await readFile(join(dataDir, 'spaces', id, file))
      return c.body(new Uint8Array(bytes), 200, {
        'Content-Type': assetMimeByExt(file),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, max-age=31536000, immutable',
      })
    } catch {
      return c.json({ error: 'not found' }, 404)
    }
  })

  app.put('/api/spaces/:id/grants', async (c) => {
    const id = c.req.param('id')
    if (!isSpaceId(id)) return c.json({ error: 'invalid space id' }, 400)
    if (!getSpace(db, id)) return c.json({ error: 'unknown space' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    const parsed = validateGrants(body.grants)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    setSpaceGrants(db, id, parsed.grants, now())
    hub.broadcast({ type: 'spaces_changed' })
    return c.json({ space: getSpaceView(db, id)!, snapshot: snapshot() })
  })

  app.put('/api/bots/:botId/spaces/:spaceId', async (c) => {
    const botId = c.req.param('botId')
    const spaceId = c.req.param('spaceId')
    if (!botById(botId)) return c.json({ error: 'unknown bot' }, 404)
    if (!isSpaceId(spaceId) || !getSpace(db, spaceId)) return c.json({ error: 'unknown space' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    let role: SpaceRole | null
    if (body.role === null || body.role === '' || body.role === 'none') {
      role = null
    } else {
      const parsed = normalizeSpaceRole(body.role)
      if (!parsed) return c.json({ error: 'role must be "viewer", "editor", or null' }, 400)
      role = parsed
    }
    setBotSpaceGrant(db, botId, spaceId, role, now())
    hub.broadcast({ type: 'spaces_changed' })
    return c.json({ ok: true, botId, spaceId, role, snapshot: snapshot() })
  })

  app.post('/api/spaces/:id/items', async (c) => {
    const id = c.req.param('id')
    if (!isSpaceId(id)) return c.json({ error: 'invalid space id' }, 400)
    if (!getSpace(db, id)) return c.json({ error: 'unknown space' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    const blockId = typeof body.blockId === 'string' ? body.blockId.trim() : ''
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const status = typeof body.status === 'string' ? body.status.trim() : ''
    const sortOrder = typeof body.sortOrder === 'number' ? body.sortOrder : undefined
    try {
      const { item } = upsertSpaceItem(db, {
        spaceId: id,
        blockId,
        title,
        status,
        data: body.data,
        ...(sortOrder !== undefined ? { sortOrder } : {}),
        tainted: false,
        updatedBy: 'operator',
        now: now(),
      })
      hub.broadcast({ type: 'spaces_changed' })
      return c.json({ item, space: getSpaceView(db, id)!, snapshot: snapshot() }, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'invalid item' }, 400)
    }
  })

  app.patch('/api/spaces/:id/items/:itemId', async (c) => {
    const id = c.req.param('id')
    const itemId = c.req.param('itemId')
    if (!isSpaceId(id) || !isSpaceItemId(itemId)) return c.json({ error: 'invalid id' }, 400)
    const existing = getSpaceItem(db, itemId)
    if (!existing || existing.spaceId !== id) return c.json({ error: 'unknown item' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    try {
      const { item } = upsertSpaceItem(db, {
        spaceId: id,
        itemId,
        blockId: typeof body.blockId === 'string' && body.blockId.trim() ? body.blockId.trim() : existing.blockId,
        title: typeof body.title === 'string' ? body.title : existing.title,
        status: typeof body.status === 'string' ? body.status : existing.status,
        data: body.data !== undefined ? body.data : existing.data,
        sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : existing.sortOrder,
        tainted: false,
        updatedBy: 'operator',
        now: now(),
      })
      hub.broadcast({ type: 'spaces_changed' })
      return c.json({ item, space: getSpaceView(db, id)!, snapshot: snapshot() })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'invalid item update' }, 400)
    }
  })

  app.delete('/api/spaces/:id/items/:itemId', (c) => {
    const id = c.req.param('id')
    const itemId = c.req.param('itemId')
    if (!isSpaceId(id) || !isSpaceItemId(itemId)) return c.json({ error: 'invalid id' }, 400)
    if (!deleteSpaceItem(db, id, itemId, now())) return c.json({ error: 'unknown item' }, 404)
    hub.broadcast({ type: 'spaces_changed' })
    return c.json({ ok: true, space: getSpaceView(db, id)!, snapshot: snapshot() })
  })

  // 严格只从服务端落库的 space.schema 读取按钮定义，绝不信任客户端传来的任意 prompt
  app.post('/api/spaces/:id/actions/:actionId', (c) => {
    const id = c.req.param('id')
    const actionId = c.req.param('actionId')
    if (!isSpaceId(id)) return c.json({ error: 'invalid space id' }, 400)
    const space = getSpaceView(db, id)
    if (!space) return c.json({ error: 'unknown space' }, 404)
    let matched: SpaceActionDef | undefined
    for (const block of space.schema.blocks) {
      if (block.type !== 'action_bar') continue
      matched = block.actions.find((a) => a.id === actionId)
      if (matched) break
    }
    if (!matched) return c.json({ error: 'unknown space action' }, 404)
    const bot = botById(matched.botId)
    if (!bot) return c.json({ error: 'target teammate unavailable' }, 404)

    const { threadId } = deps.startSpaceAction(bot, space, matched)
    return c.json({ ok: true, botId: bot.id, threadId }, 202)
  })

  return { snapshot }
}
