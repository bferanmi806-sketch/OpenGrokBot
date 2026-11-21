import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { AboutInfo, ConnectionsState, ModelConnection, ProviderPreset, QuietDigestSummary, SettingsView, SetupInfo } from '../types'
import { SettingsDialog } from './SettingsDialog'

const providers: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', region: 'cn', api: 'chat', baseURL: 'https://api.deepseek.com', needsKey: true, keyUrl: '', defaultModel: 'deepseek-flash', vision: true, docsUrl: '' },
]
const main: ModelConnection = {
  id: 'main', name: '', provider: 'deepseek', api: 'chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', vision: true,
  builtIn: true, key: { set: true, masked: 'sk-…1234', source: 'file' }, locked: [],
}
const other: ModelConnection = { ...main, id: 'c-12345678', name: 'Claude', provider: 'anthropic', builtIn: false }
const llms: ConnectionsState = { connections: [main, other], bots: {} }

const view = (over: Partial<SettingsView['values']> = {}, sources: Record<string, 'env' | 'saved' | 'default'> = {}, needsRestart: string[] = []): SettingsView => ({
  values: {
    provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', vision: true, language: '',
    computers: 'auto', browserMirror: '', checkUpdates: true, ...over,
  },
  sources: { computers: 'default', browserMirror: 'default', ...sources },
  apiKey: { set: true, masked: 'sk-…1234', source: 'file' },
  needsRestart,
})
const setup: SetupInfo = {
  needsSetup: false, chiefId: 'chief', demo: false,
  computers: {
    kind: 'local', choice: 'auto', why: 'docker_image_missing', docker: { reachable: true, imageReady: false },
    browser: { state: 'missing' }, download: { approxMB: 190, onDiskMB: 370 },
    browserMirror: { current: '', suggested: { url: 'https://cdn.npmmirror.com/binaries/playwright', owner: 'npmmirror.com' } },
    sandbox: { available: true },
  },
}
const about: AboutInfo = {
  version: null, dataDir: '/home/me/.opensuperbot', port: 4748, logs: 'stdout', runtime: { node: '24.14.0', platform: 'darwin', arch: 'arm64' }, computers: 'local',
}

function mockFetch(routes: Record<string, (body: Record<string, unknown>) => { status?: number; body: unknown }>) {
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body })
    const route = routes[`${method} ${path}`]
    const reply = route ? route(body) : { status: 404, body: {} }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

function gateway(settings: SettingsView, extra: Record<string, (body: Record<string, unknown>) => { status?: number; body: unknown }> = {}) {
  return mockFetch({
    'GET /api/settings': () => ({ body: settings }),
    'GET /api/setup': () => ({ body: setup }),
    'GET /api/about': () => ({ body: about }),
    ...extra,
  })
}

function show(opts: { lang?: 'en' | 'zh-CN'; theme?: 'dark' | 'light' | 'system'; quietDigestTick?: number } = {}) {
  const props = { onLanguage: vi.fn(), onTheme: vi.fn(), onBrowser: vi.fn(), onModels: vi.fn(), onWizard: vi.fn(), onSignedOut: vi.fn(), onClose: vi.fn() }
  const renderView = (tick?: number) => (
    <I18nProvider lang={opts.lang ?? 'en'}>
      <SettingsDialog
        llms={llms}
        providers={providers}
        browser={null}
        language=""
        theme={opts.theme ?? 'dark'}
        {...(tick !== undefined ? { quietDigestTick: tick } : {})}
        {...props}
      />
    </I18nProvider>
  )
  const rendered = render(renderView(opts.quietDigestTick))
  return { ...props, rerenderTick: (tick: number) => rendered.rerender(renderView(tick)) }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('SettingsDialog', () => {
  it('sums up the model, the computer and where things live', async () => {
    gateway(view())
    const user = userEvent.setup()
    const p = show()
    expect(await screen.findByText(/Default: DeepSeek · deepseek-flash/)).toBeInTheDocument()
    expect(screen.getByText(/1 more connection/)).toBeInTheDocument()
    expect(screen.getByText('Teammates are using: This computer.')).toBeInTheDocument()
    expect(screen.getByText(/image is not built yet, so teammates use this computer for now/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Automatic/)).toBeChecked()
    expect(screen.getByText('Run from source (no version number)')).toBeInTheDocument()
    expect(screen.getByText('/home/me/.opensuperbot')).toBeInTheDocument()
    expect(screen.getByText('4748')).toBeInTheDocument()
    expect(screen.getByText('Printed in the terminal that runs the gateway')).toBeInTheDocument()
    expect(screen.getByText('Node 24.14.0 · darwin/arm64')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Manage AI models…' }))
    expect(p.onModels).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Run the setup again' }))
    expect(p.onWizard).toHaveBeenCalled()
  })

  it('switching computers saves it and says a restart is needed when the gateway says so', async () => {
    const calls = gateway(view(), { 'PUT /api/settings': (b) => ({ body: view({ computers: b.computers as 'docker' }, { computers: 'saved' }, ['computers']) }) })
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByLabelText(/^Docker/))
    expect(await screen.findByText('Restart the gateway for this to take effect.')).toBeInTheDocument()
    expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/api/settings', body: { computers: 'docker' } })
  })

  it('a choice pinned by an environment variable is read-only and says where to change it', async () => {
    gateway(view({ computers: 'local', browserMirror: 'https://mirror.example' }, { computers: 'env', browserMirror: 'env' }))
    show()
    expect(await screen.findByText(/OPENSUPERBOT_COMPUTERS; change it there/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Docker/)).toBeDisabled()
    expect(screen.getByLabelText('Where the browser downloads from')).toBeDisabled()
    expect(screen.getByText(/OPENSUPERBOT_BROWSER_MIRROR; change it there/)).toBeInTheDocument()
  })

  it('in demo mode, offers to connect a real model through the wizard', async () => {
    gateway(view({ model: 'stub', provider: '' }))
    const user = userEvent.setup()
    const p = show()
    expect(await screen.findByText(/Demo mode: replies are scripted/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connect a real model' }))
    expect(p.onWizard).toHaveBeenCalled()
  })

  it('sets the browser mirror, with the suggestion one click away, and shows a refusal', async () => {
    let reject = false
    const calls = gateway(view(), {
      'PUT /api/settings': (b) => (reject
        ? { status: 400, body: { error: 'invalid_settings', errors: [{ key: 'browserMirror', code: 'invalid' }] } }
        : { body: view({ browserMirror: b.browserMirror as string }) }),
    })
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole('button', { name: 'Use npmmirror.com' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.at(-1)!.body).toEqual({ browserMirror: 'https://cdn.npmmirror.com/binaries/playwright' }))
    reject = true
    const input = screen.getByLabelText('Where the browser downloads from')
    await user.clear(input)
    await user.type(input, 'not a url')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('This value is not valid.')).toBeInTheDocument()
  })

  it('downloads the browser when there is none', async () => {
    gateway(view(), { 'POST /api/setup/browser': () => ({ status: 202, body: { browser: { state: 'downloading', item: null, percent: null, totalMiB: null } } }) })
    const user = userEvent.setup()
    const p = show()
    expect(await screen.findByText(/about 190 MB/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(p.onBrowser).toHaveBeenCalledWith({ state: 'downloading', item: null, percent: null, totalMiB: null }))
  })

  it('speaks Chinese', async () => {
    gateway(view())
    show({ lang: 'zh-CN' })
    expect(await screen.findByText('同事现在用的是：这台电脑。')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument()
    expect(screen.getByText('源码版（没有版本号）')).toBeInTheDocument()
  })

  it('shows the desktop app version when opened in the app, and nothing extra in a browser', async () => {
    gateway(view())
    const info = vi.fn(async () => ({ version: '0.6.0', platform: 'darwin', electron: '44.9.3' }))
    vi.stubGlobal('opensuperbot', { info, loginItem: { get: vi.fn(async () => ({ supported: true, enabled: false })), set: vi.fn() } })
    show()
    expect(await screen.findByText('Desktop app 0.6.0 (Electron 44.9.3)')).toBeInTheDocument()
  })

  it('in a browser there is no app row', async () => {
    gateway(view())
    show()
    await screen.findByText('Run from source (no version number)')
    expect(screen.queryByText(/Desktop app/)).toBeNull()
    expect(screen.queryByLabelText(/when I log in/)).toBeNull()
  })

  it('in the app, start at login: shows the real state, changes it, and says when macOS has it turned off', async () => {
    gateway(view())
    let next: { supported: boolean; enabled: boolean; why?: string } = { supported: true, enabled: false, why: 'needs_approval' }
    const set = vi.fn(async () => next)
    vi.stubGlobal('opensuperbot', {
      info: vi.fn(async () => ({ version: '0.6.0', platform: 'darwin', electron: '44.9.3' })),
      loginItem: { get: vi.fn(async () => ({ supported: true, enabled: true })), set },
    })
    const user = userEvent.setup()
    show()
    expect(await screen.findByRole('heading', { name: 'Desktop app' })).toBeInTheDocument()
    const box = await screen.findByLabelText('Open OpenSuperBot when I log in to this computer')
    expect(box).toBeChecked()
    expect(screen.getByText(/Closing the window keeps it running/)).toBeInTheDocument()
    next = { supported: true, enabled: false }
    await user.click(box)
    expect(set).toHaveBeenCalledWith(false)
    await waitFor(() => expect(box).not.toBeChecked())
    next = { supported: true, enabled: false, why: 'needs_approval' }
    await user.click(box)
    expect(await screen.findByText(/System Settings → General → Login Items/)).toBeInTheDocument()
    expect(box).not.toBeChecked()
    set.mockRejectedValueOnce(new Error('EACCES'))
    await user.click(box)
    expect(await screen.findByText(/Couldn’t change this/)).toBeInTheDocument()
  })

  it('in the app run from source, says start at login needs the installed app', async () => {
    gateway(view())
    vi.stubGlobal('opensuperbot', {
      info: vi.fn(async () => ({ version: '0.6.0-dev', platform: 'darwin', electron: '44.9.3', update: null })),
      loginItem: { get: vi.fn(async () => ({ supported: false, enabled: false, why: 'unpackaged' })), set: vi.fn() },
    })
    show({ lang: 'zh-CN' })
    expect(await screen.findByText('开机自启只在安装版里有，源码跑的不行。')).toBeInTheDocument()
    expect(screen.queryByLabelText('登录电脑时自动打开 OpenSuperBot')).toBeNull()
    expect(screen.getByLabelText('启动时检查有没有新版本')).toBeChecked()
  })

  it('in the app, toggles startup update checks and shows a download link when a newer version exists', async () => {
    const calls = gateway(view(), {
      'PUT /api/settings': (b) => ({ body: view({ checkUpdates: Boolean(b.checkUpdates) }, { checkUpdates: 'saved' }) }),
    })
    vi.stubGlobal('opensuperbot', {
      info: vi.fn(async () => ({
        version: '0.6.0',
        platform: 'darwin',
        electron: '44.9.3',
        update: { version: '0.7.0', url: 'https://github.com/wolfqing/OpenSuperBot/releases/tag/v0.7.0' },
      })),
      loginItem: { get: vi.fn(async () => ({ supported: true, enabled: false })), set: vi.fn() },
    })
    const user = userEvent.setup()
    show()
    expect(await screen.findByText('Version 0.7.0 is available.')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Download from GitHub' })
    expect(link).toHaveAttribute('href', 'https://github.com/wolfqing/OpenSuperBot/releases/tag/v0.7.0')
    expect(link).toHaveAttribute('target', '_blank')

    const check = screen.getByLabelText('Check for a newer version on startup')
    expect(check).toBeChecked()
    await user.click(check)
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/api/settings', body: { checkUpdates: false } }))
    expect(check).not.toBeChecked()
  })

  it('switches appearance between dark, light and follow system', async () => {
    const calls = gateway(view(), {
      'PUT /api/settings': (b) => ({ body: view({ theme: b.theme as 'light' | 'dark' | 'system' }, { theme: 'saved' }) }),
    })
    const user = userEvent.setup()
    const p = show()
    expect(await screen.findByLabelText('Dark')).toBeChecked()
    await user.click(screen.getByLabelText('Light'))
    expect(p.onTheme).toHaveBeenCalledWith('light')
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/api/settings', body: { theme: 'light' } }))
    await user.click(screen.getByLabelText('Follow system'))
    expect(p.onTheme).toHaveBeenCalledWith('system')
  })

  it('toggles Quiet Hours, saves start/end times, shows pending digest count, and delivers now', async () => {
    let quietState: SettingsView['values'] = {
      ...view().values,
      quietHoursEnabled: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
    }
    let digestSummary: QuietDigestSummary = {
      enabled: false,
      active: false,
      start: '22:00',
      end: '08:00',
      timeZone: 'America/Los_Angeles',
      pendingCount: 2,
      byBot: [{ botId: 'researcher', count: 2, latestAt: Date.now() }],
    }

    const calls = gateway(view(quietState), {
      'GET /api/quiet-digest': () => ({ body: digestSummary }),
      'PUT /api/settings': (b) => {
        if ('quietHoursEnabled' in b) {
          quietState = { ...quietState, quietHoursEnabled: Boolean(b.quietHoursEnabled) }
          digestSummary = { ...digestSummary, enabled: quietState.quietHoursEnabled!, active: quietState.quietHoursEnabled! }
        }
        if ('quietHoursStart' in b) {
          quietState = { ...quietState, quietHoursStart: String(b.quietHoursStart) }
          digestSummary = { ...digestSummary, start: quietState.quietHoursStart! }
        }
        if ('quietHoursEnd' in b) {
          quietState = { ...quietState, quietHoursEnd: String(b.quietHoursEnd) }
          digestSummary = { ...digestSummary, end: quietState.quietHoursEnd! }
        }
        return { body: view(quietState, { quietHoursEnabled: 'saved', quietHoursStart: 'saved', quietHoursEnd: 'saved' }) }
      },
      'POST /api/quiet-digest/flush': () => {
        const flushed = digestSummary.pendingCount
        digestSummary = { ...digestSummary, pendingCount: 0, byBot: [] }
        return { body: { flushed, threads: ['dm:researcher'] } }
      },
    })

    const user = userEvent.setup()
    show()

    const toggle = await screen.findByLabelText('Hold non-urgent scheduled checks for a morning digest')
    expect(toggle).not.toBeChecked()
    expect(screen.getByText('Timezone: America/Los_Angeles')).toBeInTheDocument()
    expect(screen.getByText('2 updates waiting for the morning digest')).toBeInTheDocument()

    await user.click(toggle)
    await waitFor(() => {
      expect(calls).toContainEqual({ method: 'PUT', path: '/api/settings', body: { quietHoursEnabled: true } })
    })
    expect(await screen.findByText('Quiet Hours active now')).toBeInTheDocument()

    const startInput = screen.getByLabelText('Starts') as HTMLInputElement
    const endInput = screen.getByLabelText('Ends') as HTMLInputElement
    const saveQuietBtn = screen.getByRole('button', { name: 'Save (Quiet Hours)' })
    expect(saveQuietBtn).toBeDisabled()

    fireEvent.change(startInput, { target: { value: '23:30' } })
    fireEvent.change(endInput, { target: { value: '23:30' } })
    expect(screen.getByText(/Start and end are the same/)).toBeInTheDocument()

    fireEvent.change(endInput, { target: { value: '07:15' } })
    expect(saveQuietBtn).not.toBeDisabled()
    await user.click(saveQuietBtn)
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'PUT',
        path: '/api/settings',
        body: { quietHoursStart: '23:30', quietHoursEnd: '07:15' },
      })
    })
    await waitFor(() => expect(saveQuietBtn).toBeDisabled())

    const deliverBtn = screen.getByRole('button', { name: 'Deliver now' })
    await user.click(deliverBtn)
    await waitFor(() => {
      expect(calls).toContainEqual({ method: 'POST', path: '/api/quiet-digest/flush', body: {} })
    })
    expect(await screen.findByText('Delivered 2 buffered updates.')).toBeInTheDocument()
    expect(await screen.findByText('No updates waiting')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deliver now' })).toBeNull()
  })

  it('uses singular copy when flushing 1 buffered update and clears feedback on quiet time edits or new pending updates', async () => {
    let digestSummary: QuietDigestSummary = {
      enabled: true,
      active: true,
      start: '22:00',
      end: '08:00',
      timeZone: 'UTC',
      pendingCount: 1,
      byBot: [{ botId: 'chief', count: 1, latestAt: Date.now() }],
    }
    gateway(view({ quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' }), {
      'GET /api/quiet-digest': () => ({ body: digestSummary }),
      'PUT /api/settings': () => ({ status: 400, body: { error: 'invalid_settings', errors: [{ key: 'quietHoursStart', code: 'invalid' }] } }),
      'POST /api/quiet-digest/flush': () => {
        digestSummary = { ...digestSummary, pendingCount: 0, byBot: [] }
        return { body: { flushed: 1, threads: ['dm:chief'] } }
      },
    })

    const user = userEvent.setup()
    const { rerenderTick } = show({ quietDigestTick: 0 })

    expect(await screen.findByText('1 update waiting for the morning digest')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Deliver now' }))
    expect(await screen.findByText('Delivered 1 buffered update.')).toBeInTheDocument()
    expect(await screen.findByText('No updates waiting')).toBeInTheDocument()

    // Incoming WS refresh with new pending updates clears stale delivery confirmation
    digestSummary = { ...digestSummary, pendingCount: 1, byBot: [{ botId: 'chief', count: 1, latestAt: Date.now() }] }
    rerenderTick(1)
    expect(await screen.findByText('1 update waiting for the morning digest')).toBeInTheDocument()
    expect(screen.queryByText('Delivered 1 buffered update.')).toBeNull()

    // Editing quietStart clears stale quietHoursStart field errors
    const startInput = screen.getByLabelText('Starts') as HTMLInputElement
    fireEvent.change(startInput, { target: { value: '23:00' } })
    await user.click(screen.getByRole('button', { name: 'Save (Quiet Hours)' }))
    expect(await screen.findByText('This value is not valid.')).toBeInTheDocument()
    fireEvent.change(startInput, { target: { value: '21:30' } })
    expect(screen.queryByText('This value is not valid.')).toBeNull()
  })

  it('ignores stale out-of-order fetchQuietDigest responses and preserves panel on transient refresh failures', async () => {
    let digestCall = 0
    let releaseStale!: (res: Response) => void
    const initialSummary: QuietDigestSummary = {
      enabled: true,
      active: true,
      start: '22:00',
      end: '08:00',
      timeZone: 'America/Los_Angeles',
      pendingCount: 2,
      byBot: [{ botId: 'chief', count: 2, latestAt: Date.now() }],
    }
    const emptySummary: QuietDigestSummary = { ...initialSummary, pendingCount: 0, byBot: [] }

    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (method === 'GET' && path === '/api/settings') {
        return json(view({ quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' }))
      }
      if (method === 'GET' && path === '/api/setup') return json(setup)
      if (method === 'GET' && path === '/api/about') return json(about)
      if (method === 'POST' && path === '/api/quiet-digest/flush') {
        return json({ flushed: 2, threads: ['dm:chief'] })
      }
      if (method === 'GET' && path === '/api/quiet-digest') {
        digestCall += 1
        if (digestCall === 1) return json(initialSummary)
        if (digestCall === 2) {
          // Slow response triggered by quietDigestTick=1 before deliverNow finishes
          return new Promise<Response>((resolve) => { releaseStale = resolve })
        }
        if (digestCall === 3) return json(emptySummary)
        // Call 4: transient 500 error during refresh
        return json({ error: 'temporary failure' }, 500)
      }
      return json({}, 404)
    }))

    const user = userEvent.setup()
    const { rerenderTick } = show({ quietDigestTick: 0 })

    expect(await screen.findByText('2 updates waiting for the morning digest')).toBeInTheDocument()

    // Trigger a slow tick refresh (call #2)
    rerenderTick(1)
    await waitFor(() => expect(releaseStale).toBeTypeOf('function'))

    // While call #2 is still in flight, user clicks Deliver now -> call #3 returns pendingCount: 0
    await user.click(screen.getByRole('button', { name: 'Deliver now' }))
    expect(await screen.findByText('Delivered 2 buffered updates.')).toBeInTheDocument()
    expect(await screen.findByText('No updates waiting')).toBeInTheDocument()

    // Now the stale call #2 finally resolves with pendingCount: 2 — must be ignored!
    releaseStale(new Response(JSON.stringify(initialSummary), { status: 200, headers: { 'content-type': 'application/json' } }))
    await waitFor(() => expect(digestCall).toBe(3))
    // Give microtasks a chance to flush
    await Promise.resolve()
    expect(screen.getByText('No updates waiting')).toBeInTheDocument()
    expect(screen.getByText('Delivered 2 buffered updates.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deliver now' })).toBeNull()

    // Transient 500 on call #4 must NOT wipe the Quiet Hours status panel
    rerenderTick(2)
    await waitFor(() => expect(digestCall).toBe(4))
    await Promise.resolve()
    expect(screen.getByText('Timezone: America/Los_Angeles')).toBeInTheDocument()
    expect(screen.getByText('No updates waiting')).toBeInTheDocument()
  })
})
