import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPendingOAuthStore } from '../src/connectors/oauth-pendings.js'
import type { ConnectorDriver, ConnectorStatus } from '../src/connectors/types.js'
import { openDb, upsertBot } from '../src/db.js'
import { createApp } from '../src/server.js'

const okLlm = {
  chat: async () => ({ content: 'ok', toolCalls: [], raw: { role: 'assistant' as const, content: 'ok' } }),
}

function stubDriver(overrides: Partial<ConnectorDriver> = {}): ConnectorDriver & { revoked: string[] } {
  let configured = false
  let counter = 0
  const revoked: string[] = []
  return {
    revoked,
    id: 'composio',
    configured: () => configured,
    testKey: async (k) => (k === 'bad' ? { ok: false, code: 'unauthorized', detail: 'bad key' } : { ok: true }),
    startOAuth: async ({ app }) => {
      configured = true
      counter++
      return {
        authConfigId: `ac_${app}`,
        remoteId: `rem_${counter}`,
        redirectUrl: `https://backend.composio.dev/oauth/${counter}`,
      }
    },
    inspectAccount: async ({ remoteId }) => ({
      status: 'active',
      accountLabel: remoteId === 'rem_2' ? 'reconnected@gmail.com' : 'alice@gmail.com',
    }),
    revokeAccount: async ({ remoteId }) => {
      revoked.push(remoteId)
    },
    listMail: async () => ({ messages: [] }),
    readMail: async () => ({ messages: [] }),
    createOrUpdateDraft: async () => ({ draftId: 'd1', summary: 'draft saved' }),
    listCalendarEvents: async () => ({ events: [] }),
    searchNotion: async () => ({ pages: [] }),
    readNotionPage: async () => ({ id: 'p1', title: 'Doc', content: '' }),
    listSlackChannels: async () => ({ channels: [] }),
    readSlackMessages: async () => ({ messages: [] }),
    executeWrite: async () => ({ status: 'succeeded', summary: 'ok' }),
    ...overrides,
  }
}

describe('createPendingOAuthStore', () => {
  it('enforces one-time consumption, 15-minute TTL expiry, and bounded max pending slots', () => {
    let clock = 1_000
    const store = createPendingOAuthStore({ ttlMs: 15 * 60_000, max: 2, now: () => clock })

    const n1 = store.mint()
    expect(n1).toMatch(/^[0-9a-f]{48}$/)
    store.put(n1, { connectorId: 'ca-00000001', app: 'gmail', candidateRemoteId: 'r1', authConfigId: 'ac1' })

    const n2 = store.mint()
    store.put(n2, { connectorId: 'ca-00000002', app: 'slack', candidateRemoteId: 'r2', authConfigId: 'ac2' })

    // 3rd mint while 2 are unexpired must throw
    expect(() => store.mint()).toThrow(/too many connector authorizations in progress/)

    // Consuming n1 returns entry once and frees a slot; replay returns null
    expect(store.consume(n1)).toMatchObject({ connectorId: 'ca-00000001', candidateRemoteId: 'r1' })
    expect(store.consume(n1)).toBeNull()

    // Advance past TTL: n2 expires and sweeps on consume / mint
    clock += 15 * 60_000 + 1
    expect(store.consume(n2)).toBeNull()

    const n3 = store.mint()
    expect(n3).toMatch(/^[0-9a-f]{48}$/)
  })
})

describe('connectors HTTP API & OAuth callback', () => {
  it('saves key, completes one-time OAuth callback, preserves remote_id on abandoned reconnect, and updates bot grants', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'osb-conn-api-'))
    const db = openDb(':memory:')
    upsertBot(db, { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' })
    upsertBot(db, { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })
    const driver = stubDriver()
    const gw = createApp({ db, llm: okLlm, dataDir, env: {}, connectorDriver: driver })
    const events: unknown[] = []
    gw.hub.add({ send: (raw) => events.push(JSON.parse(raw)) })

    // Before saving a key, connect is rejected as unconfigured
    const unconf = await gw.app.request('http://127.0.0.1:4747/api/connectors/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4747' },
      body: JSON.stringify({ app: 'gmail' }),
    })
    expect(unconf.status).toBe(400)

    // 1. Save Composio API key
    const putKey = await gw.app.request('http://127.0.0.1:4747/api/connectors/key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'cmp_valid_12345678' }),
    })
    expect(putKey.status).toBe(200)
    expect((await putKey.json()).key).toMatchObject({ set: true, source: 'file', locked: false })

    // 2. Start OAuth with initial grant to inbox-keeper
    const start = await gw.app.request('http://127.0.0.1:4747/api/connectors/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4747' },
      body: JSON.stringify({ app: 'gmail', botIds: ['inbox-keeper'] }),
    })
    expect(start.status).toBe(201)
    const started = await start.json()
    expect(started.redirectUrl).toBe('https://backend.composio.dev/oauth/1')

    // Extract nonce from pending store via callback URL returned in state
    const cbRes = await gw.app.request(started.callbackUrl)
    expect(cbRes.status).toBe(200)
    expect(cbRes.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(cbRes.headers.get('referrer-policy')).toBe('no-referrer')
    expect(cbRes.headers.get('cache-control')).toBe('no-store')
    expect(await cbRes.text()).toContain('OpenSuperBot')

    // Replay of same one-time nonce must 404 with CSP headers
    const replay = await gw.app.request(started.callbackUrl)
    expect(replay.status).toBe(404)
    expect(replay.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'")

    // Account is now active with alice@gmail.com and WS broadcast fired
    const snap = await (await gw.app.request('http://127.0.0.1:4747/api/connectors')).json()
    expect(snap.accounts[0]).toMatchObject({ status: 'active', accountLabel: 'alice@gmail.com' })
    expect(snap.botGrants['inbox-keeper']).toEqual([started.connectorId])
    expect(snap.botGrants.researcher).toEqual([])
    expect(events.some((e: any) => e.type === 'connectors_changed')).toBe(true)

    // Computer endpoint exposes connector list with per-bot granted flag
    const compInbox = await (await gw.app.request('http://127.0.0.1:4747/api/bots/inbox-keeper/computer')).json()
    expect(compInbox.connectors).toEqual([
      {
        id: started.connectorId,
        app: 'gmail',
        name: 'Gmail',
        accountLabel: 'alice@gmail.com',
        status: 'active',
        granted: true,
      },
    ])
    const compScout = await (await gw.app.request('http://127.0.0.1:4747/api/bots/researcher/computer')).json()
    expect(compScout.connectors[0].granted).toBe(false)

    // 3. Start reconnect — before callback finishes, original remote_id & label stay active!
    const reconn = await gw.app.request(`http://127.0.0.1:4747/api/connectors/${started.connectorId}/reconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4747' },
      body: '{}',
    })
    expect(reconn.status).toBe(200)
    const reconnBody = await reconn.json()
    const midSnap = await (await gw.app.request('http://127.0.0.1:4747/api/connectors')).json()
    expect(midSnap.accounts[0]).toMatchObject({ status: 'active', accountLabel: 'alice@gmail.com' })

    // Complete reconnect callback -> swaps to rem_2 / reconnected@gmail.com and revokes rem_1
    await gw.app.request(reconnBody.callbackUrl)
    const afterReconn = await (await gw.app.request('http://127.0.0.1:4747/api/connectors')).json()
    expect(afterReconn.accounts[0].accountLabel).toBe('reconnected@gmail.com')
    expect(driver.revoked).toEqual(['rem_1'])

    // 4. Update bot grants via PUT /api/bots/:botId/connectors
    const grantRes = await gw.app.request('http://127.0.0.1:4747/api/bots/researcher/connectors', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectorIds: [started.connectorId, 'ca-deadbeef'] }),
    })
    expect(grantRes.status).toBe(200)
    expect(await grantRes.json()).toEqual({ botId: 'researcher', connectorIds: [started.connectorId] })

    const missingBot = await gw.app.request('http://127.0.0.1:4747/api/bots/ghost/connectors', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectorIds: [] }),
    })
    expect(missingBot.status).toBe(404)
  })

  it('validates keys, honors env lock, handles failed reconnect without clobbering active account, refreshes, and deletes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'osb-conn-edge-'))
    const db = openDb(':memory:')
    upsertBot(db, { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' })

    let inspectStatus: ConnectorStatus = 'active'
    let inspectLabel = 'Team <script>alert(1)</script>'
    let failRevoke = false
    const driver = stubDriver({
      inspectAccount: async () => ({ status: inspectStatus, accountLabel: inspectLabel }),
      revokeAccount: async ({ remoteId }) => {
        if (failRevoke) throw new Error('upstream down')
        driver.revoked.push(remoteId)
      },
    })

    // Env-locked gateway rejects PUT /api/connectors/key with 409
    const lockedGw = createApp({
      db,
      llm: okLlm,
      dataDir,
      env: { OPENSUPERBOT_COMPOSIO_API_KEY: 'cmp_env_locked_9999' },
      connectorDriver: driver,
    })
    const lockedRes = await lockedGw.app.request('http://127.0.0.1:4747/api/connectors/key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'cmp_other_123456' }),
    })
    expect(lockedRes.status).toBe(409)
    expect(await lockedRes.json()).toEqual({ error: 'locked' })

    // Unlocked gateway with token enabled: /api/* requires auth, /oauth/connector/:nonce stays public
    const TOKEN = 'test-gateway-token-1234567890'
    const gw = createApp({ db, llm: okLlm, dataDir, env: {}, token: TOKEN, connectorDriver: driver })
    const authHeaders = {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      host: '127.0.0.1:4747',
      origin: 'http://127.0.0.1:4747',
    }

    expect((await gw.app.request('http://127.0.0.1:4747/api/connectors')).status).toBe(401)

    // Test key endpoint before and with bad/good candidates
    const testUnconf = await gw.app.request('http://127.0.0.1:4747/api/connectors/key/test', {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    })
    expect(testUnconf.status).toBe(200)
    expect((await testUnconf.json()).ok).toBe(false)

    const testBad = await gw.app.request('http://127.0.0.1:4747/api/connectors/key/test', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ apiKey: 'bad' }),
    })
    expect(await testBad.json()).toEqual({ ok: false, code: 'unauthorized', detail: 'bad key' })

    // PUT invalid key returns 400 with code & detail
    const putBad = await gw.app.request('http://127.0.0.1:4747/api/connectors/key', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ apiKey: 'bad' }),
    })
    expect(putBad.status).toBe(400)
    expect(await putBad.json()).toEqual({ error: 'invalid_key', code: 'unauthorized', detail: 'bad key' })

    const putSpaces = await gw.app.request('http://127.0.0.1:4747/api/connectors/key', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ apiKey: 'has whitespace' }),
    })
    expect(putSpaces.status).toBe(400)

    // Save valid key
    await gw.app.request('http://127.0.0.1:4747/api/connectors/key', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ apiKey: 'cmp_good_1234567890' }),
    })
    expect(await (await gw.app.request('http://127.0.0.1:4747/api/connectors/key/test', {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    })).json()).toEqual({ ok: true })

    // Initial connect where user abandons consent (callback sees non-active) marks row non-active
    inspectStatus = 'failed'
    const failedStart = await (await gw.app.request('http://127.0.0.1:4747/api/connectors/connect', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ app: 'notion' }),
    })).json()
    // Public callback without auth header works!
    const failedCb = await gw.app.request(failedStart.callbackUrl)
    expect(failedCb.status).toBe(200)
    const afterFailedInit = await (await gw.app.request('http://127.0.0.1:4747/api/connectors', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json()
    expect(afterFailedInit.accounts[0]).toMatchObject({
      id: failedStart.connectorId,
      status: 'failed',
      lastError: 'authorization was not completed',
    })

    // Refresh brings it active and escapes HTML in callback
    inspectStatus = 'active'
    const refreshed = await (await gw.app.request(`http://127.0.0.1:4747/api/connectors/${failedStart.connectorId}/refresh`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    })).json()
    expect(refreshed.accounts[0]).toMatchObject({ status: 'active', accountLabel: 'Team <script>alert(1)</script>' })

    // Reconnect where callback is NOT active must NOT clobber the still-active account!
    inspectStatus = 'failed'
    const reconn = await (await gw.app.request(`http://127.0.0.1:4747/api/connectors/${failedStart.connectorId}/reconnect`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    })).json()
    const failedReconnCb = await gw.app.request(reconn.callbackUrl)
    expect(failedReconnCb.status).toBe(200)
    const afterFailedReconn = await (await gw.app.request('http://127.0.0.1:4747/api/connectors', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json()
    expect(afterFailedReconn.accounts[0]).toMatchObject({
      status: 'active',
      accountLabel: 'Team <script>alert(1)</script>',
      lastError: '',
    })

    // Reconnect where callback IS active escapes HTML in rendered page
    inspectStatus = 'active'
    const reconn2 = await (await gw.app.request(`http://127.0.0.1:4747/api/connectors/${failedStart.connectorId}/reconnect`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    })).json()
    const okReconnHtml = await (await gw.app.request(reconn2.callbackUrl)).text()
    expect(okReconnHtml).not.toContain('<script>')
    expect(okReconnHtml).toContain('&lt;script&gt;')

    // Refresh when upstream reports expired updates status to expired
    inspectStatus = 'expired'
    const expSnap = await (await gw.app.request(`http://127.0.0.1:4747/api/connectors/${failedStart.connectorId}/refresh`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    })).json()
    expect(expSnap.accounts[0].status).toBe('expired')

    // Delete best-effort revokes upstream (even when revokeAccount rejects) and deletes row
    failRevoke = true
    const delRes = await gw.app.request(`http://127.0.0.1:4747/api/connectors/${failedStart.connectorId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:4747', origin: 'http://127.0.0.1:4747' },
    })
    expect(delRes.status).toBe(200)
    expect((await delRes.json()).accounts).toEqual([])

    // Clear key via null
    const cleared = await (await gw.app.request('http://127.0.0.1:4747/api/connectors/key', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ apiKey: null }),
    })).json()
    expect(cleared.key.set).toBe(false)

    // Trusted dev/proxy Origin is preserved in callbackUrl, while untrusted Origin is ignored when token is off
    const proxyGw = createApp({
      db,
      llm: okLlm,
      dataDir,
      env: { OPENSUPERBOT_COMPOSIO_API_KEY: 'cmp_env_1234567890' },
      allowedOrigins: ['http://localhost:5173'],
      connectorDriver: driver,
    })
    const devStart = await (await proxyGw.app.request('http://127.0.0.1:4747/api/connectors/connect', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: '127.0.0.1:4747',
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ app: 'slack' }),
    })).json()
    expect(devStart.callbackUrl).toMatch(/^http:\/\/localhost:5173\/oauth\/connector\/[0-9a-f]{48}$/)
  })
})
