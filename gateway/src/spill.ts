import { randomBytes } from 'node:crypto'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BotComputer } from './computer.js'

/** 同事工作区里存放超长工具输出的目录（相对 /workspace） */
export const SPILL_DIR = '.spill'

/** shell 默认超过 4000 字符即触发首尾预览 + 落盘（与历史 MAX_TOOL_CHARS 口径兼容） */
export const SHELL_SPILL_THRESHOLD_CHARS = 4_000
/** 连接器 / MCP 等外部只读工具超过 8000 字符触发落盘 */
export const DEFAULT_SPILL_THRESHOLD_CHARS = 8_000
export const DEFAULT_SPILL_HEAD_CHARS = 2_000
export const DEFAULT_SPILL_TAIL_CHARS = 1_500

const SAFE_ID = /^[a-zA-Z0-9._-]+$/
const SPILL_FILE = /^(\d+)-[0-9a-f]+-[a-z0-9_-]+\.txt$/

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff
const DETACH_SOURCE_THRESHOLD = 4_096

/**
 * 断开 V8 SlicedString 对超大父字符串的隐性引用（借鉴 DeepSeek Harness 防御规则）：
 * 从数 MB 文件或命令输出里切出几百字摘要并长期留存在回合消息里时，直接 .slice() 会把整块父串钉在堆中无法 GC。
 */
export function detachSlice(slice: string, sourceLength: number): string {
  if (sourceLength <= DETACH_SOURCE_THRESHOLD || slice.length === 0 || slice.length >= sourceLength) {
    return slice
  }
  return Buffer.from(slice, 'utf16le').toString('utf16le')
}

/** 从头部切出不超过 maxChars 个 UTF-16 码元，且绝不把代理对（emoji / 生僻汉字）劈成两半。 */
export function safeSliceHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let end = maxChars
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    end--
  }
  return detachSlice(text.slice(0, end), text.length)
}

/** 从尾部切出不超过 maxChars 个 UTF-16 码元，且绝不把代理对劈成两半。 */
export function safeSliceTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let start = text.length - maxChars
  if (start > 0 && isHighSurrogate(text.charCodeAt(start - 1)) && isLowSurrogate(text.charCodeAt(start))) {
    start++
  }
  return detachSlice(text.slice(start), text.length)
}

/** 代理对安全的首尾截断（无电脑或落盘失败时的优雅降级） */
export function safeHeadAndTail(
  text: string,
  maxChars = SHELL_SPILL_THRESHOLD_CHARS,
  hint = 'pipe through head, tail or sed -n to see a part',
): string {
  if (text.length <= maxChars) return text
  const half = Math.floor(maxChars / 2)
  const head = safeSliceHead(text, half)
  const tail = safeSliceTail(text, half)
  const omitted = Math.max(0, text.length - head.length - tail.length)
  return `${head}\n…(${omitted} characters omitted — ${hint})…\n${tail}`
}

function sanitizeToolSegment(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return clean || 'tool'
}

export type SpillOptions = {
  toolName: string
  /** 优先经 putFile（Docker 走 putArchive、本机走 confined）写进工作区，避免宿主机直写被容器符号链接攻击 */
  computer?: BotComputer | null
  now?: number
  thresholdChars?: number
  headChars?: number
  tailChars?: number
  fallbackHint?: string
}

export type SpillOutcome = {
  text: string
  spilledPath?: string
}

/**
 * L1 工具输出落盘（借鉴 DeepSeek Harness spill-policy）：
 * 超出内联阈值时将完整输出保存到工作区 .spill/，内联返回代理对安全的首尾预览 + read_file 读取提示；
 * 无电脑或落盘失败时尽力而为降级为首尾截断，绝不把成功的工具调用变成失败。
 */
export async function spillToolOutput(text: string, opts: SpillOptions): Promise<SpillOutcome> {
  const threshold = opts.thresholdChars ?? DEFAULT_SPILL_THRESHOLD_CHARS
  if (text.length <= threshold) return { text }

  const headChars = Math.min(opts.headChars ?? DEFAULT_SPILL_HEAD_CHARS, Math.floor(threshold / 2))
  const tailChars = Math.min(opts.tailChars ?? DEFAULT_SPILL_TAIL_CHARS, Math.floor(threshold / 2))
  const head = safeSliceHead(text, headChars)
  const tail = safeSliceTail(text, tailChars)
  const omitted = Math.max(0, text.length - head.length - tail.length)

  if (opts.computer) {
    const stamp = Math.max(0, Math.floor(opts.now ?? Date.now()))
    const relPath = `${SPILL_DIR}/${stamp}-${randomBytes(3).toString('hex')}-${sanitizeToolSegment(opts.toolName)}.txt`
    try {
      if (opts.computer.putFile) {
        await opts.computer.putFile(relPath, Buffer.from(text, 'utf8'))
      } else {
        await opts.computer.writeFile(relPath, text)
      }
      return {
        spilledPath: relPath,
        text: `${head}\n…(${omitted} characters omitted — full output saved to ${relPath}; use read_file with offset/maxChars to inspect)…\n${tail}`,
      }
    } catch {
      // 落盘失败按尽力而为降级为普通首尾预览，不破坏工具执行结果
    }
  }

  const hint = opts.fallbackHint ?? 'narrow the query or request a smaller slice'
  return { text: `${head}\n…(${omitted} characters omitted — ${hint})…\n${tail}` }
}

/** 清理各同事工作区下过期的 .spill 文件；进入目录和删文件前均校验 lstat 非符号链接。 */
export async function pruneSpills(dataDir: string, beforeMs: number): Promise<number> {
  const workspacesRoot = join(dataDir, 'workspaces')
  const botEntries = await readdir(workspacesRoot, { withFileTypes: true }).catch(() => [])
  let removed = 0
  for (const entry of botEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_ID.test(entry.name) || entry.name === '..') continue
    const spillRoot = join(workspacesRoot, entry.name, SPILL_DIR)
    const dirStat = await lstat(spillRoot).catch(() => null)
    if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) continue
    const files = await readdir(spillRoot).catch(() => [] as string[])
    for (const file of files) {
      const m = SPILL_FILE.exec(file)
      if (!m) continue
      const ts = Number(m[1])
      if (!Number.isFinite(ts) || ts <= 0 || ts >= beforeMs) continue
      const full = join(spillRoot, file)
      const fileStat = await lstat(full).catch(() => null)
      if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) continue
      await rm(full, { force: true })
      removed++
    }
  }
  return removed
}
