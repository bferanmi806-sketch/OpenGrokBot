import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkBrowserUrl } from '../src/browser-page.js'
import { createFakeComputer } from '../src/computer.js'
import { loadConfig } from '../src/config.js'
import { ensureDmThread, insertMessage, openDb, upsertBot, waitsOnOperator } from '../src/db.js'
import { createLLM, type AssistantTurn, type LLM, type ToolDef } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createRoutine, isValidCron } from '../src/routines.js'
import { createApp } from '../src/server.js'
import { createUploads } from '../src/uploads.js'
import { b64, pdf, png } from './fixtures/upload-samples.js'

describe('browser URL scheme guard', () => {
  it('blocks file:, chrome:, view-source:, javascript:, and invalid URLs', () => {
    for (const bad of [
      'file:///etc/passwd',
      'FILE:///Users/op/.ssh/id_ed25519',
      'chrome://settings',
      'chrome-extension://abc/page.html',
      'view-source:http://127.0.0.1:4747/',
      'javascript:alert(1)',
      'data:text/html,<p>hi</p>',
      'not a url',
    ]) {
      expect(() => checkBrowserUrl(bad)).toThrow()
    }
  })

  it('allows http(s) and gates data: behind allowData', () => {
    expect(() => checkBrowserUrl('https://example.com/a?b=1')).not.toThrow()
    expect(() => checkBrowserUrl('http://127.0.0.1:8080/')).not.toThrow()
    expect(() => checkBrowserUrl('data:text/html,<p>smoke</p>', { allowData: true })).not.toThrow()
  })
})

describe('computer pool concurrent dead-instance replacement', () => {
  it('serializes concurrent get() calls when a cached computer died', async () => {
    const made: ReturnType<typeof createFakeComputer>[] = []
    let firstAlive = true
    const pool = createPool({
      dataDir: '/data',
      makeComputer: async () => {
        const idx = made.length
        await new Promise((r) => setTimeout(r, 15))
        const c = createFakeComputer({ ping: async () => (idx === 0 ? firstAlive : true) })
        made.push(c)
        return c
      },
    })

    const initial = await pool.get('researcher')
    expect(made).toHaveLength(1)

    firstAlive = false
    const [a, b] = await Promise.all([pool.get('researcher'), pool.get('researcher')])
    expect(a).toBe(b)
    expect(a).not.toBe(initial)
    expect(made).toHaveLength(2)
    expect(made[0]!.calls.filter((x) => x === 'dispose')).toEqual(['dispose'])
  })
})

describe('uploads in-flight sweep & quota protection', () => {
  it('keeps an in-flight PDF file on disk when sweep() runs mid-save', async () => {
    const db = openDb(':memory:')
    upsertBot(db, { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })
    const dataDir = mkdtempSync(join(tmpdir(), 'osb-up-race-'))
    try {
      let releasePdf!: () => void
      let pdfStarted!: () => void
      const started = new Promise<void>((r) => { pdfStarted = r })
      const gate = new Promise<void>((r) => { releasePdf = r })

      const uploads = createUploads({
        db,
        dataDir,
        pdf: async () => {
          pdfStarted()
          await gate
          return { state: 'ok', pages: 1, text: 'hello' }
        },
      })

      const saving = uploads.save({ name: 'doc.pdf', mime: 'application/pdf', data: b64(pdf()) })
      await started
      // 抽文字与写盘期间 sweep 不出错，落盘入库后再 sweep 也不会误删
      expect(await uploads.sweep()).toEqual({ orphans: 0, strays: 0, missing: 0 })

      releasePdf()
      const res = await saving
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(existsSync(join(dataDir, 'uploads', res.upload.id))).toBe(true)
        expect(await uploads.sweep()).toEqual({ orphans: 0, strays: 0, missing: 0 })
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('counts in-flight uploads toward total quota across concurrent saves', async () => {
    const db = openDb(':memory:')
    const dataDir = mkdtempSync(join(tmpdir(), 'osb-up-quota-'))
    try {
      const sample = png(8, 8)
      let releaseFirst!: () => void
      let firstEntered!: () => void
      const entered = new Promise<void>((r) => { firstEntered = r })
      const gate = new Promise<void>((r) => { releaseFirst = r })

      const uploads = createUploads({
        db,
        dataDir,
        maxTotalBytes: pdf().length + sample.length - 1,
        pdf: async () => {
          firstEntered()
          await gate
          return { state: 'ok', pages: 1, text: 'ok' }
        },
      })

      const first = uploads.save({ name: 'a.pdf', mime: 'application/pdf', data: b64(pdf()) })
      await entered
      const second = await uploads.save({ name: 'b.png', mime: 'image/png', data: b64(sample) })
      expect(second).toEqual({ ok: false, code: 'uploads_full', status: 507 })

      releaseFirst()
      expect((await first).ok).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('createLLM cutoff & 200-error handling', () => {
  it('throws a clear error when finish_reason is length on a truncated tool call or empty reply', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: 'length',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'write_file', arguments: '{"path":"a.txt","con' } }],
        },
      }],
    }))) as typeof fetch
    const llm = createLLM(loadConfig({}), fakeFetch, async () => {})
    await expect(llm.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/cut off at its output limit/i)
  })

  it('surfaces upstream error message returned inside a 200 payload', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      error: { message: 'upstream context window exceeded' },
    }))) as typeof fetch
    const llm = createLLM(loadConfig({}), fakeFetch, async () => {})
    await expect(llm.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/upstream context window exceeded/)
  })
})

describe('waitsOnOperator login_request & cron validation', () => {
  it('stays waiting after login_request + bot closing text until the operator replies', () => {
    const db = openDb(':memory:')
    upsertBot(db, { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })
    ensureDmThread(db, 'researcher')
    expect(waitsOnOperator(db, 'researcher')).toBe(false)

    insertMessage(db, {
      threadId: 'dm:researcher',
      sender: 'researcher',
      kind: 'login_request',
      content: 'Sign in to Notion',
      payload: { site: 'Notion', why: 'read sprint board' },
    })
    // 同事随后发了一句收尾文字，不该把「等操作者登录」冲掉
    insertMessage(db, {
      threadId: 'dm:researcher',
      sender: 'researcher',
      kind: 'text',
      content: 'Let me know once you have signed in.',
    })
    expect(waitsOnOperator(db, 'researcher')).toBe(true)

    insertMessage(db, { threadId: 'dm:researcher', sender: 'user', kind: 'text', content: 'Signed in!' })
    expect(waitsOnOperator(db, 'researcher')).toBe(false)
  })

  it('accepts standard 5-field cron and rejects 6-field second-level cron', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true)
    expect(isValidCron('*/15 * * * *')).toBe(true)
    expect(isValidCron('* * * * * *')).toBe(false)
    expect(isValidCron('0 0 9 * * *')).toBe(false)
  })
})

describe('watch routine privilege preservation across ask_operator', () => {
  it('keeps mutating tools withheld when resuming a question asked during a watch turn', async () => {
    const db = openDb(':memory:')
    upsertBot(db, { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })
    ensureDmThread(db, 'researcher')
    const dataDir = mkdtempSync(join(tmpdir(), 'osb-watch-q-'))
    try {
      const seenTools: string[][] = []
      let step = 0
      const llm: LLM = {
        chat: async (_msgs, tools: ToolDef[]): Promise<AssistantTurn> => {
          seenTools.push(tools.map((t) => t.function.name))
          step += 1
          if (step === 1) {
            const call = { id: 'q1', name: 'ask_operator', args: { question: 'Which region?', options: ['US', 'EU'] } }
            return {
              content: null,
              toolCalls: [call],
              raw: { role: 'assistant', content: null, tool_calls: [{ id: 'q1', type: 'function', function: { name: 'ask_operator', arguments: JSON.stringify(call.args) } }] },
            }
          }
          return { content: 'All clear.', toolCalls: [], raw: { role: 'assistant', content: 'All clear.' } }
        },
      }

      const routine = createRoutine(db, {
        botId: 'researcher',
        name: 'Quiet check',
        cron: '',
        instructions: 'Check status',
        webhook: true,
        mode: 'watch',
      })
      const pool = createPool({ dataDir, makeComputer: async () => createFakeComputer() })
      const gateway = createApp({ db, llm, dataDir, pool })

      expect(await gateway.runRoutine(routine, { force: true })).toBe('ran')

      const qRow = db.prepare(`SELECT id FROM messages WHERE kind = 'question'`).get() as { id: number } | undefined
      expect(qRow).toBeTruthy()
      expect(seenTools[0]).not.toContain('run_command')
      expect(seenTools[0]).not.toContain('write_file')

      const ansRes = await gateway.app.request(`/api/questions/${qRow!.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choices: ['EU'] }),
      })
      expect(ansRes.status).toBe(202)

      for (let i = 0; i < 40 && seenTools.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 15))
      }
      expect(seenTools).toHaveLength(2)
      expect(seenTools[1]).not.toContain('run_command')
      expect(seenTools[1]).not.toContain('write_file')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
