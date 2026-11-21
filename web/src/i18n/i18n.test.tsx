import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  SignedOut,
  createMcpServer,
  createWikiPage,
  deleteMcpServer,
  deleteWikiPage,
  fetchMcpServers,
  fetchWiki,
  fetchWikiPage,
  importMcpServers,
  resolveApproval,
  revertWikiPage,
  saveWikiPage,
  setBotMcpServers,
  setMcpServerBots,
  testMcpServer,
  updateMcpServer,
} from '../api'
import type {
  ApprovalEditInput,
  BotRefPayload,
  GatewayEvent,
  McpServerView,
  WikiListResponse,
  WikiPageDetail,
  WikiPageResponse,
  WikiRevision,
} from '../types'
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

  it('includes editable approval buttons, badges, field labels, and validation messages in both languages with placeholder parity', () => {
    const requiredEditKeys: MessageKey[] = [
      'approval.edit',
      'approval.approveEdited',
      'approval.reset',
      'approval.editedBadge',
      'thread.editedBadge',
      'approval.edit.to',
      'approval.edit.cc',
      'approval.edit.bcc',
      'approval.edit.subject',
      'approval.edit.body',
      'approval.edit.replyAll',
      'approval.edit.channel',
      'approval.edit.thread',
      'approval.edit.message',
      'approval.edit.title',
      'approval.edit.markdown',
      'approval.edit.start',
      'approval.edit.end',
      'approval.edit.location',
      'approval.edit.attendees',
      'approval.edit.description',
      'approval.edit.action',
      'approval.edit.detail',
      'approval.edit.argsJson',
      'approval.edit.formMode',
      'approval.edit.jsonMode',
      'approval.edit.recipientsHint',
      'approval.edit.invalidJson',
      'approval.edit.jsonMustBeObject',
      'approval.edit.requiredField',
      'approval.edit.atLeastOneField',
      'approval.edit.invalidNumber',
      'approval.edit.failed',
    ]
    for (const key of requiredEditKeys) {
      expect(en[key]).toBeTruthy()
      expect(zhCN[key]).toBeTruthy()
      expect({ key, names: placeholders(zhCN[key]) }).toEqual({ key, names: placeholders(en[key]) })
    }
    expect(en['approval.edit']).toBe('Edit')
    expect(zhCN['approval.edit']).toBe('编辑')
    expect(en['approval.approveEdited']).toBe('Approve edited')
    expect(zhCN['approval.approveEdited']).toBe('按修改批准')
    expect(en['approval.reset']).toBe('Reset')
    expect(zhCN['approval.reset']).toBe('还原')
    expect(en['approval.editedBadge']).toBe('Edited by you')
    expect(zhCN['approval.editedBadge']).toBe('你已修改')
    expect(en['thread.editedBadge']).toBe('edited')
    expect(zhCN['thread.editedBadge']).toBe('已修改')
    expect(translate('en', 'approval.edit.requiredField', { field: 'Subject' })).toBe('Subject is required.')
    expect(translate('zh-CN', 'approval.edit.requiredField', { field: '主题' })).toBe('请填写主题。')
    expect(translate('en', 'approval.edit.invalidNumber', { field: 'limit' })).toBe('limit must be a valid number.')
    expect(translate('zh-CN', 'approval.edit.invalidNumber', { field: 'limit' })).toBe('limit必须是有效数字。')
  })

  it('includes team wiki sidebar, dialog, taint badges, form fields, revisions, and error keys in both languages with placeholder parity', () => {
    const requiredWikiKeys: MessageKey[] = [
      'sidebar.wiki',
      'wiki.title',
      'wiki.subtitle',
      'wiki.close',
      'wiki.filter.all',
      'wiki.filter.contact',
      'wiki.filter.client',
      'wiki.filter.project',
      'wiki.filter.topic',
      'wiki.kind.contact',
      'wiki.kind.client',
      'wiki.kind.project',
      'wiki.kind.topic',
      'wiki.searchPlaceholder',
      'wiki.newPage',
      'wiki.empty',
      'wiki.noMatches',
      'wiki.selectPrompt',
      'wiki.countOne',
      'wiki.count',
      'wiki.loading',
      'wiki.externalBadge',
      'wiki.externalWarning',
      'wiki.reviewAndVerify',
      'wiki.saveAndVerify',
      'wiki.versionMeta',
      'wiki.byOperator',
      'wiki.edit',
      'wiki.save',
      'wiki.saving',
      'wiki.create',
      'wiki.cancel',
      'wiki.delete',
      'wiki.confirmDelete',
      'wiki.field.kind',
      'wiki.field.title',
      'wiki.field.slug',
      'wiki.field.slugHint',
      'wiki.field.summary',
      'wiki.field.tags',
      'wiki.field.tagsPlaceholder',
      'wiki.field.body',
      'wiki.field.note',
      'wiki.field.notePlaceholder',
      'wiki.history',
      'wiki.revert',
      'wiki.confirmRevert',
      'wiki.currentVersion',
      'wiki.emptyBody',
      'wiki.error.already_exists',
      'wiki.error.invalid_kind',
      'wiki.error.invalid_slug',
      'wiki.error.invalid_version',
      'wiki.error.invalid_wiki',
      'wiki.error.not_found',
      'wiki.error.loadFailed',
    ]
    for (const key of requiredWikiKeys) {
      expect(en[key]).toBeTruthy()
      expect(zhCN[key]).toBeTruthy()
      expect({ key, names: placeholders(zhCN[key]) }).toEqual({ key, names: placeholders(en[key]) })
    }
    expect(en['sidebar.wiki']).toBe('Team wiki')
    expect(zhCN['sidebar.wiki']).toBe('团队知识库')
    expect(en['wiki.externalBadge']).toBe('External source')
    expect(zhCN['wiki.externalBadge']).toBe('外部来源')
    expect(en['wiki.saveAndVerify']).toBe('Save & verify')
    expect(zhCN['wiki.saveAndVerify']).toBe('保存并设为已核验')
    expect(translate('en', 'wiki.versionMeta', { version: 3, who: 'you' })).toBe('v3 · Updated by you')
    expect(translate('zh-CN', 'wiki.versionMeta', { version: 3, who: '你' })).toBe('v3 · 更新者：你')
    expect(translate('en', 'wiki.confirmDelete', { title: 'Acme Corp' })).toBe('Delete “Acme Corp” from the team wiki?')
    expect(translate('zh-CN', 'wiki.confirmDelete', { title: '极光科技' })).toBe('确定从团队知识库中删除「极光科技」？')
    expect(translate('en', 'wiki.confirmRevert', { title: 'Acme Corp', version: 2 })).toBe('Revert “Acme Corp” to version 2?')
    expect(translate('zh-CN', 'wiki.confirmRevert', { title: '极光科技', version: 2 })).toBe('确定将「极光科技」回滚到 v2？')
    expect(translate('en', 'wiki.history', { count: 4 })).toBe('History (4)')
    expect(translate('zh-CN', 'wiki.history', { count: 4 })).toBe('历史版本（4）')
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

describe('resolveApproval API client', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('forwards edit in POST /api/approvals/:id body and throws ApiError with invalid_edit on 400', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: '"subject" cannot contain line breaks.',
        code: 'invalid_edit',
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'already settled' }), { status: 409 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const edit: ApprovalEditInput = {
      kind: 'connector',
      tool: 'mail_send',
      to: ['alice@example.com'],
      cc: ['bob@example.com'],
      subject: 'Updated subject',
      body: 'Updated body',
    }

    await resolveApproval(42, 'approve', undefined, undefined, edit)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/approvals/42')
    const init0 = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init0.method).toBe('POST')
    expect(JSON.parse(String(init0.body))).toEqual({ decision: 'approve', edit })

    await resolveApproval(43, 'approve', '1h', undefined, { kind: 'prompt', action: 'Post update', detail: 'Final text' })
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/approvals/43')
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      decision: 'approve',
      remember: '1h',
      edit: { kind: 'prompt', action: 'Post update', detail: 'Final text' },
    })

    await resolveApproval(44, 'discard')
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/approvals/44')
    expect(JSON.parse(String((fetchMock.mock.calls[2]![1] as RequestInit).body))).toEqual({ decision: 'discard' })

    const err = await resolveApproval(42, 'approve', undefined, undefined, edit).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({
      status: 400,
      code: 'invalid_edit',
      message: '"subject" cannot contain line breaks.',
    })

    await expect(resolveApproval(42, 'approve', undefined, undefined, edit)).resolves.toBeUndefined()
    await expect(resolveApproval(42, 'approve', undefined, undefined, edit)).rejects.toBeInstanceOf(SignedOut)
  })
})

describe('Wiki API client', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const samplePage: WikiPageDetail = {
    id: 'client/acme-corp',
    kind: 'client',
    slug: 'acme-corp',
    title: 'Acme Corp',
    summary: 'Enterprise SaaS client',
    tags: ['enterprise', 'q3'],
    sourceTainted: false,
    updatedBy: 'operator',
    version: 2,
    createdAt: 1000,
    updatedAt: 2000,
    body: '# Acme Corp\n\nPrimary contact is Alice.',
  }

  const sampleRevisions: WikiRevision[] = [
    {
      id: 2,
      pageId: 'client/acme-corp',
      version: 2,
      title: 'Acme Corp',
      summary: 'Enterprise SaaS client',
      tags: ['enterprise', 'q3'],
      body: '# Acme Corp\n\nPrimary contact is Alice.',
      editedBy: 'operator',
      note: 'Verified notes',
      sourceTainted: false,
      createdAt: 2000,
    },
    {
      id: 1,
      pageId: 'client/acme-corp',
      version: 1,
      title: 'Acme Corp',
      summary: 'Initial notes',
      tags: ['enterprise'],
      body: '# Acme Corp\n\nInitial web research.',
      editedBy: 'researcher',
      note: 'First draft',
      sourceTainted: true,
      createdAt: 1000,
    },
  ]

  const samplePageResponse: WikiPageResponse = {
    page: samplePage,
    revisions: sampleRevisions,
  }

  it('builds query params cleanly in fetchWiki and handles 200, 400, and 401 responses', async () => {
    const listResponse: WikiListResponse = {
      pages: [{ ...samplePage, snippet: 'Primary contact is Alice.', score: 0.016 }],
      total: 1,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(listResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Invalid wiki kind: nope', code: 'invalid_kind' }), { status: 400 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchWiki()).toEqual(listResponse)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/wiki')

    expect(await fetchWiki({ q: '   ' })).toEqual(listResponse)
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/wiki')

    expect(await fetchWiki({ q: 'Acme | 极光', kind: 'client', limit: 25 })).toEqual(listResponse)
    const url = new URL(String(fetchMock.mock.calls[2]![0]), 'http://localhost')
    expect(url.pathname).toBe('/api/wiki')
    expect(url.searchParams.get('q')).toBe('Acme | 极光')
    expect(url.searchParams.get('kind')).toBe('client')
    expect(url.searchParams.get('limit')).toBe('25')

    const err = await fetchWiki().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 400, code: 'invalid_kind', message: 'Invalid wiki kind: nope' })

    await expect(fetchWiki()).rejects.toBeInstanceOf(SignedOut)
  })

  it('fetches, creates (throwing ApiError on 409 already_exists), saves, reverts, and deletes wiki pages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(samplePageResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Wiki page not found', code: 'not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(samplePageResponse), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Wiki page already exists: client/acme-corp', code: 'already_exists' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(samplePageResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(samplePageResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(samplePageResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Wiki page not found', code: 'not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    // fetchWikiPage (200 & 404)
    expect(await fetchWikiPage('client', 'acme-corp')).toEqual(samplePageResponse)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/wiki/client/acme-corp')

    const notFoundErr = await fetchWikiPage('client', 'missing-slug').catch((e: unknown) => e)
    expect(notFoundErr).toBeInstanceOf(ApiError)
    expect(notFoundErr).toMatchObject({ status: 404, code: 'not_found', message: 'Wiki page not found' })

    // createWikiPage (201 & 409 already_exists)
    expect(await createWikiPage({
      kind: 'client',
      slug: 'acme-corp',
      title: 'Acme Corp',
      summary: 'Enterprise SaaS client',
      tags: ['enterprise', 'q3'],
      body: '# Acme Corp\n\nPrimary contact is Alice.',
      note: 'Initial create',
    })).toEqual(samplePageResponse)
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/wiki')
    expect((fetchMock.mock.calls[2]![1] as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((fetchMock.mock.calls[2]![1] as RequestInit).body))).toEqual({
      kind: 'client',
      slug: 'acme-corp',
      title: 'Acme Corp',
      summary: 'Enterprise SaaS client',
      tags: ['enterprise', 'q3'],
      body: '# Acme Corp\n\nPrimary contact is Alice.',
      note: 'Initial create',
    })

    const conflictErr = await createWikiPage({
      kind: 'client',
      slug: 'acme-corp',
      title: 'Acme Corp',
      body: 'Duplicate',
    }).catch((e: unknown) => e)
    expect(conflictErr).toBeInstanceOf(ApiError)
    expect(conflictErr).toMatchObject({
      status: 409,
      code: 'already_exists',
      message: 'Wiki page already exists: client/acme-corp',
    })

    // saveWikiPage
    expect(await saveWikiPage('client', 'acme-corp', {
      title: 'Acme Corp',
      summary: 'Enterprise SaaS client',
      tags: ['enterprise', 'q3'],
      body: '# Acme Corp\n\nUpdated body.',
      note: 'Verified by operator',
    })).toEqual(samplePageResponse)
    expect(fetchMock.mock.calls[4]![0]).toBe('/api/wiki/client/acme-corp')
    expect((fetchMock.mock.calls[4]![1] as RequestInit).method).toBe('PUT')
    expect(JSON.parse(String((fetchMock.mock.calls[4]![1] as RequestInit).body))).toEqual({
      title: 'Acme Corp',
      summary: 'Enterprise SaaS client',
      tags: ['enterprise', 'q3'],
      body: '# Acme Corp\n\nUpdated body.',
      note: 'Verified by operator',
    })

    // revertWikiPage (without note and with note)
    expect(await revertWikiPage('client', 'acme-corp', 1)).toEqual(samplePageResponse)
    expect(fetchMock.mock.calls[5]![0]).toBe('/api/wiki/client/acme-corp/revert')
    expect((fetchMock.mock.calls[5]![1] as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((fetchMock.mock.calls[5]![1] as RequestInit).body))).toEqual({ version: 1 })

    expect(await revertWikiPage('client', 'acme-corp', 1, 'Restore v1')).toEqual(samplePageResponse)
    expect(fetchMock.mock.calls[6]![0]).toBe('/api/wiki/client/acme-corp/revert')
    expect(JSON.parse(String((fetchMock.mock.calls[6]![1] as RequestInit).body))).toEqual({ version: 1, note: 'Restore v1' })

    // deleteWikiPage (200, 404, 401)
    await expect(deleteWikiPage('client', 'acme-corp')).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[7]![0]).toBe('/api/wiki/client/acme-corp')
    expect((fetchMock.mock.calls[7]![1] as RequestInit).method).toBe('DELETE')
    expect((fetchMock.mock.calls[7]![1] as RequestInit).body).toBeUndefined()

    const deleteErr = await deleteWikiPage('client', 'acme-corp').catch((e: unknown) => e)
    expect(deleteErr).toBeInstanceOf(ApiError)
    expect(deleteErr).toMatchObject({ status: 404, code: 'not_found' })

    await expect(deleteWikiPage('client', 'acme-corp')).rejects.toBeInstanceOf(SignedOut)

    // Verify GatewayEvent & BotRefPayload wiki/taint typings compile and hold expected values
    const ev: GatewayEvent = { type: 'wiki_changed' }
    const ref: BotRefPayload = { from: 'researcher', fromName: 'Researcher', content: 'Summary', tainted: true }
    expect(ev.type).toBe('wiki_changed')
    expect(ref.tainted).toBe(true)
  })
})
