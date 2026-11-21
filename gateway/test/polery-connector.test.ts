import { describe, expect, it } from 'vitest'
import { createPoleryDriver } from '../src/connectors/polery-driver.js'
import { openDb } from '../src/db.js'
import type { LLM, ToolCall } from '../src/llm.js'
import { createApp } from '../src/server.js'

function scriptedLlm(steps: Array<{ content?: string; toolCalls?: ToolCall[] }>): {
  llm: LLM
  seenTools: string[][]
  seenToolResults: string[]
} {
  let idx = 0
  const seenTools: string[][] = []
  const seenToolResults: string[] = []
  const llm: LLM = {
    async chat(messages, tools) {
      seenTools.push((tools ?? []).map((t) => t.function.name))
      for (const m of messages) {
        if (m.role === 'tool' && typeof m.content === 'string') seenToolResults.push(m.content)
      }
      const next = steps[idx++] ?? { content: 'Done.' }
      const toolCalls = next.toolCalls ?? []
      return {
        content: next.content ?? (toolCalls.length ? null : 'Done.'),
        toolCalls,
        raw: { role: 'assistant', content: next.content ?? null, ...(toolCalls.length ? { tool_calls: [] } : {}) },
      }
    },
  }
  return { llm, seenTools, seenToolResults }
}

function seedDb() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('chief', 'Chief', 'Chief of Staff', '🧠', '', 1)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:chief', 'dm', 'chief', 'Chief', 1)`).run()
  return db
}

describe('Polery Docs native OAuth 2.1 + MCP connector', () => {
  it('connects natively without a Composio key via RFC 8414 + DCR + PKCE, then calls read tools and approval-gated write tools', async () => {
    const db = seedDb()
    const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = []
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : undefined
      const headers = new Headers(init?.headers)
      calls.push({ url, method, body, auth: headers.get('authorization') ?? undefined })

      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://docs.polery.com/oauth/authorize',
          token_endpoint: 'https://docs.polery.com/oauth/token',
          registration_endpoint: 'https://docs.polery.com/oauth/register',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/oauth/register')) {
        return new Response(JSON.stringify({ client_id: 'polery-client-123' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'polery_at_live',
          refresh_token: 'polery_rt_live',
          expires_in: 3000,
          token_type: 'Bearer',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/mcp')) {
        const rpc = JSON.parse(body ?? '{}') as { id: string; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }
        if (rpc.method === 'tools/call' && rpc.params?.name === 'list_documents') {
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [{ type: 'text', text: '1 document shared with the connector:\n- Q2 Roadmap (polery) · document_id: 11111111-1111-1111-1111-111111111111' }],
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (rpc.method === 'tools/call' && rpc.params?.name === 'create_document') {
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [{ type: 'text', text: 'Created Polery document "Brief" (document_id: 22222222-2222-2222-2222-222222222222).' }],
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }

    const poleryDriver = createPoleryDriver({ dataDir: '', origin: 'https://docs.polery.com', fetchImpl: fakeFetch, now: () => 100_000 })
    const { llm, seenTools, seenToolResults } = scriptedLlm([
      { toolCalls: [{ id: 'p1', name: 'polery_list_documents', args: {} }] },
      { toolCalls: [{ id: 'p2', name: 'polery_create_document', args: { title: 'Brief', markdown: '# Hello' } }] },
      { content: 'Held for your approval.' },
    ])

    // Note: NO Composio API key configured at all!
    const gw = createApp({ db, llm, poleryDriver, now: () => new Date(100_000) })

    const connectRes = await gw.app.request('/api/connectors/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'polery', botIds: ['chief'] }),
    })
    expect(connectRes.status).toBe(201)
    const connected = (await connectRes.json()) as { connectorId: string; redirectUrl: string; callbackUrl: string }
    const authUrl = new URL(connected.redirectUrl)
    expect(authUrl.origin).toBe('https://docs.polery.com')
    expect(authUrl.pathname).toBe('/oauth/authorize')
    expect(authUrl.searchParams.get('client_id')).toBe('polery-client-123')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('resource')).toBe('https://docs.polery.com/mcp')

    // Complete OAuth callback with authorization code
    const cbPath = new URL(connected.callbackUrl).pathname
    const cbRes = await gw.app.request(`${cbPath}?code=auth_code_xyz`)
    expect(cbRes.status).toBe(200)
    expect(await cbRes.text()).toContain('Polery Docs connected')

    // Verify account is active and granted to chief
    const snap = (await (await gw.app.request('/api/connectors')).json()) as {
      accounts: Array<{ id: string; app: string; status: string; accountLabel: string }>
      botGrants: Record<string, string[]>
    }
    expect(snap.accounts[0]).toMatchObject({ app: 'polery', status: 'active', accountLabel: 'docs.polery.com' })
    expect(snap.botGrants.chief).toContain(connected.connectorId)

    // Send a message to chief so it calls polery_list_documents (read) and polery_create_document (held for approval)
    await gw.app.request('/api/threads/dm:chief/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'List my Polery docs and create a Brief document' }),
    })
    await new Promise((r) => setTimeout(r, 80))

    expect(seenTools[0]).toContain('polery_list_documents')
    expect(seenTools[0]).toContain('polery_create_document')
    expect(seenToolResults.some((t) => t.includes('Q2 Roadmap'))).toBe(true)
    expect(seenToolResults.some((t) => t.includes('Held for operator approval'))).toBe(true)

    // Approve the held polery_create_document write and verify gateway executes it against /mcp
    const approvalRow = db.prepare(`SELECT id FROM approvals WHERE status = 'pending'`).get() as { id: number }
    const approveRes = await gw.app.request(`/api/approvals/${approvalRow.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(approveRes.status).toBe(202)
    await new Promise((r) => setTimeout(r, 40))

    const mcpCreateCall = calls.find((c) => c.url.endsWith('/mcp') && c.body?.includes('create_document'))
    expect(mcpCreateCall).toBeDefined()
    expect(mcpCreateCall?.auth).toBe('Bearer polery_at_live')
    const settled = db.prepare(`SELECT execution_status, execution_detail FROM approvals WHERE id = ?`).get(approvalRow.id) as {
      execution_status: string
      execution_detail: string
    }
    expect(settled.execution_status).toBe('succeeded')
    expect(settled.execution_detail).toContain('Created Polery document "Brief"')
  })
})
