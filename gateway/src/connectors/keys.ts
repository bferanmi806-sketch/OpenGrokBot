import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { restrictToOwner } from '../auth.js'
import { maskKey, validApiKey } from '../settings.js'

const COMPOSIO_KEY_ENV = 'OPENSUPERBOT_COMPOSIO_API_KEY'
const COMPOSIO_BASE_ENV = 'OPENSUPERBOT_COMPOSIO_BASE'
const DEFAULT_COMPOSIO_BASE = 'https://backend.composio.dev'

const keyFile = (dataDir: string) => join(dataDir, 'composio-key')

export function composioBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env[COMPOSIO_BASE_ENV] ?? '').trim().replace(/\/+$/, '')
  if (!raw) return DEFAULT_COMPOSIO_BASE
  try {
    const u = new URL(raw)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password) return raw
  } catch { /* fallback */ }
  return DEFAULT_COMPOSIO_BASE
}

export function resolveComposioKey(
  env: Record<string, string | undefined>,
  dataDir: string,
): { key: string; source: 'env' | 'file' | 'none' } {
  const fromEnv = (env[COMPOSIO_KEY_ENV] ?? '').trim()
  if (fromEnv) return { key: fromEnv, source: 'env' }
  if (!dataDir) return { key: '', source: 'none' }
  const path = keyFile(dataDir)
  if (!existsSync(path)) return { key: '', source: 'none' }
  const saved = readFileSync(path, 'utf8').trim()
  return saved ? { key: saved, source: 'file' } : { key: '', source: 'none' }
}

export function saveComposioKey(
  dataDir: string,
  key: string,
  opts: { restrict?: (path: string) => void; warn?: (line: string) => void } = {},
): void {
  const path = keyFile(dataDir)
  const trimmed = key.trim()
  if (!trimmed) {
    rmSync(path, { force: true })
    return
  }
  if (!validApiKey(trimmed)) throw new Error('invalid API key')
  mkdirSync(dataDir, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${trimmed}\n`, { mode: 0o600 })
  try {
    ;(opts.restrict ?? restrictToOwner)(tmp)
  } catch (err) {
    ;(opts.warn ?? console.warn)(`[gateway] could not limit ${path} to your account: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (process.platform !== 'win32') chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

export function composioKeyView(
  env: Record<string, string | undefined>,
  dataDir: string,
): { set: boolean; masked: string; source: 'env' | 'file' | 'none'; locked: boolean } {
  const resolved = resolveComposioKey(env, dataDir)
  return {
    set: resolved.source !== 'none',
    masked: maskKey(resolved.key),
    source: resolved.source,
    locked: resolved.source === 'env',
  }
}
