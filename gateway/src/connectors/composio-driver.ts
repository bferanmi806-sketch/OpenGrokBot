import { catalogByApp } from './catalog.js'
import { isAutomatedMail, sanitizeMailBody } from './mail-sanitize.js'
import {
  ConnectorDriverError,
  type AppKey,
  type CalendarEventItem,
  type ConnectorAccountRow,
  type ConnectorDriver,
  type ConnectorStatus,
  type FrozenExecution,
  type MailDetail,
  type MailSummary,
  type NotionPageSummary,
  type SlackChannelItem,
  type SlackMessageItem,
  type WriteExecutionResult,
} from './types.js'

const DEFAULT_BASE_URL = 'https://backend.composio.dev'
const CONTROL_TIMEOUT_MS = 15_000
const READ_TIMEOUT_MS = 20_000
const WRITE_TIMEOUT_MS = 25_000
const MAX_RETRY_AFTER_MS = 5_000
const UNCERTAIN_WRITE_DETAIL =
  'Upstream timed out or returned 5xx before confirming delivery; not retried automatically.'
const NOTION_VERSION = '2022-06-28'

const SLACK_AUTH_ERRORS = new Set([
  'invalid_auth',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'not_authed',
])

const NOTION_CODE_LANGUAGES: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  py: 'python',
  python: 'python',
  sh: 'shell',
  bash: 'bash',
  zsh: 'shell',
  shell: 'shell',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  css: 'css',
  sql: 'sql',
  go: 'go',
  rust: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'c++',
  'plain text': 'plain text',
}

function decodeSnippetEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

type ProxyParam = {
  name: string
  value: string
  in: 'query' | 'header'
}

type ProxyRequest = {
  endpoint: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  parameters?: ProxyParam[]
  body?: unknown
}

export type ComposioDriverOptions = {
  getApiKey: () => string
  getBaseUrl?: () => string
  fetchImpl?: typeof fetch
  userKey?: string
  sleepImpl?: (ms: number) => Promise<void>
}

type JsonRecord = Record<string, unknown>

function isRecord(val: unknown): val is JsonRecord {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTimeoutOrAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = 'name' in err ? String((err as { name?: unknown }).name) : ''
  return name === 'TimeoutError' || name === 'AbortError'
}

function extractUpstreamError(data: unknown, fallback: string): string {
  if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 300)
  if (isRecord(data)) {
    const errField = data.error
    if (typeof errField === 'string' && errField.trim()) return errField.trim().slice(0, 300)
    if (isRecord(errField) && typeof errField.message === 'string' && errField.message.trim()) {
      return errField.message.trim().slice(0, 300)
    }
    if (typeof data.message === 'string' && data.message.trim()) return data.message.trim().slice(0, 300)
    if (typeof data.detail === 'string' && data.detail.trim()) return data.detail.trim().slice(0, 300)
  }
  return fallback
}

function parseRetryAfterMs(resHeaders: Headers, proxyHeaders?: JsonRecord): number {
  let raw: string | null = null
  if (proxyHeaders) {
    for (const [k, v] of Object.entries(proxyHeaders)) {
      if (k.toLowerCase() === 'retry-after' && v !== undefined && v !== null) {
        raw = String(v).trim()
        break
      }
    }
  }
  if (!raw) raw = resHeaders.get('retry-after')?.trim() ?? null
  if (!raw) return 1_000

  const asNum = Number(raw)
  if (Number.isFinite(asNum)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(asNum * 1_000)))
  }
  const asDate = Date.parse(raw)
  if (Number.isFinite(asDate)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, asDate - Date.now()))
  }
  return 1_000
}

async function parseResponseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function unwrapProxyEnvelope(
  outerStatus: number,
  outerOk: boolean,
  parsed: unknown,
): { status: number; data: unknown; headers: JsonRecord } {
  if (outerOk && isRecord(parsed) && typeof parsed.status === 'number' && 'data' in parsed) {
    return {
      status: parsed.status,
      data: parsed.data,
      headers: isRecord(parsed.headers) ? parsed.headers : {},
    }
  }
  return { status: outerStatus, data: parsed, headers: {} }
}

function throwForStatus(status: number, data: unknown, context: string): never {
  if (status === 401 || status === 403 || status === 410) {
    throw new ConnectorDriverError(
      'auth_expired',
      extractUpstreamError(data, `${context}: authorization expired`),
      status,
    )
  }
  if (status === 429) {
    throw new ConnectorDriverError(
      'rate_limited',
      extractUpstreamError(data, `${context}: rate limit exceeded`),
      429,
    )
  }
  if (status === 400 || status === 404 || status === 422) {
    throw new ConnectorDriverError(
      'bad_request',
      extractUpstreamError(data, `${context}: bad request (${status})`),
      status,
    )
  }
  throw new ConnectorDriverError(
    'upstream',
    extractUpstreamError(data, `${context}: upstream error (${status})`),
    status,
  )
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function encodeRfc2047(value: string): string {
  const clean = sanitizeHeaderValue(value)
  if (!clean || !/[^\x20-\x7e]/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

function formatMimeAddress(addr: string): string {
  const clean = sanitizeHeaderValue(addr)
  const match = clean.match(/^(.*?)<([^>]+)>$/)
  if (!match) return clean
  const display = match[1]!.trim().replace(/^"(.*)"$/, '$1')
  const email = match[2]!.trim()
  if (!display) return email
  if (/[^\x20-\x7e]/.test(display)) {
    return `${encodeRfc2047(display)} <${email}>`
  }
  return /[,;<>@"]/.test(display) ? `"${display.replace(/"/g, '\\"')}" <${email}>` : `${display} <${email}>`
}

function splitAddressList(raw: string): string[] {
  if (!raw.trim()) return []
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === '"' && raw[i - 1] !== '\\') {
      inQuotes = !inQuotes
      current += ch
    } else if (ch === ',' && !inQuotes) {
      if (current.trim()) parts.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function extractBareEmail(raw: string): string {
  const match = raw.match(/<([^>]+)>/)
  return (match ? match[1]! : raw).trim().toLowerCase()
}

function buildRfc2822Raw(input: {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  inReplyTo?: string
  references?: string
}): string {
  const lines: string[] = []
  lines.push(`To: ${input.to.map(formatMimeAddress).join(', ')}`)
  if (input.cc?.length) lines.push(`Cc: ${input.cc.map(formatMimeAddress).join(', ')}`)
  if (input.bcc?.length) lines.push(`Bcc: ${input.bcc.map(formatMimeAddress).join(', ')}`)
  lines.push(`Subject: ${encodeRfc2047(input.subject)}`)
  if (input.inReplyTo?.trim()) lines.push(`In-Reply-To: ${sanitizeHeaderValue(input.inReplyTo)}`)
  if (input.references?.trim()) lines.push(`References: ${sanitizeHeaderValue(input.references)}`)
  lines.push('MIME-Version: 1.0')
  lines.push('Content-Type: text/plain; charset="UTF-8"')

  const normalizedBody = input.body.replace(/\r\n?/g, '\r\n')
  const mime = `${lines.join('\r\n')}\r\n\r\n${normalizedBody}`
  return Buffer.from(mime, 'utf8').toString('base64url')
}

function decodeBase64Url(data: string): string {
  const std = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(std, 'base64').toString('utf8')
}

function gmailHeadersMap(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRecord(payload) || !Array.isArray(payload.headers)) return out
  for (const h of payload.headers) {
    if (isRecord(h) && typeof h.name === 'string' && typeof h.value === 'string') {
      const key = h.name.toLowerCase()
      if (!out[key]) out[key] = h.value
    }
  }
  return out
}

function extractGmailContent(payload: unknown): {
  textParts: string[]
  htmlParts: string[]
  attachments: { id: string; name: string; size?: number }[]
} {
  const textParts: string[] = []
  const htmlParts: string[] = []
  const attachments: { id: string; name: string; size?: number }[] = []

  const walk = (part: unknown) => {
    if (!isRecord(part)) return
    const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : ''
    const filename = typeof part.filename === 'string' ? part.filename.trim() : ''
    const body = isRecord(part.body) ? part.body : undefined
    const attachmentId = typeof body?.attachmentId === 'string' ? body.attachmentId : ''
    const data = typeof body?.data === 'string' ? body.data : ''

    if (filename || attachmentId) {
      attachments.push({
        id: attachmentId || (typeof part.partId === 'string' ? part.partId : filename),
        name: filename || 'attachment',
        ...(typeof body?.size === 'number' ? { size: body.size } : {}),
      })
    } else if (data) {
      const decoded = decodeBase64Url(data)
      if (mimeType === 'text/html') {
        htmlParts.push(decoded)
      } else if (!mimeType || mimeType === 'text/plain') {
        textParts.push(decoded)
      }
    }

    if (Array.isArray(part.parts)) {
      for (const child of part.parts) walk(child)
    }
  }

  walk(payload)
  return { textParts, htmlParts, attachments }
}

function parseGmailSummary(raw: unknown): MailSummary {
  const msg = isRecord(raw) ? raw : {}
  const headers = gmailHeadersMap(msg.payload)
  const from = headers['from'] ?? ''
  const to = splitAddressList(headers['to'] ?? '')
  const subject = headers['subject'] ?? ''
  const date = headers['date'] ?? ''
  const labels = Array.isArray(msg.labelIds) ? msg.labelIds.map((x) => String(x)) : []
  const unread = labels.includes('UNREAD')
  const automated = isAutomatedMail({ from, headers, labels })
  const snippet = sanitizeMailBody({
    text: typeof msg.snippet === 'string' ? decodeSnippetEntities(msg.snippet) : '',
    subject,
    maxChars: 500,
  })
  return {
    id: String(msg.id ?? ''),
    ...(typeof msg.threadId === 'string' && msg.threadId ? { threadId: msg.threadId } : {}),
    from,
    to,
    subject,
    date,
    snippet,
    unread,
    automated,
  }
}

function parseGmailDetail(raw: unknown): MailDetail {
  const msg = isRecord(raw) ? raw : {}
  const headers = gmailHeadersMap(msg.payload)
  const from = headers['from'] ?? ''
  const replyTo = splitAddressList(headers['reply-to'] ?? '')
  const to = splitAddressList(headers['to'] ?? '')
  const cc = splitAddressList(headers['cc'] ?? '')
  const bcc = splitAddressList(headers['bcc'] ?? '')
  const subject = headers['subject'] ?? ''
  const date = headers['date'] ?? ''
  const labels = Array.isArray(msg.labelIds) ? msg.labelIds.map((x) => String(x)) : []
  const automated = isAutomatedMail({ from, headers, labels })
  const { textParts, htmlParts, attachments } = extractGmailContent(msg.payload)
  const body = sanitizeMailBody({
    text: textParts.length
      ? textParts.join('\n\n')
      : (htmlParts.length ? undefined : (typeof msg.snippet === 'string' ? decodeSnippetEntities(msg.snippet) : '')),
    html: htmlParts.length ? htmlParts.join('\n\n') : undefined,
    subject,
  })
  return {
    id: String(msg.id ?? ''),
    ...(typeof msg.threadId === 'string' && msg.threadId ? { threadId: msg.threadId } : {}),
    from,
    ...(replyTo.length ? { replyTo } : {}),
    to,
    cc,
    ...(bcc.length ? { bcc } : {}),
    subject,
    date,
    body,
    automated,
    attachments,
  }
}

function formatGraphRecipient(raw: unknown): string {
  if (!isRecord(raw) || !isRecord(raw.emailAddress)) return ''
  const name = typeof raw.emailAddress.name === 'string' ? raw.emailAddress.name.trim() : ''
  const address = typeof raw.emailAddress.address === 'string' ? raw.emailAddress.address.trim() : ''
  if (name && address && name.toLowerCase() !== address.toLowerCase()) return `${name} <${address}>`
  return address || name
}

function toGraphRecipients(addrs: string[]): { emailAddress: { address: string; name?: string } }[] {
  return addrs
    .map((raw) => {
      const clean = sanitizeHeaderValue(raw)
      const match = clean.match(/^(.*?)<([^>]+)>$/)
      if (match) {
        const name = match[1]!.trim().replace(/^"(.*)"$/, '$1')
        const address = match[2]!.trim()
        return address ? { emailAddress: { address, ...(name ? { name } : {}) } } : null
      }
      return clean ? { emailAddress: { address: clean } } : null
    })
    .filter((x): x is { emailAddress: { address: string; name?: string } } => x !== null)
}

function graphHeadersMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(raw)) return out
  for (const h of raw) {
    if (isRecord(h) && typeof h.name === 'string' && typeof h.value === 'string') {
      out[h.name.toLowerCase()] = h.value
    }
  }
  return out
}

function parseGraphSummary(raw: unknown): MailSummary {
  const msg = isRecord(raw) ? raw : {}
  const from = formatGraphRecipient(msg.from)
  const to = Array.isArray(msg.toRecipients)
    ? msg.toRecipients.map(formatGraphRecipient).filter(Boolean)
    : []
  const subject = typeof msg.subject === 'string' ? msg.subject : ''
  const date = typeof msg.receivedDateTime === 'string'
    ? msg.receivedDateTime
    : (typeof msg.sentDateTime === 'string' ? msg.sentDateTime : '')
  const headers = graphHeadersMap(msg.internetMessageHeaders)
  const automated = isAutomatedMail({ from, headers })
  const unread = msg.isRead === false
  const snippet = sanitizeMailBody({
    text: typeof msg.bodyPreview === 'string' ? msg.bodyPreview : '',
    subject,
    maxChars: 500,
  })
  return {
    id: String(msg.id ?? ''),
    ...(typeof msg.conversationId === 'string' && msg.conversationId ? { threadId: msg.conversationId } : {}),
    from,
    to,
    subject,
    date,
    snippet,
    unread,
    automated,
  }
}

function parseGraphDetail(raw: unknown): MailDetail {
  const msg = isRecord(raw) ? raw : {}
  const from = formatGraphRecipient(msg.from)
  const to = Array.isArray(msg.toRecipients) ? msg.toRecipients.map(formatGraphRecipient).filter(Boolean) : []
  const cc = Array.isArray(msg.ccRecipients) ? msg.ccRecipients.map(formatGraphRecipient).filter(Boolean) : []
  const bcc = Array.isArray(msg.bccRecipients) ? msg.bccRecipients.map(formatGraphRecipient).filter(Boolean) : []
  const subject = typeof msg.subject === 'string' ? msg.subject : ''
  const date = typeof msg.receivedDateTime === 'string'
    ? msg.receivedDateTime
    : (typeof msg.sentDateTime === 'string' ? msg.sentDateTime : '')
  const headers = graphHeadersMap(msg.internetMessageHeaders)
  const graphReplyTo = Array.isArray(msg.replyTo) ? msg.replyTo.map(formatGraphRecipient).filter(Boolean) : []
  const replyTo = graphReplyTo.length ? graphReplyTo : splitAddressList(headers['reply-to'] ?? '')
  const automated = isAutomatedMail({ from, headers })

  const bodyObj = isRecord(msg.body) ? msg.body : {}
  const content = typeof bodyObj.content === 'string' ? bodyObj.content : ''
  const contentType = typeof bodyObj.contentType === 'string' ? bodyObj.contentType.toLowerCase() : 'text'
  const body = sanitizeMailBody(
    contentType === 'html'
      ? { html: content, subject }
      : { text: content || (typeof msg.bodyPreview === 'string' ? msg.bodyPreview : ''), subject },
  )

  const attachments = Array.isArray(msg.attachments)
    ? msg.attachments
      .filter(isRecord)
      .map((a) => ({
        id: String(a.id ?? ''),
        name: typeof a.name === 'string' && a.name ? a.name : 'attachment',
        ...(typeof a.size === 'number' ? { size: a.size } : {}),
      }))
    : []

  return {
    id: String(msg.id ?? ''),
    ...(typeof msg.conversationId === 'string' && msg.conversationId ? { threadId: msg.conversationId } : {}),
    from,
    ...(replyTo.length ? { replyTo } : {}),
    to,
    cc,
    ...(bcc.length ? { bcc } : {}),
    subject,
    date,
    body,
    automated,
    attachments,
  }
}

function toGoogleEventTime(iso: string): { date: string } | { dateTime: string } {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso.trim()) ? { date: iso.trim() } : { dateTime: iso.trim() }
}

function toGraphEventTime(iso: string): string {
  const trimmed = iso.trim()
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const normalized = trimmed.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    const ms = Date.parse(normalized)
    if (!Number.isNaN(ms)) {
      return new Date(ms).toISOString().slice(0, 19)
    }
  }
  return trimmed
}

function normalizeGraphEventTime(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.dateTime !== 'string') return ''
  const dt = raw.dateTime.trim()
  const tz = typeof raw.timeZone === 'string' ? raw.timeZone.trim().toUpperCase() : ''
  if (tz === 'UTC' && dt && !/[zZ]|[+-]\d{2}:\d{2}$/.test(dt)) {
    return `${dt}Z`
  }
  return dt
}

function extractNotionTitle(page: unknown): string {
  if (!isRecord(page)) return '(Untitled)'
  if (isRecord(page.properties)) {
    for (const prop of Object.values(page.properties)) {
      if (isRecord(prop) && (prop.type === 'title' || Array.isArray(prop.title)) && Array.isArray(prop.title)) {
        const title = richTextToPlain(prop.title).trim()
        if (title) return title
      }
    }
  }
  if (Array.isArray(page.title)) {
    const title = richTextToPlain(page.title).trim()
    if (title) return title
  }
  return '(Untitled)'
}

function richTextToPlain(richText: unknown): string {
  if (!Array.isArray(richText)) return ''
  return richText
    .map((item) => {
      if (!isRecord(item)) return ''
      if (typeof item.plain_text === 'string') return item.plain_text
      if (isRecord(item.text) && typeof item.text.content === 'string') return item.text.content
      return ''
    })
    .join('')
}

function notionBlocksToMarkdown(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const lines: string[] = []
  for (const raw of blocks) {
    if (!isRecord(raw) || typeof raw.type !== 'string') continue
    const type = raw.type
    const inner = isRecord(raw[type]) ? (raw[type] as JsonRecord) : {}
    const text = richTextToPlain(inner.rich_text)
    switch (type) {
      case 'heading_1':
        lines.push(`# ${text}`)
        break
      case 'heading_2':
        lines.push(`## ${text}`)
        break
      case 'heading_3':
        lines.push(`### ${text}`)
        break
      case 'bulleted_list_item':
        lines.push(`- ${text}`)
        break
      case 'numbered_list_item':
        lines.push(`1. ${text}`)
        break
      case 'to_do':
        lines.push(`- [${inner.checked ? 'x' : ' '}] ${text}`)
        break
      case 'quote':
        lines.push(`> ${text}`)
        break
      case 'divider':
        lines.push('---')
        break
      case 'code': {
        const lang = typeof inner.language === 'string' ? inner.language : ''
        lines.push(`\`\`\`${lang}\n${text}\n\`\`\``)
        break
      }
      default:
        if (text) lines.push(text)
        break
    }
  }
  const joined = lines.join('\n\n').trim()
  return joined.length > 20_000 ? `${joined.slice(0, 20_000)}\n…(truncated)` : joined
}

function buildRichTextChunks(content: string): { type: 'text'; text: { content: string } }[] {
  if (!content) return [{ type: 'text', text: { content: '' } }]
  const chunks: { type: 'text'; text: { content: string } }[] = []
  for (let i = 0; i < content.length; i += 2_000) {
    chunks.push({ type: 'text', text: { content: content.slice(i, i + 2_000) } })
  }
  return chunks
}

function markdownToNotionBlocks(markdown: string): JsonRecord[] {
  const blocks: JsonRecord[] = []
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let inCodeFence = false
  let codeLanguage = 'plain text'
  let codeLines: string[] = []

  const flushCode = () => {
    blocks.push({
      object: 'block',
      type: 'code',
      code: {
        language: codeLanguage,
        rich_text: buildRichTextChunks(codeLines.join('\n')),
      },
    })
    codeLines = []
    codeLanguage = 'plain text'
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      if (inCodeFence) {
        flushCode()
        inCodeFence = false
        if (blocks.length >= 100) break
      } else {
        inCodeFence = true
        const rawLang = trimmed.slice(3).trim().toLowerCase()
        codeLanguage = NOTION_CODE_LANGUAGES[rawLang] ?? 'plain text'
      }
      continue
    }

    if (inCodeFence) {
      codeLines.push(rawLine)
      continue
    }

    if (!trimmed) continue

    if (trimmed === '---' || trimmed === '***') {
      blocks.push({ object: 'block', type: 'divider', divider: {} })
    } else if (trimmed.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: buildRichTextChunks(trimmed.slice(4).trim()) },
      })
    } else if (trimmed.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: buildRichTextChunks(trimmed.slice(3).trim()) },
      })
    } else if (trimmed.startsWith('# ')) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: buildRichTextChunks(trimmed.slice(2).trim()) },
      })
    } else if (/^[-*]\s+\[([ xX])\]\s+/.test(trimmed)) {
      const checked = /^[-*]\s+\[[xX]\]\s+/.test(trimmed)
      blocks.push({
        object: 'block',
        type: 'to_do',
        to_do: {
          checked,
          rich_text: buildRichTextChunks(trimmed.replace(/^[-*]\s+\[[ xX]\]\s+/, '')),
        },
      })
    } else if (/^[-*]\s+/.test(trimmed)) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: buildRichTextChunks(trimmed.replace(/^[-*]\s+/, '')) },
      })
    } else if (/^\d+\.\s+/.test(trimmed)) {
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: buildRichTextChunks(trimmed.replace(/^\d+\.\s+/, '')) },
      })
    } else if (trimmed.startsWith('> ')) {
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: buildRichTextChunks(trimmed.slice(2).trim()) },
      })
    } else {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: buildRichTextChunks(trimmed) },
      })
    }
    if (blocks.length >= 100) break
  }

  if (inCodeFence && blocks.length < 100) {
    flushCode()
  }
  return blocks
}

function assertSlackOk(data: unknown): JsonRecord {
  const obj = isRecord(data) ? data : {}
  if (obj.ok === false) {
    const code = typeof obj.error === 'string' ? obj.error : 'slack_error'
    if (SLACK_AUTH_ERRORS.has(code)) {
      throw new ConnectorDriverError('auth_expired', `Slack authorization expired: ${code}`, 401)
    }
    if (code === 'ratelimited') {
      throw new ConnectorDriverError('rate_limited', 'Slack rate limit exceeded', 429)
    }
    throw new ConnectorDriverError('bad_request', `Slack API error: ${code}`, 400)
  }
  return obj
}

function mapConnectedAccountStatus(rawStatus: unknown, isDisabled: unknown): ConnectorStatus {
  if (isDisabled === true) return 'failed'
  const up = typeof rawStatus === 'string' ? rawStatus.trim().toUpperCase() : ''
  if (up === 'ACTIVE') return 'active'
  if (up === 'EXPIRED') return 'expired'
  if (up === 'INITIATED' || up === 'INITIALIZING' || up === 'PENDING') return 'pending'
  return 'failed'
}

function stringList(val: unknown): string[] {
  if (typeof val === 'string') return splitAddressList(val)
  if (!Array.isArray(val)) return []
  return val.map((v) => String(v).trim()).filter(Boolean)
}

export function createComposioDriver(opts: ComposioDriverOptions): ConnectorDriver {
  const fetchFn = opts.fetchImpl ?? fetch
  const sleep = opts.sleepImpl ?? defaultSleep

  const baseUrl = (): string => {
    const raw = (opts.getBaseUrl?.() ?? '').trim().replace(/\/+$/, '')
    return raw || DEFAULT_BASE_URL
  }

  const requireApiKey = (): string => {
    const key = opts.getApiKey().trim()
    if (!key) throw new ConnectorDriverError('unconfigured', 'Composio API key is not configured')
    return key
  }

  const buildHeaders = (apiKey: string): Record<string, string> => ({
    'x-api-key': apiKey,
    'content-type': 'application/json',
  })

  async function controlRequest(
    path: string,
    init: { method?: string; body?: unknown; apiKey?: string; allowStatuses?: number[] } = {},
  ): Promise<{ status: number; data: unknown }> {
    const key = init.apiKey ?? requireApiKey()
    const url = `${baseUrl()}${path}`
    let res: Response
    let data: unknown
    try {
      res = await fetchFn(url, {
        method: init.method ?? 'GET',
        headers: buildHeaders(key),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      })
      data = await parseResponseBody(res)
    } catch (err) {
      if (isTimeoutOrAbortError(err)) {
        throw new ConnectorDriverError('timeout', 'Composio request timed out')
      }
      throw new ConnectorDriverError('upstream', err instanceof Error ? err.message : String(err))
    }

    if (res.ok || init.allowStatuses?.includes(res.status)) {
      return { status: res.status, data }
    }
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorDriverError(
        'unconfigured',
        extractUpstreamError(data, 'Composio API key rejected'),
        res.status,
      )
    }
    throwForStatus(res.status, data, 'Composio API')
  }

  async function proxyRead(
    remoteId: string,
    req: ProxyRequest,
    options: { retryOn429?: boolean } = {},
  ): Promise<unknown> {
    const key = requireApiKey()
    const retryOn429 = options.retryOn429 ?? true
    const url = `${baseUrl()}/api/v3.1/tools/execute/proxy`
    const payload: JsonRecord = {
      connected_account_id: remoteId,
      endpoint: req.endpoint,
      method: req.method,
      ...(req.parameters?.length ? { parameters: req.parameters } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response
      let rawParsed: unknown
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: buildHeaders(key),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        })
        rawParsed = await parseResponseBody(res)
      } catch (err) {
        if (isTimeoutOrAbortError(err)) {
          throw new ConnectorDriverError('timeout', `Upstream request timed out (${req.endpoint})`)
        }
        throw new ConnectorDriverError('upstream', err instanceof Error ? err.message : String(err))
      }

      const unwrapped = unwrapProxyEnvelope(res.status, res.ok, rawParsed)

      if (unwrapped.status === 429 && retryOn429 && attempt === 0) {
        await sleep(parseRetryAfterMs(res.headers, unwrapped.headers))
        continue
      }

      if (unwrapped.status >= 200 && unwrapped.status < 300) {
        return unwrapped.data
      }

      throwForStatus(unwrapped.status, unwrapped.data, req.endpoint)
    }

    throw new ConnectorDriverError('rate_limited', 'Upstream rate limit exceeded', 429)
  }

  async function proxyWriteOnce(
    remoteId: string,
    req: ProxyRequest,
    apiKey: string,
  ): Promise<
    | { kind: 'ok'; status: number; data: unknown }
    | { kind: 'failed'; error: string; authExpired?: boolean }
    | { kind: 'uncertain'; detail: string }
  > {
    const url = `${baseUrl()}/api/v3.1/tools/execute/proxy`
    const payload: JsonRecord = {
      connected_account_id: remoteId,
      endpoint: req.endpoint,
      method: req.method,
      ...(req.parameters?.length ? { parameters: req.parameters } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
    }

    let res: Response
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      })
    } catch {
      return { kind: 'uncertain', detail: UNCERTAIN_WRITE_DETAIL }
    }

    let rawParsed: unknown
    try {
      rawParsed = await parseResponseBody(res)
    } catch {
      if (!res.ok && res.status >= 400 && res.status < 500) {
        if (res.status === 401 || res.status === 403 || res.status === 410) {
          return { kind: 'failed', error: 'authorization expired', authExpired: true }
        }
        return { kind: 'failed', error: `Upstream rejected write (${res.status})` }
      }
      return { kind: 'uncertain', detail: UNCERTAIN_WRITE_DETAIL }
    }

    const unwrapped = unwrapProxyEnvelope(res.status, res.ok, rawParsed)
    const status = unwrapped.status

    if (status >= 500) {
      return { kind: 'uncertain', detail: UNCERTAIN_WRITE_DETAIL }
    }
    if (status === 401 || status === 403 || status === 410) {
      return { kind: 'failed', error: 'authorization expired', authExpired: true }
    }
    if (status < 200 || status >= 300) {
      return {
        kind: 'failed',
        error: extractUpstreamError(unwrapped.data, `Upstream rejected write (${status})`),
      }
    }
    return { kind: 'ok', status, data: unwrapped.data }
  }

  async function resolveIdentityLabel(app: AppKey, remoteId: string): Promise<string> {
    const appMeta = catalogByApp(app)
    const fallback = `${appMeta?.name ?? app} (${remoteId.slice(0, 8)})`

    try {
      switch (app) {
        case 'gmail': {
          const data = await proxyRead(
            remoteId,
            { endpoint: '/gmail/v1/users/me/profile', method: 'GET' },
            { retryOn429: false },
          )
          const email = isRecord(data) && typeof data.emailAddress === 'string' ? data.emailAddress.trim().toLowerCase() : ''
          return email || fallback
        }
        case 'outlook':
        case 'outlook_calendar': {
          const data = await proxyRead(
            remoteId,
            { endpoint: '/v1.0/me', method: 'GET' },
            { retryOn429: false },
          )
          const mail = isRecord(data)
            ? (typeof data.mail === 'string' && data.mail.trim()
                ? data.mail.trim().toLowerCase()
                : (typeof data.userPrincipalName === 'string' ? data.userPrincipalName.trim().toLowerCase() : ''))
            : ''
          return mail || fallback
        }
        case 'google_calendar': {
          const data = await proxyRead(
            remoteId,
            { endpoint: '/users/me/calendarList/primary', method: 'GET' },
            { retryOn429: false },
          )
          const rawLabel = isRecord(data)
            ? (typeof data.summary === 'string' && data.summary.trim()
                ? data.summary.trim()
                : (typeof data.id === 'string' ? data.id.trim() : ''))
            : ''
          if (!rawLabel) return fallback
          return rawLabel.includes('@') && !rawLabel.includes(' ') ? rawLabel.toLowerCase() : rawLabel
        }
        case 'notion': {
          const data = await proxyRead(
            remoteId,
            {
              endpoint: '/v1/users/me',
              method: 'GET',
              parameters: [{ name: 'Notion-Version', value: NOTION_VERSION, in: 'header' }],
            },
            { retryOn429: false },
          )
          if (!isRecord(data)) return fallback
          const bot = isRecord(data.bot) ? data.bot : undefined
          const workspaceName = typeof bot?.workspace_name === 'string' ? bot.workspace_name.trim() : ''
          const ownerUser = isRecord(bot?.owner) && isRecord(bot.owner.user) ? bot.owner.user : undefined
          const ownerName = typeof ownerUser?.name === 'string' ? ownerUser.name.trim() : ''
          const botName = typeof data.name === 'string' ? data.name.trim() : ''
          return workspaceName || ownerName || botName || fallback
        }
        case 'slack': {
          const data = await proxyRead(
            remoteId,
            { endpoint: '/api/auth.test', method: 'POST', body: {} },
            { retryOn429: false },
          )
          if (!isRecord(data) || data.ok === false) return fallback
          const team = typeof data.team === 'string' ? data.team.trim() : ''
          const user = typeof data.user === 'string' ? data.user.trim() : ''
          if (team && user) return `${team} (${user})`
          return team || user || fallback
        }
      }
    } catch {
      return fallback
    }
  }

  return {
    id: 'composio',

    configured(): boolean {
      return Boolean(opts.getApiKey().trim())
    },

    async testKey(candidateKey?: string) {
      const key = (candidateKey ?? opts.getApiKey()).trim()
      if (!key) return { ok: false, code: 'unconfigured', detail: 'Composio API key is empty' }
      try {
        const res = await fetchFn(`${baseUrl()}/api/v3.1/auth_configs?limit=1`, {
          method: 'GET',
          headers: buildHeaders(key),
          signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        })
        if (res.ok) return { ok: true }
        const data = await parseResponseBody(res)
        const detail = extractUpstreamError(data, `HTTP ${res.status}`)
        if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized', detail }
        if (res.status === 429) return { ok: false, code: 'rate_limited', detail }
        return { ok: false, code: 'upstream', detail }
      } catch (err) {
        return {
          ok: false,
          code: isTimeoutOrAbortError(err) ? 'timeout' : 'network_error',
          detail: err instanceof Error ? err.message : String(err),
        }
      }
    },

    async startOAuth(input) {
      const appMeta = catalogByApp(input.app)
      if (!appMeta) {
        throw new ConnectorDriverError('bad_request', `Unsupported connector app: ${input.app}`)
      }

      const listRes = await controlRequest(
        `/api/v3.1/auth_configs?toolkit_slug=${encodeURIComponent(appMeta.toolkitSlug)}`,
      )
      const items = isRecord(listRes.data) && Array.isArray(listRes.data.items) ? listRes.data.items : []
      const existing = items.find((item) => {
        if (!isRecord(item) || typeof item.id !== 'string' || !item.id) return false
        const status = typeof item.status === 'string' ? item.status.toUpperCase() : 'ENABLED'
        const scheme = typeof item.auth_scheme === 'string' ? item.auth_scheme.toUpperCase() : 'OAUTH2'
        const slugOk = !isRecord(item.toolkit) || !item.toolkit.slug || item.toolkit.slug === appMeta.toolkitSlug
        return status === 'ENABLED' && scheme === appMeta.authScheme && item.is_composio_managed !== false && slugOk
      })

      let authConfigId = isRecord(existing) && typeof existing.id === 'string' ? existing.id : ''
      if (!authConfigId) {
        const created = await controlRequest('/api/v3.1/auth_configs', {
          method: 'POST',
          body: {
            toolkit: { slug: appMeta.toolkitSlug },
            auth_config: {
              type: 'use_composio_managed_auth',
              name: `opensuperbot-${appMeta.toolkitSlug}`,
            },
          },
        })
        const createdObj = isRecord(created.data) ? created.data : {}
        const nested = isRecord(createdObj.auth_config) ? createdObj.auth_config : undefined
        authConfigId = typeof nested?.id === 'string'
          ? nested.id
          : (typeof createdObj.id === 'string' ? createdObj.id : '')
        if (!authConfigId) {
          throw new ConnectorDriverError('upstream', 'Composio did not return an auth_config id')
        }
      }

      const linkRes = await controlRequest('/api/v3.1/connected_accounts/link', {
        method: 'POST',
        body: {
          auth_config_id: authConfigId,
          user_id: input.userKey || opts.userKey || 'opensuperbot',
          callback_url: input.callbackUrl,
        },
      })
      const linkObj = isRecord(linkRes.data) ? linkRes.data : {}
      const remoteId = typeof linkObj.connected_account_id === 'string'
        ? linkObj.connected_account_id
        : (typeof linkObj.id === 'string' ? linkObj.id : '')
      const redirectUrl = typeof linkObj.redirect_url === 'string' ? linkObj.redirect_url : ''
      if (!remoteId || !redirectUrl) {
        throw new ConnectorDriverError('upstream', 'Composio link response missing connected_account_id or redirect_url')
      }

      return { authConfigId, remoteId, redirectUrl }
    },

    async inspectAccount(input) {
      const res = await controlRequest(
        `/api/v3.1/connected_accounts/${encodeURIComponent(input.remoteId)}`,
        { allowStatuses: [404, 410] },
      )
      if (res.status === 404 || res.status === 410) {
        return { status: 'expired', accountLabel: '' }
      }
      const obj = isRecord(res.data) ? res.data : {}
      const status = mapConnectedAccountStatus(obj.status, obj.is_disabled)
      if (status !== 'active') {
        return { status, accountLabel: '' }
      }
      const accountLabel = await resolveIdentityLabel(input.app, input.remoteId)
      return { status: 'active', accountLabel }
    },

    async revokeAccount(input) {
      await controlRequest(
        `/api/v3.1/connected_accounts/${encodeURIComponent(input.remoteId)}`,
        { method: 'DELETE', allowStatuses: [404, 410] },
      )
    },

    async listMail(account, listOpts) {
      const limit = Math.min(50, Math.max(1, listOpts.limit ?? 20))
      const folder = listOpts.folder ?? 'inbox'
      const includeAutomated = Boolean(listOpts.includeAutomated)

      if (account.app === 'gmail') {
        const qParts: string[] = []
        if (folder === 'inbox') qParts.push('in:inbox')
        else if (folder === 'sent') qParts.push('in:sent')
        if (listOpts.unread === true) qParts.push('is:unread')
        else if (listOpts.unread === false) qParts.push('is:read')
        if (listOpts.query?.trim()) qParts.push(listOpts.query.trim())

        const params: ProxyParam[] = [{ name: 'maxResults', value: String(limit), in: 'query' }]
        if (qParts.length) params.push({ name: 'q', value: qParts.join(' '), in: 'query' })
        if (listOpts.cursor?.trim()) params.push({ name: 'pageToken', value: listOpts.cursor.trim(), in: 'query' })

        const listData = await proxyRead(account.remote_id, {
          endpoint: '/gmail/v1/users/me/messages',
          method: 'GET',
          parameters: params,
        })
        const listObj = isRecord(listData) ? listData : {}
        const stubs = Array.isArray(listObj.messages) ? listObj.messages : []
        const nextCursor = typeof listObj.nextPageToken === 'string' && listObj.nextPageToken
          ? listObj.nextPageToken
          : undefined

        const messages: MailSummary[] = []
        for (const stub of stubs) {
          if (!isRecord(stub) || typeof stub.id !== 'string' || !stub.id) continue
          const msgData = await proxyRead(account.remote_id, {
            endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(stub.id)}`,
            method: 'GET',
            parameters: [{ name: 'format', value: 'metadata', in: 'query' }],
          })
          const summary = parseGmailSummary(msgData)
          if (!includeAutomated && summary.automated) continue
          messages.push(summary)
        }
        return { messages, ...(nextCursor ? { nextCursor } : {}) }
      }

      if (account.app === 'outlook') {
        const endpoint = folder === 'sent'
          ? '/v1.0/me/mailFolders/sentitems/messages'
          : folder === 'all'
            ? '/v1.0/me/messages'
            : '/v1.0/me/mailFolders/inbox/messages'

        const params: ProxyParam[] = [
          { name: '$top', value: String(limit), in: 'query' },
          {
            name: '$select',
            value: 'id,conversationId,subject,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,isRead,internetMessageHeaders',
            in: 'query',
          },
        ]
        const dateField = folder === 'sent' ? 'sentDateTime' : 'receivedDateTime'
        const cleanQuery = listOpts.query?.trim().replace(/"/g, '') ?? ''
        if (cleanQuery) {
          const searchExpr = listOpts.unread !== undefined
            ? `${cleanQuery} isread:${listOpts.unread ? 'false' : 'true'}`
            : cleanQuery
          params.push({ name: '$search', value: `"${searchExpr}"`, in: 'query' })
        } else {
          params.push({ name: '$orderby', value: `${dateField} desc`, in: 'query' })
          if (listOpts.unread !== undefined) {
            params.push({
              name: '$filter',
              value: `${dateField} ge 1900-01-01T00:00:00Z and isRead eq ${listOpts.unread ? 'false' : 'true'}`,
              in: 'query',
            })
          }
        }
        if (listOpts.cursor?.trim()) {
          const cur = listOpts.cursor.trim()
          params.push({ name: /^\d+$/.test(cur) ? '$skip' : '$skiptoken', value: cur, in: 'query' })
        }

        const data = await proxyRead(account.remote_id, { endpoint, method: 'GET', parameters: params })
        const obj = isRecord(data) ? data : {}
        const rawItems = Array.isArray(obj.value) ? obj.value : []
        const messages = rawItems
          .map(parseGraphSummary)
          .filter((m) => (includeAutomated || !m.automated) && (listOpts.unread === undefined || m.unread === listOpts.unread))

        let nextCursor: string | undefined
        if (typeof obj['@odata.nextLink'] === 'string') {
          try {
            const nextUrl = new URL(obj['@odata.nextLink'])
            nextCursor = nextUrl.searchParams.get('$skiptoken') ?? nextUrl.searchParams.get('$skip') ?? undefined
          } catch { /* ignore invalid nextLink */ }
        }
        return { messages, ...(nextCursor ? { nextCursor } : {}) }
      }

      throw new ConnectorDriverError('bad_request', `App ${account.app} does not support listMail`)
    },

    async readMail(account, sel) {
      const provided = [sel.messageId, sel.threadId, sel.draftId].filter((x) => Boolean(x?.trim()))
      if (provided.length !== 1) {
        throw new ConnectorDriverError('bad_request', 'Specify exactly one of messageId, threadId, or draftId')
      }

      if (account.app === 'gmail') {
        if (sel.messageId?.trim()) {
          const data = await proxyRead(account.remote_id, {
            endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(sel.messageId.trim())}`,
            method: 'GET',
            parameters: [{ name: 'format', value: 'full', in: 'query' }],
          })
          return { messages: [parseGmailDetail(data)] }
        }
        if (sel.threadId?.trim()) {
          const data = await proxyRead(account.remote_id, {
            endpoint: `/gmail/v1/users/me/threads/${encodeURIComponent(sel.threadId.trim())}`,
            method: 'GET',
            parameters: [{ name: 'format', value: 'full', in: 'query' }],
          })
          const rawMsgs = isRecord(data) && Array.isArray(data.messages) ? data.messages : []
          return { messages: rawMsgs.map(parseGmailDetail) }
        }
        const draftId = sel.draftId!.trim()
        const data = await proxyRead(account.remote_id, {
          endpoint: `/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`,
          method: 'GET',
          parameters: [{ name: 'format', value: 'full', in: 'query' }],
        })
        const obj = isRecord(data) ? data : {}
        const resolvedId = typeof obj.id === 'string' && obj.id ? obj.id : draftId
        return {
          draftId: resolvedId,
          messages: obj.message ? [parseGmailDetail(obj.message)] : [],
        }
      }

      if (account.app === 'outlook') {
        if (sel.threadId?.trim()) {
          const tid = sel.threadId.trim().replace(/'/g, "''")
          const data = await proxyRead(account.remote_id, {
            endpoint: '/v1.0/me/messages',
            method: 'GET',
            parameters: [
              { name: '$filter', value: `conversationId eq '${tid}'`, in: 'query' },
              { name: '$expand', value: 'attachments($select=id,name,size)', in: 'query' },
            ],
          })
          const rawMsgs = isRecord(data) && Array.isArray(data.value) ? data.value : []
          const messages = rawMsgs.map(parseGraphDetail).sort((a, b) => {
            const ta = Date.parse(a.date)
            const tb = Date.parse(b.date)
            return Number.isFinite(ta) && Number.isFinite(tb) ? ta - tb : 0
          })
          return { messages }
        }
        const targetId = (sel.messageId ?? sel.draftId)!.trim()
        const data = await proxyRead(account.remote_id, {
          endpoint: `/v1.0/me/messages/${encodeURIComponent(targetId)}`,
          method: 'GET',
          parameters: [{ name: '$expand', value: 'attachments($select=id,name,size)', in: 'query' }],
        })
        const detail = parseGraphDetail(data)
        return {
          ...(sel.draftId ? { draftId: detail.id || targetId } : {}),
          messages: [detail],
        }
      }

      throw new ConnectorDriverError('bad_request', `App ${account.app} does not support readMail`)
    },

    async createOrUpdateDraft(account, input) {
      if (!input.to.length) {
        throw new ConnectorDriverError('bad_request', 'Draft requires at least one recipient in to')
      }

      if (account.app === 'gmail') {
        const raw = buildRfc2822Raw({
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          body: input.body,
        })
        const existingId = input.draftId?.trim()
        const data = existingId
          ? await proxyRead(
              account.remote_id,
              {
                endpoint: `/gmail/v1/users/me/drafts/${encodeURIComponent(existingId)}`,
                method: 'PUT',
                body: { id: existingId, message: { raw } },
              },
              { retryOn429: false },
            )
          : await proxyRead(
              account.remote_id,
              {
                endpoint: '/gmail/v1/users/me/drafts',
                method: 'POST',
                body: { message: { raw } },
              },
              { retryOn429: false },
            )
        const draftId = isRecord(data) && typeof data.id === 'string' && data.id ? data.id : (existingId ?? '')
        return { draftId, summary: `Saved Gmail draft (${draftId})` }
      }

      if (account.app === 'outlook') {
        const payload: JsonRecord = {
          subject: input.subject,
          body: { contentType: 'Text', content: input.body },
          toRecipients: toGraphRecipients(input.to),
          ...(input.cc?.length ? { ccRecipients: toGraphRecipients(input.cc) } : {}),
          ...(input.bcc?.length ? { bccRecipients: toGraphRecipients(input.bcc) } : {}),
        }
        const existingId = input.draftId?.trim()
        const data = existingId
          ? await proxyRead(
              account.remote_id,
              {
                endpoint: `/v1.0/me/messages/${encodeURIComponent(existingId)}`,
                method: 'PATCH',
                body: payload,
              },
              { retryOn429: false },
            )
          : await proxyRead(
              account.remote_id,
              {
                endpoint: '/v1.0/me/messages',
                method: 'POST',
                body: payload,
              },
              { retryOn429: false },
            )
        const draftId = isRecord(data) && typeof data.id === 'string' && data.id ? data.id : (existingId ?? '')
        return { draftId, summary: `Saved Outlook draft (${draftId})` }
      }

      throw new ConnectorDriverError('bad_request', `App ${account.app} does not support createOrUpdateDraft`)
    },

    async listCalendarEvents(account, calOpts) {
      const limit = Math.min(100, Math.max(1, calOpts.limit ?? 50))

      if (account.app === 'google_calendar') {
        const params: ProxyParam[] = [
          { name: 'timeMin', value: calOpts.start, in: 'query' },
          { name: 'timeMax', value: calOpts.end, in: 'query' },
          { name: 'singleEvents', value: 'true', in: 'query' },
          { name: 'orderBy', value: 'startTime', in: 'query' },
          { name: 'maxResults', value: String(limit), in: 'query' },
        ]
        if (calOpts.query?.trim()) params.push({ name: 'q', value: calOpts.query.trim(), in: 'query' })

        const data = await proxyRead(account.remote_id, {
          endpoint: '/calendars/primary/events',
          method: 'GET',
          parameters: params,
        })
        const items = isRecord(data) && Array.isArray(data.items) ? data.items : []
        const events: CalendarEventItem[] = items.filter(isRecord).map((it) => {
          const startObj = isRecord(it.start) ? it.start : {}
          const endObj = isRecord(it.end) ? it.end : {}
          const attendees = Array.isArray(it.attendees)
            ? it.attendees
                .filter(isRecord)
                .map((a) => String(a.email ?? a.displayName ?? '').trim())
                .filter(Boolean)
            : []
          return {
            id: String(it.id ?? ''),
            title: typeof it.summary === 'string' && it.summary ? it.summary : '(No title)',
            start: String(startObj.dateTime ?? startObj.date ?? ''),
            end: String(endObj.dateTime ?? endObj.date ?? ''),
            ...(typeof it.location === 'string' && it.location ? { location: it.location } : {}),
            attendees,
            ...(typeof it.description === 'string' && it.description ? { description: it.description } : {}),
            ...(typeof it.status === 'string' && it.status ? { status: it.status } : {}),
          }
        })
        return { events }
      }

      if (account.app === 'outlook_calendar') {
        const params: ProxyParam[] = [
          { name: 'startDateTime', value: calOpts.start, in: 'query' },
          { name: 'endDateTime', value: calOpts.end, in: 'query' },
          { name: '$top', value: String(limit), in: 'query' },
          { name: '$orderby', value: 'start/dateTime asc', in: 'query' },
          { name: 'Prefer', value: 'outlook.timezone="UTC"', in: 'header' },
        ]
        const data = await proxyRead(account.remote_id, {
          endpoint: '/v1.0/me/calendarView',
          method: 'GET',
          parameters: params,
        })
        const items = isRecord(data) && Array.isArray(data.value) ? data.value : []
        const needle = calOpts.query?.trim().toLowerCase() ?? ''
        const events: CalendarEventItem[] = items
          .filter(isRecord)
          .map((it) => {
            const loc = isRecord(it.location) && typeof it.location.displayName === 'string'
              ? it.location.displayName.trim()
              : ''
            const attendees = Array.isArray(it.attendees)
              ? it.attendees
                  .filter(isRecord)
                  .map((a) => (isRecord(a.emailAddress) ? String(a.emailAddress.address ?? a.emailAddress.name ?? '').trim() : ''))
                  .filter(Boolean)
              : []
            const desc = typeof it.bodyPreview === 'string' && it.bodyPreview.trim()
              ? it.bodyPreview.trim()
              : undefined
            return {
              id: String(it.id ?? ''),
              title: typeof it.subject === 'string' && it.subject ? it.subject : '(No title)',
              start: normalizeGraphEventTime(it.start),
              end: normalizeGraphEventTime(it.end),
              ...(loc ? { location: loc } : {}),
              attendees,
              ...(desc ? { description: desc } : {}),
              ...(typeof it.showAs === 'string' && it.showAs ? { status: it.showAs } : {}),
            }
          })
          .filter((ev) => {
            if (!needle) return true
            return (
              ev.title.toLowerCase().includes(needle) ||
              (ev.location ?? '').toLowerCase().includes(needle) ||
              (ev.description ?? '').toLowerCase().includes(needle)
            )
          })
        return { events }
      }

      throw new ConnectorDriverError('bad_request', `App ${account.app} does not support listCalendarEvents`)
    },

    async searchNotion(account, searchOpts) {
      if (account.app !== 'notion') {
        throw new ConnectorDriverError('bad_request', `App ${account.app} does not support searchNotion`)
      }
      const limit = Math.min(100, Math.max(1, searchOpts.limit ?? 20))
      const data = await proxyRead(account.remote_id, {
        endpoint: '/v1/search',
        method: 'POST',
        parameters: [{ name: 'Notion-Version', value: NOTION_VERSION, in: 'header' }],
        body: {
          ...(searchOpts.query.trim() ? { query: searchOpts.query.trim() } : {}),
          filter: { value: 'page', property: 'object' },
          page_size: limit,
        },
      })
      const results = isRecord(data) && Array.isArray(data.results) ? data.results : []
      const pages: NotionPageSummary[] = results.filter(isRecord).map((p) => ({
        id: String(p.id ?? ''),
        title: extractNotionTitle(p),
        ...(typeof p.url === 'string' && p.url ? { url: p.url } : {}),
        ...(typeof p.last_edited_time === 'string' && p.last_edited_time ? { updatedAt: p.last_edited_time } : {}),
      }))
      return { pages }
    },

    async readNotionPage(account, pageId) {
      if (account.app !== 'notion') {
        throw new ConnectorDriverError('bad_request', `App ${account.app} does not support readNotionPage`)
      }
      const cleanId = pageId.trim()
      if (!cleanId) throw new ConnectorDriverError('bad_request', 'Notion pageId is required')

      const notionHeader: ProxyParam[] = [{ name: 'Notion-Version', value: NOTION_VERSION, in: 'header' }]
      const pageData = await proxyRead(account.remote_id, {
        endpoint: `/v1/pages/${encodeURIComponent(cleanId)}`,
        method: 'GET',
        parameters: notionHeader,
      })
      const blocksData = await proxyRead(account.remote_id, {
        endpoint: `/v1/blocks/${encodeURIComponent(cleanId)}/children`,
        method: 'GET',
        parameters: [...notionHeader, { name: 'page_size', value: '100', in: 'query' }],
      })

      const title = extractNotionTitle(pageData)
      const results = isRecord(blocksData) && Array.isArray(blocksData.results) ? blocksData.results : []
      const content = notionBlocksToMarkdown(results)
      return {
        id: isRecord(pageData) && typeof pageData.id === 'string' ? pageData.id : cleanId,
        title,
        content,
      }
    },

    async listSlackChannels(account, slackOpts) {
      if (account.app !== 'slack') {
        throw new ConnectorDriverError('bad_request', `App ${account.app} does not support listSlackChannels`)
      }
      const limit = Math.min(200, Math.max(1, slackOpts.limit ?? 100))
      const params: ProxyParam[] = [
        { name: 'types', value: 'public_channel,private_channel', in: 'query' },
        { name: 'exclude_archived', value: 'true', in: 'query' },
        { name: 'limit', value: String(limit), in: 'query' },
      ]
      if (slackOpts.cursor?.trim()) params.push({ name: 'cursor', value: slackOpts.cursor.trim(), in: 'query' })

      const raw = await proxyRead(account.remote_id, {
        endpoint: '/api/conversations.list',
        method: 'GET',
        parameters: params,
      })
      const data = assertSlackOk(raw)
      const rawChannels = Array.isArray(data.channels) ? data.channels : []
      const channels: SlackChannelItem[] = rawChannels.filter(isRecord).map((ch) => ({
        id: String(ch.id ?? ''),
        name: typeof ch.name === 'string' && ch.name ? ch.name : String(ch.id ?? ''),
        ...(typeof ch.is_private === 'boolean' ? { isPrivate: ch.is_private } : {}),
      }))
      const meta = isRecord(data.response_metadata) ? data.response_metadata : undefined
      const nextCursor = typeof meta?.next_cursor === 'string' && meta.next_cursor.trim()
        ? meta.next_cursor.trim()
        : undefined
      return { channels, ...(nextCursor ? { nextCursor } : {}) }
    },

    async readSlackMessages(account, slackOpts) {
      if (account.app !== 'slack') {
        throw new ConnectorDriverError('bad_request', `App ${account.app} does not support readSlackMessages`)
      }
      const channelId = slackOpts.channelId.trim()
      if (!channelId) throw new ConnectorDriverError('bad_request', 'Slack channelId is required')
      const limit = Math.min(100, Math.max(1, slackOpts.limit ?? 30))

      const isThread = Boolean(slackOpts.threadTs?.trim())
      const params: ProxyParam[] = [
        { name: 'channel', value: channelId, in: 'query' },
        { name: 'limit', value: String(limit), in: 'query' },
      ]
      if (isThread) params.push({ name: 'ts', value: slackOpts.threadTs!.trim(), in: 'query' })

      const raw = await proxyRead(account.remote_id, {
        endpoint: isThread ? '/api/conversations.replies' : '/api/conversations.history',
        method: 'GET',
        parameters: params,
      })
      const data = assertSlackOk(raw)
      const rawMsgs = Array.isArray(data.messages) ? data.messages : []
      const messages: SlackMessageItem[] = rawMsgs.filter(isRecord).map((m) => ({
        ts: String(m.ts ?? ''),
        user: String(m.user ?? m.bot_id ?? m.username ?? 'unknown'),
        text: typeof m.text === 'string' ? m.text : '',
        ...(typeof m.thread_ts === 'string' && m.thread_ts ? { threadTs: m.thread_ts } : {}),
      }))
      return { messages }
    },

    async executeWrite(frozen: FrozenExecution): Promise<WriteExecutionResult> {
      const apiKey = opts.getApiKey().trim()
      if (!apiKey) {
        return { status: 'failed', error: 'Composio API key is not configured' }
      }

      const { app, remoteId, accountLabel, tool, args } = frozen

      switch (tool) {
        case 'mail_send': {
          const draftId = typeof args.draftId === 'string' ? args.draftId.trim() : ''
          if (app === 'gmail') {
            if (draftId) {
              const res = await proxyWriteOnce(
                remoteId,
                { endpoint: '/gmail/v1/users/me/drafts/send', method: 'POST', body: { id: draftId } },
                apiKey,
              )
              if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
              if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
              const sentId = isRecord(res.data) && typeof res.data.id === 'string' ? ` (${res.data.id})` : ''
              return { status: 'succeeded', summary: `Sent draft via ${accountLabel}${sentId}` }
            }

            const to = stringList(args.to)
            if (!to.length) return { status: 'failed', error: 'mail_send requires draftId or recipient(s) in to' }
            const raw = buildRfc2822Raw({
              to,
              cc: stringList(args.cc),
              bcc: stringList(args.bcc),
              subject: typeof args.subject === 'string' ? args.subject : '',
              body: typeof args.body === 'string' ? args.body : '',
            })
            const res = await proxyWriteOnce(
              remoteId,
              { endpoint: '/gmail/v1/users/me/messages/send', method: 'POST', body: { raw } },
              apiKey,
            )
            if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
            if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
            const sentId = isRecord(res.data) && typeof res.data.id === 'string' ? ` (${res.data.id})` : ''
            return { status: 'succeeded', summary: `Sent email via ${accountLabel}${sentId}` }
          }

          if (app === 'outlook') {
            if (draftId) {
              const res = await proxyWriteOnce(
                remoteId,
                { endpoint: `/v1.0/me/messages/${encodeURIComponent(draftId)}/send`, method: 'POST', body: {} },
                apiKey,
              )
              if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
              if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
              return { status: 'succeeded', summary: `Sent draft via ${accountLabel}` }
            }

            const to = stringList(args.to)
            if (!to.length) return { status: 'failed', error: 'mail_send requires draftId or recipient(s) in to' }
            const cc = stringList(args.cc)
            const bcc = stringList(args.bcc)
            const res = await proxyWriteOnce(
              remoteId,
              {
                endpoint: '/v1.0/me/sendMail',
                method: 'POST',
                body: {
                  message: {
                    subject: typeof args.subject === 'string' ? args.subject : '',
                    body: { contentType: 'Text', content: typeof args.body === 'string' ? args.body : '' },
                    toRecipients: toGraphRecipients(to),
                    ...(cc.length ? { ccRecipients: toGraphRecipients(cc) } : {}),
                    ...(bcc.length ? { bccRecipients: toGraphRecipients(bcc) } : {}),
                  },
                  saveToSentItems: true,
                },
              },
              apiKey,
            )
            if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
            if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
            return { status: 'succeeded', summary: `Sent email via ${accountLabel}` }
          }

          return { status: 'failed', error: `App ${app} does not support mail_send` }
        }

        case 'mail_reply': {
          const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : ''
          const replyBody = typeof args.body === 'string' ? args.body : ''
          const replyAll = Boolean(args.replyAll)
          if (!messageId) return { status: 'failed', error: 'mail_reply requires messageId' }

          if (app === 'gmail') {
            let origData: unknown
            try {
              origData = await proxyRead(
                remoteId,
                {
                  endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
                  method: 'GET',
                  parameters: [{ name: 'format', value: 'metadata', in: 'query' }],
                },
                { retryOn429: false },
              )
            } catch (err) {
              if (err instanceof ConnectorDriverError && err.code === 'auth_expired') {
                return { status: 'failed', error: 'authorization expired', authExpired: true }
              }
              return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
            }

            const origObj = isRecord(origData) ? origData : {}
            const headers = gmailHeadersMap(origObj.payload)
            const selfEmail = extractBareEmail(accountLabel)
            const replyToList = splitAddressList(headers['reply-to'] ?? '')
            const fromList = splitAddressList(headers['from'] ?? '')
            const to = replyToList.length ? replyToList : fromList
            if (!to.length) {
              return { status: 'failed', error: 'Original Gmail message has no sender to reply to' }
            }

            const seenEmails = new Set<string>([
              ...to.map(extractBareEmail).filter(Boolean),
              ...(selfEmail ? [selfEmail] : []),
            ])
            const cc: string[] = []
            if (replyAll) {
              for (const addr of [...fromList, ...splitAddressList(headers['to'] ?? ''), ...splitAddressList(headers['cc'] ?? '')]) {
                const bare = extractBareEmail(addr)
                if (bare && !seenEmails.has(bare)) {
                  seenEmails.add(bare)
                  cc.push(addr)
                }
              }
            }

            const origSubj = (headers['subject'] ?? '').trim()
            const subject = /^re:/i.test(origSubj) ? origSubj : `Re: ${origSubj}`
            const origMsgId = (headers['message-id'] ?? '').trim()
            const origRefs = (headers['references'] ?? '').trim()
            const references = origMsgId
              ? (origRefs ? `${origRefs} ${origMsgId}` : origMsgId)
              : origRefs
            const threadId = typeof origObj.threadId === 'string' && origObj.threadId ? origObj.threadId : undefined

            const raw = buildRfc2822Raw({
              to,
              ...(cc.length ? { cc } : {}),
              subject,
              body: replyBody,
              ...(origMsgId ? { inReplyTo: origMsgId } : {}),
              ...(references ? { references } : {}),
            })

            const res = await proxyWriteOnce(
              remoteId,
              {
                endpoint: '/gmail/v1/users/me/messages/send',
                method: 'POST',
                body: { raw, ...(threadId ? { threadId } : {}) },
              },
              apiKey,
            )
            if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
            if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
            const sentId = isRecord(res.data) && typeof res.data.id === 'string' ? ` (${res.data.id})` : ''
            return { status: 'succeeded', summary: `Replied via ${accountLabel}${sentId}` }
          }

          if (app === 'outlook') {
            const action = replyAll ? 'replyAll' : 'reply'
            const res = await proxyWriteOnce(
              remoteId,
              {
                endpoint: `/v1.0/me/messages/${encodeURIComponent(messageId)}/${action}`,
                method: 'POST',
                body: { comment: replyBody },
              },
              apiKey,
            )
            if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
            if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
            return { status: 'succeeded', summary: `Replied via ${accountLabel}` }
          }

          return { status: 'failed', error: `App ${app} does not support mail_reply` }
        }

        case 'mail_archive': {
          const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : ''
          if (!messageId) return { status: 'failed', error: 'mail_archive requires messageId' }

          if (app === 'gmail') {
            const res = await proxyWriteOnce(
              remoteId,
              {
                endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
                method: 'POST',
                body: { removeLabelIds: ['INBOX'] },
              },
              apiKey,
            )
            if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
            if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
            return { status: 'succeeded', summary: `Archived message ${messageId} in ${accountLabel}` }
          }

          if (app === 'outlook') {
            const res = await proxyWriteOnce(
              remoteId,
              {
                endpoint: `/v1.0/me/messages/${encodeURIComponent(messageId)}/move`,
                method: 'POST',
                body: { destinationId: 'archive' },
              },
              apiKey,
            )
            if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
            if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
            return { status: 'succeeded', summary: `Archived message ${messageId} in ${accountLabel}` }
          }

          return { status: 'failed', error: `App ${app} does not support mail_archive` }
        }

        case 'calendar_create_event': {
          const title = typeof args.title === 'string' ? args.title.trim() : ''
          const start = typeof args.start === 'string' ? args.start.trim() : ''
          const end = typeof args.end === 'string' ? args.end.trim() : ''
          if (!title || !start || !end) {
            return { status: 'failed', error: 'calendar_create_event requires title, start, and end' }
          }
          const attendees = stringList(args.attendees)

          if (app === 'google_calendar') {
            const res = await proxyWriteOnce(
              remoteId,
              {
                endpoint: '/calendars/primary/events',
                method: 'POST',
                body: {
                  summary: title,
                  start: toGoogleEventTime(start),
                  end: toGoogleEventTime(end),
                  ...(typeof args.location === 'string' ? { location: args.location } : {}),
                  ...(typeof args.description === 'string' ? { description: args.description } : {}),
                  ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
                },
              },
              apiKey,
            )
            if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
            if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
            const evId = isRecord(res.data) && typeof res.data.id === 'string' ? ` (${res.data.id})` : ''
            return { status: 'succeeded', summary: `Created event "${title}" in ${accountLabel}${evId}` }
          }

          if (app === 'outlook_calendar') {
            const res = await proxyWriteOnce(
              remoteId,
              {
                endpoint: '/v1.0/me/events',
                method: 'POST',
                body: {
                  subject: title,
                  start: { dateTime: toGraphEventTime(start), timeZone: 'UTC' },
                  end: { dateTime: toGraphEventTime(end), timeZone: 'UTC' },
                  ...(typeof args.location === 'string' ? { location: { displayName: args.location } } : {}),
                  ...(typeof args.description === 'string'
                    ? { body: { contentType: 'Text', content: args.description } }
                    : {}),
                  ...(attendees.length
                    ? { attendees: attendees.map((address) => ({ emailAddress: { address }, type: 'required' })) }
                    : {}),
                },
              },
              apiKey,
            )
            if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
            if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
            const evId = isRecord(res.data) && typeof res.data.id === 'string' ? ` (${res.data.id})` : ''
            return { status: 'succeeded', summary: `Created event "${title}" in ${accountLabel}${evId}` }
          }

          return { status: 'failed', error: `App ${app} does not support calendar_create_event` }
        }

        case 'calendar_update_event': {
          const eventId = typeof args.eventId === 'string' ? args.eventId.trim() : ''
          if (!eventId) return { status: 'failed', error: 'calendar_update_event requires eventId' }

          if (app === 'google_calendar') {
            const patch: JsonRecord = {}
            if (typeof args.title === 'string' && args.title.trim()) patch.summary = args.title.trim()
            if (typeof args.start === 'string' && args.start.trim()) patch.start = toGoogleEventTime(args.start)
            if (typeof args.end === 'string' && args.end.trim()) patch.end = toGoogleEventTime(args.end)
            if (typeof args.location === 'string') patch.location = args.location
            if (typeof args.description === 'string') patch.description = args.description
            if (Array.isArray(args.attendees)) {
              patch.attendees = stringList(args.attendees).map((email) => ({ email }))
            }
            const res = await proxyWriteOnce(
              remoteId,
              {
                endpoint: `/calendars/primary/events/${encodeURIComponent(eventId)}`,
                method: 'PATCH',
                body: patch,
              },
              apiKey,
            )
            if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
            if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
            return { status: 'succeeded', summary: `Updated event ${eventId} in ${accountLabel}` }
          }

          if (app === 'outlook_calendar') {
            const patch: JsonRecord = {}
            if (typeof args.title === 'string' && args.title.trim()) patch.subject = args.title.trim()
            if (typeof args.start === 'string' && args.start.trim()) {
              patch.start = { dateTime: toGraphEventTime(args.start), timeZone: 'UTC' }
            }
            if (typeof args.end === 'string' && args.end.trim()) {
              patch.end = { dateTime: toGraphEventTime(args.end), timeZone: 'UTC' }
            }
            if (typeof args.location === 'string') patch.location = { displayName: args.location }
            if (typeof args.description === 'string') patch.body = { contentType: 'Text', content: args.description }
            if (Array.isArray(args.attendees)) {
              patch.attendees = stringList(args.attendees).map((address) => ({
                emailAddress: { address },
                type: 'required',
              }))
            }
            const res = await proxyWriteOnce(
              remoteId,
              {
                endpoint: `/v1.0/me/events/${encodeURIComponent(eventId)}`,
                method: 'PATCH',
                body: patch,
              },
              apiKey,
            )
            if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
            if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
            return { status: 'succeeded', summary: `Updated event ${eventId} in ${accountLabel}` }
          }

          return { status: 'failed', error: `App ${app} does not support calendar_update_event` }
        }

        case 'notion_create_page': {
          if (app !== 'notion') return { status: 'failed', error: `App ${app} does not support notion_create_page` }
          const parentPageId = typeof args.parentPageId === 'string' ? args.parentPageId.trim() : ''
          const title = typeof args.title === 'string' ? args.title.trim() : ''
          const markdown = typeof args.markdown === 'string' ? args.markdown : ''
          if (!parentPageId || !title) {
            return { status: 'failed', error: 'notion_create_page requires parentPageId and title' }
          }
          const res = await proxyWriteOnce(
            remoteId,
            {
              endpoint: '/v1/pages',
              method: 'POST',
              parameters: [{ name: 'Notion-Version', value: NOTION_VERSION, in: 'header' }],
              body: {
                parent: { page_id: parentPageId },
                properties: {
                  title: { title: buildRichTextChunks(title) },
                },
                children: markdownToNotionBlocks(markdown),
              },
            },
            apiKey,
          )
          if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
          if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
          const newId = isRecord(res.data) && typeof res.data.id === 'string' ? ` (${res.data.id})` : ''
          return { status: 'succeeded', summary: `Created Notion page "${title}"${newId}` }
        }

        case 'notion_append': {
          if (app !== 'notion') return { status: 'failed', error: `App ${app} does not support notion_append` }
          const pageId = typeof args.pageId === 'string' ? args.pageId.trim() : ''
          const markdown = typeof args.markdown === 'string' ? args.markdown : ''
          if (!pageId) return { status: 'failed', error: 'notion_append requires pageId' }
          const children = markdownToNotionBlocks(markdown)
          if (!children.length) return { status: 'failed', error: 'notion_append requires non-empty markdown content' }

          const res = await proxyWriteOnce(
            remoteId,
            {
              endpoint: `/v1/blocks/${encodeURIComponent(pageId)}/children`,
              method: 'PATCH',
              parameters: [{ name: 'Notion-Version', value: NOTION_VERSION, in: 'header' }],
              body: { children },
            },
            apiKey,
          )
          if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
          if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }
          return { status: 'succeeded', summary: `Appended blocks to Notion page (${pageId})` }
        }

        case 'slack_send_message': {
          if (app !== 'slack') return { status: 'failed', error: `App ${app} does not support slack_send_message` }
          const channelId = typeof args.channelId === 'string' ? args.channelId.trim() : ''
          const text = typeof args.text === 'string' ? args.text : ''
          const threadTs = typeof args.threadTs === 'string' && args.threadTs.trim() ? args.threadTs.trim() : undefined
          if (!channelId || !text.trim()) {
            return { status: 'failed', error: 'slack_send_message requires channelId and text' }
          }

          const res = await proxyWriteOnce(
            remoteId,
            {
              endpoint: '/api/chat.postMessage',
              method: 'POST',
              body: {
                channel: channelId,
                text,
                ...(threadTs ? { thread_ts: threadTs } : {}),
              },
            },
            apiKey,
          )
          if (res.kind === 'uncertain') return { status: 'uncertain', detail: res.detail }
          if (res.kind === 'failed') return { status: 'failed', error: res.error, ...(res.authExpired ? { authExpired: true } : {}) }

          if (isRecord(res.data) && res.data.ok === false) {
            const slackErr = typeof res.data.error === 'string' ? res.data.error : 'slack_error'
            if (SLACK_AUTH_ERRORS.has(slackErr)) {
              return { status: 'failed', error: 'authorization expired', authExpired: true }
            }
            return { status: 'failed', error: `Slack API error: ${slackErr}` }
          }

          const ts = isRecord(res.data) && typeof res.data.ts === 'string' ? ` (${res.data.ts})` : ''
          return { status: 'succeeded', summary: `Posted Slack message to ${channelId}${ts}` }
        }
      }
    },
  }
}
