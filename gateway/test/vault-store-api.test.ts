import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { openDb, SCHEMA_VERSION, schemaVersion } from '../src/db.js'
import { createHub } from '../src/hub.js'
import { mountVault } from '../src/vault/api.js'
import { createVaultSecretStore } from '../src/vault/secrets.js'

function setup() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES (?, ?, ?, ?, '', ?)`).run(
    'chief',
    'Chief',
    'Chief of Staff',
    '🧠',
    1,
  )
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES (?, ?, ?, ?, '', ?)`).run(
    'ops',
    'Ops',
    'Operations',
    '🛠',
    2,
  )
  const secrets = createVaultSecretStore('')
  const events: unknown[] = []
  const hub = createHub()
  hub.add({ send: (d) => events.push(JSON.parse(d)) })
  const app = new Hono()
  mountVault(app, { db, secrets, hub, now: () => 10_000 })
  return { db, secrets, app, events }
}

describe('vault SQLite store and HTTP API', () => {
  it('migrates cleanly to latest schema version with vault tables', () => {
    const db = openDb(':memory:')
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('vault_items', 'bot_vault_items')`)
      .all() as { name: string }[]
    expect(tables.map((t) => t.name).sort()).toEqual(['bot_vault_items', 'vault_items'])
  })

  it('creates, lists, updates, grants, and deletes vault items without ever storing or returning raw secrets in SQLite/API', async () => {
    const { db, secrets, app, events } = setup()

    const createRes = await app.request('/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Zendesk Support',
        kind: 'login',
        allowedDomains: ['Acme.Zendesk.com'],
        approvalMode: 'on_taint',
        fields: [
          { key: 'username', kind: 'text', label: 'Email' },
          { key: 'password', kind: 'secret', label: 'Password' },
          { key: 'totp', kind: 'totp', label: '2FA' },
        ],
        values: {
          username: 'bot@acme.test',
          password: 'ultra-secret-password-999',
          totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        },
      }),
    })
    expect(createRes.status).toBe(201)
    const createdBody = (await createRes.json()) as {
      item: { id: string; slug: string; allowedDomains: string[]; fields: { key: string; set: boolean; preview: string }[] }
      snapshot: { botGrants: Record<string, string[]> }
    }
    const itemId = createdBody.item.id
    expect(createdBody.item.slug).toBe('zendesk_support')
    expect(createdBody.item.allowedDomains).toEqual(['acme.zendesk.com'])
    // Zero default grants
    expect(createdBody.snapshot.botGrants).toEqual({})
    // API response never contains raw password or TOTP secret
    const serialized = JSON.stringify(createdBody)
    expect(serialized).not.toContain('ultra-secret-password-999')
    expect(serialized).not.toContain('GEZDGNBVGY3TQOJQ')

    // SQLite row never contains raw password
    const rawRow = JSON.stringify(db.prepare('SELECT * FROM vault_items WHERE id = ?').get(itemId))
    expect(rawRow).not.toContain('ultra-secret-password-999')
    expect(rawRow).not.toContain('GEZDGNBVGY3TQOJQ')

    // Grant to ops only
    const grantRes = await app.request('/api/bots/ops/vault', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemIds: [itemId] }),
    })
    expect(grantRes.status).toBe(200)
    const grantBody = (await grantRes.json()) as { itemIds: string[]; snapshot: { botGrants: Record<string, string[]> } }
    expect(grantBody.itemIds).toEqual([itemId])
    expect(grantBody.snapshot.botGrants).toEqual({ ops: [itemId] })

    // Patch keeping existing password while dropping totp field
    const patchRes = await app.request(`/api/vault/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalMode: 'always',
        fields: [
          { key: 'username', kind: 'text', label: 'Email' },
          { key: 'password', kind: 'secret', label: 'Password' },
        ],
      }),
    })
    expect(patchRes.status).toBe(200)
    // Dropped totp field was purged from secrets store; password was kept
    expect(secrets.get(itemId)).toEqual({
      username: 'bot@acme.test',
      password: 'ultra-secret-password-999',
    })

    // Delete cascades grants and secrets
    const delRes = await app.request(`/api/vault/${itemId}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    expect(secrets.get(itemId)).toEqual({})
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_vault_items').get()).toEqual({ n: 0 })
    expect(events.filter((e) => (e as { type: string }).type === 'vault_changed').length).toBeGreaterThanOrEqual(4)
  })

  it('rejects login items without domains, invalid domains, and invalid TOTP secrets', async () => {
    const { app } = setup()

    const noDomain = await app.request('/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'No Domain Login',
        kind: 'login',
        allowedDomains: [],
        fields: [{ key: 'password', kind: 'secret' }],
      }),
    })
    expect(noDomain.status).toBe(400)

    const badDomain = await app.request('/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Broad Wildcard',
        kind: 'login',
        allowedDomains: ['*.com'],
        fields: [{ key: 'password', kind: 'secret' }],
      }),
    })
    expect(badDomain.status).toBe(400)

    const badTotp = await app.request('/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad TOTP',
        kind: 'login',
        allowedDomains: ['example.com'],
        fields: [{ key: 'totp', kind: 'totp' }],
        values: { totp: 'not-valid-base32!!!' },
      }),
    })
    expect(badTotp.status).toBe(400)
  })
})
