import { randomBytes } from 'node:crypto'
import type { Db } from '../db.js'
import { isGoalId } from '../goals/store.js'
import type { PromptSpace } from '../prompts.js'
import {
  MAX_ITEMS_PER_SPACE,
  parseSpaceSchema,
  sanitizeItemData,
  SpaceSchemaError,
} from './schema.js'
import {
  SPACE_ROLES,
  type SpaceGrant,
  type SpaceItemData,
  type SpaceItemRow,
  type SpaceRole,
  type SpaceRow,
  type SpaceSchema,
  type SpaceView,
} from './types.js'

const SPACE_ID_RE = /^space-[0-9a-f]{8}$/
const ITEM_ID_RE = /^item-[0-9a-f]{8}$/
export const MAX_PROMPT_SPACES = 8

export const isSpaceId = (id: string): boolean => SPACE_ID_RE.test(id)
export const isSpaceItemId = (id: string): boolean => ITEM_ID_RE.test(id)

export function normalizeSpaceRole(raw: unknown): SpaceRole | null {
  return typeof raw === 'string' && (SPACE_ROLES as readonly string[]).includes(raw)
    ? (raw as SpaceRole)
    : null
}

function slugBase(raw: string): string {
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 26)
  return clean || 'space'
}

function allocateSlug(db: Db, desired: string, excludeId?: string): string {
  const base = slugBase(desired)
  const exists = (s: string) => Boolean(
    excludeId
      ? db.prepare('SELECT 1 FROM spaces WHERE slug = ? AND id != ?').get(s, excludeId)
      : db.prepare('SELECT 1 FROM spaces WHERE slug = ?').get(s),
  )
  if (!exists(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 28)}_${i}`
    if (!exists(candidate)) return candidate
  }
  return `${base.slice(0, 23)}_${randomBytes(4).toString('hex')}`
}

type RawSpaceRow = {
  id: string
  slug: string
  title: string
  description: string
  icon: string
  kind: string
  goal_id: string | null
  schema_json: string
  created_at: number
  updated_at: number
}

type RawItemRow = {
  id: string
  space_id: string
  block_id: string
  title: string
  status: string
  data_json: string
  sort_order: number
  tainted: number
  updated_by: string
  created_at: number
  updated_at: number
}

type RawGrantRow = {
  space_id: string
  bot_id: string
  role: string
}

function safeParseSchema(raw: string): SpaceSchema {
  try {
    return parseSpaceSchema(JSON.parse(raw))
  } catch {
    return { blocks: [] }
  }
}

function safeParseData(raw: string): SpaceItemData {
  try {
    const parsed = JSON.parse(raw)
    return sanitizeItemData(parsed)
  } catch {
    return {}
  }
}

function mapSpaceRow(r: RawSpaceRow): SpaceRow {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    icon: r.icon || '📊',
    kind: 'declarative',
    goalId: r.goal_id,
    schema: safeParseSchema(r.schema_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapItemRow(r: RawItemRow): SpaceItemRow {
  return {
    id: r.id,
    spaceId: r.space_id,
    blockId: r.block_id,
    title: r.title,
    status: r.status,
    data: safeParseData(r.data_json),
    sortOrder: r.sort_order,
    tainted: r.tainted === 1,
    updatedBy: r.updated_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function createSpace(
  db: Db,
  input: {
    title: string
    slug?: string
    description?: string
    icon?: string
    goalId?: string | null
    schema: SpaceSchema
    grants?: SpaceGrant[]
    now?: number
  },
): SpaceRow {
  const validatedSchema = parseSpaceSchema(input.schema)
  const id = `space-${randomBytes(4).toString('hex')}`
  const at = input.now ?? Date.now()
  const title = input.title.trim().slice(0, 120)
  const slug = allocateSlug(db, input.slug?.trim() || title)
  const description = (input.description ?? '').trim().slice(0, 1000)
  const icon = (input.icon ?? '📊').trim().slice(0, 8) || '📊'
  const goalId = input.goalId && isGoalId(input.goalId) ? input.goalId : null

  db.transaction(() => {
    db.prepare(
      `INSERT INTO spaces (id, slug, title, description, icon, kind, goal_id, schema_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'declarative', ?, ?, ?, ?)`,
    ).run(id, slug, title, description, icon, goalId, JSON.stringify(validatedSchema), at, at)

    if (input.grants?.length) {
      const insertGrant = db.prepare(
        `INSERT OR REPLACE INTO space_bots (space_id, bot_id, role, created_at) VALUES (?, ?, ?, ?)`,
      )
      for (const g of input.grants) {
        const role = normalizeSpaceRole(g.role)
        if (!role || !g.botId.trim()) continue
        insertGrant.run(id, g.botId.trim(), role, at)
      }
    }
  })()

  return getSpace(db, id)!
}

export function getSpace(db: Db, id: string): SpaceRow | null {
  if (!isSpaceId(id)) return null
  const row = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as RawSpaceRow | undefined
  return row ? mapSpaceRow(row) : null
}

export function getSpaceBySlug(db: Db, slug: string): SpaceRow | null {
  const clean = slug.trim().toLowerCase()
  if (!clean) return null
  const row = db.prepare('SELECT * FROM spaces WHERE slug = ?').get(clean) as RawSpaceRow | undefined
  return row ? mapSpaceRow(row) : null
}

export function resolveSpace(db: Db, idOrSlug: string): SpaceRow | null {
  const ref = idOrSlug.trim()
  if (!ref) return null
  return isSpaceId(ref) ? getSpace(db, ref) : getSpaceBySlug(db, ref)
}

export function listSpaces(db: Db): SpaceRow[] {
  const rows = db.prepare('SELECT * FROM spaces ORDER BY updated_at DESC, id ASC').all() as RawSpaceRow[]
  return rows.map(mapSpaceRow)
}

export function updateSpace(
  db: Db,
  id: string,
  patch: {
    title?: string
    description?: string
    icon?: string
    goalId?: string | null
    schema?: SpaceSchema
    grants?: SpaceGrant[]
    now?: number
  },
): SpaceRow | null {
  const existing = getSpace(db, id)
  if (!existing) return null
  const title = patch.title !== undefined ? patch.title.trim().slice(0, 120) : existing.title
  const description = patch.description !== undefined ? patch.description.trim().slice(0, 1000) : existing.description
  const icon = patch.icon !== undefined ? (patch.icon.trim().slice(0, 8) || '📊') : existing.icon
  const goalId = patch.goalId !== undefined ? (patch.goalId && isGoalId(patch.goalId) ? patch.goalId : null) : existing.goalId
  const schema = patch.schema !== undefined ? parseSpaceSchema(patch.schema) : existing.schema
  const at = patch.now ?? Date.now()

  db.transaction(() => {
    db.prepare(
      `UPDATE spaces
       SET title = ?, description = ?, icon = ?, goal_id = ?, schema_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(title, description, icon, goalId, JSON.stringify(schema), at, id)

    if (patch.grants !== undefined) {
      db.prepare('DELETE FROM space_bots WHERE space_id = ?').run(id)
      const insertGrant = db.prepare(
        `INSERT OR REPLACE INTO space_bots (space_id, bot_id, role, created_at) VALUES (?, ?, ?, ?)`,
      )
      for (const g of patch.grants) {
        const role = normalizeSpaceRole(g.role)
        if (!role || !g.botId.trim()) continue
        insertGrant.run(id, g.botId.trim(), role, at)
      }
    }
  })()

  return getSpace(db, id)
}

export function deleteSpace(db: Db, id: string): boolean {
  if (!isSpaceId(id)) return false
  return db.transaction(() => {
    const info = db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
    if (info.changes === 0) return false
    db.prepare('DELETE FROM space_items WHERE space_id = ?').run(id)
    db.prepare('DELETE FROM space_bots WHERE space_id = ?').run(id)
    return true
  })()
}

export function listSpaceGrants(db: Db, spaceId: string): SpaceGrant[] {
  const rows = db
    .prepare('SELECT space_id, bot_id, role FROM space_bots WHERE space_id = ? ORDER BY bot_id ASC')
    .all(spaceId) as RawGrantRow[]
  return rows.map((r) => ({ botId: r.bot_id, role: normalizeSpaceRole(r.role) ?? 'viewer' }))
}

export function listBotSpaceGrants(db: Db, botId: string): Map<string, SpaceRole> {
  const rows = db
    .prepare('SELECT space_id, bot_id, role FROM space_bots WHERE bot_id = ?')
    .all(botId) as RawGrantRow[]
  const out = new Map<string, SpaceRole>()
  for (const r of rows) {
    const role = normalizeSpaceRole(r.role)
    if (role) out.set(r.space_id, role)
  }
  return out
}

export function getBotSpaceRole(db: Db, botId: string, spaceId: string): SpaceRole | null {
  const row = db
    .prepare('SELECT role FROM space_bots WHERE space_id = ? AND bot_id = ?')
    .get(spaceId, botId) as { role: string } | undefined
  return row ? normalizeSpaceRole(row.role) : null
}

export function setSpaceGrants(db: Db, spaceId: string, grants: SpaceGrant[], now = Date.now()): SpaceGrant[] {
  db.transaction(() => {
    db.prepare('DELETE FROM space_bots WHERE space_id = ?').run(spaceId)
    const stmt = db.prepare('INSERT OR REPLACE INTO space_bots (space_id, bot_id, role, created_at) VALUES (?, ?, ?, ?)')
    for (const g of grants) {
      const role = normalizeSpaceRole(g.role)
      if (!role || !g.botId.trim()) continue
      stmt.run(spaceId, g.botId.trim(), role, now)
    }
  })()
  return listSpaceGrants(db, spaceId)
}

export function setBotSpaceGrant(db: Db, botId: string, spaceId: string, role: SpaceRole | null, now = Date.now()): void {
  if (role === null) {
    db.prepare('DELETE FROM space_bots WHERE space_id = ? AND bot_id = ?').run(spaceId, botId)
    return
  }
  db.prepare('INSERT OR REPLACE INTO space_bots (space_id, bot_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(spaceId, botId, role, now)
}

export function listSpaceItems(db: Db, spaceId: string, opts: { blockId?: string; limit?: number } = {}): SpaceItemRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_ITEMS_PER_SPACE, MAX_ITEMS_PER_SPACE))
  const rows = opts.blockId
    ? (db
      .prepare('SELECT * FROM space_items WHERE space_id = ? AND block_id = ? ORDER BY sort_order ASC, updated_at DESC, id ASC LIMIT ?')
      .all(spaceId, opts.blockId, limit) as RawItemRow[])
    : (db
      .prepare('SELECT * FROM space_items WHERE space_id = ? ORDER BY sort_order ASC, updated_at DESC, id ASC LIMIT ?')
      .all(spaceId, limit) as RawItemRow[])
  return rows.map(mapItemRow)
}

export function getSpaceItem(db: Db, itemId: string): SpaceItemRow | null {
  if (!isSpaceItemId(itemId)) return null
  const row = db.prepare('SELECT * FROM space_items WHERE id = ?').get(itemId) as RawItemRow | undefined
  return row ? mapItemRow(row) : null
}

export function upsertSpaceItem(
  db: Db,
  input: {
    spaceId: string
    itemId?: string
    blockId: string
    title: string
    status?: string
    data?: unknown
    sortOrder?: number
    tainted?: boolean
    updatedBy: string
    now?: number
  },
): { item: SpaceItemRow; created: boolean } {
  const space = getSpace(db, input.spaceId)
  if (!space) throw new SpaceSchemaError('Unknown space')
  const block = space.schema.blocks.find((b) => b.id === input.blockId)
  if (!block) throw new SpaceSchemaError(`Unknown block "${input.blockId}" in space "${space.title}"`)

  const title = input.title.trim().slice(0, 160)
  if (!title) throw new SpaceSchemaError('Item title must be 1 to 160 characters')
  const status = (input.status ?? '').trim().slice(0, 48)
  const cleanData = sanitizeItemData(input.data, block)
  const at = input.now ?? Date.now()

  if (input.itemId) {
    const existing = getSpaceItem(db, input.itemId)
    if (!existing || existing.spaceId !== space.id) {
      throw new SpaceSchemaError(`Item "${input.itemId}" not found in space "${space.id}"`)
    }
    const nextSort = input.sortOrder !== undefined && Number.isFinite(input.sortOrder)
      ? Math.floor(input.sortOrder)
      : existing.sortOrder
    // 非操作者写入不可洗白已有 tainted；操作者人工编辑会覆盖为干净状态
    const nextTainted = input.updatedBy === 'operator'
      ? (input.tainted ? 1 : 0)
      : (input.tainted || existing.tainted ? 1 : 0)
    db.prepare(
      `UPDATE space_items
       SET block_id = ?, title = ?, status = ?, data_json = ?, sort_order = ?, tainted = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`,
    ).run(block.id, title, status, JSON.stringify(cleanData), nextSort, nextTainted, input.updatedBy, at, existing.id)
    db.prepare('UPDATE spaces SET updated_at = ? WHERE id = ?').run(at, space.id)
    return { item: getSpaceItem(db, existing.id)!, created: false }
  }

  const countRow = db
    .prepare('SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?')
    .get(space.id) as { n: number }
  if (countRow.n >= MAX_ITEMS_PER_SPACE) {
    throw new SpaceSchemaError(`Space "${space.title}" reached the limit of ${MAX_ITEMS_PER_SPACE} items`)
  }
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM space_items WHERE space_id = ? AND block_id = ?')
    .get(space.id, block.id) as { m: number }
  const sortOrder = input.sortOrder !== undefined && Number.isFinite(input.sortOrder)
    ? Math.floor(input.sortOrder)
    : maxOrder.m + 1
  const id = `item-${randomBytes(4).toString('hex')}`
  db.prepare(
    `INSERT INTO space_items (id, space_id, block_id, title, status, data_json, sort_order, tainted, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, space.id, block.id, title, status, JSON.stringify(cleanData), sortOrder, input.tainted ? 1 : 0, input.updatedBy, at, at)
  db.prepare('UPDATE spaces SET updated_at = ? WHERE id = ?').run(at, space.id)
  return { item: getSpaceItem(db, id)!, created: true }
}

export function deleteSpaceItem(db: Db, spaceId: string, itemId: string, now = Date.now()): SpaceItemRow | null {
  if (!isSpaceId(spaceId) || !isSpaceItemId(itemId)) return null
  const existing = getSpaceItem(db, itemId)
  if (!existing || existing.spaceId !== spaceId) return null
  db.prepare('DELETE FROM space_items WHERE id = ? AND space_id = ?').run(itemId, spaceId)
  db.prepare('UPDATE spaces SET updated_at = ? WHERE id = ?').run(now, spaceId)
  return existing
}

export function getSpaceView(db: Db, spaceId: string): SpaceView | null {
  const space = getSpace(db, spaceId)
  if (!space) return null
  const items = listSpaceItems(db, space.id)
  const grants = listSpaceGrants(db, space.id)
  const goalTitle = space.goalId
    ? ((db.prepare('SELECT title FROM goals WHERE id = ?').get(space.goalId) as { title: string } | undefined)?.title ?? null)
    : null
  return { ...space, items, grants, goalTitle }
}

export function listSpaceViews(db: Db): SpaceView[] {
  return listSpaces(db)
    .map((s) => getSpaceView(db, s.id))
    .filter((v): v is SpaceView => v !== null)
}

/**
 * 为某位同事构造受预算约束的已授权空间目录（最多 8 个，不含具体条目明细，由同事按需调 space_read 读取）。
 */
export function listPromptSpacesForBot(db: Db, botId: string): PromptSpace[] {
  const grants = listBotSpaceGrants(db, botId)
  if (grants.size === 0) return []
  const allSpaces = listSpaces(db).filter((s) => grants.has(s.id)).slice(0, MAX_PROMPT_SPACES)
  return allSpaces.map((s) => {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?').get(s.id) as { n: number }).n
    return {
      id: s.id,
      slug: s.slug,
      title: s.title,
      role: grants.get(s.id)!,
      blocks: s.schema.blocks.map((b) => `${b.id}:${b.type}`),
      itemCount: count,
    }
  })
}
