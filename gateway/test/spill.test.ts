import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { pruneSpills, safeSliceHead, safeSliceTail, spillToolOutput } from '../src/spill.js'

const hasLoneSurrogate = (s: string) => /[\ud800-\udfff]/.test(s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))

describe('UTF-16 surrogate-safe slicing', () => {
  it('never splits a surrogate pair (emoji) at the cut boundary', () => {
    // Each emoji is 2 UTF-16 code units; cutting at odd boundary must back off cleanly
    const text = 'a😀b😀c'
    const head = safeSliceHead(text, 2) // index 1..2 is 😀
    expect(head).toBe('a')
    expect(hasLoneSurrogate(head)).toBe(false)

    const tail = safeSliceTail(text, 2) // index 3..4 is 😀, index 5 is c -> start=4 is low surrogate
    expect(tail).toBe('c')
    expect(hasLoneSurrogate(tail)).toBe(false)
  })
})

describe('spillToolOutput', () => {
  it('returns small outputs inline without touching the computer', async () => {
    const computer = createFakeComputer()
    const res = await spillToolOutput('short text', { toolName: 'shell', computer, thresholdChars: 100 })
    expect(res).toEqual({ text: 'short text' })
    expect(computer.files.size).toBe(0)
  })

  it('spills oversized output via putFile and points the model to read_file', async () => {
    const computer = createFakeComputer()
    const body = `BEGIN\n${'x'.repeat(10_000)}\nFINISH`
    const res = await spillToolOutput(body, {
      toolName: 'mcp__linear__list_issues',
      computer,
      now: 1700000000000,
      thresholdChars: 4_000,
      headChars: 1_000,
      tailChars: 1_000,
    })
    expect(res.spilledPath).toMatch(/^\.spill\/1700000000000-[0-9a-f]+-mcp__linear__list_issues\.txt$/)
    expect(res.text).toContain('BEGIN')
    expect(res.text).toContain('FINISH')
    expect(res.text).toContain(res.spilledPath!)
    expect(res.text).toContain('read_file')
    expect(computer.files.get(res.spilledPath!)?.toString('utf8')).toBe(body)
  })

  it('falls back cleanly to head/tail truncation when writing the spill fails or no computer is attached', async () => {
    const broken = createFakeComputer({
      putFile: async () => { throw new Error('ENOSPC') },
    })
    const body = `HEAD\n${'y'.repeat(6_000)}\nTAIL`
    const res1 = await spillToolOutput(body, {
      toolName: 'shell', computer: broken, thresholdChars: 2_000, headChars: 500, tailChars: 500,
      fallbackHint: 'pipe through head or tail',
    })
    expect(res1.spilledPath).toBeUndefined()
    expect(res1.text).toContain('HEAD')
    expect(res1.text).toContain('TAIL')
    expect(res1.text).toContain('characters omitted')
    expect(res1.text).toContain('pipe through head or tail')

    const res2 = await spillToolOutput(body, {
      toolName: 'mail_read', computer: null, thresholdChars: 2_000, headChars: 500, tailChars: 500,
    })
    expect(res2.spilledPath).toBeUndefined()
    expect(res2.text).toContain('HEAD')
    expect(res2.text).toContain('TAIL')
  })
})

describe('pruneSpills', () => {
  it('deletes expired spill files and refuses to traverse symlinks', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'osb-spill-'))
    const spillDir = join(dataDir, 'workspaces', 'researcher', '.spill')
    mkdirSync(spillDir, { recursive: true })
    const oldFile = join(spillDir, '1000-abcdef-shell.txt')
    const freshFile = join(spillDir, '9000-123456-shell.txt')
    writeFileSync(oldFile, 'old')
    writeFileSync(freshFile, 'fresh')

    // Symlinked .spill directory inside another bot must never be touched
    const outsideDir = mkdtempSync(join(tmpdir(), 'osb-outside-'))
    const victimFile = join(outsideDir, '1000-abcdef-shell.txt')
    writeFileSync(victimFile, 'keep me')
    mkdirSync(join(dataDir, 'workspaces', 'evil'), { recursive: true })
    symlinkSync(outsideDir, join(dataDir, 'workspaces', 'evil', '.spill'))

    const removed = await pruneSpills(dataDir, 5000)
    expect(removed).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(freshFile)).toBe(true)
    expect(existsSync(victimFile)).toBe(true)
  })
})
