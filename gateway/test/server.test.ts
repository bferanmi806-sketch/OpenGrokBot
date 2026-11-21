import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { listActions } from '../src/actions.js'
import { getApproval } from '../src/approvals.js'
import { ensureDmThread, listMessages, openDb, upsertBot } from '../src/db.js'
import { createHub } from '../src/hub.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { createApp } from '../src/server.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const textTurn: AssistantTurn = { content: 'On it.', toolCalls: [], raw: { role: 'assistant', content: 'On it.' } }
const okLLM: LLM = { chat: async () => textTurn }

function setup(llm: LLM = okLLM) {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  ensureDmThread(db, bot.id)
  return { db, ...createApp({ db, llm }) }
}

describe('hub', () => {
  it('broadcasts to all clients and drops broken ones', () => {
    const hub = createHub()
    const got: string[] = []
    const good = { send: (d: string) => got.push(d) }
    const bad = { send: () => { throw new Error('gone') } }
    hub.add(good)
    hub.add(bad)
    hub.broadcast({ type: 'status', botId: 'researcher', state: 'thinking' })
    expect(got).toHaveLength(1)
    expect(JSON.parse(got[0]!)).toEqual({ type: 'status', botId: 'researcher', state: 'thinking' })
    expect(hub.size()).toBe(1)
  })
})

describe('REST', () => {
  it('GET /api/bots returns sidebar rows', async () => {
    const { app } = setup()
    const res = await app.request('/api/bots')
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows[0]).toMatchObject({ id: 'researcher', name: 'Scout', thread_id: 'dm:researcher' })
  })

  it('GET messages returns history', async () => {
    const { app } = setup()
    const res = await app.request('/api/threads/dm:researcher/messages')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST message 202s and eventually persists bot reply + broadcasts', async () => {
    const { app, db, hub } = setup()
    const got: string[] = []
    hub.add({ send: (d: string) => got.push(d) })
    const res = await app.request('/api/threads/dm:researcher/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }),
    })
    expect(res.status).toBe(202)
    await vi.waitFor(() => {
      expect(listMessages(db, 'dm:researcher').map((m) => m.sender)).toEqual(['user', 'researcher'])
    })
    const types = got.map((d) => JSON.parse(d).type)
    expect(types).toContain('message')
    expect(types).toContain('status')
  })

  it('rejects empty text and unknown thread', async () => {
    const { app } = setup()
    const empty = await app.request('/api/threads/dm:researcher/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '  ' }),
    })
    expect(empty.status).toBe(400)
    const unknown = await app.request('/api/threads/dm:nobody/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    })
    expect(unknown.status).toBe(404)
  })
})

describe('screenshot serving', () => {
  function setupWithData() {
    const dataDir = mkdtempSync(join(tmpdir(), 'osb-srv-'))
    const dir = join(dataDir, 'workspaces', 'researcher', 'screenshots')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '42.png'), 'PNGDATA')
    const db = openDb(':memory:')
    upsertBot(db, bot)
    ensureDmThread(db, bot.id)
    return { dataDir, ...createApp({ db, llm: okLLM, dataDir }) }
  }

  it('serves a stored screenshot as png', async () => {
    const { app } = setupWithData()
    const res = await app.request('/api/screenshots/researcher/42.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect(await res.text()).toBe('PNGDATA')
  })

  it('404s unknown files and rejects traversal', async () => {
    const { app } = setupWithData()
    expect((await app.request('/api/screenshots/researcher/99.png')).status).toBe(404)
    expect((await app.request('/api/screenshots/researcher/notes.md')).status).toBe(404)
    expect((await app.request('/api/screenshots/researcher/..%2F..%2Fopensuperbot.db')).status).toBe(404)
  })
})

describe('editable prompt approvals', () => {
  it('emits editable on non-batch hold_for_approval, wakes bot with exact edited version, and keeps 👍 working for unedited holds', async () => {
    const seenMessages: ChatMsg[][] = []
    let step = 0
    const llm: LLM = {
      async chat(msgs) {
        seenMessages.push(msgs.map((m) => ({ ...m })))
        step += 1
        if (step === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: 'h1',
                name: 'hold_for_approval',
                args: { action: 'Post Q4 update', detail: 'Original draft text', kind: 'post', target: '@acme/news' },
              },
              {
                id: 'h2',
                name: 'hold_for_approval',
                args: { action: 'Batch follow-up', detail: 'Two items', items: ['Alice', 'Bob'] },
              },
            ],
            raw: { role: 'assistant', content: null, tool_calls: [] },
          }
        }
        if (step === 2) return { content: 'Held both.', toolCalls: [], raw: { role: 'assistant', content: 'Held both.' } }
        if (step === 3) return { content: 'Carried out edited version.', toolCalls: [], raw: { role: 'assistant', content: 'Carried out edited version.' } }
        if (step === 4) {
          return {
            content: null,
            toolCalls: [
              {
                id: 'h3',
                name: 'hold_for_approval',
                args: { action: 'Send quick note', detail: 'Unedited detail' },
              },
            ],
            raw: { role: 'assistant', content: null, tool_calls: [] },
          }
        }
        if (step === 5) return { content: 'Held quick note.', toolCalls: [], raw: { role: 'assistant', content: 'Held quick note.' } }
        return { content: 'Sent quick note.', toolCalls: [], raw: { role: 'assistant', content: 'Sent quick note.' } }
      },
    }

    const { app, db } = setup(llm)
    await app.request('/api/threads/dm:researcher/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Draft the update' }),
    })

    await vi.waitFor(() => {
      expect(listMessages(db, 'dm:researcher').some((m) => m.content === 'Held both.')).toBe(true)
    })

    const chips = listMessages(db, 'dm:researcher').filter((m) => m.kind === 'approval_request')
    expect(chips).toHaveLength(2)
    const [singleChip, batchChip] = chips
    const singleId = (singleChip!.payload as { approvalId: number }).approvalId
    const batchId = (batchChip!.payload as { approvalId: number }).approvalId

    // Single hold carries editable; batch hold omits editable
    expect((singleChip!.payload as { editable?: unknown }).editable).toEqual({
      kind: 'prompt',
      action: 'Post Q4 update',
      detail: 'Original draft text',
    })
    expect((batchChip!.payload as { editable?: unknown }).editable).toBeUndefined()

    // Invalid prompt edit returns 400 and leaves approval pending
    const badEdit = await app.request(`/api/approvals/${singleId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'approve',
        edit: { kind: 'prompt', action: '   ', detail: 'Nope' },
      }),
    })
    expect(badEdit.status).toBe(400)
    expect(await badEdit.json()).toMatchObject({ code: 'invalid_edit' })
    expect(getApproval(db, singleId)!.status).toBe('pending')

    // Editing a batch approval returns 400 and leaves approval pending
    const badBatchEdit = await app.request(`/api/approvals/${batchId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'approve',
        edit: { kind: 'prompt', action: 'Try edit batch', detail: 'Nope' },
      }),
    })
    expect(badBatchEdit.status).toBe(400)
    expect(await badBatchEdit.json()).toMatchObject({ code: 'invalid_edit' })
    expect(getApproval(db, batchId)!.status).toBe('pending')

    // Valid edit updates chip + approval_resolved with edited: true and wakes bot with edited instructions
    const editRes = await app.request(`/api/approvals/${singleId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'approve',
        edit: { kind: 'prompt', action: 'Post revised Q4 update', detail: 'Final operator-edited draft text' },
      }),
    })
    expect(editRes.status).toBe(202)

    await vi.waitFor(() => {
      expect(listMessages(db, 'dm:researcher').some((m) => m.content === 'Carried out edited version.')).toBe(true)
    })

    const updatedSingle = listMessages(db, 'dm:researcher').find((m) => m.id === singleChip!.id)!
    expect(updatedSingle.payload).toMatchObject({
      status: 'approved',
      action: 'Post revised Q4 update',
      detail: 'Final operator-edited draft text',
      edited: true,
      editable: { kind: 'prompt', action: 'Post revised Q4 update', detail: 'Final operator-edited draft text' },
    })

    const resolvedSingle = listMessages(db, 'dm:researcher').find(
      (m) => m.kind === 'approval_resolved' && (m.payload as { approvalId?: number }).approvalId === singleId,
    )!
    expect(resolvedSingle.payload).toMatchObject({
      approvalId: singleId,
      action: 'Post revised Q4 update',
      decision: 'approve',
      edited: true,
    })

    const approvalLog = listActions(db, 'researcher', 20).find(
      (a) => a.tool === 'approval' && a.summary.includes('Post revised Q4 update'),
    )
    expect(approvalLog?.summary).toContain('(edited by you)')

    const wakeupSeed = String(seenMessages[2]!.at(-1)?.content ?? '')
    expect(wakeupSeed).toContain(`Your operator edited and approved #${singleId}.`)
    expect(wakeupSeed).toContain('Final action: Post revised Q4 update')
    expect(wakeupSeed).toContain('Final edited detail:\nFinal operator-edited draft text')
    expect(wakeupSeed).toContain('Carry out this exact edited version (not your earlier draft)')

    // Duplicate click returns 409 idempotently
    const dupRes = await app.request(`/api/approvals/${singleId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(dupRes.status).toBe(409)

    // Discard batch hold, then hold a fresh unedited prompt action and approve via 👍
    await app.request(`/api/approvals/${batchId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'discard' }),
    })
    await vi.waitFor(() => {
      expect(listMessages(db, 'dm:researcher').some((m) => m.content === 'Held quick note.')).toBe(true)
    })

    const quickChip = listMessages(db, 'dm:researcher').filter((m) => m.kind === 'approval_request').at(-1)!
    const quickId = (quickChip.payload as { approvalId: number }).approvalId
    const thumbRes = await app.request('/api/threads/dm:researcher/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '👍' }),
    })
    expect(thumbRes.status).toBe(202)
    expect(await thumbRes.json()).toMatchObject({ ok: true, approved: true })
    expect(getApproval(db, quickId)!.status).toBe('approved')

    await vi.waitFor(() => {
      expect(listMessages(db, 'dm:researcher').some((m) => m.content === 'Sent quick note.')).toBe(true)
    })
    const updatedQuick = listMessages(db, 'dm:researcher').find((m) => m.id === quickChip.id)!
    expect((updatedQuick.payload as { edited?: boolean }).edited).toBeUndefined()
  })
})
