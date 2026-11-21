import { describe, expect, it } from 'vitest'
import {
  TOOL_PRUNE_MARKER,
  createContextMeter,
  estimateTextTokens,
  inferContextWindow,
  isContextOverflowError,
  pruneOldToolResults,
} from '../src/context-budget.js'
import type { ChatMsg } from '../src/llm.js'

describe('token estimation and context window inference', () => {
  it('estimates CJK higher than ASCII so Chinese prompts are not under-counted', () => {
    const en = estimateTextTokens('a'.repeat(100))
    const zh = estimateTextTokens('中'.repeat(100))
    expect(en).toBe(25)
    expect(zh).toBe(150)
  })

  it('infers sensible windows by model family and respects explicit override', () => {
    expect(inferContextWindow('gemini-3.5-flash-lite')).toBe(1_000_000)
    expect(inferContextWindow('claude-opus-5-5')).toBe(200_000)
    expect(inferContextWindow('deepseek-flash')).toBe(128_000)
    expect(inferContextWindow('qwen3-vl:8b')).toBe(32_000)
    expect(inferContextWindow('deepseek-flash', 64_000)).toBe(64_000)
  })
})

describe('createContextMeter', () => {
  it('anchors on real provider usage and adds only heuristic delta for subsequent messages', () => {
    const meter = createContextMeter()
    const base: ChatMsg[] = [{ role: 'user', content: 'hello' }]
    meter.recordUsage({ prompt: 10_000, completion: 500, cached: 8_000 }, base, [])
    // Immediately after recording usage, projected equals real total
    expect(meter.projectedTokens(base, [])).toBe(10_500)
    // Appending a 400-char ASCII message adds ~100 + framing overhead
    const next: ChatMsg[] = [...base, { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(400) }]
    const projected = meter.projectedTokens(next, [])
    expect(projected).toBeGreaterThan(10_580)
    expect(projected).toBeLessThan(10_650)
  })
})

describe('isContextOverflowError', () => {
  it('recognizes common provider overflow messages and ignores unrelated errors', () => {
    expect(isContextOverflowError(new Error('LLM API 400: maximum context length is 128000 tokens'))).toBe(true)
    expect(isContextOverflowError(new Error('LLM API 400: prompt is too long: 210000 tokens > 200000 maximum'))).toBe(true)
    expect(isContextOverflowError(new Error('LLM API 400: context_length_exceeded'))).toBe(true)
    expect(isContextOverflowError(new Error('LLM API 429: rate limit exceeded'))).toBe(false)
  })
})

describe('pruneOldToolResults', () => {
  it('keeps the most recent tool batches verbatim and prunes oversized older tool outputs', () => {
    const big = `START\n${'z'.repeat(5_000)}\nEND`
    const messages: ChatMsg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'investigate' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: big },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2' }] },
      { role: 'tool', tool_call_id: 'c2', content: big },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c3' }] },
      { role: 'tool', tool_call_id: 'c3', content: big },
    ]
    const out = pruneOldToolResults(messages, { keepRecentToolSteps: 2 })
    expect(out.prunedCount).toBe(1)
    expect(out.charsRemoved).toBeGreaterThan(3_000)
    // Oldest batch c1 pruned, keeping both ends
    expect(out.messages[3]!.content).toContain('START')
    expect(out.messages[3]!.content).toContain('END')
    expect(out.messages[3]!.content).toContain(TOOL_PRUNE_MARKER)
    // Two most recent batches c2 and c3 preserved verbatim
    expect(out.messages[5]!.content).toBe(big)
    expect(out.messages[7]!.content).toBe(big)
    // Input array was not mutated
    expect(messages[3]!.content).toBe(big)
  })
})
