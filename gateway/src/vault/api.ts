import type { Hono } from 'hono'
import type { Db } from '../db.js'
import type { Hub } from '../hub.js'
import { MAX_ALLOWED_DOMAINS, normalizeDomainList } from './domains.js'
import {
  createVaultItem,
  deleteVaultItem,
  getVaultItem,
  isVaultFieldKey,
  isVaultItemId,
  listAllBotVaultGrants,
  listVaultItems,
  setBotVaultItems,
  setVaultItemBots,
  updateVaultItem,
} from './store.js'
import { parseTotpInput } from './totp.js'
import {
  VAULT_APPROVAL_MODES,
  VAULT_FIELD_KINDS,
  VAULT_ITEM_KINDS,
  type VaultApprovalMode,
  type VaultFieldKind,
  type VaultFieldMeta,
  type VaultItemKind,
  type VaultItemRow,
  type VaultItemView,
  type VaultSecretStore,
} from './types.js'

const MAX_NAME_CHARS = 120
const MAX_NOTES_CHARS = 500
const MAX_FIELDS_PER_ITEM = 20
const MAX_FIELD_VALUE_CHARS = 4_000

export type VaultSnapshot = {
  items: VaultItemView[]
  botGrants: Record<string, string[]>
}

export type VaultApiDeps = {
  db: Db
  secrets: VaultSecretStore
  hub: Hub
  now?: () => number
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function validateName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Vault item name must be a string')
  const name = raw.trim()
  if (!name || name.length > MAX_NAME_CHARS || name.includes('\0')) {
    throw new Error(`Vault item name must be 1 to ${MAX_NAME_CHARS} characters`)
  }
  return name
}

function validateKind(raw: unknown): VaultItemKind {
  if (typeof raw !== 'string' || !(VAULT_ITEM_KINDS as readonly string[]).includes(raw)) {
    throw new Error(`Vault item kind must be one of: ${VAULT_ITEM_KINDS.join(', ')}`)
  }
  return raw as VaultItemKind
}

function validateApprovalMode(raw: unknown): VaultApprovalMode {
  if (raw === undefined) return 'on_taint'
  if (typeof raw !== 'string' || !(VAULT_APPROVAL_MODES as readonly string[]).includes(raw)) {
    throw new Error(`Vault approval mode must be one of: ${VAULT_APPROVAL_MODES.join(', ')}`)
  }
  return raw as VaultApprovalMode
}

function validateAllowedDomains(raw: unknown, kind: VaultItemKind): string[] {
  if (raw === undefined) {
    if (kind === 'login') throw new Error('Login vault items require at least one allowed domain')
    return []
  }
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    throw new Error('allowedDomains must be an array of domain strings')
  }
  const { domains, invalid } = normalizeDomainList(raw)
  if (invalid.length > 0) {
    throw new Error(`Invalid allowed domain pattern: ${invalid.join(', ')}`)
  }
  if (domains.length > MAX_ALLOWED_DOMAINS) {
    throw new Error(`At most ${MAX_ALLOWED_DOMAINS} allowed domains per vault item`)
  }
  if (kind === 'login' && domains.length === 0) {
    throw new Error('Login vault items require at least one allowed domain')
  }
  return domains
}

function validateFields(raw: unknown): VaultFieldMeta[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FIELDS_PER_ITEM) {
    throw new Error(`Vault item must define 1 to ${MAX_FIELDS_PER_ITEM} fields`)
  }
  const seen = new Set<string>()
  const out: VaultFieldMeta[] = []
  for (const entry of raw) {
    if (!isObject(entry)) throw new Error('Each vault field must be an object')
    const key = typeof entry.key === 'string' ? entry.key.trim() : ''
    if (!isVaultFieldKey(key)) throw new Error(`Invalid vault field key: "${key}"`)
    if (seen.has(key)) throw new Error(`Duplicate vault field key: "${key}"`)
    seen.add(key)

    const kindRaw = entry.kind ?? 'text'
    if (typeof kindRaw !== 'string' || !(VAULT_FIELD_KINDS as readonly string[]).includes(kindRaw)) {
      throw new Error(`Invalid field kind for "${key}"`)
    }
    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 64) : ''
    out.push({ key, kind: kindRaw as VaultFieldKind, ...(label ? { label } : {}) })
  }
  return out
}

function validateValuesPatch(
  raw: unknown,
  fields: readonly VaultFieldMeta[],
  allowNull: boolean,
): Record<string, string | null> {
  if (raw === undefined) return {}
  if (!isObject(raw)) throw new Error('values must be a JSON object')
  const fieldByKey = new Map(fields.map((f) => [f.key, f]))
  const out: Record<string, string | null> = {}
  for (const [rawKey, val] of Object.entries(raw)) {
    if (!Object.hasOwn(raw, rawKey)) continue
    const key = rawKey.trim()
    const meta = fieldByKey.get(key)
    if (!meta) throw new Error(`Unknown vault field "${key}"`)
    if (val === null) {
      if (!allowNull) throw new Error(`Value for "${key}" must be a string`)
      out[key] = null
      continue
    }
    if (typeof val !== 'string') throw new Error(`Value for "${key}" must be a string`)
    if (val.length > MAX_FIELD_VALUE_CHARS || val.includes('\0')) {
      throw new Error(`Value for "${key}" exceeds ${MAX_FIELD_VALUE_CHARS} characters or contains NUL`)
    }
    if (val === '') {
      if (allowNull) out[key] = null
      continue
    }
    if (meta.kind === 'totp') {
      parseTotpInput(val)
    }
    out[key] = val
  }
  return out
}

function toView(item: VaultItemRow, secrets: VaultSecretStore): VaultItemView {
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    kind: item.kind,
    allowedDomains: item.allowedDomains,
    fields: secrets.masked(item.id, item.fields),
    approvalMode: item.approvalMode,
    notes: item.notes,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

export function mountVault(app: Hono, deps: VaultApiDeps): { snapshot: () => VaultSnapshot } {
  const { db, secrets, hub } = deps
  const now = deps.now ?? (() => Date.now())

  const snapshot = (): VaultSnapshot => ({
    items: listVaultItems(db).map((item) => toView(item, secrets)),
    botGrants: listAllBotVaultGrants(db),
  })

  app.get('/api/vault', (c) => c.json(snapshot()))

  app.post('/api/vault', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    try {
      const name = validateName(body.name)
      const kind = validateKind(body.kind)
      const allowedDomains = validateAllowedDomains(body.allowedDomains, kind)
      const fields = validateFields(body.fields)
      const approvalMode = validateApprovalMode(body.approvalMode)
      const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, MAX_NOTES_CHARS) : ''
      const valuesPatch = validateValuesPatch(body.values, fields, false)
      const slug = typeof body.slug === 'string' ? body.slug.trim() : undefined

      const created = createVaultItem(db, {
        name,
        ...(slug ? { slug } : {}),
        kind,
        allowedDomains,
        fields,
        approvalMode,
        notes,
        now: now(),
      })
      if (Object.keys(valuesPatch).length > 0) {
        secrets.patch(created.id, valuesPatch)
      }
      if (Array.isArray(body.botIds) && body.botIds.every((id) => typeof id === 'string')) {
        setVaultItemBots(db, created.id, body.botIds, now())
      }
      hub.broadcast({ type: 'vault_changed' })
      return c.json({ item: toView(created, secrets), snapshot: snapshot() }, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.patch('/api/vault/:id', async (c) => {
    const id = c.req.param('id')
    if (!isVaultItemId(id)) return c.json({ error: 'invalid vault item id' }, 400)
    const existing = getVaultItem(db, id)
    if (!existing) return c.json({ error: 'unknown vault item' }, 404)

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    try {
      const name = body.name !== undefined ? validateName(body.name) : existing.name
      const kind = body.kind !== undefined ? validateKind(body.kind) : existing.kind
      const allowedDomains = body.allowedDomains !== undefined
        ? validateAllowedDomains(body.allowedDomains, kind)
        : validateAllowedDomains(existing.allowedDomains, kind)
      const fields = body.fields !== undefined ? validateFields(body.fields) : existing.fields
      const approvalMode = body.approvalMode !== undefined
        ? validateApprovalMode(body.approvalMode)
        : existing.approvalMode
      const notes = body.notes !== undefined
        ? (typeof body.notes === 'string' ? body.notes.trim().slice(0, MAX_NOTES_CHARS) : '')
        : existing.notes
      const valuesPatch = validateValuesPatch(body.values, fields, true)

      // 删掉的字段同步从 secrets 文件里清除，避免孤儿明文滞留
      const nextKeys = new Set(fields.map((f) => f.key))
      for (const oldField of existing.fields) {
        if (!nextKeys.has(oldField.key)) {
          valuesPatch[oldField.key] = null
        }
      }

      const updated = updateVaultItem(db, id, {
        name,
        kind,
        allowedDomains,
        fields,
        approvalMode,
        notes,
        now: now(),
      })!
      if (Object.keys(valuesPatch).length > 0) {
        secrets.patch(id, valuesPatch)
      }
      if (Array.isArray(body.botIds) && body.botIds.every((b) => typeof b === 'string')) {
        setVaultItemBots(db, id, body.botIds, now())
      }
      hub.broadcast({ type: 'vault_changed' })
      return c.json({ item: toView(updated, secrets), snapshot: snapshot() })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.delete('/api/vault/:id', (c) => {
    const id = c.req.param('id')
    if (!isVaultItemId(id)) return c.json({ error: 'invalid vault item id' }, 400)
    if (!deleteVaultItem(db, id)) return c.json({ error: 'unknown vault item' }, 404)
    secrets.remove(id)
    hub.broadcast({ type: 'vault_changed' })
    return c.json({ ok: true, snapshot: snapshot() })
  })

  app.put('/api/bots/:botId/vault', async (c) => {
    const botId = c.req.param('botId')
    const exists = db.prepare('SELECT 1 FROM bots WHERE id = ?').get(botId)
    if (!exists) return c.json({ error: 'unknown bot' }, 404)
    const body = (await c.req.json().catch(() => null)) as { itemIds?: unknown } | null
    if (!body || !Array.isArray(body.itemIds) || body.itemIds.some((id) => typeof id !== 'string')) {
      return c.json({ error: 'itemIds must be an array of vault item ids' }, 400)
    }
    const granted = setBotVaultItems(db, botId, body.itemIds, now())
    hub.broadcast({ type: 'vault_changed' })
    return c.json({ botId, itemIds: granted, snapshot: snapshot() })
  })

  return { snapshot }
}
