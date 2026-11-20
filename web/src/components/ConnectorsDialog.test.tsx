import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { ConnectorsSnapshot, McpServersSnapshot, McpServerView } from '../types'
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

  it('renders Apps and MCP tabs when mcpState is provided, tests a server, updates tool policy, and saves teammate access', async () => {
    const linearServer: McpServerView = {
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
      headerKeys: ['Authorization'],
      envMasked: {},
      headersMasked: { Authorization: 'Bear…1234' },
      trustReadOnlyHint: false,
      tools: [
        {
          name: 'list_issues',
          description: 'List issues in workspace',
          inputSchema: { type: 'object' },
          readOnlyHint: true,
          destructiveHint: false,
          overrideMode: null,
          effectiveMode: 'write',
          exposedName: 'mcp__linear__list_issues',
        },
        {
          name: 'delete_issue',
          description: 'Delete an issue',
          inputSchema: { type: 'object' },
          readOnlyHint: false,
          destructiveHint: true,
          overrideMode: null,
          effectiveMode: 'write',
          exposedName: 'mcp__linear__delete_issue',
        },
      ],
      toolPolicies: {},
      status: 'disconnected',
      lastError: '',
      grantedBotIds: ['inbox-keeper'],
      createdAt: 10,
      updatedAt: 10,
    }
    const mcpSnapshot: McpServersSnapshot = {
      servers: [linearServer],
      botGrants: { 'inbox-keeper': ['mcp-linear'], researcher: [] },
    }
    const testedLinear: McpServerView = {
      ...linearServer,
      status: 'connected',
      updatedAt: 20,
    }
    const policyUpdatedLinear: McpServerView = {
      ...testedLinear,
      toolPolicies: { list_issues: 'read' },
      tools: testedLinear.tools.map((tool) =>
        tool.name === 'list_issues'
          ? { ...tool, overrideMode: 'read' as const, effectiveMode: 'read' as const }
          : tool,
      ),
      updatedAt: 30,
    }

    const calls = mockFetch({
      'POST /api/mcp/servers/mcp-linear/test': () => ({ body: { server: testedLinear } }),
      'PATCH /api/mcp/servers/mcp-linear': () => ({ body: { server: policyUpdatedLinear } }),
      'PUT /api/mcp/servers/mcp-linear/bots': (body) => ({
        body: { server: { ...policyUpdatedLinear, grantedBotIds: (body as { botIds: string[] }).botIds }, botIds: (body as { botIds: string[] }).botIds },
      }),
    })
    const onMcpChange = vi.fn()

    const { rerender } = render(
      <ConnectorsDialog
        state={snapshot}
        roster={roster}
        onChange={() => {}}
        mcpState={mcpSnapshot}
        onMcpChange={onMcpChange}
        onClose={() => {}}
      />,
    )

    const appsTab = screen.getByRole('tab', { name: 'Apps' })
    const mcpTab = screen.getByRole('tab', { name: 'MCP' })
    expect(appsTab).toHaveAttribute('aria-selected', 'true')
    expect(mcpTab).toHaveAttribute('aria-selected', 'false')

    await userEvent.click(mcpTab)
    expect(mcpTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/Local \(stdio\) servers run commands on the gateway host/)).toBeInTheDocument()

    const card = screen.getByText('Linear').closest('.mcp-card') as HTMLElement
    expect(within(card).getByText('HTTP')).toBeInTheDocument()
    expect(within(card).getByText('Not tested')).toBeInTheDocument()
    expect(within(card).getByText('2 tools')).toBeInTheDocument()
    expect(within(card).getByText('Granted to Sorter')).toBeInTheDocument()

    // Test / refresh server
    await userEvent.click(within(card).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(calls).toContainEqual({
      method: 'POST',
      path: '/api/mcp/servers/mcp-linear/test',
      body: undefined,
    }))
    expect(onMcpChange).toHaveBeenLastCalledWith({
      servers: [testedLinear],
      botGrants: { 'inbox-keeper': ['mcp-linear'], researcher: [] },
    })

    rerender(
      <ConnectorsDialog
        state={snapshot}
        roster={roster}
        onChange={() => {}}
        mcpState={{ servers: [testedLinear], botGrants: { 'inbox-keeper': ['mcp-linear'], researcher: [] } }}
        onMcpChange={onMcpChange}
        onClose={() => {}}
      />,
    )
    const updatedCard = screen.getByText('Linear').closest('.mcp-card') as HTMLElement
    expect(within(updatedCard).getByText('Connected')).toBeInTheDocument()

    // Expand discovered tools & switch list_issues from default (Needs approval) to Read-only
    await userEvent.click(within(updatedCard).getByRole('button', { name: 'Discovered tools (2)' }))
    expect(within(updatedCard).getByText('readOnlyHint')).toBeInTheDocument()
    expect(within(updatedCard).getByText('Destructive')).toBeInTheDocument()
    const policySelect = within(updatedCard).getByRole('combobox', { name: 'list_issues' })
    expect(policySelect).toHaveValue('default')
    await userEvent.selectOptions(policySelect, 'read')

    await waitFor(() => expect(calls).toContainEqual({
      method: 'PATCH',
      path: '/api/mcp/servers/mcp-linear',
      body: { toolPolicies: { list_issues: 'read' } },
    }))
    expect(onMcpChange).toHaveBeenLastCalledWith({
      servers: [policyUpdatedLinear],
      botGrants: { 'inbox-keeper': ['mcp-linear'], researcher: [] },
    })

    rerender(
      <ConnectorsDialog
        state={snapshot}
        roster={roster}
        onChange={() => {}}
        mcpState={{ servers: [policyUpdatedLinear], botGrants: { 'inbox-keeper': ['mcp-linear'], researcher: [] } }}
        onMcpChange={onMcpChange}
        onClose={() => {}}
      />,
    )

    // Toggle teammate access
    const cardForAccess = screen.getByText('Linear').closest('.mcp-card') as HTMLElement
    await userEvent.click(within(cardForAccess).getByRole('button', { name: 'Manage access' }))
    expect(within(cardForAccess).getByRole('checkbox', { name: 'Sorter' })).toBeChecked()
    const scoutBox = within(cardForAccess).getByRole('checkbox', { name: 'Scout' })
    expect(scoutBox).not.toBeChecked()
    await userEvent.click(scoutBox)
    await userEvent.click(within(cardForAccess).getByRole('button', { name: 'Save access' }))

    await waitFor(() => expect(calls).toContainEqual({
      method: 'PUT',
      path: '/api/mcp/servers/mcp-linear/bots',
      body: { botIds: ['inbox-keeper', 'researcher'] },
    }))
    expect(onMcpChange).toHaveBeenLastCalledWith({
      servers: [{ ...policyUpdatedLinear, grantedBotIds: ['inbox-keeper', 'researcher'] }],
      botGrants: { 'inbox-keeper': ['mcp-linear'], researcher: ['mcp-linear'] },
    })
  })

  it('imports mcpServers JSON with validation feedback, adds/edits stdio servers preserving masked secrets, pauses, and deletes with confirmation', async () => {
    const fsServer: McpServerView = {
      id: 'mcp-fs',
      name: 'Filesystem',
      slug: 'filesystem',
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      cwd: '/tmp',
      url: '',
      envKeys: ['API_TOKEN'],
      headerKeys: [],
      envMasked: { API_TOKEN: 'tok…9999' },
      headersMasked: {},
      trustReadOnlyHint: true,
      tools: [],
      toolPolicies: {},
      status: 'connected',
      lastError: '',
      grantedBotIds: ['researcher'],
      createdAt: 1,
      updatedAt: 1,
    }
    const editedFsServer: McpServerView = {
      ...fsServer,
      cwd: '/var/tmp',
      updatedAt: 2,
    }
    const pausedFsServer: McpServerView = {
      ...editedFsServer,
      enabled: false,
      status: 'disconnected',
      updatedAt: 3,
    }

    let patchIndex = 0
    const calls = mockFetch({
      'POST /api/mcp/servers/import': () => ({
        body: {
          imported: [fsServer],
          errors: [{ name: 'broken', error: 'MCP server entry must specify either "command" (stdio) or "url" (http)' }],
        },
      }),
      'PATCH /api/mcp/servers/mcp-fs': () => {
        patchIndex += 1
        return { body: { server: patchIndex === 1 ? editedFsServer : pausedFsServer } }
      },
      'DELETE /api/mcp/servers/mcp-fs': () => ({
        body: { ok: true, state: { servers: [], botGrants: {} } },
      }),
    })
    const onMcpChange = vi.fn()

    const { rerender } = render(
      <ConnectorsDialog
        state={snapshot}
        roster={roster}
        onChange={() => {}}
        mcpState={{ servers: [], botGrants: { 'inbox-keeper': [], researcher: [] } }}
        onMcpChange={onMcpChange}
        initialTab="mcp"
        onClose={() => {}}
      />,
    )

    expect(screen.getByText(/No MCP servers configured yet/)).toBeInTheDocument()

    // Import JSON
    await userEvent.click(screen.getByRole('button', { name: 'Import JSON' }))
    const jsonPayload = JSON.stringify({
      mcpServers: {
        Filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
        broken: {},
      },
    })
    fireEvent.change(screen.getByPlaceholderText('Paste Claude Desktop or Cursor mcpServers JSON'), {
      target: { value: jsonPayload },
    })
    await userEvent.click(screen.getByRole('checkbox', { name: /Trust server readOnlyHint/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Scout' }))
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/mcp/servers/import',
      body: {
        json: jsonPayload,
        botIds: ['researcher'],
        trustReadOnlyHint: true,
      },
    }))
    expect(onMcpChange).toHaveBeenLastCalledWith({
      servers: [fsServer],
      botGrants: { 'inbox-keeper': [], researcher: ['mcp-fs'] },
    })
    expect(screen.getByText('Imported 1 MCP server(s).')).toBeInTheDocument()
    expect(screen.getByText('Skipped 1 invalid entries:')).toBeInTheDocument()
    expect(screen.getByText(/broken: MCP server entry must specify/)).toBeInTheDocument()

    rerender(
      <ConnectorsDialog
        state={snapshot}
        roster={roster}
        onChange={() => {}}
        mcpState={{ servers: [fsServer], botGrants: { 'inbox-keeper': [], researcher: ['mcp-fs'] } }}
        onMcpChange={onMcpChange}
        initialTab="mcp"
        onClose={() => {}}
      />,
    )

    // Edit stdio server while keeping saved secret untouched (and verify renaming key without value disables Save)
    const card = screen.getByText('Filesystem').closest('.mcp-card') as HTMLElement
    expect(within(card).getByText('stdio')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    expect(screen.getByPlaceholderText('Saved (tok…9999) — leave blank to keep')).toBeInTheDocument()
    const envKeyInput = screen.getByLabelText('Key') as HTMLInputElement
    const saveBtn = screen.getByRole('button', { name: 'Save' })
    expect(saveBtn).not.toBeDisabled()
    await userEvent.clear(envKeyInput)
    await userEvent.type(envKeyInput, 'RENAMED_TOKEN')
    expect(saveBtn).toBeDisabled()
    await userEvent.clear(envKeyInput)
    await userEvent.type(envKeyInput, 'API_TOKEN')
    expect(saveBtn).not.toBeDisabled()
    const cwdInput = screen.getByLabelText('Working folder')
    await userEvent.clear(cwdInput)
    await userEvent.type(cwdInput, '/var/tmp')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(calls[1]?.method).toBe('PATCH'))
    expect(calls[1]?.path).toBe('/api/mcp/servers/mcp-fs')
    expect((calls[1]?.body as { cwd?: string; env?: Record<string, unknown> }).cwd).toBe('/var/tmp')
    expect((calls[1]?.body as { env?: Record<string, unknown> }).env ?? {}).toEqual({})

    rerender(
      <ConnectorsDialog
        state={snapshot}
        roster={roster}
        onChange={() => {}}
        mcpState={{ servers: [editedFsServer], botGrants: { 'inbox-keeper': [], researcher: ['mcp-fs'] } }}
        onMcpChange={onMcpChange}
        initialTab="mcp"
        onClose={() => {}}
      />,
    )

    // Pause server
    const cardToPause = screen.getByText('Filesystem').closest('.mcp-card') as HTMLElement
    await userEvent.click(within(cardToPause).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(calls[2]).toEqual({
      method: 'PATCH',
      path: '/api/mcp/servers/mcp-fs',
      body: { enabled: false },
    }))

    rerender(
      <ConnectorsDialog
        state={snapshot}
        roster={roster}
        onChange={() => {}}
        mcpState={{ servers: [pausedFsServer], botGrants: { 'inbox-keeper': [], researcher: ['mcp-fs'] } }}
        onMcpChange={onMcpChange}
        initialTab="mcp"
        onClose={() => {}}
      />,
    )
    const pausedCard = screen.getByText('Filesystem').closest('.mcp-card') as HTMLElement
    expect(within(pausedCard).getByText('Paused')).toBeInTheDocument()

    // Open Edit form, then delete server via ConfirmDialog -> Edit form closes too
    await userEvent.click(within(pausedCard).getByRole('button', { name: 'Edit' }))
    expect(screen.getByText('Edit Filesystem')).toBeInTheDocument()
    await userEvent.click(within(pausedCard).getByRole('button', { name: 'Delete' }))
    const confirm = screen.getByRole('alertdialog')
    expect(confirm).toHaveTextContent('Delete Filesystem?')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls[3]).toEqual({
      method: 'DELETE',
      path: '/api/mcp/servers/mcp-fs',
      body: undefined,
    }))
    expect(screen.queryByText('Edit Filesystem')).toBeNull()
    expect(onMcpChange).toHaveBeenLastCalledWith({
      servers: [],
      botGrants: { 'inbox-keeper': [], researcher: [] },
    })
  })

  it('renders Chinese tab labels and MCP server controls when lang is zh-CN', async () => {
    render(
      <I18nProvider lang="zh-CN">
        <ConnectorsDialog
          state={snapshot}
          roster={roster}
          onChange={() => {}}
          mcpState={{ servers: [], botGrants: {} }}
          onMcpChange={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    )
    expect(screen.getByRole('tab', { name: '应用' })).toBeInTheDocument()
    const zhMcpTab = screen.getByRole('tab', { name: 'MCP 服务' })
    await userEvent.click(zhMcpTab)
    expect(screen.getByText(/本机命令（stdio）由你亲自配置/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加服务' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导入 JSON' })).toBeInTheDocument()
  })

  it('creates a remote HTTP MCP server manually with headers and teammate grants', async () => {
    const createdServer: McpServerView = {
      id: 'mcp-gh',
      name: 'GitHub',
      slug: 'github',
      transport: 'http',
      enabled: true,
      command: '',
      args: [],
      cwd: '',
      url: 'https://api.githubcopilot.com/mcp/',
      envKeys: [],
      headerKeys: ['Authorization'],
      envMasked: {},
      headersMasked: { Authorization: 'Bear…abcd' },
      trustReadOnlyHint: true,
      tools: [],
      toolPolicies: {},
      status: 'connected',
      lastError: '',
      grantedBotIds: ['inbox-keeper'],
      createdAt: 1,
      updatedAt: 1,
    }
    const calls = mockFetch({
      'POST /api/mcp/servers': () => ({ status: 201, body: { server: createdServer } }),
    })
    const onMcpChange = vi.fn()

    render(
      <ConnectorsDialog
        state={snapshot}
        roster={roster}
        onChange={() => {}}
        mcpState={{ servers: [], botGrants: { 'inbox-keeper': [], researcher: [] } }}
        onMcpChange={onMcpChange}
        initialTab="mcp"
        onClose={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await userEvent.type(screen.getByLabelText('Name'), 'GitHub')
    await userEvent.selectOptions(screen.getByLabelText('Transport'), 'http')
    await userEvent.type(screen.getByLabelText('Server URL'), 'https://api.githubcopilot.com/mcp/')

    await userEvent.click(screen.getByRole('button', { name: /Authorization: Bearer/ }))
    const valueInput = screen.getByPlaceholderText('Value') as HTMLInputElement
    const saveBtn = screen.getByRole('button', { name: 'Save' })
    await userEvent.clear(valueInput)
    expect(saveBtn).toBeDisabled()
    await userEvent.type(valueInput, 'Bearer ghp_secret_abcd')
    expect(saveBtn).not.toBeDisabled()

    await userEvent.click(screen.getByRole('checkbox', { name: /Trust server readOnlyHint/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sorter' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/mcp/servers',
      body: {
        name: 'GitHub',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer ghp_secret_abcd' },
        trustReadOnlyHint: true,
        botIds: ['inbox-keeper'],
      },
    }))
    expect(onMcpChange).toHaveBeenCalledWith({
      servers: [createdServer],
      botGrants: { 'inbox-keeper': ['mcp-gh'], researcher: [] },
    })
  })
})
