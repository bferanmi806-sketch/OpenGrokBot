import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ConnectorDriverError,
  type ConnectorAccountRow,
  type ConnectorDriver,
  type ConnectorStatus,
  type FrozenExecution,
  type WriteExecutionResult,
} from './types.js'

export const DEFAULT_POLERY_ORIGIN = 'https://docs.polery.com'
const POLERY_SCOPES = 'mcp:read mcp:write offline_access'
const TOKEN_REFRESH_MARGIN_MS = 60_000
const FETCH_TIMEOUT_MS = 15_000

type StoredPoleryToken = {
  origin: string
  clientId: string
  clientSecret?: string
  tokenEndpoint: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  accountLabel: string
}

type PendingPoleryAuth = {
  origin: string
  clientId: string
  clientSecret?: string
  tokenEndpoint: string
  codeVerifier: string
  callbackUrl: string
  createdAt: number
}

export type PoleryToolCallResult = {
  text: string
  structured?: Record<string, unknown>
  isError: boolean
}

export type PoleryConnectorDriver = {
  readonly origin: string
  startOAuth(input: { callbackUrl: string }): Promise<{
    authConfigId: string
    remoteId: string
    redirectUrl: string
  }>
  completeOAuth(input: {
    remoteId: string
    code?: string
    error?: string
    errorDescription?: string
    callbackUrl: string
  }): Promise<{ status: ConnectorStatus; accountLabel: string; error?: string }>
  inspectAccount(remoteId: string): Promise<{ status: ConnectorStatus; accountLabel: string }>
  revokeAccount(remoteId: string): Promise<void>
  callTool(account: ConnectorAccountRow, toolName: string, args: Record<string, unknown>): Promise<PoleryToolCallResult>
  executeWrite(frozen: FrozenExecution): Promise<WriteExecutionResult>
}

export function resolvePoleryOrigin(env: Record<string, string | undefined>): string {
  const raw = env.OPENSUPERBOT_POLERY_ORIGIN?.trim()
  if (!raw) return DEFAULT_POLERY_ORIGIN
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin
    }
  } catch { /* fall back to default */ }
  return DEFAULT_POLERY_ORIGIN
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function parseJsonBody(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function createPoleryDriver(opts: {
  dataDir: string
  origin?: string
  fetchImpl?: typeof fetch
  now?: () => number
}): PoleryConnectorDriver {
  const origin = (opts.origin || DEFAULT_POLERY_ORIGIN).replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => Date.now())
  const tokenFile = opts.dataDir ? join(opts.dataDir, 'polery-tokens.json') : ''

  const memTokens = new Map<string, StoredPoleryToken>()
  const pendingAuths = new Map<string, PendingPoleryAuth>()

  const loadAll = (): Record<string, StoredPoleryToken> => {
    if (!tokenFile) return Object.fromEntries(memTokens.entries())
    if (!existsSync(tokenFile)) return {}
    try {
      const raw = JSON.parse(readFileSync(tokenFile, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, StoredPoleryToken>)
        : {}
    } catch {
      return {}
    }
  }

  const saveAll = (records: Record<string, StoredPoleryToken>): void => {
    if (!tokenFile) {
      memTokens.clear()
      for (const [k, v] of Object.entries(records)) memTokens.set(k, v)
      return
    }
    mkdirSync(dirname(tokenFile), { recursive: true })
    const tmp = `${tokenFile}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 })
    renameSync(tmp, tokenFile)
  }

  const getToken = (remoteId: string): StoredPoleryToken | null => loadAll()[remoteId] ?? null

  const putToken = (remoteId: string, token: StoredPoleryToken): void => {
    const all = loadAll()
    all[remoteId] = token
    saveAll(all)
  }

  const deleteToken = (remoteId: string): void => {
    const all = loadAll()
    if (!(remoteId in all)) return
    delete all[remoteId]
    saveAll(all)
  }

  const discoverMetadata = async (baseOrigin: string): Promise<{
    authorizationEndpoint: string
    tokenEndpoint: string
    registrationEndpoint: string
  }> => {
    const fallback = {
      authorizationEndpoint: `${baseOrigin}/oauth/authorize`,
      tokenEndpoint: `${baseOrigin}/oauth/token`,
      registrationEndpoint: `${baseOrigin}/oauth/register`,
    }
    try {
      const res = await fetchImpl(`${baseOrigin}/.well-known/oauth-authorization-server`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) return fallback
      const meta = parseJsonBody(await res.text())
      if (!meta) return fallback
      return {
        authorizationEndpoint: typeof meta.authorization_endpoint === 'string' ? meta.authorization_endpoint : fallback.authorizationEndpoint,
        tokenEndpoint: typeof meta.token_endpoint === 'string' ? meta.token_endpoint : fallback.tokenEndpoint,
        registrationEndpoint: typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : fallback.registrationEndpoint,
      }
    } catch {
      return fallback
    }
  }

  const registerClient = async (registrationEndpoint: string, callbackUrl: string): Promise<{
    clientId: string
    clientSecret?: string
  }> => {
    let res: Response
    try {
      res = await fetchImpl(registrationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'OpenSuperBot',
          redirect_uris: [callbackUrl],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: POLERY_SCOPES,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      throw new ConnectorDriverError(
        'upstream',
        `Could not reach Polery Docs OAuth server: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const body = parseJsonBody(await res.text())
    if (!res.ok || !body || typeof body.client_id !== 'string' || !body.client_id.trim()) {
      const detail = typeof body?.error_description === 'string'
        ? body.error_description
        : typeof body?.error === 'string'
          ? body.error
          : `HTTP ${res.status}`
      throw new ConnectorDriverError('upstream', `Polery Docs client registration failed: ${detail}`, res.status)
    }
    return {
      clientId: body.client_id.trim(),
      ...(typeof body.client_secret === 'string' && body.client_secret.trim()
        ? { clientSecret: body.client_secret.trim() }
        : {}),
    }
  }

  const refreshAccessToken = async (remoteId: string, stored: StoredPoleryToken): Promise<StoredPoleryToken> => {
    if (!stored.refreshToken) {
      throw new ConnectorDriverError('auth_expired', 'Polery Docs session expired; reconnect in Connectors.')
    }
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: stored.clientId,
      resource: `${stored.origin}/mcp`,
    })
    if (stored.clientSecret) params.set('client_secret', stored.clientSecret)
    let res: Response
    try {
      res = await fetchImpl(stored.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: params.toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      throw new ConnectorDriverError('upstream', `Polery Docs token refresh failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const body = parseJsonBody(await res.text())
    if (!res.ok || !body || typeof body.access_token !== 'string' || !body.access_token.trim()) {
      const errCode = typeof body?.error === 'string' ? body.error : `http_${res.status}`
      if (res.status === 400 || res.status === 401 || errCode === 'invalid_grant') {
        throw new ConnectorDriverError('auth_expired', `Polery Docs authorization expired (${errCode}).`, res.status)
      }
      throw new ConnectorDriverError('upstream', `Polery Docs token refresh error (${errCode}).`, res.status)
    }
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : 3000
    const updated: StoredPoleryToken = {
      ...stored,
      accessToken: body.access_token.trim(),
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token.trim()
        ? body.refresh_token.trim()
        : stored.refreshToken,
      expiresAt: now() + expiresIn * 1000,
    }
    putToken(remoteId, updated)
    return updated
  }

  const ensureValidToken = async (remoteId: string): Promise<StoredPoleryToken> => {
    const stored = getToken(remoteId)
    if (!stored) {
      throw new ConnectorDriverError('auth_expired', 'Polery Docs credentials are missing; reconnect in Connectors.')
    }
    if (stored.expiresAt && stored.expiresAt - now() <= TOKEN_REFRESH_MARGIN_MS) {
      return refreshAccessToken(remoteId, stored)
    }
    return stored
  }

  const rpcRequest = async (
    stored: StoredPoleryToken,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> => {
    let res: Response
    try {
      res = await fetchImpl(`${stored.origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${stored.accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomBytes(6).toString('hex'),
          method,
          params,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      throw new ConnectorDriverError('upstream', `Polery Docs request failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const text = await res.text()
    return { status: res.status, body: parseJsonBody(text) }
  }

  const invokeMcpTool = async (
    remoteId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<PoleryToolCallResult> => {
    let stored = await ensureValidToken(remoteId)
    let resp = await rpcRequest(stored, 'tools/call', { name: toolName, arguments: args })
    if (resp.status === 401 && stored.refreshToken) {
      stored = await refreshAccessToken(remoteId, stored)
      resp = await rpcRequest(stored, 'tools/call', { name: toolName, arguments: args })
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new ConnectorDriverError('auth_expired', 'Polery Docs rejected the access token; reconnect in Connectors.', resp.status)
    }
    if (resp.status >= 400 || !resp.body) {
      throw new ConnectorDriverError('upstream', `Polery Docs returned HTTP ${resp.status}.`, resp.status)
    }
    if (resp.body.error && typeof resp.body.error === 'object') {
      const errObj = resp.body.error as { message?: unknown }
      throw new ConnectorDriverError('upstream', typeof errObj.message === 'string' ? errObj.message : 'Polery MCP error')
    }
    const result = (resp.body.result ?? {}) as {
      content?: Array<{ type?: string; text?: string }>
      structuredContent?: Record<string, unknown>
      isError?: boolean
    }
    const text = (result.content ?? [])
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('\n')
      .trim()
    return {
      text: text || '(empty response from Polery Docs)',
      ...(result.structuredContent ? { structured: result.structuredContent } : {}),
      isError: result.isError === true,
    }
  }

  return {
    origin,

    async startOAuth({ callbackUrl }) {
      const meta = await discoverMetadata(origin)
      const client = await registerClient(meta.registrationEndpoint, callbackUrl)
      const { verifier, challenge } = makePkce()
      const remoteId = `polery_${randomBytes(6).toString('hex')}`

      // Prune stale pendings older than 15m
      const cutoff = now() - 15 * 60_000
      for (const [k, v] of pendingAuths) {
        if (v.createdAt < cutoff) pendingAuths.delete(k)
      }
      pendingAuths.set(remoteId, {
        origin,
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        tokenEndpoint: meta.tokenEndpoint,
        codeVerifier: verifier,
        callbackUrl,
        createdAt: now(),
      })

      const authUrl = new URL(meta.authorizationEndpoint)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', client.clientId)
      authUrl.searchParams.set('redirect_uri', callbackUrl)
      authUrl.searchParams.set('scope', POLERY_SCOPES)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('resource', `${origin}/mcp`)
      authUrl.searchParams.set('state', remoteId)

      return {
        authConfigId: origin,
        remoteId,
        redirectUrl: authUrl.toString(),
      }
    },

    async completeOAuth({ remoteId, code, error, errorDescription, callbackUrl }) {
      const pending = pendingAuths.get(remoteId)
      pendingAuths.delete(remoteId)
      if (error) {
        return {
          status: 'failed',
          accountLabel: '',
          error: errorDescription || error,
        }
      }
      if (!pending || !code) {
        return {
          status: 'failed',
          accountLabel: '',
          error: 'missing authorization code or expired handshake',
        }
      }

      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.callbackUrl || callbackUrl,
        client_id: pending.clientId,
        code_verifier: pending.codeVerifier,
        resource: `${pending.origin}/mcp`,
      })
      if (pending.clientSecret) params.set('client_secret', pending.clientSecret)

      let res: Response
      try {
        res = await fetchImpl(pending.tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: params.toString(),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      } catch (err) {
        throw new ConnectorDriverError(
          'upstream',
          `Could not exchange Polery Docs authorization code: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      const body = parseJsonBody(await res.text())
      if (!res.ok || !body || typeof body.access_token !== 'string' || !body.access_token.trim()) {
        const msg = typeof body?.error_description === 'string'
          ? body.error_description
          : typeof body?.error === 'string'
            ? body.error
            : `HTTP ${res.status}`
        return { status: 'failed', accountLabel: '', error: msg }
      }
      const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : 3000
      const hostLabel = new URL(pending.origin).hostname
      const tokenRecord: StoredPoleryToken = {
        origin: pending.origin,
        clientId: pending.clientId,
        ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        tokenEndpoint: pending.tokenEndpoint,
        accessToken: body.access_token.trim(),
        ...(typeof body.refresh_token === 'string' && body.refresh_token.trim()
          ? { refreshToken: body.refresh_token.trim() }
          : {}),
        expiresAt: now() + expiresIn * 1000,
        accountLabel: hostLabel,
      }
      putToken(remoteId, tokenRecord)
      return { status: 'active', accountLabel: hostLabel }
    },

    async inspectAccount(remoteId) {
      const stored = getToken(remoteId)
      if (!stored) return { status: 'expired', accountLabel: '' }
      try {
        const valid = await ensureValidToken(remoteId)
        const probe = await rpcRequest(valid, 'tools/list', {})
        if (probe.status === 401 || probe.status === 403) {
          return { status: 'expired', accountLabel: valid.accountLabel }
        }
        return { status: 'active', accountLabel: valid.accountLabel }
      } catch (err) {
        if (err instanceof ConnectorDriverError && err.code === 'auth_expired') {
          return { status: 'expired', accountLabel: stored.accountLabel }
        }
        throw err
      }
    },

    async revokeAccount(remoteId) {
      pendingAuths.delete(remoteId)
      deleteToken(remoteId)
    },

    async callTool(account, toolName, args) {
      return invokeMcpTool(account.remote_id, toolName, args)
    },

    async executeWrite(frozen) {
      const { tool, remoteId, args } = frozen
      if (tool !== 'polery_create_document' && tool !== 'polery_propose_edits') {
        return { status: 'failed', error: `Polery driver does not support ${tool}` }
      }
      const mcpTool = tool === 'polery_create_document' ? 'create_document' : 'propose_edits'
      try {
        const res = await invokeMcpTool(remoteId, mcpTool, args)
        if (res.isError) return { status: 'failed', error: res.text }
        return { status: 'succeeded', summary: res.text }
      } catch (err) {
        if (err instanceof ConnectorDriverError && err.code === 'auth_expired') {
          return { status: 'failed', error: err.message, authExpired: true }
        }
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

export function composeConnectorDriver(base: ConnectorDriver, polery: PoleryConnectorDriver): ConnectorDriver {
  return {
    get id() {
      return base.id
    },
    configured: () => base.configured(),
    testKey: (candidateKey) => base.testKey(candidateKey),
    startOAuth: (input) =>
      input.app === 'polery' ? polery.startOAuth({ callbackUrl: input.callbackUrl }) : base.startOAuth(input),
    completeOAuth: (input) =>
      input.app === 'polery'
        ? polery.completeOAuth(input)
        : base.completeOAuth
          ? base.completeOAuth(input)
          : base.inspectAccount({ app: input.app, remoteId: input.remoteId }),
    inspectAccount: (input) =>
      input.app === 'polery' ? polery.inspectAccount(input.remoteId) : base.inspectAccount(input),
    revokeAccount: (input) =>
      input.remoteId.startsWith('polery_') ? polery.revokeAccount(input.remoteId) : base.revokeAccount(input),
    listMail: (acc, opts) => base.listMail(acc, opts),
    readMail: (acc, sel) => base.readMail(acc, sel),
    createOrUpdateDraft: (acc, input) => base.createOrUpdateDraft(acc, input),
    listCalendarEvents: (acc, opts) => base.listCalendarEvents(acc, opts),
    searchNotion: (acc, opts) => base.searchNotion(acc, opts),
    readNotionPage: (acc, pageId) => base.readNotionPage(acc, pageId),
    listSlackChannels: (acc, opts) => base.listSlackChannels(acc, opts),
    readSlackMessages: (acc, opts) => base.readSlackMessages(acc, opts),
    callPoleryTool: (acc, toolName, args) => polery.callTool(acc, toolName, args),
    executeWrite: (frozen) =>
      frozen.app === 'polery' ? polery.executeWrite(frozen) : base.executeWrite(frozen),
  }
}
