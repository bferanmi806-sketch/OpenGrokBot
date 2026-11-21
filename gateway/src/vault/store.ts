import { randomBytes } from 'node:crypto'
import type { Db } from '../db.js'
import {
  VAULT_APPROVAL_MODES,
  VAULT_FIELD_KINDS,
  VAULT_ITEM_KINDS,
  type VaultApprovalMode,
  type VaultFieldKind,
  type VaultFieldMeta,
  type VaultItemKind,
  type VaultItemRow,
} from './types.js'

const ID_RE = /^vault-[0-9a-f]{8}$/
const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/

export const isVaultItemId = (id: string): boolean => ID_RE.test(id)
export const isVaultFieldKey = (key: string): boolean => FIELD_KEY_RE.test(key)

export function normalizeVaultSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28)
    .replace(/_+$/, '')
  return cleaned || 'item'
}

function uniqueVaultSlug(db: Db, raw: string, excludeId?: string): string {
  const base = normalizeVaultSlug(raw)
  const exists = excludeId
    ? db.prepare('SELECT 1 FROM vault_items WHERE slug = ? AND id != ?')
    : db.prepare('SELECT 1 FROM vault_items WHERE slug = ?')
  const taken = (candidate: string) => Boolean(excludeId ? exists.get(candidate, excludeId) : exists.get(candidate))
  if (!taken(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `_${n}`
    const headLen = Math.min(25, Math.max(1, 28 - suffix.length))
    const prefix = (base.slice(0, headLen).replace(/_+$/, '') || 'item').slice(0, headLen)
    const candidate = `${prefix}${suffix}`
    if (!taken(candidate)) return candidate
  }
}

type RawVaultItemRow = {
  id: string
  slug: string
  name: string
  kind: string
  allowed_domains_json: string
  fields_json: string
  approval_mode: string
  notes: string
  created_at: number
  updated_at: number
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function parseFields(json: string): VaultFieldMeta[] {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    const out: VaultFieldMeta[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const rec = item as Partial<VaultFieldMeta>
      if (typeof rec.key !== 'string' || !isVaultFieldKey(rec.key) || seen.has(rec.key)) continue
      const kind: VaultFieldKind = (VAULT_FIELD_KINDS as readonly string[]).includes(String(rec.kind))
        ? (rec.kind as VaultFieldKind)
        : 'text'
      seen.add(rec.key)
      out.push({
        key: rec.key,
        kind,
        ...(typeof rec.label === 'string' && rec.label.trim() ? { label: rec.label.trim().slice(0, 64) } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

function sanitizeFields(fields: readonly VaultFieldMeta[]): VaultFieldMeta[] {
  const seen = new Set<string>()
  const out: VaultFieldMeta[] = []
  for (const f of fields) {
    const key = f.key.trim()
    if (!isVaultFieldKey(key) || seen.has(key)) continue
    seen.add(key)
    const kind: VaultFieldKind = (VAULT_FIELD_KINDS as readonly string[]).includes(f.kind) ? f.kind : 'text'
    const label = typeof f.label === 'string' ? f.label.trim().slice(0, 64) : ''
    out.push({ key, kind, ...(label ? { label } : {}) })
  }
  return out
}

function normalizeKind(raw: string): VaultItemKind {
  return (VAULT_ITEM_KINDS as readonly string[]).includes(raw) ? (raw as VaultItemKind) : 'login'
}

function normalizeApprovalMode(raw: string): VaultApprovalMode {
  return (VAULT_APPROVAL_MODES as readonly string[]).includes(raw) ? (raw as VaultApprovalMode) : 'on_taint'
}

function mapRow(r: RawVaultItemRow): VaultItemRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    kind: normalizeKind(r.kind),
    allowedDomains: parseStringArray(r.allowed_domains_json),
    fields: parseFields(r.fields_json),
    approvalMode: normalizeApprovalMode(r.approval_mode),
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export type CreateVaultItemInput = {
  name: string
  slug?: string
  kind: VaultItemKind
  allowedDomains?: string[]
  fields: VaultFieldMeta[]
  approvalMode?: VaultApprovalMode
  notes?: string
  now?: number
}

export type UpdateVaultItemPatch = {
  name?: string
  kind?: VaultItemKind
  allowedDomains?: string[]
  fields?: VaultFieldMeta[]
  approvalMode?: VaultApprovalMode
  notes?: string
  now?: number
}

export function createVaultItem(db: Db, input: CreateVaultItemInput): VaultItemRow {
  const id = `vault-${randomBytes(4).toString('hex')}`
  const name = input.name.trim()
  const slug = uniqueVaultSlug(db, input.slug?.trim() || name)
  const kind = normalizeKind(input.kind)
  const allowedDomains = [...new Set((input.allowedDomains ?? []).map((d) => d.trim()).filter(Boolean))]
  const fields = sanitizeFields(input.fields)
  const approvalMode = normalizeApprovalMode(input.approvalMode ?? 'on_taint')
  const notes = (input.notes ?? '').trim().slice(0, 500)
  const at = input.now ?? Date.now()

  db.prepare(
    `INSERT INTO vault_items (
      id, slug, name, kind, allowed_domains_json, fields_json, approval_mode, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    slug,
    name,
    kind,
    JSON.stringify(allowedDomains),
    JSON.stringify(fields),
    approvalMode,
    notes,
    at,
    at,
  )
  return getVaultItem(db, id)!
}

export function getVaultItem(db: Db, id: string): VaultItemRow | null {
  if (!isVaultItemId(id)) return null
  const row = db.prepare('SELECT * FROM vault_items WHERE id = ?').get(id) as RawVaultItemRow | undefined
  return row ? mapRow(row) : null
}

export function getVaultItemBySlug(db: Db, slug: string): VaultItemRow | null {
  const clean = slug.trim().toLowerCase()
  if (!clean) return null
  const row = db.prepare('SELECT * FROM vault_items WHERE slug = ?').get(clean) as RawVaultItemRow | undefined
  return row ? mapRow(row) : null
}

export function listVaultItems(db: Db): VaultItemRow[] {
  const rows = db
    .prepare('SELECT * FROM vault_items ORDER BY created_at ASC, id ASC')
    .all() as RawVaultItemRow[]
  return rows.map(mapRow)
}

export function updateVaultItem(db: Db, id: string, patch: UpdateVaultItemPatch): VaultItemRow | null {
  const existing = getVaultItem(db, id)
  if (!existing) return null

  const name = patch.name !== undefined ? patch.name.trim() : existing.name
  const kind = patch.kind !== undefined ? normalizeKind(patch.kind) : existing.kind
  const allowedDomains = patch.allowedDomains !== undefined
    ? [...new Set(patch.allowedDomains.map((d) => d.trim()).filter(Boolean))]
    : existing.allowedDomains
  const fields = patch.fields !== undefined ? sanitizeFields(patch.fields) : existing.fields
  const approvalMode = patch.approvalMode !== undefined
    ? normalizeApprovalMode(patch.approvalMode)
    : existing.approvalMode
  const notes = patch.notes !== undefined ? patch.notes.trim().slice(0, 500) : existing.notes
  const at = patch.now ?? Date.now()

  db.prepare(
    `UPDATE vault_items
     SET name = ?, kind = ?, allowed_domains_json = ?, fields_json = ?, approval_mode = ?, notes = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    name,
    kind,
    JSON.stringify(allowedDomains),
    JSON.stringify(fields),
    approvalMode,
    notes,
    at,
    id,
  )
  return getVaultItem(db, id)
}

export function deleteVaultItem(db: Db, id: string): boolean {
  if (!isVaultItemId(id)) return false
  return db.transaction(() => {
    db.prepare('DELETE FROM bot_vault_items WHERE item_id = ?').run(id)
    return db.prepare('DELETE FROM vault_items WHERE id = ?').run(id).changes > 0
  })()
}

export function listBotVaultItemIds(db: Db, botId: string): string[] {
  const rows = db
    .prepare(
      `SELECT b.item_id
       FROM bot_vault_items b
       INNER JOIN vault_items v ON v.id = b.item_id
       WHERE b.bot_id = ?
       ORDER BY v.created_at ASC, v.id ASC`,
    )
    .all(botId) as { item_id: string }[]
  return rows.map((r) => r.item_id)
}

export function listBotVaultItems(db: Db, botId: string): VaultItemRow[] {
  const rows = db
    .prepare(
      `SELECT v.*
       FROM vault_items v
       INNER JOIN bot_vault_items b ON b.item_id = v.id
       WHERE b.bot_id = ?
       ORDER BY v.created_at ASC, v.id ASC`,
    )
    .all(botId) as RawVaultItemRow[]
  return rows.map(mapRow)
}

export function isVaultItemGrantedToBot(db: Db, botId: string, itemId: string): boolean {
  if (!isVaultItemId(itemId)) return false
  return Boolean(
    db.prepare('SELECT 1 FROM bot_vault_items WHERE bot_id = ? AND item_id = ?').get(botId, itemId),
  )
}

export function setBotVaultItems(db: Db, botId: string, itemIds: readonly string[], now = Date.now()): string[] {
  const valid = new Set(listVaultItems(db).map((i) => i.id))
  const unique = [...new Set(itemIds.filter((id) => valid.has(id)))]
  db.transaction(() => {
    db.prepare('DELETE FROM bot_vault_items WHERE bot_id = ?').run(botId)
    const insert = db.prepare('INSERT INTO bot_vault_items (bot_id, item_id, created_at) VALUES (?, ?, ?)')
    for (const itemId of unique) insert.run(botId, itemId, now)
  })()
  return listBotVaultItemIds(db, botId)
}

export function setVaultItemBots(db: Db, itemId: string, botIds: readonly string[], now = Date.now()): string[] {
  if (!getVaultItem(db, itemId)) return []
  const existingBots = new Set((db.prepare('SELECT id FROM bots').all() as { id: string }[]).map((r) => r.id))
  const unique = [...new Set(botIds.filter((id) => existingBots.has(id)))]
  db.transaction(() => {
    db.prepare('DELETE FROM bot_vault_items WHERE item_id = ?').run(itemId)
    const insert = db.prepare('INSERT INTO bot_vault_items (bot_id, item_id, created_at) VALUES (?, ?, ?)')
    for (const botId of unique) insert.run(botId, itemId, now)
  })()
  return unique
}

export function listAllBotVaultGrants(db: Db): Record<string, string[]> {
  const rows = db
    .prepare(
      `SELECT b.bot_id, b.item_id
       FROM bot_vault_items b
       INNER JOIN vault_items v ON v.id = b.item_id
       ORDER BY b.bot_id ASC, v.created_at ASC, v.id ASC`,
    )
    .all() as { bot_id: string; item_id: string }[]
  const out: Record<string, string[]> = {}
  for (const r of rows) {
    ;(out[r.bot_id] ??= []).push(r.item_id)
  }
  return out
}
