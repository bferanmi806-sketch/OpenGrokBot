import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { Conversation } from './types'

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
  /** /api/bots 的回答 */
  bots?: unknown[]
  /** /api/wiki/* 的回答 */
  wiki?: (url: string, init?: RequestInit) => unknown | Promise<unknown>
  /** POST /api/rule-proposals/:id 的回答 */
  resolveRuleProposal?: (url: string, body: Record<string, unknown>) => { status?: number; body: unknown }
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
    if (url.startsWith('/api/threads/')) return json(opts.messages ? await opts.messages(url) : [])
    if (url.includes('/computer')) {
      await opts.computerGate
      return json(opts.computer ?? {})
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
})
