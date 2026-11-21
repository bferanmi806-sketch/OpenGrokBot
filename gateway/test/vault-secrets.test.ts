import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVaultSecretStore } from '../src/vault/secrets.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('vault secret store', () => {
  it('writes 0600 atomic JSON on disk and masks secret/totp while previewing text fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osb-vault-'))
    dirs.push(dir)
    const store = createVaultSecretStore(dir)

    store.patch('vault-a1b2c3d4', {
      username: 'alice@acme.test',
      password: 'SuperSecretPassword!99',
      totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    })

    if (process.platform !== 'win32') {
      const mode = statSync(join(dir, 'vault-secrets.json')).mode & 0o777
      expect(mode).toBe(0o600)
    }

    const masked = store.masked('vault-a1b2c3d4', [
      { key: 'username', kind: 'text' },
      { key: 'password', kind: 'secret' },
      { key: 'totp', kind: 'totp' },
    ])
    expect(masked[0]).toMatchObject({ key: 'username', set: true, preview: 'alice@acme.test' })
    expect(masked[1]?.set).toBe(true)
    expect(masked[1]?.preview).not.toContain('SuperSecretPassword')
    expect(masked[2]).toMatchObject({ key: 'totp', set: true, preview: '•••••• (TOTP)' })

    // Partial patch keeps existing values and removes null/empty fields
    store.patch('vault-a1b2c3d4', { totp: null })
    expect(store.get('vault-a1b2c3d4')).toEqual({
      username: 'alice@acme.test',
      password: 'SuperSecretPassword!99',
    })
  })

  it('redacts secret values longest-first including Bearer suffixes', () => {
    const store = createVaultSecretStore('')
    store.patch('vault-11111111', {
      auth: 'Bearer tok_live_abcdef123456',
      pass: 'my-secret-pass',
    })
    const out = store.redactText(
      ['vault-11111111'],
      'error with Bearer tok_live_abcdef123456 and raw tok_live_abcdef123456 and my-secret-pass',
    )
    expect(out).toBe('error with [REDACTED] and raw [REDACTED] and [REDACTED]')
    expect(out).not.toContain('tok_live_abcdef123456')
    expect(out).not.toContain('my-secret-pass')
  })
})
