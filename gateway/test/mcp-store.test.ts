import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, schemaVersion, upsertBot } from '../src/db.js'
import { createHub } from '../src/hub.js'
import { createMcpSecretVault } from '../src/mcp/secrets.js'
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  isMcpServerId,
  listAllBotMcpGrants,
  listBotMcpServerIds,
  listBotMcpServersAllStatuses,
  listEnabledBotMcpServers,
  listMcpServers,
  markMcpServerStatus,
  normalizeMcpSlug,
  saveMcpDiscoveredTools,
  setBotMcpServers,
  setMcpServerBots,
  updateMcpServer,
} from '../src/mcp/store.js'
import { McpCallError } from '../src/mcp/types.js'

describe('mcp store & secrets vault', () => {
  it('migrates to v13, deduplicates slugs, and enforces default zero teammate grants', () => {
    const db = openDb(':memory:')
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(13)
    upsertBot(db, { id: 'coder', name: 'Builder', role: 'dev', emoji: '🛠', soul_path: '' })
    upsertBot(db, { id: 'scout', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })

    expect(normalizeMcpSlug('GitHub Enterprise MCP!')).toBe('github_enterprise_mc')

    const s1 = createMcpServer(db, {
      name: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      envKeys: ['GITHUB_TOKEN'],
      now: 1000,
    })
    const s2 = createMcpServer(db, {
      name: 'GitHub',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headerKeys: ['Authorization'],
      trustReadOnlyHint: true,
      now: 1001,
    })

    expect(s1.id).toMatch(/^mcp-[0-9a-f]{8}$/)
    expect(isMcpServerId(s1.id)).toBe(true)
    expect(isMcpServerId('ca-12345678')).toBe(false)
    expect(s1.slug).toBe('github')
    expect(s2.slug).toBe('github_2')
    expect(listEnabledBotMcpServers(db, 'coder')).toEqual([])

    setBotMcpServers(db, 'coder', [s1.id, s2.id], 1002)
    expect(listEnabledBotMcpServers(db, 'coder').map((s) => s.id)).toEqual([s1.id, s2.id])
    expect(listBotMcpServerIds(db, 'coder')).toEqual([s1.id, s2.id].sort())
    expect(listEnabledBotMcpServers(db, 'scout')).toEqual([])

    updateMcpServer(db, s1.id, { enabled: false, toolPolicies: { create_issue: 'write', get_issue: 'read' } }, 1003)
    expect(listEnabledBotMcpServers(db, 'coder').map((s) => s.id)).toEqual([s2.id])
    expect(listBotMcpServersAllStatuses(db, 'coder').map((s) => s.id)).toEqual([s1.id, s2.id])
    expect(getMcpServer(db, s1.id)?.toolPolicies).toEqual({ create_issue: 'write', get_issue: 'read' })

    saveMcpDiscoveredTools(db, s2.id, [
      {
        name: 'list_issues',
        description: 'List open issues',
        inputSchema: { type: 'object', properties: {} },
        readOnlyHint: true,
        destructiveHint: false,
      },
    ], 1004)
    expect(getMcpServer(db, s2.id)?.status).toBe('connected')
    expect(getMcpServer(db, s2.id)?.tools).toHaveLength(1)

    markMcpServerStatus(db, s2.id, 'error', 'connection refused', 1005)
    expect(getMcpServer(db, s2.id)?.lastError).toBe('connection refused')

    setMcpServerBots(db, s2.id, ['scout'], 1006)
    expect(listAllBotMcpGrants(db)).toEqual({ coder: [s1.id], scout: [s2.id] })

    expect(deleteMcpServer(db, s2.id)).toBe(true)
    expect(listMcpServers(db).map((s) => s.id)).toEqual([s1.id])
    expect(listAllBotMcpGrants(db).scout).toEqual([])
  })

  it('handles 20-char slug collisions, fallback slugs, invalid IDs, and mcp_changed hub events', () => {
    const db = openDb(':memory:')
    expect(normalizeMcpSlug('   !!!   ')).toBe('server')

    const a = createMcpServer(db, {
      name: 'twenty_character_mcp_server_name',
      transport: 'http',
      url: 'https://a.example.com/mcp',
      now: 10,
    })
    const b = createMcpServer(db, {
      name: 'twenty_character_mcp_server_name',
      transport: 'http',
      url: 'https://b.example.com/mcp',
      now: 11,
    })
    const c = createMcpServer(db, {
      name: 'twenty_character_mcp_server_name',
      transport: 'http',
      url: 'https://c.example.com/mcp',
      now: 12,
    })
    expect(a.slug.length).toBeLessThanOrEqual(20)
    expect(b.slug).toBe(`${a.slug.slice(0, 17)}_2`)
    expect(c.slug).toBe(`${a.slug.slice(0, 17)}_3`)

    expect(getMcpServer(db, 'not-an-id')).toBeNull()
    expect(updateMcpServer(db, 'mcp-00000000', { name: 'Nope' })).toBeNull()
    expect(deleteMcpServer(db, 'not-an-id')).toBe(false)

    const hub = createHub()
    const frames: string[] = []
    hub.add({ send: (d) => frames.push(d) })
    hub.broadcast({ type: 'mcp_changed' })
    expect(frames).toEqual([JSON.stringify({ type: 'mcp_changed' })])

    const err = new McpCallError('uncertain_write', 'stream closed mid-flight', true)
    expect(err.code).toBe('uncertain_write')
    expect(err.dispatched).toBe(true)
    expect(err.message).toBe('stream closed mid-flight')
  })

  it('stores secrets in 0600 mcp-secrets.json, preserves omitted keys on patch, masks values, and redacts errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osb-mcp-secrets-'))
    const vault = createMcpSecretVault(dir)

    vault.patch('mcp-11112222', {
      env: { GITHUB_TOKEN: 'ghp_secret_value_123456', EXTRA_KEY: 'extra_secret_9876' },
      headers: { Authorization: 'Bearer lin_api_abcdef123456' },
    })

    const file = join(dir, 'mcp-secrets.json')
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }

    // Partial patch keeps GITHUB_TOKEN, removes EXTRA_KEY, updates Authorization
    vault.patch('mcp-11112222', {
      env: { EXTRA_KEY: null },
      headers: { 'X-Custom': 'custom_token_9999' },
    })

    const reloaded = createMcpSecretVault(dir)
    expect(reloaded.get('mcp-11112222')).toEqual({
      env: { GITHUB_TOKEN: 'ghp_secret_value_123456' },
      headers: {
        Authorization: 'Bearer lin_api_abcdef123456',
        'X-Custom': 'custom_token_9999',
      },
    })

    const masked = reloaded.masked('mcp-11112222')
    expect(masked.envMasked.GITHUB_TOKEN).not.toContain('secret_value')
    expect(masked.headersMasked.Authorization).not.toContain('lin_api_abcdef')

    const dirty = 'Failed with token ghp_secret_value_123456 and Bearer lin_api_abcdef123456 (raw lin_api_abcdef123456)'
    expect(reloaded.redactText('mcp-11112222', dirty)).not.toContain('ghp_secret_value_123456')
    expect(reloaded.redactText('mcp-11112222', dirty)).not.toContain('lin_api_abcdef123456')

    reloaded.remove('mcp-11112222')
    expect(reloaded.get('mcp-11112222')).toEqual({ env: {}, headers: {} })
    expect(readFileSync(file, 'utf8')).not.toContain('ghp_secret_value_123456')
  })

  it('supports in-memory vault mode when dataDir is empty and treats empty string patch as deletion', () => {
    const mem = createMcpSecretVault('')
    mem.patch('mcp-aaaaaaaa', {
      env: { API_TOKEN: 'super_secret_token_99', SHORT: 'abc' },
      headers: { Authorization: 'Bearer tok_987654321' },
    })
    expect(mem.get('mcp-aaaaaaaa')).toEqual({
      env: { API_TOKEN: 'super_secret_token_99', SHORT: 'abc' },
      headers: { Authorization: 'Bearer tok_987654321' },
    })
    // Short values (< 4 chars) are not over-redacted across arbitrary words
    expect(mem.redactText('mcp-aaaaaaaa', 'abc failed with tok_987654321')).toBe('abc failed with [REDACTED]')

    mem.patch('mcp-aaaaaaaa', { env: { API_TOKEN: '' } })
    expect(mem.get('mcp-aaaaaaaa').env.API_TOKEN).toBeUndefined()
    mem.remove('mcp-aaaaaaaa')
    expect(mem.get('mcp-aaaaaaaa')).toEqual({ env: {}, headers: {} })
  })
})
