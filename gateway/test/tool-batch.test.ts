import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTurn } from '../src/agent.js'
import { createFakeComputer } from '../src/computer.js'
import { createLocalComputer } from '../src/computer-local.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { partitionToolBatches, runWithConcurrency } from '../src/tool-batch.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const events = { onMessage: () => {}, onStatus: () => {} }

describe('partitionToolBatches & runWithConcurrency', () => {
  it('groups consecutive parallel-safe read tools and isolates mutating tools as barriers', () => {
    const calls = ['r1', 'r2', 'r3', 'w1', 'r4', 'w2', 'r5', 'r6']
    const batches = partitionToolBatches(calls, (c) => c.startsWith('r'))
    expect(batches).toEqual([
      { parallel: true, items: ['r1', 'r2', 'r3'] },
      { parallel: false, items: ['w1'] },
      { parallel: false, items: ['r4'] },
      { parallel: false, items: ['w2'] },
      { parallel: true, items: ['r5', 'r6'] },
    ])
  })

  it('respects concurrency cap, preserves output order, and stops dispatching on abort', async () => {
    let active = 0
    let maxActive = 0
    const results = await runWithConcurrency([30, 10, 20, 5], 2, async (ms, i) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, ms))
      active--
      return `${i}:${ms}`
    })
    expect(maxActive).toBe(2)
    expect(results).toEqual(['0:30', '1:10', '2:20', '3:5'])

    const ctrl = new AbortController()
    const started: number[] = []
    await runWithConcurrency([0, 1, 2, 3], 1, async (n) => {
      started.push(n)
      if (n === 1) ctrl.abort()
      return n
    }, ctrl.signal)
    expect(started).toEqual([0, 1])
  })
})

describe('runTurn parallel reads, file stale guard, and sandbox diagnosis', () => {
  it('runs consecutive read_file calls concurrently while preserving result order and write barrier', async () => {
    const db = openDb(':memory:')
    upsertBot(db, bot)
    const threadId = ensureDmThread(db, bot.id)

    let activeReads = 0
    let maxConcurrentReads = 0
    const log: string[] = []
    const comp = createFakeComputer({
      async readFile(path) {
        activeReads++
        maxConcurrentReads = Math.max(maxConcurrentReads, activeReads)
        log.push(`start:${path}`)
        await new Promise((r) => setTimeout(r, path === 'slow.txt' ? 40 : 10))
        activeReads--
        log.push(`end:${path}`)
        return `content-of-${path}`
      },
      async writeFile(path) {
        expect(activeReads).toBe(0) // Barrier: all prior reads finished before write starts
        log.push(`write:${path}`)
      },
    })

    const seen: ChatMsg[][] = []
    let step = 0
    const llm: LLM = {
      async chat(messages): Promise<AssistantTurn> {
        seen.push(messages.map((m) => ({ ...m })))
        step++
        if (step === 1) {
          return {
            content: null,
            toolCalls: [
              { id: 'c1', name: 'read_file', args: { path: 'slow.txt' } },
              { id: 'c2', name: 'read_file', args: { path: 'fast.txt' } },
              { id: 'c3', name: 'write_file', args: { path: 'out.txt', content: 'done' } },
            ],
            raw: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"slow.txt"}' } },
                { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"fast.txt"}' } },
                { id: 'c3', type: 'function', function: { name: 'write_file', arguments: '{"path":"out.txt","content":"done"}' } },
              ],
            },
          }
        }
        return { content: 'All done.', toolCalls: [], raw: { role: 'assistant', content: 'All done.' } }
      },
    }

    const outcome = await runTurn({ db, llm, bot, soul: '', threadId, getComputer: async () => comp }, 'merge', events)
    expect(outcome).toBe('replied')
    expect(maxConcurrentReads).toBe(2)
    expect(log.at(-1)).toBe('write:out.txt')
    // Tool results pushed strictly in model's original call order (c1, c2, c3)
    const toolMsgs = seen[1]!.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3'])
    expect(toolMsgs[0]!.content).toBe('content-of-slow.txt')
    expect(toolMsgs[1]!.content).toBe('content-of-fast.txt')
    expect(toolMsgs[2]!.content).toBe('Wrote out.txt.')
  })

  it('refuses stale write_file overwrites when a read file changes externally, unless re-read or force:true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osb-stale-'))
    try {
      const target = join(dir, 'notes.md')
      writeFileSync(target, 'v1', 'utf8')
      const comp = createLocalComputer({
        workspaceDir: dir,
        profileDir: join(dir, '.profile'),
        executablePath: '/nonexistent',
      })
      const db = openDb(':memory:')
      upsertBot(db, bot)
      const threadId = ensureDmThread(db, bot.id)

      const seen: ChatMsg[][] = []
      let step = 0
      const llm: LLM = {
        async chat(messages): Promise<AssistantTurn> {
          seen.push(messages.map((m) => ({ ...m })))
          step++
          if (step === 1) {
            return {
              content: null,
              toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'notes.md' } }],
              raw: { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.md"}' } }] },
            }
          }
          if (step === 2) {
            // Simulate operator or external process modifying the file before bot writes
            writeFileSync(target, 'v2-modified-by-operator', 'utf8')
            return {
              content: null,
              toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'notes.md', content: 'stale-bot-write' } }],
              raw: { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"notes.md","content":"stale-bot-write"}' } }] },
            }
          }
          if (step === 3) {
            // Explicit force: true succeeds and updates the observed version
            return {
              content: null,
              toolCalls: [{ id: 'w2', name: 'write_file', args: { path: 'notes.md', content: 'forced-write', force: true } }],
              raw: { role: 'assistant', content: null, tool_calls: [{ id: 'w2', type: 'function', function: { name: 'write_file', arguments: '{"path":"notes.md","content":"forced-write","force":true}' } }] },
            }
          }
          return { content: 'Updated.', toolCalls: [], raw: { role: 'assistant', content: 'Updated.' } }
        },
      }

      const outcome = await runTurn({ db, llm, bot, soul: '', threadId, getComputer: async () => comp }, 'edit notes', events)
      expect(outcome).toBe('replied')
      const refused = seen[2]!.find((m) => m.role === 'tool' && m.tool_call_id === 'w1')!
      expect(refused.content).toContain('Refused to overwrite')
      expect(refused.content).toContain('changed on disk')
      const forced = seen[3]!.find((m) => m.role === 'tool' && m.tool_call_id === 'w2')!
      expect(forced.content).toBe('Wrote notes.md.')
      expect(readFileSync(target, 'utf8')).toBe('forced-write')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appends clear sandbox diagnosis hints to shell output when sandboxOutcome is set', async () => {
    const db = openDb(':memory:')
    upsertBot(db, bot)
    const threadId = ensureDmThread(db, bot.id)
    const comp = createFakeComputer({
      shell: async () => ({
        stdout: '',
        stderr: 'bash: /etc/hosts: Operation not permitted',
        exitCode: 1,
        sandboxOutcome: 'denied',
      }),
    })
    const seen: ChatMsg[][] = []
    let step = 0
    const llm: LLM = {
      async chat(messages) {
        seen.push(messages.map((m) => ({ ...m })))
        step++
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: 's1', name: 'shell', args: { cmd: 'echo x > /etc/hosts' } }],
            raw: { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"echo x > /etc/hosts"}' } }] },
          }
        }
        return { content: 'Blocked.', toolCalls: [], raw: { role: 'assistant', content: 'Blocked.' } }
      },
    }
    await runTurn({ db, llm, bot, soul: '', threadId, getComputer: async () => comp }, 'test', events)
    const toolMsg = seen[1]!.find((m) => m.role === 'tool' && m.tool_call_id === 's1')!
    expect(toolMsg.content).toContain('[sandbox: blocked by workspace confinement')
  })
})
