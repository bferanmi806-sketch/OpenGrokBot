import type { Context, Hono } from 'hono'
import type { Db } from '../db.js'
import type { Hub } from '../hub.js'
import { validApiKey } from '../settings.js'
import { CATALOG, catalogByApp, isAppKey } from './catalog.js'
import { composioKeyView, resolveComposioKey, saveComposioKey } from './keys.js'
import { createPendingOAuthStore } from './oauth-pendings.js'
import {
  activateConnectorAccount,
  createConnectorAccount,
  deleteConnectorAccount,
  getConnectorAccount,
  listAllBotGrants,
  listConnectorAccounts,
  markConnectorStatus,
  setBotConnectors,
  setConnectorBots,
} from './store.js'
import {
  ConnectorDriverError,
  type AppKey,
  type CatalogApp,
  type ConnectorDriver,
  type ConnectorStatus,
} from './types.js'

export type ConnectorAccountView = {
  id: string
  app: AppKey
  accountLabel: string
  status: ConnectorStatus
  lastError: string
  createdAt: number
  updatedAt: number
}

export type ConnectorsSnapshot = {
  key: { set: boolean; masked: string; source: 'env' | 'file' | 'none'; locked: boolean }
  catalog: CatalogApp[]
  accounts: ConnectorAccountView[]
  botGrants: Record<string, string[]>
}

export type ConnectorsApiDeps = {
  db: Db
  dataDir: string
  env: Record<string, string | undefined>
  driver: ConnectorDriver
  hub: Hub
  now?: () => number
  allowedOrigins?: string[]
}

const OAUTH_HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
} as const

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function oauthHtmlResponse(
  c: Context,
  opts: { status: 200 | 404 | 502; title: string; detail: string; accent: 'ok' | 'warn' | 'err' },
): Response {
  const color = opts.accent === 'ok' ? '#15803d' : opts.accent === 'warn' ? '#b45309' : '#b91c1c'
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)} · OpenSuperBot</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; }
    main { max-width: 420px; padding: 28px 32px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06); }
    .badge { display: inline-block; font-size: 12px; font-weight: 600; color: ${color}; margin-bottom: 8px; letter-spacing: 0.02em; text-transform: uppercase; }
    h1 { margin: 0 0 10px; font-size: 19px; line-height: 1.35; }
    p { margin: 0; font-size: 14px; line-height: 1.55; color: #475569; }
  </style>
</head>
<body>
  <main>
    <div class="badge">OpenSuperBot</div>
    <h1>${escapeHtml(opts.title)}</h1>
    <p>${escapeHtml(opts.detail)}</p>
  </main>
</body>
</html>`
  return c.body(html, opts.status, OAUTH_HTML_HEADERS)
}

function effectivePort(u: URL): string {
  if (u.port) return u.port
  return u.protocol === 'https:' ? '443' : '80'
}

function sameHost(a: URL, b: URL): boolean {
  const loopback = (h: string) => (['127.0.0.1', '[::1]', '::1'].includes(h) ? 'localhost' : h)
  return loopback(a.hostname) === loopback(b.hostname) && effectivePort(a) === effectivePort(b)
}

function requestOrigin(c: Context, allowedOrigins: string[] = []): string {
  const reqUrl = new URL(c.req.url)
  const parsedAllowed = allowedOrigins.flatMap((a) => {
    try {
      const u = new URL(a)
      return u.protocol === 'http:' || u.protocol === 'https:' ? [u] : []
    } catch {
      return []
    }
  })
  const trustHttps = parsedAllowed.some((u) => u.protocol === 'https:')
  const forwardedHttps = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https'
  const scheme = reqUrl.protocol === 'https:' || (trustHttps && forwardedHttps) ? 'https' : 'http'

  let self = reqUrl
  const host = c.req.header('host')?.trim()
  if (host) {
    try {
      const candidate = new URL(`${scheme}://${host}`)
      if (!candidate.username && !candidate.password && candidate.pathname === '/' && !candidate.search && !candidate.hash) {
        self = candidate
      }
    } catch { /* fallback to reqUrl */ }
  }

  const originHeader = c.req.header('origin')?.trim()
  if (originHeader) {
    try {
      const from = new URL(originHeader)
      if ((from.protocol === 'http:' || from.protocol === 'https:') && !from.username && !from.password) {
        if (sameHost(from, self) && (self.protocol !== 'https:' || from.protocol === 'https:')) {
          return from.origin
        }
        if (parsedAllowed.some((allowed) => sameHost(from, allowed) && (allowed.protocol !== 'https:' || from.protocol === 'https:'))) {
          return from.origin
        }
      }
    } catch { /* fallback to self */ }
  }

  return self.origin
}

function driverErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof ConnectorDriverError) {
    switch (err.code) {
      case 'unconfigured':
      case 'bad_request':
        return c.json({ error: err.message, code: err.code }, 400)
      case 'auth_expired':
        return c.json({ error: err.message, code: 'auth_expired' }, 422)
      case 'rate_limited':
        return c.json({ error: err.message, code: 'rate_limited' }, 429)
      case 'timeout':
        return c.json({ error: err.message, code: 'timeout' }, 504)
      case 'upstream':
        return c.json({ error: err.message, code: 'upstream' }, 502)
    }
  }
  return c.json({ error: err instanceof Error ? err.message : 'connector driver error', code: 'upstream' }, 502)
}

export function mountConnectors(app: Hono, deps: ConnectorsApiDeps): void {
  const { db, dataDir, env, driver, hub } = deps
  const clock = deps.now ?? Date.now
  const allowedOrigins = deps.allowedOrigins ?? []
  const pendings = createPendingOAuthStore({ now: clock })

  const isConfigured = (): boolean => driver.configured() || composioKeyView(env, dataDir).set

  const snapshot = (): ConnectorsSnapshot => ({
    key: composioKeyView(env, dataDir),
    catalog: [...CATALOG],
    accounts: listConnectorAccounts(db).map((row) => ({
      id: row.id,
      app: row.app,
      accountLabel: row.account_label,
      status: row.status,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    botGrants: listAllBotGrants(db),
  })

  app.get('/api/connectors', (c) => c.json(snapshot()))

  app.put('/api/connectors/key', async (c) => {
    if (composioKeyView(env, dataDir).locked) {
      return c.json({ error: 'locked' }, 409)
    }
    if (!dataDir) {
      return c.json({ error: 'data directory is not configured' }, 409)
    }
    const body = await c.req.json().catch(() => null)
    if (!isObject(body) || (body.apiKey !== null && typeof body.apiKey !== 'string')) {
      return c.json({ error: 'invalid_key', code: 'invalid' }, 400)
    }
    const trimmed = body.apiKey === null ? '' : body.apiKey.trim()
    if (trimmed) {
      if (!validApiKey(trimmed)) {
        return c.json({ error: 'invalid_key', code: 'invalid' }, 400)
      }
      let res: Awaited<ReturnType<ConnectorDriver['testKey']>>
      try {
        res = await driver.testKey(trimmed)
      } catch (err) {
        return c.json({
          error: 'invalid_key',
          code: 'network_error',
          detail: err instanceof Error ? err.message : String(err),
        }, 400)
      }
      if (!res.ok) {
        return c.json({
          error: 'invalid_key',
          code: res.code,
          ...(res.detail !== undefined ? { detail: res.detail } : {}),
        }, 400)
      }
    }
    saveComposioKey(dataDir, trimmed)
    hub.broadcast({ type: 'connectors_changed' })
    return c.json(snapshot())
  })

  app.post('/api/connectors/key/test', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) {
      return c.json({ error: 'invalid request body' }, 400)
    }
    try {
      if (body.apiKey !== undefined) {
        if (typeof body.apiKey !== 'string') {
          return c.json({ error: 'apiKey must be a string' }, 400)
        }
        const trimmed = body.apiKey.trim()
        if (!trimmed) return c.json({ ok: false, code: 'unconfigured' })
        if (!validApiKey(trimmed)) return c.json({ ok: false, code: 'invalid' })
        return c.json(await driver.testKey(trimmed))
      }
      const savedKey = resolveComposioKey(env, dataDir).key
      if (!savedKey && !driver.configured()) {
        return c.json({ ok: false, code: 'unconfigured' })
      }
      return c.json(await driver.testKey(savedKey || undefined))
    } catch (err) {
      return c.json({
        ok: false,
        code: 'network_error',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  app.post('/api/connectors/connect', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) {
      return c.json({ error: 'invalid request body' }, 400)
    }
    if (!isAppKey(body.app)) {
      return c.json({ error: 'unknown connector app', code: 'invalid_app' }, 400)
    }
    if (body.botIds !== undefined && (!Array.isArray(body.botIds) || !body.botIds.every((id) => typeof id === 'string'))) {
      return c.json({ error: 'botIds must be an array of strings', code: 'invalid_bots' }, 400)
    }
    if (!isConfigured()) {
      return c.json({ error: 'Composio API key is not configured', code: 'unconfigured' }, 400)
    }

    let nonce: string
    try {
      nonce = pendings.mint()
    } catch (err) {
      return c.json({
        error: err instanceof Error ? err.message : 'too many connector authorizations in progress',
        code: 'too_many_pending',
      }, 429)
    }

    const callbackUrl = `${requestOrigin(c, allowedOrigins)}/oauth/connector/${nonce}`
    let started: { authConfigId: string; remoteId: string; redirectUrl: string }
    try {
      started = await driver.startOAuth({ app: body.app, callbackUrl, userKey: 'opensuperbot' })
    } catch (err) {
      return driverErrorResponse(c, err)
    }
    if (!isHttpUrl(started.redirectUrl)) {
      return c.json({ error: 'invalid OAuth redirect URL from upstream', code: 'upstream' }, 502)
    }

    const at = clock()
    const row = createConnectorAccount(db, {
      app: body.app,
      driver: driver.id,
      remoteId: started.remoteId,
      authConfigId: started.authConfigId,
      status: 'pending',
      now: at,
    })
    if (body.botIds?.length) {
      setConnectorBots(db, row.id, body.botIds, at)
    }
    pendings.put(nonce, {
      connectorId: row.id,
      app: body.app,
      candidateRemoteId: started.remoteId,
      authConfigId: started.authConfigId,
    })
    hub.broadcast({ type: 'connectors_changed' })
    return c.json({
      connectorId: row.id,
      redirectUrl: started.redirectUrl,
      callbackUrl,
      state: snapshot(),
    }, 201)
  })

  app.post('/api/connectors/:id/reconnect', async (c) => {
    const current = getConnectorAccount(db, c.req.param('id'))
    if (!current) {
      return c.json({ error: 'unknown connector', code: 'not_found' }, 404)
    }
    if (!isConfigured()) {
      return c.json({ error: 'Composio API key is not configured', code: 'unconfigured' }, 400)
    }

    let nonce: string
    try {
      nonce = pendings.mint()
    } catch (err) {
      return c.json({
        error: err instanceof Error ? err.message : 'too many connector authorizations in progress',
        code: 'too_many_pending',
      }, 429)
    }

    const callbackUrl = `${requestOrigin(c, allowedOrigins)}/oauth/connector/${nonce}`
    let started: { authConfigId: string; remoteId: string; redirectUrl: string }
    try {
      started = await driver.startOAuth({ app: current.app, callbackUrl, userKey: 'opensuperbot' })
    } catch (err) {
      return driverErrorResponse(c, err)
    }
    if (!isHttpUrl(started.redirectUrl)) {
      return c.json({ error: 'invalid OAuth redirect URL from upstream', code: 'upstream' }, 502)
    }

    pendings.put(nonce, {
      connectorId: current.id,
      app: current.app,
      candidateRemoteId: started.remoteId,
      authConfigId: started.authConfigId,
      ...(current.remote_id ? { previousRemoteId: current.remote_id } : {}),
    })
    return c.json({
      connectorId: current.id,
      redirectUrl: started.redirectUrl,
      callbackUrl,
    })
  })

  app.post('/api/connectors/:id/refresh', async (c) => {
    const row = getConnectorAccount(db, c.req.param('id'))
    if (!row) {
      return c.json({ error: 'unknown connector', code: 'not_found' }, 404)
    }
    if (!isConfigured()) {
      return c.json({ error: 'Composio API key is not configured', code: 'unconfigured' }, 400)
    }

    let inspected: { status: ConnectorStatus; accountLabel: string }
    try {
      inspected = await driver.inspectAccount({ app: row.app, remoteId: row.remote_id })
    } catch (err) {
      return driverErrorResponse(c, err)
    }

    const at = clock()
    if (inspected.status === 'active') {
      const appName = catalogByApp(row.app)?.name ?? row.app
      activateConnectorAccount(
        db,
        row.id,
        {
          remoteId: row.remote_id,
          accountLabel: inspected.accountLabel || row.account_label || `${appName} (${row.remote_id.slice(0, 8)})`,
        },
        at,
      )
    } else {
      const lastError = inspected.status === 'expired'
        ? 'authorization expired'
        : inspected.status === 'failed'
          ? 'connection failed'
          : row.last_error
      markConnectorStatus(db, row.id, inspected.status, lastError, at)
    }
    hub.broadcast({ type: 'connectors_changed' })
    return c.json(snapshot())
  })

  app.delete('/api/connectors/:id', async (c) => {
    const id = c.req.param('id')
    const row = getConnectorAccount(db, id)
    if (!row) {
      return c.json({ error: 'unknown connector', code: 'not_found' }, 404)
    }
    if (row.remote_id) {
      await driver.revokeAccount({ remoteId: row.remote_id }).catch(() => {})
    }
    deleteConnectorAccount(db, id)
    hub.broadcast({ type: 'connectors_changed' })
    return c.json(snapshot())
  })

  app.put('/api/bots/:botId/connectors', async (c) => {
    const botId = c.req.param('botId')
    const exists = db.prepare('SELECT 1 FROM bots WHERE id = ?').get(botId)
    if (!exists) {
      return c.json({ error: 'unknown bot' }, 404)
    }
    const body = await c.req.json().catch(() => null)
    if (!isObject(body) || !Array.isArray(body.connectorIds) || !body.connectorIds.every((id) => typeof id === 'string')) {
      return c.json({ error: 'connectorIds must be an array of strings', code: 'invalid_connectors' }, 400)
    }
    const updated = setBotConnectors(db, botId, body.connectorIds, clock())
    hub.broadcast({ type: 'connectors_changed' })
    return c.json({ botId, connectorIds: updated })
  })

  app.get('/oauth/connector/:nonce', async (c) => {
    const pending = pendings.consume(c.req.param('nonce') ?? '')
    if (!pending) {
      return oauthHtmlResponse(c, {
        status: 404,
        title: 'Authorization link expired or already used',
        detail: 'Return to OpenSuperBot and start the connection again if needed.',
        accent: 'err',
      })
    }

    const existing = getConnectorAccount(db, pending.connectorId)
    if (!existing) {
      await driver.revokeAccount({ remoteId: pending.candidateRemoteId }).catch(() => {})
      return oauthHtmlResponse(c, {
        status: 404,
        title: 'Connector was removed',
        detail: 'This connector is no longer present in OpenSuperBot.',
        accent: 'err',
      })
    }

    let inspected: { status: ConnectorStatus; accountLabel: string }
    try {
      inspected = await driver.inspectAccount({ app: pending.app, remoteId: pending.candidateRemoteId })
    } catch (err) {
      if (!pending.previousRemoteId) {
        markConnectorStatus(
          db,
          pending.connectorId,
          'failed',
          err instanceof Error ? err.message : 'authorization check failed',
          clock(),
        )
        hub.broadcast({ type: 'connectors_changed' })
      }
      return oauthHtmlResponse(c, {
        status: 502,
        title: 'Could not verify authorization',
        detail: 'OpenSuperBot could not reach the connector service. Return to OpenSuperBot and try again.',
        accent: 'err',
      })
    }

    const appName = catalogByApp(pending.app)?.name ?? pending.app
    if (inspected.status === 'active') {
      const accountLabel = inspected.accountLabel || `${appName} (${pending.candidateRemoteId.slice(0, 8)})`
      activateConnectorAccount(
        db,
        pending.connectorId,
        {
          remoteId: pending.candidateRemoteId,
          accountLabel,
          authConfigId: pending.authConfigId,
        },
        clock(),
      )
      if (pending.previousRemoteId && pending.previousRemoteId !== pending.candidateRemoteId) {
        const toRevoke = new Set(
          [pending.previousRemoteId, existing.remote_id].filter(
            (r): r is string => Boolean(r) && r !== pending.candidateRemoteId,
          ),
        )
        for (const remoteId of toRevoke) {
          await driver.revokeAccount({ remoteId }).catch(() => {})
        }
      }
      hub.broadcast({ type: 'connectors_changed' })
      return oauthHtmlResponse(c, {
        status: 200,
        title: `${appName} connected`,
        detail: `Signed in as ${accountLabel}. You can close this tab and return to OpenSuperBot.`,
        accent: 'ok',
      })
    }

    if (!pending.previousRemoteId) {
      markConnectorStatus(db, pending.connectorId, inspected.status, 'authorization was not completed', clock())
    }
    hub.broadcast({ type: 'connectors_changed' })
    return oauthHtmlResponse(c, {
      status: 200,
      title: 'Authorization not completed',
      detail: `${appName} was not authorized. Return to OpenSuperBot if you want to try again.`,
      accent: 'warn',
    })
  })
}
