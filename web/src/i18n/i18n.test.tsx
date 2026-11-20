import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  SignedOut,
  createMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  importMcpServers,
  setBotMcpServers,
  setMcpServerBots,
  testMcpServer,
  updateMcpServer,
} from '../api'
import type { McpServerView } from '../types'
import { en, type MessageKey } from './en'
import { I18nProvider, makeT, pickLang, translate, useT } from './index'
import { zhCN } from './zh-CN'

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('the Chinese dictionary', () => {
  it('has every key, and no key English lacks', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
  })

  it('fills in the same placeholders as English, so no value goes missing in translation', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect({ key, names: placeholders(zhCN[key]) }).toEqual({ key, names: placeholders(en[key]) })
    }
  })

  it('is actually translated: no entry is left as the English text (brand names aside)', () => {
    const sameOnPurpose = new Set<MessageKey>([
      'app.title', 'panel.trigger.webhook',
      // 品牌名、接口名和纯格式串，两种语言一样
      'models.form.apiKey', 'models.form.api.responses', 'picker.chip',
    ])
    const untranslated = (Object.keys(en) as MessageKey[]).filter((k) => !sameOnPurpose.has(k) && zhCN[k] === en[k])
    expect(untranslated).toEqual([])
  })

  it('includes connector dialog, panel, approval execution, and notice keys in both languages', () => {
    const requiredKeys: MessageKey[] = [
      'sidebar.connectors',
      'connectors.title',
      'connectors.close',
      'connectors.custodyNote',
      'connectors.keyLabel',
      'connectors.keyPlaceholder',
      'connectors.keySave',
      'connectors.keyTest',
      'connectors.testing',
      'connectors.testOk',
      'connectors.testBad',
      'connectors.keyLocked',
      'connectors.keyFromEnv',
      'connectors.keySet',
      'connectors.keyUnset',
      'connectors.keyChange',
      'connectors.keyClear',
      'connectors.needKeyHint',
      'connectors.group.mail_calendar',
      'connectors.group.productivity',
      'connectors.group.messaging',
      'connectors.status.active',
      'connectors.status.pending',
      'connectors.status.expired',
      'connectors.status.failed',
      'connectors.emptyAccounts',
      'connectors.connect',
      'connectors.authorizeBrowser',
      'connectors.grantTo',
      'connectors.grantedTo',
      'connectors.noGrants',
      'connectors.manageAccess',
      'connectors.saveAccess',
      'connectors.cancel',
      'connectors.reconnect',
      'connectors.refresh',
      'connectors.disconnect',
      'connectors.confirmDisconnect',
      'connectors.error.unauthorized',
      'connectors.error.bad_request',
      'connectors.error.locked',
      'panel.connectors',
      'panel.connectorsHint',
      'approval.exec.succeeded',
      'approval.exec.failed',
      'approval.exec.uncertain',
      'notice.connector_expired',
      'notice.connector_failed',
      'notice.connector_uncertain',
    ]
    for (const key of requiredKeys) {
      expect(en[key]).toBeTruthy()
      expect(zhCN[key]).toBeTruthy()
    }
    expect(zhCN['sidebar.connectors']).toBe('连接器')
    expect(zhCN['connectors.status.expired']).toBe('需重新授权')
    expect(zhCN['connectors.noGrants']).toBe('未授权给任何同事')
    expect(en['connectors.keyLocked']).toContain('OPENSUPERBOT_COMPOSIO_API_KEY')
    expect(zhCN['connectors.keyLocked']).toContain('OPENSUPERBOT_COMPOSIO_API_KEY')
    expect(en['connectors.error.locked']).toContain('OPENSUPERBOT_COMPOSIO_API_KEY')
    expect(zhCN['connectors.error.locked']).toContain('OPENSUPERBOT_COMPOSIO_API_KEY')
    expect(en['approval.exec.succeeded']).toBe('✓ Executed')
    expect(zhCN['approval.exec.succeeded']).toBe('✓ 已执行')
  })

  it('includes MCP tabs, custody note, form fields, status badges, tool policies, errors, and panel keys in both languages', () => {
    const requiredMcpKeys: MessageKey[] = [
      'connectors.tab.apps',
      'connectors.tab.mcp',
      'mcp.custody',
      'mcp.empty',
      'mcp.addServer',
      'mcp.importJson',
      'mcp.test',
      'mcp.testing',
      'mcp.save',
      'mcp.saving',
      'mcp.cancel',
      'mcp.edit',
      'mcp.delete',
      'mcp.pause',
      'mcp.enable',
      'mcp.access',
      'mcp.saveAccess',
      'mcp.grantTo',
      'mcp.grantedTo',
      'mcp.noGrants',
      'mcp.addTitle',
      'mcp.editTitle',
      'mcp.importTitle',
      'mcp.importHint',
      'mcp.importPlaceholder',
      'mcp.importSubmit',
      'mcp.importing',
      'mcp.importSuccess',
      'mcp.importPartialErrors',
      'mcp.importErrorRow',
      'mcp.field.name',
      'mcp.field.namePlaceholder',
      'mcp.field.transport',
      'mcp.transport.stdio',
      'mcp.transport.http',
      'mcp.field.command',
      'mcp.field.commandPlaceholder',
      'mcp.field.args',
      'mcp.field.argsPlaceholder',
      'mcp.field.cwd',
      'mcp.field.cwdPlaceholder',
      'mcp.field.url',
      'mcp.field.urlPlaceholder',
      'mcp.field.env',
      'mcp.field.headers',
      'mcp.field.keyPlaceholder',
      'mcp.field.valuePlaceholder',
      'mcp.field.secretSavedPlaceholder',
      'mcp.field.addVar',
      'mcp.field.addHeader',
      'mcp.field.removeRow',
      'mcp.field.trustReadOnlyHint',
      'mcp.field.trustReadOnlyHintHelp',
      'mcp.status.connected',
      'mcp.status.error',
      'mcp.status.paused',
      'mcp.status.disconnected',
      'mcp.toolsCount',
      'mcp.toolsEmpty',
      'mcp.policyDefault',
      'mcp.policyRead',
      'mcp.policyWrite',
      'mcp.hintReadOnly',
      'mcp.hintDestructive',
      'mcp.confirmDelete',
      'mcp.error.invalid_body',
      'mcp.error.invalid_name',
      'mcp.error.invalid_transport',
      'mcp.error.invalid_enabled',
      'mcp.error.invalid_trust_hint',
      'mcp.error.invalid_connect_now',
      'mcp.error.invalid_bots',
      'mcp.error.invalid_policies',
      'mcp.error.invalid_stdio',
      'mcp.error.invalid_http',
      'mcp.error.invalid_secrets',
      'mcp.error.invalid_import',
      'mcp.error.empty_import',
      'mcp.error.invalid_servers',
      'mcp.error.not_found',
      'panel.mcpServers',
      'panel.mcpServersHint',
      'panel.mcpServersEmpty',
      'panel.mcpToolsCount',
      'error.invalid_servers',
    ]
    for (const key of requiredMcpKeys) {
      expect(en[key]).toBeTruthy()
      expect(zhCN[key]).toBeTruthy()
    }
    expect(en['connectors.tab.apps']).toBe('Apps')
    expect(zhCN['connectors.tab.apps']).toBe('应用')
    expect(en['connectors.tab.mcp']).toBe('MCP')
    expect(zhCN['connectors.tab.mcp']).toBe('MCP 服务')
    expect(en['mcp.custody']).toContain('0600')
    expect(zhCN['mcp.custody']).toContain('0600')
    expect(en['mcp.policyDefault']).toContain('{mode}')
    expect(zhCN['mcp.policyDefault']).toContain('{mode}')
    expect(en['mcp.toolsCount']).toContain('{count}')
    expect(zhCN['mcp.toolsCount']).toContain('{count}')
  })
})

describe('translate', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'panel.title', { name: 'Scout' })).toBe("Scout's computer")
    expect(translate('zh-CN', 'panel.title', { name: 'Scout' })).toBe('Scout 的电脑')
    expect(translate('en', 'panel.title')).toBe("{name}'s computer")
  })

  it('formats dates the browser way in English and the Chinese way in Chinese', () => {
    expect(makeT('en').locale).toBeUndefined()
    expect(makeT('zh-CN').locale).toBe('zh-CN')
  })
})

describe('pickLang', () => {
  it('follows the saved setting first', () => {
    expect(pickLang('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(pickLang('en', ['zh-CN'])).toBe('en')
  })

  it('otherwise takes the first browser language it has', () => {
    expect(pickLang('', ['zh-TW', 'en'])).toBe('zh-CN')
    expect(pickLang('', ['fr-FR', 'zh-CN'])).toBe('zh-CN')
    expect(pickLang(undefined, ['de', 'en-GB'])).toBe('en')
    expect(pickLang('', ['ja'])).toBe('en')
    expect(pickLang('', [])).toBe('en')
  })
})

describe('useT', () => {
  function Probe() {
    const t = useT()
    return <span>{t('thread.today')}</span>
  }

  it('is English without a provider, and the provider language inside one', () => {
    const { unmount } = render(<Probe />)
    expect(screen.getByText('Today')).toBeInTheDocument()
    unmount()
    render(<I18nProvider lang="zh-CN"><Probe /></I18nProvider>)
    expect(screen.getByText('今天')).toBeInTheDocument()
  })
})

describe('MCP API client', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const sampleServer: McpServerView = {
    id: 'mcp_1',
    name: 'Linear',
    slug: 'linear',
    transport: 'http',
    enabled: true,
    command: '',
    args: [],
    cwd: '',
    url: 'https://mcp.linear.app/sse',
    envKeys: [],
    headerKeys: ['Authorization'],
    envMasked: {},
    headersMasked: { Authorization: 'Bear…1234' },
    trustReadOnlyHint: true,
    tools: [
      {
        name: 'list_issues',
        description: 'List issues',
        inputSchema: { type: 'object' },
        readOnlyHint: true,
        destructiveHint: false,
        overrideMode: null,
        effectiveMode: 'read',
        exposedName: 'mcp__linear__list_issues',
      },
    ],
    toolPolicies: {},
    status: 'connected',
    lastError: '',
    grantedBotIds: ['researcher'],
    createdAt: 1000,
    updatedAt: 2000,
  }

  it('returns null on 404 from fetchMcpServers, throws SignedOut on 401, and parses snapshot on 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        servers: [sampleServer],
        botGrants: { researcher: ['mcp_1'] },
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchMcpServers()).toBeNull()
    await expect(fetchMcpServers()).rejects.toBeInstanceOf(SignedOut)
    expect(await fetchMcpServers()).toEqual({
      servers: [sampleServer],
      botGrants: { researcher: ['mcp_1'] },
    })
  })

  it('calls MCP server CRUD, import, test, and grant endpoints with expected methods, paths, and error codes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ server: sampleServer }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        imported: [sampleServer],
        errors: [{ name: 'bad', error: 'missing command or url' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ server: { ...sampleServer, enabled: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ server: sampleServer }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, state: { servers: [], botGrants: {} } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ server: sampleServer, botIds: ['researcher'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ botId: 'inbox keeper', serverIds: ['mcp_1'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no MCP servers found in JSON', code: 'empty_import' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await createMcpServer({
      name: 'Linear',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
      headers: { Authorization: 'Bearer secret1234' },
      trustReadOnlyHint: true,
      botIds: ['researcher'],
    })).toEqual({ server: sampleServer })
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/mcp/servers')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST')

    expect(await importMcpServers({ json: '{"mcpServers":{}}', botIds: ['researcher'], trustReadOnlyHint: false })).toEqual({
      imported: [sampleServer],
      errors: [{ name: 'bad', error: 'missing command or url' }],
    })
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/mcp/servers/import')

    expect(await updateMcpServer('mcp/1', { enabled: false, toolPolicies: { list_issues: 'default' } }))
      .toEqual({ server: { ...sampleServer, enabled: false } })
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/mcp/servers/mcp%2F1')
    expect((fetchMock.mock.calls[2]![1] as RequestInit).method).toBe('PATCH')

    expect(await testMcpServer('mcp/1')).toEqual({ server: sampleServer })
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/mcp/servers/mcp%2F1/test')
    expect((fetchMock.mock.calls[3]![1] as RequestInit).method).toBe('POST')

    await deleteMcpServer('mcp/1')
    expect(fetchMock.mock.calls[4]![0]).toBe('/api/mcp/servers/mcp%2F1')
    expect((fetchMock.mock.calls[4]![1] as RequestInit).method).toBe('DELETE')

    await setMcpServerBots('mcp/1', ['researcher'])
    expect(fetchMock.mock.calls[5]![0]).toBe('/api/mcp/servers/mcp%2F1/bots')
    expect((fetchMock.mock.calls[5]![1] as RequestInit).method).toBe('PUT')

    await setBotMcpServers('inbox keeper', ['mcp_1'])
    expect(fetchMock.mock.calls[6]![0]).toBe('/api/bots/inbox%20keeper/mcp')
    expect((fetchMock.mock.calls[6]![1] as RequestInit).method).toBe('PUT')

    const err = await importMcpServers({ json: '{}' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 400, code: 'empty_import', message: 'no MCP servers found in JSON' })
  })
})
