import type { ChatOptions, LLM } from './llm.js'

export const MAX_LOCAL_LLM_CONCURRENCY = 8
export const DEFAULT_LOCAL_LLM_CONCURRENCY = 1

export type LlmPriority = 'interactive' | 'background' | 'routine' | 'low'

export const LLM_PRIORITY_RANK: Record<LlmPriority, number> = {
  interactive: 0,
  background: 1,
  routine: 2,
  low: 3,
}

export type LlmQueueEndpointView = {
  key: string
  active: number
  queued: number
  byPriority: Record<LlmPriority, number>
}

export type LlmQueueSnapshot = {
  concurrency: number
  endpoints: LlmQueueEndpointView[]
}

export type LlmQueue = {
  run<T>(key: string, priority: LlmPriority, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>
  wrap(llm: LLM, baseURL: string | (() => string), opts?: { model?: string | (() => string) }): LLM
  notifyConcurrencyChange(): void
  snapshot(): LlmQueueSnapshot
}

/** 校验设置值：0 = 不限，1..MAX_LOCAL_LLM_CONCURRENCY = 并发上限；其它一律拒收 */
export function parseLocalLlmConcurrency(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < 0 || value > MAX_LOCAL_LLM_CONCURRENCY) return undefined
  return value === 0 ? 0 : value
}

/** 解析环境变量 OPENSUPERBOT_LOCAL_LLM_CONCURRENCY：不合法或空白退回默认值 */
export function parseLocalLlmConcurrencyEnv(
  value: string | undefined,
  fallback: number = DEFAULT_LOCAL_LLM_CONCURRENCY,
): number {
  if (value === undefined) return fallback
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return fallback
  return parseLocalLlmConcurrency(Number(trimmed)) ?? fallback
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return null
  const a = Number(match[1])
  const b = Number(match[2])
  const c = Number(match[3])
  const d = Number(match[4])
  if (a > 255 || b > 255 || c > 255 || d > 255) return null
  return [a, b, c, d]
}

function classifyIpv4(octets: [number, number, number, number], port: string): string | null {
  const [a, b, c, d] = octets
  // 127.0.0.0/8 loopback or 0.0.0.0 unspecified
  if (a === 127 || (a === 0 && b === 0 && c === 0 && d === 0)) {
    return `local:loopback:${port}`
  }
  // RFC-1918 private LAN + 169.254.0.0/16 link-local
  const isPrivate =
    a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
  if (isPrivate) {
    return `local:lan:${a}.${b}.${c}.${d}:${port}`
  }
  return null
}

function parseIpv6Hextets(addr: string): number[] | null {
  const zoneIdx = addr.indexOf('%')
  let input = zoneIdx === -1 ? addr : addr.slice(0, zoneIdx)
  if (!input) return null

  // Handle dotted-decimal IPv4 tail (e.g. ::ffff:127.0.0.1) if not already hex-normalized
  const lastColon = input.lastIndexOf(':')
  if (lastColon !== -1 && input.slice(lastColon + 1).includes('.')) {
    const ipv4 = parseIpv4(input.slice(lastColon + 1))
    if (!ipv4) return null
    const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16)
    const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16)
    input = `${input.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const parts = input.split('::')
  if (parts.length > 2) return null

  const parseGroups = (segment: string): number[] | null => {
    if (!segment) return []
    const groups = segment.split(':')
    const out: number[] = []
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }

  const left = parseGroups(parts[0]!)
  if (!left) return null
  if (parts.length === 1) {
    return left.length === 8 ? left : null
  }
  const right = parseGroups(parts[1]!)
  if (!right) return null
  const missing = 8 - (left.length + right.length)
  if (missing < 1) return null
  return [...left, ...new Array<number>(missing).fill(0), ...right]
}

/**
 * 判断模型接口地址是不是本地或局域网自建服务，并返回归一化后的队列键。
 * - 本机回环及容器宿主机别名统一归到 `local:loopback:<port>`（localhost / 127.0.0.1 / [::1] 共享同一把锁）
 * - 局域网私有 IP / mDNS 按主机和端口分桶
 * - 公网云 API 或非 http(s) 地址返回 null（完全绕过队列）
 */
export function localEndpointKey(baseURL: string): string | null {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  const rawHost = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!rawHost) return null

  // IPv6 literal wrapped in [...]
  if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
    const bare = rawHost.slice(1, -1)
    const h = parseIpv6Hextets(bare)
    if (!h) return null

    // :: (unspecified) or ::1 (loopback)
    const zeroPrefix = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0
    if (zeroPrefix && (h[7] === 0 || h[7] === 1)) {
      return `local:loopback:${port}`
    }

    // IPv4-mapped IPv6 ::ffff:0:0/96
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
      const octets: [number, number, number, number] = [
        (h[6]! >> 8) & 0xff,
        h[6]! & 0xff,
        (h[7]! >> 8) & 0xff,
        h[7]! & 0xff,
      ]
      return classifyIpv4(octets, port)
    }

    // IPv6 ULA fc00::/7 or link-local fe80::/10
    if ((h[0]! & 0xfe00) === 0xfc00 || (h[0]! & 0xffc0) === 0xfe80) {
      return `local:lan:[${bare}]:${port}`
    }
    return null
  }

  // IPv4 literal
  const ipv4 = parseIpv4(rawHost)
  if (ipv4) {
    return classifyIpv4(ipv4, port)
  }

  // Loopback & container-host aliases
  if (
    rawHost === 'localhost'
    || (!rawHost.startsWith('.') && !rawHost.includes('..') && rawHost.endsWith('.localhost'))
    || rawHost === 'host.docker.internal'
    || rawHost === 'host.containers.internal'
  ) {
    return `local:loopback:${port}`
  }

  // mDNS local hostname (e.g. mac-studio.local)
  if (!rawHost.startsWith('.') && !rawHost.includes('..') && rawHost.endsWith('.local')) {
    return `local:mdns:${rawHost}:${port}`
  }

  return null
}

type Waiter = {
  priority: LlmPriority
  rank: number
  seq: number
  signal?: AbortSignal
  onAbort?: () => void
  granted: boolean
  cancelled: boolean
  resolve: () => void
  reject: (err: Error) => void
}

type Lane = {
  active: number
  waiters: Waiter[]
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError')
}

function insertWaiter(waiters: Waiter[], waiter: Waiter): void {
  let idx = waiters.length
  while (idx > 0) {
    const prev = waiters[idx - 1]!
    if (prev.rank < waiter.rank || (prev.rank === waiter.rank && prev.seq < waiter.seq)) break
    idx -= 1
  }
  waiters.splice(idx, 0, waiter)
}

function normalizePriority(priority: unknown): LlmPriority {
  return typeof priority === 'string' && Object.hasOwn(LLM_PRIORITY_RANK, priority)
    ? (priority as LlmPriority)
    : 'interactive'
}

/**
 * 本地模型优先级信号量队列：
 * 每个本地端点独立计数，按 (priority rank ASC, FIFO seq ASC) 放行，确保交互式对话在步骤间插队。
 */
export function createLlmQueue(opts?: { concurrency?: number | (() => number) }): LlmQueue {
  const rawConcurrency = opts?.concurrency
  const lanes = new Map<string, Lane>()
  let nextSeq = 0

  function resolveConcurrency(): number {
    let raw: unknown
    try {
      raw = typeof rawConcurrency === 'function' ? rawConcurrency() : rawConcurrency
    } catch {
      return DEFAULT_LOCAL_LLM_CONCURRENCY
    }
    if (raw === undefined) return DEFAULT_LOCAL_LLM_CONCURRENCY
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LOCAL_LLM_CONCURRENCY
    if (raw <= 0) return 0
    if (raw > MAX_LOCAL_LLM_CONCURRENCY) return MAX_LOCAL_LLM_CONCURRENCY
    const floored = Math.floor(raw)
    return floored >= 1 ? floored : DEFAULT_LOCAL_LLM_CONCURRENCY
  }

  function getLane(key: string): Lane {
    let lane = lanes.get(key)
    if (!lane) {
      lane = { active: 0, waiters: [] }
      lanes.set(key, lane)
    }
    return lane
  }

  function cleanupLane(key: string, lane: Lane): void {
    if (lane.active === 0 && lane.waiters.length === 0) {
      lanes.delete(key)
    }
  }

  function pump(key: string): void {
    const lane = lanes.get(key)
    if (!lane) return
    const limit = resolveConcurrency()
    while (lane.waiters.length > 0 && (limit <= 0 || lane.active < limit)) {
      const next = lane.waiters.shift()!
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener('abort', next.onAbort)
      }
      if (next.cancelled) continue
      if (next.signal?.aborted) {
        next.cancelled = true
        next.reject(abortError(next.signal))
        continue
      }
      next.granted = true
      lane.active += 1
      next.resolve()
    }
    cleanupLane(key, lane)
  }

  async function run<T>(
    key: string,
    priority: LlmPriority,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      throw abortError(signal)
    }

    const tier = normalizePriority(priority)
    const lane = getLane(key)
    const limit = resolveConcurrency()

    if (limit <= 0) {
      if (lane.waiters.length > 0) pump(key)
      lane.active += 1
    } else if (lane.active < limit && lane.waiters.length === 0) {
      lane.active += 1
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          priority: tier,
          rank: LLM_PRIORITY_RANK[tier],
          seq: nextSeq++,
          signal,
          granted: false,
          cancelled: false,
          resolve,
          reject,
        }
        if (signal) {
          const onAbort = () => {
            if (waiter.granted || waiter.cancelled) return
            waiter.cancelled = true
            const idx = lane.waiters.indexOf(waiter)
            if (idx !== -1) lane.waiters.splice(idx, 1)
            cleanupLane(key, lane)
            reject(abortError(signal))
          }
          waiter.onAbort = onAbort
          signal.addEventListener('abort', onAbort, { once: true })
        }
        insertWaiter(lane.waiters, waiter)
        if (lane.active < limit) pump(key)
      })
    }

    try {
      if (signal?.aborted) {
        throw abortError(signal)
      }
      return await fn()
    } finally {
      lane.active -= 1
      pump(key)
    }
  }

  function notifyConcurrencyChange(): void {
    for (const key of [...lanes.keys()]) {
      pump(key)
    }
  }

  function wrap(
    llm: LLM,
    baseURL: string | (() => string),
    wrapOpts?: { model?: string | (() => string) },
  ): LLM {
    return {
      chat(messages, tools, chatOpts?: ChatOptions) {
        const model = typeof wrapOpts?.model === 'function' ? wrapOpts.model() : wrapOpts?.model
        if (model === 'stub') return llm.chat(messages, tools, chatOpts)
        const url = typeof baseURL === 'function' ? baseURL() : baseURL
        const key = localEndpointKey(url)
        if (!key) return llm.chat(messages, tools, chatOpts)
        const priority = normalizePriority(chatOpts?.priority)
        return run(key, priority, () => llm.chat(messages, tools, chatOpts), chatOpts?.signal)
      },
    }
  }

  function snapshot(): LlmQueueSnapshot {
    const endpoints: LlmQueueEndpointView[] = []
    for (const [key, lane] of lanes) {
      if (lane.active === 0 && lane.waiters.length === 0) continue
      const byPriority: Record<LlmPriority, number> = {
        interactive: 0,
        background: 0,
        routine: 0,
        low: 0,
      }
      let queued = 0
      for (const waiter of lane.waiters) {
        if (!waiter.cancelled) {
          byPriority[waiter.priority] += 1
          queued += 1
        }
      }
      endpoints.push({
        key,
        active: lane.active,
        queued,
        byPriority,
      })
    }
    endpoints.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return {
      concurrency: resolveConcurrency(),
      endpoints,
    }
  }

  return { run, wrap, notifyConcurrencyChange, snapshot }
}
