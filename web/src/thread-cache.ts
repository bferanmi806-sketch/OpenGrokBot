import type { Message } from './types'

export const DEFAULT_THREAD_CACHE_MAX = 10

export type ThreadCache = {
  get(threadId: string): Message[] | undefined
  set(threadId: string, messages: readonly Message[], isPinned?: (threadId: string) => boolean): void
  /** 仅当该线程已在缓存中时静默增量更新（同 id 就地替换，新 id 按升序插入）；不触发任何 UI 渲染。 */
  upsertMessage(threadId: string, message: Message): boolean
  has(threadId: string): boolean
  size(): number
  clear(exceptThreadId?: string): void
}

/**
 * 最近访问线程 LRU 消息缓存（借鉴 DeepSeek Harness Retain Facets / recentViews）：
 * 切走同事对话时只保留数据快照与后台 WS 静默增量，不做隐藏视图渲染；切回时零白屏秒开。
 */
export function createThreadCache(maxEntries = DEFAULT_THREAD_CACHE_MAX): ThreadCache {
  const limit = Math.max(1, Math.floor(maxEntries))
  const hardLimit = limit * 2
  const entries = new Map<string, Message[]>()

  const evict = (isPinned?: (threadId: string) => boolean) => {
    if (entries.size <= limit) return
    for (const key of [...entries.keys()]) {
      if (entries.size <= limit) break
      if (isPinned?.(key)) continue
      entries.delete(key)
    }
    // 即使大量活跃线程被钉住，也要守住内存硬上限
    for (const key of [...entries.keys()]) {
      if (entries.size <= hardLimit) break
      entries.delete(key)
    }
  }

  return {
    get(threadId) {
      const hit = entries.get(threadId)
      if (!hit) return undefined
      entries.delete(threadId)
      entries.set(threadId, hit)
      return [...hit]
    },
    set(threadId, messages, isPinned) {
      entries.delete(threadId)
      entries.set(threadId, [...messages])
      evict(isPinned)
    },
    upsertMessage(threadId, message) {
      const list = entries.get(threadId)
      if (!list) return false
      const idx = list.findIndex((m) => m.id === message.id)
      if (idx !== -1) {
        const next = [...list]
        next[idx] = message
        entries.set(threadId, next)
        return true
      }
      const last = list[list.length - 1]
      if (!last || message.id > last.id) {
        entries.set(threadId, [...list, message])
      } else {
        const next = [...list, message].sort((a, b) => a.id - b.id)
        entries.set(threadId, next)
      }
      return true
    },
    has: (threadId) => entries.has(threadId),
    size: () => entries.size,
    clear(exceptThreadId) {
      if (!exceptThreadId) {
        entries.clear()
        return
      }
      const keep = entries.get(exceptThreadId)
      entries.clear()
      if (keep) entries.set(exceptThreadId, keep)
    },
  }
}
