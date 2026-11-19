import { randomBytes } from 'node:crypto'
import type { AppKey } from './types.js'

export type PendingOAuth = {
  connectorId: string
  app: AppKey
  candidateRemoteId: string
  authConfigId: string
  previousRemoteId?: string
  expiresAt: number
}

export function createPendingOAuthStore(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
  const ttlMs = opts.ttlMs ?? 15 * 60_000
  const max = opts.max ?? 32
  const now = opts.now ?? Date.now
  const map = new Map<string, PendingOAuth>()

  const sweep = (at: number) => {
    for (const [k, v] of map) {
      if (v.expiresAt <= at) map.delete(k)
    }
  }

  return {
    mint(): string {
      const at = now()
      sweep(at)
      if (map.size >= max) throw new Error('too many connector authorizations in progress')
      return randomBytes(24).toString('hex')
    },
    put(nonce: string, entry: Omit<PendingOAuth, 'expiresAt'>): void {
      const at = now()
      sweep(at)
      if (!map.has(nonce) && map.size >= max) {
        throw new Error('too many connector authorizations in progress')
      }
      map.set(nonce, { ...entry, expiresAt: at + ttlMs })
    },
    consume(nonce: string): PendingOAuth | null {
      const at = now()
      sweep(at)
      const found = map.get(nonce)
      if (!found) return null
      map.delete(nonce)
      return found
    },
  }
}
