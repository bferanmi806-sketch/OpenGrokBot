import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db.js'
import type { AssistantTurn, LLM } from '../src/llm.js'
import {
  DEFAULT_LOCAL_LLM_CONCURRENCY,
  LLM_PRIORITY_RANK,
  MAX_LOCAL_LLM_CONCURRENCY,
  createLlmQueue,
  localEndpointKey,
  parseLocalLlmConcurrency,
  parseLocalLlmConcurrencyEnv,
  type LlmPriority,
} from '../src/llm-queue.js'
import {
  SETTING_DEFAULTS,
  applySettings,
  currentConfig,
  lockedKeys,
  readSavedSettings,
  resolveSettings,
  saveSettings,
} from '../src/settings.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const okTurn = (content = 'ok'): AssistantTurn => ({
  content,
  toolCalls: [],
  raw: { role: 'assistant', content },
})

describe('localEndpointKey', () => {
  it('collapses loopback and container-host aliases on the same port to one shared key', () => {
    const urls = [
      'http://localhost:11434/v1',
      'http://LOCALHOST.:11434/v1',
      'http://ollama.localhost:11434/v1',
      'http://127.0.0.1:11434/v1',
      'http://127.0.0.2:11434/v1',
      'http://127.255.255.254:11434/v1',
      'http://0.0.0.0:11434/v1',
      'http://[::1]:11434/v1',
      'http://[0:0:0:0:0:0:0:1]:11434/v1',
      'http://[::]:11434/v1',
      'http://[0:0:0:0:0:0:0:0]:11434/v1',
      'http://[::ffff:127.0.0.1]:11434/v1',
      'http://[::ffff:7f00:1]:11434/v1',
      'http://[::ffff:127.0.1.5]:11434/v1',
      'http://[::ffff:0.0.0.0]:11434/v1',
      'http://[::ffff:0:0]:11434/v1',
      'http://host.docker.internal:11434/v1',
      'http://host.containers.internal:11434/v1',
    ]
    for (const url of urls) {
      expect(localEndpointKey(url), url).toBe('local:loopback:11434')
    }
  })

  it('keeps distinct ports separate and normalizes implicit default ports 80 and 443', () => {
    expect(localEndpointKey('http://localhost:11434/v1')).toBe('local:loopback:11434')
    expect(localEndpointKey('http://localhost:1234/v1')).toBe('local:loopback:1234')
    expect(localEndpointKey('http://localhost/v1')).toBe('local:loopback:80')
    expect(localEndpointKey('http://127.0.0.1:80/v1')).toBe('local:loopback:80')
    expect(localEndpointKey('https://localhost/v1')).toBe('local:loopback:443')
    expect(localEndpointKey('https://[::1]:443/v1')).toBe('local:loopback:443')
  })

  it('classifies *.local mDNS hosts per hostname and port', () => {
    expect(localEndpointKey('http://mac-studio.local:11434/v1')).toBe('local:mdns:mac-studio.local:11434')
    expect(localEndpointKey('https://GPU-Box.LOCAL./v1')).toBe('local:mdns:gpu-box.local:443')
    expect(localEndpointKey('http://local:11434/v1')).toBeNull()
    expect(localEndpointKey('http://foo.local.com:11434/v1')).toBeNull()
    expect(localEndpointKey('http://.local:11434/v1')).toBeNull()
  })

  it('classifies RFC-1918 and link-local IPv4 (including IPv4-mapped IPv6) and rejects adjacent public ranges', () => {
    expect(localEndpointKey('http://10.0.0.5:11434/v1')).toBe('local:lan:10.0.0.5:11434')
    expect(localEndpointKey('http://172.16.0.1:8000/v1')).toBe('local:lan:172.16.0.1:8000')
    expect(localEndpointKey('http://172.31.255.254:8000/v1')).toBe('local:lan:172.31.255.254:8000')
    expect(localEndpointKey('http://192.168.1.50:11434/v1')).toBe('local:lan:192.168.1.50:11434')
    expect(localEndpointKey('http://169.254.10.20:11434/v1')).toBe('local:lan:169.254.10.20:11434')

    // IPv4-mapped IPv6 LAN aliases collapse to canonical dotted IPv4 key
    expect(localEndpointKey('http://[::ffff:192.168.1.50]:11434/v1')).toBe('local:lan:192.168.1.50:11434')
    expect(localEndpointKey('http://[::ffff:c0a8:132]:11434/v1')).toBe('local:lan:192.168.1.50:11434')
    expect(localEndpointKey('http://[::ffff:10.0.0.5]:11434/v1')).toBe('local:lan:10.0.0.5:11434')
    expect(localEndpointKey('http://[::ffff:172.16.0.1]:8000/v1')).toBe('local:lan:172.16.0.1:8000')
    expect(localEndpointKey('http://[::ffff:169.254.10.20]:11434/v1')).toBe('local:lan:169.254.10.20:11434')

    // Non-private boundary IPv4 and IPv4-mapped public IPv6
    expect(localEndpointKey('http://172.15.255.255:8000/v1')).toBeNull()
    expect(localEndpointKey('http://172.32.0.1:8000/v1')).toBeNull()
    expect(localEndpointKey('http://192.169.1.1:11434/v1')).toBeNull()
    expect(localEndpointKey('http://169.253.1.1:11434/v1')).toBeNull()
    expect(localEndpointKey('http://1.1.1.1:11434/v1')).toBeNull()
    expect(localEndpointKey('http://[::ffff:8.8.8.8]:11434/v1')).toBeNull()
  })

  it('classifies IPv6 ULA (fc00::/7) and link-local (fe80::/10) and rejects global IPv6', () => {
    expect(localEndpointKey('http://[fc00::1]:11434/v1')).toBe('local:lan:[fc00::1]:11434')
    expect(localEndpointKey('http://[fd12::1]:11434/v1')).toBe('local:lan:[fd12::1]:11434')
    expect(localEndpointKey('http://[fdff::abcd]:11434/v1')).toBe('local:lan:[fdff::abcd]:11434')
    expect(localEndpointKey('http://[fe80::1]:11434/v1')).toBe('local:lan:[fe80::1]:11434')
    expect(localEndpointKey('http://[febf::1]:11434/v1')).toBe('local:lan:[febf::1]:11434')

    expect(localEndpointKey('http://[fbff::1]:11434/v1')).toBeNull()
    expect(localEndpointKey('http://[fe00::1]:11434/v1')).toBeNull()
    expect(localEndpointKey('http://[fe7f::1]:11434/v1')).toBeNull()
    expect(localEndpointKey('http://[fec0::1]:11434/v1')).toBeNull()
    expect(localEndpointKey('http://[2001:4860:4860::8888]:11434/v1')).toBeNull()
  })

  it('returns null for public cloud APIs and invalid or non-http URLs', () => {
    const bypass = [
      'https://api.openai.com/v1',
      'https://api.anthropic.com',
      'https://api.deepseek.com/v1',
      'https://api.x.ai/v1',
      'http://localhost.evil.com:11434/v1',
      'http://notlocalhost:11434/v1',
      'http://.localhost:11434/v1',
      'file:///etc/passwd',
      'ws://localhost:11434/v1',
      'ftp://localhost:21',
      'not a url',
      '',
    ]
    for (const url of bypass) {
      expect(localEndpointKey(url), url).toBeNull()
    }
  })
})

describe('createLlmQueue', () => {
  it('dispatches queued work in strict priority order and FIFO within each tier', async () => {
    expect(LLM_PRIORITY_RANK).toEqual({ interactive: 0, background: 1, routine: 2, low: 3 })

    const queue = createLlmQueue({ concurrency: 1 })
    const key = 'local:loopback:11434'
    const blocker = deferred()
    const order: string[] = []

    const first = queue.run(key, 'routine', async () => {
      order.push('holder')
      await blocker.promise
      return 'holder'
    })

    const enqueue = (label: string, priority: LlmPriority) =>
      queue.run(key, priority, async () => {
        order.push(label)
        return label
      })

    const pLow = enqueue('low', 'low')
    const pRoutine1 = enqueue('routine #1', 'routine')
    const pBg = enqueue('background', 'background')
    const pInteractive1 = enqueue('interactive #1', 'interactive')
    const pRoutine2 = enqueue('routine #2', 'routine')
    const pInteractive2 = enqueue('interactive #2', 'interactive')

    expect(queue.snapshot()).toEqual({
      concurrency: 1,
      endpoints: [
        {
          key,
          active: 1,
          queued: 6,
          byPriority: { interactive: 2, background: 1, routine: 2, low: 1 },
        },
      ],
    })

    blocker.resolve()
    const results = await Promise.all([first, pLow, pRoutine1, pBg, pInteractive1, pRoutine2, pInteractive2])
    expect(results).toEqual(['holder', 'low', 'routine #1', 'background', 'interactive #1', 'routine #2', 'interactive #2'])
    expect(order).toEqual([
      'holder',
      'interactive #1',
      'interactive #2',
      'background',
      'routine #1',
      'routine #2',
      'low',
    ])
    expect(queue.snapshot()).toEqual({ concurrency: 1, endpoints: [] })
  })

  it('tracks independent endpoints separately and sorts snapshot keys', async () => {
    const queue = createLlmQueue({ concurrency: 1 })
    const a = deferred()
    const b = deferred()
    let bStarted = false

    const runA = queue.run('local:loopback:11434', 'routine', async () => {
      await a.promise
    })
    const runB = queue.run('local:lan:192.168.1.50:11434', 'routine', async () => {
      bStarted = true
      await b.promise
    })

    expect(bStarted).toBe(true)
    expect(queue.snapshot().endpoints.map((e) => e.key)).toEqual([
      'local:lan:192.168.1.50:11434',
      'local:loopback:11434',
    ])

    a.resolve()
    b.resolve()
    await Promise.all([runA, runB])
    expect(queue.snapshot().endpoints).toEqual([])
  })

  it('handles pre-aborted and in-queue AbortSignal cancellations cleanly without calling fn', async () => {
    const queue = createLlmQueue({ concurrency: 1 })
    const key = 'local:loopback:11434'

    // 1. Pre-aborted signal with default AbortError and custom Error reason
    const preDefault = new AbortController()
    preDefault.abort()
    const fnPreDefault = vi.fn(async () => 'nope')
    await expect(queue.run(key, 'interactive', fnPreDefault, preDefault.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fnPreDefault).not.toHaveBeenCalled()

    const preCustom = new AbortController()
    preCustom.abort(new Error('stopped by operator'))
    const fnPreCustom = vi.fn(async () => 'nope')
    await expect(queue.run(key, 'interactive', fnPreCustom, preCustom.signal)).rejects.toThrow('stopped by operator')
    expect(fnPreCustom).not.toHaveBeenCalled()
    expect(queue.snapshot().endpoints).toEqual([])

    // 2. Abort while waiting in queue
    const blocker = deferred()
    const active = queue.run(key, 'interactive', async () => {
      await blocker.promise
      return 'first'
    })

    const ac1 = new AbortController()
    const fnCancelled = vi.fn(async () => 'cancelled')
    const pCancelled = queue.run(key, 'interactive', fnCancelled, ac1.signal)

    const fnKept = vi.fn(async () => 'kept')
    const pKept = queue.run(key, 'routine', fnKept)

    expect(queue.snapshot().endpoints[0]).toMatchObject({
      active: 1,
      queued: 2,
      byPriority: { interactive: 1, background: 0, routine: 1, low: 0 },
    })

    ac1.abort()
    // Removed synchronously upon abort
    expect(queue.snapshot().endpoints[0]).toMatchObject({
      active: 1,
      queued: 1,
      byPriority: { interactive: 0, background: 0, routine: 1, low: 0 },
    })
    await expect(pCancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(fnCancelled).not.toHaveBeenCalled()

    blocker.resolve()
    expect(await active).toBe('first')
    expect(await pKept).toBe('kept')
    expect(fnKept).toHaveBeenCalledTimes(1)
    expect(queue.snapshot().endpoints).toEqual([])
  })

  it('releases slot if a granted waiter is aborted before resuming', async () => {
    let limit = 1
    const queue = createLlmQueue({ concurrency: () => limit })
    const key = 'local:loopback:11434'
    const blocker = deferred()
    const active = queue.run(key, 'interactive', () => blocker.promise)

    const ac = new AbortController()
    const fnAborted = vi.fn(async () => 'aborted')
    const pAborted = queue.run(key, 'interactive', fnAborted, ac.signal)
    const pNext = queue.run(key, 'routine', async () => 'next')

    // Synchronously grant slot 2 to pAborted, then abort before pAborted's microtask resumes
    limit = 2
    queue.notifyConcurrencyChange()
    ac.abort()

    await expect(pAborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(fnAborted).not.toHaveBeenCalled()
    // Slot 2 must have been released so pNext runs immediately even while slot 1 is still blocked
    expect(await pNext).toBe('next')

    blocker.resolve()
    await active
    expect(queue.snapshot().endpoints).toEqual([])
  })

  it('releases the slot and cleans up when fn throws or rejects', async () => {
    const queue = createLlmQueue({ concurrency: 1 })
    const key = 'local:loopback:11434'
    const blocker = deferred()

    const failing = queue.run(key, 'interactive', async () => {
      await blocker.promise
      throw new Error('boom')
    })
    const next = queue.run(key, 'routine', async () => 'recovered')

    blocker.reject(new Error('boom'))
    await expect(failing).rejects.toThrow('boom')
    expect(await next).toBe('recovered')
    expect(queue.snapshot().endpoints).toEqual([])
  })

  it('immediately dispatches queued waiters when concurrency increases or becomes unlimited (0)', async () => {
    let limit = 1
    const queue = createLlmQueue({ concurrency: () => limit })
    const key = 'local:loopback:11434'

    const d1 = deferred()
    const d2 = deferred()
    const d3 = deferred()
    const d4 = deferred()
    const started: string[] = []

    const p1 = queue.run(key, 'routine', async () => { started.push('1'); await d1.promise })
    const pLow = queue.run(key, 'low', async () => { started.push('low'); await d4.promise })
    const pInteractive = queue.run(key, 'interactive', async () => { started.push('interactive'); await d2.promise })
    const pBg = queue.run(key, 'background', async () => { started.push('background'); await d3.promise })

    expect(started).toEqual(['1'])
    expect(queue.snapshot()).toEqual({
      concurrency: 1,
      endpoints: [{ key, active: 1, queued: 3, byPriority: { interactive: 1, background: 1, routine: 0, low: 1 } }],
    })

    // Raise 1 -> 2: immediately dispatches highest-priority waiter ('interactive')
    limit = 2
    queue.notifyConcurrencyChange()
    await vi.waitFor(() => expect(started).toEqual(['1', 'interactive']))
    expect(queue.snapshot()).toEqual({
      concurrency: 2,
      endpoints: [{ key, active: 2, queued: 2, byPriority: { interactive: 0, background: 1, routine: 0, low: 1 } }],
    })

    // Set 2 -> 0 (unlimited): drains all remaining queued waiters immediately in priority order
    limit = 0
    queue.notifyConcurrencyChange()
    await vi.waitFor(() => expect(started).toEqual(['1', 'interactive', 'background', 'low']))
    expect(queue.snapshot()).toEqual({
      concurrency: 0,
      endpoints: [{ key, active: 4, queued: 0, byPriority: { interactive: 0, background: 0, routine: 0, low: 0 } }],
    })

    d1.resolve()
    d2.resolve()
    d3.resolve()
    d4.resolve()
    await Promise.all([p1, pLow, pInteractive, pBg])
    expect(queue.snapshot()).toEqual({ concurrency: 0, endpoints: [] })
  })

  it('clamps invalid concurrency values safely and respects 0 -> 1 transitions', async () => {
    expect(createLlmQueue({ concurrency: Number.NaN }).snapshot().concurrency).toBe(DEFAULT_LOCAL_LLM_CONCURRENCY)
    expect(createLlmQueue({ concurrency: 99 }).snapshot().concurrency).toBe(MAX_LOCAL_LLM_CONCURRENCY)
    expect(createLlmQueue({ concurrency: -5 }).snapshot().concurrency).toBe(0)

    let limit = 0
    const queue = createLlmQueue({ concurrency: () => limit })
    const key = 'local:loopback:11434'
    const d1 = deferred()
    let secondStarted = false

    const p1 = queue.run(key, 'routine', async () => { await d1.promise })
    expect(queue.snapshot().endpoints[0]).toMatchObject({ active: 1, queued: 0 })

    // Tightening 0 -> 1 while p1 is active makes p2 wait until p1 finishes
    limit = 1
    const p2 = queue.run(key, 'interactive', async () => { secondStarted = true })
    await Promise.resolve()
    expect(secondStarted).toBe(false)
    expect(queue.snapshot().endpoints[0]).toMatchObject({ active: 1, queued: 1 })

    d1.resolve()
    await Promise.all([p1, p2])
    expect(secondStarted).toBe(true)
    expect(queue.snapshot().endpoints).toEqual([])
  })

  it('wrap() bypasses stub model and public cloud URLs, and shares one semaphore across loopback aliases', async () => {
    const queue = createLlmQueue({ concurrency: 1 })

    // 1. model === 'stub' bypasses queue even on localhost
    const dStub1 = deferred()
    let stub2Entered = false
    const stubInner: LLM = {
      chat: async (msgs) => {
        if (msgs[0]?.content === '1') await dStub1.promise
        else stub2Entered = true
        return okTurn('stub')
      },
    }
    const stubWrapped = queue.wrap(stubInner, 'http://localhost:11434/v1', { model: () => 'stub' })
    const s1 = stubWrapped.chat([{ role: 'user', content: '1' }], [])
    const s2 = stubWrapped.chat([{ role: 'user', content: '2' }], [])
    expect(stub2Entered).toBe(true)
    expect(queue.snapshot().endpoints).toEqual([])
    dStub1.resolve()
    await Promise.all([s1, s2])

    // 2. Public cloud URL bypasses queue completely
    const dCloud1 = deferred()
    let cloud2Entered = false
    const cloudInner: LLM = {
      chat: async (msgs) => {
        if (msgs[0]?.content === '1') await dCloud1.promise
        else cloud2Entered = true
        return okTurn('cloud')
      },
    }
    const cloudWrapped = queue.wrap(cloudInner, 'https://api.openai.com/v1', { model: 'gpt-4o' })
    const c1 = cloudWrapped.chat([{ role: 'user', content: '1' }], [])
    const c2 = cloudWrapped.chat([{ role: 'user', content: '2' }], [])
    expect(cloud2Entered).toBe(true)
    expect(queue.snapshot().endpoints).toEqual([])
    dCloud1.resolve()
    await Promise.all([c1, c2])

    // 3. Two separate LLM instances using localhost:11434 and 127.0.0.1:11434 share the same queue
    const dHold = deferred()
    const order: string[] = []
    const makeInner = (tag: string): LLM => ({
      chat: async (msgs) => {
        const id = `${tag}:${msgs[0]?.content}`
        order.push(id)
        if (id === 'a:hold') await dHold.promise
        return okTurn(id)
      },
    })
    const llmA = queue.wrap(makeInner('a'), 'http://localhost:11434/v1', { model: 'qwen3' })
    const llmB = queue.wrap(makeInner('b'), () => 'http://127.0.0.1:11434/v1', { model: () => 'llama3' })

    const pHold = llmA.chat([{ role: 'user', content: 'hold' }], [], { priority: 'routine' })
    const pLow = llmB.chat([{ role: 'user', content: 'low' }], [], { priority: 'low' })
    const pDefaultInteractive = llmB.chat([{ role: 'user', content: 'chat' }], []) // defaults to interactive

    expect(queue.snapshot()).toEqual({
      concurrency: 1,
      endpoints: [
        {
          key: 'local:loopback:11434',
          active: 1,
          queued: 2,
          byPriority: { interactive: 1, background: 0, routine: 0, low: 1 },
        },
      ],
    })

    dHold.resolve()
    await Promise.all([pHold, pLow, pDefaultInteractive])
    expect(order).toEqual(['a:hold', 'b:chat', 'b:low'])
  })
})

describe('localLlmConcurrency config and settings validation', () => {
  it('validates integers 0..8 and rejects floats, negatives, >8, strings, and booleans', () => {
    for (let n = 0; n <= MAX_LOCAL_LLM_CONCURRENCY; n++) {
      expect(parseLocalLlmConcurrency(n)).toBe(n)
    }
    expect(Object.is(parseLocalLlmConcurrency(-0), 0)).toBe(true)
    for (const bad of [-1, 1.5, 9, Number.NaN, Number.POSITIVE_INFINITY, '2', '1', true, false, null, undefined, {}]) {
      expect(parseLocalLlmConcurrency(bad), String(bad)).toBeUndefined()
    }

    expect(parseLocalLlmConcurrencyEnv(undefined)).toBe(1)
    expect(parseLocalLlmConcurrencyEnv('')).toBe(1)
    expect(parseLocalLlmConcurrencyEnv('   ')).toBe(1)
    expect(parseLocalLlmConcurrencyEnv('0')).toBe(0)
    expect(parseLocalLlmConcurrencyEnv(' 4 ')).toBe(4)
    expect(parseLocalLlmConcurrencyEnv('8')).toBe(8)
    for (const bad of ['-1', '1.5', '9', '1e0', '0x2', 'abc']) {
      expect(parseLocalLlmConcurrencyEnv(bad), bad).toBe(1)
    }
  })

  it('loads OPENSUPERBOT_LOCAL_LLM_CONCURRENCY in loadConfig with safe fallback', () => {
    expect(loadConfig({}).localLlmConcurrency).toBe(1)
    expect(loadConfig({ OPENSUPERBOT_LOCAL_LLM_CONCURRENCY: '0' }).localLlmConcurrency).toBe(0)
    expect(loadConfig({ OPENSUPERBOT_LOCAL_LLM_CONCURRENCY: '3' }).localLlmConcurrency).toBe(3)
    expect(loadConfig({ OPENSUPERBOT_LOCAL_LLM_CONCURRENCY: '8' }).localLlmConcurrency).toBe(8)
    expect(loadConfig({ OPENSUPERBOT_LOCAL_LLM_CONCURRENCY: '-1' }).localLlmConcurrency).toBe(1)
    expect(loadConfig({ OPENSUPERBOT_LOCAL_LLM_CONCURRENCY: '1.5' }).localLlmConcurrency).toBe(1)
    expect(loadConfig({ OPENSUPERBOT_LOCAL_LLM_CONCURRENCY: '9' }).localLlmConcurrency).toBe(1)
    expect(loadConfig({ OPENSUPERBOT_LOCAL_LLM_CONCURRENCY: 'nope' }).localLlmConcurrency).toBe(1)
  })

  it('persists, validates, resolves, locks, and applies localLlmConcurrency in settings', () => {
    expect(SETTING_DEFAULTS.localLlmConcurrency).toBe(1)

    const db = openDb(':memory:')
    expect(saveSettings(db, { localLlmConcurrency: 0 })).toEqual({ ok: true })
    expect(readSavedSettings(db).localLlmConcurrency).toBe(0)

    expect(saveSettings(db, { localLlmConcurrency: 4 })).toEqual({ ok: true })
    expect(readSavedSettings(db).localLlmConcurrency).toBe(4)

    for (const bad of [-1, 1.5, 9, '2', true]) {
      const res = saveSettings(db, { localLlmConcurrency: bad })
      expect(res).toEqual({ ok: false, errors: [{ key: 'localLlmConcurrency', code: 'invalid' }] })
    }
    expect(readSavedSettings(db).localLlmConcurrency).toBe(4)

    const env = { OPENSUPERBOT_LOCAL_LLM_CONCURRENCY: '2' }
    expect(lockedKeys(env).has('localLlmConcurrency')).toBe(true)
    const resolved = resolveSettings(env, readSavedSettings(db))
    expect(resolved.values.localLlmConcurrency).toBe(2)
    expect(resolved.sources.localLlmConcurrency).toBe('env')

    const startup = loadConfig({ OPENSUPERBOT_DATA: '/tmp/ogb-llm-queue' })
    expect(applySettings(startup, resolveSettings({}, readSavedSettings(db)).values, '').localLlmConcurrency).toBe(4)
    expect(currentConfig(startup, {}, db).localLlmConcurrency).toBe(4)
    expect(currentConfig(startup, env, db).localLlmConcurrency).toBe(2)

    expect(saveSettings(db, { localLlmConcurrency: null })).toEqual({ ok: true })
    expect(readSavedSettings(db).localLlmConcurrency).toBeUndefined()
    expect(resolveSettings({}, readSavedSettings(db)).sources.localLlmConcurrency).toBe('default')
  })
})
