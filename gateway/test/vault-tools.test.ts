import { describe, expect, it } from 'vitest'
import { pageOperations, VaultFillError, type PageLike } from '../src/browser-page.js'
import { createFakeComputer } from '../src/computer.js'
import { openDb } from '../src/db.js'
import type { LLM, ToolCall } from '../src/llm.js'
import type { Pool } from '../src/pool.js'
import { createRoutine } from '../src/routines.js'
import { createApp } from '../src/server.js'
import { generateTotp } from '../src/vault/totp.js'

function makeMockPage(opts: {
  url: string
  elements: Record<string, { tag: string; type: string; autocomplete?: string; filled: string[] }>
}): { page: PageLike; setUrl: (next: string) => void } {
  let currentUrl = opts.url
  const makeEl = (key: string) => {
    const rec = opts.elements[key]
    return {
      async waitFor() {
        if (!rec) throw new Error(`missing ${key}`)
      },
      async evaluate<R>(fn: (el: unknown) => R): Promise<R> {
        if (!rec) throw new Error(`missing ${key}`)
        return fn({
          tagName: rec.tag.toUpperCase(),
          type: rec.type,
          getAttribute: (k: string) => (k === 'type' ? rec.type : k === 'autocomplete' ? (rec.autocomplete ?? null) : null),
        })
      },
      async fill(text: string) {
        if (!rec) throw new Error(`missing ${key}`)
        rec.filled.push(text)
      },
    }
  }
  const page: PageLike = {
    async goto(u: string) { currentUrl = u },
    async title() { return 'Login' },
    url() { return currentUrl },
    async innerText() { return '' },
    async screenshot() { return Buffer.alloc(1) },
    async click() {},
    locator: (sel) => ({ first: () => makeEl(sel) }),
    getByLabel: (label) => ({ first: () => makeEl(label) }),
    getByPlaceholder: (ph) => ({ first: () => makeEl(ph) }),
    keyboard: { async press() {} },
    viewportSize: () => ({ width: 1280, height: 800 }),
  }
  return { page, setUrl: (next) => { currentUrl = next } }
}

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

function makePool(computer: ReturnType<typeof createFakeComputer>): Pool {
  return {
    async get() { return computer },
    peek() { return Promise.resolve(computer) },
    async disposeAll() {},
    lastUsed: () => undefined,
    async forget() {},
    async retire() {},
  }
}

describe('browser_page fillSecret security invariants', () => {
  it('blocks non-password inputs for secret fields and blocks origin mismatch', async () => {
    const elements = {
      '#comment': { tag: 'textarea', type: 'text', filled: [] as string[] },
      '#password': { tag: 'input', type: 'password', filled: [] as string[] },
    }
    const { page, setUrl } = makeMockPage({ url: 'https://github.com/login', elements })
    const ops = pageOperations(async () => page)

    // Refuses filling password into a comment textarea on the same domain
    await expect(
      ops.fillSecret('#comment', 'TopSecret123', { expectedOrigin: 'https://github.com', requirePasswordInput: true }),
    ).rejects.toMatchObject({ code: 'not_password_input' })
    expect(elements['#comment'].filled).toEqual([])

    // Succeeds on real password input
    const res = await ops.fillSecret('#password', 'TopSecret123', {
      expectedOrigin: 'https://github.com',
      requirePasswordInput: true,
    })
    expect(res.origin).toBe('https://github.com')
    expect(elements['#password'].filled).toEqual(['TopSecret123'])

    // Refuses if page navigated to another origin (TOCTOU)
    setUrl('https://evil.example/phish')
    await expect(
      ops.fillSecret('#password', 'TopSecret123', { expectedOrigin: 'https://github.com', requirePasswordInput: true }),
    ).rejects.toMatchObject({ code: 'origin_mismatch' })
  })
})

describe('vault browser_fill_secret end-to-end tool, approval, and redaction', () => {
  const FIXED_NOW = 59_000 // RFC 6238 test timestamp
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

  function seedDb() {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('ops', 'Ops', 'Operations', '🛠', '', 1)`).run()
    db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:ops', 'dm', 'ops', 'Ops', 1)`).run()
    return db
  }

  it('fills allowed HTTPS login + live TOTP directly in clean operator turn, and redacts subsequent extract', async () => {
    const db = seedDb()
    const filledCalls: Array<{ target: string; value: string; requirePasswordInput?: boolean }> = []
    let currentUrl = 'https://app.zendesk.com/login'
    const computer = createFakeComputer({
      pageText: 'Welcome back! Debug echo: MySecretPass!77',
      async currentUrl() { return currentUrl },
      async fillSecret(target, value, opts) {
        filledCalls.push({ target, value, requirePasswordInput: opts.requirePasswordInput })
        return { origin: opts.expectedOrigin }
      },
    })
    const { llm, seenTools, seenToolResults } = scriptedLlm([
      {
        toolCalls: [
          { id: 'c1', name: 'browser_fill_secret', args: { item_id: 'zendesk', field: 'password', target: '#pw' } },
          { id: 'c2', name: 'browser_fill_secret', args: { item_id: 'zendesk', field: 'totp', target: '#otp', submit: true } },
          { id: 'c3', name: 'browser_extract', args: {} },
        ],
      },
      { content: 'Signed in.' },
    ])
    const gw = createApp({ db, llm, pool: makePool(computer), now: () => new Date(FIXED_NOW) })

    // Before granting, tool is not exposed
    const createdRes = await gw.app.request('/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Zendesk',
        slug: 'zendesk',
        kind: 'login',
        allowedDomains: ['app.zendesk.com'],
        approvalMode: 'on_taint',
        fields: [
          { key: 'password', kind: 'secret' },
          { key: 'totp', kind: 'totp' },
        ],
        values: { password: 'MySecretPass!77', totp: RFC_SECRET },
      }),
    })
    const { item } = (await createdRes.json()) as { item: { id: string } }
    await gw.app.request('/api/bots/ops/vault', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemIds: [item.id] }),
    })

    // Trigger operator turn
    await gw.app.request('/api/threads/dm:ops/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Sign into Zendesk' }),
    })
    // Wait for async turn queue
    await new Promise((r) => setTimeout(r, 40))

    expect(seenTools[0]).toContain('browser_fill_secret')
    expect(filledCalls).toEqual([
      { target: '#pw', value: 'MySecretPass!77', requirePasswordInput: true },
      { target: '#otp', value: generateTotp(RFC_SECRET, FIXED_NOW).code, requirePasswordInput: false },
    ])

    // Subsequent browser_extract redacted the secret before reaching the model
    const extractResult = seenToolResults.find((t) => t.includes('Welcome back!'))
    expect(extractResult).toBeDefined()
    expect(extractResult).toContain('[REDACTED]')
    expect(extractResult).not.toContain('MySecretPass!77')

    // Zero raw secret persisted anywhere in messages or actions
    const allMessages = JSON.stringify(db.prepare('SELECT * FROM messages').all())
    const allActions = JSON.stringify(db.prepare('SELECT * FROM actions').all())
    expect(allMessages).not.toContain('MySecretPass!77')
    expect(allActions).not.toContain('MySecretPass!77')
    currentUrl = 'https://other.test/'
    expect(currentUrl).toBe('https://other.test/')
  })

  it('holds for gateway-executed approval when approvalMode is always, rejects edit, and enforces TOCTOU origin on approve', async () => {
    const db = seedDb()
    let currentUrl = 'https://app.acme.test/login'
    const filledValues: string[] = []
    const computer = createFakeComputer({
      async currentUrl() { return currentUrl },
      async fillSecret(_target, value, opts) {
        if (!currentUrl.startsWith(opts.expectedOrigin)) {
          throw new VaultFillError('origin_mismatch', 'origin changed')
        }
        filledValues.push(value)
        return { origin: opts.expectedOrigin }
      },
    })
    const { llm } = scriptedLlm([
      {
        toolCalls: [
          { id: 'c1', name: 'browser_fill_secret', args: { item_id: 'acme_admin', field: 'password', target: '#pw' } },
        ],
      },
      { content: 'Waiting for approval.' },
      { content: 'Proceeding after vault fill.' },
    ])
    const gw = createApp({ db, llm, pool: makePool(computer), now: () => new Date(FIXED_NOW) })

    const createdRes = await gw.app.request('/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme Admin',
        slug: 'acme_admin',
        kind: 'login',
        allowedDomains: ['app.acme.test'],
        approvalMode: 'always',
        fields: [{ key: 'password', kind: 'secret' }],
        values: { password: 'AdminPassword#88' },
        botIds: ['ops'],
      }),
    })
    expect(createdRes.status).toBe(201)

    await gw.app.request('/api/threads/dm:ops/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Log in to Acme Admin' }),
    })
    await new Promise((r) => setTimeout(r, 40))

    // Nothing filled before approval
    expect(filledValues).toEqual([])
    const approval = db.prepare('SELECT * FROM approvals ORDER BY id DESC LIMIT 1').get() as {
      id: number
      status: string
      execution_json: string
    }
    expect(approval.status).toBe('pending')
    expect(approval.execution_json).not.toContain('AdminPassword#88')
    expect(JSON.parse(approval.execution_json)).toMatchObject({
      kind: 'vault_fill',
      field: 'password',
      expectedOrigin: 'https://app.acme.test',
    })

    // Editing a vault approval is refused
    const editRes = await gw.app.request(`/api/approvals/${approval.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', edit: { kind: 'prompt', action: 'changed' } }),
    })
    expect(editRes.status).toBe(400)

    // Approving on the exact origin executes the fill once
    const approveRes = await gw.app.request(`/api/approvals/${approval.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(approveRes.status).toBe(202)
    await new Promise((r) => setTimeout(r, 40))
    expect(filledValues).toEqual(['AdminPassword#88'])

    const settled = db.prepare('SELECT execution_status FROM approvals WHERE id = ?').get(approval.id) as {
      execution_status: string
    }
    expect(settled.execution_status).toBe('succeeded')
  })

  it('blocks approval execution if browser navigated to a different origin before operator clicked Approve', async () => {
    const db = seedDb()
    let currentUrl = 'https://app.acme.test/login'
    const filledValues: string[] = []
    const computer = createFakeComputer({
      async currentUrl() { return currentUrl },
      async fillSecret(_target, value, opts) {
        filledValues.push(value)
        return { origin: opts.expectedOrigin }
      },
    })
    const { llm } = scriptedLlm([
      {
        toolCalls: [
          { id: 'c1', name: 'browser_fill_secret', args: { item_id: 'acme_admin', field: 'password', target: '#pw' } },
        ],
      },
      { content: 'Waiting.' },
    ])
    const gw = createApp({ db, llm, pool: makePool(computer), now: () => new Date(FIXED_NOW) })
    await gw.app.request('/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme Admin',
        slug: 'acme_admin',
        kind: 'login',
        allowedDomains: ['app.acme.test', 'other.acme.test'],
        approvalMode: 'always',
        fields: [{ key: 'password', kind: 'secret' }],
        values: { password: 'AdminPassword#88' },
        botIds: ['ops'],
      }),
    })

    await gw.app.request('/api/threads/dm:ops/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Log in' }),
    })
    await new Promise((r) => setTimeout(r, 40))

    const approval = db.prepare('SELECT id FROM approvals ORDER BY id DESC LIMIT 1').get() as { id: number }
    // Browser navigates to a different allowed origin before approval!
    currentUrl = 'https://other.acme.test/phish'
    const approveRes = await gw.app.request(`/api/approvals/${approval.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(approveRes.status).toBe(202)
    expect(filledValues).toEqual([])
    const settled = db.prepare('SELECT execution_status, execution_detail FROM approvals WHERE id = ?').get(approval.id) as {
      execution_status: string
      execution_detail: string
    }
    expect(settled.execution_status).toBe('failed')
    expect(settled.execution_detail).toContain('navigated away')
  })

  it('forces approval for on_taint items during webhook-tainted turns and blocks watch routines from using vault fill', async () => {
    const db = seedDb()
    const filledValues: string[] = []
    const computer = createFakeComputer({
      async currentUrl() { return 'https://app.acme.test/login' },
      async fillSecret(_target, value, opts) {
        filledValues.push(value)
        return { origin: opts.expectedOrigin }
      },
    })
    const { llm, seenTools } = scriptedLlm([
      {
        toolCalls: [
          { id: 'c1', name: 'browser_fill_secret', args: { item_id: 'acme_taint', field: 'password', target: '#pw' } },
        ],
      },
      { content: 'Held due to taint.' },
    ])
    const gw = createApp({ db, llm, pool: makePool(computer), now: () => new Date(FIXED_NOW) })
    await gw.app.request('/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme Taint',
        slug: 'acme_taint',
        kind: 'login',
        allowedDomains: ['app.acme.test'],
        approvalMode: 'on_taint',
        fields: [{ key: 'password', kind: 'secret' }],
        values: { password: 'TaintedPassword#55' },
        botIds: ['ops'],
      }),
    })
    // Insert a webhook message into thread history to taint the turn as outside-data
    db.prepare(`INSERT INTO messages (thread_id, sender, kind, content, payload, created_at) VALUES ('dm:ops', 'webhook', 'webhook', '', '{}', 10)`).run()

    await gw.app.request('/api/threads/dm:ops/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Log in now' }),
    })
    await new Promise((r) => setTimeout(r, 40))

    expect(seenTools[0]).toContain('browser_fill_secret')
    expect(filledValues).toEqual([])
    const approval = db.prepare('SELECT status, execution_json FROM approvals ORDER BY id DESC LIMIT 1').get() as {
      status: string
      execution_json: string
    }
    expect(approval.status).toBe('pending')
    expect(JSON.parse(approval.execution_json)).toMatchObject({ kind: 'vault_fill', field: 'password' })

    // Now verify a watch routine never receives browser_fill_secret in its tool list
    const { llm: watchLlm, seenTools: watchTools } = scriptedLlm([{ content: 'Nothing new.' }])
    const gwWatch = createApp({ db, llm: watchLlm, pool: makePool(computer), now: () => new Date(FIXED_NOW) })
    const routine = createRoutine(db, { botId: 'ops', name: 'Watch', cron: '0 9 * * *', instructions: 'Check page', mode: 'watch' })
    await gwWatch.runRoutine(routine)
    expect(watchTools[0]).toBeDefined()
    expect(watchTools[0]).not.toContain('browser_fill_secret')
  })
})
