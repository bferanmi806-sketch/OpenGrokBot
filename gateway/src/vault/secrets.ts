import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { restrictToOwner } from '../auth.js'
import { maskKey } from '../settings.js'
import type { VaultFieldMeta, VaultMaskedField, VaultSecretStore } from './types.js'

type StoredVaultSecretsFile = {
  version: 1
  items: Record<string, Record<string, string>>
}

const secretsFile = (dataDir: string) => join(dataDir, 'vault-secrets.json')
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const isSafeKey = (key: string): boolean => key.length > 0 && !FORBIDDEN_KEYS.has(key)

function sanitizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.hasOwn(raw, k)) continue
    const key = k.trim()
    if (isSafeKey(key) && typeof v === 'string' && v.length > 0) {
      out[key] = v
    }
  }
  return out
}

function applyPatchMap(
  base: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (Object.hasOwn(base, k) && isSafeKey(k)) next[k] = v
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(patch, k)) continue
    const key = k.trim()
    if (!isSafeKey(key)) continue
    if (v === null || v === '') {
      delete next[key]
    } else if (typeof v === 'string') {
      next[key] = v
    }
  }
  return next
}

/**
 * 沿用 mcp-secrets.json 同款的本地 0600 原子存储。
 * 不入 SQLite、不挂进任何同事容器或命令沙箱、不向模型暴露原始值。
 */
export function createVaultSecretStore(
  dataDir: string,
  opts: { restrict?: (path: string) => void; warn?: (line: string) => void } = {},
): VaultSecretStore {
  const memory = new Map<string, Record<string, string>>()

  const readDisk = (): Record<string, Record<string, string>> => {
    const path = secretsFile(dataDir)
    if (!existsSync(path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredVaultSecretsFile> | null
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !Object.hasOwn(parsed, 'items') ||
        !parsed.items ||
        typeof parsed.items !== 'object' ||
        Array.isArray(parsed.items)
      ) {
        return {}
      }
      const out: Record<string, Record<string, string>> = {}
      for (const [itemId, entry] of Object.entries(parsed.items)) {
        if (!Object.hasOwn(parsed.items, itemId) || !isSafeKey(itemId)) continue
        const clean = sanitizeStringMap(entry)
        if (Object.keys(clean).length > 0) out[itemId] = clean
      }
      return out
    } catch {
      return {}
    }
  }

  const writeDisk = (items: Record<string, Record<string, string>>): void => {
    const path = secretsFile(dataDir)
    mkdirSync(dataDir, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    const payload: StoredVaultSecretsFile = { version: 1, items }
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    try {
      ;(opts.restrict ?? restrictToOwner)(tmp)
    } catch (err) {
      ;(opts.warn ?? console.warn)(
        `[gateway] could not limit ${path} to your account: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  }

  const get = (itemId: string): Record<string, string> => {
    if (!isSafeKey(itemId)) return {}
    if (!dataDir) return { ...(memory.get(itemId) ?? {}) }
    const items = readDisk()
    return Object.hasOwn(items, itemId) ? { ...items[itemId]! } : {}
  }

  const patch = (itemId: string, update: Record<string, string | null>): Record<string, string> => {
    if (!isSafeKey(itemId)) return {}
    if (!dataDir) {
      const next = applyPatchMap(memory.get(itemId) ?? {}, update)
      if (Object.keys(next).length === 0) memory.delete(itemId)
      else memory.set(itemId, next)
      return { ...next }
    }
    const items = readDisk()
    const next = applyPatchMap(Object.hasOwn(items, itemId) ? items[itemId]! : {}, update)
    if (Object.keys(next).length === 0) delete items[itemId]
    else items[itemId] = next
    writeDisk(items)
    return { ...next }
  }

  const remove = (itemId: string): void => {
    if (!isSafeKey(itemId)) return
    if (!dataDir) {
      memory.delete(itemId)
      return
    }
    const path = secretsFile(dataDir)
    if (!existsSync(path)) return
    const items = readDisk()
    if (Object.hasOwn(items, itemId)) {
      delete items[itemId]
      writeDisk(items)
    }
  }

  const masked = (itemId: string, fields: readonly VaultFieldMeta[]): VaultMaskedField[] => {
    const values = get(itemId)
    return fields.map((f) => {
      const raw = Object.hasOwn(values, f.key) ? values[f.key]! : ''
      const set = raw.length > 0
      let preview = ''
      if (set) {
        if (f.kind === 'totp') preview = '•••••• (TOTP)'
        else if (f.kind === 'secret') preview = maskKey(raw)
        else preview = raw.length > 80 ? `${raw.slice(0, 77)}…` : raw
      }
      return {
        key: f.key,
        kind: f.kind,
        ...(f.label ? { label: f.label } : {}),
        set,
        preview,
      }
    })
  }

  const redactText = (itemIds: readonly string[], text: string): string => {
    if (!text || itemIds.length === 0) return text
    const candidates = new Set<string>()
    for (const itemId of itemIds) {
      const values = get(itemId)
      for (const raw of Object.values(values)) {
        if (raw.length >= 4) candidates.add(raw)
        const trimmed = raw.trim()
        if (trimmed.length >= 4) candidates.add(trimmed)
        const bearer = /^Bearer\s+(.+)$/i.exec(trimmed)
        if (bearer?.[1]) {
          const suffix = bearer[1].trim()
          if (suffix.length >= 4) candidates.add(suffix)
        }
      }
    }
    if (candidates.size === 0) return text
    const sorted = [...candidates].sort((a, b) => b.length - a.length)
    let out = text
    for (const secret of sorted) {
      out = out.split(secret).join('[REDACTED]')
    }
    return out
  }

  return { get, patch, remove, masked, redactText }
}
