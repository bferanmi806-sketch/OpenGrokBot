import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { BackgroundTaskView, Conversation, DispatchPlanView, Message } from './types'

class FakeSocket {
  static last: FakeSocket | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) { FakeSocket.last = this }
  close() {}
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }) }
}

const conversation = (over: Partial<Conversation>): Conversation => ({
  id: 'dm:researcher', kind: 'dm', title: 'Scout', emoji: '🔎', subtitle: 'research',
  members: ['researcher'], last_message: null, pending: 0, ...over,
})

function mockGateway(opts: {
  session?: number
  conversations?: Conversation[]
  messages?: (url: string) => Promise<unknown> | unknown
  computer?: unknown
  /** 不为空时，/computer 的响应等它兑现了才回（模拟电脑在醒） */
  computerGate?: Promise<void>
  /** 设置里存的界面语言；不给 = 网关没有设置路由（老网关） */
  language?: string
  /** /api/setup 的回答；不给 = 老网关，没有向导 */
  setup?: unknown
  /** /api/connections 的回答；不给 = 老网关 */
  connections?: unknown
  /** /api/connectors 的回答；不给 = 老网关 */
  connectors?: unknown | (() => unknown)
  /** /api/mcp/servers 的回答；不给 = 老网关 */
  mcpServers?: unknown | (() => unknown)
  /** /api/feed 的回答；不给 = 老网关 */
  feed?: unknown
  /** /api/goals 的回答；不给 = 老网关 */
  goals?: unknown
  /** /api/spaces 的回答；不给 = 老网关 */
  spaces?: unknown
  /** /api/bots 的回答 */
  bots?: unknown[]
  /** /api/wiki/* 的回答 */
  wiki?: (url: string, init?: RequestInit) => unknown | Promise<unknown>
  /** POST /api/rule-proposals/:id 的回答 */
  resolveRuleProposal?: (url: string, body: Record<string, unknown>) => { status?: number; body: unknown }
  /** GET /api/bots/:botId/background-tasks 的回答 */
  backgroundTasks?: (url: string) => Promise<unknown> | unknown
  /** POST /api/background-tasks/:id/steer 的回答 */
  steerBackgroundTask?: (url: string, body: Record<string, unknown>) => { status?: number; body: unknown }
  /** POST /api/background-tasks/:id/cancel 的回答 */
  cancelBackgroundTask?: (url: string) => { status?: number; body: unknown }
  /** GET/PUT /api/threads/:id/team 的回答 */
  teamCharter?: (url: string, init?: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>
  /** POST /api/dispatch-plans/:id/start 的回答 */
  startDispatchPlan?: (url: string) => { status?: number; body: unknown }
  /** POST /api/dispatch-plans/:id/cancel 的回答 */
  cancelDispatchPlan?: (url: string) => { status?: number; body: unknown }
} = {}) {
  const calls: string[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    if (init?.method === 'POST') calls.push(`POST ${url} ${String(init.body ?? '')}`)
    if (init?.method === 'PUT') calls.push(`PUT ${url} ${String(init.body ?? '')}`)
    if (init?.method === 'DELETE') calls.push(`DELETE ${url}`)
    if (url === '/api/uploads' && init?.method === 'POST') {
      const sent = JSON.parse(String(init.body)) as { name: string; mime: string; data: string }
      return new Response(JSON.stringify({ id: 'c'.repeat(32), url: `/api/uploads/${'c'.repeat(32)}`, name: sent.name, mime: sent.mime, size: atob(sent.data).length }), { status: 201 })
    }
    if (url.startsWith('/api/uploads/') && init?.method === 'DELETE') return new Response(null, { status: 204 })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url === '/api/session') return json({ ok: opts.session === undefined }, opts.session ?? 200)
    if (url === '/api/conversations') return json(opts.conversations ?? [conversation({})])
    if (url === '/api/bots') return json(opts.bots ?? [])
    if ((url === '/api/wiki' || url.startsWith('/api/wiki?') || url.startsWith('/api/wiki/')) && opts.wiki) {
      return json(await opts.wiki(url, init))
    }
    if (url === '/api/setup' && opts.setup) return json(opts.setup)
    if (url === '/api/connections' && opts.connections) return json(opts.connections)
    if (url === '/api/settings/providers' && opts.connections) return json([])
    if (url === '/api/connectors' && opts.connectors) {
      return json(typeof opts.connectors === 'function' ? opts.connectors() : opts.connectors)
    }
    if (url.endsWith('/connectors') && init?.method === 'PUT') {
      const sent = JSON.parse(String(init.body)) as { connectorIds: string[] }
      const botId = decodeURIComponent(url.split('/')[3] ?? '')
      return json({ botId, connectorIds: sent.connectorIds })
    }
    if (url === '/api/mcp/servers' && opts.mcpServers) {
      return json(typeof opts.mcpServers === 'function' ? opts.mcpServers() : opts.mcpServers)
    }
    if (url === '/api/feed' && opts.feed) return json(opts.feed)
    if (url === '/api/goals' && opts.goals) return json(opts.goals)
    if (url === '/api/spaces' && opts.spaces) return json(opts.spaces)
    if (url.endsWith('/mcp') && init?.method === 'PUT') {
      const sent = JSON.parse(String(init.body)) as { serverIds: string[] }
      const botId = decodeURIComponent(url.split('/')[3] ?? '')
      return json({ botId, serverIds: sent.serverIds })
    }
    if (url === '/api/about' && opts.setup) return json({ version: null, dataDir: '/d', logs: 'stdout', runtime: { node: '24', platform: 'darwin', arch: 'arm64' }, computers: 'local' })
    if (url === '/api/settings' && opts.setup && opts.language === undefined) {
      return json({ values: { model: 'grok-4.7', language: '', computers: 'auto', browserMirror: '' }, sources: {}, apiKey: { set: true, masked: 'x', source: 'file' }, needsRestart: [] })
    }
    if (url === '/api/settings' && opts.language !== undefined) {
      return opts.session === 401 ? json({ error: 'sign in' }, 401) : json({ values: { language: opts.language } })
    }
    if (url.startsWith('/api/rule-proposals/') && init?.method === 'POST' && opts.resolveRuleProposal) {
      const sent = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      const reply = opts.resolveRuleProposal(url, sent)
      return json(reply.body, reply.status ?? 200)
    }
    if (url.endsWith('/background-tasks') && opts.backgroundTasks) {
      return json(await opts.backgroundTasks(url))
    }
    if (url.startsWith('/api/background-tasks/') && url.endsWith('/steer') && init?.method === 'POST' && opts.steerBackgroundTask) {
      const sent = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      const reply = opts.steerBackgroundTask(url, sent)
      return json(reply.body, reply.status ?? 200)
    }
    if (url.startsWith('/api/background-tasks/') && url.endsWith('/cancel') && init?.method === 'POST' && opts.cancelBackgroundTask) {
      const reply = opts.cancelBackgroundTask(url)
      return json(reply.body, reply.status ?? 200)
    }
    if (url.startsWith('/api/threads/') && url.endsWith('/team') && opts.teamCharter) {
      const reply = await opts.teamCharter(url, init)
      return json(reply.body, reply.status ?? 200)
    }
    if (url.startsWith('/api/dispatch-plans/') && url.endsWith('/start') && init?.method === 'POST' && opts.startDispatchPlan) {
      const reply = opts.startDispatchPlan(url)
      return json(reply.body, reply.status ?? 200)
    }
    if (url.startsWith('/api/dispatch-plans/') && url.endsWith('/cancel') && init?.method === 'POST' && opts.cancelDispatchPlan) {
      const reply = opts.cancelDispatchPlan(url)
      return json(reply.body, reply.status ?? 200)
    }
    if (/^\/api\/bots\/[^/]+\/workflows$/.test(url) && (!init?.method || init.method === 'GET')) return json([])
    if (url.endsWith('/workflows/recording') && init?.method === 'POST') return json({ ok: true, recording: true }, 202)
    if (url.startsWith('/api/threads/')) return json(opts.messages ? await opts.messages(url) : [])
    if (url.includes('/computer')) {
      await opts.computerGate
      const val = typeof opts.computer === 'function' ? await (opts.computer as (u: string) => unknown)(url) : opts.computer
      return json(val ?? {})
    }
    return json({ error: 'unexpected' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

/**
 * 首屏画出来了还不算准备好：连 WebSocket、换线程时收面板，都是 React 在渲染之后才跑的 effect。
 * 机器一忙，测试就会在「画出来了」和「effect 跑完了」之间的空当里动手：socket 还是 null，
 * 或者刚打开的面板被一个迟到的「换线程就收面板」关掉。等 socket 建好、把排着的 effect 冲掉，再开始操作。
 */
async function ready(): Promise<FakeSocket> {
  await screen.findAllByText('Scout')
  await waitFor(() => expect(FakeSocket.last).not.toBeNull())
  await act(async () => {})
  return FakeSocket.last!
}

beforeEach(() => {
  FakeSocket.last = null
  vi.stubGlobal('WebSocket', FakeSocket)
  document.title = 'OpenSuperBot'
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('App language', () => {
  it('speaks the language saved in settings', async () => {
    mockGateway({ conversations: [], language: 'zh-CN' })
    render(<App />)
    expect(await screen.findByText('还没有同事。')).toBeInTheDocument()
    // 页面语言是渲染之后的 effect 设的：文字先出来，冷启动时 lang 可能还差一拍
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'))
  })

  it('follows the browser when nothing is saved, even on the locked sign-in page', async () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['zh-CN', 'en'], language: 'zh-CN' })
    mockGateway({ session: 401, language: '' })
    render(<App />)
    expect(await screen.findByText('网关已上锁')).toBeInTheDocument()
    expect(screen.getByText('gateway/data/auth-token')).toBeInTheDocument()
  })

  it('stays in English for an English browser and an old gateway without settings', async () => {
    mockGateway({ conversations: [] })
    render(<App />)
    expect(await screen.findByText('No teammates yet.')).toBeInTheDocument()
  })
})

describe('App', () => {
  it('asks the operator to sign in when the gateway is locked', async () => {
    mockGateway({ session: 401 })
    render(<App />)
    expect(await screen.findByText(/sign-in link/i)).toBeInTheDocument()
  })

  it('counts what is waiting on you in the tab title', async () => {
    mockGateway({
      conversations: [
        conversation({ pending: 2 }),
        conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'], pending: 1 }),
      ],
    })
    render(<App />)
    await waitFor(() => expect(document.title).toBe('(3) OpenSuperBot'))
  })

  it('catches up after the live connection comes back', async () => {
    const calls = mockGateway()
    render(<App />)
    const socket = await ready()
    const before = calls.filter((u) => u === '/api/conversations').length
    await act(async () => { socket.emit({ type: 'hello', statuses: { researcher: 'thinking' } }) })
    await waitFor(() => expect(calls.filter((u) => u === '/api/conversations').length).toBe(before + 1))
    expect(screen.getByText(/Scout …/)).toBeInTheDocument()
  })

  it('ignores live events it does not know (a newer gateway), and keeps showing messages', async () => {
    mockGateway()
    render(<App />)
    const socket = await ready()
    await act(async () => {
      socket.emit({ type: 'setup.browser', browser: { state: 'downloading', item: 'chromium', percent: 10, totalMiB: 185.8 } })
      socket.emit({
        type: 'message', threadId: 'dm:researcher',
        message: { id: 7, thread_id: 'dm:researcher', sender: 'researcher', kind: 'text', content: 'still here', payload: null, created_at: 7 },
      })
    })
    await waitFor(() => expect(document.querySelector('.thread-scroll')!.textContent).toContain('still here'))
  })

  it('keeps the newest line as the sidebar preview when an older card updates in place', async () => {
    mockGateway()
    render(<App />)
    const socket = await ready()
    const at = (id: number, kind: string, content: string, payload: unknown = null) => ({
      type: 'message', threadId: 'dm:researcher',
      message: { id, thread_id: 'dm:researcher', sender: 'researcher', kind, content, payload, created_at: id },
    })
    await act(async () => {
      socket.emit(at(3, 'activity', '', { done: false, steps: [{ tool: 'shell', summary: 'ls' }] }))
      socket.emit(at(4, 'text', 'All filed.'))
      socket.emit(at(3, 'activity', '', { done: true, steps: [{ tool: 'shell', summary: 'ls', ok: true }] }))
    })
    expect(screen.getAllByText('All filed.').length).toBeGreaterThan(0)
    expect(document.querySelector('.sidebar-preview')!.textContent).toBe('All filed.')
  })

  it('does not lock itself when the gateway is only restarting (dev proxy answers 502)', async () => {
    mockGateway({ session: 502 })
    render(<App />)
    await waitFor(() => expect(FakeSocket.last).not.toBeNull())
    expect(screen.queryByText(/sign-in link/i)).toBeNull()
  })

  it('keeps live updates that land while a catch-up fetch is in flight', async () => {
    let release: ((rows: unknown) => void) | undefined
    let slow = false
    mockGateway({
      messages: () => (slow ? new Promise((r) => { release = r }) : []),
    })
    render(<App />)
    const socket = await ready()
    slow = true
    await act(async () => { socket.emit({ type: 'hello', statuses: {} }) })
    await waitFor(() => expect(release).toBeTypeOf('function')) // 补拉的请求已经发出、还没回来
    await act(async () => {
      socket.emit({
        type: 'message', threadId: 'dm:researcher',
        message: { id: 9, thread_id: 'dm:researcher', sender: 'researcher', kind: 'text', content: 'arrived mid-fetch', payload: null, created_at: 9 },
      })
    })
    await act(async () => { release!([]) })
    // 侧栏预览里也有这句话，所以只看线程本身；合并发生在 fetch 的 then 里，要等它落到 DOM
    await waitFor(() => expect(document.querySelector('.thread-scroll')!.textContent).toContain('arrived mid-fetch'))
  })

  it('opens the computer panel at once and fills it in when the computer is up', async () => {
    let wake!: () => void
    mockGateway({
      computerGate: new Promise<void>((r) => { wake = r }),
      computer: { botId: 'researcher', running: false, vncUrl: null, routines: [], error: 'Docker is not running.' },
    })
    render(<App />)
    await ready()
    await act(async () => { screen.getByRole('button', { name: 'Open its computer' }).click() })
    expect(await screen.findByRole('status')).toHaveTextContent("Starting Scout's computer…")
    await act(async () => { wake() })
    expect(await screen.findByText('Docker is not running.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('opens the local browser window when a recording starts', async () => {
    const calls = mockGateway({
      computer: {
        botId: 'researcher', running: true, kind: 'local', vncUrl: null,
        screen: { kind: 'cdp', url: '/screen/researcher/ws' }, window: false, routines: [],
      },
    })
    render(<App />)
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'Open its computer' }))
    await screen.findByText("Scout's computer")
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow name' }), 'Collect status')
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    await waitFor(() => expect(calls).toContain('POST /api/bots/researcher/computer/window {"shown":true}'))
    const recordingCall = calls.indexOf('POST /api/bots/researcher/workflows/recording {"title":"Collect status"}')
    const windowCall = calls.indexOf('POST /api/bots/researcher/computer/window {"shown":true}')
    expect(recordingCall).toBeGreaterThanOrEqual(0)
    expect(windowCall).toBeGreaterThan(recordingCall)
  })

  it('does not reopen a panel whose computer woke up after you moved on', async () => {
    let wake!: () => void
    mockGateway({
      conversations: [conversation({}), conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'] })],
      computerGate: new Promise<void>((r) => { wake = r }),
      computer: { botId: 'researcher', running: false, vncUrl: null, routines: [], error: 'late answer' },
    })
    render(<App />)
    await ready()
    await act(async () => { screen.getByRole('button', { name: 'Open its computer' }).click() })
    expect(document.querySelector('.computer-panel')).not.toBeNull()
    await act(async () => { screen.getByText('Chief').click() })
    await waitFor(() => expect(document.querySelector('.computer-panel')).toBeNull())
    await act(async () => { wake() })
    expect(document.querySelector('.computer-panel')).toBeNull()
    expect(screen.queryByText('late answer')).toBeNull()
  })

  it('closes the computer panel when you switch to another teammate', async () => {
    mockGateway({
      conversations: [conversation({}), conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'] })],
      computer: { botId: 'researcher', running: false, vncUrl: null, routines: [], error: 'Docker is not running.' },
    })
    render(<App />)
    await ready()
    await act(async () => { screen.getByRole('button', { name: 'Open its computer' }).click() })
    expect(await screen.findByText("Scout's computer")).toBeInTheDocument()
    await act(async () => { screen.getByText('Chief').click() })
    await waitFor(() => expect(document.querySelector('.computer-panel')).toBeNull())
  })

  it('keeps a live reply that lands while two thread loads overlap', async () => {
    const gates: Record<string, (rows: unknown) => void> = {}
    let slow = false
    mockGateway({
      conversations: [conversation({}), conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'] })],
      messages: (url) => (slow ? new Promise((r) => { gates[decodeURIComponent(url)] = r }) : []),
    })
    render(<App />)
    await screen.findAllByText('Scout')
    slow = true
    await act(async () => { screen.getByText('Chief').click() }) // load(chief) 在飞
    await act(async () => { screen.getAllByText('Scout')[0]!.click() }) // 马上切回：load(scout) 在飞
    await waitFor(() => expect(gates['/api/threads/dm:chief/messages']).toBeTypeOf('function'))
    await waitFor(() => expect(gates['/api/threads/dm:researcher/messages']).toBeTypeOf('function'))
    await act(async () => { gates['/api/threads/dm:chief/messages']!([]) }) // 晚到的 chief 结果被丢掉，但不能把 scout 的记账清掉
    await act(async () => {
      FakeSocket.last!.emit({
        type: 'message', threadId: 'dm:researcher',
        message: { id: 9, thread_id: 'dm:researcher', sender: 'researcher', kind: 'text', content: 'final reply', payload: null, created_at: 9 },
      })
    })
    await act(async () => { gates['/api/threads/dm:researcher/messages']!([]) })
    await waitFor(() => expect(document.querySelector('.thread-scroll')!.textContent).toContain('final reply'))
  })

  it('opens the first-run wizard when the gateway asks for it, and lands in Chief’s thread with the example sent', async () => {
    const calls = mockGateway({
      conversations: [conversation({}), conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'] })],
      setup: {
        needsSetup: true, chiefId: 'chief', demo: false,
        computers: {
          kind: 'local', choice: 'auto', docker: { reachable: false, imageReady: null },
          browser: { state: 'found', executablePath: '/usr/bin/chrome', source: 'system' }, download: { approxMB: 190, onDiskMB: 370 },
          browserMirror: { current: '', suggested: null }, sandbox: { available: true },
        },
      },
    })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Welcome to OpenSuperBot' })).toBeInTheDocument()
    expect(document.querySelector('.sidebar')).toBeNull()
    await act(async () => { screen.getByRole('button', { name: 'Just look around (demo mode)' }).click() })
    await act(async () => { (await screen.findByRole('button', { name: 'Continue' })).click() })
    await act(async () => { screen.getByRole('button', { name: /Every morning at 9/ }).click() })
    await waitFor(() => expect(document.querySelector('.sidebar')).not.toBeNull())
    await waitFor(() => expect(calls).toContain(
      `POST /api/threads/dm%3Achief/messages ${JSON.stringify({ text: 'Every morning at 9, give me a short summary of the tech news.' })}`,
    ))
    expect(document.querySelector('.thread-header')?.textContent).toContain('Chief')
  })

  it('skips the wizard once the gateway is set up', async () => {
    mockGateway({ setup: { needsSetup: false, demo: false, computers: {} } })
    render(<App />)
    await screen.findAllByText('Scout')
    await act(async () => {})
    expect(screen.queryByRole('heading', { name: 'Welcome to OpenSuperBot' })).toBeNull()
  })

  it('opens settings from the sidebar, and can run the setup again and close it', async () => {
    const computers = {
      kind: 'local', choice: 'auto', docker: { reachable: false, imageReady: null },
      browser: { state: 'found', executablePath: '/usr/bin/chrome', source: 'system' }, download: { approxMB: 190, onDiskMB: 370 },
      browserMirror: { current: '', suggested: null }, sandbox: { available: true },
    }
    mockGateway({ setup: { needsSetup: false, chiefId: 'chief', demo: false, computers } })
    render(<App />)
    await ready()
    await act(async () => { (await screen.findByRole('button', { name: 'Settings' })).click() })
    expect(await screen.findByText('Run from source (no version number)')).toBeInTheDocument()
    await act(async () => { screen.getByRole('button', { name: 'Run the setup again' }).click() })
    expect(await screen.findByRole('heading', { name: 'Welcome to OpenSuperBot' })).toBeInTheDocument()
    await act(async () => { screen.getByRole('button', { name: 'Close the setup' }).click() })
    await waitFor(() => expect(document.querySelector('.sidebar')).not.toBeNull())
  })

  it('marks a thread whose teammate runs the demo model, and connects a real model from there', async () => {
    const connection = (model: string) => ({
      connections: [{ id: 'main', name: '', provider: '', api: 'chat', baseURL: 'https://api.x.ai/v1', model, vision: false, builtIn: true, key: { set: false, masked: '', source: 'none' }, locked: [] }],
      bots: {},
    })
    const computers = {
      kind: 'local', choice: 'auto', docker: { reachable: false, imageReady: null },
      browser: { state: 'found', executablePath: '/usr/bin/chrome', source: 'system' }, download: { approxMB: 190, onDiskMB: 370 },
      browserMirror: { current: '', suggested: null }, sandbox: { available: true },
    }
    mockGateway({ setup: { needsSetup: false, chiefId: 'chief', demo: true, computers }, connections: connection('stub') })
    render(<App />)
    await ready()
    expect(await screen.findByText(/Replies here are scripted/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Demo mode' })).toBeInTheDocument()
    await act(async () => { screen.getByRole('button', { name: 'Connect a real model' }).click() })
    expect(await screen.findByRole('heading', { name: 'Welcome to OpenSuperBot' })).toBeInTheDocument()
  })

  it('shows no demo banner on a real model', async () => {
    mockGateway({ connections: {
      connections: [{ id: 'main', name: '', provider: 'xai', api: 'responses', baseURL: 'https://api.x.ai/v1', model: 'grok-4.7', vision: false, builtIn: true, key: { set: true, masked: 'x', source: 'file' }, locked: [] }],
      bots: {},
    } })
    render(<App />)
    await ready()
    expect(await screen.findByText(/grok-4\.7/)).toBeInTheDocument() // 连接拿回来了，才算数
    expect(screen.queryByText(/Replies here are scripted/)).toBeNull()
  })

  it('uploads a file you attach and sends it with your message; one you take out again is deleted', async () => {
    const calls = mockGateway()
    const { container } = render(<App />)
    await ready()
    const picker = () => container.querySelector('input[type=file]') as HTMLInputElement
    await userEvent.upload(picker(), new File(['# plan'], 'plan.md', { type: '' }), { applyAccept: false })
    await screen.findByText('6 B') // 传完了：显示大小
    expect(calls).toContain(`POST /api/uploads ${JSON.stringify({ name: 'plan.md', mime: 'text/markdown', data: btoa('# plan') })}`)
    await userEvent.type(screen.getByRole('textbox'), 'read this{Enter}')
    await waitFor(() => expect(calls).toContain(
      `POST /api/threads/dm%3Aresearcher/messages ${JSON.stringify({ text: 'read this', attachments: [{ id: 'c'.repeat(32) }] })}`,
    ))
    expect(screen.queryByText('plan.md')).toBeNull()

    await userEvent.upload(picker(), new File(['x'], 'oops.txt', { type: 'text/plain' }), { applyAccept: false })
    await screen.findByText('1 B')
    await userEvent.click(screen.getByRole('button', { name: 'Remove oops.txt' }))
    await waitFor(() => expect(calls).toContain(`DELETE /api/uploads/${'c'.repeat(32)}`))
  })

  it('says so when the teammate you are sending a picture to cannot see images', async () => {
    const connection = (vision: boolean) => ({
      id: 'main', name: 'Default', provider: 'deepseek', api: 'chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat',
      vision, builtIn: true, key: { set: true, masked: 'sk-…', source: 'file' }, locked: [],
    })
    mockGateway({ connections: { connections: [connection(false)], bots: {} } })
    const { container } = render(<App />)
    await ready()
    await userEvent.upload(container.querySelector('input[type=file]') as HTMLInputElement, new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' }), { applyAccept: false })
    expect(await screen.findByText(/Scout cannot see images/)).toBeInTheDocument()
  })

  it('opens the thread a #thread= link names, now and when the link changes, and falls back if it is gone', async () => {
    window.location.hash = '#thread=dm%3Achief'
    mockGateway({ conversations: [conversation({}), conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'] })] })
    render(<App />)
    await ready()
    await waitFor(() => expect(document.querySelector('.thread-header')?.textContent).toContain('Chief'))
    await act(async () => {
      window.location.hash = '#thread=dm%3Aresearcher'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await waitFor(() => expect(document.querySelector('.thread-header')?.textContent).toContain('Scout'))
    window.location.hash = ''
  })

  it('a link to a thread that no longer exists lands on the first one', async () => {
    window.location.hash = '#thread=dm%3Agone'
    mockGateway({ conversations: [conversation({}), conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'] })] })
    render(<App />)
    await ready()
    await waitFor(() => expect(document.querySelector('.thread-header')?.textContent).toContain('Scout'))
    window.location.hash = ''
  })

  it('loads connectors, refreshes them and an open computer panel on connectors_changed, and toggles bot access', async () => {
    let connectorSnap = {
      key: { set: true, masked: 'cmp…1234', source: 'file', locked: false },
      catalog: [{ app: 'gmail', name: 'Gmail', group: 'mail_calendar', domain: 'mail', toolkitSlug: 'gmail', authScheme: 'OAUTH2' }],
      accounts: [{ id: 'ca-11112222', app: 'gmail', accountLabel: 'alice@gmail.com', status: 'expired', lastError: 'expired', createdAt: 1, updatedAt: 1 }],
      botGrants: { researcher: [] as string[] },
    }
    const calls = mockGateway({
      connectors: () => connectorSnap,
      computer: {
        botId: 'researcher',
        running: false,
        vncUrl: null,
        routines: [],
        connectors: [{ id: 'ca-11112222', app: 'gmail', name: 'Gmail', accountLabel: 'alice@gmail.com', status: 'active', granted: false }],
      },
    })
    render(<App />)
    const socket = await ready()

    const connectorsBtn = await screen.findByRole('button', { name: 'Connectors (needs attention)' })
    await userEvent.click(connectorsBtn)
    expect(await screen.findByRole('dialog', { name: 'Connectors' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))

    await userEvent.click(screen.getByRole('button', { name: 'Open its computer' }))
    const gmailToggle = await screen.findByRole('checkbox', { name: 'alice@gmail.com' })
    await userEvent.click(gmailToggle)
    await waitFor(() => expect(calls).toContain(
      `PUT /api/bots/researcher/connectors ${JSON.stringify({ connectorIds: ['ca-11112222'] })}`,
    ))

    const computerCallsBefore = calls.filter((u) => u === '/api/bots/researcher/computer').length
    connectorSnap = {
      ...connectorSnap,
      accounts: [{ ...connectorSnap.accounts[0]!, status: 'active', lastError: '' }],
    }
    await act(async () => { socket.emit({ type: 'connectors_changed' }) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connectors' })).toBeInTheDocument())
    await waitFor(() => expect(calls.filter((u) => u === '/api/bots/researcher/computer').length).toBeGreaterThan(computerCallsBefore))
  })

  it('loads MCP servers, lights up attention on enabled server errors, refreshes on mcp_changed, and toggles bot MCP access', async () => {
    const connectorSnap = {
      key: { set: true, masked: 'cmp…1234', source: 'file', locked: false },
      catalog: [],
      accounts: [],
      botGrants: { researcher: [] as string[] },
    }
    let mcpSnap = {
      servers: [
        {
          id: 'mcp-linear',
          name: 'Linear',
          slug: 'linear',
          transport: 'http',
          enabled: true,
          command: '',
          args: [],
          cwd: '',
          url: 'https://mcp.linear.app/mcp',
          envKeys: [],
          headerKeys: [],
          envMasked: {},
          headersMasked: {},
          trustReadOnlyHint: false,
          tools: [],
          toolPolicies: {},
          status: 'error',
          lastError: 'connection refused',
          grantedBotIds: [] as string[],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      botGrants: { researcher: [] as string[] },
    }
    const calls = mockGateway({
      connectors: connectorSnap,
      mcpServers: () => mcpSnap,
      computer: {
        botId: 'researcher',
        running: false,
        vncUrl: null,
        routines: [],
        mcpServers: [
          {
            id: 'mcp-linear',
            name: 'Linear',
            slug: 'linear',
            transport: 'http',
            enabled: true,
            status: 'connected',
            toolCount: 2,
            granted: false,
          },
        ],
      },
    })
    render(<App />)
    const socket = await ready()

    const connectorsBtn = await screen.findByRole('button', { name: 'Connectors (needs attention)' })
    await userEvent.click(connectorsBtn)
    await userEvent.click(screen.getByRole('tab', { name: 'MCP' }))
    expect(screen.getByText('connection refused')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))

    await userEvent.click(screen.getByRole('button', { name: 'Open its computer' }))
    const linearToggle = await screen.findByRole('checkbox', { name: 'Linear' })
    await userEvent.click(linearToggle)
    await waitFor(() => expect(calls).toContain(
      `PUT /api/bots/researcher/mcp ${JSON.stringify({ serverIds: ['mcp-linear'] })}`,
    ))

    const computerCallsBefore = calls.filter((u) => u === '/api/bots/researcher/computer').length
    mcpSnap = {
      ...mcpSnap,
      servers: [{ ...mcpSnap.servers[0]!, status: 'connected', lastError: '' }],
    }
    await act(async () => { socket.emit({ type: 'mcp_changed' }) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connectors' })).toBeInTheDocument())
    await waitFor(() => expect(calls.filter((u) => u === '/api/bots/researcher/computer').length).toBeGreaterThan(computerCallsBefore))
  })

  it('keeps Today as the sole top sidebar entry and routes #today, #goals, and #space=<id> to Today tabs', async () => {
    window.history.replaceState(null, '', '#goals')
    mockGateway({
      feed: { needsYou: [], items: [], ideas: [], unreadCount: 0 },
      goals: {
        goals: [
          {
            id: 'goal-11111111',
            title: 'Ship unified Today hub',
            description: '',
            successCriteria: 'One top entry in sidebar',
            status: 'active',
            ownerBotId: 'researcher',
            memberBotIds: [],
            targetDate: null,
            sourceIdeaId: null,
            createdAt: 1,
            updatedAt: 1,
            milestones: [],
            doneMilestones: 0,
            totalMilestones: 0,
            recentUpdates: [],
            routines: [],
            recentActions: [],
          },
        ],
        activeCount: 1,
        unlinkedRoutines: [],
      },
      spaces: {
        spaces: [
          {
            id: 'space-aaaaaaaa',
            slug: 'launch_board',
            title: 'Launch Board',
            description: 'Zero-JS board',
            icon: '📋',
            kind: 'declarative',
            goalId: 'goal-11111111',
            goalTitle: 'Ship unified Today hub',
            schema: { blocks: [{ id: 'notes', type: 'markdown', title: 'Notes', content: 'Space notes live here' }] },
            items: [],
            grants: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        templates: [{ id: 'kanban', icon: '📋' }],
      },
    })

    render(<App />)
    await ready()

    // Only Today sits in the top sidebar nav; no separate Goals or Spaces sidebar button
    expect(screen.getByRole('button', { name: /^Today$/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Goals$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Spaces$/ })).not.toBeInTheDocument()

    // #goals opens directly on the Tracking & Goals secondary tab inside Today (both Needs You and Goals live here)
    expect(await screen.findByText('Ship unified Today hub')).toBeInTheDocument()
    expect(screen.getByText(/Nothing is waiting on your decision right now\./)).toBeInTheDocument()

    // #space=<id> opens directly on the Spaces secondary tab with that space active
    await act(async () => {
      window.location.hash = '#space=space-aaaaaaaa'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(await screen.findByText('Space notes live here')).toBeInTheDocument()

    // Switching hash to #today lands on the default Feed tab with Custom Feed prompt composer
    await act(async () => {
      window.location.hash = '#today'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(await screen.findByText('Custom Feed')).toBeInTheDocument()
    window.history.replaceState(null, '', window.location.pathname)
  })

  it('opens Team wiki from the sidebar, renders a page, and live-refreshes on wiki_changed', async () => {
    let pageVersion = 1
    let pageBody = 'Initial notes about Acme Corp.'
    let extraPage = false

    const calls = mockGateway({
      bots: [{ id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', thread_id: 'dm:researcher', last_message: null }],
      wiki: (url) => {
        if (url === '/api/wiki?limit=200') {
          const pages = [
            {
              id: 'client/acme',
              kind: 'client',
              slug: 'acme',
              title: 'Acme Corp',
              summary: 'Enterprise prospect',
              tags: ['enterprise'],
              sourceTainted: false,
              updatedBy: 'researcher',
              version: pageVersion,
              createdAt: 1,
              updatedAt: pageVersion,
            },
            ...(extraPage ? [{
              id: 'contact/lin',
              kind: 'contact',
              slug: 'lin',
              title: 'Lin Chen',
              summary: 'VP Engineering',
              tags: [],
              sourceTainted: true,
              updatedBy: 'researcher',
              version: 1,
              createdAt: 2,
              updatedAt: 2,
            }] : []),
          ]
          return { pages, total: pages.length }
        }
        if (url === '/api/wiki/client/acme') {
          return {
            page: {
              id: 'client/acme',
              kind: 'client',
              slug: 'acme',
              title: 'Acme Corp',
              summary: 'Enterprise prospect',
              tags: ['enterprise'],
              body: pageBody,
              sourceTainted: false,
              updatedBy: 'researcher',
              version: pageVersion,
              createdAt: 1,
              updatedAt: pageVersion,
            },
            revisions: [
              {
                id: pageVersion,
                pageId: 'client/acme',
                version: pageVersion,
                title: 'Acme Corp',
                summary: 'Enterprise prospect',
                tags: ['enterprise'],
                body: pageBody,
                editedBy: 'researcher',
                note: '',
                sourceTainted: false,
                createdAt: pageVersion,
              },
            ],
          }
        }
        return { error: 'not found' }
      },
    })

    render(<App />)
    const socket = await ready()

    await userEvent.click(screen.getByRole('button', { name: 'Team wiki' }))
    expect(await screen.findByRole('dialog', { name: 'Team wiki' })).toBeInTheDocument()

    const acmeItem = await screen.findByRole('button', { name: /Acme Corp/ })
    await userEvent.click(acmeItem)
    expect(await screen.findByText('Initial notes about Acme Corp.')).toBeInTheDocument()
    expect(screen.getByText('v1 · Updated by Scout')).toBeInTheDocument()

    const listCallsBefore = calls.filter((u) => u === '/api/wiki?limit=200').length
    const pageCallsBefore = calls.filter((u) => u === '/api/wiki/client/acme').length

    pageVersion = 2
    pageBody = 'Updated notes pushed by a teammate.'
    extraPage = true
    await act(async () => { socket.emit({ type: 'wiki_changed' }) })

    expect(await screen.findByText('Updated notes pushed by a teammate.')).toBeInTheDocument()
    expect(await screen.findByText('Lin Chen')).toBeInTheDocument()
    expect(screen.getByText('v2 · Updated by Scout')).toBeInTheDocument()
    expect(calls.filter((u) => u === '/api/wiki?limit=200').length).toBeGreaterThan(listCallsBefore)
    expect(calls.filter((u) => u === '/api/wiki/client/acme').length).toBeGreaterThan(pageCallsBefore)
  })

  it('refreshes an open Team wiki dialog when WebSocket hello arrives after reconnect', async () => {
    let pageVersion = 1
    let pageBody = 'Before disconnect.'
    let addedDuringOutage = false

    const calls = mockGateway({
      bots: [{ id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', thread_id: 'dm:researcher', last_message: null }],
      wiki: (url) => {
        if (url === '/api/wiki?limit=200') {
          const pages = [
            {
              id: 'client/acme',
              kind: 'client',
              slug: 'acme',
              title: 'Acme Corp',
              summary: 'Enterprise prospect',
              tags: ['enterprise'],
              sourceTainted: false,
              updatedBy: 'researcher',
              version: pageVersion,
              createdAt: 1,
              updatedAt: pageVersion,
            },
            ...(addedDuringOutage ? [{
              id: 'project/aurora',
              kind: 'project',
              slug: 'aurora',
              title: 'Aurora Launch',
              summary: 'Added while disconnected',
              tags: [],
              sourceTainted: false,
              updatedBy: 'researcher',
              version: 1,
              createdAt: 2,
              updatedAt: 2,
            }] : []),
          ]
          return { pages, total: pages.length }
        }
        if (url === '/api/wiki/client/acme') {
          return {
            page: {
              id: 'client/acme',
              kind: 'client',
              slug: 'acme',
              title: 'Acme Corp',
              summary: 'Enterprise prospect',
              tags: ['enterprise'],
              body: pageBody,
              sourceTainted: false,
              updatedBy: 'researcher',
              version: pageVersion,
              createdAt: 1,
              updatedAt: pageVersion,
            },
            revisions: [
              {
                id: pageVersion,
                pageId: 'client/acme',
                version: pageVersion,
                title: 'Acme Corp',
                summary: 'Enterprise prospect',
                tags: ['enterprise'],
                body: pageBody,
                editedBy: 'researcher',
                note: '',
                sourceTainted: false,
                createdAt: pageVersion,
              },
            ],
          }
        }
        return { error: 'not found' }
      },
    })

    render(<App />)
    const socket = await ready()

    await userEvent.click(screen.getByRole('button', { name: 'Team wiki' }))
    await userEvent.click(await screen.findByRole('button', { name: /Acme Corp/ }))
    expect(await screen.findByText('Before disconnect.')).toBeInTheDocument()

    const listCallsBefore = calls.filter((u) => u === '/api/wiki?limit=200').length
    const pageCallsBefore = calls.filter((u) => u === '/api/wiki/client/acme').length

    pageVersion = 2
    pageBody = 'Synced after reconnect.'
    addedDuringOutage = true
    await act(async () => { socket.emit({ type: 'hello', statuses: {} }) })

    expect(await screen.findByText('Synced after reconnect.')).toBeInTheDocument()
    expect(await screen.findByText('Aurora Launch')).toBeInTheDocument()
    expect(screen.getByText('v2 · Updated by Scout')).toBeInTheDocument()
    expect(calls.filter((u) => u === '/api/wiki?limit=200').length).toBeGreaterThan(listCallsBefore)
    expect(calls.filter((u) => u === '/api/wiki/client/acme').length).toBeGreaterThan(pageCallsBefore)
  })

  it('patches rule_proposal immediately on 200 without waiting for WS and resyncs stale pending cards on 409', async () => {
    let serverMessages = [
      {
        id: 20,
        thread_id: 'dm:researcher',
        sender: 'researcher',
        kind: 'rule_proposal',
        content: '',
        payload: {
          proposalId: 41,
          rule: 'Do not email bob@acme.com',
          reason: 'Discarded twice',
          source: 'discard_pattern',
          sourceTainted: false,
          status: 'pending',
        },
        created_at: 20,
      },
      {
        id: 21,
        thread_id: 'dm:researcher',
        sender: 'researcher',
        kind: 'rule_proposal',
        content: '',
        payload: {
          proposalId: 42,
          rule: 'Never post to #general',
          reason: 'Suggested by teammate',
          source: 'agent',
          sourceTainted: false,
          status: 'pending',
        },
        created_at: 21,
      },
    ]

    mockGateway({
      messages: () => serverMessages,
      resolveRuleProposal: (url, body) => {
        if (url === '/api/rule-proposals/41') {
          return {
            status: 200,
            body: {
              ok: true,
              proposal: {
                id: 41,
                botId: 'researcher',
                threadId: 'dm:researcher',
                rule: String(body.rule ?? 'Do not email bob@acme.com'),
                reason: 'Discarded twice',
                source: 'discard_pattern',
                sourceTainted: false,
                status: 'accepted',
                messageId: 20,
                createdAt: 20,
                resolvedAt: 500,
              },
              memoryUpdated: true,
            },
          }
        }
        // Simulate proposal 42 already resolved in another tab -> 409 settled
        serverMessages = serverMessages.map((m) => (
          m.id === 21
            ? { ...m, payload: { ...m.payload, status: 'dismissed', resolvedAt: 600 } }
            : m
        ))
        return { status: 409, body: { error: 'rule proposal already resolved', code: 'settled' } }
      },
    })

    const user = userEvent.setup()
    render(<App />)
    await ready()

    // Edit proposal 41 and accept -> flips immediately even with no WS event
    const inputs = await screen.findAllByLabelText('Standing rule (editable)')
    await user.clear(inputs[0]!)
    await user.type(inputs[0]!, 'Ask before emailing bob@acme.com')
    const saveBtns = screen.getAllByRole('button', { name: 'Save to MEMORY.md' })
    await user.click(saveBtns[0]!)

    expect(await screen.findByText('Saved to MEMORY.md · edited')).toBeInTheDocument()
    expect(screen.getByText('Ask before emailing bob@acme.com')).toBeInTheDocument()

    // Proposal 42 returns 409 settled -> triggers thread refresh so stale pending card flips to dismissed
    await user.click(screen.getByRole('button', { name: 'Save to MEMORY.md' }))
    expect(await screen.findByText('Rule proposal dismissed')).toBeInTheDocument()
  })

  it('refreshes an open computer panel when a quiet_digest message arrives over WebSocket', async () => {
    const calls = mockGateway({
      computer: { botId: 'researcher', running: false, vncUrl: null, routines: [] },
    })
    render(<App />)
    const socket = await ready()

    await userEvent.click(screen.getByRole('button', { name: 'Open its computer' }))
    expect(await screen.findByText("Scout's computer")).toBeInTheDocument()
    const before = calls.filter((u) => u === '/api/bots/researcher/computer').length

    await act(async () => {
      socket.emit({
        type: 'message',
        threadId: 'dm:researcher',
        message: {
          id: 30,
          thread_id: 'dm:researcher',
          sender: 'researcher',
          kind: 'quiet_digest',
          content: '',
          payload: { windowStart: '22:00', windowEnd: '08:00', itemCount: 1, items: [] },
          created_at: 30,
        },
      })
    })
    await waitFor(() => expect(calls.filter((u) => u === '/api/bots/researcher/computer').length).toBeGreaterThan(before))
  })

  it('preserves mid-fetch in-place WS updates over stale fetched snapshots', async () => {
    let releaseFetch!: (rows: unknown[]) => void
    let fetchCount = 0
    const pendingCard = {
      id: 5,
      thread_id: 'dm:researcher',
      sender: 'researcher',
      kind: 'rule_proposal',
      content: '',
      payload: {
        proposalId: 99,
        rule: 'Always check wiki first',
        reason: 'Suggested by teammate',
        source: 'agent',
        sourceTainted: false,
        status: 'pending',
      },
      created_at: 5,
    }
    const acceptedCard = {
      ...pendingCard,
      payload: { ...pendingCard.payload, status: 'accepted', resolvedAt: 999 },
    }
    mockGateway({
      messages: () => {
        fetchCount += 1
        if (fetchCount === 1) return [pendingCard]
        return new Promise((resolve) => { releaseFetch = resolve })
      },
    })

    render(<App />)
    const socket = await ready()
    expect(await screen.findByRole('button', { name: 'Save to MEMORY.md' })).toBeInTheDocument()

    // Trigger a reconnect resync so fetchMessages is in flight while an in-place WS update arrives
    await act(async () => { socket.emit({ type: 'hello', statuses: {} }) })
    await waitFor(() => expect(fetchCount).toBe(2))
    await act(async () => {
      socket.emit({ type: 'message', threadId: 'dm:researcher', message: acceptedCard })
    })
    expect(await screen.findByText('Saved to MEMORY.md')).toBeInTheDocument()

    // Now the stale snapshot (id: 5 still pending) resolves — must NOT overwrite the accepted WS update!
    await act(async () => { releaseFetch([pendingCard]) })
    expect(screen.getByText('Saved to MEMORY.md')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save to MEMORY.md' })).not.toBeInTheDocument()
  })

  it('tracks background_task_changed over WebSocket in the DM header pill and live-patches open ComputerPanel', async () => {
    const task1 = {
      id: 'bg-1111aaaa',
      botId: 'researcher',
      threadId: 'dm:researcher',
      title: 'Deep market scan',
      instructions: 'Scan top 5 vendors',
      status: 'running' as const,
      stepCount: 1,
      lastStep: 'browser_goto: https://vendor1.example',
      steps: [{ tool: 'browser_goto', summary: 'https://vendor1.example', ok: true, at: 100 }],
      summary: '',
      error: '',
      usesBrowser: true,
      messageId: 50,
      createdAt: 100,
      startedAt: 105,
      finishedAt: null,
    }
    const task2 = {
      ...task1,
      id: 'bg-2222bbbb',
      title: 'Draft executive brief',
      status: 'queued' as const,
      stepCount: 0,
      lastStep: '',
      steps: [],
      usesBrowser: false,
      messageId: 51,
      createdAt: 200,
      startedAt: null,
    }
    mockGateway({
      backgroundTasks: () => ({ tasks: [] }),
      computer: {
        botId: 'researcher',
        running: false,
        vncUrl: null,
        routines: [],
        backgroundTasks: [task1],
      },
    })

    render(<App />)
    const socket = await ready()
    expect(screen.queryByRole('button', { name: /background task/i })).toBeNull()

    // One active background task appears -> header pill shows "⚡ 1 background task"
    await act(async () => {
      socket.emit({ type: 'background_task_changed', botId: 'researcher', task: task1 })
    })
    const pill1 = await screen.findByRole('button', { name: /1 background task/ })
    expect(pill1).toBeInTheDocument()

    // Clicking the pill opens ComputerPanel with the live task
    await userEvent.click(pill1)
    expect(await screen.findByText('Background tasks')).toBeInTheDocument()
    expect(screen.getByText('Deep market scan')).toBeInTheDocument()
    expect(screen.getByText('Using browser')).toBeInTheDocument()

    // A second queued task arrives -> header pill updates to "⚡ 2 background tasks" and open panel live-patches in place
    await act(async () => {
      socket.emit({ type: 'background_task_changed', botId: 'researcher', task: task2 })
    })
    expect(await screen.findByRole('button', { name: /2 background tasks/ })).toBeInTheDocument()
    expect(screen.getByText('Draft executive brief')).toBeInTheDocument()

    // Both settle -> open panel reflects completed/cancelled and header pill disappears
    await act(async () => {
      socket.emit({
        type: 'background_task_changed',
        botId: 'researcher',
        task: { ...task1, status: 'completed', summary: 'Vendor matrix complete.', finishedAt: 500 },
      })
      socket.emit({
        type: 'background_task_changed',
        botId: 'researcher',
        task: { ...task2, status: 'cancelled', finishedAt: 505 },
      })
    })
    expect(await screen.findByText('Vendor matrix complete.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /background task/i })).toBeNull()
  })

  it('patches background_task immediately on steer/cancel 200 and resyncs stale active cards on 409', async () => {
    let serverTasks: BackgroundTaskView[] = [
      {
        id: 'bg-aaaa1111',
        botId: 'researcher',
        threadId: 'dm:researcher',
        title: 'Compile pricing matrix',
        instructions: 'Gather pricing',
        status: 'running',
        stepCount: 1,
        lastStep: 'wiki_search: pricing',
        steps: [{ tool: 'wiki_search', summary: 'pricing', ok: true, at: 100 }],
        summary: '',
        error: '',
        usesBrowser: false,
        messageId: 60,
        createdAt: 100,
        startedAt: 110,
        finishedAt: null,
      },
      {
        id: 'bg-bbbb2222',
        botId: 'researcher',
        threadId: 'dm:researcher',
        title: 'Legacy migration scan',
        instructions: 'Scan repo',
        status: 'running',
        stepCount: 2,
        lastStep: 'read_file: README.md',
        steps: [{ tool: 'read_file', summary: 'README.md', ok: true, at: 150 }],
        summary: '',
        error: '',
        usesBrowser: false,
        messageId: 61,
        createdAt: 150,
        startedAt: 160,
        finishedAt: null,
      },
    ]
    let serverMessages: Message[] = [
      {
        id: 60,
        thread_id: 'dm:researcher',
        sender: 'researcher',
        kind: 'background_task',
        content: '',
        payload: {
          taskId: 'bg-aaaa1111',
          title: 'Compile pricing matrix',
          status: 'running',
          stepCount: 1,
          lastStep: 'wiki_search: pricing',
          steps: [{ tool: 'wiki_search', summary: 'pricing', ok: true, at: 100 }],
          usesBrowser: false,
          createdAt: 100,
          startedAt: 110,
          finishedAt: null,
        },
        created_at: 100,
      },
      {
        id: 61,
        thread_id: 'dm:researcher',
        sender: 'researcher',
        kind: 'background_task',
        content: '',
        payload: {
          taskId: 'bg-bbbb2222',
          title: 'Legacy migration scan',
          status: 'running',
          stepCount: 2,
          lastStep: 'read_file: README.md',
          steps: [{ tool: 'read_file', summary: 'README.md', ok: true, at: 150 }],
          usesBrowser: false,
          createdAt: 150,
          startedAt: 160,
          finishedAt: null,
        },
        created_at: 150,
      },
    ]

    mockGateway({
      messages: () => serverMessages,
      backgroundTasks: () => ({ tasks: serverTasks }),
      steerBackgroundTask: (url, body) => {
        if (url === '/api/background-tasks/bg-aaaa1111/steer') {
          const note = String(body.note ?? '')
          const updated: BackgroundTaskView = {
            ...serverTasks[0]!,
            lastStep: `steer: ${note}`,
            steps: [...serverTasks[0]!.steps, { tool: 'steer', summary: note, ok: true, at: 200 }],
          }
          serverTasks = [updated, serverTasks[1]!]
          return { status: 200, body: { ok: true, task: updated } }
        }
        return { status: 404, body: { error: 'not found', code: 'not_found' } }
      },
      cancelBackgroundTask: (url) => {
        if (url === '/api/background-tasks/bg-aaaa1111/cancel') {
          const cancelled: BackgroundTaskView = {
            ...serverTasks[0]!,
            status: 'cancelled',
            finishedAt: 300,
          }
          serverTasks = [cancelled, serverTasks[1]!]
          return { status: 200, body: { ok: true, task: cancelled } }
        }
        // Simulate bg-bbbb2222 already completed on server -> 409 settled triggers resync
        serverTasks = [
          serverTasks[0]!,
          { ...serverTasks[1]!, status: 'completed', summary: 'Finished already on server.', finishedAt: 350 },
        ]
        serverMessages = serverMessages.map((m) => (
          m.id === 61 && m.payload && 'taskId' in m.payload
            ? { ...m, payload: { ...m.payload, status: 'completed', summary: 'Finished already on server.', finishedAt: 350 } }
            : m
        ))
        return { status: 409, body: { error: 'Background task bg-bbbb2222 is already completed.', code: 'settled' } }
      },
    })

    const user = userEvent.setup()
    render(<App />)
    await ready()

    const steerInputs = await screen.findAllByPlaceholderText('Send a steering note…')
    const steerBtns = screen.getAllByRole('button', { name: 'Steer' })
    const cancelBtns = screen.getAllByRole('button', { name: 'Cancel' })

    // Steer bg-aaaa1111 -> 200 patches step immediately without waiting for WS
    await user.type(steerInputs[0]!, 'Include annual discounts')
    await user.click(steerBtns[0]!)
    expect(await screen.findByText('Include annual discounts')).toBeInTheDocument()

    // Cancel bg-aaaa1111 -> 200 flips card to Cancelled immediately without waiting for WS
    await user.click(cancelBtns[0]!)
    expect(await screen.findByText('Cancelled')).toBeInTheDocument()

    // Cancel stale bg-bbbb2222 -> 409 settled resyncs thread & flips card to Completed with server summary
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Finished already on server.')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })

  it('preserves live WS background_task_changed updates when stale fetchBackgroundTasks or fetchComputer snapshots resolve', async () => {
    const runningTask: BackgroundTaskView = {
      id: 'bg-race1111',
      botId: 'researcher',
      threadId: 'dm:researcher',
      title: 'Race-prone scan',
      instructions: 'Scan vendors',
      status: 'running',
      stepCount: 1,
      lastStep: 'wiki_search: vendors',
      steps: [{ tool: 'wiki_search', summary: 'vendors', ok: true, at: 100 }],
      summary: '',
      error: '',
      usesBrowser: false,
      messageId: 70,
      createdAt: 100,
      startedAt: 110,
      finishedAt: null,
    }
    const completedTask: BackgroundTaskView = {
      ...runningTask,
      status: 'completed',
      stepCount: 2,
      lastStep: 'write_file: report.md',
      summary: 'Live WS completion summary.',
      finishedAt: 250,
    }
    const task2Running: BackgroundTaskView = {
      ...runningTask,
      id: 'bg-race2222',
      title: 'Panel wake race task',
      messageId: 71,
      createdAt: 300,
      startedAt: 310,
    }
    const task2Completed: BackgroundTaskView = {
      ...task2Running,
      status: 'completed',
      summary: 'Completed while panel was waking.',
      finishedAt: 400,
    }

    let bgFetchCount = 0
    let releaseBgFetch!: (v: unknown) => void
    let releaseComputerFetch!: (v: unknown) => void
    let computerFetchCount = 0

    mockGateway({
      backgroundTasks: () => {
        bgFetchCount += 1
        if (bgFetchCount === 1) return { tasks: [runningTask] }
        return new Promise((resolve) => { releaseBgFetch = resolve })
      },
      computer: () => {
        computerFetchCount += 1
        return new Promise((resolve) => { releaseComputerFetch = resolve })
      },
    })

    const user = userEvent.setup()
    render(<App />)
    const socket = await ready()

    // Initial load shows "1 background task" pill
    expect(await screen.findByRole('button', { name: /1 background task/ })).toBeInTheDocument()

    // --- Part A: WS completion arrives while fetchBackgroundTasks (triggered by reconnect hello) is in flight ---
    await act(async () => { socket.emit({ type: 'hello', statuses: {} }) })
    await waitFor(() => expect(bgFetchCount).toBe(2))

    await act(async () => {
      socket.emit({ type: 'background_task_changed', botId: 'researcher', task: completedTask })
    })
    // Pill disappears immediately because the task completed over WS
    await waitFor(() => expect(screen.queryByRole('button', { name: /background task/i })).toBeNull())

    // Now the stale HTTP /background-tasks snapshot (still 'running') resolves -> MUST NOT revert to running!
    await act(async () => { releaseBgFetch({ tasks: [runningTask] }) })
    await act(async () => {})
    expect(screen.queryByRole('button', { name: /background task/i })).toBeNull()

    // --- Part B: WS completion arrives while fetchComputer (loadPanel) is in flight ---
    await act(async () => {
      socket.emit({ type: 'background_task_changed', botId: 'researcher', task: task2Running })
    })
    const pill2 = await screen.findByRole('button', { name: /1 background task/ })
    await user.click(pill2)
    await waitFor(() => expect(computerFetchCount).toBe(1))

    // While /computer is still pending, task2 completes over WS
    await act(async () => {
      socket.emit({ type: 'background_task_changed', botId: 'researcher', task: task2Completed })
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /background task/i })).toBeNull())

    // Now the stale /computer snapshot (with task2 still 'running') resolves ->
    // panel AND header pill MUST reflect task2Completed, NOT revert to running!
    await act(async () => {
      releaseComputerFetch({
        botId: 'researcher',
        running: false,
        vncUrl: null,
        routines: [],
        backgroundTasks: [task2Running],
      })
    })
    expect(await screen.findByText('Completed while panel was waking.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /background task/i })).toBeNull()
  })

  it('opens Team charter modal from a group thread header, saves team.md, and refreshes on team_charter_changed', async () => {
    let charterContent = '- Scout researches before Ticker prices.'
    const groupConv = conversation({
      id: 'group:offsite-crew',
      kind: 'group',
      title: 'Offsite crew',
      emoji: '👥',
      subtitle: 'Chief, Scout, Ticker',
      members: ['chief', 'researcher', 'market-watch'],
    })

    const calls = mockGateway({
      conversations: [conversation({}), groupConv],
      bots: [
        { id: 'chief', name: 'Chief', role: 'lead', emoji: '🧭', thread_id: 'dm:chief', last_message: null },
        { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', thread_id: 'dm:researcher', last_message: null },
        { id: 'market-watch', name: 'Ticker', role: 'pricing', emoji: '📈', thread_id: 'dm:market-watch', last_message: null },
      ],
      teamCharter: (_url, init) => {
        if (init?.method === 'PUT') {
          const sent = JSON.parse(String(init.body)) as { content: string }
          charterContent = sent.content
          return { status: 200, body: { threadId: 'group:offsite-crew', content: charterContent, updatedAt: 2000 } }
        }
        return { status: 200, body: { threadId: 'group:offsite-crew', content: charterContent, updatedAt: 1000 } }
      },
    })

    const user = userEvent.setup()
    render(<App />)
    const socket = await ready()

    // DM thread must NOT render Team charter button
    expect(screen.queryByRole('button', { name: 'Team charter' })).toBeNull()

    // Switch to group thread -> Team charter button appears in header
    await user.click(screen.getByRole('button', { name: /Offsite crew/ }))
    const charterBtn = await screen.findByRole('button', { name: 'Team charter' })
    await user.click(charterBtn)

    const textarea = await screen.findByRole('textbox', { name: 'Team charter (team.md)' }) as HTMLTextAreaElement
    expect(textarea.value).toBe('- Scout researches before Ticker prices.')

    // Edit & save
    await user.type(textarea, '\n- Keep updates concise.')
    await user.click(screen.getByRole('button', { name: 'Save charter' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved to team.md.')
    expect(calls.some((c) => c.startsWith('PUT /api/threads/group%3Aoffsite-crew/team '))).toBe(true)

    // Remote team_charter_changed event refreshes clean dialog
    charterContent = '- Updated remotely.'
    await act(async () => {
      socket.emit({ type: 'team_charter_changed', threadId: 'group:offsite-crew' })
    })
    await waitFor(() => {
      expect(textarea.value).toBe('- Updated remotely.')
    })
  })

  it('live-patches dispatch_plan_changed over WS, patches immediately on Start/Cancel 200, and resyncs stale plans on 409', async () => {
    const groupConv = conversation({
      id: 'group:offsite-crew',
      kind: 'group',
      title: 'Offsite crew',
      emoji: '👥',
      subtitle: 'Chief, Scout, Ticker',
      members: ['chief', 'researcher', 'market-watch'],
    })

    const baseStep1 = {
      id: 's1',
      seq: 0,
      wave: 0,
      botId: 'researcher',
      title: 'Gather facts',
      instructions: 'Research competitors',
      dependsOn: [],
      status: 'pending' as const,
      output: '',
      error: '',
      outputTainted: false,
      waitingApprovalId: null,
      waitingQuestionId: null,
      startedAt: null,
      finishedAt: null,
    }

    const plan1Draft: DispatchPlanView = {
      id: 'dp-aaaa1111',
      threadId: 'group:offsite-crew',
      createdBy: 'chief',
      title: 'Q3 launch workflow',
      status: 'draft',
      sourceTainted: false,
      messageId: 90,
      error: '',
      steps: [baseStep1],
      createdAt: 100,
      startedAt: null,
      finishedAt: null,
    }
    const plan2Draft: DispatchPlanView = {
      ...plan1Draft,
      id: 'dp-bbbb2222',
      title: 'Stale workflow',
      messageId: 91,
      createdAt: 110,
    }

    let serverMessages: Message[] = [
      {
        id: 90,
        thread_id: 'group:offsite-crew',
        sender: 'chief',
        kind: 'dispatch_plan',
        content: '',
        payload: {
          planId: plan1Draft.id,
          threadId: plan1Draft.threadId,
          createdBy: plan1Draft.createdBy,
          title: plan1Draft.title,
          status: plan1Draft.status,
          sourceTainted: plan1Draft.sourceTainted,
          error: plan1Draft.error,
          steps: plan1Draft.steps,
          createdAt: plan1Draft.createdAt,
          startedAt: plan1Draft.startedAt,
          finishedAt: plan1Draft.finishedAt,
        },
        created_at: 100,
      },
      {
        id: 91,
        thread_id: 'group:offsite-crew',
        sender: 'chief',
        kind: 'dispatch_plan',
        content: '',
        payload: {
          planId: plan2Draft.id,
          threadId: plan2Draft.threadId,
          createdBy: plan2Draft.createdBy,
          title: plan2Draft.title,
          status: plan2Draft.status,
          sourceTainted: plan2Draft.sourceTainted,
          error: plan2Draft.error,
          steps: plan2Draft.steps,
          createdAt: plan2Draft.createdAt,
          startedAt: plan2Draft.startedAt,
          finishedAt: plan2Draft.finishedAt,
        },
        created_at: 110,
      },
    ]

    mockGateway({
      conversations: [groupConv],
      bots: [
        { id: 'chief', name: 'Chief', role: 'lead', emoji: '🧭', thread_id: 'dm:chief', last_message: null },
        { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', thread_id: 'dm:researcher', last_message: null },
        { id: 'market-watch', name: 'Ticker', role: 'pricing', emoji: '📈', thread_id: 'dm:market-watch', last_message: null },
      ],
      messages: () => serverMessages,
      startDispatchPlan: (url) => {
        if (url === '/api/dispatch-plans/dp-aaaa1111/start') {
          const started: DispatchPlanView = {
            ...plan1Draft,
            status: 'running',
            startedAt: 200,
            steps: [{ ...baseStep1, status: 'running', startedAt: 200 }],
          }
          return { status: 200, body: { ok: true, plan: started } }
        }
        // Stale plan2 returns 409 invalid_state -> server has it completed
        serverMessages = serverMessages.map((m) => (
          m.id === 91 && m.payload && 'planId' in m.payload
            ? {
                ...m,
                payload: {
                  ...m.payload,
                  status: 'completed',
                  finishedAt: 350,
                  steps: [{ ...baseStep1, status: 'completed', output: 'Already done on server.' }],
                },
              }
            : m
        ))
        return { status: 409, body: { error: 'Plan dp-bbbb2222 is already completed.', code: 'invalid_state' } }
      },
      cancelDispatchPlan: (url) => {
        if (url === '/api/dispatch-plans/dp-aaaa1111/cancel') {
          const cancelled: DispatchPlanView = {
            ...plan1Draft,
            status: 'cancelled',
            finishedAt: 260,
            steps: [{ ...baseStep1, status: 'cancelled', finishedAt: 260 }],
          }
          return { status: 200, body: { ok: true, plan: cancelled } }
        }
        return { status: 409, body: { error: 'already settled', code: 'settled' } }
      },
    })

    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('Offsite crew')
    await waitFor(() => expect(FakeSocket.last).not.toBeNull())
    await act(async () => {})
    const socket = FakeSocket.last!

    // Start plan1 -> 200 patches immediately to Running without waiting for WS
    const startBtns = await screen.findAllByRole('button', { name: 'Start pipeline' })
    await user.click(startBtns[0]!)
    expect((await screen.findAllByText('Running')).length).toBeGreaterThanOrEqual(2)

    // WS dispatch_plan_changed updates plan1 step to waiting_approval / paused live
    await act(async () => {
      socket.emit({
        type: 'dispatch_plan_changed',
        threadId: 'group:offsite-crew',
        plan: {
          ...plan1Draft,
          status: 'paused',
          startedAt: 200,
          steps: [{ ...baseStep1, status: 'waiting_approval', waitingApprovalId: 5 }],
        },
      })
    })
    expect(await screen.findByText('Waiting on approval')).toBeInTheDocument()
    expect(screen.getByText('Waiting on you')).toBeInTheDocument()

    // Cancel plan1 -> 200 patches immediately to Cancelled
    const cancelBtns = screen.getAllByRole('button', { name: 'Cancel pipeline' })
    await user.click(cancelBtns[0]!)
    expect((await screen.findAllByText('Cancelled')).length).toBeGreaterThanOrEqual(2)

    // Start stale plan2 -> 409 triggers thread resync and flips card to Completed
    await user.click(screen.getByRole('button', { name: 'Start pipeline' }))
    expect(await screen.findByText('Completed')).toBeInTheDocument()
  })

  it('preserves a dispatch_plan_changed WS update arriving while fetchMessages is in flight after switching to a group thread', async () => {
    const dmConv = conversation({
      id: 'dm:chief',
      title: 'Chief',
      emoji: '🧭',
      subtitle: 'lead',
      members: ['chief'],
    })
    const groupConv = conversation({
      id: 'group:offsite-crew',
      kind: 'group',
      title: 'Offsite crew',
      emoji: '👥',
      subtitle: 'Chief · Scout',
      members: ['chief', 'researcher'],
    })
    const stepDraft = {
      id: 's1',
      seq: 0,
      wave: 0,
      botId: 'researcher',
      title: 'Audit vendor pricing',
      instructions: 'Audit pricing.',
      dependsOn: [],
      status: 'pending' as const,
      output: '',
      error: '',
      outputTainted: false,
      waitingApprovalId: null,
      waitingQuestionId: null,
      startedAt: null,
      finishedAt: null,
    }
    const staleDraftMessage: Message = {
      id: 120,
      thread_id: 'group:offsite-crew',
      sender: 'chief',
      kind: 'dispatch_plan',
      content: '',
      payload: {
        planId: 'dp-race1111',
        threadId: 'group:offsite-crew',
        createdBy: 'chief',
        title: 'Launch pricing pipeline',
        status: 'draft',
        sourceTainted: false,
        error: '',
        steps: [stepDraft],
        createdAt: 100,
        startedAt: null,
        finishedAt: null,
      },
      created_at: 100,
    }
    const liveRunningPlan: DispatchPlanView = {
      id: 'dp-race1111',
      threadId: 'group:offsite-crew',
      createdBy: 'chief',
      title: 'Launch pricing pipeline',
      status: 'running',
      sourceTainted: false,
      messageId: 120,
      error: '',
      steps: [{ ...stepDraft, status: 'running', startedAt: 250 }],
      createdAt: 100,
      startedAt: 250,
      finishedAt: null,
    }

    let resolveGroupFetch!: (msgs: Message[]) => void
    let groupFetchStarted = false
    mockGateway({
      conversations: [dmConv, groupConv],
      bots: [
        { id: 'chief', name: 'Chief', role: 'lead', emoji: '🧭', thread_id: 'dm:chief', last_message: null },
        { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', thread_id: 'dm:researcher', last_message: null },
      ],
      messages: (url) => {
        if (url.includes(encodeURIComponent('group:offsite-crew'))) {
          groupFetchStarted = true
          return new Promise<Message[]>((resolve) => {
            resolveGroupFetch = resolve
          })
        }
        return []
      },
    })

    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('Chief')
    await waitFor(() => expect(FakeSocket.last).not.toBeNull())
    await act(async () => {})
    const socket = FakeSocket.last!

    // Switch to the group thread -> messages clears to [] and fetchMessages(group) stays in flight
    await user.click(screen.getByRole('button', { name: /Offsite crew/ }))
    await waitFor(() => expect(groupFetchStarted).toBe(true))

    // WS dispatch_plan_changed arrives BEFORE fetchMessages resolves (while messages === [])
    await act(async () => {
      socket.emit({
        type: 'dispatch_plan_changed',
        threadId: 'group:offsite-crew',
        plan: liveRunningPlan,
      })
    })

    // Now the stale HTTP snapshot (status: 'draft') resolves -> MUST be overlaid with liveRunningPlan ('running')!
    await act(async () => {
      resolveGroupFetch([staleDraftMessage])
    })

    expect(await screen.findByText('Launch pricing pipeline')).toBeInTheDocument()
    expect((await screen.findAllByText('Running')).length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('button', { name: 'Start pipeline' })).toBeNull()
  })
})
