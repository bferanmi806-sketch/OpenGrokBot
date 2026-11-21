import { describe, expect, it } from 'vitest'
import {
  MAX_DETAIL_BODY_CHARS,
  MAX_EDITABLE_SCHEMA_BYTES,
  MAX_EDIT_ACTION_CHARS,
  MAX_EDIT_TEXT_CHARS,
  MAX_EMAIL_ADDRESS_CHARS,
  MAX_EMAIL_LIST_LENGTH,
  MAX_MCP_ARGS_BYTES,
  applyApprovalEdit,
  buildConnectorEditable,
  buildMcpEditable,
  buildPromptEditable,
  formatMcpWriteApprovalDetail,
} from '../src/approval-edit.js'
import {
  canRemember,
  createApproval,
  getApproval,
  resolveApproval,
  type ApprovalRow,
} from '../src/approvals.js'
import type { FrozenExecution, ResolvedDraftSnapshot } from '../src/connectors/types.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { FrozenMcpExecution } from '../src/mcp/types.js'

function makeApprovalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: 1,
    thread_id: 'dm:inbox-keeper',
    bot_id: 'inbox-keeper',
    action: 'Send email via me@acme.com to bob@acme.com',
    detail: 'Account: Gmail · me@acme.com (conn-1)\nTo: bob@acme.com\nSubject: Hello\n\nHi Bob',
    kind: 'email',
    target: 'bob@acme.com',
    status: 'pending',
    message_id: 10,
    rule_id: null,
    created_at: 1_700_000_000_000,
    resolved_at: null,
    items: null,
    approved_items: null,
    workflow_run_id: null,
    execution_json: null,
    execution_status: null,
    execution_detail: null,
    operation_id: null,
    ...overrides,
  }
}

function makeFrozenConnector(overrides: Partial<FrozenExecution> = {}): FrozenExecution {
  return {
    version: 1,
    connectorId: 'conn-1',
    remoteId: 'remote-1',
    app: 'gmail',
    accountLabel: 'me@acme.com',
    tool: 'mail_send',
    args: {
      to: ['bob@acme.com'],
      subject: 'Hello',
      body: 'Hi Bob',
    },
    operationId: 'op-1',
    ...overrides,
  }
}

function makeFrozenMcp(overrides: Partial<FrozenMcpExecution> = {}): FrozenMcpExecution {
  return {
    kind: 'mcp',
    operationId: 'op-mcp-1',
    serverId: 'srv-1',
    serverName: 'Linear',
    serverSlug: 'linear',
    toolName: 'create_issue',
    exposedToolName: 'mcp__linear__create_issue',
    args: { title: 'Fix bug', priority: 2 },
    ...overrides,
  }
}

describe('projection builders', () => {
  describe('buildConnectorEditable', () => {
    it('builds mail_send inline editable preserving full un-truncated body up to limit', () => {
      const longBody = 'a'.repeat(MAX_DETAIL_BODY_CHARS + 500)
      const frozen = makeFrozenConnector({
        args: { to: ['bob@acme.com'], cc: ['carol@acme.com'], subject: 'Update', body: longBody },
      })
      expect(buildConnectorEditable(frozen)).toEqual({
        kind: 'connector',
        tool: 'mail_send',
        accountLabel: 'me@acme.com',
        to: ['bob@acme.com'],
        cc: ['carol@acme.com'],
        bcc: [],
        subject: 'Update',
        body: longBody,
      })
    })

    it('returns undefined for mail_send inline when body exceeds limit or required fields missing', () => {
      expect(
        buildConnectorEditable(
          makeFrozenConnector({
            args: { to: ['bob@acme.com'], subject: 'S', body: 'x'.repeat(MAX_EDIT_TEXT_CHARS + 1) },
          }),
        ),
      ).toBeUndefined()
      expect(buildConnectorEditable(makeFrozenConnector({ args: { to: [], subject: 'S', body: 'B' } }))).toBeUndefined()
    })

    it('builds mail_send draftId editable from resolvedDraftSnapshot and returns undefined if snapshot missing', () => {
      const snap: ResolvedDraftSnapshot = {
        to: ['bob@acme.com'],
        cc: ['carol@acme.com'],
        bcc: ['dave@acme.com'],
        subject: 'Draft subject',
        body: 'Draft body',
      }
      const frozen = makeFrozenConnector({
        args: { draftId: 'draft-42' },
        resolvedDraftSnapshot: snap,
      })
      expect(buildConnectorEditable(frozen)).toEqual({
        kind: 'connector',
        tool: 'mail_send',
        accountLabel: 'me@acme.com',
        draftId: 'draft-42',
        ...snap,
      })

      const legacyDraft = makeFrozenConnector({ args: { draftId: 'draft-42' } })
      expect(buildConnectorEditable(legacyDraft)).toBeUndefined()
    })

    it('builds mail_reply editable from replyMeta and returns undefined when replyMeta is missing', () => {
      const frozen = makeFrozenConnector({
        tool: 'mail_reply',
        args: { messageId: 'msg-1', body: 'Thanks!', replyAll: false },
        replyMeta: {
          to: ['Alice <alice@acme.com>'],
          allCc: ['bob@acme.com'],
          subject: 'Re: Plan',
          threadId: 'thr-1',
        },
      })
      expect(buildConnectorEditable(frozen)).toEqual({
        kind: 'connector',
        tool: 'mail_reply',
        accountLabel: 'me@acme.com',
        to: ['Alice <alice@acme.com>'],
        replyAllCc: ['bob@acme.com'],
        subject: 'Re: Plan',
        body: 'Thanks!',
        replyAll: false,
      })

      const legacyReply = makeFrozenConnector({
        tool: 'mail_reply',
        args: { messageId: 'msg-1', body: 'Thanks!' },
      })
      expect(buildConnectorEditable(legacyReply)).toBeUndefined()
    })

    it('builds slack_send_message, notion_create_page, notion_append, calendar_create_event, calendar_update_event', () => {
      expect(
        buildConnectorEditable(
          makeFrozenConnector({
            app: 'slack',
            accountLabel: 'Acme Slack',
            tool: 'slack_send_message',
            args: { channelId: 'C123', text: 'Hello team', threadTs: '1700.0001' },
          }),
        ),
      ).toEqual({
        kind: 'connector',
        tool: 'slack_send_message',
        accountLabel: 'Acme Slack',
        channelId: 'C123',
        threadTs: '1700.0001',
        text: 'Hello team',
      })

      expect(
        buildConnectorEditable(
          makeFrozenConnector({
            app: 'notion',
            accountLabel: 'Acme Wiki',
            tool: 'notion_create_page',
            args: { parentPageId: 'page-parent', title: 'Notes', markdown: '# Heading' },
          }),
        ),
      ).toEqual({
        kind: 'connector',
        tool: 'notion_create_page',
        accountLabel: 'Acme Wiki',
        parentPageId: 'page-parent',
        title: 'Notes',
        markdown: '# Heading',
      })

      expect(
        buildConnectorEditable(
          makeFrozenConnector({
            app: 'notion',
            accountLabel: 'Acme Wiki',
            tool: 'notion_append',
            args: { pageId: 'page-1', markdown: '- item' },
          }),
        ),
      ).toEqual({
        kind: 'connector',
        tool: 'notion_append',
        accountLabel: 'Acme Wiki',
        pageId: 'page-1',
        markdown: '- item',
      })

      expect(
        buildConnectorEditable(
          makeFrozenConnector({
            app: 'google_calendar',
            accountLabel: 'me@acme.com',
            tool: 'calendar_create_event',
            args: { title: 'Sync', start: '2026-11-22T10:00:00Z', end: '2026-11-22T10:30:00Z' },
          }),
        ),
      ).toEqual({
        kind: 'connector',
        tool: 'calendar_create_event',
        accountLabel: 'me@acme.com',
        title: 'Sync',
        start: '2026-11-22T10:00:00Z',
        end: '2026-11-22T10:30:00Z',
        location: '',
        attendees: [],
        description: '',
      })

      expect(
        buildConnectorEditable(
          makeFrozenConnector({
            app: 'google_calendar',
            accountLabel: 'me@acme.com',
            tool: 'calendar_update_event',
            args: { eventId: 'evt-9', location: '', attendees: [], description: '' },
          }),
        ),
      ).toEqual({
        kind: 'connector',
        tool: 'calendar_update_event',
        accountLabel: 'me@acme.com',
        eventId: 'evt-9',
        location: '',
        attendees: [],
        description: '',
      })
    })

    it('returns undefined for mail_archive and empty calendar_update_event', () => {
      expect(
        buildConnectorEditable(
          makeFrozenConnector({
            tool: 'mail_archive',
            args: { messageId: 'msg-9' },
          }),
        ),
      ).toBeUndefined()

      expect(
        buildConnectorEditable(
          makeFrozenConnector({
            app: 'google_calendar',
            tool: 'calendar_update_event',
            args: { eventId: 'evt-9' },
          }),
        ),
      ).toBeUndefined()
    })
  })

  describe('buildMcpEditable', () => {
    it('clones args safely and includes compact inputSchema <= 32KB', () => {
      const frozen = makeFrozenMcp({ args: { nested: { a: 1 }, tags: ['p1'] } })
      const schema = {
        type: 'object',
        properties: { title: { type: 'string' } },
      }
      const editable = buildMcpEditable(frozen, schema)
      expect(editable).toEqual({
        kind: 'mcp',
        serverName: 'Linear',
        toolName: 'create_issue',
        args: { nested: { a: 1 }, tags: ['p1'] },
        inputSchema: schema,
      })
      ;(editable.args.nested as { a: number }).a = 999
      expect((frozen.args.nested as { a: number }).a).toBe(1)
    })

    it('omits inputSchema when serialized length exceeds 32,768 bytes and keeps it at the exact limit', () => {
      const frozen = makeFrozenMcp()
      const wrapper = JSON.stringify({ type: 'object', description: '' })
      const exactPad = MAX_EDITABLE_SCHEMA_BYTES - wrapper.length
      const exactSchema = { type: 'object', description: 'x'.repeat(exactPad) }
      expect(JSON.stringify(exactSchema).length).toBe(MAX_EDITABLE_SCHEMA_BYTES)
      expect(buildMcpEditable(frozen, exactSchema).inputSchema).toEqual(exactSchema)

      const oversizedSchema = { type: 'object', description: 'x'.repeat(exactPad + 1) }
      expect(JSON.stringify(oversizedSchema).length).toBe(MAX_EDITABLE_SCHEMA_BYTES + 1)
      expect(buildMcpEditable(frozen, oversizedSchema).inputSchema).toBeUndefined()
    })
  })

  describe('buildPromptEditable', () => {
    it('returns prompt editable shape', () => {
      expect(buildPromptEditable('Post tweet', 'Hello world')).toEqual({
        kind: 'prompt',
        action: 'Post tweet',
        detail: 'Hello world',
      })
    })
  })
})

describe('applyApprovalEdit — connector tools', () => {
  it('applies inline mail_send edit, recomputes target/action/detail, and detects no-op', () => {
    const frozen = makeFrozenConnector({
      args: { to: ['Bob <bob@acme.com>'], subject: 'Hello', body: 'Hi Bob' },
    })
    const originalDetail =
      'Account: Gmail · me@acme.com (conn-1)\nTo: Bob <bob@acme.com>\nSubject: Hello\n\nHi Bob'
    const row = makeApprovalRow({
      action: 'Send email via me@acme.com to Bob <bob@acme.com>',
      detail: originalDetail,
      target: 'bob@acme.com',
      execution_json: JSON.stringify(frozen),
    })

    // No-op edit
    const noop = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'mail_send',
      to: ['Bob <bob@acme.com>'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: 'Hi Bob',
    })
    expect(noop.ok).toBe(true)
    if (!noop.ok) return
    expect(noop.applied.changed).toBe(false)
    expect(noop.applied.action).toBe(row.action)
    expect(noop.applied.detail).toBe(originalDetail)
    expect(noop.applied.target).toBe('bob@acme.com')

    // Real edit adding CC (making target multi-recipient -> not rememberable)
    const edited = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'mail_send',
      to: ['alice@acme.com'],
      cc: ['bob@acme.com'],
      bcc: ['audit@acme.com'],
      subject: 'Updated subject',
      body: 'Updated body',
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.applied.changed).toBe(true)
    expect(edited.applied.action).toBe('Send email via me@acme.com to alice@acme.com')
    expect(edited.applied.detail).toBe(
      'Account: Gmail · me@acme.com (conn-1)\nTo: alice@acme.com\nCc: bob@acme.com\nBcc: audit@acme.com\nSubject: Updated subject\n\nUpdated body',
    )
    expect(edited.applied.target).toBe('alice@acme.com, bob@acme.com, audit@acme.com')
    expect(canRemember({ kind: 'email', target: edited.applied.target })).toBe(false)
    const nextFrozen = JSON.parse(edited.applied.executionJson!) as FrozenExecution
    expect(nextFrozen.args).toEqual({
      to: ['alice@acme.com'],
      cc: ['bob@acme.com'],
      bcc: ['audit@acme.com'],
      subject: 'Updated subject',
      body: 'Updated body',
    })
  })

  it('truncates mail_send detail at 4,000 chars while keeping full body in executionJson & editable', () => {
    const frozen = makeFrozenConnector()
    const row = makeApprovalRow({ execution_json: JSON.stringify(frozen) })
    const longBody = 'Z'.repeat(MAX_DETAIL_BODY_CHARS + 250)
    const res = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'mail_send',
      to: ['bob@acme.com'],
      subject: 'Long',
      body: longBody,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.applied.detail).toContain(`${'Z'.repeat(MAX_DETAIL_BODY_CHARS)}\n…(truncated)`)
    const nextFrozen = JSON.parse(res.applied.executionJson!) as FrozenExecution
    expect(nextFrozen.args.body).toBe(longBody)
    expect(res.applied.editable.kind === 'connector' && res.applied.editable.tool === 'mail_send' && res.applied.editable.body).toBe(longBody)
  })

  it('applies mail_send draftId edit with TOCTOU snapshot separation and draftUpdate', () => {
    const origSnap: ResolvedDraftSnapshot = {
      to: ['bob@acme.com'],
      cc: ['carol@acme.com'],
      bcc: [],
      subject: 'Draft subj',
      body: 'Draft body',
    }
    const frozen = makeFrozenConnector({
      args: { draftId: 'draft-7' },
      resolvedDraftSnapshot: origSnap,
    })
    const originalDetail =
      'Account: Gmail · me@acme.com (conn-1)\nDraft: draft-7\nTo: bob@acme.com\nCc: carol@acme.com\nSubject: Draft subj\n\nDraft body'
    const row = makeApprovalRow({
      action: 'Send email via me@acme.com to bob@acme.com',
      detail: originalDetail,
      target: 'bob@acme.com, carol@acme.com',
      execution_json: JSON.stringify(frozen),
    })

    // No-op returns changed: false and draftUpdate: undefined
    const noop = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'mail_send',
      to: ['bob@acme.com'],
      cc: ['carol@acme.com'],
      bcc: [],
      subject: 'Draft subj',
      body: 'Draft body',
    })
    expect(noop.ok).toBe(true)
    if (!noop.ok) return
    expect(noop.applied.changed).toBe(false)
    expect(noop.applied.draftUpdate).toBeUndefined()
    expect(noop.applied.draftToctouSnapshot).toEqual(origSnap)
    expect(noop.applied.detail).toBe(originalDetail)

    // Edit clears CC and changes body -> single recipient target, keeps args: { draftId }
    const edited = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'mail_send',
      to: ['bob@acme.com'],
      cc: [],
      bcc: [],
      subject: 'Draft subj (final)',
      body: 'Edited draft body',
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.applied.changed).toBe(true)
    expect(edited.applied.draftToctouSnapshot).toEqual(origSnap)
    expect(edited.applied.draftUpdate).toEqual({
      draftId: 'draft-7',
      to: ['bob@acme.com'],
      cc: [],
      bcc: [],
      subject: 'Draft subj (final)',
      body: 'Edited draft body',
    })
    expect(edited.applied.target).toBe('bob@acme.com')
    expect(edited.applied.detail).toBe(
      'Account: Gmail · me@acme.com (conn-1)\nDraft: draft-7\nTo: bob@acme.com\nSubject: Draft subj (final)\n\nEdited draft body',
    )
    const nextFrozen = JSON.parse(edited.applied.executionJson!) as FrozenExecution
    expect(nextFrozen.args).toEqual({ draftId: 'draft-7' })
    expect(nextFrozen.resolvedDraftSnapshot).toEqual({
      to: ['bob@acme.com'],
      cc: [],
      bcc: [],
      subject: 'Draft subj (final)',
      body: 'Edited draft body',
    })
  })

  it('rejects editing draftId mail_send when resolvedDraftSnapshot is missing', () => {
    const frozen = makeFrozenConnector({ args: { draftId: 'draft-missing' } })
    const row = makeApprovalRow({ execution_json: JSON.stringify(frozen) })
    const res = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'mail_send',
      to: ['bob@acme.com'],
      subject: 'Subj',
      body: 'Body',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/snapshot/i)
  })

  it('applies mail_reply edit toggling replyAll false -> true and true -> false', () => {
    const frozenFalse = makeFrozenConnector({
      tool: 'mail_reply',
      args: { messageId: 'msg-55', body: 'Initial reply' },
      replyMeta: {
        to: ['Alice <alice@acme.com>'],
        allCc: ['Bob <bob@acme.com>', 'carol@acme.com'],
        subject: 'Re: Q4 Review',
        threadId: 'thr-55',
      },
    })
    const detailFalse =
      'Account: Gmail · me@acme.com (conn-1)\nIn-Reply-To: msg-55 (thread thr-55)\nTo: Alice <alice@acme.com>\nSubject: Re: Q4 Review\n\nInitial reply'
    const rowFalse = makeApprovalRow({
      action: 'Reply via me@acme.com to Alice <alice@acme.com>',
      detail: detailFalse,
      target: 'alice@acme.com',
      execution_json: JSON.stringify(frozenFalse),
    })

    // No-op matches exactly
    const noop = applyApprovalEdit(rowFalse, {
      kind: 'connector',
      tool: 'mail_reply',
      body: 'Initial reply',
      replyAll: false,
    })
    expect(noop.ok).toBe(true)
    if (!noop.ok) return
    expect(noop.applied.changed).toBe(false)
    expect(noop.applied.action).toBe(rowFalse.action)
    expect(noop.applied.detail).toBe(detailFalse)
    expect(noop.applied.target).toBe('alice@acme.com')

    // Toggle false -> true
    const toAll = applyApprovalEdit(rowFalse, {
      kind: 'connector',
      tool: 'mail_reply',
      body: 'Looping everyone in.',
      replyAll: true,
    })
    expect(toAll.ok).toBe(true)
    if (!toAll.ok) return
    expect(toAll.applied.changed).toBe(true)
    expect(toAll.applied.action).toBe(
      'Reply via me@acme.com to Alice <alice@acme.com>, Bob <bob@acme.com>, carol@acme.com',
    )
    expect(toAll.applied.detail).toBe(
      'Account: Gmail · me@acme.com (conn-1)\nIn-Reply-To: msg-55 (thread thr-55)\nTo: Alice <alice@acme.com>\nCc: Bob <bob@acme.com>, carol@acme.com\nSubject: Re: Q4 Review\n\nLooping everyone in.',
    )
    expect(toAll.applied.target).toBe('alice <alice@acme.com>, bob <bob@acme.com>, carol@acme.com')
    expect(canRemember({ kind: 'email', target: toAll.applied.target })).toBe(false)
    const nextFrozenAll = JSON.parse(toAll.applied.executionJson!) as FrozenExecution
    expect(nextFrozenAll.args).toEqual({
      messageId: 'msg-55',
      body: 'Looping everyone in.',
      replyAll: true,
    })

    // Toggle true -> false
    const rowTrue = makeApprovalRow({
      action: toAll.applied.action,
      detail: toAll.applied.detail,
      target: toAll.applied.target,
      execution_json: toAll.applied.executionJson!,
    })
    const backToSingle = applyApprovalEdit(rowTrue, {
      kind: 'connector',
      tool: 'mail_reply',
      body: 'Just to Alice.',
      replyAll: false,
    })
    expect(backToSingle.ok).toBe(true)
    if (!backToSingle.ok) return
    expect(backToSingle.applied.changed).toBe(true)
    expect(backToSingle.applied.action).toBe('Reply via me@acme.com to Alice <alice@acme.com>')
    expect(backToSingle.applied.detail).not.toContain('\nCc:')
    expect(backToSingle.applied.target).toBe('alice@acme.com')
    expect(canRemember({ kind: 'email', target: backToSingle.applied.target })).toBe(true)
    const nextFrozenSingle = JSON.parse(backToSingle.applied.executionJson!) as FrozenExecution
    expect(nextFrozenSingle.args).toEqual({ messageId: 'msg-55', body: 'Just to Alice.' })
  })

  it('handles legacy mail_reply without replyMeta: allows body edit, rejects replyAll change', () => {
    const legacyFrozen = makeFrozenConnector({
      tool: 'mail_reply',
      args: { messageId: 'msg-old', body: 'Old body' },
    })
    const row = makeApprovalRow({
      action: 'Reply via me@acme.com to alice@acme.com',
      detail: 'Account: Gmail · me@acme.com (conn-1)\nIn-Reply-To: msg-old\nTo: alice@acme.com\nSubject: Re: Hi\n\nOld body',
      target: 'alice@acme.com',
      execution_json: JSON.stringify(legacyFrozen),
    })

    const bodyEdit = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'mail_reply',
      body: 'New legacy body',
    })
    expect(bodyEdit.ok).toBe(true)
    if (!bodyEdit.ok) return
    expect(bodyEdit.applied.changed).toBe(true)
    expect(bodyEdit.applied.action).toBe(row.action)
    expect(bodyEdit.applied.target).toBe('alice@acme.com')
    expect(bodyEdit.applied.detail).toContain('\n\nNew legacy body')

    const toggleAttempt = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'mail_reply',
      body: 'New legacy body',
      replyAll: true,
    })
    expect(toggleAttempt.ok).toBe(false)
    if (!toggleAttempt.ok) expect(toggleAttempt.error).toMatch(/replyAll/i)
  })

  it('applies slack_send_message edit while preserving immutable threadTs', () => {
    const frozen = makeFrozenConnector({
      connectorId: 'conn-slack',
      app: 'slack',
      accountLabel: 'Acme',
      tool: 'slack_send_message',
      args: { channelId: 'C111', text: 'Original', threadTs: '1700.123' },
    })
    const origDetail = 'Account: Slack · Acme (conn-slack)\nChannel: C111\nThread: 1700.123\n\nOriginal'
    const row = makeApprovalRow({
      kind: 'message',
      action: 'Post Slack message to C111 (Acme)',
      detail: origDetail,
      target: 'acme:c111',
      execution_json: JSON.stringify(frozen),
    })

    const noop = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'slack_send_message',
      channelId: 'C111',
      text: 'Original',
    })
    expect(noop.ok).toBe(true)
    if (noop.ok) {
      expect(noop.applied.changed).toBe(false)
      expect(noop.applied.action).toBe(row.action)
      expect(noop.applied.detail).toBe(origDetail)
      expect(noop.applied.target).toBe(row.target)
    }

    const edited = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'slack_send_message',
      channelId: 'C222',
      text: 'Updated message',
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.applied.changed).toBe(true)
    expect(edited.applied.action).toBe('Post Slack message to C222 (Acme)')
    expect(edited.applied.target).toBe('acme:c222')
    expect(edited.applied.detail).toBe(
      'Account: Slack · Acme (conn-slack)\nChannel: C222\nThread: 1700.123\n\nUpdated message',
    )
    const nextFrozen = JSON.parse(edited.applied.executionJson!) as FrozenExecution
    expect(nextFrozen.args).toEqual({ channelId: 'C222', text: 'Updated message', threadTs: '1700.123' })
  })

  it('applies notion_create_page edit and allows empty markdown', () => {
    const frozen = makeFrozenConnector({
      connectorId: 'conn-notion',
      app: 'notion',
      accountLabel: 'Team Wiki',
      tool: 'notion_create_page',
      args: { parentPageId: 'p-root', title: 'Draft', markdown: 'Body' },
    })
    const origDetail = 'Account: Notion · Team Wiki (conn-notion)\nParent Page: p-root\nTitle: Draft\n\nBody'
    const row = makeApprovalRow({
      kind: 'post',
      action: 'Create Notion page "Draft" in Team Wiki',
      detail: origDetail,
      target: 'notion/p-root',
      execution_json: JSON.stringify(frozen),
    })

    const noop = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'notion_create_page',
      title: 'Draft',
      markdown: 'Body',
    })
    expect(noop.ok).toBe(true)
    if (noop.ok) {
      expect(noop.applied.changed).toBe(false)
      expect(noop.applied.detail).toBe(origDetail)
    }

    const edited = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'notion_create_page',
      title: 'Final Title',
      markdown: '',
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.applied.changed).toBe(true)
    expect(edited.applied.action).toBe('Create Notion page "Final Title" in Team Wiki')
    expect(edited.applied.detail).toBe(
      'Account: Notion · Team Wiki (conn-notion)\nParent Page: p-root\nTitle: Final Title',
    )
    expect(edited.applied.target).toBe('notion/p-root')
    const nextFrozen = JSON.parse(edited.applied.executionJson!) as FrozenExecution
    expect(nextFrozen.args).toEqual({ parentPageId: 'p-root', title: 'Final Title', markdown: '' })
  })

  it('applies notion_append edit and rejects blank markdown', () => {
    const frozen = makeFrozenConnector({
      connectorId: 'conn-notion',
      app: 'notion',
      accountLabel: 'Team Wiki',
      tool: 'notion_append',
      args: { pageId: 'p-123', markdown: '- Old bullet' },
    })
    const origDetail = 'Account: Notion · Team Wiki (conn-notion)\nPage ID: p-123\n\n- Old bullet'
    const row = makeApprovalRow({
      kind: 'post',
      action: 'Append to Notion page p-123 in Team Wiki',
      detail: origDetail,
      target: 'notion/p-123',
      execution_json: JSON.stringify(frozen),
    })

    const noop = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'notion_append',
      markdown: '- Old bullet',
    })
    expect(noop.ok).toBe(true)
    if (noop.ok) {
      expect(noop.applied.changed).toBe(false)
      expect(noop.applied.detail).toBe(origDetail)
    }

    const edited = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'notion_append',
      markdown: '- Updated bullet',
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.applied.changed).toBe(true)
    expect(edited.applied.detail).toBe(
      'Account: Notion · Team Wiki (conn-notion)\nPage ID: p-123\n\n- Updated bullet',
    )
    const nextFrozen = JSON.parse(edited.applied.executionJson!) as FrozenExecution
    expect(nextFrozen.args).toEqual({ pageId: 'p-123', markdown: '- Updated bullet' })

    const blank = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'notion_append',
      markdown: '   ',
    })
    expect(blank.ok).toBe(false)
  })

  it('applies calendar_create_event edit and detects no-op', () => {
    const frozen = makeFrozenConnector({
      connectorId: 'conn-cal',
      app: 'google_calendar',
      accountLabel: 'me@acme.com',
      tool: 'calendar_create_event',
      args: {
        title: 'Standup',
        start: '2026-11-22T09:00:00Z',
        end: '2026-11-22T09:30:00Z',
        location: 'Room A',
        attendees: ['bob@acme.com'],
        description: 'Daily sync',
      },
    })
    const origDetail =
      'Account: Google Calendar · me@acme.com (conn-cal)\nTitle: Standup\nWhen: 2026-11-22T09:00:00Z → 2026-11-22T09:30:00Z\nLocation: Room A\nAttendees: bob@acme.com\n\nDaily sync'
    const row = makeApprovalRow({
      kind: 'booking',
      action: 'Create calendar event "Standup" in me@acme.com',
      detail: origDetail,
      target: '',
      execution_json: JSON.stringify(frozen),
    })

    const noop = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'calendar_create_event',
      title: 'Standup',
      start: '2026-11-22T09:00:00Z',
      end: '2026-11-22T09:30:00Z',
      location: 'Room A',
      attendees: ['bob@acme.com'],
      description: 'Daily sync',
    })
    expect(noop.ok).toBe(true)
    if (noop.ok) {
      expect(noop.applied.changed).toBe(false)
      expect(noop.applied.action).toBe(row.action)
      expect(noop.applied.detail).toBe(origDetail)
    }

    const edited = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'calendar_create_event',
      title: 'Weekly Sync',
      start: '2026-11-22T10:00:00Z',
      end: '2026-11-22T11:00:00Z',
      location: '',
      attendees: [],
      description: '',
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.applied.changed).toBe(true)
    expect(edited.applied.action).toBe('Create calendar event "Weekly Sync" in me@acme.com')
    expect(edited.applied.detail).toBe(
      'Account: Google Calendar · me@acme.com (conn-cal)\nTitle: Weekly Sync\nWhen: 2026-11-22T10:00:00Z → 2026-11-22T11:00:00Z',
    )
    const nextFrozen = JSON.parse(edited.applied.executionJson!) as FrozenExecution
    expect(nextFrozen.args).toEqual({
      title: 'Weekly Sync',
      start: '2026-11-22T10:00:00Z',
      end: '2026-11-22T11:00:00Z',
    })
  })

  it('applies calendar_update_event edit, supports explicit empty clears, and rejects empty patch or eventId mutation', () => {
    const frozen = makeFrozenConnector({
      connectorId: 'conn-cal',
      app: 'google_calendar',
      accountLabel: 'me@acme.com',
      tool: 'calendar_update_event',
      args: { eventId: 'evt-42', title: 'Old Title', location: 'Room 1' },
    })
    const origDetail =
      'Account: Google Calendar · me@acme.com (conn-cal)\nEvent ID: evt-42\nTitle: Old Title\nLocation: Room 1'
    const row = makeApprovalRow({
      kind: 'booking',
      action: 'Update calendar event evt-42 in me@acme.com',
      detail: origDetail,
      target: '',
      execution_json: JSON.stringify(frozen),
    })

    // No-op
    const noop = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'calendar_update_event',
      title: 'Old Title',
      location: 'Room 1',
    })
    expect(noop.ok).toBe(true)
    if (noop.ok) {
      expect(noop.applied.changed).toBe(false)
      expect(noop.applied.detail).toBe(origDetail)
    }

    // Explicit clear location: '' counts as a field
    const clearLoc = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'calendar_update_event',
      location: '',
    })
    expect(clearLoc.ok).toBe(true)
    if (clearLoc.ok) {
      expect(clearLoc.applied.changed).toBe(true)
      expect(clearLoc.applied.detail).toContain('Location: (cleared)')
      const nextFrozen = JSON.parse(clearLoc.applied.executionJson!) as FrozenExecution
      expect(nextFrozen.args).toEqual({ eventId: 'evt-42', location: '' })
    }

    // Explicit clear attendees: [] counts as a field
    const clearAtt = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'calendar_update_event',
      attendees: [],
    })
    expect(clearAtt.ok).toBe(true)
    if (clearAtt.ok) {
      expect(clearAtt.applied.detail).toContain('Attendees: (none)')
      const nextFrozen = JSON.parse(clearAtt.applied.executionJson!) as FrozenExecution
      expect(nextFrozen.args).toEqual({ eventId: 'evt-42', attendees: [] })
    }

    // Explicit clear description: '' counts as a field
    const clearDesc = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'calendar_update_event',
      description: '',
    })
    expect(clearDesc.ok).toBe(true)
    if (clearDesc.ok) {
      const nextFrozen = JSON.parse(clearDesc.applied.executionJson!) as FrozenExecution
      expect(nextFrozen.args).toEqual({ eventId: 'evt-42', description: '' })
    }

    // Empty patch rejected
    const emptyPatch = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'calendar_update_event',
    })
    expect(emptyPatch.ok).toBe(false)
    if (!emptyPatch.ok) expect(emptyPatch.error).toMatch(/at least one field/i)

    // Mutating eventId rejected
    const tamperId = applyApprovalEdit(row, {
      kind: 'connector',
      tool: 'calendar_update_event',
      eventId: 'evt-999',
      title: 'Hack',
    })
    expect(tamperId.ok).toBe(false)
    if (!tamperId.ok) expect(tamperId.error).toMatch(/eventId/)

    // Explicitly blank title / start / end rejected
    expect(
      applyApprovalEdit(row, { kind: 'connector', tool: 'calendar_update_event', title: '   ' }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, { kind: 'connector', tool: 'calendar_update_event', start: '' }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, { kind: 'connector', tool: 'calendar_update_event', end: '\n' }).ok,
    ).toBe(false)
  })
})

describe('applyApprovalEdit — MCP & prompt', () => {
  it('applies MCP edit, formats detail identically to mcp/tools.ts, and detects canonical no-op', () => {
    const frozen = makeFrozenMcp({ args: { title: 'Bug', priority: 2, nested: { a: true, b: [1, 2] } } })
    const origDetail = formatMcpWriteApprovalDetail(frozen.args)
    const row = makeApprovalRow({
      kind: 'other',
      action: 'Linear · create_issue',
      detail: origDetail,
      target: 'mcp:linear/create_issue',
      execution_json: JSON.stringify(frozen),
    })

    // No-op with different key order
    const noop = applyApprovalEdit(row, {
      kind: 'mcp',
      args: { nested: { b: [1, 2], a: true }, priority: 2, title: 'Bug' },
    })
    expect(noop.ok).toBe(true)
    if (noop.ok) {
      expect(noop.applied.changed).toBe(false)
      expect(noop.applied.action).toBe('Linear · create_issue')
      expect(noop.applied.target).toBe('mcp:linear/create_issue')
    }

    // Real edit
    const edited = applyApprovalEdit(row, {
      kind: 'mcp',
      args: { title: 'Critical Bug', priority: 1 },
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.applied.changed).toBe(true)
    expect(edited.applied.detail).toBe(JSON.stringify({ title: 'Critical Bug', priority: 1 }, null, 2))
    const nextFrozen = JSON.parse(edited.applied.executionJson!) as FrozenMcpExecution
    expect(nextFrozen.args).toEqual({ title: 'Critical Bug', priority: 1 })

    // Empty args formats as '(no arguments)'
    const empty = applyApprovalEdit(row, { kind: 'mcp', args: {} })
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.applied.detail).toBe('(no arguments)')

    // Long MCP args detail truncates at 1,200 chars with '\n[…truncated]'
    const longText = 'M'.repeat(2_000)
    const longRes = applyApprovalEdit(row, { kind: 'mcp', args: { body: longText } })
    expect(longRes.ok).toBe(true)
    if (longRes.ok) {
      expect(longRes.applied.detail.length).toBeLessThanOrEqual(1_200)
      expect(longRes.applied.detail.endsWith('\n[…truncated]')).toBe(true)
      const parsedNext = JSON.parse(longRes.applied.executionJson!) as FrozenMcpExecution
      expect(parsedNext.args).toEqual({ body: longText })
    }
  })

  it('rejects invalid MCP edits: non-object, oversized, proto keys, non-finite numbers, cycles, depth', () => {
    const frozen = makeFrozenMcp()
    const row = makeApprovalRow({
      kind: 'other',
      action: 'Linear · create_issue',
      detail: formatMcpWriteApprovalDetail(frozen.args),
      target: 'mcp:linear/create_issue',
      execution_json: JSON.stringify(frozen),
    })

    expect(applyApprovalEdit(row, { kind: 'mcp', args: [] }).ok).toBe(false)
    expect(applyApprovalEdit(row, { kind: 'mcp', args: null }).ok).toBe(false)
    expect(applyApprovalEdit(row, { kind: 'mcp', args: 'str' }).ok).toBe(false)

    // __proto__ via JSON.parse (own property)
    const protoParsed = JSON.parse('{"kind":"mcp","args":{"__proto__":{"admin":true}}}')
    const rProto = applyApprovalEdit(row, protoParsed)
    expect(rProto.ok).toBe(false)
    if (!rProto.ok) expect(rProto.error).toMatch(/__proto__/)

    // Nested constructor / prototype keys inside arrays
    const rNested = applyApprovalEdit(row, {
      kind: 'mcp',
      args: { items: [{ ok: true }, { nested: { constructor: { prototype: {} } } }] },
    })
    expect(rNested.ok).toBe(false)
    if (!rNested.ok) expect(rNested.error).toMatch(/constructor|prototype/)

    const rPrototypeKey = applyApprovalEdit(row, {
      kind: 'mcp',
      args: { a: { prototype: 'bad' } },
    })
    expect(rPrototypeKey.ok).toBe(false)
    if (!rPrototypeKey.ok) expect(rPrototypeKey.error).toMatch(/prototype/)

    // Custom prototype object
    const customProto = Object.create({ inherited: 1 }) as Record<string, unknown>
    customProto.x = 1
    expect(applyApprovalEdit(row, { kind: 'mcp', args: customProto }).ok).toBe(false)

    // Oversized args (> 128 KB)
    const bigArgs = { blob: 'x'.repeat(MAX_MCP_ARGS_BYTES) }
    const rBig = applyApprovalEdit(row, { kind: 'mcp', args: bigArgs })
    expect(rBig.ok).toBe(false)
    if (!rBig.ok) expect(rBig.error).toMatch(/128000/)

    // Circular reference
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const rCycle = applyApprovalEdit(row, { kind: 'mcp', args: circular })
    expect(rCycle.ok).toBe(false)
    if (!rCycle.ok) expect(rCycle.error).toMatch(/circular/i)

    // Excessive nesting depth (> 64)
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 70; i++) deep = { child: deep }
    const rDeep = applyApprovalEdit(row, { kind: 'mcp', args: deep })
    expect(rDeep.ok).toBe(false)
    if (!rDeep.ok) expect(rDeep.error).toMatch(/depth/i)

    // Non-finite numbers
    expect(applyApprovalEdit(row, { kind: 'mcp', args: { n: Number.NaN } }).ok).toBe(false)
    expect(applyApprovalEdit(row, { kind: 'mcp', args: { n: Number.POSITIVE_INFINITY } }).ok).toBe(false)

    // Tampered serverId / toolName
    expect(applyApprovalEdit(row, { kind: 'mcp', serverId: 'evil', args: {} }).ok).toBe(false)
    expect(applyApprovalEdit(row, { kind: 'mcp', toolName: 'delete_all', args: {} }).ok).toBe(false)
  })

  it('applies prompt edit and rejects invalid action/detail', () => {
    const row = makeApprovalRow({
      action: 'Post release note',
      detail: 'Version 0.8 is live.',
      kind: 'post',
      target: '@opensuperbot',
      execution_json: null,
    })

    const noop = applyApprovalEdit(row, {
      kind: 'prompt',
      action: 'Post release note',
      detail: 'Version 0.8 is live.',
    })
    expect(noop.ok).toBe(true)
    if (noop.ok) {
      expect(noop.applied.changed).toBe(false)
      expect(noop.applied.executionJson).toBeUndefined()
    }

    const edited = applyApprovalEdit(row, {
      kind: 'prompt',
      action: 'Post v0.8 release note',
      detail: 'Version 0.8 is live!\nWith inline editing.',
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.applied.changed).toBe(true)
    expect(edited.applied.action).toBe('Post v0.8 release note')
    expect(edited.applied.detail).toBe('Version 0.8 is live!\nWith inline editing.')
    expect(edited.applied.target).toBe('@opensuperbot')
    expect(edited.applied.executionJson).toBeUndefined()

    expect(applyApprovalEdit(row, { kind: 'prompt', action: '', detail: 'ok' }).ok).toBe(false)
    expect(applyApprovalEdit(row, { kind: 'prompt', action: 'line1\nline2', detail: 'ok' }).ok).toBe(false)
    expect(
      applyApprovalEdit(row, { kind: 'prompt', action: 'a'.repeat(MAX_EDIT_ACTION_CHARS + 1), detail: 'ok' }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, { kind: 'prompt', action: 'ok', detail: 'd'.repeat(MAX_EDIT_TEXT_CHARS + 1) }).ok,
    ).toBe(false)
  })
})

describe('applyApprovalEdit — security & structural rejections', () => {
  it('rejects non-object edits, workflow approvals, batch approvals, and mail_archive', () => {
    const promptRow = makeApprovalRow({ execution_json: null })
    expect(applyApprovalEdit(promptRow, null).ok).toBe(false)
    expect(applyApprovalEdit(promptRow, 'edit').ok).toBe(false)
    expect(applyApprovalEdit(promptRow, []).ok).toBe(false)

    const workflowRow = makeApprovalRow({ execution_json: null, workflow_run_id: 'wf-1' })
    expect(applyApprovalEdit(workflowRow, { kind: 'prompt', action: 'A', detail: 'D' }).ok).toBe(false)

    const batchRow = makeApprovalRow({ execution_json: null, items: JSON.stringify(['a@x.com', 'b@x.com']) })
    expect(applyApprovalEdit(batchRow, { kind: 'prompt', action: 'A', detail: 'D' }).ok).toBe(false)

    const archiveRow = makeApprovalRow({
      execution_json: JSON.stringify(makeFrozenConnector({ tool: 'mail_archive', args: { messageId: 'm1' } })),
    })
    expect(
      applyApprovalEdit(archiveRow, { kind: 'connector', tool: 'mail_archive', messageId: 'm1' }).ok,
    ).toBe(false)
  })

  it('rejects mismatched kind and mismatched connector tool', () => {
    const connectorRow = makeApprovalRow({ execution_json: JSON.stringify(makeFrozenConnector()) })
    const mcpRow = makeApprovalRow({ execution_json: JSON.stringify(makeFrozenMcp()) })
    const promptRow = makeApprovalRow({ execution_json: null })

    expect(applyApprovalEdit(connectorRow, { kind: 'prompt', action: 'A', detail: 'D' }).ok).toBe(false)
    expect(applyApprovalEdit(connectorRow, { kind: 'mcp', args: {} }).ok).toBe(false)
    expect(
      applyApprovalEdit(connectorRow, { kind: 'connector', tool: 'slack_send_message', channelId: 'C1', text: 'Hi' }).ok,
    ).toBe(false)

    expect(applyApprovalEdit(mcpRow, { kind: 'prompt', action: 'A', detail: 'D' }).ok).toBe(false)
    expect(applyApprovalEdit(promptRow, { kind: 'mcp', args: {} }).ok).toBe(false)
  })

  it('rejects CR/LF email header injection and invalid email fields on mail_send', () => {
    const row = makeApprovalRow({ execution_json: JSON.stringify(makeFrozenConnector()) })

    // CR/LF in to, cc, bcc, subject (including trailing \r\n)
    expect(
      applyApprovalEdit(row, {
        kind: 'connector',
        tool: 'mail_send',
        to: ['bob@acme.com\r\nBcc: evil@attacker.com'],
        subject: 'Hi',
        body: 'Body',
      }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, {
        kind: 'connector',
        tool: 'mail_send',
        to: ['bob@acme.com\n'],
        subject: 'Hi',
        body: 'Body',
      }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, {
        kind: 'connector',
        tool: 'mail_send',
        to: ['bob@acme.com'],
        cc: ['carol@acme.com\rX-Evil: 1'],
        subject: 'Hi',
        body: 'Body',
      }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, {
        kind: 'connector',
        tool: 'mail_send',
        to: ['bob@acme.com'],
        bcc: ['dave@acme.com\nX-Evil: 1'],
        subject: 'Hi',
        body: 'Body',
      }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, {
        kind: 'connector',
        tool: 'mail_send',
        to: ['bob@acme.com'],
        subject: 'Hi\r\nBcc: evil@attacker.com',
        body: 'Body',
      }).ok,
    ).toBe(false)

    // Empty required fields
    expect(
      applyApprovalEdit(row, { kind: 'connector', tool: 'mail_send', to: [], subject: 'Hi', body: 'Body' }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, { kind: 'connector', tool: 'mail_send', to: ['bob@acme.com'], subject: '  ', body: 'Body' })
        .ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, { kind: 'connector', tool: 'mail_send', to: ['bob@acme.com'], subject: 'Hi', body: '   ' })
        .ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, { kind: 'connector', tool: 'mail_send', to: ['bob@acme.com', ''], subject: 'Hi', body: 'Body' })
        .ok,
    ).toBe(false)

    // Oversized address & list length & body
    expect(
      applyApprovalEdit(row, {
        kind: 'connector',
        tool: 'mail_send',
        to: [`${'a'.repeat(MAX_EMAIL_ADDRESS_CHARS)}@x.com`],
        subject: 'Hi',
        body: 'Body',
      }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, {
        kind: 'connector',
        tool: 'mail_send',
        to: Array.from({ length: MAX_EMAIL_LIST_LENGTH + 1 }, (_, i) => `u${i}@acme.com`),
        subject: 'Hi',
        body: 'Body',
      }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, {
        kind: 'connector',
        tool: 'mail_send',
        to: ['bob@acme.com'],
        subject: 'Hi',
        body: 'x'.repeat(MAX_EDIT_TEXT_CHARS + 1),
      }).ok,
    ).toBe(false)

    // Immutable/internal field tampering across tools and top-level __proto__
    expect(
      applyApprovalEdit(row, {
        kind: 'connector',
        tool: 'mail_send',
        connectorId: 'conn-other',
        to: ['bob@acme.com'],
        subject: 'Hi',
        body: 'Body',
      }).ok,
    ).toBe(false)
    expect(
      applyApprovalEdit(row, {
        kind: 'connector',
        tool: 'mail_send',
        draftId: 'draft-swapped',
        to: ['bob@acme.com'],
        subject: 'Hi',
        body: 'Body',
      }).ok,
    ).toBe(false)

    const replyRow = makeApprovalRow({
      execution_json: JSON.stringify(
        makeFrozenConnector({
          tool: 'mail_reply',
          args: { messageId: 'm1', body: 'hi' },
          replyMeta: { to: ['a@b.com'], allCc: [], subject: 'Re: Hi' },
        }),
      ),
    })
    expect(
      applyApprovalEdit(replyRow, { kind: 'connector', tool: 'mail_reply', messageId: 'm2', body: 'hi' }).ok,
    ).toBe(false)

    const slackRow = makeApprovalRow({
      execution_json: JSON.stringify(
        makeFrozenConnector({
          app: 'slack',
          tool: 'slack_send_message',
          args: { channelId: 'C1', text: 'hi', threadTs: '1.2' },
        }),
      ),
    })
    expect(
      applyApprovalEdit(slackRow, {
        kind: 'connector',
        tool: 'slack_send_message',
        channelId: 'C1',
        text: 'hi',
        threadTs: '9.9',
      }).ok,
    ).toBe(false)

    const notionCreateRow = makeApprovalRow({
      execution_json: JSON.stringify(
        makeFrozenConnector({
          app: 'notion',
          tool: 'notion_create_page',
          args: { parentPageId: 'p1', title: 'T', markdown: 'M' },
        }),
      ),
    })
    expect(
      applyApprovalEdit(notionCreateRow, {
        kind: 'connector',
        tool: 'notion_create_page',
        parentPageId: 'p2',
        title: 'T',
        markdown: 'M',
      }).ok,
    ).toBe(false)

    const notionAppendRow = makeApprovalRow({
      execution_json: JSON.stringify(
        makeFrozenConnector({
          app: 'notion',
          tool: 'notion_append',
          args: { pageId: 'p1', markdown: 'M' },
        }),
      ),
    })
    expect(
      applyApprovalEdit(notionAppendRow, {
        kind: 'connector',
        tool: 'notion_append',
        pageId: 'p2',
        markdown: 'M',
      }).ok,
    ).toBe(false)

    const promptRow = makeApprovalRow({ execution_json: null })
    const topProto = JSON.parse('{"kind":"prompt","action":"A","detail":"D","__proto__":{"p":1}}')
    expect(applyApprovalEdit(promptRow, topProto).ok).toBe(false)
  })
})

describe('resolveApproval atomic patch', () => {
  it('atomically updates action, detail, target, execution_json on first call and returns null on second call', () => {
    const db = openDb(':memory:')
    const bot = { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' }
    upsertBot(db, bot)
    const threadId = ensureDmThread(db, bot.id)

    const initialExec = JSON.stringify(makeFrozenConnector())
    const a = createApproval(db, {
      threadId,
      botId: bot.id,
      action: 'Send email via me@acme.com to bob@acme.com',
      detail: 'original detail',
      kind: 'email',
      target: 'bob@acme.com',
      executionJson: initialExec,
    })

    const nextExec = JSON.stringify(
      makeFrozenConnector({ args: { to: ['alice@acme.com'], subject: 'Edited', body: 'Updated' } }),
    )
    const first = resolveApproval(db, a.id, 'approve', {
      action: 'Send email via me@acme.com to alice@acme.com',
      detail: 'updated detail',
      target: 'alice@acme.com',
      executionJson: nextExec,
    })
    expect(first).not.toBeNull()
    expect(first!.status).toBe('approved')
    expect(first!.resolved_at).toBeGreaterThan(0)
    expect(first!.action).toBe('Send email via me@acme.com to alice@acme.com')
    expect(first!.detail).toBe('updated detail')
    expect(first!.target).toBe('alice@acme.com')
    expect(first!.execution_json).toBe(nextExec)

    // Concurrent / duplicate click with a different patch returns null and leaves DB intact
    const second = resolveApproval(db, a.id, 'approve', {
      action: 'OVERWRITTEN',
      detail: 'OVERWRITTEN',
      target: 'evil@attacker.com',
      executionJson: '{"hacked":true}',
    })
    expect(second).toBeNull()

    const stored = getApproval(db, a.id)!
    expect(stored.action).toBe('Send email via me@acme.com to alice@acme.com')
    expect(stored.detail).toBe('updated detail')
    expect(stored.target).toBe('alice@acme.com')
    expect(stored.execution_json).toBe(nextExec)
  })

  it('preserves untouched columns when patch omits optional fields', () => {
    const db = openDb(':memory:')
    const bot = { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' }
    upsertBot(db, bot)
    const threadId = ensureDmThread(db, bot.id)

    const a = createApproval(db, {
      threadId,
      botId: bot.id,
      action: 'Original action',
      detail: 'Original detail',
      kind: 'post',
      target: '@acme',
    })

    const resolved = resolveApproval(db, a.id, 'approve', {
      action: 'Edited action',
      detail: 'Edited detail',
    })
    expect(resolved).not.toBeNull()
    expect(resolved!.action).toBe('Edited action')
    expect(resolved!.detail).toBe('Edited detail')
    expect(resolved!.target).toBe('@acme')
    expect(resolved!.execution_json).toBeNull()
  })
})
