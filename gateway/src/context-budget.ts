import type { ChatMsg, ToolDef, Usage } from './llm.js'
import { safeSliceHead, safeSliceTail } from './spill.js'

const ROLE_OVERHEAD = 4
const BLOCK_OVERHEAD = 4
const IMAGE_ESTIMATE_TOKENS = 1_200

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const PRESSURE_RATIO = 0.75
export const DEFAULT_PRUNE_KEEP_RECENT_STEPS = 2
export const DEFAULT_PRUNE_THRESHOLD_CHARS = 2_400
export const DEFAULT_PRUNE_HEAD_CHARS = 1_000
export const DEFAULT_PRUNE_TAIL_CHARS = 500
export const TOOL_PRUNE_MARKER = '\n\n[... earlier tool output pruned to save context ...]\n\n'

const isCjkCode = (code: number) =>
  (code >= 0x3000 && code <= 0x9fff)
  || (code >= 0xac00 && code <= 0xd7af)
  || (code >= 0xf900 && code <= 0xfaff)
  || (code >= 0xff00 && code <= 0xffef)

/**
 * 中英文感知的零依赖启发式 token 估算：
 * CJK 字符按约 1.5 token 计，ASCII/拉丁按约 0.25 token 计，避免纯 chars/4 在中文场景严重低估。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (isCjkCode(text.charCodeAt(i))) cjk++
  }
  const other = text.length - cjk
  return Math.ceil(cjk * 1.5 + other * 0.25)
}

export function estimateMessageTokens(msg: ChatMsg): number {
  let tokens = ROLE_OVERHEAD
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    tokens += estimateTextTokens(msg.content) + BLOCK_OVERHEAD
  }
  if (msg.tool_calls?.length) {
    try {
      tokens += estimateTextTokens(JSON.stringify(msg.tool_calls)) + BLOCK_OVERHEAD
    } catch {
      tokens += 64
    }
  }
  if (msg.images?.length) {
    tokens += msg.images.length * IMAGE_ESTIMATE_TOKENS
  }
  return tokens
}

export function estimateMessagesTokens(messages: readonly ChatMsg[]): number {
  let total = 0
  for (const m of messages) total += estimateMessageTokens(m)
  return total
}

export function estimateToolsTokens(tools: readonly ToolDef[]): number {
  if (!tools.length) return 0
  try {
    return estimateTextTokens(JSON.stringify(tools)) + BLOCK_OVERHEAD
  } catch {
    return tools.length * 120
  }
}

/** 根据常见模型族推断默认上下文窗口；支持显式 override（如 OPENSUPERBOT_CONTEXT_WINDOW）。 */
export function inferContextWindow(model?: string, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override)
  const m = (model ?? '').trim().toLowerCase()
  if (!m) return DEFAULT_CONTEXT_WINDOW
  // Ollama 等本地模型常带 tag（如 qwen3-vl:8b / llama3:8b），优先按保守本地窗口处理
  if (m.includes(':') || m.includes('llama') || m.includes('mistral')) return 32_000
  if (m.includes('gemini')) return 1_000_000
  if (m.includes('claude')) return 200_000
  if (m.includes('gpt-6') || m.includes('gpt-5') || m.includes('minimax')) return 200_000
  if (m.includes('deepseek') || m.includes('grok') || m.includes('qwen') || m.includes('kimi') || m.includes('glm')) {
    return 128_000
  }
  return DEFAULT_CONTEXT_WINDOW
}

export type ContextMeter = {
  recordUsage(usage: Usage, messages: readonly ChatMsg[], tools: readonly ToolDef[]): void
  projectedTokens(messages: readonly ChatMsg[], tools: readonly ToolDef[]): number
  resetAnchor(): void
}

/**
 * 真实 Usage 锚定计量器（借鉴 DeepSeek Harness token-meter）：
 * 历史大头用最近一次模型返回的真实 prompt+completion usage 做基线，
 * 仅对本步新增消息用启发式算增量，并取保守上界（不低于全量估算）。
 */
export function createContextMeter(): ContextMeter {
  let anchorReal: number | null = null
  let anchorEstimated = 0

  return {
    recordUsage(usage, messages, tools) {
      const realTotal = (usage.prompt ?? 0) + (usage.completion ?? 0)
      if (realTotal <= 0) return
      anchorReal = realTotal
      anchorEstimated = estimateMessagesTokens(messages) + estimateToolsTokens(tools)
    },
    projectedTokens(messages, tools) {
      const currentEstimated = estimateMessagesTokens(messages) + estimateToolsTokens(tools)
      if (anchorReal === null) return currentEstimated
      const baseline = Math.max(anchorReal, anchorEstimated)
      return Math.max(0, baseline + (currentEstimated - anchorEstimated))
    },
    resetAnchor() {
      anchorReal = null
      anchorEstimated = 0
    },
  }
}

const OVERFLOW_PATTERNS = [
  /context[_\s-]?length[_\s-]?exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /exceeds the (?:model(?:'s)? )?context (?:window|limit|length)/i,
  /too many tokens/i,
  /input (?:token count|is too long).*exceed/i,
  /request too large.*tokens/i,
  /context window.*exceeded/i,
]

/** 识别主流模型厂商（OpenAI / Anthropic / DeepSeek / xAI / Gemini / Ollama）的上下文窗口溢出报错。 */
export function isContextOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return OVERFLOW_PATTERNS.some((re) => re.test(msg))
}

export type PruneToolResultsOptions = {
  keepRecentToolSteps?: number
  thresholdChars?: number
  headChars?: number
  tailChars?: number
}

export type PruneToolResultsOutcome = {
  messages: ChatMsg[]
  prunedCount: number
  charsRemoved: number
}

/**
 * L2 零模型成本工具结果剪枝（借鉴 DeepSeek Harness compaction-tool-result-pruner）：
 * 保留最近 keepRecentToolSteps 轮工具调用的原文不动，对更早的超大 role='tool' 结果保留首尾、裁掉中间段。
 */
export function pruneOldToolResults(
  messages: readonly ChatMsg[],
  opts: PruneToolResultsOptions = {},
): PruneToolResultsOutcome {
  const keepSteps = Math.max(0, Math.floor(opts.keepRecentToolSteps ?? DEFAULT_PRUNE_KEEP_RECENT_STEPS))
  const threshold = Math.max(200, Math.floor(opts.thresholdChars ?? DEFAULT_PRUNE_THRESHOLD_CHARS))
  const headChars = Math.max(0, Math.floor(opts.headChars ?? DEFAULT_PRUNE_HEAD_CHARS))
  const tailChars = Math.max(0, Math.floor(opts.tailChars ?? DEFAULT_PRUNE_TAIL_CHARS))

  // 找出所有连续 tool 结果批次的起始索引，保护最近 keepSteps 个批次
  const toolBatchStarts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'tool' && messages[i - 1]?.role !== 'tool') {
      toolBatchStarts.push(i)
    }
  }
  const protectedFrom = keepSteps === 0
    ? messages.length
    : toolBatchStarts.length <= keepSteps
      ? 0
      : toolBatchStarts[toolBatchStarts.length - keepSteps]!

  let prunedCount = 0
  let charsRemoved = 0
  const out = messages.map((m, idx) => {
    if (idx >= protectedFrom || m.role !== 'tool' || typeof m.content !== 'string') return m
    if (m.content.length <= threshold) return m
    if (m.content.includes(TOOL_PRUNE_MARKER)) return m
    const head = safeSliceHead(m.content, headChars)
    const tail = safeSliceTail(m.content, tailChars)
    const next = `${head}${TOOL_PRUNE_MARKER}${tail}`
    if (next.length >= m.content.length) return m
    prunedCount++
    charsRemoved += m.content.length - next.length
    return { ...m, content: next }
  })

  return { messages: out, prunedCount, charsRemoved }
}
