import { describe, expect, it } from 'vitest'
import type { PageLike } from '../src/browser-page.js'
import { createFakeComputer } from '../src/computer.js'
import { openDb } from '../src/db.js'
import type { LLM } from '../src/llm.js'
import type { Pool } from '../src/pool.js'
import { createApp } from '../src/server.js'
import { generateTotp } from '../src/vault/totp.js'
import { parseWorkflowTrace, saveWorkflowTrace } from '../src/workflows.js'

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const FIXED_NOW = 59_000

function makeWorkflowPage(initialUrl: string, fields: Record<string, { tag: string; type: string; filled: string[] }>): PageLike {
  let url = initialUrl
  const wrap = (key: string) => ({
    async waitFor() {
      if (!fields[key]) throw new Error(`missing ${key}`)
    },
    async evaluate<R>(fn: (el: unknown) => R): Promise<R> {
      const f = fields[key]!
      return fn({
        tagName: f.tag.toUpperCase(),
        type: f.type,
        getAttribute: (k: string) => (k === 'type' ? f.type : null),
      })
    },
    async fill(value: string) {
      fields[key]!.filled.push(value)
    },
  })
  return {
    async goto(next: string) { url = next },
    async title() { return 'Signin' },
    url() { return url },
    async innerText() { return '' },
    async screenshot() { return Buffer.alloc(1) },
    async click() {},
    getByLabel: (label) => ({ first: () => wrap(label) }),
    viewportSize: () => ({ width: 1280, height: 800 }),
  }
}

const dummyLlm: LLM = {
  async chat() {
    return { content: 'ok', toolCalls: [], raw: { role: 'assistant', content: 'ok' } }
  },
}

describe('vault workflow value binding', () => {
  it('validates { kind: "vault" } workflow values and rejects malformed ids', () => {
    const valid = parseWorkflowTrace({
      format: 'opensuperbot.workflow',
      version: 1,
      title: 'Vault Login',
      steps: [
        {
          type: 'fill',
          target: { candidates: [{ label: 'Password' }] },
          value: { kind: 'vault', itemId: 'vault-a1b2c3d4', field: 'password' },
        },
      ],
    })
    expect(valid.steps[0]).toMatchObject({
      type: 'fill',
      value: { kind: 'vault', itemId: 'vault-a1b2c3d4', field: 'password' },
    })

    expect(() =>
      parseWorkflowTrace({
        format: 'opensuperbot.workflow',
        version: 1,
        title: 'Bad Vault',
        steps: [
          {
            type: 'fill',
            target: { candidates: [{ label: 'Password' }] },
            value: { kind: 'vault', itemId: 'not-a-vault-id', field: 'password' },
          },
        ],
      }),
    ).toThrow(/vault item id/i)
  })

  it('replays a vault-bound workflow with empty bindings and enforces domain & grant checks', async () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('ops', 'Ops', 'Operations', '🛠', '', 1)`).run()
    db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:ops', 'dm', 'ops', 'Ops', 1)`).run()

    const fields = {
      Email: { tag: 'input', type: 'email', filled: [] as string[] },
      Password: { tag: 'input', type: 'password', filled: [] as string[] },
      '2FA Code': { tag: 'input', type: 'text', filled: [] as string[] },
    }
    const page = makeWorkflowPage('https://portal.acme.test/login', fields)
    const computer = createFakeComputer({ workflowPage: async () => page })
    const pool: Pool = {
      async get() { return computer },
      peek() { return Promise.resolve(computer) },
      async disposeAll() {},
      lastUsed: () => undefined,
      async forget() {},
      async retire() {},
    }
    const gw = createApp({ db, llm: dummyLlm, pool, now: () => new Date(FIXED_NOW) })

    const createRes = await gw.app.request('/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme Portal',
        kind: 'login',
        allowedDomains: ['portal.acme.test'],
        fields: [
          { key: 'username', kind: 'text' },
          { key: 'password', kind: 'secret' },
          { key: 'totp', kind: 'totp' },
        ],
        values: { username: 'ops@acme.test', password: 'WorkflowPassword!42', totp: RFC_SECRET },
        botIds: ['ops'],
      }),
    })
    const { item } = (await createRes.json()) as { item: { id: string } }

    const saved = saveWorkflowTrace(db, 'ops', {
      format: 'opensuperbot.workflow',
      version: 1,
      title: 'Portal Sign-in',
      steps: [
        { type: 'navigate', url: 'https://portal.acme.test/login' },
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'vault', itemId: item.id, field: 'username' } },
        { type: 'fill', target: { candidates: [{ label: 'Password' }] }, value: { kind: 'vault', itemId: item.id, field: 'password' } },
        { type: 'fill', target: { candidates: [{ label: '2FA Code' }] }, value: { kind: 'vault', itemId: item.id, field: 'totp' } },
      ],
    })

    // Run with empty bindings — vault resolves JIT (navigate waits POPUP_SETTLE_WINDOW_MS = 250ms)
    const runRes = await gw.app.request(`/api/bots/ops/workflows/${saved.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(runRes.status).toBe(202)
    await new Promise((r) => setTimeout(r, 380))

    expect(fields.Email.filled).toEqual(['ops@acme.test'])
    expect(fields.Password.filled).toEqual(['WorkflowPassword!42'])
    expect(fields['2FA Code'].filled).toEqual([generateTotp(RFC_SECRET, FIXED_NOW).code])

    // Domain mismatch stops workflow cleanly before filling
    const evilWorkflow = saveWorkflowTrace(db, 'ops', {
      format: 'opensuperbot.workflow',
      version: 1,
      title: 'Wrong Domain',
      steps: [
        { type: 'navigate', url: 'https://evil.example/login' },
        { type: 'fill', target: { candidates: [{ label: 'Password' }] }, value: { kind: 'vault', itemId: item.id, field: 'password' } },
      ],
    })
    const badRun = await gw.app.request(`/api/bots/ops/workflows/${evilWorkflow.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(badRun.status).toBe(202)
    await new Promise((r) => setTimeout(r, 380))
    expect(fields.Password.filled).toHaveLength(1) // did not fill on evil domain
    const lastMsg = db.prepare(`SELECT content FROM messages WHERE thread_id = 'dm:ops' ORDER BY id DESC LIMIT 1`).get() as { content: string }
    expect(lastMsg.content).toContain('allowed domains')
  })
})
