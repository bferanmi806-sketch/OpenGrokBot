import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { ConnectorsSnapshot } from '../types'
import { ConnectorsDialog } from './ConnectorsDialog'

const snapshot: ConnectorsSnapshot = {
  key: { set: true, masked: 'cmp…1234', source: 'file', locked: false },
  catalog: [
    { app: 'gmail', name: 'Gmail', group: 'mail_calendar', domain: 'mail', toolkitSlug: 'gmail', authScheme: 'OAUTH2' },
    { app: 'notion', name: 'Notion', group: 'productivity', domain: 'notion', toolkitSlug: 'notion', authScheme: 'OAUTH2' },
    { app: 'slack', name: 'Slack', group: 'messaging', domain: 'slack', toolkitSlug: 'slack', authScheme: 'OAUTH2' },
  ],
  accounts: [
    {
      id: 'ca-11112222', app: 'gmail', accountLabel: 'alice@gmail.com', status: 'active',
      lastError: '', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'ca-33334444', app: 'slack', accountLabel: 'Acme Slack', status: 'expired',
      lastError: 'token expired', createdAt: 2, updatedAt: 2,
    },
  ],
  botGrants: { 'inbox-keeper': ['ca-11112222'], researcher: [] },
}

const roster = {
  'inbox-keeper': { name: 'Sorter', emoji: '📥' },
  researcher: { name: 'Scout', emoji: '🔎' },
}

function mockFetch(routes: Record<string, (body: unknown) => { status?: number; body: unknown }>) {
  const calls: { method: string; path: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body })
    const route = routes[`${method} ${path}`]
    const reply = route ? route(body) : { status: 404, body: {} }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
  return calls
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ConnectorsDialog', () => {
  it('renders grouped apps, connected accounts, teammate grants, and reconnect status in Chinese', async () => {
    const onChange = vi.fn()
    render(
      <I18nProvider lang="zh-CN">
        <ConnectorsDialog
          state={snapshot}
          roster={roster}
          onChange={onChange}
          onClose={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog', { name: '连接器' })).toBeInTheDocument()
    expect(screen.getByText(/Composio 的 API key 只存在这台电脑上/)).toBeInTheDocument()
    expect(screen.getByText('邮箱与日历')).toBeInTheDocument()
    expect(screen.getByText('文档与效率')).toBeInTheDocument()
    expect(screen.getByText('即时通讯')).toBeInTheDocument()
    expect(screen.getByText('alice@gmail.com')).toBeInTheDocument()
    expect(screen.getByText(/Sorter/)).toBeInTheDocument()
    expect(screen.getByText('需重新授权')).toBeInTheDocument()
  })

  it('saves a Composio API key when unset, and tests or clears an existing key', async () => {
    const unset: ConnectorsSnapshot = {
      ...snapshot,
      key: { set: false, masked: '', source: 'none', locked: false },
      accounts: [],
    }
    const calls = mockFetch({
      'PUT /api/connectors/key': (body) => ({
        body: (body as { apiKey: string | null }).apiKey ? snapshot : unset,
      }),
      'POST /api/connectors/key/test': () => ({ body: { ok: true } }),
    })
    const onChange = vi.fn()
    const { rerender } = render(
      <ConnectorsDialog state={unset} roster={roster} onChange={onChange} onClose={() => {}} />,
    )

    expect(screen.getByText(/Add your Composio API key above to connect accounts/)).toBeInTheDocument()
    await userEvent.type(screen.getByPlaceholderText('Paste your Composio API key'), 'cmp_live_123456')
    await userEvent.click(screen.getByRole('button', { name: 'Test & save' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(snapshot))
    expect(calls[0]).toEqual({ method: 'PUT', path: '/api/connectors/key', body: { apiKey: 'cmp_live_123456' } })

    rerender(<ConnectorsDialog state={snapshot} roster={roster} onChange={onChange} onClose={() => {}} />)
    expect(screen.getByText('Key cmp…1234')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText(/Key verified\./)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    const dialog = screen.getByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'PUT', path: '/api/connectors/key', body: { apiKey: null } }))
  })

  it('locks the API key bar when set via OPENSUPERBOT_COMPOSIO_API_KEY', () => {
    const lockedState: ConnectorsSnapshot = {
      ...snapshot,
      key: { set: true, masked: 'cmp…9999', source: 'env', locked: true },
    }
    render(<ConnectorsDialog state={lockedState} roster={roster} onChange={() => {}} onClose={() => {}} />)
    expect(screen.getByText(/OPENSUPERBOT_COMPOSIO_API_KEY/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument()
  })

  it('starts OAuth with teammates defaulting to unchecked and opens the browser redirect URL', async () => {
    const pendingState: ConnectorsSnapshot = {
      ...snapshot,
      accounts: [
        ...snapshot.accounts,
        { id: 'ca-55556666', app: 'notion', accountLabel: '', status: 'pending', lastError: '', createdAt: 3, updatedAt: 3 },
      ],
      botGrants: { ...snapshot.botGrants, researcher: ['ca-55556666'] },
    }
    const calls = mockFetch({
      'POST /api/connectors/connect': () => ({
        status: 201,
        body: {
          connectorId: 'ca-55556666',
          redirectUrl: 'https://composio.example/oauth/notion',
          callbackUrl: 'http://127.0.0.1:4319/oauth/connector/nonce1',
          state: pendingState,
        },
      }),
    })
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const onChange = vi.fn()

    render(<ConnectorsDialog state={snapshot} roster={roster} onChange={onChange} onClose={() => {}} />)

    const notionCard = screen.getByText('Notion').closest('.connector-card') as HTMLElement
    await userEvent.click(within(notionCard).getByRole('button', { name: 'Connect' }))

    const sorterBox = within(notionCard).getByRole('checkbox', { name: 'Sorter' })
    const scoutBox = within(notionCard).getByRole('checkbox', { name: 'Scout' })
    expect(sorterBox).not.toBeChecked()
    expect(scoutBox).not.toBeChecked()

    await userEvent.click(scoutBox)
    await userEvent.click(within(notionCard).getByRole('button', { name: 'Authorize in browser' }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(pendingState))
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/connectors/connect',
      body: { app: 'notion', botIds: ['researcher'] },
    })
    expect(openSpy).toHaveBeenCalledWith('https://composio.example/oauth/notion', '_blank', 'noopener')
  })

  it('manages per-account teammate access, reconnects, refreshes, and disconnects with confirmation', async () => {
    const refreshedState: ConnectorsSnapshot = {
      ...snapshot,
      accounts: snapshot.accounts.map((a) => (a.id === 'ca-33334444' ? { ...a, status: 'active' as const, lastError: '' } : a)),
    }
    const afterDeleteState: ConnectorsSnapshot = {
      ...snapshot,
      accounts: snapshot.accounts.filter((a) => a.id !== 'ca-11112222'),
      botGrants: { 'inbox-keeper': [], researcher: [] },
    }
    const calls = mockFetch({
      'PUT /api/bots/researcher/connectors': (body) => ({
        body: { botId: 'researcher', connectorIds: (body as { connectorIds: string[] }).connectorIds },
      }),
      'POST /api/connectors/ca-33334444/reconnect': () => ({
        body: {
          connectorId: 'ca-33334444',
          redirectUrl: 'https://composio.example/oauth/slack-reauth',
          callbackUrl: 'http://127.0.0.1:4319/oauth/connector/nonce2',
        },
      }),
      'POST /api/connectors/ca-33334444/refresh': () => ({ body: refreshedState }),
      'DELETE /api/connectors/ca-11112222': () => ({ body: afterDeleteState }),
    })
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const onChange = vi.fn()

    render(<ConnectorsDialog state={snapshot} roster={roster} onChange={onChange} onClose={() => {}} />)

    // Manage access on Gmail account (alice@gmail.com)
    const gmailAccount = screen.getByText('alice@gmail.com').closest('.connector-account') as HTMLElement
    await userEvent.click(within(gmailAccount).getByRole('button', { name: 'Manage access' }))
    expect(within(gmailAccount).getByRole('checkbox', { name: 'Sorter' })).toBeChecked()
    const scoutCheck = within(gmailAccount).getByRole('checkbox', { name: 'Scout' })
    expect(scoutCheck).not.toBeChecked()
    await userEvent.click(scoutCheck)
    await userEvent.click(within(gmailAccount).getByRole('button', { name: 'Save access' }))

    await waitFor(() => expect(calls).toContainEqual({
      method: 'PUT',
      path: '/api/bots/researcher/connectors',
      body: { connectorIds: ['ca-11112222'] },
    }))
    expect(onChange).toHaveBeenCalledWith({
      ...snapshot,
      botGrants: { 'inbox-keeper': ['ca-11112222'], researcher: ['ca-11112222'] },
    })

    // Reconnect and Refresh on expired Slack account
    const slackAccount = screen.getByText('Acme Slack').closest('.connector-account') as HTMLElement
    await userEvent.click(within(slackAccount).getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://composio.example/oauth/slack-reauth', '_blank', 'noopener'))

    await userEvent.click(within(slackAccount).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(refreshedState))

    // Disconnect on Gmail account via ConfirmDialog
    await userEvent.click(within(gmailAccount).getByRole('button', { name: 'Disconnect' }))
    const confirm = screen.getByRole('alertdialog')
    expect(confirm).toHaveTextContent('Disconnect alice@gmail.com?')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(afterDeleteState))
  })

  it('clears the authorizing hint immediately when a reconnecting account becomes active via WS update', async () => {
    mockFetch({
      'POST /api/connectors/ca-33334444/reconnect': () => ({
        body: {
          connectorId: 'ca-33334444',
          redirectUrl: 'https://composio.example/oauth/slack-reauth',
          callbackUrl: 'http://127.0.0.1:4319/oauth/connector/nonce3',
        },
      }),
    })
    vi.spyOn(window, 'open').mockImplementation(() => null)

    const { rerender } = render(
      <ConnectorsDialog state={snapshot} roster={roster} onChange={() => {}} onClose={() => {}} />,
    )

    const slackAccount = screen.getByText('Acme Slack').closest('.connector-account') as HTMLElement
    expect(within(slackAccount).queryByText(/Finish signing in inside the browser tab/)).toBeNull()

    await userEvent.click(within(slackAccount).getByRole('button', { name: 'Reconnect' }))
    expect(await within(slackAccount).findByText(/Finish signing in inside the browser tab/)).toBeInTheDocument()

    // Simulate WS connectors_changed pushing status: 'active' without clicking Refresh
    const wsActiveState: ConnectorsSnapshot = {
      ...snapshot,
      accounts: snapshot.accounts.map((a) =>
        a.id === 'ca-33334444' ? { ...a, status: 'active' as const, lastError: '' } : a,
      ),
    }
    rerender(<ConnectorsDialog state={wsActiveState} roster={roster} onChange={() => {}} onClose={() => {}} />)
    expect(within(slackAccount).queryByText(/Finish signing in inside the browser tab/)).toBeNull()

    // If the account later expires again while the dialog stays open, the hint stays hidden until Reconnect is clicked again
    rerender(<ConnectorsDialog state={snapshot} roster={roster} onChange={() => {}} onClose={() => {}} />)
    expect(within(slackAccount).queryByText(/Finish signing in inside the browser tab/)).toBeNull()
  })

  it('closes on Escape key', () => {
    const onClose = vi.fn()
    render(<ConnectorsDialog state={snapshot} roster={roster} onChange={() => {}} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
