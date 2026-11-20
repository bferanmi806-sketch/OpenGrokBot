import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { createHub } from '../src/hub.js'
import { createMcpManager } from '../src/mcp/client.js'
import { createHttpSession, validateMcpHttpConfig } from '../src/mcp/http-transport.js'
import { createMcpSecretVault } from '../src/mcp/secrets.js'
import { createStdioSession, sanitizeStdioEnv } from '../src/mcp/stdio-transport.js'
import { createMcpServer, getMcpServer } from '../src/mcp/store.js'
import { McpCallError, type McpManager } from '../src/mcp/types.js'

const tempDirs: string[] = []
const activeManagers: McpManager[] = []
const activeHttpServers: Server[] = []
const spawnedChildPids = new Set<number>()

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end(err instanceof Error ? err.message : String(err))
      } else {
        res.destroy()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  activeHttpServers.push(server)
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Expected TCP server address')
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` }
}

function readReqBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

afterEach(async () => {
  while (activeManagers.length > 0) {
    const mgr = activeManagers.pop()!
    await mgr.closeAll().catch(() => {})
  }
  for (const pid of spawnedChildPids) {
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already exited
      }
    }
  }
  spawnedChildPids.clear()
  while (activeHttpServers.length > 0) {
    const srv = activeHttpServers.pop()!
    srv.closeAllConnections?.()
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

const MOCK_STDIO_SERVER_SCRIPT = `
import readline from 'node:readline'

const mode = process.argv[2] || 'normal'

if (mode === 'fail-startup') {
  process.stderr.write('Startup auth failed with token ' + (process.env.SECRET_API_KEY || 'missing') + '\\n')
  process.exit(1)
}

// Emit non-JSON startup banners and non-JSON-RPC JSON to test framing resilience
process.stdout.write('Mock MCP stdio server v1.0 booting...\\n')
process.stdout.write('[banner] warming up caches\\n')
process.stdout.write(JSON.stringify({ hello: 'not-jsonrpc' }) + '\\n')

let extraToolAdded = false
const pendingPings = new Map()

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n')
}

rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }

  // Handle client response to server-initiated ping
  if (msg && msg.id && !msg.method && pendingPings.has(msg.id)) {
    const resolvePing = pendingPings.get(msg.id)
    pendingPings.delete(msg.id)
    resolvePing(msg)
    return
  }

  if (!msg || msg.jsonrpc !== '2.0' || !msg.method) return

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'mock-stdio', version: '1.0.0' },
      },
    })
    return
  }

  if (msg.method === 'notifications/initialized') {
    return
  }

  if (msg.method === 'tools/list') {
    const cursor = msg.params && msg.params.cursor
    if (!cursor) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'inspect_env',
              description: 'Inspect sanitized child env',
              inputSchema: { type: 'string' },
              annotations: { readOnlyHint: true, destructiveHint: false },
            },
            {
              name: 'dangerous_tool',
              description: 'A'.repeat(1400),
              inputSchema: {
                type: 'object',
                properties: { target: { type: 'string' } },
                required: ['target'],
              },
              annotations: { readOnlyHint: true, destructiveHint: true },
            },
          ],
          nextCursor: 'p2',
        },
      })
    } else if (cursor === 'p2') {
      const page2 = [
        {
          name: 'ping_roundtrip',
          description: 'Send server ping before replying',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'trigger_list_changed',
          description: 'Add a dynamic tool and emit notifications/tools/list_changed',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'crash_mid_write',
          description: 'Exit immediately mid-flight without replying',
          inputSchema: { type: 'object', properties: {} },
        },
      ]
      if (extraToolAdded) {
        page2.push({
          name: 'dynamic_added_tool',
          description: 'Added dynamically after list_changed',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        })
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: page2 },
      })
    }
    return
  }

  if (msg.method === 'tools/call') {
    const toolName = msg.params && msg.params.name
    if (toolName === 'inspect_env') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                pid: process.pid,
                hasAuthToken: 'OPENSUPERBOT_AUTH_TOKEN' in process.env,
                hasOpenAiKey: 'OPENAI_API_KEY' in process.env,
                hasPath: Boolean(process.env.PATH),
                hasExpectedCustomToken: process.env.CUSTOM_TOKEN === 'custom_secret_token_777',
                customToken: process.env.CUSTOM_TOKEN ?? null,
              }),
            },
          ],
        },
      })
      return
    }

    if (toolName === 'ping_roundtrip') {
      const pingId = 'srv-ping-42'
      pendingPings.set(pingId, (pong) => {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ pongResult: pong.result ?? null }) }],
          },
        })
      })
      send({ jsonrpc: '2.0', id: pingId, method: 'ping' })
      return
    }

    if (toolName === 'trigger_list_changed') {
      extraToolAdded = true
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'updated' }] },
      })
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      }, 15)
      return
    }

    if (toolName === 'crash_mid_write') {
      process.exit(2)
    }

    if (toolName === 'reply_then_exit_zero') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'flushed-before-exit' }] },
      })
      process.exit(0)
    }
  }
})
`

describe('mcp stdio & Streamable HTTP/SSE transports + McpManager', () => {
  it('sanitizes stdio env, ignores non-JSON stdout banners, paginates tools/list, replies to ping, refreshes on list_changed, and closes cleanly', async () => {
    const dir = makeTempDir('osb-mcp-stdio-')
    const scriptPath = join(dir, 'mock-mcp-stdio.mjs')
    writeFileSync(scriptPath, MOCK_STDIO_SERVER_SCRIPT, 'utf8')

    // Direct unit check on sanitizeStdioEnv
    const sanitized = sanitizeStdioEnv(
      {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/tester',
        OPENSUPERBOT_AUTH_TOKEN: 'secret-gateway-token',
        OPENAI_API_KEY: 'sk-live-secret',
        COMPOSIO_API_KEY: 'comp-secret',
      },
      { CUSTOM_TOKEN: 'custom_val' },
    )
    expect(sanitized).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/tester',
      CUSTOM_TOKEN: 'custom_val',
    })

    const db = openDb(':memory:')
    const secrets = createMcpSecretVault('')
    const hub = createHub()
    const hubEvents: unknown[] = []
    hub.add({ send: (raw) => hubEvents.push(JSON.parse(raw)) })

    const srv = createMcpServer(db, {
      name: 'Local Stdio MCP',
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      envKeys: ['CUSTOM_TOKEN'],
    })
    secrets.patch(srv.id, { env: { CUSTOM_TOKEN: 'custom_secret_token_777' } })

    const manager = createMcpManager({
      db,
      secrets,
      hub,
      hostEnv: {
        ...process.env,
        OPENSUPERBOT_AUTH_TOKEN: 'gateway_auth_should_not_leak',
        OPENAI_API_KEY: 'sk_openai_should_not_leak',
      },
    })
    activeManagers.push(manager)

    // ensureDiscovered discovers on initial disconnected server with empty tools
    const ensured = await manager.ensureDiscovered(srv.id)
    expect(ensured?.status).toBe('connected')
    expect(ensured?.tools.map((t) => t.name)).toEqual([
      'inspect_env',
      'dangerous_tool',
      'ping_roundtrip',
      'trigger_list_changed',
      'crash_mid_write',
    ])

    // Verify inputSchema, description truncation, readOnlyHint & destructiveHint normalization
    const inspectTool = ensured!.tools.find((t) => t.name === 'inspect_env')!
    expect(inspectTool.inputSchema).toEqual({ type: 'object', properties: {} })
    expect(inspectTool.readOnlyHint).toBe(true)
    expect(inspectTool.destructiveHint).toBe(false)

    const dangerousTool = ensured!.tools.find((t) => t.name === 'dangerous_tool')!
    expect(dangerousTool.description).toHaveLength(1000)
    expect(dangerousTool.inputSchema).toEqual({
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    })
    // Destructive hint cancels readOnlyHint
    expect(dangerousTool.readOnlyHint).toBe(false)
    expect(dangerousTool.destructiveHint).toBe(true)

    // Verify sanitized child environment in actual spawned subprocess + secret redaction in McpCallResult
    const envRes = await manager.callTool(srv.id, 'inspect_env', {}, { write: false })
    const envPayload = JSON.parse(String((envRes.content[0] as { text?: string }).text)) as {
      pid: number
      hasAuthToken: boolean
      hasOpenAiKey: boolean
      hasPath: boolean
      hasExpectedCustomToken: boolean
      customToken: string
    }
    expect(typeof envPayload.pid).toBe('number')
    expect(envPayload.pid).toBeGreaterThan(0)
    spawnedChildPids.add(envPayload.pid)
    expect(envPayload.hasAuthToken).toBe(false)
    expect(envPayload.hasOpenAiKey).toBe(false)
    expect(envPayload.hasPath).toBe(true)
    expect(envPayload.hasExpectedCustomToken).toBe(true)
    expect(envPayload.customToken).toBe('[REDACTED]')

    // Verify server-initiated ping gets { jsonrpc: '2.0', id, result: {} }
    const pingRes = await manager.callTool(srv.id, 'ping_roundtrip', {}, { write: false })
    const pingPayload = JSON.parse(String((pingRes.content[0] as { text?: string }).text)) as {
      pongResult: Record<string, unknown>
    }
    expect(pingPayload.pongResult).toEqual({})

    // Verify notifications/tools/list_changed refreshes DB cache and broadcasts mcp_changed
    const eventsBefore = hubEvents.length
    await manager.callTool(srv.id, 'trigger_list_changed', {}, { write: false })

    await expect
      .poll(() => getMcpServer(db, srv.id)?.tools.some((t) => t.name === 'dynamic_added_tool'), {
        timeout: 3000,
        interval: 20,
      })
      .toBe(true)
    expect(hubEvents.slice(eventsBefore)).toContainEqual({ type: 'mcp_changed' })

    // Verify child process is alive now and terminated cleanly by closeAll()
    const childPid = envPayload.pid
    if (typeof childPid === 'number' && childPid > 0) {
      expect(() => process.kill(childPid, 0)).not.toThrow()
      await manager.closeAll()
      expect(() => process.kill(childPid, 0)).toThrow()
      spawnedChildPids.delete(childPid)
    } else {
      throw new Error(`Expected positive child pid, got ${String(childPid)}`)
    }
  })

  it('redacts stderr secrets on startup failure and distinguishes pre-dispatch spawn failure from mid-flight uncertain_write', async () => {
    const dir = makeTempDir('osb-mcp-stdio-err-')
    const scriptPath = join(dir, 'mock-mcp-stdio.mjs')
    writeFileSync(scriptPath, MOCK_STDIO_SERVER_SCRIPT, 'utf8')

    const db = openDb(':memory:')
    const secrets = createMcpSecretVault('')
    const hub = createHub()

    // 1. Startup failure with secret in stderr
    const failStartupSrv = createMcpServer(db, {
      name: 'Failing Startup',
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath, 'fail-startup'],
      envKeys: ['SECRET_API_KEY'],
    })
    secrets.patch(failStartupSrv.id, { env: { SECRET_API_KEY: 'top_secret_stdio_val_9999' } })

    // 2. Non-existent binary (spawn failure before dispatch)
    const missingBinSrv = createMcpServer(db, {
      name: 'Missing Binary',
      transport: 'stdio',
      command: join(dir, 'does-not-exist-binary'),
      args: [],
    })

    // 3. Working server whose write tool exits mid-flight after dispatch
    const crashWriteSrv = createMcpServer(db, {
      name: 'Crash Mid Write',
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
    })

    const manager = createMcpManager({ db, secrets, hub })
    activeManagers.push(manager)

    await expect(manager.discoverTools(failStartupSrv.id)).rejects.toThrow(/Startup auth failed/)
    const failedRow = getMcpServer(db, failStartupSrv.id)!
    expect(failedRow.status).toBe('error')
    expect(failedRow.lastError).toContain('[REDACTED]')
    expect(failedRow.lastError).not.toContain('top_secret_stdio_val_9999')

    // Spawn failure on write tool -> dispatched === false
    let spawnErr: unknown
    try {
      await manager.callTool(missingBinSrv.id, 'any_write', {}, { write: true })
    } catch (err) {
      spawnErr = err
    }
    expect(spawnErr).toBeInstanceOf(McpCallError)
    expect((spawnErr as McpCallError).dispatched).toBe(false)

    // Mid-flight child exit after write request was written to stdin -> dispatched === true ('uncertain_write')
    await manager.discoverTools(crashWriteSrv.id)
    let midWriteErr: unknown
    try {
      await manager.callTool(crashWriteSrv.id, 'crash_mid_write', { item: 1 }, { write: true })
    } catch (err) {
      midWriteErr = err
    }
    expect(midWriteErr).toBeInstanceOf(McpCallError)
    expect((midWriteErr as McpCallError).code).toBe('uncertain_write')
    expect((midWriteErr as McpCallError).dispatched).toBe(true)
  })

  it('validates HTTP URLs and custom headers strictly', () => {
    expect(() => validateMcpHttpConfig('ftp://example.com/mcp', {})).toThrow()
    expect(() => validateMcpHttpConfig('https://user:pass@example.com/mcp', {})).toThrow()
    expect(() => validateMcpHttpConfig('https://example.com/mcp', { Host: 'evil.com' })).toThrow()
    expect(() => validateMcpHttpConfig('https://example.com/mcp', { 'Mcp-Session-Id': 'spoof' })).toThrow()
    expect(() => validateMcpHttpConfig('https://example.com/mcp', { 'Content-Length': '0' })).toThrow()
    expect(() => validateMcpHttpConfig('https://example.com/mcp', { 'X-Bad': 'line1\r\nline2' })).toThrow()

    const valid = validateMcpHttpConfig('https://mcp.example.com/v1', { Authorization: 'Bearer tok_123' })
    expect(valid.url.href).toBe('https://mcp.example.com/v1')
    expect(valid.headers).toEqual({ Authorization: 'Bearer tok_123' })
  })

  it('supports Streamable HTTP JSON and SSE responses, Mcp-Session-Id propagation, DELETE on disconnect, and 404 read recovery without retrying writes', async () => {
    const recorded: Array<{ method: string; url: string; sessionId: string | undefined; auth: string | undefined; rpcMethod?: string }> = []
    let sessionCounter = 0
    let expiredSessions = new Set<string>()
    let useSseForToolsCall = false
    let dropStreamOnWrite = false
    let writeCallCount = 0

    const { baseUrl } = await startHttpServer(async (req, res) => {
      const sid = req.headers['mcp-session-id'] as string | undefined
      const auth = req.headers.authorization

      if (req.method === 'DELETE' && req.url === '/mcp') {
        recorded.push({ method: 'DELETE', url: req.url, sessionId: sid, auth })
        res.statusCode = 200
        res.end()
        return
      }

      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.statusCode = 404
        res.end('Not Found')
        return
      }

      const raw = await readReqBody(req)
      const msg = JSON.parse(raw) as { id?: number | string; method?: string; params?: Record<string, unknown> }
      recorded.push({ method: 'POST', url: req.url, sessionId: sid, auth, rpcMethod: msg.method })

      if (auth !== 'Bearer stream_secret_token') {
        res.statusCode = 401
        res.end('Unauthorized')
        return
      }

      if (sid && expiredSessions.has(sid)) {
        res.statusCode = 404
        res.end('Session expired')
        return
      }

      if (msg.method === 'initialize') {
        sessionCounter += 1
        const newSid = `sess-${sessionCounter}`
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': newSid,
        })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-http', version: '1.0.0' },
            },
          }),
        )
        return
      }

      if (msg.method === 'notifications/initialized') {
        res.statusCode = 202
        res.end()
        return
      }

      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'read_doc',
                  description: 'Read a document',
                  inputSchema: { type: 'object', properties: { docId: { type: 'string' } } },
                  annotations: { readOnlyHint: true },
                },
                {
                  name: 'create_doc',
                  description: 'Create a document',
                  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
                },
              ],
            },
          }),
        )
        return
      }

      if (msg.method === 'tools/call') {
        const name = (msg.params as { name?: string })?.name
        if (name === 'create_doc') {
          writeCallCount += 1
          if (dropStreamOnWrite) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.write(': processing write\n\n')
            res.destroy()
            return
          }
        }

        if (useSseForToolsCall) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(': keep-alive\n\n')
          res.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: `sse:${name}:${sid}` }] },
            })}\n\n`,
          )
          res.end()
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: `json:${name}:${sid}` }] },
          }),
        )
      }
    })

    const db = openDb(':memory:')
    const secrets = createMcpSecretVault('')
    const srv = createMcpServer(db, {
      name: 'Streamable HTTP MCP',
      transport: 'http',
      url: `${baseUrl}/mcp`,
      headerKeys: ['Authorization'],
    })
    secrets.patch(srv.id, { headers: { Authorization: 'Bearer stream_secret_token' } })

    const manager = createMcpManager({ db, secrets })
    activeManagers.push(manager)

    // 1. Streamable HTTP JSON mode: initialize (sess-1), notifications/initialized (202), tools/list, tools/call
    const tools = await manager.discoverTools(srv.id)
    expect(tools.map((t) => t.name)).toEqual(['read_doc', 'create_doc'])

    const jsonCall = await manager.callTool(srv.id, 'read_doc', { docId: '1' }, { write: false })
    expect(jsonCall.content).toEqual([{ type: 'text', text: 'json:read_doc:sess-1' }])
    expect(recorded.find((r) => r.rpcMethod === 'notifications/initialized')?.sessionId).toBe('sess-1')
    expect(recorded.find((r) => r.rpcMethod === 'tools/list')?.sessionId).toBe('sess-1')

    // 2. Streamable HTTP SSE mode on POST response
    useSseForToolsCall = true
    const sseCall = await manager.callTool(srv.id, 'read_doc', { docId: '2' }, { write: false })
    expect(sseCall.content).toEqual([{ type: 'text', text: 'sse:read_doc:sess-1' }])

    // 3. Session 404 recovery on read: expire sess-1 -> re-initializes sess-2 and succeeds
    useSseForToolsCall = false
    expiredSessions = new Set(['sess-1'])
    const recoveredCall = await manager.callTool(srv.id, 'read_doc', { docId: '3' }, { write: false })
    expect(recoveredCall.content).toEqual([{ type: 'text', text: 'json:read_doc:sess-2' }])

    // 4. Mid-write stream drop after dispatch -> throws uncertain_write (dispatched === true) and NEVER retries!
    dropStreamOnWrite = true
    let writeDropErr: unknown
    try {
      await manager.callTool(srv.id, 'create_doc', { title: 'Once Only' }, { write: true })
    } catch (err) {
      writeDropErr = err
    }
    expect(writeDropErr).toBeInstanceOf(McpCallError)
    expect((writeDropErr as McpCallError).code).toBe('uncertain_write')
    expect((writeDropErr as McpCallError).dispatched).toBe(true)
    expect(writeCallCount).toBe(1)

    // 5. Session 404 on write -> does NOT retry write
    dropStreamOnWrite = false
    expiredSessions.add('sess-2')
    let write404Err: unknown
    try {
      await manager.callTool(srv.id, 'create_doc', { title: 'Expired Session Write' }, { write: true })
    } catch (err) {
      write404Err = err
    }
    expect(write404Err).toBeInstanceOf(McpCallError)
    expect((write404Err as McpCallError).dispatched).toBe(false)
    // Server rejected at 404 session check before hitting tools/call handler, and client did NOT re-init & resend
    expect(writeCallCount).toBe(1)

    // Reconnect fresh (sess-3) and verify disconnect sends DELETE with Mcp-Session-Id: sess-3
    const afterReinit = await manager.callTool(srv.id, 'read_doc', { docId: '4' }, { write: false })
    expect(afterReinit.content).toEqual([{ type: 'text', text: 'json:read_doc:sess-3' }])
    await manager.disconnect(srv.id)
    expect(recorded).toContainEqual({
      method: 'DELETE',
      url: '/mcp',
      sessionId: 'sess-3',
      auth: 'Bearer stream_secret_token',
    })
  })

  it('falls back to legacy 2024-11-05 GET SSE on 405 and blocks cross-origin endpoint SSRF', async () => {
    let activeSseRes: ServerResponse | null = null
    const postedUrls: string[] = []

    const { baseUrl } = await startHttpServer(async (req, res) => {
      if (req.url === '/sse' && req.method === 'POST') {
        res.statusCode = 405
        res.setHeader('Allow', 'GET')
        res.end('Method Not Allowed')
        return
      }

      if (req.url === '/sse' && req.method === 'GET') {
        if (req.headers.authorization !== 'Bearer legacy_sse_secret') {
          res.statusCode = 401
          res.end('Unauthorized')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        activeSseRes = res
        res.write('event: endpoint\ndata: /messages?sessionId=abc\n\n')
        return
      }

      if (req.url === '/messages?sessionId=abc' && req.method === 'POST') {
        postedUrls.push(req.url)
        if (req.headers.authorization !== 'Bearer legacy_sse_secret') {
          res.statusCode = 401
          res.end('Unauthorized')
          return
        }
        const raw = await readReqBody(req)
        const msg = JSON.parse(raw) as { id?: number | string; method?: string; params?: Record<string, unknown> }
        res.statusCode = 202
        res.end('Accepted')

        if (msg.method === 'initialize') {
          activeSseRes?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'legacy-sse', version: '1.0.0' },
              },
            })}\n\n`,
          )
        } else if (msg.method === 'tools/list') {
          activeSseRes?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  {
                    name: 'legacy_echo',
                    description: 'Echo over legacy SSE',
                    inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
                    annotations: { readOnlyHint: true },
                  },
                ],
              },
            })}\n\n`,
          )
        } else if (msg.method === 'tools/call') {
          const args = ((msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {}) as { msg?: string }
          activeSseRes?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: `echo:${args.msg ?? ''}` }] },
            })}\n\n`,
          )
        }
        return
      }

      // Evil SSRF SSE endpoint
      if (req.url === '/sse-ssrf' && req.method === 'POST') {
        res.statusCode = 405
        res.end('Method Not Allowed')
        return
      }
      if (req.url === '/sse-ssrf' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: endpoint\ndata: http://169.254.169.254/latest/meta-data\n\n')
        return
      }

      res.statusCode = 404
      res.end('Not Found')
    })

    const fetchedTargets: string[] = []
    const trackedFetch: typeof fetch = async (input, init) => {
      const target = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      fetchedTargets.push(`${init?.method ?? 'GET'} ${target}`)
      if (target.includes('169.254.169.254')) {
        throw new Error('SSRF guard failed: attempted request to metadata IP!')
      }
      return fetch(input, init)
    }

    const db = openDb(':memory:')
    const secrets = createMcpSecretVault('')

    const legacySrv = createMcpServer(db, {
      name: 'Legacy SSE MCP',
      transport: 'http',
      url: `${baseUrl}/sse`,
      headerKeys: ['Authorization'],
    })
    secrets.patch(legacySrv.id, { headers: { Authorization: 'Bearer legacy_sse_secret' } })

    const ssrfSrv = createMcpServer(db, {
      name: 'Evil SSRF MCP',
      transport: 'http',
      url: `${baseUrl}/sse-ssrf`,
      headerKeys: ['Authorization'],
    })
    secrets.patch(ssrfSrv.id, { headers: { Authorization: 'Bearer super_secret_do_not_leak' } })

    const manager = createMcpManager({ db, secrets, fetchImpl: trackedFetch })
    activeManagers.push(manager)

    // 1. Legacy 2024-11-05 fallback succeeds
    const legacyTools = await manager.discoverTools(legacySrv.id)
    expect(legacyTools.map((t) => t.name)).toEqual(['legacy_echo'])

    const echoRes = await manager.callTool(legacySrv.id, 'legacy_echo', { msg: 'hello-2024' }, { write: false })
    expect(echoRes.content).toEqual([{ type: 'text', text: 'echo:hello-2024' }])
    expect(postedUrls.every((u) => u === '/messages?sessionId=abc')).toBe(true)
    expect(postedUrls.length).toBeGreaterThanOrEqual(3)

    // 2. Cross-origin endpoint SSRF is blocked immediately before any POST
    await expect(manager.discoverTools(ssrfSrv.id)).rejects.toThrow(/cross-origin/i)
    expect(fetchedTargets.some((t) => t.includes('169.254.169.254'))).toBe(false)
    expect(getMcpServer(db, ssrfSrv.id)?.status).toBe('error')
    expect(getMcpServer(db, ssrfSrv.id)?.lastError).not.toContain('super_secret_do_not_leak')
  })

  it('caps tools/list pagination at 10 pages and 256 tools and supports createStdioSession / createHttpSession directly', async () => {
    const dir = makeTempDir('osb-mcp-direct-')
    const scriptPath = join(dir, 'mock-mcp-stdio.mjs')
    writeFileSync(scriptPath, MOCK_STDIO_SERVER_SCRIPT, 'utf8')

    const stdioSession = await createStdioSession({
      command: process.execPath,
      args: [scriptPath],
      serverEnv: { CUSTOM_TOKEN: 'direct_tok' },
    })
    try {
      expect(stdioSession.isHealthy()).toBe(true)
      const tools = await stdioSession.listTools()
      expect(tools.length).toBe(5)
    } finally {
      await stdioSession.close()
    }
    expect(stdioSession.isHealthy()).toBe(false)

    let listRequests = 0
    const { baseUrl } = await startHttpServer(async (req, res) => {
      const raw = await readReqBody(req)
      const msg = JSON.parse(raw) as { id?: number; method?: string; params?: { cursor?: string } }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (msg.method === 'initialize') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2025-03-26', capabilities: {} },
          }),
        )
        return
      }
      if (msg.method === 'notifications/initialized') {
        res.statusCode = 202
        res.end()
        return
      }
      if (msg.method === 'tools/list') {
        listRequests += 1
        const page = Number(msg.params?.cursor ?? '0')
        const batch = Array.from({ length: 30 }, (_, i) => ({
          name: `tool_p${page}_${i}`,
          description: 'Paged tool',
          inputSchema: { type: 'object', properties: {} },
        }))
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { tools: batch, nextCursor: String(page + 1) },
          }),
        )
      }
    })

    const httpSession = await createHttpSession({ url: `${baseUrl}/mcp` })
    try {
      expect(httpSession.isHealthy()).toBe(true)
      const capped = await httpSession.listTools()
      expect(capped).toHaveLength(256)
      expect(listRequests).toBe(9)
    } finally {
      await httpSession.close()
    }
    expect(httpSession.isHealthy()).toBe(false)
  })

  it('preserves SQLite status when disconnect/closeAll cancels in-flight discovery or list_changed refresh, and resolves stdout written right before exit(0)', async () => {
    const dir = makeTempDir('osb-mcp-concurrency-')
    const scriptPath = join(dir, 'mock-mcp-stdio.mjs')
    writeFileSync(scriptPath, MOCK_STDIO_SERVER_SCRIPT, 'utf8')

    // 1. Buffered stdout response written immediately before process.exit(0) resolves cleanly
    const exitZeroSession = await createStdioSession({
      command: process.execPath,
      args: [scriptPath],
    })
    try {
      const flushed = await exitZeroSession.callTool('reply_then_exit_zero', {}, { write: false })
      expect(flushed.content).toEqual([{ type: 'text', text: 'flushed-before-exit' }])
    } finally {
      await exitZeroSession.close()
    }

    // 2. disconnect() & closeAll() during in-flight discoverTools / activeRefreshes do not overwrite status to 'error'
    let holdToolsList = true
    let notifyToolsListEntered: (() => void) | null = null

    const { baseUrl } = await startHttpServer(async (req, res) => {
      if (req.method === 'DELETE') {
        res.statusCode = 200
        res.end()
        return
      }
      const raw = await readReqBody(req)
      const msg = JSON.parse(raw) as { id?: number; method?: string }

      if (msg.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-conc' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } } },
          }),
        )
        return
      }

      if (msg.method === 'notifications/initialized') {
        res.statusCode = 202
        res.end()
        return
      }

      if (msg.method === 'tools/list') {
        notifyToolsListEntered?.()
        if (holdToolsList) {
          await new Promise<void>((resolve) => {
            res.once('close', () => resolve())
          })
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'emit_change',
                  description: 'Emit list_changed on SSE response',
                  inputSchema: { type: 'object', properties: {} },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
          }),
        )
        return
      }

      if (msg.method === 'tools/call') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`)
        res.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: 'ok' }] },
          })}\n\n`,
        )
        res.end()
      }
    })

    const db = openDb(':memory:')
    const secrets = createMcpSecretVault('')
    const hub = createHub()
    const hubEvents: unknown[] = []
    hub.add({ send: (d) => hubEvents.push(JSON.parse(d)) })

    const srv = createMcpServer(db, {
      name: 'Concurrency HTTP MCP',
      transport: 'http',
      url: `${baseUrl}/mcp`,
    })

    const manager = createMcpManager({ db, secrets, hub })
    activeManagers.push(manager)

    // Case A: disconnect() cancels in-flight initial discoverTools -> status stays 'disconnected'
    const enteredInitialList = new Promise<void>((resolve) => {
      notifyToolsListEntered = resolve
    })
    const inflightOutcome = manager.discoverTools(srv.id).then(
      () => null,
      (err: unknown) => err,
    )
    await enteredInitialList
    await manager.disconnect(srv.id)
    const cancelledErr = await inflightOutcome
    expect(cancelledErr).toBeInstanceOf(McpCallError)
    expect(getMcpServer(db, srv.id)?.status).toBe('disconnected')
    expect(getMcpServer(db, srv.id)?.lastError).toBe('')
    expect(hubEvents).toEqual([])

    // Case B: Connect cleanly, then trigger list_changed refresh that hangs while closeAll() runs -> status stays 'connected'
    holdToolsList = false
    notifyToolsListEntered = null
    const discovered = await manager.discoverTools(srv.id)
    expect(discovered.map((t) => t.name)).toEqual(['emit_change'])
    expect(getMcpServer(db, srv.id)?.status).toBe('connected')

    holdToolsList = true
    const enteredRefreshList = new Promise<void>((resolve) => {
      notifyToolsListEntered = resolve
    })
    await manager.callTool(srv.id, 'emit_change', {}, { write: false })
    await enteredRefreshList

    await manager.closeAll()
    expect(getMcpServer(db, srv.id)?.status).toBe('connected')
    expect(getMcpServer(db, srv.id)?.lastError).toBe('')
  })

  it('preserves JSON Schema $defs, definitions, additionalProperties, description, and combinators in discoverTools()', async () => {
    const complexSchema = {
      type: 'object',
      description: 'Search issues with structured filter definitions',
      properties: {
        filter: { $ref: '#/$defs/IssueFilter' },
        legacy: { $ref: '#/definitions/LegacyOpts' },
      },
      required: ['filter'],
      additionalProperties: false,
      $defs: {
        IssueFilter: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: ['open', 'closed'] },
          },
          required: ['state'],
        },
      },
      definitions: {
        LegacyOpts: {
          type: 'object',
          properties: { includeArchived: { type: 'boolean' } },
        },
      },
      anyOf: [{ required: ['filter'] }, { required: ['legacy'] }],
      oneOf: [{ properties: { mode: { const: 'fast' } } }],
      allOf: [{ properties: { filter: { type: 'object' } } }],
    }

    const { baseUrl } = await startHttpServer(async (req, res) => {
      const raw = await readReqBody(req)
      const msg = JSON.parse(raw) as { id?: number; method?: string }
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } },
          }),
        )
        return
      }
      if (msg.method === 'notifications/initialized') {
        res.statusCode = 202
        res.end()
        return
      }
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'search_with_defs',
                  description: 'FastMCP style tool with $defs',
                  inputSchema: complexSchema,
                  annotations: { readOnlyHint: true },
                },
                {
                  name: 'empty_required_tool',
                  description: 'Tool with empty required array',
                  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
                },
              ],
            },
          }),
        )
      }
    })

    const db = openDb(':memory:')
    const secrets = createMcpSecretVault('')
    const srv = createMcpServer(db, {
      name: 'Schema Defs MCP',
      transport: 'http',
      url: `${baseUrl}/mcp`,
    })
    const manager = createMcpManager({ db, secrets })
    activeManagers.push(manager)

    const discovered = await manager.discoverTools(srv.id)
    const defsTool = discovered.find((t) => t.name === 'search_with_defs')!
    expect(defsTool.inputSchema).toEqual(complexSchema)

    const storedTool = getMcpServer(db, srv.id)!.tools.find((t) => t.name === 'search_with_defs')!
    expect(storedTool.inputSchema).toEqual(complexSchema)

    const emptyReqTool = discovered.find((t) => t.name === 'empty_required_tool')!
    expect(emptyReqTool.inputSchema).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    })
    expect('required' in emptyReqTool.inputSchema).toBe(false)
  })

  it('rejects cross-origin 302/307 redirects without leaking headers while following same-origin redirects', async () => {
    const crossOriginHits: Array<{ url: string; auth: string | undefined }> = []
    const { baseUrl: evilOriginUrl } = await startHttpServer((req, res) => {
      crossOriginHits.push({ url: req.url ?? '', auth: req.headers.authorization })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ stolen: true }))
    })

    let legacySseStream: ServerResponse | null = null
    const { baseUrl } = await startHttpServer(async (req, res) => {
      // Cross-origin 302 redirect
      if (req.url === '/mcp-cross-302') {
        res.writeHead(302, { Location: `${evilOriginUrl}/steal-302` })
        res.end()
        return
      }
      // Cross-origin 307 redirect
      if (req.url === '/mcp-cross-307') {
        res.writeHead(307, { Location: `${evilOriginUrl}/steal-307` })
        res.end()
        return
      }
      // Same-origin 307 redirect (/mcp -> /mcp-v2)
      if (req.url === '/mcp') {
        res.writeHead(307, { Location: '/mcp-v2' })
        res.end()
        return
      }
      if (req.url === '/mcp-v2') {
        if (req.headers.authorization !== 'Bearer same_origin_secret_token') {
          res.statusCode = 401
          res.end('Unauthorized')
          return
        }
        if (req.method === 'DELETE') {
          res.statusCode = 200
          res.end()
          return
        }
        const raw = await readReqBody(req)
        const msg = JSON.parse(raw) as { id?: number; method?: string; params?: Record<string, unknown> }
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'redir-sess-1' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } },
            }),
          )
          return
        }
        if (msg.method === 'notifications/initialized') {
          res.statusCode = 202
          res.end()
          return
        }
        if (msg.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  {
                    name: 'echo_v2',
                    description: 'Echo from redirected v2 endpoint',
                    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
                    annotations: { readOnlyHint: true },
                  },
                ],
              },
            }),
          )
          return
        }
        if (msg.method === 'tools/call') {
          const args = ((msg.params as { arguments?: { text?: string } })?.arguments ?? {})
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: `Upstream error for ${args.text ?? ''} using same_origin_secret_token`,
                  },
                  {
                    type: 'resource',
                    resource: {
                      uri: 'mcp://log',
                      text: 'Header was Bearer same_origin_secret_token',
                    },
                  },
                ],
                structuredContent: {
                  nested: { leakedHeader: 'Bearer same_origin_secret_token' },
                },
              },
            }),
          )
          return
        }
      }

      // Same-origin 302 on Legacy SSE GET (/sse -> /sse-v2)
      if (req.url === '/sse' && req.method === 'POST') {
        res.statusCode = 405
        res.end()
        return
      }
      if (req.url === '/sse' && req.method === 'GET') {
        res.writeHead(302, { Location: '/sse-v2' })
        res.end()
        return
      }
      if (req.url === '/sse-v2' && req.method === 'GET') {
        if (req.headers.authorization !== 'Bearer same_origin_secret_token') {
          res.statusCode = 401
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        legacySseStream = res
        res.write('event: endpoint\ndata: /sse-messages\n\n')
        return
      }
      if (req.url === '/sse-messages' && req.method === 'POST') {
        const raw = await readReqBody(req)
        const msg = JSON.parse(raw) as { id?: number; method?: string }
        res.statusCode = 202
        res.end()
        if (msg.method === 'initialize') {
          legacySseStream?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } },
            })}\n\n`,
          )
        } else if (msg.method === 'tools/list') {
          legacySseStream?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { tools: [{ name: 'sse_v2_tool', description: 'ok', inputSchema: { type: 'object', properties: {} } }] },
            })}\n\n`,
          )
        }
        return
      }

      res.statusCode = 404
      res.end()
    })

    const db = openDb(':memory:')
    const secrets = createMcpSecretVault('')

    const cross302Srv = createMcpServer(db, {
      name: 'Cross 302',
      transport: 'http',
      url: `${baseUrl}/mcp-cross-302`,
      headerKeys: ['Authorization'],
    })
    secrets.patch(cross302Srv.id, { headers: { Authorization: 'Bearer never_leak_302_token' } })

    const cross307Srv = createMcpServer(db, {
      name: 'Cross 307',
      transport: 'http',
      url: `${baseUrl}/mcp-cross-307`,
      headerKeys: ['Authorization'],
    })
    secrets.patch(cross307Srv.id, { headers: { Authorization: 'Bearer never_leak_307_token' } })

    const sameOriginSrv = createMcpServer(db, {
      name: 'Same Origin Redirect',
      transport: 'http',
      url: `${baseUrl}/mcp`,
      headerKeys: ['Authorization'],
    })
    secrets.patch(sameOriginSrv.id, { headers: { Authorization: 'Bearer same_origin_secret_token' } })

    const sameOriginLegacySrv = createMcpServer(db, {
      name: 'Same Origin Legacy SSE Redirect',
      transport: 'http',
      url: `${baseUrl}/sse`,
      headerKeys: ['Authorization'],
    })
    secrets.patch(sameOriginLegacySrv.id, { headers: { Authorization: 'Bearer same_origin_secret_token' } })

    const manager = createMcpManager({ db, secrets })
    activeManagers.push(manager)

    // Cross-origin 302 & 307 are rejected with connect_failed and NEVER hit evilOriginUrl
    let err302: unknown
    try {
      await manager.discoverTools(cross302Srv.id)
    } catch (err) {
      err302 = err
    }
    expect(err302).toBeInstanceOf(McpCallError)
    expect((err302 as McpCallError).code).toBe('connect_failed')
    expect((err302 as McpCallError).dispatched).toBe(false)
    expect((err302 as McpCallError).message).toMatch(/cross-origin/i)

    let err307: unknown
    try {
      await manager.callTool(cross307Srv.id, 'any_write', { x: 1 }, { write: true })
    } catch (err) {
      err307 = err
    }
    expect(err307).toBeInstanceOf(McpCallError)
    expect((err307 as McpCallError).code).toBe('connect_failed')
    expect((err307 as McpCallError).dispatched).toBe(false)
    expect(crossOriginHits).toEqual([])

    // Same-origin 307 redirect (/mcp -> /mcp-v2) succeeds and redacts echoed secrets in McpCallResult!
    const v2Tools = await manager.discoverTools(sameOriginSrv.id)
    expect(v2Tools.map((t) => t.name)).toEqual(['echo_v2'])

    const callRes = await manager.callTool(sameOriginSrv.id, 'echo_v2', { text: 'req1' }, { write: false })
    expect(callRes.isError).toBe(true)
    expect(JSON.stringify(callRes)).not.toContain('same_origin_secret_token')
    expect(callRes.content[0]).toEqual({
      type: 'text',
      text: 'Upstream error for req1 using [REDACTED]',
    })
    expect(callRes.content[1]).toEqual({
      type: 'resource',
      resource: {
        uri: 'mcp://log',
        text: 'Header was [REDACTED]',
      },
    })
    expect(callRes.structuredContent).toEqual({
      nested: { leakedHeader: '[REDACTED]' },
    })

    // Same-origin 302 redirect on legacy SSE GET (/sse -> /sse-v2) succeeds too
    const sseV2Tools = await manager.discoverTools(sameOriginLegacySrv.id)
    expect(sseV2Tools.map((t) => t.name)).toEqual(['sse_v2_tool'])
  })
})
