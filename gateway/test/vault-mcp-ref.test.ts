import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { createMcpManager } from '../src/mcp/client.js'
import { createMcpSecretVault } from '../src/mcp/secrets.js'
import { createMcpServer } from '../src/mcp/store.js'
import { createVaultSecretStore } from '../src/vault/secrets.js'
import { createVaultItem } from '../src/vault/store.js'

describe('MCP ${vault:slug.field} secret references and redaction', () => {
  it('resolves vault references in HTTP MCP headers and redacts vault secrets from tool outputs', async () => {
    const db = openDb(':memory:')
    const vaultSecrets = createVaultSecretStore('')
    const mcpSecrets = createMcpSecretVault('')

    const vaultItem = createVaultItem(db, {
      name: 'GitHub Read-Only',
      slug: 'github_ro',
      kind: 'api_secret',
      fields: [{ key: 'token', kind: 'secret' }],
    })
    vaultSecrets.patch(vaultItem.id, { token: 'ghp_VaultSuperToken987654' })

    const server = createMcpServer(db, {
      name: 'GitHub MCP',
      transport: 'http',
      url: 'https://mcp.example.test/rpc',
      headerKeys: ['Authorization'],
    })
    mcpSecrets.patch(server.id, {
      headers: { Authorization: 'Bearer ${vault:github_ro.token}' },
    })

    const receivedAuthHeaders: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers)
      const auth = headers.get('authorization')
      if (auth) receivedAuthHeaders.push(auth)
      const req = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string }
      if (req.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'gh', version: '1.0' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (req.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (req.method === 'tools/call') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: 'echo token=ghp_VaultSuperToken987654' }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const manager = createMcpManager({ db, secrets: mcpSecrets, vaultSecrets, fetchImpl })
    const res = await manager.callTool(server.id, 'ping', {}, { write: false })

    expect(receivedAuthHeaders.length).toBeGreaterThan(0)
    expect(receivedAuthHeaders[0]).toBe('Bearer ghp_VaultSuperToken987654')
    const outText = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
    expect(outText).toContain('[REDACTED]')
    expect(outText).not.toContain('ghp_VaultSuperToken987654')

    await manager.closeAll()
  })

  it('rejects TOTP vault fields or unknown vault slugs referenced from MCP headers', async () => {
    const db = openDb(':memory:')
    const vaultSecrets = createVaultSecretStore('')
    const mcpSecrets = createMcpSecretVault('')

    const item = createVaultItem(db, {
      name: 'Acme Login',
      slug: 'acme',
      kind: 'login',
      allowedDomains: ['acme.test'],
      fields: [{ key: 'totp', kind: 'totp' }],
    })
    vaultSecrets.patch(item.id, { totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' })

    const server = createMcpServer(db, {
      name: 'Bad Ref',
      transport: 'http',
      url: 'https://mcp.example.test/rpc',
      headerKeys: ['X-Otp'],
    })
    mcpSecrets.patch(server.id, { headers: { 'X-Otp': '${vault:acme.totp}' } })

    const manager = createMcpManager({ db, secrets: mcpSecrets, vaultSecrets })
    await expect(manager.discoverTools(server.id)).rejects.toThrow(/TOTP/i)
    await manager.closeAll()
  })
})
