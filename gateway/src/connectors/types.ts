export const APP_KEYS = ['gmail', 'outlook', 'google_calendar', 'outlook_calendar', 'notion', 'slack'] as const
export type AppKey = (typeof APP_KEYS)[number]
export type AppGroupId = 'mail_calendar' | 'productivity' | 'messaging'
export type ConnectorDomain = 'mail' | 'calendar' | 'notion' | 'slack'
export type ConnectorStatus = 'pending' | 'active' | 'expired' | 'failed'

export type CatalogApp = {
  app: AppKey
  name: string
  group: AppGroupId
  domain: ConnectorDomain
  toolkitSlug: string
  authScheme: 'OAUTH2'
}

export type ConnectorAccountRow = {
  id: string
  app: AppKey
  driver: string
  remote_id: string
  auth_config_id: string
  account_label: string
  status: ConnectorStatus
  last_error: string
  notified_expired: number
  created_at: number
  updated_at: number
}

export type MailSummary = {
  id: string
  threadId?: string
  from: string
  to: string[]
  subject: string
  date: string
  snippet: string
  unread: boolean
  automated: boolean
}

export type MailDetail = {
  id: string
  threadId?: string
  from: string
  replyTo?: string[]
  to: string[]
  cc: string[]
  bcc?: string[]
  subject: string
  date: string
  body: string
  automated: boolean
  attachments: { id: string; name: string; size?: number }[]
}

export type CalendarEventItem = {
  id: string
  title: string
  start: string
  end: string
  location?: string
  attendees: string[]
  description?: string
  status?: string
}

export type NotionPageSummary = { id: string; title: string; url?: string; updatedAt?: string }
export type SlackChannelItem = { id: string; name: string; isPrivate?: boolean }
export type SlackMessageItem = { ts: string; user: string; text: string; threadTs?: string }

export type ConnectorWriteToolName =
  | 'mail_send'
  | 'mail_reply'
  | 'mail_archive'
  | 'calendar_create_event'
  | 'calendar_update_event'
  | 'notion_create_page'
  | 'notion_append'
  | 'slack_send_message'

export type ResolvedDraftSnapshot = {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
}

export type MailReplyMeta = {
  to: string[]
  allCc: string[]
  subject: string
  threadId?: string
}

export type FrozenExecution = {
  version: 1
  connectorId: string
  remoteId: string
  app: AppKey
  accountLabel: string
  tool: ConnectorWriteToolName
  args: Record<string, unknown>
  resolvedDraftSnapshot?: ResolvedDraftSnapshot
  replyMeta?: MailReplyMeta
  operationId: string
}

export type WriteExecutionResult =
  | { status: 'succeeded'; summary: string }
  | { status: 'failed'; error: string; authExpired?: boolean }
  | { status: 'uncertain'; detail: string }

export class ConnectorDriverError extends Error {
  readonly code: 'unconfigured' | 'auth_expired' | 'rate_limited' | 'bad_request' | 'upstream' | 'timeout'
  readonly status?: number
  constructor(
    code: 'unconfigured' | 'auth_expired' | 'rate_limited' | 'bad_request' | 'upstream' | 'timeout',
    message: string,
    status?: number,
  ) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface ConnectorDriver {
  readonly id: string
  configured(): boolean
  testKey(candidateKey?: string): Promise<{ ok: true } | { ok: false; code: string; detail?: string }>
  startOAuth(input: { app: AppKey; callbackUrl: string; userKey: string }): Promise<{
    authConfigId: string
    remoteId: string
    redirectUrl: string
  }>
  inspectAccount(input: { app: AppKey; remoteId: string }): Promise<{
    status: ConnectorStatus
    accountLabel: string
  }>
  revokeAccount(input: { remoteId: string }): Promise<void>
  // Mail
  listMail(account: ConnectorAccountRow, opts: {
    folder?: 'inbox' | 'sent' | 'all'
    unread?: boolean
    query?: string
    includeAutomated?: boolean
    limit?: number
    cursor?: string
  }): Promise<{ messages: MailSummary[]; nextCursor?: string }>
  readMail(account: ConnectorAccountRow, sel: {
    messageId?: string
    threadId?: string
    draftId?: string
  }): Promise<{ messages: MailDetail[]; draftId?: string }>
  createOrUpdateDraft(account: ConnectorAccountRow, input: {
    draftId?: string
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    body: string
  }): Promise<{ draftId: string; summary: string }>
  // Calendar
  listCalendarEvents(account: ConnectorAccountRow, opts: {
    start: string
    end: string
    query?: string
    limit?: number
  }): Promise<{ events: CalendarEventItem[] }>
  // Notion
  searchNotion(account: ConnectorAccountRow, opts: { query: string; limit?: number }): Promise<{ pages: NotionPageSummary[] }>
  readNotionPage(account: ConnectorAccountRow, pageId: string): Promise<{ id: string; title: string; content: string }>
  // Slack
  listSlackChannels(account: ConnectorAccountRow, opts: { limit?: number; cursor?: string }): Promise<{ channels: SlackChannelItem[]; nextCursor?: string }>
  readSlackMessages(account: ConnectorAccountRow, opts: { channelId: string; threadTs?: string; limit?: number }): Promise<{ messages: SlackMessageItem[] }>
  // Gated Writes (single attempt, never auto-retried on timeout)
  executeWrite(frozen: FrozenExecution): Promise<WriteExecutionResult>
}
