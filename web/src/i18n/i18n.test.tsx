import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  SignedOut,
  cancelBackgroundTask,
  cancelDispatchPlan,
  createMcpServer,
  createWikiPage,
  deleteMcpServer,
  deleteWikiPage,
  fetchBackgroundTasks,
  fetchDispatchPlans,
  fetchLlmQueue,
  fetchMcpServers,
  fetchQuietDigest,
  fetchRuleProposals,
  fetchTeamCharter,
  fetchWiki,
  fetchWikiPage,
  flushQuietDigest,
  importMcpServers,
  resolveApproval,
  resolveRuleProposal,
  revertWikiPage,
  saveTeamCharter,
  saveWikiPage,
  setBotMcpServers,
  setMcpServerBots,
  startDispatchPlan,
  steerBackgroundTask,
  syncWikiFromChats,
  testMcpServer,
  updateMcpServer,
} from '../api'
import type {
  ApprovalEditInput,
  ApprovalPayload,
  BackgroundTaskActionResponse,
  BackgroundTaskPayload,
  BackgroundTaskStatus,
  BackgroundTaskView,
  BotRefPayload,
  ComputerInfo,
  DispatchPlanActionResponse,
  DispatchPlanPayload,
  DispatchPlanStatus,
  DispatchPlanView,
  DispatchStepStatus,
  GatewayEvent,
  LlmPriority,
  LlmQueueEndpointView,
  LlmQueueSnapshot,
  McpServerView,
  Message,
  QuietDigestFlushResponse,
  QuietDigestPayload,
  QuietDigestSummary,
  ResolveRuleProposalResponse,
  RoutineMode,
  RuleProposalPayload,
  RuleProposalView,
  SettingsView,
  TeamCharterView,
  WikiListResponse,
  WikiPageDetail,
  WikiPageResponse,
  WikiRevision,
  WikiSyncResponse,
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
      'wiki.byAutoSync',
      'wiki.sync',
      'wiki.syncing',
      'wiki.syncDoneOne',
      'wiki.syncDoneMany',
      'wiki.syncEmpty',
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
      'wiki.error.sync_failed',
      'wiki.error.not_implemented',
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
    expect(en['wiki.sync']).toBe('Sync from chats')
    expect(zhCN['wiki.sync']).toBe('从对话同步')
    expect(en['wiki.byAutoSync']).toBe('auto-sync')
    expect(zhCN['wiki.byAutoSync']).toBe('自动同步')
    expect(translate('en', 'wiki.syncDoneMany', { count: 3 })).toBe('Updated 3 wiki pages from recent chats.')
    expect(translate('zh-CN', 'wiki.syncDoneMany', { count: 3 })).toBe('已从近期对话更新 3 篇知识库页面。')
    expect(translate('en', 'wiki.versionMeta', { version: 3, who: 'you' })).toBe('v3 · Updated by you')
    expect(translate('zh-CN', 'wiki.versionMeta', { version: 3, who: '你' })).toBe('v3 · 更新者：你')
    expect(translate('en', 'wiki.versionMeta', { version: 2, who: zhCN['wiki.byAutoSync'] })).toBe('v2 · Updated by 自动同步')
    expect(translate('zh-CN', 'wiki.versionMeta', { version: 2, who: zhCN['wiki.byAutoSync'] })).toBe('v2 · 更新者：自动同步')
    expect(translate('en', 'wiki.confirmDelete', { title: 'Acme Corp' })).toBe('Delete “Acme Corp” from the team wiki?')
    expect(translate('zh-CN', 'wiki.confirmDelete', { title: '极光科技' })).toBe('确定从团队知识库中删除「极光科技」？')
    expect(translate('en', 'wiki.confirmRevert', { title: 'Acme Corp', version: 2 })).toBe('Revert “Acme Corp” to version 2?')
    expect(translate('zh-CN', 'wiki.confirmRevert', { title: '极光科技', version: 2 })).toBe('确定将「极光科技」回滚到 v2？')
    expect(translate('en', 'wiki.history', { count: 4 })).toBe('History (4)')
    expect(translate('zh-CN', 'wiki.history', { count: 4 })).toBe('历史版本（4）')
  })

  it('includes proactive prepare mode, rule proposal, quiet digest, Quiet Hours settings, and sidebar preview keys in both languages with placeholder parity', () => {
    const requiredProactiveKeys: MessageKey[] = [
      'routine.createdPrepare',
      'routine.prepareHint',
      'panel.prepareTag',
      'panel.trigger.prepare',
      'ruleProposal.title',
      'ruleProposal.sourceDiscard',
      'ruleProposal.sourceAgent',
      'ruleProposal.sourceDreaming',
      'ruleProposal.taintedBadge',
      'ruleProposal.ruleLabel',
      'ruleProposal.rulePlaceholder',
      'ruleProposal.accept',
      'ruleProposal.saving',
      'ruleProposal.dismiss',
      'ruleProposal.dismissing',
      'ruleProposal.accepted',
      'ruleProposal.acceptedEdited',
      'ruleProposal.dismissed',
      'ruleProposal.emptyError',
      'ruleProposal.tooLongError',
      'ruleProposal.failed',
      'ruleProposal.hint',
      'quietDigest.titleOne',
      'quietDigest.titleMany',
      'quietDigest.window',
      'quietDigest.deliveredEarly',
      'quietDigest.routineFallback',
      'settings.quietHours.title',
      'settings.quietHours.enable',
      'settings.quietHours.hint',
      'settings.quietHours.start',
      'settings.quietHours.end',
      'settings.quietHours.timezone',
      'settings.quietHours.sameTimeWarning',
      'settings.quietHours.activeNow',
      'settings.quietHours.pendingOne',
      'settings.quietHours.pendingMany',
      'settings.quietHours.pendingNone',
      'settings.quietHours.deliverNow',
      'settings.quietHours.delivering',
      'settings.quietHours.deliveredOne',
      'settings.quietHours.delivered',
      'settings.quietHours.deliverFailed',
      'sidebar.preview.ruleProposal',
      'sidebar.preview.quietDigestOne',
      'sidebar.preview.quietDigestMany',
      'error.invalid_rule',
      'error.settled',
      'error.gone',
      'error.memory_unavailable',
      'error.invalid_decision',
    ]
    for (const key of requiredProactiveKeys) {
      expect(en[key]).toBeTruthy()
      expect(zhCN[key]).toBeTruthy()
      expect({ key, names: placeholders(zhCN[key]) }).toEqual({ key, names: placeholders(en[key]) })
    }
    expect(en['routine.createdPrepare']).toBe('Prepare routine created')
    expect(zhCN['routine.createdPrepare']).toBe('已创建备料任务')
    expect(en['panel.prepareTag']).toBe('prepare')
    expect(zhCN['panel.prepareTag']).toBe('备料')
    expect(zhCN['settings.quietHours.hint']).toContain('值守（watch）')
    expect(en['settings.quietHours.deliveredOne']).toBe('Delivered 1 buffered update.')
    expect(zhCN['settings.quietHours.deliveredOne']).toBe('已投递 1 条暂存更新。')
    expect(en['ruleProposal.sourceDreaming']).toBe('Suggested from your feedback')
    expect(zhCN['ruleProposal.sourceDreaming']).toBe('根据你的对话反馈提议')
    expect(en['ruleProposal.taintedBadge']).toBe('External source — review carefully')
    expect(zhCN['ruleProposal.taintedBadge']).toBe('来自外部内容，请仔细核对')
    expect(translate('en', 'ruleProposal.tooLongError', { max: 300 })).toBe('Rule must be 300 characters or fewer.')
    expect(translate('zh-CN', 'ruleProposal.tooLongError', { max: 300 })).toBe('规矩不能超过 300 个字符。')
    expect(translate('en', 'quietDigest.titleMany', { count: 3 })).toBe('Morning digest · 3 updates')
    expect(translate('zh-CN', 'quietDigest.titleMany', { count: 3 })).toBe('晨报汇总 · 3 条更新')
    expect(translate('en', 'quietDigest.window', { start: '22:00', end: '08:00' })).toBe('Held during Quiet Hours (22:00–08:00)')
    expect(translate('zh-CN', 'quietDigest.window', { start: '22:00', end: '08:00' })).toBe('免打扰时段（22:00–08:00）暂存')
    expect(translate('en', 'settings.quietHours.timezone', { tz: 'Asia/Shanghai' })).toBe('Timezone: Asia/Shanghai')
    expect(translate('zh-CN', 'settings.quietHours.timezone', { tz: 'Asia/Shanghai' })).toBe('时区：Asia/Shanghai')
    expect(translate('en', 'settings.quietHours.pendingMany', { count: 4 })).toBe('4 updates waiting for the morning digest')
    expect(translate('zh-CN', 'settings.quietHours.pendingMany', { count: 4 })).toBe('4 条更新正等待晨报投递')
    expect(translate('en', 'settings.quietHours.delivered', { count: 2 })).toBe('Delivered 2 buffered updates.')
    expect(translate('zh-CN', 'settings.quietHours.delivered', { count: 2 })).toBe('已投递 2 条暂存更新。')
    expect(translate('en', 'sidebar.preview.quietDigestMany', { count: 5 })).toBe('Morning digest (5 updates)')
    expect(translate('zh-CN', 'sidebar.preview.quietDigestMany', { count: 5 })).toBe('晨报汇总（5 条更新）')
  })

  it('includes local LLM concurrency and queue status keys in both languages with placeholder parity', () => {
    const requiredLocalLlmKeys: MessageKey[] = [
      'settings.localLlm.label',
      'settings.localLlm.hint',
      'settings.localLlm.one',
      'settings.localLlm.unlimited',
      'settings.localLlm.option',
      'settings.localLlm.queueBusy',
      'settings.localLlm.queueActive',
    ]
    for (const key of requiredLocalLlmKeys) {
      expect(en[key]).toBeTruthy()
      expect(zhCN[key]).toBeTruthy()
      expect({ key, names: placeholders(zhCN[key]) }).toEqual({ key, names: placeholders(en[key]) })
    }
    expect(en['settings.localLlm.label']).toBe('Local model concurrency')
    expect(zhCN['settings.localLlm.label']).toBe('本地模型并发上限')
    expect(en['settings.localLlm.one']).toBe('1 (Recommended)')
    expect(zhCN['settings.localLlm.one']).toBe('1（推荐）')
    expect(en['settings.localLlm.unlimited']).toBe('Unlimited')
    expect(zhCN['settings.localLlm.unlimited']).toBe('不限制')
    expect(translate('en', 'settings.localLlm.option', { count: 4 })).toBe('4 concurrent')
    expect(translate('zh-CN', 'settings.localLlm.option', { count: 4 })).toBe('4 并发')
    expect(translate('en', 'settings.localLlm.queueBusy', { active: 1, queued: 2 })).toBe('Local queue: 1 active · 2 waiting')
    expect(translate('zh-CN', 'settings.localLlm.queueBusy', { active: 1, queued: 2 })).toBe('本地队列：1 运行中 · 2 排队中')
    expect(translate('en', 'settings.localLlm.queueActive', { active: 2 })).toBe('Local queue: 2 active')
    expect(translate('zh-CN', 'settings.localLlm.queueActive', { active: 2 })).toBe('本地队列：2 运行中')
  })

  it('includes Phase 7 background task, panel, approval held, error, and sidebar preview keys in both languages with placeholder parity', () => {
    const requiredBgKeys: MessageKey[] = [
      'approval.held.background',
      'panel.trigger.background',
      'panel.backgroundTasks',
      'panel.noBackgroundTasks',
      'error.invalid_note',
      'error.queue_full',
      'error.browser_in_use',
      'error.not_found',
      'bgTask.label',
      'bgTask.status.queued',
      'bgTask.status.running',
      'bgTask.status.completed',
      'bgTask.status.failed',
      'bgTask.status.cancelled',
      'bgTask.usingBrowser',
      'bgTask.stepsOne',
      'bgTask.stepsMany',
      'bgTask.steerPlaceholder',
      'bgTask.steerSend',
      'bgTask.steering',
      'bgTask.cancel',
      'bgTask.cancelling',
      'bgTask.showSteps',
      'bgTask.hideSteps',
      'bgTask.activePillOne',
      'bgTask.activePillMany',
      'bgTask.steerFailed',
      'bgTask.cancelFailed',
      'bgTask.emptyNote',
      'bgTask.noteTooLong',
      'bgTask.alreadySettled',
      'sidebar.preview.backgroundTask',
    ]
    for (const key of requiredBgKeys) {
      expect(en[key]).toBeTruthy()
      expect(zhCN[key]).toBeTruthy()
      expect({ key, names: placeholders(zhCN[key]) }).toEqual({ key, names: placeholders(en[key]) })
    }
    expect(en['panel.trigger.background']).toBe('Background')
    expect(zhCN['panel.trigger.background']).toBe('后台任务')
    expect(en['bgTask.usingBrowser']).toBe('Using browser')
    expect(zhCN['bgTask.usingBrowser']).toBe('占用浏览器')
    expect(translate('en', 'bgTask.stepsMany', { count: 4 })).toBe('4 steps')
    expect(translate('zh-CN', 'bgTask.stepsMany', { count: 4 })).toBe('4 步')
    expect(translate('en', 'bgTask.activePillMany', { count: 2 })).toBe('2 background tasks')
    expect(translate('zh-CN', 'bgTask.activePillMany', { count: 2 })).toBe('2 项后台任务')
    expect(translate('en', 'bgTask.noteTooLong', { max: 1000 })).toBe('Steering note must be 1000 characters or fewer.')
    expect(translate('zh-CN', 'bgTask.noteTooLong', { max: 1000 })).toBe('纠偏指令不能超过 1000 个字符。')
    expect(translate('en', 'sidebar.preview.backgroundTask', { title: 'Audit' })).toBe('Background: Audit')
    expect(translate('zh-CN', 'sidebar.preview.backgroundTask', { title: '竞品调研' })).toBe('后台任务：竞品调研')
  })

  it('includes Phase 8 dispatch pipeline, team charter, panel trigger, error, and sidebar preview keys in both languages with placeholder parity', () => {
    const requiredPhase8Keys: MessageKey[] = [
      'panel.trigger.pipeline',
      'error.invalid_state',
      'error.invalid_content',
      'sidebar.preview.dispatchPlan',
      'dispatch.label',
      'dispatch.status.draft',
      'dispatch.status.running',
      'dispatch.status.paused',
      'dispatch.status.completed',
      'dispatch.status.failed',
      'dispatch.status.cancelled',
      'dispatch.stepStatus.pending',
      'dispatch.stepStatus.running',
      'dispatch.stepStatus.waiting_approval',
      'dispatch.stepStatus.completed',
      'dispatch.stepStatus.failed',
      'dispatch.stepStatus.skipped',
      'dispatch.stepStatus.cancelled',
      'dispatch.taintedBadge',
      'dispatch.after',
      'dispatch.wave',
      'dispatch.start',
      'dispatch.starting',
      'dispatch.cancel',
      'dispatch.cancelling',
      'dispatch.draftHint',
      'dispatch.startFailed',
      'dispatch.cancelFailed',
      'dispatch.alreadySettled',
      'dispatch.showOutput',
      'dispatch.hideOutput',
      'teamCharter.button',
      'teamCharter.title',
      'teamCharter.subtitle',
      'teamCharter.placeholder',
      'teamCharter.loading',
      'teamCharter.loadFailed',
      'teamCharter.save',
      'teamCharter.saving',
      'teamCharter.saved',
      'teamCharter.tooLong',
      'teamCharter.saveFailed',
      'teamCharter.close',
      'teamCharter.cancel',
    ]
    for (const key of requiredPhase8Keys) {
      expect(en[key]).toBeTruthy()
      expect(zhCN[key]).toBeTruthy()
      expect({ key, names: placeholders(zhCN[key]) }).toEqual({ key, names: placeholders(en[key]) })
    }
    expect(en['panel.trigger.pipeline']).toBe('Pipeline')
    expect(zhCN['panel.trigger.pipeline']).toBe('流水线')
    expect(en['dispatch.label']).toBe('Dispatch pipeline')
    expect(zhCN['dispatch.label']).toBe('协作流水线')
    expect(en['teamCharter.button']).toBe('Team charter')
    expect(zhCN['teamCharter.button']).toBe('团队章程')
    expect(translate('en', 'dispatch.after', { deps: 's1, s2' })).toBe('After s1, s2')
    expect(translate('zh-CN', 'dispatch.after', { deps: 's1, s2' })).toBe('依赖 s1, s2')
    expect(translate('en', 'dispatch.wave', { wave: 2 })).toBe('Stage 2')
    expect(translate('zh-CN', 'dispatch.wave', { wave: 2 })).toBe('阶段 2')
    expect(translate('en', 'teamCharter.tooLong', { max: 16384 })).toBe('Team charter must be 16384 characters or fewer.')
    expect(translate('zh-CN', 'teamCharter.tooLong', { max: 16384 })).toBe('团队章程不能超过 16384 个字符。')
    expect(translate('en', 'sidebar.preview.dispatchPlan', { title: 'Q3 rollout' })).toBe('Pipeline: Q3 rollout')
    expect(translate('zh-CN', 'sidebar.preview.dispatchPlan', { title: 'Q3 发布' })).toBe('流水线：Q3 发布')
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

  it('syncs wiki from chats via POST /api/wiki/sync and surfaces ApiError and SignedOut', async () => {
    const syncRes: WikiSyncResponse = {
      ok: true,
      threadsSynced: 2,
      pagesCreated: 1,
      pagesUpdated: 1,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(syncRes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'LLM unavailable', code: 'sync_failed' }), { status: 500 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await syncWikiFromChats()).toEqual(syncRes)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/wiki/sync')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({})

    const syncErr = await syncWikiFromChats().catch((e: unknown) => e)
    expect(syncErr).toBeInstanceOf(ApiError)
    expect(syncErr).toMatchObject({ status: 500, code: 'sync_failed', message: 'LLM unavailable' })

    await expect(syncWikiFromChats()).rejects.toBeInstanceOf(SignedOut)
  })
})

describe('Proactive Quiet Digest & Rule Proposals API client', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const sampleSummary: QuietDigestSummary = {
    enabled: true,
    active: true,
    start: '22:00',
    end: '08:00',
    timeZone: 'Asia/Shanghai',
    pendingCount: 2,
    byBot: [{ botId: 'chief', count: 2, latestAt: 1700000000000 }],
  }

  const sampleFlush: QuietDigestFlushResponse = {
    flushed: 2,
    threads: ['dm:chief'],
  }

  const sampleProposal: RuleProposalView = {
    id: 7,
    botId: 'chief',
    threadId: 'dm:chief',
    rule: 'Do not send emails to promos@example.com unless explicitly asked',
    reason: 'You discarded 2 similar email requests for promos@example.com in the past 14 days.',
    source: 'discard_pattern',
    sourceTainted: false,
    status: 'pending',
    messageId: 91,
    createdAt: 1700000000000,
    resolvedAt: null,
  }

  it('fetches and flushes quiet digests, handling botId filter, ApiError, and SignedOut', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(sampleSummary), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sampleFlush), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sampleFlush), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unknown bot' }), { status: 404 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchQuietDigest()).toEqual(sampleSummary)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/quiet-digest')

    const summaryErr = await fetchQuietDigest().catch((e: unknown) => e)
    expect(summaryErr).toBeInstanceOf(ApiError)
    expect(summaryErr).toMatchObject({ status: 404, message: 'not found' })

    await expect(fetchQuietDigest()).rejects.toBeInstanceOf(SignedOut)

    expect(await flushQuietDigest()).toEqual(sampleFlush)
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/quiet-digest/flush')
    expect((fetchMock.mock.calls[3]![1] as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((fetchMock.mock.calls[3]![1] as RequestInit).body))).toEqual({})

    expect(await flushQuietDigest('chief')).toEqual(sampleFlush)
    expect(fetchMock.mock.calls[4]![0]).toBe('/api/quiet-digest/flush')
    expect(JSON.parse(String((fetchMock.mock.calls[4]![1] as RequestInit).body))).toEqual({ botId: 'chief' })

    const flushErr = await flushQuietDigest('missing').catch((e: unknown) => e)
    expect(flushErr).toBeInstanceOf(ApiError)
    expect(flushErr).toMatchObject({ status: 404, message: 'unknown bot' })

    await expect(flushQuietDigest()).rejects.toBeInstanceOf(SignedOut)
  })

  it('lists and resolves rule proposals with query params, optional edited rule, ApiError codes, and SignedOut', async () => {
    const acceptedResponse: ResolveRuleProposalResponse = {
      ok: true,
      proposal: { ...sampleProposal, status: 'accepted', rule: 'Edited standing rule', resolvedAt: 1700000100000 },
      memoryUpdated: true,
    }
    const dismissedResponse: ResolveRuleProposalResponse = {
      ok: true,
      proposal: { ...sampleProposal, status: 'dismissed', resolvedAt: 1700000200000 },
      memoryUpdated: false,
    }

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [sampleProposal] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [sampleProposal] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [sampleProposal] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid status' }), { status: 400 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(acceptedResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(acceptedResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(dismissedResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rule proposal already resolved', code: 'settled' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid rule', code: 'invalid_rule' }), { status: 400 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchRuleProposals()).toEqual({ proposals: [sampleProposal] })
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/rule-proposals')

    expect(await fetchRuleProposals({ botId: '   ' })).toEqual({ proposals: [sampleProposal] })
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/rule-proposals')

    expect(await fetchRuleProposals({ botId: 'chief', status: 'pending' })).toEqual({ proposals: [sampleProposal] })
    const url = new URL(String(fetchMock.mock.calls[2]![0]), 'http://localhost')
    expect(url.pathname).toBe('/api/rule-proposals')
    expect(url.searchParams.get('botId')).toBe('chief')
    expect(url.searchParams.get('status')).toBe('pending')

    const listErr = await fetchRuleProposals().catch((e: unknown) => e)
    expect(listErr).toBeInstanceOf(ApiError)
    expect(listErr).toMatchObject({ status: 400, message: 'invalid status' })

    await expect(fetchRuleProposals()).rejects.toBeInstanceOf(SignedOut)

    expect(await resolveRuleProposal(7, 'accept')).toEqual(acceptedResponse)
    expect(fetchMock.mock.calls[5]![0]).toBe('/api/rule-proposals/7')
    expect((fetchMock.mock.calls[5]![1] as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((fetchMock.mock.calls[5]![1] as RequestInit).body))).toEqual({ decision: 'accept' })

    expect(await resolveRuleProposal(7, 'accept', 'Edited standing rule')).toEqual(acceptedResponse)
    expect(JSON.parse(String((fetchMock.mock.calls[6]![1] as RequestInit).body))).toEqual({
      decision: 'accept',
      rule: 'Edited standing rule',
    })

    // Dismiss must omit rule even if a caller passes one
    expect(await resolveRuleProposal(7, 'dismiss', 'ignored text')).toEqual(dismissedResponse)
    expect(JSON.parse(String((fetchMock.mock.calls[7]![1] as RequestInit).body))).toEqual({ decision: 'dismiss' })

    const settledErr = await resolveRuleProposal(7, 'accept').catch((e: unknown) => e)
    expect(settledErr).toBeInstanceOf(ApiError)
    expect(settledErr).toMatchObject({ status: 409, code: 'settled' })

    const invalidErr = await resolveRuleProposal(7, 'accept', '').catch((e: unknown) => e)
    expect(invalidErr).toBeInstanceOf(ApiError)
    expect(invalidErr).toMatchObject({ status: 400, code: 'invalid_rule' })

    await expect(resolveRuleProposal(7, 'dismiss')).rejects.toBeInstanceOf(SignedOut)

    // Verify Phase 5 extended types compile and match gateway shapes
    const mode: RoutineMode = 'prepare'
    const digestPayload: QuietDigestPayload = {
      windowStart: '22:00',
      windowEnd: '08:00',
      itemCount: 1,
      items: [{
        id: 1,
        routineId: 10,
        routineName: 'Morning prep',
        routineMode: mode,
        kind: 'text',
        summary: 'Brief ready',
        text: 'Brief ready',
        createdAt: 1700000000000,
      }],
      flushedManually: true,
    }
    const proposalPayload: RuleProposalPayload = {
      proposalId: 7,
      rule: sampleProposal.rule,
      reason: sampleProposal.reason,
      source: 'dreaming',
      sourceTainted: true,
      status: 'pending',
    }
    const digestMsg: Message = {
      id: 100,
      thread_id: 'dm:chief',
      sender: 'chief',
      kind: 'quiet_digest',
      content: '',
      payload: digestPayload,
      created_at: 1700000000000,
    }
    const proposalMsg: Message = {
      id: 101,
      thread_id: 'dm:chief',
      sender: 'chief',
      kind: 'rule_proposal',
      content: '',
      payload: proposalPayload,
      created_at: 1700000000000,
    }
    const ev: GatewayEvent = { type: 'quiet_digest_changed' }
    const settingsMinimal: SettingsView['values'] = {
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-5',
      vision: true,
      language: 'en',
      computers: 'auto',
      browserMirror: '',
      checkUpdates: true,
    }
    const settingsQuiet: SettingsView['values'] = {
      ...settingsMinimal,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
    }
    expect(digestMsg.kind).toBe('quiet_digest')
    expect(proposalMsg.kind).toBe('rule_proposal')
    expect(ev.type).toBe('quiet_digest_changed')
    expect(settingsQuiet.quietHoursEnabled).toBe(true)
  })
})

describe('Local LLM Queue API client', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('fetches GET /api/llm-queue and throws ApiError on failure and SignedOut on 401', async () => {
    const priority: LlmPriority = 'interactive'
    const endpoint: LlmQueueEndpointView = {
      key: 'local:loopback:11434',
      active: 1,
      queued: 2,
      byPriority: { interactive: 1, background: 0, routine: 1, low: 0 },
    }
    const snapshot: LlmQueueSnapshot = {
      concurrency: 1,
      endpoints: [endpoint],
    }

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchLlmQueue()).toEqual(snapshot)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/llm-queue')

    const notFoundErr = await fetchLlmQueue().catch((e: unknown) => e)
    expect(notFoundErr).toBeInstanceOf(ApiError)
    expect(notFoundErr).toMatchObject({ status: 404, message: 'not found' })

    await expect(fetchLlmQueue()).rejects.toBeInstanceOf(SignedOut)

    const settingsWithLocalConcurrency: SettingsView['values'] = {
      provider: 'ollama',
      baseURL: 'http://localhost:11434/v1',
      model: 'qwen3:8b',
      vision: false,
      language: 'en',
      computers: 'local',
      browserMirror: '',
      checkUpdates: true,
      localLlmConcurrency: 2,
    }
    expect(priority).toBe('interactive')
    expect(settingsWithLocalConcurrency.localLlmConcurrency).toBe(2)
  })
})

describe('Background Tasks API client', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const sampleTask: BackgroundTaskView = {
    id: 'bg-a1b2c3d4',
    botId: 'inbox keeper',
    threadId: 'dm:inbox keeper',
    title: 'Compile Q3 pricing matrix',
    instructions: 'Check top 3 competitors',
    status: 'running',
    stepCount: 2,
    lastStep: 'browser_extract: pricing table',
    steps: [
      { tool: 'browser_goto', summary: 'https://competitor.example', ok: true, ms: 300, at: 1000 },
      { tool: 'browser_extract', summary: 'pricing table', ok: true, ms: 500, at: 2000 },
    ],
    summary: '',
    error: '',
    usesBrowser: true,
    messageId: 44,
    createdAt: 1000,
    startedAt: 1050,
    finishedAt: null,
  }

  it('fetches, steers, and cancels background tasks with URL encoding, strict ApiError codes, and SignedOut', async () => {
    const steeredRes: BackgroundTaskActionResponse = {
      ok: true,
      task: {
        ...sampleTask,
        lastStep: 'steer: Focus on enterprise',
        steps: [...sampleTask.steps, { tool: 'steer', summary: 'Focus on enterprise', ok: true, at: 3000 }],
      },
    }
    const cancelledRes: BackgroundTaskActionResponse = {
      ok: true,
      task: { ...sampleTask, status: 'cancelled', finishedAt: 4000 },
    }

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tasks: [sampleTask] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unknown bot' }), { status: 404 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(steeredRes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Steering note must be 1–1000 characters.', code: 'invalid_note' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Background task bg-a1b2c3d4 is already completed.', code: 'settled' }), { status: 409 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(cancelledRes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Background task bg-missing not found.', code: 'not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Background task bg-a1b2c3d4 is already cancelled.', code: 'settled' }), { status: 409 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    // fetchBackgroundTasks
    expect(await fetchBackgroundTasks('inbox keeper')).toEqual({ tasks: [sampleTask] })
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/bots/inbox%20keeper/background-tasks')

    const listErr = await fetchBackgroundTasks('missing').catch((e: unknown) => e)
    expect(listErr).toBeInstanceOf(ApiError)
    expect(listErr).toMatchObject({ status: 404, message: 'unknown bot' })

    await expect(fetchBackgroundTasks('researcher')).rejects.toBeInstanceOf(SignedOut)

    // steerBackgroundTask
    expect(await steerBackgroundTask('bg/a1', 'Focus on enterprise')).toEqual(steeredRes)
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/background-tasks/bg%2Fa1/steer')
    expect((fetchMock.mock.calls[3]![1] as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((fetchMock.mock.calls[3]![1] as RequestInit).body))).toEqual({ note: 'Focus on enterprise' })

    const invalidNoteErr = await steerBackgroundTask('bg-a1b2c3d4', '').catch((e: unknown) => e)
    expect(invalidNoteErr).toBeInstanceOf(ApiError)
    expect(invalidNoteErr).toMatchObject({ status: 400, code: 'invalid_note' })

    const steerSettledErr = await steerBackgroundTask('bg-a1b2c3d4', 'Too late').catch((e: unknown) => e)
    expect(steerSettledErr).toBeInstanceOf(ApiError)
    expect(steerSettledErr).toMatchObject({ status: 409, code: 'settled' })

    await expect(steerBackgroundTask('bg-a1b2c3d4', 'Note')).rejects.toBeInstanceOf(SignedOut)

    // cancelBackgroundTask
    expect(await cancelBackgroundTask('bg/a1')).toEqual(cancelledRes)
    expect(fetchMock.mock.calls[7]![0]).toBe('/api/background-tasks/bg%2Fa1/cancel')
    expect((fetchMock.mock.calls[7]![1] as RequestInit).method).toBe('POST')

    const cancelMissingErr = await cancelBackgroundTask('bg-missing').catch((e: unknown) => e)
    expect(cancelMissingErr).toBeInstanceOf(ApiError)
    expect(cancelMissingErr).toMatchObject({ status: 404, code: 'not_found' })

    const cancelSettledErr = await cancelBackgroundTask('bg-a1b2c3d4').catch((e: unknown) => e)
    expect(cancelSettledErr).toBeInstanceOf(ApiError)
    expect(cancelSettledErr).toMatchObject({ status: 409, code: 'settled' })

    await expect(cancelBackgroundTask('bg-a1b2c3d4')).rejects.toBeInstanceOf(SignedOut)

    // Verify Phase 7 types compile and match gateway contracts
    const status: BackgroundTaskStatus = 'running'
    const payload: BackgroundTaskPayload = {
      taskId: sampleTask.id,
      title: sampleTask.title,
      status,
      stepCount: sampleTask.stepCount,
      lastStep: sampleTask.lastStep,
      steps: sampleTask.steps,
      usesBrowser: sampleTask.usesBrowser,
      createdAt: sampleTask.createdAt,
      startedAt: sampleTask.startedAt,
      finishedAt: sampleTask.finishedAt,
    }
    const msg: Message = {
      id: 44,
      thread_id: sampleTask.threadId,
      sender: sampleTask.botId,
      kind: 'background_task',
      content: '',
      payload,
      created_at: 1000,
    }
    const approval: ApprovalPayload = {
      approvalId: 1,
      action: 'send report',
      status: 'pending',
      ruleHeld: 'background',
    }
    const ev: GatewayEvent = { type: 'background_task_changed', botId: sampleTask.botId, task: sampleTask }
    const comp: ComputerInfo = {
      botId: sampleTask.botId,
      running: true,
      vncUrl: null,
      routines: [],
      backgroundTasks: [sampleTask],
    }
    expect(msg.kind).toBe('background_task')
    expect(approval.ruleHeld).toBe('background')
    expect(ev.type).toBe('background_task_changed')
    expect(comp.backgroundTasks).toHaveLength(1)
  })
})

describe('Team Charter & Dispatch Plans API client', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const sampleCharter: TeamCharterView = {
    threadId: 'group:offsite crew',
    content: '- Scout researches first.',
    updatedAt: 1000,
  }

  const samplePlan: DispatchPlanView = {
    id: 'dp-a1b2c3d4',
    threadId: 'group:offsite crew',
    createdBy: 'chief',
    title: 'Q3 pricing & outreach',
    status: 'draft',
    sourceTainted: false,
    messageId: 88,
    error: '',
    steps: [
      {
        id: 's1',
        seq: 0,
        wave: 0,
        botId: 'researcher',
        title: 'Gather facts',
        instructions: 'Write findings to team wiki',
        dependsOn: [],
        status: 'pending',
        output: '',
        error: '',
        outputTainted: false,
        waitingApprovalId: null,
        waitingQuestionId: null,
        startedAt: null,
        finishedAt: null,
      },
    ],
    createdAt: 1000,
    startedAt: null,
    finishedAt: null,
  }

  it('fetches/saves team charter and fetches/starts/cancels dispatch plans with URL encoding, strict ApiError codes, and SignedOut', async () => {
    const startedRes: DispatchPlanActionResponse = {
      ok: true,
      plan: { ...samplePlan, status: 'running', startedAt: 2000 },
    }
    const cancelledRes: DispatchPlanActionResponse = {
      ok: true,
      plan: { ...samplePlan, status: 'cancelled', finishedAt: 3000 },
    }

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(sampleCharter), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unknown group thread' }), { status: 404 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...sampleCharter, content: 'Updated charter', updatedAt: 2000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'too long', code: 'invalid_content' }), { status: 400 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ plans: [samplePlan] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unknown group thread' }), { status: 404 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(startedRes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not draft', code: 'invalid_state' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'missing', code: 'not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(cancelledRes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'already done', code: 'settled' }), { status: 409 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    // fetchTeamCharter
    expect(await fetchTeamCharter('group:offsite crew')).toEqual(sampleCharter)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/threads/group%3Aoffsite%20crew/team')

    const charter404 = await fetchTeamCharter('dm:scout').catch((e: unknown) => e)
    expect(charter404).toBeInstanceOf(ApiError)
    expect(charter404).toMatchObject({ status: 404, message: 'unknown group thread' })
    await expect(fetchTeamCharter('group:x')).rejects.toBeInstanceOf(SignedOut)

    // saveTeamCharter
    expect(await saveTeamCharter('group:offsite crew', 'Updated charter')).toEqual({
      ...sampleCharter,
      content: 'Updated charter',
      updatedAt: 2000,
    })
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/threads/group%3Aoffsite%20crew/team')
    expect((fetchMock.mock.calls[3]![1] as RequestInit).method).toBe('PUT')
    expect(JSON.parse(String((fetchMock.mock.calls[3]![1] as RequestInit).body))).toEqual({ content: 'Updated charter' })

    const charter400 = await saveTeamCharter('group:offsite crew', 'x'.repeat(20000)).catch((e: unknown) => e)
    expect(charter400).toBeInstanceOf(ApiError)
    expect(charter400).toMatchObject({ status: 400, code: 'invalid_content' })
    await expect(saveTeamCharter('group:x', 'ok')).rejects.toBeInstanceOf(SignedOut)

    // fetchDispatchPlans
    expect(await fetchDispatchPlans('group:offsite crew')).toEqual({ plans: [samplePlan] })
    expect(fetchMock.mock.calls[6]![0]).toBe('/api/threads/group%3Aoffsite%20crew/dispatch-plans')

    const plans404 = await fetchDispatchPlans('dm:scout').catch((e: unknown) => e)
    expect(plans404).toBeInstanceOf(ApiError)
    expect(plans404).toMatchObject({ status: 404 })
    await expect(fetchDispatchPlans('group:x')).rejects.toBeInstanceOf(SignedOut)

    // startDispatchPlan
    expect(await startDispatchPlan('dp/a1')).toEqual(startedRes)
    expect(fetchMock.mock.calls[9]![0]).toBe('/api/dispatch-plans/dp%2Fa1/start')
    expect((fetchMock.mock.calls[9]![1] as RequestInit).method).toBe('POST')

    const start409 = await startDispatchPlan('dp-a1b2c3d4').catch((e: unknown) => e)
    expect(start409).toBeInstanceOf(ApiError)
    expect(start409).toMatchObject({ status: 409, code: 'invalid_state' })

    const start404 = await startDispatchPlan('dp-missing').catch((e: unknown) => e)
    expect(start404).toBeInstanceOf(ApiError)
    expect(start404).toMatchObject({ status: 404, code: 'not_found' })
    await expect(startDispatchPlan('dp-a1b2c3d4')).rejects.toBeInstanceOf(SignedOut)

    // cancelDispatchPlan
    expect(await cancelDispatchPlan('dp/a1')).toEqual(cancelledRes)
    expect(fetchMock.mock.calls[13]![0]).toBe('/api/dispatch-plans/dp%2Fa1/cancel')
    expect((fetchMock.mock.calls[13]![1] as RequestInit).method).toBe('POST')

    const cancel409 = await cancelDispatchPlan('dp-a1b2c3d4').catch((e: unknown) => e)
    expect(cancel409).toBeInstanceOf(ApiError)
    expect(cancel409).toMatchObject({ status: 409, code: 'settled' })
    await expect(cancelDispatchPlan('dp-a1b2c3d4')).rejects.toBeInstanceOf(SignedOut)

    // Verify Phase 8 types compile and match gateway contracts
    const planStatus: DispatchPlanStatus = 'paused'
    const stepStatus: DispatchStepStatus = 'waiting_approval'
    const payload: DispatchPlanPayload = {
      planId: samplePlan.id,
      threadId: samplePlan.threadId,
      createdBy: samplePlan.createdBy,
      title: samplePlan.title,
      status: planStatus,
      sourceTainted: false,
      error: '',
      steps: [{ ...samplePlan.steps[0]!, status: stepStatus }],
      createdAt: samplePlan.createdAt,
      startedAt: null,
      finishedAt: null,
    }
    const msg: Message = {
      id: 88,
      thread_id: samplePlan.threadId,
      sender: 'chief',
      kind: 'dispatch_plan',
      content: '',
      payload,
      created_at: 1000,
    }
    const ev1: GatewayEvent = { type: 'dispatch_plan_changed', threadId: samplePlan.threadId, plan: samplePlan }
    const ev2: GatewayEvent = { type: 'team_charter_changed', threadId: samplePlan.threadId }
    expect(msg.kind).toBe('dispatch_plan')
    expect(ev1.type).toBe('dispatch_plan_changed')
    expect(ev2.type).toBe('team_charter_changed')
  })
})
