import { describe, expect, it } from 'vitest'
import { createThreadCache } from './thread-cache'
import type { Message } from './types'

const msg = (id: number, thread_id: string, content = `m${id}`): Message => ({
  id,
  thread_id,
  sender: 'researcher',
  kind: 'text',
  content,
  payload: null,
  created_at: id * 1000,
})

describe('createThreadCache', () => {
  it('stores recent threads, refreshes LRU on get, and evicts least-recently-used unpinned threads', () => {
    const cache = createThreadCache(2)
    cache.set('dm:a', [msg(1, 'dm:a')])
    cache.set('dm:b', [msg(2, 'dm:b')])
    // Touch dm:a so dm:b becomes least recently used
    expect(cache.get('dm:a')?.map((m) => m.id)).toEqual([1])
    cache.set('dm:c', [msg(3, 'dm:c')])
    expect(cache.has('dm:b')).toBe(false)
    expect(cache.has('dm:a')).toBe(true)
    expect(cache.has('dm:c')).toBe(true)
  })

  it('keeps pinned active threads from being evicted while unpinned ones exist', () => {
    const cache = createThreadCache(2)
    cache.set('dm:busy', [msg(1, 'dm:busy')])
    cache.set('dm:idle', [msg(2, 'dm:idle')])
    cache.set('dm:new', [msg(3, 'dm:new')], (id) => id === 'dm:busy')
    expect(cache.has('dm:busy')).toBe(true)
    expect(cache.has('dm:idle')).toBe(false)
    expect(cache.has('dm:new')).toBe(true)
  })

  it('silently upserts live messages into cached threads only and replaces same-id updates in place', () => {
    const cache = createThreadCache(5)
    expect(cache.upsertMessage('dm:unvisited', msg(1, 'dm:unvisited'))).toBe(false)
    expect(cache.has('dm:unvisited')).toBe(false)

    cache.set('dm:a', [msg(1, 'dm:a', 'first'), msg(3, 'dm:a', 'third')])
    expect(cache.upsertMessage('dm:a', msg(2, 'dm:a', 'middle'))).toBe(true)
    expect(cache.upsertMessage('dm:a', msg(3, 'dm:a', 'third-updated'))).toBe(true)
    expect(cache.upsertMessage('dm:a', msg(4, 'dm:a', 'fourth'))).toBe(true)

    expect(cache.get('dm:a')?.map((m) => `${m.id}:${m.content}`)).toEqual([
      '1:first',
      '2:middle',
      '3:third-updated',
      '4:fourth',
    ])
  })

  it('clears stale entries on reconnect while optionally keeping the active thread', () => {
    const cache = createThreadCache(5)
    cache.set('dm:a', [msg(1, 'dm:a')])
    cache.set('dm:b', [msg(2, 'dm:b')])
    cache.clear('dm:a')
    expect(cache.has('dm:a')).toBe(true)
    expect(cache.has('dm:b')).toBe(false)
    cache.clear()
    expect(cache.size()).toBe(0)
  })
})
