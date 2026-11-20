import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  buildSecretRedactor,
  isRecord,
  isValidInitializeResult,
  normalizeMcpCallResult,
  paginateMcpTools,
  type McpSession,
} from './stdio-transport.js'
import { McpCallError, type McpCallResult, type McpDiscoveredTool } from './types.js'

export type { McpSession } from './stdio-transport.js'

const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024
const MAX_ERROR_SNIPPET_BYTES = 4 * 1024
const DELETE_TIMEOUT_MS = 3_000

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FORBIDDEN_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'accept',
  'content-type',
  'mcp-session-id',
])

export type HttpSessionOptions = {
  url: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  redact?: (text: string) => string
  onToolsChanged?: () => void
  handshakeTimeoutMs?: number
  callTimeoutMs?: number
}

export function validateMcpHttpConfig(
  url: string,
  headers: Record<string, string>,
): { url: URL; headers: Record<string, string> } {
  const rawUrl = typeof url === 'string' ? url.trim() : ''
  if (!rawUrl || rawUrl.includes('\0')) {
    throw new McpCallError('connect_failed', 'MCP HTTP URL must be a non-empty string', false)
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new McpCallError('connect_failed', 'Invalid MCP HTTP URL', false)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpCallError('connect_failed', `Unsupported MCP HTTP protocol: ${parsed.protocol}`, false)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new McpCallError('connect_failed', 'MCP HTTP URL must not include username or password', false)
  }

  const cleanHeaders: Record<string, string> = {}
  const seenLower = new Set<string>()
  for (const [rawName, val] of Object.entries(headers ?? {})) {
    const name = rawName.trim()
    if (!name || !HEADER_NAME_RE.test(name)) {
      throw new McpCallError('connect_failed', `Invalid custom HTTP header name: ${rawName}`, false)
    }
    const lower = name.toLowerCase()
    if (FORBIDDEN_HEADER_NAMES.has(lower)) {
      throw new McpCallError('connect_failed', `Forbidden custom HTTP header: ${name}`, false)
    }
    if (seenLower.has(lower)) {
      throw new McpCallError('connect_failed', `Duplicate custom HTTP header: ${name}`, false)
    }
    if (typeof val !== 'string' || /[\r\n\0]/.test(val)) {
      throw new McpCallError('connect_failed', `Invalid custom HTTP header value for ${name}`, false)
    }
    seenLower.add(lower)
    cleanHeaders[name] = val
  }

  return { url: parsed, headers: cleanHeaders }
}

function createRequestAbort(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let didTimeout = false

  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason ?? new Error('aborted'))
  }

  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort(new Error('timeout'))
  }, timeoutMs)
  timer.unref?.()

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer)
      controller.abort(externalSignal.reason ?? new Error('aborted'))
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
    timedOut: () => didTimeout,
  }
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = 'name' in err ? String((err as { name?: unknown }).name) : ''
  return name === 'AbortError' || name === 'TimeoutError'
}

async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let totalBytes = 0
  let out = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new Error(`MCP HTTP response exceeded ${maxBytes} byte limit`)
        }
        out += decoder.decode(value, { stream: true })
      }
    }
    out += decoder.decode()
    return out
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

type SseEvent = {
  event: string
  data: string
}

async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  opts: {
    maxTotalBytes?: number
    maxEventBytes: number
    onEvent: (ev: SseEvent) => boolean | void | Promise<boolean | void>
  },
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let totalBytes = 0
  let lineBuffer = ''
  let eventType = ''
  let dataLines: string[] = []
  let eventBytes = 0

  const flushEvent = async (): Promise<boolean> => {
    if (dataLines.length === 0 && eventType === '') return false
    const ev: SseEvent = {
      event: eventType || 'message',
      data: dataLines.join('\n'),
    }
    eventType = ''
    dataLines = []
    eventBytes = 0
    return (await opts.onEvent(ev)) === true
  }

  const processLine = async (rawLine: string): Promise<boolean> => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      return flushEvent()
    }
    if (line.startsWith(':')) {
      return false
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const rawVal = colon === -1 ? '' : line.slice(colon + 1)
    const val = rawVal.startsWith(' ') ? rawVal.slice(1) : rawVal

    if (field === 'event') {
      eventType = val
    } else if (field === 'data') {
      eventBytes += Buffer.byteLength(val, 'utf8') + 1
      if (eventBytes > opts.maxEventBytes) {
        throw new Error(`MCP SSE event exceeded ${opts.maxEventBytes} byte limit`)
      }
      dataLines.push(val)
    }
    return false
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      totalBytes += value.byteLength
      if (opts.maxTotalBytes !== undefined && totalBytes > opts.maxTotalBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`MCP SSE stream exceeded ${opts.maxTotalBytes} byte limit`)
      }

      lineBuffer += decoder.decode(value, { stream: true })
      if (Buffer.byteLength(lineBuffer, 'utf8') > opts.maxEventBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`MCP SSE line exceeded ${opts.maxEventBytes} byte limit`)
      }

      for (;;) {
        const nl = lineBuffer.indexOf('\n')
        if (nl === -1) break
        const line = lineBuffer.slice(0, nl)
        lineBuffer = lineBuffer.slice(nl + 1)
        const shouldStop = await processLine(line)
        if (shouldStop) {
          await reader.cancel().catch(() => {})
          return
        }
      }
    }

    lineBuffer += decoder.decode()
    if (lineBuffer.length > 0) {
      const trailingLines = lineBuffer.split(/\r?\n/)
      lineBuffer = ''
      for (const line of trailingLines) {
        const shouldStop = await processLine(line)
        if (shouldStop) return
      }
    }
    await flushEvent()
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

function isJsonRpcEnvelope(val: unknown): val is Record<string, unknown> {
  return isRecord(val) && val.jsonrpc === '2.0' && ('result' in val || 'error' in val)
}

function extractRpcErrorMessage(errField: unknown): string {
  if (isRecord(errField) && typeof errField.message === 'string' && errField.message.trim()) {
    return errField.message.trim()
  }
  return 'MCP JSON-RPC error'
}

type PendingLegacyRequest = {
  id: number
  write: boolean
  dispatched: boolean
  resolve: (val: unknown) => void
  reject: (err: McpCallError) => void
  cleanup: () => void
}

async function connectLegacySse(params: {
  baseUrl: URL
  customHeaders: Record<string, string>
  fetchImpl: typeof fetch
  redact: (text: string) => string
  onToolsChanged?: () => void
  handshakeTimeoutMs: number
  callTimeoutMs: number
}): Promise<McpSession> {
  const { baseUrl, customHeaders, fetchImpl, redact, onToolsChanged, handshakeTimeoutMs, callTimeoutMs } = params

  const sseAbort = new AbortController()
  let healthy = true
  let closed = false
  let nextId = 0
  let endpointUrl: URL | null = null
  const pending = new Map<number | string, PendingLegacyRequest>()

  let handshakeTimedOut = false
  const handshakeDeadline = Date.now() + handshakeTimeoutMs
  const handshakeTimer = setTimeout(() => {
    handshakeTimedOut = true
    healthy = false
    sseAbort.abort(new Error('handshake timeout'))
  }, handshakeTimeoutMs)
  handshakeTimer.unref?.()

  let resolveEndpoint!: (url: URL) => void
  let rejectEndpoint!: (err: McpCallError) => void
  let endpointSettled = false
  const endpointPromise = new Promise<URL>((resolve, reject) => {
    resolveEndpoint = (url) => {
      if (endpointSettled) return
      endpointSettled = true
      resolve(url)
    }
    rejectEndpoint = (err) => {
      if (endpointSettled) return
      endpointSettled = true
      reject(err)
    }
  })

  const rejectAllPending = (reason: string): void => {
    const entries = [...pending.values()]
    pending.clear()
    for (const entry of entries) {
      entry.cleanup()
      if (entry.write && entry.dispatched) {
        entry.reject(new McpCallError('uncertain_write', redact(`${reason} after write dispatch`), true))
      } else {
        entry.reject(
          new McpCallError(handshakeTimedOut ? 'timeout' : 'connect_failed', redact(reason), false),
        )
      }
    }
  }

  const sendBestEffortReply = (payload: Record<string, unknown>): void => {
    if (!endpointUrl || closed) return
    const abort = createRequestAbort(5_000)
    void fetchImpl(endpointUrl.href, {
      method: 'POST',
      headers: { ...customHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abort.signal,
    })
      .catch(() => {})
      .finally(() => abort.cleanup())
  }

  const handleIncomingRpcObject = (msg: Record<string, unknown>): void => {
    if (msg.jsonrpc !== '2.0') return
    const hasMethod = typeof msg.method === 'string' && msg.method.length > 0
    const hasId = 'id' in msg && (typeof msg.id === 'number' || typeof msg.id === 'string')

    if (hasMethod && hasId) {
      if (msg.method === 'ping') {
        sendBestEffortReply({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else {
        sendBestEffortReply({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${String(msg.method)}` },
        })
      }
      return
    }

    if (hasMethod && !hasId) {
      if (msg.method === 'notifications/tools/list_changed') {
        try {
          onToolsChanged?.()
        } catch {
          // ignore
        }
      }
      return
    }

    if (hasId && !hasMethod) {
      const entry = pending.get(msg.id as number | string)
      if (!entry) return
      pending.delete(msg.id as number | string)
      entry.cleanup()
      if (isRecord(msg.error)) {
        entry.reject(new McpCallError('protocol_error', redact(extractRpcErrorMessage(msg.error)), false))
      } else if ('result' in msg) {
        entry.resolve(msg.result)
      } else {
        entry.reject(new McpCallError('protocol_error', 'Malformed MCP JSON-RPC response on SSE stream', false))
      }
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    healthy = false
    clearTimeout(handshakeTimer)
    sseAbort.abort()
    rejectAllPending('MCP legacy SSE session closed')
  }

  try {
    let getRes: Response
    try {
      getRes = await fetchImpl(baseUrl.href, {
        method: 'GET',
        headers: {
          ...customHeaders,
          Accept: 'text/event-stream',
        },
        signal: sseAbort.signal,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new McpCallError(
        handshakeTimedOut || isAbortLikeError(err) ? 'timeout' : 'connect_failed',
        redact(`MCP legacy SSE GET failed: ${msg}`),
        false,
      )
    }

    if (!getRes.ok || !getRes.body) {
      const snippet = await readBoundedText(getRes.body, MAX_ERROR_SNIPPET_BYTES).catch(() => '')
      const suffix = snippet.trim() ? `: ${snippet.trim()}` : ''
      throw new McpCallError(
        'connect_failed',
        redact(`MCP legacy SSE GET returned HTTP ${getRes.status}${suffix}`),
        false,
      )
    }

    // Background SSE reader loop
    void consumeSseStream(getRes.body, {
      maxEventBytes: MAX_HTTP_BODY_BYTES,
      onEvent: (ev) => {
        if (ev.event === 'endpoint') {
          let candidate: URL
          try {
            candidate = new URL(ev.data.trim(), baseUrl)
          } catch {
            healthy = false
            rejectEndpoint(new McpCallError('protocol_error', 'Invalid endpoint URL in MCP SSE event', false))
            sseAbort.abort()
            return true
          }

          if (
            (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') ||
            candidate.origin !== baseUrl.origin ||
            candidate.username !== '' ||
            candidate.password !== ''
          ) {
            healthy = false
            rejectEndpoint(
              new McpCallError(
                'connect_failed',
                `Cross-origin MCP SSE endpoint rejected (${candidate.origin} !== ${baseUrl.origin})`,
                false,
              ),
            )
            sseAbort.abort()
            return true
          }

          endpointUrl = candidate
          resolveEndpoint(candidate)
          return false
        }

        if (ev.event === 'message' || ev.event === '') {
          const trimmed = ev.data.trim()
          if (!trimmed) return false
          let parsed: unknown
          try {
            parsed = JSON.parse(trimmed)
          } catch {
            return false
          }
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (isRecord(item)) handleIncomingRpcObject(item)
            }
          } else if (isRecord(parsed)) {
            handleIncomingRpcObject(parsed)
          }
        }
        return false
      },
    })
      .then(() => {
        healthy = false
        if (!closed) {
          rejectEndpoint(new McpCallError('connect_failed', 'MCP SSE stream closed before endpoint event', false))
          rejectAllPending('MCP SSE stream closed unexpectedly')
        }
      })
      .catch((err) => {
        healthy = false
        if (!closed) {
          const msg = err instanceof Error ? err.message : String(err)
          rejectEndpoint(
            new McpCallError(
              handshakeTimedOut || isAbortLikeError(err) ? 'timeout' : 'connect_failed',
              redact(`MCP SSE stream error: ${msg}`),
              false,
            ),
          )
          rejectAllPending(`MCP SSE stream error: ${msg}`)
        }
      })

    const resolvedEndpoint = await endpointPromise

    const sendLegacyRequest = (
      method: string,
      reqParams: Record<string, unknown>,
      reqOpts: { write: boolean; timeoutMs: number; signal?: AbortSignal },
    ): Promise<unknown> => {
      if (closed || !healthy) {
        return Promise.reject(new McpCallError('connect_failed', 'MCP SSE session is disconnected', false))
      }
      if (reqOpts.signal?.aborted) {
        return Promise.reject(new McpCallError('timeout', 'MCP SSE request aborted before dispatch', false))
      }

      const id = ++nextId
      return new Promise<unknown>((resolve, reject) => {
        const reqAbort = createRequestAbort(reqOpts.timeoutMs, reqOpts.signal)
        const onSignalAbort = (): void => {
          const cur = pending.get(id)
          if (!cur) return
          pending.delete(id)
          cur.cleanup()
          if (cur.write && cur.dispatched) {
            cur.reject(
              new McpCallError(
                'uncertain_write',
                'MCP legacy SSE write call timed out or aborted after dispatch',
                true,
              ),
            )
          } else {
            cur.reject(new McpCallError('timeout', `MCP legacy SSE request timed out (${method})`, false))
          }
        }

        reqAbort.signal.addEventListener('abort', onSignalAbort, { once: true })

        const cleanup = (): void => {
          reqAbort.signal.removeEventListener('abort', onSignalAbort)
          reqAbort.cleanup()
        }

        const entry: PendingLegacyRequest = {
          id,
          write: reqOpts.write,
          dispatched: false,
          resolve,
          reject,
          cleanup,
        }
        pending.set(id, entry)

        void (async () => {
          let postRes: Response
          try {
            entry.dispatched = true
            postRes = await fetchImpl(resolvedEndpoint.href, {
              method: 'POST',
              headers: {
                ...customHeaders,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ jsonrpc: '2.0', id, method, params: reqParams }),
              signal: reqAbort.signal,
            })
          } catch (err) {
            const cur = pending.get(id)
            if (!cur) return
            pending.delete(id)
            cur.cleanup()
            const msg = err instanceof Error ? err.message : String(err)
            if (cur.write) {
              cur.reject(
                new McpCallError('uncertain_write', redact(`MCP SSE POST failed during write: ${msg}`), true),
              )
            } else if (reqAbort.timedOut() || isAbortLikeError(err)) {
              cur.reject(new McpCallError('timeout', `MCP SSE POST timed out (${method})`, false))
            } else {
              cur.reject(new McpCallError('connect_failed', redact(`MCP SSE POST failed: ${msg}`), false))
            }
            return
          }

          if (!postRes.ok) {
            const snippet = await readBoundedText(postRes.body, MAX_ERROR_SNIPPET_BYTES).catch(() => '')
            const cur = pending.get(id)
            if (!cur) return
            pending.delete(id)
            cur.cleanup()
            const suffix = snippet.trim() ? `: ${snippet.trim()}` : ''
            if (postRes.status >= 500 || postRes.status === 408) {
              if (cur.write) {
                cur.reject(
                  new McpCallError(
                    'uncertain_write',
                    redact(`MCP SSE POST HTTP ${postRes.status} during write${suffix}`),
                    true,
                  ),
                )
              } else {
                cur.reject(
                  new McpCallError('connect_failed', redact(`MCP SSE POST HTTP ${postRes.status}${suffix}`), false),
                )
              }
            } else {
              cur.reject(
                new McpCallError(
                  postRes.status === 401 || postRes.status === 403 || postRes.status === 404
                    ? 'connect_failed'
                    : 'protocol_error',
                  redact(`MCP SSE POST HTTP ${postRes.status}${suffix}`),
                  false,
                ),
              )
            }
            return
          }

          // Drain POST response body; if server returned inline JSON-RPC response, handle it too
          const ct = (postRes.headers.get('content-type') ?? '').toLowerCase()
          const bodyText = await readBoundedText(postRes.body, MAX_HTTP_BODY_BYTES).catch(() => '')
          if (ct.includes('application/json') && bodyText.trim()) {
            try {
              const parsed = JSON.parse(bodyText)
              if (isRecord(parsed)) handleIncomingRpcObject(parsed)
            } catch {
              // Response will arrive via SSE stream
            }
          }
        })()
      })
    }

    const remainingHandshakeMs = Math.max(1_000, handshakeDeadline - Date.now())
    const initResult = await sendLegacyRequest(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
      { write: false, timeoutMs: remainingHandshakeMs },
    )
    if (!isValidInitializeResult(initResult)) {
      throw new McpCallError('protocol_error', 'Invalid MCP initialize response from legacy SSE server', false)
    }

    const notifAbort = createRequestAbort(Math.max(1_000, handshakeDeadline - Date.now()))
    try {
      const notifRes = await fetchImpl(resolvedEndpoint.href, {
        method: 'POST',
        headers: {
          ...customHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: notifAbort.signal,
      })
      await readBoundedText(notifRes.body, MAX_ERROR_SNIPPET_BYTES).catch(() => '')
    } finally {
      notifAbort.cleanup()
    }

    clearTimeout(handshakeTimer)

    return {
      listTools(signal?: AbortSignal): Promise<McpDiscoveredTool[]> {
        return paginateMcpTools(
          (cursor, sig) =>
            sendLegacyRequest('tools/list', cursor ? { cursor } : {}, {
              write: false,
              timeoutMs: handshakeTimeoutMs,
              signal: sig,
            }),
          signal,
        )
      },
      async callTool(
        name: string,
        args: Record<string, unknown>,
        callOpts?: { write?: boolean; signal?: AbortSignal },
      ): Promise<McpCallResult> {
        const res = await sendLegacyRequest(
          'tools/call',
          { name, arguments: args },
          {
            write: callOpts?.write === true,
            timeoutMs: callTimeoutMs,
            signal: callOpts?.signal,
          },
        )
        return normalizeMcpCallResult(res)
      },
      close,
      isHealthy: () => healthy && !closed,
    }
  } catch (err) {
    await close()
    throw err
  }
}

export async function createHttpSession(opts: HttpSessionOptions): Promise<McpSession> {
  const { url: baseUrl, headers: customHeaders } = validateMcpHttpConfig(opts.url, opts.headers ?? {})
  const fetchImpl = opts.fetchImpl ?? fetch
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const redact = buildSecretRedactor(Object.values(customHeaders), opts.redact)

  let sessionId: string | null = null
  let healthy = true
  let closed = false
  let nextId = 0
  let reinitPromise: Promise<void> | null = null

  const buildPostHeaders = (): Record<string, string> => ({
    ...customHeaders,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  })

  const sendBestEffortPostReply = (payload: Record<string, unknown>): void => {
    if (closed) return
    const abort = createRequestAbort(5_000)
    void fetchImpl(baseUrl.href, {
      method: 'POST',
      headers: buildPostHeaders(),
      body: JSON.stringify(payload),
      signal: abort.signal,
    })
      .catch(() => {})
      .finally(() => abort.cleanup())
  }

  const parseStreamableResponse = async (
    res: Response,
    expectedId: number,
    write: boolean,
    reqAbort: { timedOut: () => boolean },
  ): Promise<unknown> => {
    const returnedSid = res.headers.get('mcp-session-id')?.trim()
    if (returnedSid) {
      sessionId = returnedSid
    }

    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (ct.includes('text/event-stream')) {
      if (!res.body) {
        throw new McpCallError(
          write ? 'uncertain_write' : 'protocol_error',
          'Empty MCP SSE response body',
          write,
        )
      }

      let matched = false
      let matchedResult: unknown
      let rpcErr: McpCallError | null = null

      try {
        await consumeSseStream(res.body, {
          maxTotalBytes: MAX_HTTP_BODY_BYTES,
          maxEventBytes: MAX_HTTP_BODY_BYTES,
          onEvent: (ev) => {
            if (ev.event !== 'message' && ev.event !== '') return false
            const trimmed = ev.data.trim()
            if (!trimmed) return false
            let parsed: unknown
            try {
              parsed = JSON.parse(trimmed)
            } catch {
              return false
            }
            const items = Array.isArray(parsed) ? parsed : [parsed]
            for (const item of items) {
              if (!isRecord(item) || item.jsonrpc !== '2.0') continue
              const hasMethod = typeof item.method === 'string' && item.method.length > 0
              const hasId = 'id' in item && (typeof item.id === 'number' || typeof item.id === 'string')

              if (hasMethod && hasId) {
                if (item.method === 'ping') {
                  sendBestEffortPostReply({ jsonrpc: '2.0', id: item.id, result: {} })
                } else {
                  sendBestEffortPostReply({
                    jsonrpc: '2.0',
                    id: item.id,
                    error: { code: -32601, message: `Method not found: ${String(item.method)}` },
                  })
                }
                continue
              }

              if (hasMethod && !hasId) {
                if (item.method === 'notifications/tools/list_changed') {
                  try {
                    opts.onToolsChanged?.()
                  } catch {
                    // ignore
                  }
                }
                continue
              }

              if (!hasMethod && (item.id === expectedId || (item.id === null && isRecord(item.error)))) {
                matched = true
                if (isRecord(item.error)) {
                  rpcErr = new McpCallError(
                    'protocol_error',
                    redact(extractRpcErrorMessage(item.error)),
                    false,
                  )
                } else if ('result' in item) {
                  matchedResult = item.result
                } else {
                  rpcErr = new McpCallError('protocol_error', 'Malformed MCP JSON-RPC SSE response', false)
                }
                return true
              }
            }
            return false
          },
        })
      } catch (err) {
        if (err instanceof McpCallError) throw err
        const msg = err instanceof Error ? err.message : String(err)
        if (write) {
          throw new McpCallError(
            'uncertain_write',
            redact(`MCP SSE stream interrupted after write dispatch: ${msg}`),
            true,
          )
        }
        if (reqAbort.timedOut() || isAbortLikeError(err)) {
          throw new McpCallError('timeout', 'MCP SSE stream timed out', false)
        }
        throw new McpCallError('protocol_error', redact(`MCP SSE stream failed: ${msg}`), false)
      }

      if (rpcErr) throw rpcErr
      if (!matched) {
        if (write) {
          throw new McpCallError(
            'uncertain_write',
            'MCP SSE stream ended before delivering write response',
            true,
          )
        }
        throw new McpCallError('protocol_error', 'MCP SSE stream ended without matching JSON-RPC response', false)
      }
      return matchedResult
    }

    // JSON response mode
    let bodyText: string
    try {
      bodyText = await readBoundedText(res.body, MAX_HTTP_BODY_BYTES)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (write) {
        throw new McpCallError(
          'uncertain_write',
          redact(`MCP HTTP body interrupted after write dispatch: ${msg}`),
          true,
        )
      }
      if (reqAbort.timedOut() || isAbortLikeError(err)) {
        throw new McpCallError('timeout', 'MCP HTTP response timed out', false)
      }
      throw new McpCallError('protocol_error', redact(`MCP HTTP response failed: ${msg}`), false)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      if (write) {
        throw new McpCallError(
          'uncertain_write',
          'MCP HTTP returned truncated or invalid JSON after write dispatch',
          true,
        )
      }
      throw new McpCallError('protocol_error', 'Invalid JSON in MCP HTTP response', false)
    }

    const items = Array.isArray(parsed) ? parsed : [parsed]
    for (const item of items) {
      if (!isRecord(item) || item.jsonrpc !== '2.0') continue
      if (item.method === 'notifications/tools/list_changed') {
        try {
          opts.onToolsChanged?.()
        } catch {
          // ignore
        }
        continue
      }
      if (item.id === expectedId || (item.id === null && isRecord(item.error))) {
        if (isRecord(item.error)) {
          throw new McpCallError('protocol_error', redact(extractRpcErrorMessage(item.error)), false)
        }
        if ('result' in item) {
          return item.result
        }
      }
    }

    if (write) {
      throw new McpCallError('uncertain_write', 'MCP HTTP response missing JSON-RPC result after write dispatch', true)
    }
    throw new McpCallError('protocol_error', 'Invalid MCP JSON-RPC response envelope', false)
  }

  const sendInitializedNotification = async (signal?: AbortSignal): Promise<void> => {
    const reqAbort = createRequestAbort(handshakeTimeoutMs, signal)
    try {
      const notifRes = await fetchImpl(baseUrl.href, {
        method: 'POST',
        headers: buildPostHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: reqAbort.signal,
      })
      const returnedSid = notifRes.headers.get('mcp-session-id')?.trim()
      if (returnedSid) {
        sessionId = returnedSid
      }
      if (!notifRes.ok) {
        const snippet = await readBoundedText(notifRes.body, MAX_ERROR_SNIPPET_BYTES).catch(() => '')
        const suffix = snippet.trim() ? `: ${snippet.trim()}` : ''
        throw new McpCallError(
          'connect_failed',
          redact(`MCP notifications/initialized failed with HTTP ${notifRes.status}${suffix}`),
          false,
        )
      }
      await readBoundedText(notifRes.body, MAX_ERROR_SNIPPET_BYTES).catch(() => '')
    } catch (err) {
      if (err instanceof McpCallError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new McpCallError(
        reqAbort.timedOut() || isAbortLikeError(err) ? 'timeout' : 'connect_failed',
        redact(`MCP notifications/initialized failed: ${msg}`),
        false,
      )
    } finally {
      reqAbort.cleanup()
    }
  }

  const runStreamableInitialize = async (allowLegacyFallback: boolean): Promise<'streamable' | McpSession> => {
    const initId = ++nextId
    const reqAbort = createRequestAbort(handshakeTimeoutMs)
    let res: Response
    try {
      res = await fetchImpl(baseUrl.href, {
        method: 'POST',
        headers: buildPostHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: initId,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: MCP_CLIENT_INFO,
          },
        }),
        signal: reqAbort.signal,
      })
    } catch (err) {
      reqAbort.cleanup()
      const msg = err instanceof Error ? err.message : String(err)
      throw new McpCallError(
        reqAbort.timedOut() || isAbortLikeError(err) ? 'timeout' : 'connect_failed',
        redact(`MCP HTTP initialize failed: ${msg}`),
        false,
      )
    }

    try {
      if (allowLegacyFallback && (res.status === 400 || res.status === 404 || res.status === 405)) {
        const bodyText = await readBoundedText(res.body, 64 * 1024).catch(() => '')
        let parsed: unknown = null
        if (bodyText.trim()) {
          try {
            parsed = JSON.parse(bodyText)
          } catch {
            parsed = null
          }
        }
        if (isJsonRpcEnvelope(parsed)) {
          if (isRecord(parsed.error)) {
            throw new McpCallError('protocol_error', redact(extractRpcErrorMessage(parsed.error)), false)
          }
        } else {
          reqAbort.cleanup()
          return await connectLegacySse({
            baseUrl,
            customHeaders,
            fetchImpl,
            redact,
            onToolsChanged: opts.onToolsChanged,
            handshakeTimeoutMs,
            callTimeoutMs,
          })
        }
      }

      if (!res.ok) {
        const snippet = await readBoundedText(res.body, MAX_ERROR_SNIPPET_BYTES).catch(() => '')
        const suffix = snippet.trim() ? `: ${snippet.trim()}` : ''
        throw new McpCallError(
          'connect_failed',
          redact(`MCP HTTP initialize failed with HTTP ${res.status}${suffix}`),
          false,
        )
      }

      const initResult = await parseStreamableResponse(res, initId, false, reqAbort)
      if (!isValidInitializeResult(initResult)) {
        throw new McpCallError('protocol_error', 'Invalid MCP initialize response from HTTP server', false)
      }
    } finally {
      reqAbort.cleanup()
    }

    await sendInitializedNotification()
    healthy = true
    return 'streamable'
  }

  const reinitializeAfterSessionExpiry = (): Promise<void> => {
    reinitPromise ??= (async () => {
      try {
        sessionId = null
        await runStreamableInitialize(false)
      } catch (err) {
        healthy = false
        throw err
      } finally {
        reinitPromise = null
      }
    })()
    return reinitPromise
  }

  const initialOutcome = await runStreamableInitialize(true)
  if (initialOutcome !== 'streamable') {
    return initialOutcome
  }

  const sendStreamableRequest = async (
    method: string,
    reqParams: Record<string, unknown>,
    reqOpts: { write: boolean; timeoutMs: number; signal?: AbortSignal },
    allow404Retry = true,
  ): Promise<unknown> => {
    if (closed) {
      throw new McpCallError('connect_failed', 'MCP HTTP session is closed', false)
    }
    if (reqOpts.signal?.aborted) {
      throw new McpCallError('timeout', 'MCP HTTP request aborted before dispatch', false)
    }

    const id = ++nextId
    const usedSessionId = sessionId
    const reqAbort = createRequestAbort(reqOpts.timeoutMs, reqOpts.signal)

    let res: Response
    try {
      res = await fetchImpl(baseUrl.href, {
        method: 'POST',
        headers: buildPostHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: reqParams }),
        signal: reqAbort.signal,
      })
    } catch (err) {
      reqAbort.cleanup()
      const msg = err instanceof Error ? err.message : String(err)
      if (reqOpts.write) {
        throw new McpCallError(
          'uncertain_write',
          redact(`MCP HTTP write request failed after dispatch: ${msg}`),
          true,
        )
      }
      if (reqAbort.timedOut() || isAbortLikeError(err)) {
        throw new McpCallError('timeout', `MCP HTTP request timed out (${method})`, false)
      }
      throw new McpCallError('connect_failed', redact(`MCP HTTP request failed: ${msg}`), false)
    }

    try {
      if (res.status === 404 && usedSessionId !== null) {
        await readBoundedText(res.body, MAX_ERROR_SNIPPET_BYTES).catch(() => '')
        if (sessionId === usedSessionId) {
          sessionId = null
        }
        if (!reqOpts.write && allow404Retry) {
          reqAbort.cleanup()
          await reinitializeAfterSessionExpiry()
          return await sendStreamableRequest(method, reqParams, reqOpts, false)
        }
        healthy = false
        throw new McpCallError('connect_failed', 'MCP HTTP session expired (HTTP 404)', false)
      }

      if (!res.ok) {
        const snippet = await readBoundedText(res.body, MAX_ERROR_SNIPPET_BYTES).catch(() => '')
        const suffix = snippet.trim() ? `: ${snippet.trim()}` : ''

        if (res.status >= 500 || res.status === 408) {
          if (reqOpts.write) {
            throw new McpCallError(
              'uncertain_write',
              redact(`MCP HTTP ${res.status} during write call${suffix}`),
              true,
            )
          }
          throw new McpCallError(
            res.status === 408 ? 'timeout' : 'connect_failed',
            redact(`MCP HTTP ${res.status}${suffix}`),
            false,
          )
        }

        if (res.status === 401 || res.status === 403) {
          healthy = false
        }
        const code =
          res.status === 401 || res.status === 403 || res.status === 404 ? 'connect_failed' : 'protocol_error'
        throw new McpCallError(code, redact(`MCP HTTP ${res.status}${suffix}`), false)
      }

      return await parseStreamableResponse(res, id, reqOpts.write, reqAbort)
    } finally {
      reqAbort.cleanup()
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    healthy = false
    const sid = sessionId
    sessionId = null
    if (sid) {
      const delAbort = createRequestAbort(DELETE_TIMEOUT_MS)
      try {
        const delRes = await fetchImpl(baseUrl.href, {
          method: 'DELETE',
          headers: {
            ...customHeaders,
            'Mcp-Session-Id': sid,
          },
          signal: delAbort.signal,
        })
        await readBoundedText(delRes.body, MAX_ERROR_SNIPPET_BYTES).catch(() => '')
      } catch {
        // Best-effort DELETE on disconnect
      } finally {
        delAbort.cleanup()
      }
    }
  }

  return {
    listTools(signal?: AbortSignal): Promise<McpDiscoveredTool[]> {
      return paginateMcpTools(
        (cursor, sig) =>
          sendStreamableRequest('tools/list', cursor ? { cursor } : {}, {
            write: false,
            timeoutMs: handshakeTimeoutMs,
            signal: sig,
          }),
        signal,
      )
    },
    async callTool(
      name: string,
      args: Record<string, unknown>,
      callOpts?: { write?: boolean; signal?: AbortSignal },
    ): Promise<McpCallResult> {
      const res = await sendStreamableRequest('tools/call', { name, arguments: args }, {
        write: callOpts?.write === true,
        timeoutMs: callTimeoutMs,
        signal: callOpts?.signal,
      })
      return normalizeMcpCallResult(res)
    },
    close,
    isHealthy: () => healthy && !closed,
  }
}
