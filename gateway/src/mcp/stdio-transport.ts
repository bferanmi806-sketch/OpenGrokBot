import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { McpCallError, type McpCallResult, type McpDiscoveredTool } from './types.js'

export const MCP_PROTOCOL_VERSION = '2025-03-26'
export const MCP_CLIENT_INFO = { name: 'OpenSuperBot', version: '0.6.1' } as const

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000
export const DEFAULT_CALL_TIMEOUT_MS = 30_000

const MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_STDERR_CHARS = 8 * 1024
const MAX_STDIO_ARGS = 64
const MAX_STDIO_ARG_CHARS = 4_096
const SIGTERM_GRACE_MS = 1_500

export const MAX_TOOL_PAGES = 10
export const MAX_TOOLS_PER_SERVER = 256
const MAX_TOOL_DESCRIPTION_CHARS = 1_000

const SAFE_STDIO_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SYSTEMROOT',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PATHEXT',
  'PROGRAMFILES',
] as const

const SAFE_STDIO_ENV_UPPER = new Set<string>(SAFE_STDIO_ENV_KEYS)

export type McpSession = {
  listTools(signal?: AbortSignal): Promise<McpDiscoveredTool[]>
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { write?: boolean; signal?: AbortSignal },
  ): Promise<McpCallResult>
  close(): Promise<void>
  isHealthy(): boolean
}

export type StdioSessionOptions = {
  command: string
  args?: readonly string[]
  cwd?: string
  hostEnv?: Record<string, string | undefined>
  serverEnv?: Record<string, string>
  redact?: (text: string) => string
  onToolsChanged?: () => void
  handshakeTimeoutMs?: number
  callTimeoutMs?: number
}

export function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

export function buildSecretRedactor(
  secretValues: readonly string[],
  upstream?: (text: string) => string,
): (text: string) => string {
  const candidates = new Set<string>()
  for (const raw of secretValues) {
    if (typeof raw !== 'string') continue
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
  return (text: string): string => {
    if (!text) return text
    let out = text
    for (const s of sorted) {
      out = out.split(s).join('[REDACTED]')
    }
    return upstream ? upstream(out) : out
  }
}

export function isValidInitializeResult(val: unknown): boolean {
  return isRecord(val) && typeof val.protocolVersion === 'string' && isRecord(val.capabilities)
}

export function normalizeMcpInputSchema(raw: unknown): Record<string, unknown> {
  const s = isRecord(raw) ? raw : {}
  const properties = isRecord(s.properties) ? { ...s.properties } : {}
  const required = Array.isArray(s.required)
    ? s.required.filter((item): item is string => typeof item === 'string')
    : undefined
  return {
    type: 'object',
    properties,
    ...(required !== undefined ? { required } : {}),
  }
}

export function normalizeMcpDiscoveredTool(raw: unknown): McpDiscoveredTool | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return null
  }
  const ann = isRecord(raw.annotations) ? raw.annotations : undefined
  const destructiveHint = ann?.destructiveHint === true
  const readOnlyHint = ann?.readOnlyHint === true && !destructiveHint
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, MAX_TOOL_DESCRIPTION_CHARS) : '',
    inputSchema: normalizeMcpInputSchema(raw.inputSchema),
    readOnlyHint,
    destructiveHint,
  }
}

export async function paginateMcpTools(
  fetchPage: (cursor?: string, signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<McpDiscoveredTool[]> {
  const tools: McpDiscoveredTool[] = []
  const seen = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    if (signal?.aborted) {
      throw new McpCallError('timeout', 'MCP tools/list aborted', false)
    }
    const res = await fetchPage(cursor, signal)
    if (!isRecord(res) || !Array.isArray(res.tools)) {
      throw new McpCallError('protocol_error', 'Invalid MCP tools/list response', false)
    }
    for (const item of res.tools) {
      const normalized = normalizeMcpDiscoveredTool(item)
      if (!normalized || seen.has(normalized.name)) continue
      seen.add(normalized.name)
      tools.push(normalized)
      if (tools.length >= MAX_TOOLS_PER_SERVER) {
        return tools
      }
    }
    const nextCursor = typeof res.nextCursor === 'string' && res.nextCursor.length > 0 ? res.nextCursor : undefined
    if (!nextCursor || nextCursor === cursor) break
    cursor = nextCursor
  }

  return tools
}

export function normalizeMcpCallResult(raw: unknown): McpCallResult {
  if (!isRecord(raw)) {
    throw new McpCallError('protocol_error', 'Invalid MCP tools/call response', false)
  }
  const content = Array.isArray(raw.content) ? raw.content.filter(isRecord) : []
  return {
    content,
    ...(raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent } : {}),
    ...(typeof raw.isError === 'boolean' ? { isError: raw.isError } : {}),
  }
}

export function sanitizeStdioEnv(
  hostEnv: Record<string, string | undefined>,
  serverEnv: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(hostEnv)) {
    if (typeof v !== 'string') continue
    if (k.includes('\0') || v.includes('\0')) continue
    if (SAFE_STDIO_ENV_UPPER.has(k.toUpperCase())) {
      out[k] = v
    }
  }
  for (const [rawKey, v] of Object.entries(serverEnv)) {
    const key = rawKey.trim()
    if (!key || typeof v !== 'string') continue
    if (key.includes('\0') || v.includes('\0')) continue
    out[key] = v
  }
  return out
}

export function validateMcpStdioConfig(
  command: string,
  args: readonly string[] = [],
  cwd = '',
): { command: string; args: string[]; cwd: string } {
  const cleanCmd = typeof command === 'string' ? command.trim() : ''
  if (!cleanCmd || cleanCmd.includes('\0')) {
    throw new McpCallError('connect_failed', 'MCP stdio command must be a non-empty string without NUL bytes', false)
  }
  if (!Array.isArray(args) || args.length > MAX_STDIO_ARGS) {
    throw new McpCallError(
      'connect_failed',
      `MCP stdio args must be an array of at most ${MAX_STDIO_ARGS} items`,
      false,
    )
  }
  const cleanArgs: string[] = []
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > MAX_STDIO_ARG_CHARS || arg.includes('\0')) {
      throw new McpCallError('connect_failed', 'Invalid MCP stdio argument', false)
    }
    cleanArgs.push(arg)
  }
  const cleanCwd = typeof cwd === 'string' ? cwd.trim() : ''
  if (cleanCwd) {
    if (cleanCwd.includes('\0')) {
      throw new McpCallError('connect_failed', 'MCP stdio cwd must not contain NUL bytes', false)
    }
    try {
      if (!statSync(cleanCwd).isDirectory()) {
        throw new McpCallError('connect_failed', `MCP stdio cwd is not a directory: ${cleanCwd}`, false)
      }
    } catch (err) {
      if (err instanceof McpCallError) throw err
      throw new McpCallError('connect_failed', `MCP stdio cwd does not exist: ${cleanCwd}`, false)
    }
  }
  return { command: cleanCmd, args: cleanArgs, cwd: cleanCwd }
}

type PendingStdioRequest = {
  id: number
  write: boolean
  dispatched: boolean
  resolve: (value: unknown) => void
  reject: (err: McpCallError) => void
  cleanup: () => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

export async function createStdioSession(opts: StdioSessionOptions): Promise<McpSession> {
  const valid = validateMcpStdioConfig(opts.command, opts.args ?? [], opts.cwd ?? '')
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const serverEnv = opts.serverEnv ?? {}
  const redact = buildSecretRedactor(Object.values(serverEnv), opts.redact)

  const env = sanitizeStdioEnv(opts.hostEnv ?? process.env, serverEnv)
  const child = spawn(valid.command, valid.args, {
    cwd: valid.cwd || undefined,
    env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let healthy = true
  let closing = false
  let exited = false
  let spawnError: Error | null = null
  let exitSummary = ''
  let stderrTail = ''
  let nextId = 0
  let closePromise: Promise<void> | null = null

  const pending = new Map<number | string, PendingStdioRequest>()
  const stderrDecoder = new StringDecoder('utf8')

  let resolveExit!: () => void
  const exitPromise = new Promise<void>((r) => {
    resolveExit = r
  })

  let resolveStreamsClosed!: () => void
  const streamsClosedPromise = new Promise<void>((r) => {
    resolveStreamsClosed = r
  })

  const appendStderr = (text: string): void => {
    if (!text) return
    stderrTail += text
    if (stderrTail.length > MAX_STDERR_CHARS) {
      stderrTail = stderrTail.slice(-MAX_STDERR_CHARS)
    }
  }

  const formatStderrSuffix = (): string => {
    const trimmed = stderrTail.trim()
    return trimmed ? `: ${redact(trimmed)}` : ''
  }

  const rejectAllPending = (code: 'connect_failed' | 'protocol_error', baseMessage: string): void => {
    const entries = [...pending.values()]
    pending.clear()
    for (const entry of entries) {
      entry.cleanup()
      if (entry.write && entry.dispatched) {
        entry.reject(
          new McpCallError(
            'uncertain_write',
            redact(`${baseMessage} after write dispatch${formatStderrSuffix()}`),
            true,
          ),
        )
      } else {
        entry.reject(new McpCallError(code, redact(`${baseMessage}${formatStderrSuffix()}`), false))
      }
    }
  }

  child.stdin?.on('error', () => {
    // Prevent uncaught EPIPE if child exits before reading stdin
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    appendStderr(stderrDecoder.write(chunk))
  })
  child.stderr?.on('end', () => {
    appendStderr(stderrDecoder.end())
  })

  const hasValidPid = (): boolean =>
    typeof child.pid === 'number' && Number.isInteger(child.pid) && child.pid > 0

  const writeJsonLine = (payload: Record<string, unknown>): boolean => {
    if (
      closing ||
      exited ||
      spawnError ||
      !hasValidPid() ||
      !child.stdin ||
      child.stdin.destroyed ||
      !child.stdin.writable
    ) {
      return false
    }
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
      return true
    } catch {
      return false
    }
  }

  const handleRpcObject = (msg: Record<string, unknown>): void => {
    if (msg.jsonrpc !== '2.0') return

    const hasMethod = typeof msg.method === 'string' && msg.method.length > 0
    const hasId = 'id' in msg && (typeof msg.id === 'number' || typeof msg.id === 'string')

    if (hasMethod && hasId) {
      // Server -> client request
      if (msg.method === 'ping') {
        writeJsonLine({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else {
        writeJsonLine({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${String(msg.method)}` },
        })
      }
      return
    }

    if (hasMethod && !hasId) {
      // Server -> client notification
      if (msg.method === 'notifications/tools/list_changed') {
        try {
          opts.onToolsChanged?.()
        } catch {
          // Ignore callback errors
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
        const rawErr = typeof msg.error.message === 'string' ? msg.error.message : 'MCP JSON-RPC error'
        entry.reject(new McpCallError('protocol_error', redact(rawErr), false))
      } else if ('result' in msg) {
        entry.resolve(msg.result)
      } else {
        entry.reject(new McpCallError('protocol_error', 'Malformed MCP JSON-RPC response', false))
      }
    }
  }

  const handleStdoutLine = (rawLine: string): void => {
    const trimmed = rawLine.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Non-JSON banner lines on stdout are ignored safely
      return
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (isRecord(item)) handleRpcObject(item)
      }
    } else if (isRecord(parsed)) {
      handleRpcObject(parsed)
    }
  }

  let lineChunks: Buffer[] = []
  let lineBytes = 0

  const abortOnFramingOverflow = (): void => {
    lineChunks = []
    lineBytes = 0
    healthy = false
    rejectAllPending('protocol_error', 'MCP stdio stdout line exceeded 4 MB limit')
    void close()
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    if (closing || !healthy) return
    let slice = chunk
    for (;;) {
      const nl = slice.indexOf(0x0a)
      if (nl === -1) break
      const head = slice.subarray(0, nl)
      if (lineBytes + head.length > MAX_LINE_BYTES) {
        abortOnFramingOverflow()
        return
      }
      const fullBuf = lineChunks.length === 0 ? head : Buffer.concat([...lineChunks, head], lineBytes + head.length)
      lineChunks = []
      lineBytes = 0
      let line = fullBuf.toString('utf8')
      if (line.endsWith('\r')) line = line.slice(0, -1)
      handleStdoutLine(line)
      slice = slice.subarray(nl + 1)
    }

    if (slice.length > 0) {
      if (lineBytes + slice.length > MAX_LINE_BYTES) {
        abortOnFramingOverflow()
        return
      }
      lineChunks.push(slice)
      lineBytes += slice.length
    }
  })

  child.once('error', (err) => {
    spawnError = err
    healthy = false
    exited = true
    resolveExit()
    resolveStreamsClosed()
    if (!closing) {
      rejectAllPending('connect_failed', `Failed to spawn MCP stdio process (${valid.command}): ${err.message}`)
    }
  })

  child.once('close', () => {
    appendStderr(stderrDecoder.end())
    resolveStreamsClosed()
  })

  child.once('exit', (code, signal) => {
    exited = true
    healthy = false
    exitSummary = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
    resolveExit()
    if (!closing) {
      void Promise.race([streamsClosedPromise, sleep(100)]).then(() => {
        if (!closing && pending.size > 0) {
          rejectAllPending('connect_failed', `MCP stdio server exited (${exitSummary})`)
        }
      })
    }
  })

  const sendRequest = (
    method: string,
    params: Record<string, unknown>,
    reqOpts: { write: boolean; timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> => {
    if (closing || exited || spawnError || !healthy || !hasValidPid()) {
      const reason = spawnError
        ? `Failed to spawn MCP stdio process (${valid.command}): ${spawnError.message}`
        : `MCP stdio server is not connected${exitSummary ? ` (${exitSummary})` : ''}`
      return Promise.reject(new McpCallError('connect_failed', redact(`${reason}${formatStderrSuffix()}`), false))
    }
    if (reqOpts.signal?.aborted) {
      return Promise.reject(new McpCallError('timeout', 'MCP stdio request aborted before dispatch', false))
    }

    const id = ++nextId
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined

      const onAbort = (): void => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        entry.cleanup()
        if (entry.write && entry.dispatched) {
          entry.reject(
            new McpCallError('uncertain_write', 'MCP stdio write call aborted after dispatch; outcome uncertain', true),
          )
        } else {
          entry.reject(new McpCallError('timeout', 'MCP stdio request aborted', false))
        }
      }

      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        reqOpts.signal?.removeEventListener('abort', onAbort)
      }

      timer = setTimeout(() => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        entry.cleanup()
        if (entry.write && entry.dispatched) {
          entry.reject(
            new McpCallError(
              'uncertain_write',
              redact(`MCP stdio write call timed out after dispatch${formatStderrSuffix()}`),
              true,
            ),
          )
        } else {
          entry.reject(new McpCallError('timeout', redact(`MCP stdio request timed out (${method})`), false))
        }
      }, reqOpts.timeoutMs)
      timer.unref?.()

      reqOpts.signal?.addEventListener('abort', onAbort, { once: true })

      const entry: PendingStdioRequest = {
        id,
        write: reqOpts.write,
        dispatched: false,
        resolve,
        reject,
        cleanup,
      }
      pending.set(id, entry)

      const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
      if (
        closing ||
        exited ||
        spawnError ||
        !hasValidPid() ||
        !child.stdin ||
        child.stdin.destroyed ||
        !child.stdin.writable
      ) {
        pending.delete(id)
        cleanup()
        reject(new McpCallError('connect_failed', redact(`MCP stdio stdin is not writable${formatStderrSuffix()}`), false))
        return
      }

      try {
        entry.dispatched = true
        child.stdin.write(line)
      } catch (err) {
        pending.delete(id)
        cleanup()
        const msg = err instanceof Error ? err.message : String(err)
        if (entry.write && entry.dispatched) {
          reject(new McpCallError('uncertain_write', redact(`MCP stdio write failed mid-stream: ${msg}`), true))
        } else {
          reject(new McpCallError('connect_failed', redact(`MCP stdio write failed: ${msg}`), false))
        }
      }
    })
  }

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true
      healthy = false
      rejectAllPending('connect_failed', 'MCP stdio session closed')

      try {
        child.stdin?.end()
      } catch {
        // ignore
      }

      await Promise.resolve()

      // Guard child.pid > 0 strictly: when spawn() fails with ENOENT, child.pid is undefined
      // while Node's internal uv_process_t handle has pid = 0 until onErrorNT runs, so calling
      // child.kill() without checking child.pid > 0 would invoke kill(0, SIGTERM) on POSIX!
      if (hasValidPid() && !exited && child.exitCode === null && child.signalCode === null) {
        try {
          if (hasValidPid()) child.kill('SIGTERM')
        } catch {
          // ignore
        }
        const outcome = await Promise.race([
          exitPromise.then(() => 'exited' as const),
          sleep(SIGTERM_GRACE_MS).then(() => 'timeout' as const),
        ])
        if (
          outcome === 'timeout' &&
          hasValidPid() &&
          !exited &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
          await Promise.race([exitPromise, sleep(500)])
        }
      }

      child.stdout?.destroy()
      child.stderr?.destroy()
      child.stdin?.destroy()
    })()
    return closePromise
  }

  try {
    if (!hasValidPid() && !exited && !spawnError) {
      // Allow Node's nextTick spawn 'error' (e.g. ENOENT) to populate spawnError before rejecting
      await Promise.race([exitPromise, sleep(50)])
    }
    const initResult = await sendRequest(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
      { write: false, timeoutMs: handshakeTimeoutMs },
    )
    if (!isValidInitializeResult(initResult)) {
      throw new McpCallError('protocol_error', 'Invalid MCP initialize response from stdio server', false)
    }
    writeJsonLine({ jsonrpc: '2.0', method: 'notifications/initialized' })
  } catch (err) {
    await close()
    throw err
  }

  return {
    listTools(signal?: AbortSignal): Promise<McpDiscoveredTool[]> {
      return paginateMcpTools(
        (cursor, sig) =>
          sendRequest('tools/list', cursor ? { cursor } : {}, {
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
      const res = await sendRequest(
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
    isHealthy: () => healthy && !closing && !exited && !spawnError,
  }
}
