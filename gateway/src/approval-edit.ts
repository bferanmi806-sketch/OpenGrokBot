import { normalizeTarget, type ApprovalRow } from './approvals.js'
import { catalogByApp } from './connectors/catalog.js'
import type { FrozenExecution, ResolvedDraftSnapshot } from './connectors/types.js'
import type { FrozenMcpExecution } from './mcp/types.js'

export const MAX_EDIT_TEXT_CHARS = 64_000
export const MAX_EDIT_ACTION_CHARS = 500
export const MAX_MCP_ARGS_BYTES = 128_000
export const MAX_EDITABLE_SCHEMA_BYTES = 32_768
export const MAX_DETAIL_BODY_CHARS = 4_000
export const MAX_EMAIL_ADDRESS_CHARS = 500
export const MAX_EMAIL_LIST_LENGTH = 100

const MAX_MCP_APPROVAL_DETAIL_CHARS = 1_200
const MCP_TRUNCATED_MARKER = '\n[…truncated]'
const MAX_MCP_JSON_DEPTH = 64
const HEADER_INJECTION_RE = /[\r\n]/
const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export type EditableMailSend = {
  kind: 'connector'
  tool: 'mail_send'
  accountLabel: string
  draftId?: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
}

export type EditableMailReply = {
  kind: 'connector'
  tool: 'mail_reply'
  accountLabel: string
  to: string[]
  /** Extra recipients that will be CC'd when replyAll is true */
  replyAllCc: string[]
  subject: string
  body: string
  replyAll: boolean
}

export type EditableSlackMessage = {
  kind: 'connector'
  tool: 'slack_send_message'
  accountLabel: string
  channelId: string
  threadTs?: string
  text: string
}

export type EditableNotionCreatePage = {
  kind: 'connector'
  tool: 'notion_create_page'
  accountLabel: string
  parentPageId: string
  title: string
  markdown: string
}

export type EditableNotionAppend = {
  kind: 'connector'
  tool: 'notion_append'
  accountLabel: string
  pageId: string
  markdown: string
}

export type EditableCalendarCreateEvent = {
  kind: 'connector'
  tool: 'calendar_create_event'
  accountLabel: string
  title: string
  start: string
  end: string
  location: string
  attendees: string[]
  description: string
}

export type EditableCalendarUpdateEvent = {
  kind: 'connector'
  tool: 'calendar_update_event'
  accountLabel: string
  eventId: string
  title?: string
  start?: string
  end?: string
  location?: string
  attendees?: string[]
  description?: string
}

export type EditableMcp = {
  kind: 'mcp'
  serverName: string
  toolName: string
  args: Record<string, unknown>
  /** Compact JSON Schema (omitted if serialized size exceeds 32 KB) */
  inputSchema?: Record<string, unknown>
}

export type EditablePrompt = {
  kind: 'prompt'
  action: string
  detail: string
}

export type ApprovalEditable =
  | EditableMailSend
  | EditableMailReply
  | EditableSlackMessage
  | EditableNotionCreatePage
  | EditableNotionAppend
  | EditableCalendarCreateEvent
  | EditableCalendarUpdateEvent
  | EditableMcp
  | EditablePrompt

export type MailSendEditInput = {
  kind: 'connector'
  tool: 'mail_send'
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
}

export type MailReplyEditInput = {
  kind: 'connector'
  tool: 'mail_reply'
  body: string
  replyAll?: boolean
}

export type SlackMessageEditInput = {
  kind: 'connector'
  tool: 'slack_send_message'
  channelId: string
  text: string
}

export type NotionCreatePageEditInput = {
  kind: 'connector'
  tool: 'notion_create_page'
  title: string
  markdown: string
}

export type NotionAppendEditInput = {
  kind: 'connector'
  tool: 'notion_append'
  markdown: string
}

export type CalendarCreateEventEditInput = {
  kind: 'connector'
  tool: 'calendar_create_event'
  title: string
  start: string
  end: string
  location?: string
  attendees?: string[]
  description?: string
}

export type CalendarUpdateEventEditInput = {
  kind: 'connector'
  tool: 'calendar_update_event'
  title?: string
  start?: string
  end?: string
  location?: string
  attendees?: string[]
  description?: string
}

export type ConnectorEditInput =
  | MailSendEditInput
  | MailReplyEditInput
  | SlackMessageEditInput
  | NotionCreatePageEditInput
  | NotionAppendEditInput
  | CalendarCreateEventEditInput
  | CalendarUpdateEventEditInput

export type McpEditInput = {
  kind: 'mcp'
  args: Record<string, unknown>
}

export type PromptEditInput = {
  kind: 'prompt'
  action: string
  detail: string
}

export type ApprovalEditInput = ConnectorEditInput | McpEditInput | PromptEditInput

export type DraftUpdateRequest = {
  draftId: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
}

export type AppliedApprovalEdit = {
  action: string
  detail: string
  target: string
  executionJson?: string
  editable: ApprovalEditable
  changed: boolean
  draftToctouSnapshot?: ResolvedDraftSnapshot
  draftUpdate?: DraftUpdateRequest
}

export type ApplyApprovalEditResult =
  | { ok: true; applied: AppliedApprovalEdit }
  | { ok: false; error: string }

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false
  const proto = Object.getPrototypeOf(val)
  return proto === Object.prototype || proto === null
}

function optString(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined
  const t = val.trim()
  return t ? t : undefined
}

function cleanStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  return val.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text
}

function truncateMcpBounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let keep = Math.max(0, maxChars - MCP_TRUNCATED_MARKER.length)
  if (keep > 0) {
    const code = text.charCodeAt(keep - 1)
    if (code >= 0xd800 && code <= 0xdbff) keep -= 1
  }
  return `${text.slice(0, keep)}${MCP_TRUNCATED_MARKER}`
}

export function formatMcpWriteApprovalDetail(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) return '(no arguments)'
  try {
    return truncateMcpBounded(JSON.stringify(args, null, 2), MAX_MCP_APPROVAL_DETAIL_CHARS)
  } catch {
    return '(unserializable arguments)'
  }
}

/** Matches `connectors/tools.ts` accountDisplay + `Account: ` prefix exactly. */
function formatConnectorAccountLine(frozen: Pick<FrozenExecution, 'connectorId' | 'app' | 'accountLabel'>): string {
  const appName = catalogByApp(frozen.app)?.name ?? frozen.app
  const label = frozen.accountLabel || frozen.connectorId
  return `Account: ${appName} · ${label} (${frozen.connectorId})`
}

/** Matches `connectors/tools.ts` extractSingleEmailTarget exactly. */
function extractSingleEmailTarget(raw: string): string {
  const trimmed = raw.trim()
  if (/[,;|\n]/.test(trimmed)) return normalizeTarget(trimmed)
  const angle = trimmed.match(/^[^<>@,;]*<([^<>@\s,;]+@[^<>@\s,;]+)>\s*$/)
  if (angle) return normalizeTarget(angle[1]!)
  return normalizeTarget(trimmed)
}

function computeEmailTarget(to: readonly string[], cc: readonly string[], bcc: readonly string[]): string {
  if (to.length === 1 && cc.length === 0 && bcc.length === 0) {
    return extractSingleEmailTarget(to[0]!)
  }
  return normalizeTarget([...to, ...cc, ...bcc].join(', '))
}

function assertAllowedKeys(raw: Record<string, unknown>, allowed: readonly string[]): string | null {
  const allowedSet = new Set(allowed)
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (FORBIDDEN_PROTO_KEYS.has(key)) {
      return `Edit payload cannot contain forbidden key "${key}".`
    }
    if (!allowedSet.has(key)) {
      return `Field "${key}" cannot be edited.`
    }
  }
  return null
}

function validateSingleLineString(
  raw: unknown,
  field: string,
  opts: { required: boolean; maxChars?: number },
): { ok: true; value: string } | { ok: false; error: string } {
  const max = opts.maxChars ?? MAX_EDIT_ACTION_CHARS
  if (typeof raw !== 'string') {
    return { ok: false, error: `"${field}" must be a string.` }
  }
  if (HEADER_INJECTION_RE.test(raw)) {
    return { ok: false, error: `"${field}" cannot contain line breaks.` }
  }
  const trimmed = raw.trim()
  if (opts.required && !trimmed) {
    return { ok: false, error: `"${field}" cannot be empty.` }
  }
  if (trimmed.length > max) {
    return { ok: false, error: `"${field}" must be at most ${max} characters.` }
  }
  return { ok: true, value: trimmed }
}

function validateMultilineText(
  raw: unknown,
  field: string,
  opts: { requiredNonEmpty: boolean; trimOutput?: boolean },
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: `"${field}" must be a string.` }
  }
  if (raw.length > MAX_EDIT_TEXT_CHARS) {
    return { ok: false, error: `"${field}" must be at most ${MAX_EDIT_TEXT_CHARS} characters.` }
  }
  if (opts.requiredNonEmpty && !raw.trim()) {
    return { ok: false, error: `"${field}" cannot be empty.` }
  }
  return { ok: true, value: opts.trimOutput ? raw.trim() : raw }
}

function validateAddressList(
  raw: unknown,
  field: string,
  opts: { required: boolean },
): { ok: true; list: string[] } | { ok: false; error: string } {
  if (raw === undefined) {
    if (opts.required) {
      return { ok: false, error: `"${field}" must be an array of addresses.` }
    }
    return { ok: true, list: [] }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: `"${field}" must be an array of addresses.` }
  }
  if (raw.length > MAX_EMAIL_LIST_LENGTH) {
    return { ok: false, error: `"${field}" cannot have more than ${MAX_EMAIL_LIST_LENGTH} entries.` }
  }
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return { ok: false, error: `Each entry in "${field}" must be a string.` }
    }
    if (HEADER_INJECTION_RE.test(entry)) {
      return { ok: false, error: `"${field}" entries cannot contain CR or LF characters.` }
    }
    const trimmed = entry.trim()
    if (!trimmed) {
      return { ok: false, error: `Each entry in "${field}" must be a non-empty string.` }
    }
    if (trimmed.length > MAX_EMAIL_ADDRESS_CHARS) {
      return { ok: false, error: `Each entry in "${field}" must be at most ${MAX_EMAIL_ADDRESS_CHARS} characters.` }
    }
    out.push(trimmed)
  }
  if (opts.required && out.length === 0) {
    return { ok: false, error: `"${field}" must contain at least one recipient.` }
  }
  return { ok: true, list: out }
}

function validateMcpJsonValue(val: unknown, depth: number, seen: Set<object>): string | null {
  if (depth > MAX_MCP_JSON_DEPTH) {
    return `MCP arguments exceed maximum nesting depth (${MAX_MCP_JSON_DEPTH}).`
  }
  if (val === null || typeof val === 'string' || typeof val === 'boolean') return null
  if (typeof val === 'number') {
    return Number.isFinite(val) ? null : 'MCP arguments cannot contain non-finite numbers.'
  }
  if (typeof val !== 'object') {
    return 'MCP arguments must contain only JSON values.'
  }
  if (seen.has(val)) {
    return 'MCP arguments cannot contain circular references.'
  }
  seen.add(val)
  try {
    if (Array.isArray(val)) {
      for (const item of val) {
        const err = validateMcpJsonValue(item, depth + 1, seen)
        if (err) return err
      }
      return null
    }
    const proto = Object.getPrototypeOf(val)
    if (proto !== Object.prototype && proto !== null) {
      return 'MCP arguments must contain only plain JSON objects.'
    }
    for (const key of Object.getOwnPropertyNames(val)) {
      if (FORBIDDEN_PROTO_KEYS.has(key)) {
        return `MCP arguments cannot contain forbidden key "${key}".`
      }
      const err = validateMcpJsonValue((val as Record<string, unknown>)[key], depth + 1, seen)
      if (err) return err
    }
    return null
  } finally {
    seen.delete(val)
  }
}

function deepJsonEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > MAX_MCP_JSON_DEPTH) return false
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, idx) => deepJsonEqual(item, b[idx], depth + 1))
  }
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined)
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.hasOwn(objB, key) || objB[key] === undefined) return false
    if (!deepJsonEqual(objA[key], objB[key], depth + 1)) return false
  }
  return true
}

function cloneJsonObjectSafe(val: unknown): Record<string, unknown> {
  if (!isPlainObject(val)) return {}
  try {
    const serialized = JSON.stringify(val)
    if (typeof serialized !== 'string') return {}
    const parsed = JSON.parse(serialized) as unknown
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function buildConnectorEditable(frozen: FrozenExecution): ApprovalEditable | undefined {
  if (!isPlainObject(frozen.args)) return undefined
  const args = frozen.args
  const accountLabel = frozen.accountLabel

  switch (frozen.tool) {
    case 'mail_send': {
      const draftId = optString(args.draftId)
      if (draftId) {
        const snap = frozen.resolvedDraftSnapshot
        if (!snap || !Array.isArray(snap.to) || typeof snap.subject !== 'string' || typeof snap.body !== 'string') {
          return undefined
        }
        const to = cleanStringArray(snap.to)
        if (!to.length || snap.body.length > MAX_EDIT_TEXT_CHARS) return undefined
        return {
          kind: 'connector',
          tool: 'mail_send',
          accountLabel,
          draftId,
          to,
          cc: cleanStringArray(snap.cc),
          bcc: cleanStringArray(snap.bcc),
          subject: snap.subject,
          body: snap.body,
        }
      }
      const to = cleanStringArray(args.to)
      const subject = typeof args.subject === 'string' ? args.subject : undefined
      const body = typeof args.body === 'string' ? args.body : undefined
      if (!to.length || subject === undefined || body === undefined || body.length > MAX_EDIT_TEXT_CHARS) {
        return undefined
      }
      return {
        kind: 'connector',
        tool: 'mail_send',
        accountLabel,
        to,
        cc: cleanStringArray(args.cc),
        bcc: cleanStringArray(args.bcc),
        subject,
        body,
      }
    }

    case 'mail_reply': {
      const messageId = optString(args.messageId)
      const body = typeof args.body === 'string' ? args.body : undefined
      const meta = frozen.replyMeta
      if (!messageId || body === undefined || body.length > MAX_EDIT_TEXT_CHARS) return undefined
      if (!meta || !Array.isArray(meta.to) || typeof meta.subject !== 'string') return undefined
      const to = cleanStringArray(meta.to)
      if (!to.length) return undefined
      return {
        kind: 'connector',
        tool: 'mail_reply',
        accountLabel,
        to,
        replyAllCc: cleanStringArray(meta.allCc),
        subject: meta.subject,
        body,
        replyAll: args.replyAll === true,
      }
    }

    case 'slack_send_message': {
      const channelId = optString(args.channelId)
      const text = typeof args.text === 'string' ? args.text : undefined
      const threadTs = optString(args.threadTs)
      if (!channelId || text === undefined || text.length > MAX_EDIT_TEXT_CHARS) return undefined
      return {
        kind: 'connector',
        tool: 'slack_send_message',
        accountLabel,
        channelId,
        ...(threadTs ? { threadTs } : {}),
        text,
      }
    }

    case 'notion_create_page': {
      const parentPageId = optString(args.parentPageId)
      const title = optString(args.title)
      const markdown = typeof args.markdown === 'string' ? args.markdown : undefined
      if (!parentPageId || !title || markdown === undefined || markdown.length > MAX_EDIT_TEXT_CHARS) {
        return undefined
      }
      return {
        kind: 'connector',
        tool: 'notion_create_page',
        accountLabel,
        parentPageId,
        title,
        markdown,
      }
    }

    case 'notion_append': {
      const pageId = optString(args.pageId)
      const markdown = typeof args.markdown === 'string' ? args.markdown : undefined
      if (!pageId || markdown === undefined || markdown.length > MAX_EDIT_TEXT_CHARS) return undefined
      return {
        kind: 'connector',
        tool: 'notion_append',
        accountLabel,
        pageId,
        markdown,
      }
    }

    case 'calendar_create_event': {
      const title = optString(args.title)
      const start = optString(args.start)
      const end = optString(args.end)
      const description = typeof args.description === 'string' ? args.description : ''
      if (!title || !start || !end || description.length > MAX_EDIT_TEXT_CHARS) return undefined
      return {
        kind: 'connector',
        tool: 'calendar_create_event',
        accountLabel,
        title,
        start,
        end,
        location: typeof args.location === 'string' ? args.location.trim() : '',
        attendees: cleanStringArray(args.attendees),
        description,
      }
    }

    case 'calendar_update_event': {
      const eventId = optString(args.eventId)
      if (!eventId) return undefined
      const out: EditableCalendarUpdateEvent = {
        kind: 'connector',
        tool: 'calendar_update_event',
        accountLabel,
        eventId,
      }
      let hasField = false
      if (typeof args.title === 'string' && args.title.trim()) {
        out.title = args.title.trim()
        hasField = true
      }
      if (typeof args.start === 'string' && args.start.trim()) {
        out.start = args.start.trim()
        hasField = true
      }
      if (typeof args.end === 'string' && args.end.trim()) {
        out.end = args.end.trim()
        hasField = true
      }
      if (typeof args.location === 'string') {
        out.location = args.location.trim()
        hasField = true
      }
      if (Array.isArray(args.attendees)) {
        out.attendees = cleanStringArray(args.attendees)
        hasField = true
      }
      if (typeof args.description === 'string') {
        if (args.description.length > MAX_EDIT_TEXT_CHARS) return undefined
        out.description = args.description
        hasField = true
      }
      return hasField ? out : undefined
    }

    case 'mail_archive':
    default:
      return undefined
  }
}

export function buildMcpEditable(
  frozen: FrozenMcpExecution,
  inputSchema?: Record<string, unknown>,
): EditableMcp | undefined {
  if (!isPlainObject(frozen.args)) return undefined
  let args: Record<string, unknown>
  try {
    const serializedArgs = JSON.stringify(frozen.args)
    if (typeof serializedArgs !== 'string' || Buffer.byteLength(serializedArgs, 'utf8') > MAX_MCP_ARGS_BYTES) {
      return undefined
    }
    const parsedArgs = JSON.parse(serializedArgs) as unknown
    if (!isPlainObject(parsedArgs) || validateMcpJsonValue(parsedArgs, 0, new Set()) !== null) {
      return undefined
    }
    args = parsedArgs
  } catch {
    return undefined
  }

  let safeSchema: Record<string, unknown> | undefined
  if (inputSchema && isPlainObject(inputSchema)) {
    try {
      const serialized = JSON.stringify(inputSchema)
      if (typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= MAX_EDITABLE_SCHEMA_BYTES) {
        const parsed = JSON.parse(serialized) as unknown
        if (isPlainObject(parsed)) safeSchema = parsed
      }
    } catch {
      safeSchema = undefined
    }
  }
  return {
    kind: 'mcp',
    serverName: frozen.serverName,
    toolName: frozen.toolName,
    args,
    ...(safeSchema ? { inputSchema: safeSchema } : {}),
  }
}

export function buildPromptEditable(action: string, detail: string): EditablePrompt | undefined {
  const trimmedAction = action.trim()
  if (!trimmedAction || trimmedAction.length > MAX_EDIT_ACTION_CHARS || detail.length > MAX_EDIT_TEXT_CHARS) {
    return undefined
  }
  return {
    kind: 'prompt',
    action: trimmedAction,
    detail,
  }
}

function applyPromptEdit(approval: ApprovalRow, raw: Record<string, unknown>): ApplyApprovalEditResult {
  if (raw.kind !== 'prompt') {
    return { ok: false, error: 'Edit kind must be "prompt" for this approval.' }
  }
  const keyErr = assertAllowedKeys(raw, ['kind', 'action', 'detail'])
  if (keyErr) return { ok: false, error: keyErr }

  const actionRes = validateSingleLineString(raw.action, 'action', { required: true })
  if (!actionRes.ok) return actionRes

  const detailRes = validateMultilineText(raw.detail, 'detail', { requiredNonEmpty: false, trimOutput: true })
  if (!detailRes.ok) return detailRes

  const action = actionRes.value
  const detail = detailRes.value
  const changed = action !== approval.action || detail !== approval.detail
  const finalAction = changed ? action : approval.action
  const finalDetail = changed ? detail : approval.detail
  return {
    ok: true,
    applied: {
      action: finalAction,
      detail: finalDetail,
      target: approval.target,
      editable: { kind: 'prompt', action: finalAction, detail: finalDetail },
      changed,
    },
  }
}

function applyMcpEdit(
  approval: ApprovalRow,
  frozen: FrozenMcpExecution,
  raw: Record<string, unknown>,
): ApplyApprovalEditResult {
  if (raw.kind !== 'mcp') {
    return { ok: false, error: 'Edit kind must be "mcp" for this approval.' }
  }
  const keyErr = assertAllowedKeys(raw, ['kind', 'args'])
  if (keyErr) return { ok: false, error: keyErr }

  if (!isPlainObject(raw.args)) {
    return { ok: false, error: 'MCP edit "args" must be a plain JSON object.' }
  }
  const valErr = validateMcpJsonValue(raw.args, 0, new Set())
  if (valErr) return { ok: false, error: valErr }

  let serializedArgs: string
  try {
    serializedArgs = JSON.stringify(raw.args)
  } catch {
    return { ok: false, error: 'MCP edit "args" could not be serialized as JSON.' }
  }
  if (Buffer.byteLength(serializedArgs, 'utf8') > MAX_MCP_ARGS_BYTES) {
    return { ok: false, error: `MCP arguments must be at most ${MAX_MCP_ARGS_BYTES} bytes.` }
  }
  const nextArgs = JSON.parse(serializedArgs) as Record<string, unknown>
  const prevArgs = isPlainObject(frozen.args) ? frozen.args : {}
  const changed = !deepJsonEqual(prevArgs, nextArgs)

  if (!changed) {
    return {
      ok: true,
      applied: {
        action: approval.action,
        detail: approval.detail,
        target: approval.target,
        executionJson: approval.execution_json ?? JSON.stringify({ ...frozen, args: prevArgs }),
        editable: {
          kind: 'mcp',
          serverName: frozen.serverName,
          toolName: frozen.toolName,
          args: cloneJsonObjectSafe(prevArgs),
        },
        changed: false,
      },
    }
  }

  const action =
    frozen.serverName && frozen.toolName ? `${frozen.serverName} · ${frozen.toolName}` : approval.action
  const detail = formatMcpWriteApprovalDetail(nextArgs)
  const target =
    frozen.serverSlug && frozen.toolName ? `mcp:${frozen.serverSlug}/${frozen.toolName}` : approval.target
  const nextExecutionJson = JSON.stringify({ ...frozen, args: nextArgs })

  return {
    ok: true,
    applied: {
      action,
      detail,
      target,
      executionJson: nextExecutionJson,
      editable: {
        kind: 'mcp',
        serverName: frozen.serverName,
        toolName: frozen.toolName,
        args: cloneJsonObjectSafe(nextArgs),
      },
      changed: true,
    },
  }
}

function applyConnectorEdit(
  approval: ApprovalRow,
  frozen: FrozenExecution,
  raw: Record<string, unknown>,
): ApplyApprovalEditResult {
  if (frozen.tool === 'mail_archive') {
    return { ok: false, error: 'mail_archive approvals cannot be edited.' }
  }
  if (raw.kind !== 'connector') {
    return { ok: false, error: 'Edit kind must be "connector" for this approval.' }
  }
  if (raw.tool !== frozen.tool) {
    return { ok: false, error: `Edit tool must match "${frozen.tool}".` }
  }
  if (!isPlainObject(frozen.args)) {
    return { ok: false, error: 'Invalid stored connector execution arguments.' }
  }

  const label = frozen.accountLabel || frozen.connectorId
  const acctLine = formatConnectorAccountLine(frozen)

  switch (frozen.tool) {
    case 'mail_send': {
      const keyErr = assertAllowedKeys(raw, ['kind', 'tool', 'to', 'cc', 'bcc', 'subject', 'body'])
      if (keyErr) return { ok: false, error: keyErr }

      const toRes = validateAddressList(raw.to, 'to', { required: true })
      if (!toRes.ok) return toRes
      const ccRes = validateAddressList(raw.cc, 'cc', { required: false })
      if (!ccRes.ok) return ccRes
      const bccRes = validateAddressList(raw.bcc, 'bcc', { required: false })
      if (!bccRes.ok) return bccRes
      const subjectRes = validateSingleLineString(raw.subject, 'subject', { required: true })
      if (!subjectRes.ok) return subjectRes
      const bodyRes = validateMultilineText(raw.body, 'body', { requiredNonEmpty: true })
      if (!bodyRes.ok) return bodyRes

      const to = toRes.list
      const cc = ccRes.list
      const bcc = bccRes.list
      const subject = subjectRes.value
      const body = bodyRes.value
      const target = computeEmailTarget(to, cc, bcc)
      const action = `Send email via ${label} to ${to.join(', ')}`

      const draftId = optString(frozen.args.draftId)
      if (draftId) {
        const prevSnap = frozen.resolvedDraftSnapshot
        if (
          !prevSnap ||
          !Array.isArray(prevSnap.to) ||
          typeof prevSnap.subject !== 'string' ||
          typeof prevSnap.body !== 'string'
        ) {
          return { ok: false, error: `Draft "${draftId}" is missing its approval snapshot and cannot be edited.` }
        }
        const draftToctouSnapshot: ResolvedDraftSnapshot = {
          to: cleanStringArray(prevSnap.to),
          cc: cleanStringArray(prevSnap.cc),
          bcc: cleanStringArray(prevSnap.bcc),
          subject: prevSnap.subject,
          body: prevSnap.body,
        }
        const changed =
          !sameStringArray(draftToctouSnapshot.to, to) ||
          !sameStringArray(draftToctouSnapshot.cc, cc) ||
          !sameStringArray(draftToctouSnapshot.bcc, bcc) ||
          draftToctouSnapshot.subject.trim() !== subject ||
          draftToctouSnapshot.body !== body

        const headerLines = [
          acctLine,
          `Draft: ${draftId}`,
          `To: ${to.join(', ')}`,
          ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
          ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
          `Subject: ${subject}`,
        ]
        const detail = `${headerLines.join('\n')}\n\n${truncateText(body, MAX_DETAIL_BODY_CHARS)}`
        const nextSnapshot: ResolvedDraftSnapshot = {
          to: [...to],
          cc: [...cc],
          bcc: [...bcc],
          subject,
          body,
        }
        const nextFrozen: FrozenExecution = {
          ...frozen,
          args: { draftId },
          resolvedDraftSnapshot: nextSnapshot,
        }
        const executionJson = changed
          ? JSON.stringify(nextFrozen)
          : (approval.execution_json ?? JSON.stringify(nextFrozen))

        return {
          ok: true,
          applied: {
            action: changed ? action : approval.action,
            detail: changed ? detail : approval.detail,
            target: changed ? target : approval.target,
            executionJson,
            editable: {
              kind: 'connector',
              tool: 'mail_send',
              accountLabel: frozen.accountLabel,
              draftId,
              to: [...to],
              cc: [...cc],
              bcc: [...bcc],
              subject: changed ? subject : draftToctouSnapshot.subject,
              body,
            },
            changed,
            draftToctouSnapshot,
            ...(changed ? { draftUpdate: { draftId, to: [...to], cc: [...cc], bcc: [...bcc], subject, body } } : {}),
          },
        }
      }

      const prevTo = cleanStringArray(frozen.args.to)
      const prevCc = cleanStringArray(frozen.args.cc)
      const prevBcc = cleanStringArray(frozen.args.bcc)
      const prevSubject = typeof frozen.args.subject === 'string' ? frozen.args.subject.trim() : ''
      const prevBody = typeof frozen.args.body === 'string' ? frozen.args.body : ''
      const changed =
        !sameStringArray(prevTo, to) ||
        !sameStringArray(prevCc, cc) ||
        !sameStringArray(prevBcc, bcc) ||
        prevSubject !== subject ||
        prevBody !== body

      const headerLines = [
        acctLine,
        `To: ${to.join(', ')}`,
        ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
        ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
        `Subject: ${subject}`,
      ]
      const detail = `${headerLines.join('\n')}\n\n${truncateText(body, MAX_DETAIL_BODY_CHARS)}`
      const nextArgs: Record<string, unknown> = {
        to: [...to],
        ...(cc.length ? { cc: [...cc] } : {}),
        ...(bcc.length ? { bcc: [...bcc] } : {}),
        subject,
        body,
      }
      const nextFrozen: FrozenExecution = { ...frozen, args: nextArgs }
      const executionJson = changed
        ? JSON.stringify(nextFrozen)
        : (approval.execution_json ?? JSON.stringify(nextFrozen))

      return {
        ok: true,
        applied: {
          action: changed ? action : approval.action,
          detail: changed ? detail : approval.detail,
          target: changed ? target : approval.target,
          executionJson,
          editable: {
            kind: 'connector',
            tool: 'mail_send',
            accountLabel: frozen.accountLabel,
            to: [...to],
            cc: [...cc],
            bcc: [...bcc],
            subject,
            body,
          },
          changed,
        },
      }
    }

    case 'mail_reply': {
      const keyErr = assertAllowedKeys(raw, ['kind', 'tool', 'body', 'replyAll'])
      if (keyErr) return { ok: false, error: keyErr }

      const messageId = optString(frozen.args.messageId)
      if (!messageId) {
        return { ok: false, error: 'Stored mail_reply payload is missing "messageId".' }
      }
      const bodyRes = validateMultilineText(raw.body, 'body', { requiredNonEmpty: true })
      if (!bodyRes.ok) return bodyRes
      if (raw.replyAll !== undefined && typeof raw.replyAll !== 'boolean') {
        return { ok: false, error: '"replyAll" must be a boolean.' }
      }

      const prevReplyAll = frozen.args.replyAll === true
      const nextReplyAll = raw.replyAll !== undefined ? raw.replyAll : prevReplyAll
      const prevBody = typeof frozen.args.body === 'string' ? frozen.args.body : ''
      const body = bodyRes.value
      const changed = body !== prevBody || nextReplyAll !== prevReplyAll

      const nextArgs: Record<string, unknown> = {
        messageId,
        body,
        ...(nextReplyAll ? { replyAll: true } : {}),
      }
      const nextFrozen: FrozenExecution = { ...frozen, args: nextArgs }
      const executionJson = changed
        ? JSON.stringify(nextFrozen)
        : (approval.execution_json ?? JSON.stringify(nextFrozen))

      const meta = frozen.replyMeta
      const hasMeta = Boolean(meta && Array.isArray(meta.to) && cleanStringArray(meta.to).length > 0 && typeof meta.subject === 'string')
      if (!hasMeta) {
        if (nextReplyAll !== prevReplyAll) {
          return { ok: false, error: 'Cannot change "replyAll" on a legacy mail_reply approval without reply metadata.' }
        }
        const sepIdx = approval.detail.indexOf('\n\n')
        const detail =
          sepIdx >= 0
            ? `${approval.detail.slice(0, sepIdx)}\n\n${truncateText(body, MAX_DETAIL_BODY_CHARS)}`
            : `${acctLine}\nIn-Reply-To: ${messageId}\n\n${truncateText(body, MAX_DETAIL_BODY_CHARS)}`
        return {
          ok: true,
          applied: {
            action: approval.action,
            detail: changed ? detail : approval.detail,
            target: approval.target,
            executionJson,
            editable: {
              kind: 'connector',
              tool: 'mail_reply',
              accountLabel: frozen.accountLabel,
              to: [],
              replyAllCc: [],
              subject: '',
              body,
              replyAll: nextReplyAll,
            },
            changed,
          },
        }
      }

      const to = cleanStringArray(meta!.to)
      const allCc = cleanStringArray(meta!.allCc)
      const cc = nextReplyAll ? allCc : []
      const allRecipients = [...to, ...cc]
      const target = computeEmailTarget(to, cc, [])
      const action = `Reply via ${label} to ${allRecipients.join(', ')}`
      const headerLines = [
        acctLine,
        `In-Reply-To: ${messageId}${meta!.threadId ? ` (thread ${meta!.threadId})` : ''}`,
        `To: ${to.join(', ')}`,
        ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
        `Subject: ${meta!.subject}`,
      ]
      const detail = `${headerLines.join('\n')}\n\n${truncateText(body, MAX_DETAIL_BODY_CHARS)}`

      return {
        ok: true,
        applied: {
          action: changed ? action : approval.action,
          detail: changed ? detail : approval.detail,
          target: changed ? target : approval.target,
          executionJson,
          editable: {
            kind: 'connector',
            tool: 'mail_reply',
            accountLabel: frozen.accountLabel,
            to: [...to],
            replyAllCc: [...allCc],
            subject: meta!.subject,
            body,
            replyAll: nextReplyAll,
          },
          changed,
        },
      }
    }

    case 'slack_send_message': {
      const keyErr = assertAllowedKeys(raw, ['kind', 'tool', 'channelId', 'text'])
      if (keyErr) return { ok: false, error: keyErr }

      const channelRes = validateSingleLineString(raw.channelId, 'channelId', { required: true })
      if (!channelRes.ok) return channelRes
      const textRes = validateMultilineText(raw.text, 'text', { requiredNonEmpty: true })
      if (!textRes.ok) return textRes

      const channelId = channelRes.value
      const text = textRes.value
      const threadTs = optString(frozen.args.threadTs)
      const prevChannelId = optString(frozen.args.channelId) ?? ''
      const prevText = typeof frozen.args.text === 'string' ? frozen.args.text : ''
      const changed = channelId !== prevChannelId || text !== prevText

      const lines = [acctLine, `Channel: ${channelId}`, ...(threadTs ? [`Thread: ${threadTs}`] : [])]
      const action = `Post Slack message to ${channelId} (${label})`
      const detail = `${lines.join('\n')}\n\n${truncateText(text, MAX_DETAIL_BODY_CHARS)}`
      const target = normalizeTarget(`${label}:${channelId}`)
      const nextArgs: Record<string, unknown> = { channelId, text, ...(threadTs ? { threadTs } : {}) }
      const nextFrozen: FrozenExecution = { ...frozen, args: nextArgs }
      const executionJson = changed
        ? JSON.stringify(nextFrozen)
        : (approval.execution_json ?? JSON.stringify(nextFrozen))

      return {
        ok: true,
        applied: {
          action: changed ? action : approval.action,
          detail: changed ? detail : approval.detail,
          target: changed ? target : approval.target,
          executionJson,
          editable: {
            kind: 'connector',
            tool: 'slack_send_message',
            accountLabel: frozen.accountLabel,
            channelId,
            ...(threadTs ? { threadTs } : {}),
            text,
          },
          changed,
        },
      }
    }

    case 'notion_create_page': {
      const keyErr = assertAllowedKeys(raw, ['kind', 'tool', 'title', 'markdown'])
      if (keyErr) return { ok: false, error: keyErr }

      const parentPageId = optString(frozen.args.parentPageId)
      if (!parentPageId) {
        return { ok: false, error: 'Stored notion_create_page payload is missing "parentPageId".' }
      }
      const titleRes = validateSingleLineString(raw.title, 'title', { required: true })
      if (!titleRes.ok) return titleRes
      const markdownRes = validateMultilineText(raw.markdown, 'markdown', { requiredNonEmpty: false })
      if (!markdownRes.ok) return markdownRes

      const title = titleRes.value
      const markdown = markdownRes.value
      const prevTitle = optString(frozen.args.title) ?? ''
      const prevMarkdown = typeof frozen.args.markdown === 'string' ? frozen.args.markdown : ''
      const changed = title !== prevTitle || markdown !== prevMarkdown

      const lines = [acctLine, `Parent Page: ${parentPageId}`, `Title: ${title}`]
      const action = `Create Notion page "${title}" in ${label}`
      const detail = markdown.trim()
        ? `${lines.join('\n')}\n\n${truncateText(markdown, MAX_DETAIL_BODY_CHARS)}`
        : lines.join('\n')
      const target = normalizeTarget(`notion/${parentPageId}`)
      const nextArgs: Record<string, unknown> = { parentPageId, title, markdown }
      const nextFrozen: FrozenExecution = { ...frozen, args: nextArgs }
      const executionJson = changed
        ? JSON.stringify(nextFrozen)
        : (approval.execution_json ?? JSON.stringify(nextFrozen))

      return {
        ok: true,
        applied: {
          action: changed ? action : approval.action,
          detail: changed ? detail : approval.detail,
          target: changed ? target : approval.target,
          executionJson,
          editable: {
            kind: 'connector',
            tool: 'notion_create_page',
            accountLabel: frozen.accountLabel,
            parentPageId,
            title,
            markdown,
          },
          changed,
        },
      }
    }

    case 'notion_append': {
      const keyErr = assertAllowedKeys(raw, ['kind', 'tool', 'markdown'])
      if (keyErr) return { ok: false, error: keyErr }

      const pageId = optString(frozen.args.pageId)
      if (!pageId) {
        return { ok: false, error: 'Stored notion_append payload is missing "pageId".' }
      }
      const markdownRes = validateMultilineText(raw.markdown, 'markdown', { requiredNonEmpty: true })
      if (!markdownRes.ok) return markdownRes

      const markdown = markdownRes.value
      const prevMarkdown = typeof frozen.args.markdown === 'string' ? frozen.args.markdown : ''
      const changed = markdown !== prevMarkdown

      const action = `Append to Notion page ${pageId} in ${label}`
      const detail = `${acctLine}\nPage ID: ${pageId}\n\n${truncateText(markdown, MAX_DETAIL_BODY_CHARS)}`
      const target = normalizeTarget(`notion/${pageId}`)
      const nextArgs: Record<string, unknown> = { pageId, markdown }
      const nextFrozen: FrozenExecution = { ...frozen, args: nextArgs }
      const executionJson = changed
        ? JSON.stringify(nextFrozen)
        : (approval.execution_json ?? JSON.stringify(nextFrozen))

      return {
        ok: true,
        applied: {
          action: changed ? action : approval.action,
          detail: changed ? detail : approval.detail,
          target: changed ? target : approval.target,
          executionJson,
          editable: {
            kind: 'connector',
            tool: 'notion_append',
            accountLabel: frozen.accountLabel,
            pageId,
            markdown,
          },
          changed,
        },
      }
    }

    case 'calendar_create_event': {
      const keyErr = assertAllowedKeys(raw, [
        'kind',
        'tool',
        'title',
        'start',
        'end',
        'location',
        'attendees',
        'description',
      ])
      if (keyErr) return { ok: false, error: keyErr }

      const titleRes = validateSingleLineString(raw.title, 'title', { required: true })
      if (!titleRes.ok) return titleRes
      const startRes = validateSingleLineString(raw.start, 'start', { required: true })
      if (!startRes.ok) return startRes
      const endRes = validateSingleLineString(raw.end, 'end', { required: true })
      if (!endRes.ok) return endRes

      let location: string | undefined
      if (raw.location !== undefined) {
        const locRes = validateSingleLineString(raw.location, 'location', { required: false })
        if (!locRes.ok) return locRes
        location = locRes.value || undefined
      }

      const attendeesRes = validateAddressList(raw.attendees, 'attendees', { required: false })
      if (!attendeesRes.ok) return attendeesRes
      const attendees = attendeesRes.list

      let description: string | undefined
      if (raw.description !== undefined) {
        const descRes = validateMultilineText(raw.description, 'description', {
          requiredNonEmpty: false,
          trimOutput: true,
        })
        if (!descRes.ok) return descRes
        description = descRes.value || undefined
      }

      const title = titleRes.value
      const start = startRes.value
      const end = endRes.value

      const prevTitle = optString(frozen.args.title) ?? ''
      const prevStart = optString(frozen.args.start) ?? ''
      const prevEnd = optString(frozen.args.end) ?? ''
      const prevLocation = optString(frozen.args.location) ?? ''
      const prevAttendees = cleanStringArray(frozen.args.attendees)
      const prevDescription =
        typeof frozen.args.description === 'string' && frozen.args.description.trim()
          ? frozen.args.description.trim()
          : ''

      const changed =
        title !== prevTitle ||
        start !== prevStart ||
        end !== prevEnd ||
        (location ?? '') !== prevLocation ||
        !sameStringArray(prevAttendees, attendees) ||
        (description ?? '') !== prevDescription

      const lines = [
        acctLine,
        `Title: ${title}`,
        `When: ${start} → ${end}`,
        ...(location ? [`Location: ${location}`] : []),
        ...(attendees.length ? [`Attendees: ${attendees.join(', ')}`] : []),
      ]
      const action = `Create calendar event "${title}" in ${label}`
      const detail = description
        ? `${lines.join('\n')}\n\n${truncateText(description, MAX_DETAIL_BODY_CHARS)}`
        : lines.join('\n')
      const target = ''
      const nextArgs: Record<string, unknown> = {
        title,
        start,
        end,
        ...(attendees.length ? { attendees: [...attendees] } : {}),
        ...(location ? { location } : {}),
        ...(description ? { description } : {}),
      }
      const nextFrozen: FrozenExecution = { ...frozen, args: nextArgs }
      const executionJson = changed
        ? JSON.stringify(nextFrozen)
        : (approval.execution_json ?? JSON.stringify(nextFrozen))

      return {
        ok: true,
        applied: {
          action: changed ? action : approval.action,
          detail: changed ? detail : approval.detail,
          target: changed ? target : approval.target,
          executionJson,
          editable: {
            kind: 'connector',
            tool: 'calendar_create_event',
            accountLabel: frozen.accountLabel,
            title,
            start,
            end,
            location: location ?? '',
            attendees: [...attendees],
            description: description ?? '',
          },
          changed,
        },
      }
    }

    case 'calendar_update_event': {
      const keyErr = assertAllowedKeys(raw, [
        'kind',
        'tool',
        'title',
        'start',
        'end',
        'location',
        'attendees',
        'description',
      ])
      if (keyErr) return { ok: false, error: keyErr }

      const eventId = optString(frozen.args.eventId)
      if (!eventId) {
        return { ok: false, error: 'Stored calendar_update_event payload is missing "eventId".' }
      }

      const patch: Record<string, unknown> = { eventId }
      const lines = [acctLine, `Event ID: ${eventId}`]
      const editable: EditableCalendarUpdateEvent = {
        kind: 'connector',
        tool: 'calendar_update_event',
        accountLabel: frozen.accountLabel,
        eventId,
      }

      let nextTitle: string | undefined
      if (raw.title !== undefined) {
        const res = validateSingleLineString(raw.title, 'title', { required: true })
        if (!res.ok) return res
        nextTitle = res.value
        patch.title = nextTitle
        editable.title = nextTitle
        lines.push(`Title: ${nextTitle}`)
      }

      let nextStart: string | undefined
      if (raw.start !== undefined) {
        const res = validateSingleLineString(raw.start, 'start', { required: true })
        if (!res.ok) return res
        nextStart = res.value
        patch.start = nextStart
        editable.start = nextStart
        lines.push(`Start: ${nextStart}`)
      }

      let nextEnd: string | undefined
      if (raw.end !== undefined) {
        const res = validateSingleLineString(raw.end, 'end', { required: true })
        if (!res.ok) return res
        nextEnd = res.value
        patch.end = nextEnd
        editable.end = nextEnd
        lines.push(`End: ${nextEnd}`)
      }

      let nextLocation: string | undefined
      if (raw.location !== undefined) {
        const res = validateSingleLineString(raw.location, 'location', { required: false })
        if (!res.ok) return res
        nextLocation = res.value
        patch.location = nextLocation
        editable.location = nextLocation
        lines.push(`Location: ${nextLocation || '(cleared)'}`)
      }

      let nextAttendees: string[] | undefined
      if (raw.attendees !== undefined) {
        const res = validateAddressList(raw.attendees, 'attendees', { required: false })
        if (!res.ok) return res
        nextAttendees = res.list
        patch.attendees = [...nextAttendees]
        editable.attendees = [...nextAttendees]
        lines.push(`Attendees: ${nextAttendees.join(', ') || '(none)'}`)
      }

      let nextDescription: string | undefined
      let descSuffix = ''
      if (raw.description !== undefined) {
        const res = validateMultilineText(raw.description, 'description', { requiredNonEmpty: false })
        if (!res.ok) return res
        nextDescription = res.value
        patch.description = nextDescription
        editable.description = nextDescription
        descSuffix = `\n\n${truncateText(nextDescription, MAX_DETAIL_BODY_CHARS)}`
      }

      if (Object.keys(patch).length <= 1) {
        return { ok: false, error: 'calendar_update_event requires at least one field to update.' }
      }

      const prevTitle = typeof frozen.args.title === 'string' && frozen.args.title.trim() ? frozen.args.title.trim() : undefined
      const prevStart = typeof frozen.args.start === 'string' && frozen.args.start.trim() ? frozen.args.start.trim() : undefined
      const prevEnd = typeof frozen.args.end === 'string' && frozen.args.end.trim() ? frozen.args.end.trim() : undefined
      const prevLocation = typeof frozen.args.location === 'string' ? frozen.args.location.trim() : undefined
      const prevAttendees = Array.isArray(frozen.args.attendees) ? cleanStringArray(frozen.args.attendees) : undefined
      const prevDescription = typeof frozen.args.description === 'string' ? frozen.args.description : undefined

      const attendeesChanged =
        (prevAttendees === undefined) !== (nextAttendees === undefined) ||
        (prevAttendees !== undefined && nextAttendees !== undefined && !sameStringArray(prevAttendees, nextAttendees))

      const changed =
        prevTitle !== nextTitle ||
        prevStart !== nextStart ||
        prevEnd !== nextEnd ||
        prevLocation !== nextLocation ||
        attendeesChanged ||
        prevDescription !== nextDescription

      const action = `Update calendar event ${eventId} in ${label}`
      const detail = `${lines.join('\n')}${descSuffix}`
      const target = ''
      const nextFrozen: FrozenExecution = { ...frozen, args: patch }
      const executionJson = changed
        ? JSON.stringify(nextFrozen)
        : (approval.execution_json ?? JSON.stringify(nextFrozen))

      return {
        ok: true,
        applied: {
          action: changed ? action : approval.action,
          detail: changed ? detail : approval.detail,
          target: changed ? target : approval.target,
          executionJson,
          editable,
          changed,
        },
      }
    }

    default:
      return { ok: false, error: `Connector tool "${String(frozen.tool)}" cannot be edited.` }
  }
}

export function applyApprovalEdit(approval: ApprovalRow, rawEdit: unknown): ApplyApprovalEditResult {
  if (!isPlainObject(rawEdit)) {
    return { ok: false, error: 'Edit payload must be a JSON object.' }
  }
  if (approval.workflow_run_id !== null) {
    return { ok: false, error: 'Workflow approvals cannot be edited.' }
  }
  if (approval.items !== null) {
    return { ok: false, error: 'Batch approvals cannot be edited.' }
  }

  if (approval.execution_json === null) {
    return applyPromptEdit(approval, rawEdit)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(approval.execution_json)
  } catch {
    return { ok: false, error: 'Invalid stored execution payload.' }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Invalid stored execution payload.' }
  }

  if (parsed.kind === 'mcp') {
    if (
      typeof parsed.serverId !== 'string' ||
      typeof parsed.toolName !== 'string' ||
      !isPlainObject(parsed.args)
    ) {
      return { ok: false, error: 'Invalid stored MCP execution payload.' }
    }
    return applyMcpEdit(approval, parsed as FrozenMcpExecution, rawEdit)
  }

  if (typeof parsed.tool === 'string' && typeof parsed.connectorId === 'string') {
    return applyConnectorEdit(approval, parsed as FrozenExecution, rawEdit)
  }

  return { ok: false, error: 'Unsupported stored execution payload.' }
}
