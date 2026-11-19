import { randomUUID } from 'node:crypto'
import { recordAction, type ActionTrigger } from '../actions.js'
import type { AgentEvents, RuleBlock, RuleGrant } from '../agent.js'
import {
  RULEABLE_KINDS,
  blockText,
  canRemember,
  createApproval,
  destinationReason,
  findMatchingRule,
  normalizeTarget,
  recordApprovalExecution,
  type ApprovalKind,
  type BlockReason,
} from '../approvals.js'
import { insertMessage, type Db } from '../db.js'
import type { Hub } from '../hub.js'
import type { ToolDef } from '../llm.js'
import { noticeText, type Notice } from '../notices.js'
import { catalogByApp } from './catalog.js'
import { listActiveBotConnectors, markConnectorStatus, markExpiredNotified } from './store.js'
import {
  ConnectorDriverError,
  type AppKey,
  type ConnectorAccountRow,
  type ConnectorDomain,
  type ConnectorDriver,
  type ConnectorWriteToolName,
  type FrozenExecution,
} from './types.js'

export const CONNECTOR_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mail_list',
  'mail_read',
  'calendar_list',
  'notion_search',
  'notion_read_page',
  'slack_list_channels',
  'slack_read_messages',
])

export const CONNECTOR_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mail_send',
  'mail_reply',
  'mail_archive',
  'calendar_create_event',
  'calendar_update_event',
  'notion_create_page',
  'notion_append',
  'slack_send_message',
])

const ALL_CONNECTOR_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CONNECTOR_READ_TOOL_NAMES,
  'mail_draft',
  ...CONNECTOR_WRITE_TOOL_NAMES,
])

const MAX_READ_OUTPUT_CHARS = 16_000
const MAX_DETAIL_BODY_CHARS = 4_000

export function isConnectorTool(name: string): boolean {
  return ALL_CONNECTOR_TOOL_NAMES.has(name)
}

function accountDisplay(acc: Pick<ConnectorAccountRow, 'id' | 'app' | 'account_label'>): string {
  const appName = catalogByApp(acc.app)?.name ?? acc.app
  const label = acc.account_label || acc.id
  return `${appName} · ${label} (${acc.id})`
}

function accountParam(accounts: ConnectorAccountRow[]): { prop: Record<string, unknown>; required: boolean } {
  if (accounts.length >= 2) {
    const summary = accounts
      .map((a) => `${a.id} (${catalogByApp(a.app)?.name ?? a.app} · ${a.account_label || a.id})`)
      .join(', ')
    return {
      required: true,
      prop: {
        type: 'string',
        enum: accounts.map((a) => a.id),
        description: `Connected account id to use: ${summary}.`,
      },
    }
  }
  const only = accounts[0]!
  return {
    required: false,
    prop: {
      type: 'string',
      description: `Optional connected account id or label (defaults to ${only.id}: ${catalogByApp(only.app)?.name ?? only.app} · ${only.account_label || only.id}).`,
    },
  }
}

function makeTool(
  name: string,
  description: string,
  acct: { prop: Record<string, unknown>; required: boolean },
  properties: Record<string, unknown>,
  requiredFields: string[] = [],
): ToolDef {
  const required = [...(acct.required ? ['account'] : []), ...requiredFields]
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: { account: acct.prop, ...properties },
        ...(required.length ? { required } : {}),
      },
    },
  }
}

export function buildConnectorTools(
  accounts: readonly ConnectorAccountRow[],
  opts: { watch?: boolean } = {},
): ToolDef[] {
  const active = accounts.filter((a) => a.status === 'active')
  if (!active.length) return []

  const byDomain = (domain: ConnectorDomain) => active.filter((a) => catalogByApp(a.app)?.domain === domain)
  const mailAccounts = byDomain('mail')
  const calendarAccounts = byDomain('calendar')
  const notionAccounts = byDomain('notion')
  const slackAccounts = byDomain('slack')

  const tools: ToolDef[] = []

  if (mailAccounts.length) {
    const acct = accountParam(mailAccounts)
    tools.push(
      makeTool(
        'mail_list',
        'List email summaries in a connected mailbox. Automated newsletters/notifications are hidden unless includeAutomated is true.',
        acct,
        {
          folder: { type: 'string', enum: ['inbox', 'sent', 'all'], description: 'Mailbox folder (default "inbox").' },
          unread: { type: 'boolean', description: 'Filter by unread status.' },
          query: { type: 'string', description: 'Provider search query.' },
          includeAutomated: { type: 'boolean', description: 'Include automated/bulk messages (default false).' },
          limit: { type: 'number', description: 'Maximum messages to return (default 20, max 100).' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous mail_list call.' },
        },
      ),
      makeTool(
        'mail_read',
        'Read an email message, thread, or saved draft in full without changing its unread state. Pass exactly one of messageId, threadId, or draftId.',
        acct,
        {
          messageId: { type: 'string', description: 'Single message id to read.' },
          threadId: { type: 'string', description: 'Conversation/thread id to read.' },
          draftId: { type: 'string', description: 'Saved draft id to read.' },
        },
      ),
      makeTool(
        'mail_draft',
        'Create or update an unsent draft in the connected mailbox Drafts folder.',
        acct,
        {
          draftId: { type: 'string', description: 'Existing draft id to update; omit to create a new draft.' },
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
          cc: { type: 'array', items: { type: 'string' }, description: 'CC email addresses.' },
          bcc: { type: 'array', items: { type: 'string' }, description: 'BCC email addresses.' },
          subject: { type: 'string', description: 'Email subject line.' },
          body: { type: 'string', description: 'Plain-text email body.' },
        },
        ['to', 'subject', 'body'],
      ),
      makeTool(
        'mail_send',
        'Send an email (held by the gateway for operator approval unless covered by an eligible standing rule). Pass either draftId OR (to, subject, body).',
        acct,
        {
          draftId: { type: 'string', description: 'Saved draft id to send.' },
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses (when not using draftId).' },
          cc: { type: 'array', items: { type: 'string' }, description: 'CC email addresses.' },
          bcc: { type: 'array', items: { type: 'string' }, description: 'BCC email addresses.' },
          subject: { type: 'string', description: 'Email subject line (when not using draftId).' },
          body: { type: 'string', description: 'Plain-text email body (when not using draftId).' },
        },
      ),
      makeTool(
        'mail_reply',
        'Reply to an existing email message (held by the gateway for operator approval unless covered by an eligible standing rule).',
        acct,
        {
          messageId: { type: 'string', description: 'Message id to reply to.' },
          body: { type: 'string', description: 'Plain-text reply body.' },
          replyAll: { type: 'boolean', description: 'Reply to all recipients on the message (default false).' },
        },
        ['messageId', 'body'],
      ),
      makeTool(
        'mail_archive',
        'Archive an email message out of the inbox (held by the gateway for operator approval).',
        acct,
        {
          messageId: { type: 'string', description: 'Message id to archive.' },
        },
        ['messageId'],
      ),
    )
  }

  if (calendarAccounts.length) {
    const acct = accountParam(calendarAccounts)
    tools.push(
      makeTool(
        'calendar_list',
        'List calendar events between start and end ISO 8601 timestamps.',
        acct,
        {
          start: { type: 'string', description: 'Start timestamp in ISO 8601 format.' },
          end: { type: 'string', description: 'End timestamp in ISO 8601 format.' },
          query: { type: 'string', description: 'Optional search filter.' },
          limit: { type: 'number', description: 'Maximum events to return (default 50, max 100).' },
        },
        ['start', 'end'],
      ),
      makeTool(
        'calendar_create_event',
        'Create a calendar event (held by the gateway for operator approval).',
        acct,
        {
          title: { type: 'string', description: 'Event title/summary.' },
          start: { type: 'string', description: 'Start timestamp in ISO 8601 format.' },
          end: { type: 'string', description: 'End timestamp in ISO 8601 format.' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Optional attendee email addresses.' },
          location: { type: 'string', description: 'Optional location.' },
          description: { type: 'string', description: 'Optional event description.' },
        },
        ['title', 'start', 'end'],
      ),
      makeTool(
        'calendar_update_event',
        'Update an existing calendar event (held by the gateway for operator approval).',
        acct,
        {
          eventId: { type: 'string', description: 'Calendar event id to update.' },
          title: { type: 'string', description: 'Updated title.' },
          start: { type: 'string', description: 'Updated start timestamp in ISO 8601 format.' },
          end: { type: 'string', description: 'Updated end timestamp in ISO 8601 format.' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Updated attendee email addresses.' },
          location: { type: 'string', description: 'Updated location.' },
          description: { type: 'string', description: 'Updated description.' },
        },
        ['eventId'],
      ),
    )
  }

  if (notionAccounts.length) {
    const acct = accountParam(notionAccounts)
    tools.push(
      makeTool(
        'notion_search',
        'Search Notion pages accessible to the connected workspace.',
        acct,
        {
          query: { type: 'string', description: 'Search query text (pass "" to list recent pages).' },
          limit: { type: 'number', description: 'Maximum pages to return (default 20, max 100).' },
        },
        ['query'],
      ),
      makeTool(
        'notion_read_page',
        'Read a Notion page title and block contents as Markdown.',
        acct,
        {
          pageId: { type: 'string', description: 'Notion page id.' },
        },
        ['pageId'],
      ),
      makeTool(
        'notion_create_page',
        'Create a child Notion page under parentPageId (held by the gateway for operator approval).',
        acct,
        {
          parentPageId: { type: 'string', description: 'Parent Notion page id.' },
          title: { type: 'string', description: 'New page title.' },
          markdown: { type: 'string', description: 'Page body in Markdown.' },
        },
        ['parentPageId', 'title', 'markdown'],
      ),
      makeTool(
        'notion_append',
        'Append Markdown blocks to an existing Notion page (held by the gateway for operator approval).',
        acct,
        {
          pageId: { type: 'string', description: 'Notion page id to append to.' },
          markdown: { type: 'string', description: 'Markdown content to append.' },
        },
        ['pageId', 'markdown'],
      ),
    )
  }

  if (slackAccounts.length) {
    const acct = accountParam(slackAccounts)
    tools.push(
      makeTool(
        'slack_list_channels',
        'List Slack channels accessible to the connected account.',
        acct,
        {
          limit: { type: 'number', description: 'Maximum channels to return (default 100, max 200).' },
          cursor: { type: 'string', description: 'Pagination cursor.' },
        },
      ),
      makeTool(
        'slack_read_messages',
        'Read recent messages in a Slack channel or thread.',
        acct,
        {
          channelId: { type: 'string', description: 'Slack channel id (e.g. "C01234567").' },
          threadTs: { type: 'string', description: 'Optional thread timestamp to read replies.' },
          limit: { type: 'number', description: 'Maximum messages to return (default 30, max 100).' },
        },
        ['channelId'],
      ),
      makeTool(
        'slack_send_message',
        'Post a message to a Slack channel or thread (held by the gateway for operator approval unless covered by an eligible standing rule).',
        acct,
        {
          channelId: { type: 'string', description: 'Slack channel id (e.g. "C01234567").' },
          text: { type: 'string', description: 'Message text to post.' },
          threadTs: { type: 'string', description: 'Optional thread timestamp to reply in thread.' },
        },
        ['channelId', 'text'],
      ),
    )
  }

  return opts.watch ? tools.filter((t) => CONNECTOR_READ_TOOL_NAMES.has(t.function.name)) : tools
}

function domainOfTool(name: string): ConnectorDomain | null {
  if (name.startsWith('mail_')) return 'mail'
  if (name.startsWith('calendar_')) return 'calendar'
  if (name.startsWith('notion_')) return 'notion'
  if (name.startsWith('slack_')) return 'slack'
  return null
}

function resolveAccount(
  activeAccounts: readonly ConnectorAccountRow[],
  domain: ConnectorDomain,
  rawProvided: unknown,
): { ok: true; account: ConnectorAccountRow } | { ok: false; error: string } {
  const domainAccounts = activeAccounts.filter((a) => catalogByApp(a.app)?.domain === domain)
  if (!domainAccounts.length) {
    return { ok: false, error: `No active ${domain} connector is authorized for you right now.` }
  }
  const provided = typeof rawProvided === 'string' ? rawProvided.trim() : ''
  const describeChoices = () =>
    domainAccounts.map((a) => `${a.id} (${catalogByApp(a.app)?.name ?? a.app} · ${a.account_label || a.id})`).join(', ')

  if (domainAccounts.length === 1) {
    const only = domainAccounts[0]!
    if (!provided) return { ok: true, account: only }
    if (only.id === provided || (only.account_label && only.account_label.toLowerCase() === provided.toLowerCase())) {
      return { ok: true, account: only }
    }
    return {
      ok: false,
      error: `Account "${provided}" does not match your authorized ${domain} account: ${describeChoices()}.`,
    }
  }

  if (!provided) {
    return {
      ok: false,
      error: `Multiple ${domain} accounts are authorized; pass "account" with one of: ${describeChoices()}.`,
    }
  }
  const byId = domainAccounts.find((a) => a.id === provided)
  if (byId) return { ok: true, account: byId }
  const byLabel = domainAccounts.filter(
    (a) => Boolean(a.account_label) && a.account_label.toLowerCase() === provided.toLowerCase(),
  )
  if (byLabel.length === 1) return { ok: true, account: byLabel[0]! }
  return {
    ok: false,
    error: `Unknown or ambiguous ${domain} account "${provided}". Choose one of: ${describeChoices()}.`,
  }
}

function optString(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined
  const t = val.trim()
  return t ? t : undefined
}

function optPositiveInt(val: unknown, max: number): number | undefined {
  if (val === undefined || val === null) return undefined
  const n = typeof val === 'number' ? val : Number(val)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(Math.floor(n), max)
}

function cleanStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  return val.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text
}

function extractBareEmail(raw: string): string {
  const trimmed = raw.trim()
  const angle = trimmed.match(/<([^<>@\s,;]+@[^<>@\s,;]+)>/)
  return (angle ? angle[1]! : trimmed).trim().toLowerCase()
}

/**
 * Extracts a single bare email address for approval target matching ONLY when raw represents a single address
 * (e.g. "Bob <bob@acme.com>" -> "bob@acme.com"). Multi-address strings stay intact so destinationReason rejects them.
 */
function extractSingleEmailTarget(raw: string): string {
  const trimmed = raw.trim()
  if (/[,;|\n]/.test(trimmed)) return normalizeTarget(trimmed)
  const angle = trimmed.match(/^[^<>@,;]*<([^<>@\s,;]+@[^<>@\s,;]+)>\s*$/)
  if (angle) return normalizeTarget(angle[1]!)
  return normalizeTarget(trimmed)
}

function formatReadJson(acc: ConnectorAccountRow, payload: Record<string, unknown>): string {
  const text = JSON.stringify(
    {
      account: { id: acc.id, app: acc.app, label: acc.account_label || acc.id },
      ...payload,
    },
    null,
    2,
  )
  return truncateText(text, MAX_READ_OUTPUT_CHARS)
}

export function handleConnectorAuthExpired(opts: {
  db: Db
  hub?: Hub
  threadId: string
  botId: string
  account: Pick<ConnectorAccountRow, 'id' | 'app' | 'account_label'>
  error: string
  now?: number
  onNotice?: (msg: ReturnType<typeof insertMessage>) => void
}): void {
  markConnectorStatus(opts.db, opts.account.id, 'expired', opts.error, opts.now ?? Date.now())
  opts.hub?.broadcast({ type: 'connectors_changed' })
  if (markExpiredNotified(opts.db, opts.account.id)) {
    const appName = catalogByApp(opts.account.app)?.name ?? opts.account.app
    const notice: Notice = {
      notice: 'connector_expired',
      params: { app: appName, account: opts.account.account_label || opts.account.id },
    }
    const msg = insertMessage(opts.db, {
      threadId: opts.threadId,
      sender: opts.botId,
      kind: 'text',
      content: noticeText(notice),
      payload: notice,
    })
    if (opts.onNotice) opts.onNotice(msg)
    else opts.hub?.broadcast({ type: 'message', threadId: opts.threadId, message: msg })
  }
}

type PreparedWrite =
  | {
      ok: true
      action: string
      detail: string
      kind: ApprovalKind
      target: string
      frozenArgs: Record<string, unknown>
    }
  | { ok: false; error: string }

async function prepareConnectorWrite(
  driver: ConnectorDriver,
  acc: ConnectorAccountRow,
  tool: ConnectorWriteToolName,
  args: Record<string, unknown>,
): Promise<PreparedWrite> {
  const label = acc.account_label || acc.id
  const acctLine = `Account: ${accountDisplay(acc)}`

  switch (tool) {
    case 'mail_send': {
      const draftId = optString(args.draftId)
      const inlineTo = cleanStringArray(args.to)
      const inlineCc = cleanStringArray(args.cc)
      const inlineBcc = cleanStringArray(args.bcc)
      const hasInlineFields =
        inlineTo.length > 0 ||
        inlineCc.length > 0 ||
        inlineBcc.length > 0 ||
        Boolean(optString(args.subject)) ||
        Boolean(optString(args.body))

      if (draftId && hasInlineFields) {
        return {
          ok: false,
          error: 'mail_send accepts either "draftId" alone or inline ("to", "subject", "body"), not both.',
        }
      }

      if (draftId) {
        const draft = await driver.readMail(acc, { draftId })
        const msg = draft.messages[0]
        if (!msg) return { ok: false, error: `Draft "${draftId}" was not found or could not be read.` }
        const to = msg.to.filter(Boolean)
        const cc = (msg.cc ?? []).filter(Boolean)
        const bcc = (msg.bcc ?? []).filter(Boolean)
        if (!to.length) {
          return { ok: false, error: `Draft "${draftId}" has no recipients in "to". Update it with mail_draft first.` }
        }
        const resolvedDraftId = draft.draftId || draftId
        const allRecipients = [...to, ...cc, ...bcc]
        const target =
          to.length === 1 && !cc.length && !bcc.length
            ? extractSingleEmailTarget(to[0]!)
            : normalizeTarget(allRecipients.join(', '))
        const headerLines = [
          acctLine,
          `Draft: ${resolvedDraftId}`,
          `To: ${to.join(', ')}`,
          ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
          ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
          `Subject: ${msg.subject || '(no subject)'}`,
        ]
        return {
          ok: true,
          action: `Send email via ${label} to ${to.join(', ')}`,
          detail: `${headerLines.join('\n')}\n\n${truncateText(msg.body, MAX_DETAIL_BODY_CHARS)}`,
          kind: 'email',
          target,
          frozenArgs: { draftId: resolvedDraftId },
        }
      }

      const subject = typeof args.subject === 'string' ? args.subject.trim() : ''
      const body = typeof args.body === 'string' ? args.body : ''
      if (!inlineTo.length || !subject || !body.trim()) {
        return {
          ok: false,
          error: 'mail_send requires either "draftId" or non-empty "to", "subject", and "body".',
        }
      }
      const allRecipients = [...inlineTo, ...inlineCc, ...inlineBcc]
      const target =
        inlineTo.length === 1 && !inlineCc.length && !inlineBcc.length
          ? extractSingleEmailTarget(inlineTo[0]!)
          : normalizeTarget(allRecipients.join(', '))
      const headerLines = [
        acctLine,
        `To: ${inlineTo.join(', ')}`,
        ...(inlineCc.length ? [`Cc: ${inlineCc.join(', ')}`] : []),
        ...(inlineBcc.length ? [`Bcc: ${inlineBcc.join(', ')}`] : []),
        `Subject: ${subject}`,
      ]
      return {
        ok: true,
        action: `Send email via ${label} to ${inlineTo.join(', ')}`,
        detail: `${headerLines.join('\n')}\n\n${truncateText(body, MAX_DETAIL_BODY_CHARS)}`,
        kind: 'email',
        target,
        frozenArgs: {
          to: inlineTo,
          ...(inlineCc.length ? { cc: inlineCc } : {}),
          ...(inlineBcc.length ? { bcc: inlineBcc } : {}),
          subject,
          body,
        },
      }
    }

    case 'mail_reply': {
      const messageId = optString(args.messageId)
      const body = typeof args.body === 'string' ? args.body : ''
      const replyAll = args.replyAll === true
      if (!messageId || !body.trim()) {
        return { ok: false, error: 'mail_reply requires non-empty "messageId" and "body".' }
      }
      const origRes = await driver.readMail(acc, { messageId })
      const orig = origRes.messages[0]
      if (!orig) return { ok: false, error: `Message "${messageId}" was not found.` }
      const primaryTo = orig.from.trim()
      if (!primaryTo) return { ok: false, error: `Message "${messageId}" has no sender to reply to.` }

      const selfBare = extractBareEmail(acc.account_label)
      const seen = new Set<string>([extractBareEmail(primaryTo), ...(selfBare ? [selfBare] : [])])
      const cc: string[] = []
      if (replyAll) {
        for (const addr of [...orig.to, ...(orig.cc ?? [])]) {
          const bare = extractBareEmail(addr)
          if (bare && !seen.has(bare)) {
            seen.add(bare)
            cc.push(addr)
          }
        }
      }
      const subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject || '(no subject)'}`
      const allRecipients = [primaryTo, ...cc]
      const target = cc.length === 0 ? extractSingleEmailTarget(primaryTo) : normalizeTarget(allRecipients.join(', '))
      const headerLines = [
        acctLine,
        `In-Reply-To: ${messageId}${orig.threadId ? ` (thread ${orig.threadId})` : ''}`,
        `To: ${primaryTo}`,
        ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
        `Subject: ${subject}`,
      ]
      return {
        ok: true,
        action: `Reply via ${label} to ${allRecipients.join(', ')}`,
        detail: `${headerLines.join('\n')}\n\n${truncateText(body, MAX_DETAIL_BODY_CHARS)}`,
        kind: 'email',
        target,
        frozenArgs: { messageId, body, ...(replyAll ? { replyAll: true } : {}) },
      }
    }

    case 'mail_archive': {
      const messageId = optString(args.messageId)
      if (!messageId) return { ok: false, error: 'mail_archive requires "messageId".' }
      return {
        ok: true,
        action: `Archive email ${messageId} in ${label}`,
        detail: `${acctLine}\nMessage ID: ${messageId}`,
        kind: 'other',
        target: '',
        frozenArgs: { messageId },
      }
    }

    case 'calendar_create_event': {
      const title = optString(args.title)
      const start = optString(args.start)
      const end = optString(args.end)
      if (!title || !start || !end) {
        return { ok: false, error: 'calendar_create_event requires "title", "start", and "end".' }
      }
      const attendees = cleanStringArray(args.attendees)
      const location = optString(args.location)
      const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : undefined
      const lines = [
        acctLine,
        `Title: ${title}`,
        `When: ${start} → ${end}`,
        ...(location ? [`Location: ${location}`] : []),
        ...(attendees.length ? [`Attendees: ${attendees.join(', ')}`] : []),
      ]
      return {
        ok: true,
        action: `Create calendar event "${title}" in ${label}`,
        detail: description ? `${lines.join('\n')}\n\n${truncateText(description, MAX_DETAIL_BODY_CHARS)}` : lines.join('\n'),
        kind: 'booking',
        target: '',
        frozenArgs: {
          title,
          start,
          end,
          ...(attendees.length ? { attendees } : {}),
          ...(location ? { location } : {}),
          ...(description ? { description } : {}),
        },
      }
    }

    case 'calendar_update_event': {
      const eventId = optString(args.eventId)
      if (!eventId) return { ok: false, error: 'calendar_update_event requires "eventId".' }
      const patch: Record<string, unknown> = { eventId }
      const lines = [acctLine, `Event ID: ${eventId}`]
      if (typeof args.title === 'string' && args.title.trim()) {
        patch.title = args.title.trim()
        lines.push(`Title: ${patch.title}`)
      }
      if (typeof args.start === 'string' && args.start.trim()) {
        patch.start = args.start.trim()
        lines.push(`Start: ${patch.start}`)
      }
      if (typeof args.end === 'string' && args.end.trim()) {
        patch.end = args.end.trim()
        lines.push(`End: ${patch.end}`)
      }
      if (typeof args.location === 'string') {
        patch.location = args.location.trim()
        lines.push(`Location: ${patch.location || '(cleared)'}`)
      }
      if (Array.isArray(args.attendees)) {
        const attendees = cleanStringArray(args.attendees)
        patch.attendees = attendees
        lines.push(`Attendees: ${attendees.join(', ') || '(none)'}`)
      }
      let descSuffix = ''
      if (typeof args.description === 'string') {
        patch.description = args.description
        descSuffix = `\n\n${truncateText(args.description, MAX_DETAIL_BODY_CHARS)}`
      }
      if (Object.keys(patch).length <= 1) {
        return { ok: false, error: 'calendar_update_event requires at least one field to update.' }
      }
      return {
        ok: true,
        action: `Update calendar event ${eventId} in ${label}`,
        detail: `${lines.join('\n')}${descSuffix}`,
        kind: 'booking',
        target: '',
        frozenArgs: patch,
      }
    }

    case 'notion_create_page': {
      const parentPageId = optString(args.parentPageId)
      const title = optString(args.title)
      const markdown = typeof args.markdown === 'string' ? args.markdown : undefined
      if (!parentPageId || !title || markdown === undefined) {
        return { ok: false, error: 'notion_create_page requires "parentPageId", "title", and "markdown".' }
      }
      const lines = [acctLine, `Parent Page: ${parentPageId}`, `Title: ${title}`]
      return {
        ok: true,
        action: `Create Notion page "${title}" in ${label}`,
        detail: markdown.trim()
          ? `${lines.join('\n')}\n\n${truncateText(markdown, MAX_DETAIL_BODY_CHARS)}`
          : lines.join('\n'),
        kind: 'post',
        target: normalizeTarget(`notion/${parentPageId}`),
        frozenArgs: { parentPageId, title, markdown },
      }
    }

    case 'notion_append': {
      const pageId = optString(args.pageId)
      const markdown = typeof args.markdown === 'string' ? args.markdown : ''
      if (!pageId || !markdown.trim()) {
        return { ok: false, error: 'notion_append requires non-empty "pageId" and "markdown".' }
      }
      return {
        ok: true,
        action: `Append to Notion page ${pageId} in ${label}`,
        detail: `${acctLine}\nPage ID: ${pageId}\n\n${truncateText(markdown, MAX_DETAIL_BODY_CHARS)}`,
        kind: 'post',
        target: normalizeTarget(`notion/${pageId}`),
        frozenArgs: { pageId, markdown },
      }
    }

    case 'slack_send_message': {
      const channelId = optString(args.channelId)
      const text = typeof args.text === 'string' ? args.text : ''
      const threadTs = optString(args.threadTs)
      if (!channelId || !text.trim()) {
        return { ok: false, error: 'slack_send_message requires non-empty "channelId" and "text".' }
      }
      const lines = [acctLine, `Channel: ${channelId}`, ...(threadTs ? [`Thread: ${threadTs}`] : [])]
      return {
        ok: true,
        action: `Post Slack message to ${channelId} (${label})`,
        detail: `${lines.join('\n')}\n\n${truncateText(text, MAX_DETAIL_BODY_CHARS)}`,
        kind: 'message',
        target: normalizeTarget(`${label}:${channelId}`),
        frozenArgs: { channelId, text, ...(threadTs ? { threadTs } : {}) },
      }
    }
  }
}

export type RunConnectorToolOpts = {
  db: Db
  driver: ConnectorDriver
  hub?: Hub
  botId: string
  threadId: string
  trigger: ActionTrigger
  name: string
  args: Record<string, unknown>
  ruleBlock: RuleBlock | null
  events: AgentEvents
  now?: number
}

export async function runConnectorToolCall(
  opts: RunConnectorToolOpts,
): Promise<{ text: string; ok: boolean; tainted?: boolean }> {
  const { db, driver, hub, botId, threadId, trigger, name, args, ruleBlock, events } = opts
  const domain = domainOfTool(name)
  if (!domain || !isConnectorTool(name)) {
    return { text: `Unknown connector tool: ${name}`, ok: false }
  }

  const activeAccounts = listActiveBotConnectors(db, botId)
  const resolved = resolveAccount(activeAccounts, domain, args.account)
  if (!resolved.ok) {
    return { text: resolved.error, ok: false }
  }
  const acc = resolved.account
  const at = opts.now ?? Date.now()
  const emitNotice = (notice: Notice) => {
    events.onMessage(
      insertMessage(db, {
        threadId,
        sender: botId,
        kind: 'text',
        content: noticeText(notice),
        payload: notice,
      }),
    )
  }

  try {
    switch (name) {
      case 'mail_list': {
        const folder = args.folder === 'inbox' || args.folder === 'sent' || args.folder === 'all' ? args.folder : undefined
        const unread = typeof args.unread === 'boolean' ? args.unread : undefined
        const query = optString(args.query)
        const includeAutomated = args.includeAutomated === true
        const limit = optPositiveInt(args.limit, 100)
        const cursor = optString(args.cursor)
        const res = await driver.listMail(acc, {
          ...(folder ? { folder } : {}),
          ...(unread !== undefined ? { unread } : {}),
          ...(query ? { query } : {}),
          includeAutomated,
          ...(limit ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
        })
        return { text: formatReadJson(acc, res), ok: true, tainted: true }
      }

      case 'mail_read': {
        const messageId = optString(args.messageId)
        const mailThreadId = optString(args.threadId)
        const draftId = optString(args.draftId)
        if ([messageId, mailThreadId, draftId].filter(Boolean).length !== 1) {
          return { text: 'mail_read requires exactly one of "messageId", "threadId", or "draftId".', ok: false }
        }
        const res = await driver.readMail(acc, {
          ...(messageId ? { messageId } : {}),
          ...(mailThreadId ? { threadId: mailThreadId } : {}),
          ...(draftId ? { draftId } : {}),
        })
        return { text: formatReadJson(acc, res), ok: true, tainted: true }
      }

      case 'mail_draft': {
        const to = cleanStringArray(args.to)
        const cc = cleanStringArray(args.cc)
        const bcc = cleanStringArray(args.bcc)
        const draftId = optString(args.draftId)
        const subject = typeof args.subject === 'string' ? args.subject : undefined
        const body = typeof args.body === 'string' ? args.body : undefined
        if (!to.length || subject === undefined || body === undefined) {
          return { text: 'mail_draft requires non-empty "to", "subject", and "body".', ok: false }
        }
        const res = await driver.createOrUpdateDraft(acc, {
          ...(draftId ? { draftId } : {}),
          to,
          ...(cc.length ? { cc } : {}),
          ...(bcc.length ? { bcc } : {}),
          subject,
          body,
        })
        return {
          text: JSON.stringify({
            ok: true,
            account: { id: acc.id, app: acc.app, label: acc.account_label || acc.id },
            draftId: res.draftId,
            summary: res.summary,
          }),
          ok: true,
        }
      }

      case 'calendar_list': {
        const start = optString(args.start)
        const end = optString(args.end)
        if (!start || !end) {
          return { text: 'calendar_list requires "start" and "end" ISO 8601 timestamps.', ok: false }
        }
        const query = optString(args.query)
        const limit = optPositiveInt(args.limit, 100)
        const res = await driver.listCalendarEvents(acc, {
          start,
          end,
          ...(query ? { query } : {}),
          ...(limit ? { limit } : {}),
        })
        return { text: formatReadJson(acc, res), ok: true, tainted: true }
      }

      case 'notion_search': {
        if (typeof args.query !== 'string') {
          return { text: 'notion_search requires a "query" string.', ok: false }
        }
        const limit = optPositiveInt(args.limit, 100)
        const res = await driver.searchNotion(acc, { query: args.query, ...(limit ? { limit } : {}) })
        return { text: formatReadJson(acc, res), ok: true, tainted: true }
      }

      case 'notion_read_page': {
        const pageId = optString(args.pageId)
        if (!pageId) return { text: 'notion_read_page requires "pageId".', ok: false }
        const res = await driver.readNotionPage(acc, pageId)
        return { text: formatReadJson(acc, res), ok: true, tainted: true }
      }

      case 'slack_list_channels': {
        const limit = optPositiveInt(args.limit, 200)
        const cursor = optString(args.cursor)
        const res = await driver.listSlackChannels(acc, {
          ...(limit ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
        })
        return { text: formatReadJson(acc, res), ok: true, tainted: true }
      }

      case 'slack_read_messages': {
        const channelId = optString(args.channelId)
        if (!channelId) return { text: 'slack_read_messages requires "channelId".', ok: false }
        const threadTs = optString(args.threadTs)
        const limit = optPositiveInt(args.limit, 100)
        const res = await driver.readSlackMessages(acc, {
          channelId,
          ...(threadTs ? { threadTs } : {}),
          ...(limit ? { limit } : {}),
        })
        return { text: formatReadJson(acc, res), ok: true, tainted: true }
      }

      default: {
        if (!CONNECTOR_WRITE_TOOL_NAMES.has(name)) {
          return { text: `Unknown connector tool: ${name}`, ok: false }
        }
        const writeTool = name as ConnectorWriteToolName
        const prepared = await prepareConnectorWrite(driver, acc, writeTool, args)
        if (!prepared.ok) {
          return { text: prepared.error, ok: false }
        }

        const operationId = randomUUID()
        const frozen: FrozenExecution = {
          version: 1,
          connectorId: acc.id,
          remoteId: acc.remote_id,
          app: acc.app as AppKey,
          accountLabel: acc.account_label || acc.id,
          tool: writeTool,
          args: prepared.frozenArgs,
          operationId,
        }
        const executionJson = JSON.stringify(frozen)
        const rulesAllowed = ruleBlock === null
        const match = findMatchingRule(db, { botId, kind: prepared.kind, target: prepared.target, now: at })
        const matchedRule = rulesAllowed ? match : null

        if (!matchedRule) {
          const approval = createApproval(db, {
            threadId,
            botId,
            action: prepared.action,
            detail: prepared.detail,
            kind: prepared.kind,
            target: prepared.target,
            executionJson,
            operationId,
            now: at,
          })
          const reason: BlockReason | null = RULEABLE_KINDS.has(prepared.kind)
            ? destinationReason(prepared.kind, prepared.target)
            : null
          const blocked = reason ? blockText(reason) : null
          events.onMessage(
            insertMessage(db, {
              threadId,
              sender: botId,
              kind: 'approval_request',
              payload: {
                approvalId: approval.id,
                action: prepared.action,
                detail: prepared.detail,
                kind: prepared.kind,
                target: prepared.target,
                status: 'pending',
                canRemember: canRemember({ kind: prepared.kind, target: prepared.target }),
                ...(blocked ? { rememberBlocked: blocked, rememberReason: reason } : {}),
                ...(match && ruleBlock ? { ruleHeld: ruleBlock } : {}),
              },
            }),
          )
          return {
            ok: true,
            text: `Held for operator approval (approval #${approval.id}). Stop here and wait — when your operator approves, the gateway sends this action directly.`,
          }
        }

        const approval = createApproval(db, {
          threadId,
          botId,
          action: prepared.action,
          detail: prepared.detail,
          kind: prepared.kind,
          target: prepared.target,
          ruleId: matchedRule.id,
          executionJson,
          operationId,
          now: at,
        })
        recordAction(db, {
          botId,
          threadId,
          trigger,
          tool: 'approval',
          summary: `allowed by your rule #${matchedRule.id}: ${prepared.action}`,
          at,
        })

        const execRes = await driver.executeWrite(frozen)
        const executionStatus = execRes.status
        const executionDetail =
          execRes.status === 'succeeded'
            ? execRes.summary
            : execRes.status === 'failed'
              ? execRes.error
              : execRes.detail
        recordApprovalExecution(db, approval.id, executionStatus, executionDetail)

        const ruleGrant: RuleGrant = {
          id: matchedRule.id,
          kind: matchedRule.kind,
          target: matchedRule.target,
          expiresAt: matchedRule.expires_at,
        }
        events.onMessage(
          insertMessage(db, {
            threadId,
            sender: botId,
            kind: 'approval_request',
            payload: {
              approvalId: approval.id,
              action: prepared.action,
              detail: prepared.detail,
              kind: prepared.kind,
              target: prepared.target,
              status: 'approved',
              rule: ruleGrant,
              executionStatus,
              executionDetail,
            },
          }),
        )

        if (execRes.status === 'failed' && execRes.authExpired) {
          handleConnectorAuthExpired({
            db,
            hub,
            threadId,
            botId,
            account: acc,
            error: execRes.error,
            now: at,
            onNotice: (m) => events.onMessage(m),
          })
        }
        if (execRes.status === 'failed' || execRes.status === 'uncertain') {
          emitNotice({
            notice: 'connector_execution',
            params: { status: execRes.status, action: prepared.action, detail: executionDetail },
          })
          return {
            ok: false,
            text:
              execRes.status === 'uncertain'
                ? `Pre-approved by standing rule, but outcome is unconfirmed: ${executionDetail}. Do NOT retry automatically to avoid duplicates.`
                : `Pre-approved by standing rule, but execution failed: ${executionDetail}`,
          }
        }
        return {
          ok: true,
          text: `Pre-approved by your operator and executed by the gateway: ${execRes.summary}`,
        }
      }
    }
  } catch (err) {
    if (err instanceof ConnectorDriverError && err.code === 'auth_expired') {
      handleConnectorAuthExpired({
        db,
        hub,
        threadId,
        botId,
        account: acc,
        error: err.message,
        now: at,
        onNotice: (m) => events.onMessage(m),
      })
      const appName = catalogByApp(acc.app)?.name ?? acc.app
      return {
        ok: false,
        text: `${appName} (${acc.account_label || acc.id}) authorization has expired: ${err.message}. Ask your operator to reconnect it in Connectors.`,
      }
    }
    return {
      ok: false,
      text: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
