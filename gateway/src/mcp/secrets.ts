import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { restrictToOwner } from '../auth.js'
import { maskKey } from '../settings.js'
import type { McpSecretVault, McpServerSecrets } from './types.js'

export type { McpSecretVault, McpServerSecrets } from './types.js'

type StoredSecretsFile = {
  version: 1
  servers: Record<string, McpServerSecrets>
}

const secretsFile = (dataDir: string) => join(dataDir, 'mcp-secrets.json')

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const isSafeObjectKey = (key: string): boolean => key.length > 0 && !FORBIDDEN_OBJECT_KEYS.has(key)

function sanitizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.hasOwn(raw, k)) continue
    const key = k.trim()
    if (isSafeObjectKey(key) && typeof v === 'string' && v.length > 0) {
      out[key] = v
    }
  }
  return out
}

function cloneSecrets(entry?: McpServerSecrets): McpServerSecrets {
  return {
    env: entry ? { ...entry.env } : {},
    headers: entry ? { ...entry.headers } : {},
  }
}

function applyPatchMap(
  base: Record<string, string>,
  patch?: Record<string, string | null>,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (Object.hasOwn(base, k) && isSafeObjectKey(k)) {
      next[k] = v
    }
  }
  if (!patch) return next
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(patch, k)) continue
    const key = k.trim()
    if (!isSafeObjectKey(key)) continue
    if (v === null || v === '') {
      delete next[key]
    } else if (typeof v === 'string') {
      next[key] = v
    }
  }
  return next
}

export function createMcpSecretVault(
  dataDir: string,
  opts: { restrict?: (path: string) => void; warn?: (line: string) => void } = {},
): McpSecretVault {
  const memory = new Map<string, McpServerSecrets>()

  const readDisk = (): Record<string, McpServerSecrets> => {
    const path = secretsFile(dataDir)
    if (!existsSync(path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredSecretsFile> | null
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !Object.hasOwn(parsed, 'servers') ||
        !parsed.servers ||
        typeof parsed.servers !== 'object' ||
        Array.isArray(parsed.servers)
      ) {
        return {}
      }
      const out: Record<string, McpServerSecrets> = {}
      for (const [serverId, entry] of Object.entries(parsed.servers)) {
        if (!Object.hasOwn(parsed.servers, serverId) || !isSafeObjectKey(serverId)) continue
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const env = Object.hasOwn(entry, 'env') ? sanitizeStringMap((entry as Partial<McpServerSecrets>).env) : {}
        const headers = Object.hasOwn(entry, 'headers')
          ? sanitizeStringMap((entry as Partial<McpServerSecrets>).headers)
          : {}
        if (Object.keys(env).length > 0 || Object.keys(headers).length > 0) {
          out[serverId] = { env, headers }
        }
      }
      return out
    } catch {
      return {}
    }
  }

  const writeDisk = (servers: Record<string, McpServerSecrets>): void => {
    const path = secretsFile(dataDir)
    mkdirSync(dataDir, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    const payload: StoredSecretsFile = { version: 1, servers }
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

  const get = (serverId: string): McpServerSecrets => {
    if (!isSafeObjectKey(serverId)) return cloneSecrets()
    if (!dataDir) return cloneSecrets(memory.get(serverId))
    const servers = readDisk()
    return cloneSecrets(Object.hasOwn(servers, serverId) ? servers[serverId] : undefined)
  }

  const patch: McpSecretVault['patch'] = (serverId, update) => {
    if (!isSafeObjectKey(serverId)) return cloneSecrets()
    if (!dataDir) {
      const cur = cloneSecrets(memory.get(serverId))
      const next: McpServerSecrets = {
        env: applyPatchMap(cur.env, update.env),
        headers: applyPatchMap(cur.headers, update.headers),
      }
      if (Object.keys(next.env).length === 0 && Object.keys(next.headers).length === 0) {
        memory.delete(serverId)
      } else {
        memory.set(serverId, next)
      }
      return cloneSecrets(next)
    }

    const servers = readDisk()
    const cur = cloneSecrets(Object.hasOwn(servers, serverId) ? servers[serverId] : undefined)
    const next: McpServerSecrets = {
      env: applyPatchMap(cur.env, update.env),
      headers: applyPatchMap(cur.headers, update.headers),
    }
    if (Object.keys(next.env).length === 0 && Object.keys(next.headers).length === 0) {
      delete servers[serverId]
    } else {
      servers[serverId] = next
    }
    writeDisk(servers)
    return cloneSecrets(next)
  }

  const remove = (serverId: string): void => {
    if (!isSafeObjectKey(serverId)) return
    if (!dataDir) {
      memory.delete(serverId)
      return
    }
    const path = secretsFile(dataDir)
    if (!existsSync(path)) return
    const servers = readDisk()
    if (Object.hasOwn(servers, serverId)) {
      delete servers[serverId]
    }
    writeDisk(servers)
  }

  const masked = (serverId: string): { envMasked: Record<string, string>; headersMasked: Record<string, string> } => {
    const cur = get(serverId)
    return {
      envMasked: Object.fromEntries(Object.entries(cur.env).map(([k, v]) => [k, maskKey(v)])),
      headersMasked: Object.fromEntries(Object.entries(cur.headers).map(([k, v]) => [k, maskKey(v)])),
    }
  }

  const redactText = (serverId: string, text: string): string => {
    if (!text) return text
    const cur = get(serverId)
    const candidates = new Set<string>()
    for (const raw of [...Object.values(cur.env), ...Object.values(cur.headers)]) {
      if (raw.length >= 4) candidates.add(raw)
      const trimmed = raw.trim()
      if (trimmed.length >= 4) candidates.add(trimmed)
      const bearer = /^Bearer\s+(.+)$/i.exec(trimmed)
      if (bearer?.[1]) {
        const suffix = bearer[1].trim()
        if (suffix.length >= 4) candidates.add(suffix)
      }
    }
    const sorted = [...candidates].sort((a, b) => b.length - a.length)
    let out = text
    for (const secret of sorted) {
      out = out.split(secret).join('[REDACTED]')
    }
    return out
  }

  return { get, patch, remove, masked, redactText }
}
