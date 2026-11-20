import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, upsertBot } from '../src/db.js'
import { parseMcpServersImportJson } from '../src/mcp/api.js'
import { computeExposedToolNames, effectiveToolMode, isMcpToolName } from '../src/mcp/naming.js'
import { saveMcpDiscoveredTools, markMcpServerStatus } from '../src/mcp/store.js'
import type { McpDiscoveredTool, McpManager } from '../src/mcp/types.js'
import { createApp } from '../src/server.js'

const okLlm = {
  chat: async () => ({ content: 'ok', toolCalls: [], raw: { role: 'assistant' as const, content: 'ok' } }),
}

function createStubMcpManager(
  db: ReturnType<typeof openDb>,
  handlers: {
    onDiscover?: (serverId: string) => Promise<McpDiscoveredTool[]> | McpDiscoveredTool[]
  } = {},
): McpManager & {
  discovered: string[]
  disconnected: string[]
  closedAllCount: () => number
} {
  const discovered: string[] = []
  const disconnected: string[] = []
  let closedAll = 0

  return {
    discovered,
    disconnected,
    closedAllCount: () => closedAll,
    async discoverTools(serverId: string): Promise<McpDiscoveredTool[]> {
      discovered.push(serverId)
      try {
        const tools = handlers.onDiscover ? await handlers.onDiscover(serverId) : []
        saveMcpDiscoveredTools(db, serverId, tools)
        return tools
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        markMcpServerStatus(db, serverId, 'error', msg)
        throw err
      }
    },
    async ensureDiscovered() {
      return null
    },
    async callTool() {
      return { content: [] }
    },
    async disconnect(serverId: string): Promise<void> {
      disconnected.push(serverId)
    },
    async closeAll(): Promise<void> {
      closedAll += 1
    },
  }
}

describe('mcp tool naming & 3-tier read/write policy (naming.ts)', () => {
  it('identifies mcp__* tool names and builds collision-free <=64-char exposed names', () => {
    expect(isMcpToolName('mcp__linear__get_issue')).toBe(true)
    expect(isMcpToolName('mail_list')).toBe(false)
    expect(isMcpToolName('shell')).toBe(false)

    const longRaw = `super_long_enterprise_action_${'x'.repeat(70)}`
    const map = computeExposedToolNames('twenty_char_srv_slug', [
      { name: 'get-issue' },
      { name: 'get_issue' },
      { name: '   !!!   ' },
      { name: longRaw },
    ])

    expect(map.get('get-issue')).toBe('mcp__twenty_char_srv_slug__get_issue')

    const colliding = map.get('get_issue')!
    const expectedCollisionHash = createHash('sha256').update('get_issue').digest('hex').slice(0, 4)
    expect(colliding).toBe(`mcp__twenty_char_srv_slug__get_issue_${expectedCollisionHash}`)
    expect(colliding.length).toBeLessThanOrEqual(64)

    expect(map.get('   !!!   ')).toBe('mcp__twenty_char_srv_slug__tool')

    const truncated = map.get(longRaw)!
    const expectedLongHash = createHash('sha256').update(longRaw).digest('hex').slice(0, 4)
    expect(truncated.length).toBe(64)
    expect(truncated.endsWith(`_${expectedLongHash}`)).toBe(true)
    expect(truncated).toMatch(/^mcp__[a-z0-9_]+$/)
  })

  it('resolves 3-tier effectiveToolMode fail-safe to write unless overridden or trusted non-destructive readOnlyHint', () => {
    const roTool = { name: 'list_items', readOnlyHint: true, destructiveHint: false }
    const roButDestructive = { name: 'purge_items', readOnlyHint: true, destructiveHint: true }
    const writeTool = { name: 'create_item', readOnlyHint: false, destructiveHint: false }

    // Default untrusted server: everything is write
    expect(effectiveToolMode({ trustReadOnlyHint: false, toolPolicies: {} }, roTool)).toBe('write')
    expect(effectiveToolMode({ trustReadOnlyHint: false, toolPolicies: {} }, writeTool)).toBe('write')

    // Trusted readOnlyHint: readOnly && !destructive -> read; destructive stays write
    expect(effectiveToolMode({ trustReadOnlyHint: true, toolPolicies: {} }, roTool)).toBe('read')
    expect(effectiveToolMode({ trustReadOnlyHint: true, toolPolicies: {} }, roButDestructive)).toBe('write')
    expect(effectiveToolMode({ trustReadOnlyHint: true, toolPolicies: {} }, writeTool)).toBe('write')

    // Operator overrides always win in both directions
    expect(
      effectiveToolMode({ trustReadOnlyHint: true, toolPolicies: { list_items: 'write' } }, roTool),
    ).toBe('write')
    expect(
      effectiveToolMode({ trustReadOnlyHint: false, toolPolicies: { purge_items: 'read' } }, roButDestructive),
    ).toBe('read')
  })
})

describe('parseMcpServersImportJson', () => {
  it('parses Claude/Cursor mcpServers wrapper, flat maps, serverUrl alias, and per-entry validation errors', () => {
    const raw = JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          env: { FS_TOKEN: 'secret_fs_123' },
        },
        linear: {
          serverUrl: 'https://mcp.linear.app/mcp',
          headers: { Authorization: 'Bearer lin_secret_456' },
        },
        badProtocol: {
          url: 'ftp://example.com/mcp',
        },
        badHeader: {
          url: 'https://api.example.com/mcp',
          headers: { Host: 'evil.example.com' },
        },
        missingTransport: {
          env: { A: '1' },
        },
      },
    })

    const parsed = parseMcpServersImportJson(raw)
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.entries[0]).toMatchObject({
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { FS_TOKEN: 'secret_fs_123' },
    })
    expect(parsed.entries[1]).toMatchObject({
      name: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer lin_secret_456' },
    })
    expect(parsed.errors.map((e) => e.name)).toEqual(['badProtocol', 'badHeader', 'missingTransport'])

    // Flat map without mcpServers wrapper
    const flat = parseMcpServersImportJson(
      JSON.stringify({
        github: { command: 'uvx', args: ['mcp-server-github'] },
      }),
    )
    expect(flat.entries).toHaveLength(1)
    expect(flat.entries[0]?.name).toBe('github')
    expect(flat.errors).toEqual([])

    // Invalid top-level JSON or >20 servers throws
    expect(() => parseMcpServersImportJson('{bad json')).toThrow()
    const twentyOne = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`s${i}`, { url: `https://s${i}.example.com/mcp` }]),
    )
    expect(() => parseMcpServersImportJson(JSON.stringify({ mcpServers: twentyOne }))).toThrow(/20/)
  })
})

describe('MCP HTTP API (/api/mcp/*, /api/bots/:botId/mcp, /api/bots/:botId/computer)', () => {
  it('supports CRUD, secret masking, error-preserving discovery, partial PATCH, test refresh, bidirectional grants, and DELETE', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'osb-mcp-api-'))
    const db = openDb(':memory:')
    upsertBot(db, { id: 'coder', name: 'Builder', role: 'dev', emoji: '🛠', soul_path: '' })
    upsertBot(db, { id: 'scout', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })

    let failDiscovery = false
    let nextTools: McpDiscoveredTool[] = [
      {
        name: 'get_issue',
        description: 'Read a Linear issue',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        readOnlyHint: true,
        destructiveHint: false,
      },
      {
        name: 'delete_issue',
        description: 'Delete an issue',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        readOnlyHint: true,
        destructiveHint: true,
      },
    ]

    const manager = createStubMcpManager(db, {
      onDiscover: async () => {
        if (failDiscovery) throw new Error('Connection refused to upstream MCP')
        return nextTools
      },
    })

    const gw = createApp({ db, llm: okLlm, dataDir, env: {}, mcpManager: manager })
    const events: Array<{ type: string }> = []
    gw.hub.add({ send: (raw) => events.push(JSON.parse(raw)) })

    // 1. GET /api/mcp/servers starts empty
    const initRes = await gw.app.request('http://127.0.0.1:4747/api/mcp/servers')
    expect(initRes.status).toBe(200)
    expect(await initRes.json()).toEqual({
      servers: [],
      botGrants: { coder: [], scout: [] },
    })

    // 2. Validation failures on POST /api/mcp/servers
    const badUrl = await gw.app.request('http://127.0.0.1:4747/api/mcp/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad URL', transport: 'http', url: 'https://user:pass@example.com/mcp' }),
    })
    expect(badUrl.status).toBe(400)

    const badHeader = await gw.app.request('http://127.0.0.1:4747/api/mcp/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad Header',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { 'Content-Length': '99' },
      }),
    })
    expect(badHeader.status).toBe(400)

    const badCmd = await gw.app.request('http://127.0.0.1:4747/api/mcp/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad Stdio', transport: 'stdio', command: '   ' }),
    })
    expect(badCmd.status).toBe(400)

    // 3. POST /api/mcp/servers creates HTTP server, masks headers, runs discoverTools by default
    const createHttpRes = await gw.app.request('http://127.0.0.1:4747/api/mcp/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Linear',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        headers: {
          Authorization: 'Bearer lin_api_super_secret_token_999',
          'X-Workspace': 'ws_secret_value_888',
        },
        botIds: ['coder'],
      }),
    })
    expect(createHttpRes.status).toBe(201)
    const createdHttp = (await createHttpRes.json()).server
    expect(createdHttp).toMatchObject({
      name: 'Linear',
      slug: 'linear',
      transport: 'http',
      enabled: true,
      url: 'https://mcp.linear.app/mcp',
      headerKeys: ['Authorization', 'X-Workspace'],
      trustReadOnlyHint: false,
      status: 'connected',
      grantedBotIds: ['coder'],
    })
    expect(createdHttp.headersMasked.Authorization).not.toContain('super_secret_token')
    expect(createdHttp.headersMasked['X-Workspace']).not.toContain('ws_secret_value')
    expect(createdHttp.tools).toEqual([
      expect.objectContaining({
        name: 'get_issue',
        exposedName: 'mcp__linear__get_issue',
        overrideMode: null,
        effectiveMode: 'write',
      }),
      expect.objectContaining({
        name: 'delete_issue',
        exposedName: 'mcp__linear__delete_issue',
        overrideMode: null,
        effectiveMode: 'write',
      }),
    ])
    expect(manager.discovered).toEqual([createdHttp.id])

    // Verify 0600 secret file on disk
    const secretFile = join(dataDir, 'mcp-secrets.json')
    if (process.platform !== 'win32') {
      expect(statSync(secretFile).mode & 0o777).toBe(0o600)
    }

    // 4. POST /api/mcp/servers keeps saved server with status: 'error' if initial discovery fails
    failDiscovery = true
    const createErrRes = await gw.app.request('http://127.0.0.1:4747/api/mcp/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Local FS',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: { FS_SECRET: 'fs_secret_value_123456', KEEP_ME: 'keep_secret_value_654321' },
      }),
    })
    expect(createErrRes.status).toBe(201)
    const createdStdio = (await createErrRes.json()).server
    expect(createdStdio.status).toBe('error')
    expect(createdStdio.lastError).toContain('Connection refused')
    expect(createdStdio.envKeys).toEqual(['FS_SECRET', 'KEEP_ME'])
    expect(createdStdio.envMasked.FS_SECRET).not.toContain('fs_secret_value')
    expect(createdStdio.grantedBotIds).toEqual([])

    // 5. PATCH /api/mcp/servers/:id updates trustReadOnlyHint, toolPolicies ('read' | 'write' | 'default'),
    //    partial headers/env without wiping untouched secrets, and disconnects active session
    const patchHttpRes = await gw.app.request(`http://127.0.0.1:4747/api/mcp/servers/${createdHttp.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trustReadOnlyHint: true,
        toolPolicies: { delete_issue: 'read' },
        headers: { 'X-Workspace': null, 'X-New': 'new_header_secret_777' },
      }),
    })
    expect(patchHttpRes.status).toBe(200)
    const patchedHttp = (await patchHttpRes.json()).server
    expect(manager.disconnected).toContain(createdHttp.id)
    expect(patchedHttp.trustReadOnlyHint).toBe(true)
    expect(patchedHttp.headerKeys).toEqual(['Authorization', 'X-New'])
    // Untouched Authorization secret is still present!
    expect(patchedHttp.headersMasked.Authorization).toBe(createdHttp.headersMasked.Authorization)
    expect(patchedHttp.headersMasked['X-Workspace']).toBeUndefined()
    expect(patchedHttp.headersMasked['X-New']).toBeDefined()
    expect(patchedHttp.tools).toEqual([
      expect.objectContaining({
        name: 'get_issue',
        overrideMode: null,
        effectiveMode: 'read', // via trustReadOnlyHint
      }),
      expect.objectContaining({
        name: 'delete_issue',
        overrideMode: 'read',
        effectiveMode: 'read', // via explicit override
      }),
    ])

    // Resetting toolPolicies override with 'default' falls back to server rule (destructiveHint -> write)
    const resetPolicyRes = await gw.app.request(`http://127.0.0.1:4747/api/mcp/servers/${createdHttp.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        toolPolicies: { delete_issue: 'default', get_issue: 'write' },
      }),
    })
    expect(resetPolicyRes.status).toBe(200)
    const resetPolicyServer = (await resetPolicyRes.json()).server
    expect(resetPolicyServer.toolPolicies).toEqual({ get_issue: 'write' })
    expect(resetPolicyServer.tools).toEqual([
      expect.objectContaining({ name: 'get_issue', overrideMode: 'write', effectiveMode: 'write' }),
      expect.objectContaining({ name: 'delete_issue', overrideMode: null, effectiveMode: 'write' }),
    ])

    // Partial env patch on stdio server preserves KEEP_ME and updates enabled: false
    const patchStdioRes = await gw.app.request(`http://127.0.0.1:4747/api/mcp/servers/${createdStdio.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        env: { FS_SECRET: '' },
      }),
    })
    expect(patchStdioRes.status).toBe(200)
    const patchedStdio = (await patchStdioRes.json()).server
    expect(patchedStdio.enabled).toBe(false)
    expect(patchedStdio.envKeys).toEqual(['KEEP_ME'])
    expect(patchedStdio.envMasked.KEEP_ME).toBe(createdStdio.envMasked.KEEP_ME)

    // 6. POST /api/mcp/servers/:id/test reconnects & refreshes tools
    failDiscovery = false
    nextTools = [
      {
        name: 'read_file',
        description: 'Read file content',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        readOnlyHint: true,
        destructiveHint: false,
      },
    ]
    const testRes = await gw.app.request(`http://127.0.0.1:4747/api/mcp/servers/${createdStdio.id}/test`, {
      method: 'POST',
    })
    expect(testRes.status).toBe(200)
    const testedStdio = (await testRes.json()).server
    expect(testedStdio.status).toBe('connected')
    expect(testedStdio.lastError).toBe('')
    expect(testedStdio.tools).toEqual([
      expect.objectContaining({
        name: 'read_file',
        exposedName: 'mcp__local_fs__read_file',
        overrideMode: null,
        effectiveMode: 'write',
      }),
    ])

    // 7. Bidirectional bot grants: PUT /api/mcp/servers/:id/bots & PUT /api/bots/:botId/mcp + computer view
    events.length = 0
    const putServerBots = await gw.app.request(`http://127.0.0.1:4747/api/mcp/servers/${createdHttp.id}/bots`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botIds: ['coder', 'scout', 'nonexistent'] }),
    })
    expect(putServerBots.status).toBe(200)
    expect(events.some((e) => e.type === 'mcp_changed')).toBe(true)

    const compScout1 = await (await gw.app.request('http://127.0.0.1:4747/api/bots/scout/computer')).json()
    expect(compScout1.mcpServers).toEqual([
      {
        id: createdHttp.id,
        name: 'Linear',
        slug: 'linear',
        transport: 'http',
        enabled: true,
        status: 'connected',
        toolCount: 2,
        granted: true,
      },
      {
        id: createdStdio.id,
        name: 'Local FS',
        slug: 'local_fs',
        transport: 'stdio',
        enabled: false,
        status: 'connected',
        toolCount: 1,
        granted: false,
      },
    ])

    events.length = 0
    const putBotMcp = await gw.app.request('http://127.0.0.1:4747/api/bots/scout/mcp', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverIds: [createdStdio.id, 'mcp-deadbeef'] }),
    })
    expect(putBotMcp.status).toBe(200)
    expect(await putBotMcp.json()).toEqual({ botId: 'scout', serverIds: [createdStdio.id] })
    expect(events.some((e) => e.type === 'mcp_changed')).toBe(true)

    const snapAfterGrants = await (await gw.app.request('http://127.0.0.1:4747/api/mcp/servers')).json()
    expect(snapAfterGrants.botGrants).toEqual({
      coder: [createdHttp.id],
      scout: [createdStdio.id],
    })

    // 8. DELETE /api/mcp/servers/:id disconnects, removes DB rows & secrets, and broadcasts mcp_changed
    events.length = 0
    const delRes = await gw.app.request(`http://127.0.0.1:4747/api/mcp/servers/${createdStdio.id}`, {
      method: 'DELETE',
    })
    expect(delRes.status).toBe(200)
    expect(events.some((e) => e.type === 'mcp_changed')).toBe(true)
    expect(readFileSync(secretFile, 'utf8')).not.toContain('keep_secret_value_654321')

    const snapAfterDel = await (await gw.app.request('http://127.0.0.1:4747/api/mcp/servers')).json()
    expect(snapAfterDel.servers.map((s: { id: string }) => s.id)).toEqual([createdHttp.id])
    expect(snapAfterDel.botGrants.scout).toEqual([])

    expect((await gw.app.request(`http://127.0.0.1:4747/api/mcp/servers/${createdStdio.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await gw.app.request(`http://127.0.0.1:4747/api/mcp/servers/${createdStdio.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })).status).toBe(404)
    expect((await gw.app.request(`http://127.0.0.1:4747/api/mcp/servers/${createdStdio.id}/test`, { method: 'POST' })).status).toBe(404)
    expect((await gw.app.request(`http://127.0.0.1:4747/api/mcp/servers/${createdStdio.id}/bots`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botIds: [] }),
    })).status).toBe(404)
    expect((await gw.app.request('http://127.0.0.1:4747/api/bots/unknown-bot/mcp', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverIds: [] }),
    })).status).toBe(404)

    // connectNow: false skips initial discovery
    const discoveredBefore = manager.discovered.length
    const deferredRes = await gw.app.request('http://127.0.0.1:4747/api/mcp/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Deferred Server',
        transport: 'http',
        url: 'https://deferred.example.com/mcp',
        connectNow: false,
      }),
    })
    expect(deferredRes.status).toBe(201)
    expect((await deferredRes.json()).server.status).toBe('disconnected')
    expect(manager.discovered.length).toBe(discoveredBefore)

    // 9. stopAll() closes all MCP sessions
    gw.stopAll()
    expect(manager.closedAllCount()).toBe(1)
  })

  it('batch-imports Claude Desktop / Cursor mcpServers JSON, masks secrets, grants bots, and reports per-entry errors', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'osb-mcp-import-'))
    const db = openDb(':memory:')
    upsertBot(db, { id: 'coder', name: 'Builder', role: 'dev', emoji: '🛠', soul_path: '' })
    const manager = createStubMcpManager(db, {
      onDiscover: async () => [
        {
          name: 'ping',
          description: 'Ping server',
          inputSchema: { type: 'object', properties: {} },
          readOnlyHint: true,
          destructiveHint: false,
        },
      ],
    })
    const TOKEN = 'mcp-gateway-auth-token-12345'
    const gw = createApp({ db, llm: okLlm, dataDir, env: {}, token: TOKEN, mcpManager: manager })

    // Unauthenticated access rejected
    expect((await gw.app.request('http://127.0.0.1:4747/api/mcp/servers')).status).toBe(401)

    const authHeaders = {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      host: '127.0.0.1:4747',
      origin: 'http://127.0.0.1:4747',
    }

    const importRes = await gw.app.request('http://127.0.0.1:4747/api/mcp/servers/import', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        botIds: ['coder'],
        trustReadOnlyHint: true,
        json: JSON.stringify({
          mcpServers: {
            filesystem: {
              command: 'npx',
              args: ['-y', 'pkg'],
              env: { KEY: 'val_secret_123456' },
            },
            linear: {
              url: 'https://mcp.linear.app/mcp',
              headers: { Authorization: 'Bearer secret_linear_987654' },
            },
            invalidEntry: {
              url: 'not-a-valid-url',
            },
          },
        }),
      }),
    })
    expect(importRes.status).toBe(200)
    const body = await importRes.json()
    expect(body.imported).toHaveLength(2)
    expect(body.errors).toEqual([
      expect.objectContaining({ name: 'invalidEntry' }),
    ])

    const [fsSrv, linSrv] = body.imported
    expect(fsSrv).toMatchObject({
      name: 'filesystem',
      slug: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      envKeys: ['KEY'],
      trustReadOnlyHint: true,
      status: 'connected',
      grantedBotIds: ['coder'],
    })
    expect(fsSrv.envMasked.KEY).not.toContain('val_secret')
    expect(fsSrv.tools[0]).toMatchObject({
      name: 'ping',
      exposedName: 'mcp__filesystem__ping',
      effectiveMode: 'read',
    })

    expect(linSrv).toMatchObject({
      name: 'linear',
      slug: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      headerKeys: ['Authorization'],
      trustReadOnlyHint: true,
      status: 'connected',
      grantedBotIds: ['coder'],
    })
    expect(linSrv.headersMasked.Authorization).not.toContain('secret_linear')
  })
})
