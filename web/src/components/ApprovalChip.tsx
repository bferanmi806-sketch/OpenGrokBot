import { useEffect, useId, useState } from 'react'
import { ApiError } from '../api'
import { useT, type MessageKey, type T } from '../i18n'
import { blockReasonText, errorText } from '../i18n/describe'
import type {
  ApprovalEditable,
  ApprovalEditInput,
  ApprovalPayload,
  CalendarUpdateEventEditInput,
  EditableMcp,
  RuleDuration,
} from '../types'

const OUTCOME: Record<string, MessageKey> = { approved: 'approval.approved', discarded: 'approval.discarded' }

/** 规则为什么这次没放行：只认你自己开头的活 */
const HELD_BECAUSE: Record<string, MessageKey> = {
  webhook: 'approval.held.webhook',
  routine: 'approval.held.routine',
  relay: 'approval.held.relay',
  'outside-data': 'approval.held.outsideData',
  unknown: 'approval.held.unknown',
}

const DURATIONS: { value: RuleDuration; label: MessageKey }[] = [
  { value: '1h', label: 'approval.for1h' },
  { value: '24h', label: 'approval.for24h' },
  { value: 'always', label: 'approval.forAlways' },
]

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type McpPrimitiveType = 'string' | 'number' | 'integer' | 'boolean'

type McpSchemaField = {
  key: string
  type: McpPrimitiveType
  required: boolean
  label: string
  description?: string
  multiline: boolean
}

type EditorDraft =
  | { kind: 'mail_send'; to: string; cc: string; bcc: string; subject: string; body: string }
  | { kind: 'mail_reply'; body: string; replyAll: boolean }
  | { kind: 'slack_send_message'; channelId: string; text: string }
  | { kind: 'notion_create_page'; title: string; markdown: string }
  | { kind: 'notion_append'; markdown: string }
  | {
      kind: 'calendar_create_event'
      title: string
      start: string
      end: string
      location: string
      attendees: string
      description: string
    }
  | {
      kind: 'calendar_update_event'
      title: string
      start: string
      end: string
      location: string
      attendees: string
      description: string
    }
  | {
      kind: 'mcp'
      mode: 'form' | 'json'
      formValues: Record<string, string | boolean | undefined>
      formPresent: Record<string, boolean>
      jsonText: string
      modeError: string | null
    }
  | { kind: 'prompt'; action: string; detail: string }

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false
  const proto = Object.getPrototypeOf(val)
  return proto === Object.prototype || proto === null
}

function parseAddressList(raw: string): string[] {
  const parts: string[] = []
  for (const line of raw.split(/\r?\n|\r/)) {
    let current = ''
    let inQuotes = false
    let escaped = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (escaped) {
        current += ch
        escaped = false
        continue
      }
      if (ch === '\\' && inQuotes) {
        current += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        inQuotes = !inQuotes
        current += ch
      } else if ((ch === ',' || ch === ';') && !inQuotes) {
        const trimmed = current.trim()
        if (trimmed) parts.push(trimmed)
        current = ''
      } else {
        current += ch
      }
    }
    const trimmed = current.trim()
    if (trimmed) parts.push(trimmed)
  }
  return parts
}

function formatAddressList(list: readonly string[]): string {
  return list.join(', ')
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function deepJsonEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > 64) return false
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

function extractMcpSchemaFields(editable: EditableMcp): McpSchemaField[] | null {
  const schema = editable.inputSchema
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return null
  const props = schema.properties
  const keys = Object.keys(props)
  if (keys.length === 0) return null
  const requiredSet = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
  )
  const fields: McpSchemaField[] = []
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) return null
    const prop = props[key]
    if (!isPlainObject(prop)) return null
    const rawType = prop.type
    if (rawType !== 'string' && rawType !== 'number' && rawType !== 'integer' && rawType !== 'boolean') {
      return null
    }
    const initVal = editable.args[key]
    const multiline =
      rawType === 'string' && typeof initVal === 'string' && (initVal.includes('\n') || initVal.length > 100)
    const label = typeof prop.title === 'string' && prop.title.trim() ? prop.title.trim() : key
    const description =
      typeof prop.description === 'string' && prop.description.trim() ? prop.description.trim() : undefined
    fields.push({
      key,
      type: rawType,
      required: requiredSet.has(key),
      label,
      ...(description ? { description } : {}),
      multiline,
    })
  }
  return fields
}

function argsMatchMcpFields(fields: readonly McpSchemaField[], args: Record<string, unknown>): boolean {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  for (const key of Object.keys(args)) {
    const field = byKey.get(key)
    if (!field) return false
    const val = args[key]
    if (val === undefined) continue
    if (field.type === 'string' && typeof val !== 'string') return false
    if (field.type === 'boolean' && typeof val !== 'boolean') return false
    if (field.type === 'number' && (typeof val !== 'number' || !Number.isFinite(val))) return false
    if (field.type === 'integer' && (typeof val !== 'number' || !Number.isInteger(val))) return false
  }
  return true
}

function mcpFormValuesFromArgs(
  fields: readonly McpSchemaField[],
  args: Record<string, unknown>,
): Record<string, string | boolean | undefined> {
  const values: Record<string, string | boolean | undefined> = {}
  for (const field of fields) {
    const val = args[field.key]
    if (field.type === 'boolean') {
      values[field.key] = typeof val === 'boolean' ? val : undefined
    } else if (field.type === 'string') {
      values[field.key] = typeof val === 'string' ? val : ''
    } else {
      values[field.key] = typeof val === 'number' && Number.isFinite(val) ? String(val) : ''
    }
  }
  return values
}

function mcpPresentFromArgs(args: Record<string, unknown>): Record<string, boolean> {
  const present: Record<string, boolean> = {}
  for (const key of Object.keys(args)) {
    if (args[key] !== undefined) present[key] = true
  }
  return present
}

function buildMcpArgsFromForm(
  fields: readonly McpSchemaField[],
  formValues: Record<string, string | boolean | undefined>,
  formPresent: Record<string, boolean>,
  t: T,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string; partialArgs: Record<string, unknown> } {
  const args: Record<string, unknown> = {}
  let firstError: string | null = null
  for (const field of fields) {
    const present = formPresent[field.key] === true
    const raw = formValues[field.key]
    if (field.type === 'boolean') {
      if (typeof raw === 'boolean') {
        args[field.key] = raw
      } else if (field.required) {
        args[field.key] = false
      }
    } else if (field.type === 'string') {
      const str = typeof raw === 'string' ? raw : ''
      if (field.required && !str.trim()) {
        if (!firstError) firstError = t('approval.edit.requiredField', { field: field.label })
      }
      if (str !== '' || present) {
        args[field.key] = str
      }
    } else {
      const str = typeof raw === 'string' ? raw.trim() : ''
      if (str === '') {
        if (field.required && !firstError) {
          firstError = t('approval.edit.requiredField', { field: field.label })
        }
      } else {
        const num = Number(str)
        const valid = Number.isFinite(num) && (field.type === 'number' || Number.isInteger(num))
        if (!valid) {
          if (!firstError) firstError = t('approval.edit.invalidNumber', { field: field.label })
        } else {
          args[field.key] = num
        }
      }
    }
  }
  if (firstError) return { ok: false, error: firstError, partialArgs: args }
  return { ok: true, args }
}

function parseMcpJson(
  jsonText: string,
  t: T,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { ok: false, error: t('approval.edit.invalidJson') }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: t('approval.edit.jsonMustBeObject') }
  }
  return { ok: true, args: parsed }
}

function createInitialDraft(editable: ApprovalEditable): EditorDraft {
  if (editable.kind === 'prompt') {
    return { kind: 'prompt', action: editable.action, detail: editable.detail }
  }
  if (editable.kind === 'mcp') {
    const fields = extractMcpSchemaFields(editable)
    const canForm = fields !== null && argsMatchMcpFields(fields, editable.args)
    return {
      kind: 'mcp',
      mode: canForm ? 'form' : 'json',
      formValues: fields ? mcpFormValuesFromArgs(fields, editable.args) : {},
      formPresent: mcpPresentFromArgs(editable.args),
      jsonText: JSON.stringify(editable.args, null, 2),
      modeError: null,
    }
  }
  switch (editable.tool) {
    case 'mail_send':
      return {
        kind: 'mail_send',
        to: formatAddressList(editable.to),
        cc: formatAddressList(editable.cc),
        bcc: formatAddressList(editable.bcc),
        subject: editable.subject,
        body: editable.body,
      }
    case 'mail_reply':
      return {
        kind: 'mail_reply',
        body: editable.body,
        replyAll: editable.replyAll,
      }
    case 'slack_send_message':
      return {
        kind: 'slack_send_message',
        channelId: editable.channelId,
        text: editable.text,
      }
    case 'notion_create_page':
      return {
        kind: 'notion_create_page',
        title: editable.title,
        markdown: editable.markdown,
      }
    case 'notion_append':
      return {
        kind: 'notion_append',
        markdown: editable.markdown,
      }
    case 'calendar_create_event':
      return {
        kind: 'calendar_create_event',
        title: editable.title,
        start: editable.start,
        end: editable.end,
        location: editable.location,
        attendees: formatAddressList(editable.attendees),
        description: editable.description,
      }
    case 'calendar_update_event':
      return {
        kind: 'calendar_update_event',
        title: editable.title ?? '',
        start: editable.start ?? '',
        end: editable.end ?? '',
        location: editable.location ?? '',
        attendees: editable.attendees ? formatAddressList(editable.attendees) : '',
        description: editable.description ?? '',
      }
  }
}

type EvaluatedDraft =
  | { ok: true; edit: ApprovalEditInput; dirty: boolean }
  | { ok: false; error: string; dirty: boolean }

function evaluateDraft(editable: ApprovalEditable, draft: EditorDraft, t: T): EvaluatedDraft {
  if (editable.kind === 'prompt' && draft.kind === 'prompt') {
    const action = draft.action.trim()
    const dirty = action !== editable.action.trim() || draft.detail.trim() !== editable.detail.trim()
    if (!action) {
      return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.action') }), dirty: true }
    }
    return {
      ok: true,
      dirty,
      edit: { kind: 'prompt', action, detail: draft.detail },
    }
  }

  if (editable.kind === 'mcp' && draft.kind === 'mcp') {
    if (draft.mode === 'form') {
      const fields = extractMcpSchemaFields(editable)
      if (!fields) {
        return { ok: false, error: t('approval.edit.failed'), dirty: true }
      }
      const built = buildMcpArgsFromForm(fields, draft.formValues, draft.formPresent, t)
      if (!built.ok) {
        return { ok: false, error: built.error, dirty: true }
      }
      const dirty = !deepJsonEqual(editable.args, built.args)
      return { ok: true, dirty, edit: { kind: 'mcp', args: built.args } }
    }
    const parsed = parseMcpJson(draft.jsonText, t)
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, dirty: true }
    }
    const dirty = !deepJsonEqual(editable.args, parsed.args)
    return { ok: true, dirty, edit: { kind: 'mcp', args: parsed.args } }
  }

  if (editable.kind === 'connector') {
    if (editable.tool === 'mail_send' && draft.kind === 'mail_send') {
      const to = parseAddressList(draft.to)
      const cc = parseAddressList(draft.cc)
      const bcc = parseAddressList(draft.bcc)
      const subject = draft.subject.trim()
      const body = draft.body
      const dirty =
        !sameStringArray(editable.to, to) ||
        !sameStringArray(editable.cc, cc) ||
        !sameStringArray(editable.bcc, bcc) ||
        editable.subject.trim() !== subject ||
        editable.body !== body
      if (to.length === 0) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.to') }), dirty: true }
      }
      if (!subject) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.subject') }), dirty: true }
      }
      if (!body.trim()) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.body') }), dirty: true }
      }
      return {
        ok: true,
        dirty,
        edit: { kind: 'connector', tool: 'mail_send', to, cc, bcc, subject, body },
      }
    }

    if (editable.tool === 'mail_reply' && draft.kind === 'mail_reply') {
      const dirty = draft.body !== editable.body || draft.replyAll !== editable.replyAll
      if (!draft.body.trim()) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.body') }), dirty: true }
      }
      return {
        ok: true,
        dirty,
        edit: { kind: 'connector', tool: 'mail_reply', body: draft.body, replyAll: draft.replyAll },
      }
    }

    if (editable.tool === 'slack_send_message' && draft.kind === 'slack_send_message') {
      const channelId = draft.channelId.trim()
      const text = draft.text
      const dirty = channelId !== editable.channelId.trim() || text !== editable.text
      if (!channelId) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.channel') }), dirty: true }
      }
      if (!text.trim()) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.message') }), dirty: true }
      }
      return {
        ok: true,
        dirty,
        edit: { kind: 'connector', tool: 'slack_send_message', channelId, text },
      }
    }

    if (editable.tool === 'notion_create_page' && draft.kind === 'notion_create_page') {
      const title = draft.title.trim()
      const markdown = draft.markdown
      const dirty = title !== editable.title.trim() || markdown !== editable.markdown
      if (!title) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.title') }), dirty: true }
      }
      return {
        ok: true,
        dirty,
        edit: { kind: 'connector', tool: 'notion_create_page', title, markdown },
      }
    }

    if (editable.tool === 'notion_append' && draft.kind === 'notion_append') {
      const markdown = draft.markdown
      const dirty = markdown !== editable.markdown
      if (!markdown.trim()) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.markdown') }), dirty: true }
      }
      return {
        ok: true,
        dirty,
        edit: { kind: 'connector', tool: 'notion_append', markdown },
      }
    }

    if (editable.tool === 'calendar_create_event' && draft.kind === 'calendar_create_event') {
      const title = draft.title.trim()
      const start = draft.start.trim()
      const end = draft.end.trim()
      const location = draft.location.trim()
      const attendees = parseAddressList(draft.attendees)
      const description = draft.description
      const dirty =
        title !== editable.title.trim() ||
        start !== editable.start.trim() ||
        end !== editable.end.trim() ||
        location !== editable.location.trim() ||
        !sameStringArray(editable.attendees, attendees) ||
        description.trim() !== editable.description.trim()
      if (!title) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.title') }), dirty: true }
      }
      if (!start) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.start') }), dirty: true }
      }
      if (!end) {
        return { ok: false, error: t('approval.edit.requiredField', { field: t('approval.edit.end') }), dirty: true }
      }
      return {
        ok: true,
        dirty,
        edit: {
          kind: 'connector',
          tool: 'calendar_create_event',
          title,
          start,
          end,
          location,
          attendees,
          description,
        },
      }
    }

    if (editable.tool === 'calendar_update_event' && draft.kind === 'calendar_update_event') {
      const edit: CalendarUpdateEventEditInput = {
        kind: 'connector',
        tool: 'calendar_update_event',
      }
      let fieldCount = 0

      const nextTitle = draft.title.trim()
      if (nextTitle) {
        edit.title = nextTitle
        fieldCount += 1
      }
      const nextStart = draft.start.trim()
      if (nextStart) {
        edit.start = nextStart
        fieldCount += 1
      }
      const nextEnd = draft.end.trim()
      if (nextEnd) {
        edit.end = nextEnd
        fieldCount += 1
      }
      if (editable.location !== undefined || draft.location.trim() !== '') {
        edit.location = draft.location.trim()
        fieldCount += 1
      }
      const parsedAttendees = parseAddressList(draft.attendees)
      if (editable.attendees !== undefined || parsedAttendees.length > 0) {
        edit.attendees = parsedAttendees
        fieldCount += 1
      }
      if (editable.description !== undefined || draft.description !== '') {
        edit.description = draft.description
        fieldCount += 1
      }

      const attendeesDirty =
        (editable.attendees === undefined) !== (edit.attendees === undefined) ||
        (editable.attendees !== undefined &&
          edit.attendees !== undefined &&
          !sameStringArray(editable.attendees, edit.attendees))
      const dirty =
        edit.title !== editable.title ||
        edit.start !== editable.start ||
        edit.end !== editable.end ||
        edit.location !== editable.location ||
        attendeesDirty ||
        edit.description !== editable.description

      if (fieldCount === 0) {
        return { ok: false, error: t('approval.edit.atLeastOneField'), dirty: true }
      }
      return { ok: true, dirty, edit }
    }
  }

  return { ok: false, error: t('approval.edit.failed'), dirty: false }
}

function formatEditError(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    const msg = errorText(t, err).trim()
    return msg || t('approval.edit.failed')
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim()
  }
  return t('approval.edit.failed')
}

/** 规则管到什么时候：今天之内只写钟点，跨天带上日期 */
export function untilLabel(expiresAt: number | null, t: T, now = new Date()): string {
  if (expiresAt === null) return t('approval.untilRevoked')
  const at = new Date(expiresAt)
  const time = at.toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === now.toDateString()
    ? t('approval.until', { when: time })
    : t('approval.until', { when: `${at.toLocaleDateString(t.locale, { month: 'short', day: 'numeric' })} ${time}` })
}

/** 一批里先摊开这么多项，再多的折起来 */
const SHOWN_ITEMS = 6

/** 一批对象：待批时每项一个勾，默认全勾；批完后放行的打 ✓，留下的划掉 */
function BatchItems({ items, kept, onToggle, approved }: {
  items: string[]
  kept: Set<number>
  onToggle?: (index: number) => void
  approved?: number[]
}) {
  const t = useT()
  const [all, setAll] = useState(items.length <= SHOWN_ITEMS)
  const shown = all ? items : items.slice(0, SHOWN_ITEMS)
  const done = approved ? new Set(approved) : null
  return (
    <div className="approval-items">
      <ul>
        {shown.map((item, i) => (
          <li key={i} className={done && !done.has(i) ? 'left-out' : undefined}>
            {onToggle ? (
              <label>
                <input type="checkbox" checked={kept.has(i)} onChange={() => onToggle(i)} />
                <span>{item}</span>
              </label>
            ) : (
              <span>{done?.has(i) ? '✓ ' : ''}{item}</span>
            )}
          </li>
        ))}
      </ul>
      {all ? null : (
        <button type="button" className="approval-items-more" onClick={() => setAll(true)}>{t('approval.showAll', { count: items.length })}</button>
      )}
    </div>
  )
}

function ExecutionLine({ payload }: { payload: ApprovalPayload }) {
  const t = useT()
  const status = payload.executionStatus
  if (!status) return null
  const detail = payload.executionDetail?.trim()
  if (status === 'succeeded') {
    return (
      <div className="approval-exec succeeded">
        <span>{t('approval.exec.succeeded')}</span>
        {detail ? <span className="approval-exec-detail"> · {detail}</span> : null}
      </div>
    )
  }
  const text = status === 'failed'
    ? (detail ? t('approval.exec.failedDetail', { detail }) : t('approval.exec.failed'))
    : (detail ? t('approval.exec.uncertainDetail', { detail }) : t('approval.exec.uncertain'))
  return <div className={`approval-exec ${status}`}>{text}</div>
}

function ApprovalEditorFields({
  editable,
  draft,
  busy,
  onChange,
}: {
  editable: ApprovalEditable
  draft: EditorDraft
  busy: boolean
  onChange: (next: EditorDraft) => void
}) {
  const t = useT()
  const baseId = useId()

  if (editable.kind === 'prompt' && draft.kind === 'prompt') {
    return (
      <>
        <div className="approval-edit-field">
          <label htmlFor={`${baseId}-action`}>{t('approval.edit.action')}</label>
          <input
            id={`${baseId}-action`}
            type="text"
            value={draft.action}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, action: e.target.value })}
          />
        </div>
        <div className="approval-edit-field">
          <label htmlFor={`${baseId}-detail`}>{t('approval.edit.detail')}</label>
          <textarea
            id={`${baseId}-detail`}
            rows={5}
            value={draft.detail}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, detail: e.target.value })}
          />
        </div>
      </>
    )
  }

  if (editable.kind === 'mcp' && draft.kind === 'mcp') {
    const schemaFields = extractMcpSchemaFields(editable)
    const switchToJson = () => {
      if (draft.mode === 'json') return
      const built = schemaFields
        ? buildMcpArgsFromForm(schemaFields, draft.formValues, draft.formPresent, t)
        : null
      const nextArgs = built ? (built.ok ? built.args : built.partialArgs) : editable.args
      onChange({
        ...draft,
        mode: 'json',
        jsonText: JSON.stringify(nextArgs, null, 2),
        modeError: null,
      })
    }
    const switchToForm = () => {
      if (draft.mode === 'form' || !schemaFields) return
      const parsed = parseMcpJson(draft.jsonText, t)
      if (!parsed.ok) {
        onChange({ ...draft, modeError: parsed.error })
        return
      }
      if (!argsMatchMcpFields(schemaFields, parsed.args)) {
        onChange({ ...draft, modeError: t('approval.edit.failed') })
        return
      }
      onChange({
        ...draft,
        mode: 'form',
        formValues: mcpFormValuesFromArgs(schemaFields, parsed.args),
        formPresent: mcpPresentFromArgs(parsed.args),
        modeError: null,
      })
    }

    return (
      <>
        {schemaFields ? (
          <div className="approval-edit-mode" role="group" aria-label={`${t('approval.edit.formMode')} / ${t('approval.edit.jsonMode')}`}>
            <button
              type="button"
              className={`approval-edit-toggle${draft.mode === 'form' ? ' active' : ''}`}
              aria-pressed={draft.mode === 'form'}
              disabled={busy}
              onClick={switchToForm}
            >
              {t('approval.edit.formMode')}
            </button>
            <button
              type="button"
              className={`approval-edit-toggle${draft.mode === 'json' ? ' active' : ''}`}
              aria-pressed={draft.mode === 'json'}
              disabled={busy}
              onClick={switchToJson}
            >
              {t('approval.edit.jsonMode')}
            </button>
          </div>
        ) : null}
        {draft.mode === 'form' && schemaFields ? (
          schemaFields.map((field) => {
            const fieldId = `${baseId}-mcp-${field.key}`
            if (field.type === 'boolean') {
              return (
                <div className="approval-edit-field" key={field.key}>
                  <label className="approval-edit-check" htmlFor={fieldId}>
                    <input
                      id={fieldId}
                      type="checkbox"
                      checked={draft.formValues[field.key] === true}
                      disabled={busy}
                      onChange={(e) => onChange({
                        ...draft,
                        formValues: { ...draft.formValues, [field.key]: e.target.checked },
                        formPresent: { ...draft.formPresent, [field.key]: true },
                        modeError: null,
                      })}
                    />
                    <span>{field.label}</span>
                  </label>
                  {field.description ? <span className="approval-edit-hint">{field.description}</span> : null}
                </div>
              )
            }
            const strVal = typeof draft.formValues[field.key] === 'string' ? (draft.formValues[field.key] as string) : ''
            return (
              <div className="approval-edit-field" key={field.key}>
                <label htmlFor={fieldId}>{field.label}</label>
                {field.multiline ? (
                  <textarea
                    id={fieldId}
                    rows={3}
                    value={strVal}
                    disabled={busy}
                    onChange={(e) => onChange({
                      ...draft,
                      formValues: { ...draft.formValues, [field.key]: e.target.value },
                      modeError: null,
                    })}
                  />
                ) : (
                  <input
                    id={fieldId}
                    type="text"
                    inputMode={field.type === 'integer' ? 'numeric' : field.type === 'number' ? 'decimal' : undefined}
                    value={strVal}
                    disabled={busy}
                    onChange={(e) => onChange({
                      ...draft,
                      formValues: { ...draft.formValues, [field.key]: e.target.value },
                      modeError: null,
                    })}
                  />
                )}
                {field.description ? <span className="approval-edit-hint">{field.description}</span> : null}
              </div>
            )
          })
        ) : (
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-mcp-json`}>{t('approval.edit.argsJson')}</label>
            <textarea
              id={`${baseId}-mcp-json`}
              className="approval-edit-json"
              rows={6}
              spellCheck={false}
              value={draft.jsonText}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, jsonText: e.target.value, modeError: null })}
            />
          </div>
        )}
      </>
    )
  }

  if (editable.kind === 'connector') {
    if (editable.tool === 'mail_send' && draft.kind === 'mail_send') {
      return (
        <>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-to`}>{t('approval.edit.to')}</label>
            <textarea
              id={`${baseId}-to`}
              className="approval-edit-recipients"
              rows={2}
              value={draft.to}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, to: e.target.value })}
            />
            <span className="approval-edit-hint">{t('approval.edit.recipientsHint')}</span>
          </div>
          <div className="approval-edit-row">
            <div className="approval-edit-field">
              <label htmlFor={`${baseId}-cc`}>{t('approval.edit.cc')}</label>
              <input
                id={`${baseId}-cc`}
                type="text"
                value={draft.cc}
                disabled={busy}
                onChange={(e) => onChange({ ...draft, cc: e.target.value })}
              />
            </div>
            <div className="approval-edit-field">
              <label htmlFor={`${baseId}-bcc`}>{t('approval.edit.bcc')}</label>
              <input
                id={`${baseId}-bcc`}
                type="text"
                value={draft.bcc}
                disabled={busy}
                onChange={(e) => onChange({ ...draft, bcc: e.target.value })}
              />
            </div>
          </div>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-subject`}>{t('approval.edit.subject')}</label>
            <input
              id={`${baseId}-subject`}
              type="text"
              value={draft.subject}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, subject: e.target.value })}
            />
          </div>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-body`}>{t('approval.edit.body')}</label>
            <textarea
              id={`${baseId}-body`}
              rows={6}
              value={draft.body}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, body: e.target.value })}
            />
          </div>
        </>
      )
    }

    if (editable.tool === 'mail_reply' && draft.kind === 'mail_reply') {
      return (
        <>
          <div className="approval-edit-header">
            <div><strong>{t('approval.edit.to')}:</strong> {editable.to.join(', ')}</div>
            {draft.replyAll && editable.replyAllCc.length > 0 ? (
              <div><strong>{t('approval.edit.cc')}:</strong> {editable.replyAllCc.join(', ')}</div>
            ) : null}
            <div><strong>{t('approval.edit.subject')}:</strong> {editable.subject}</div>
          </div>
          <label className="approval-edit-check" htmlFor={`${baseId}-reply-all`}>
            <input
              id={`${baseId}-reply-all`}
              type="checkbox"
              checked={draft.replyAll}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, replyAll: e.target.checked })}
            />
            <span>{t('approval.edit.replyAll')}</span>
          </label>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-reply-body`}>{t('approval.edit.body')}</label>
            <textarea
              id={`${baseId}-reply-body`}
              rows={6}
              value={draft.body}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, body: e.target.value })}
            />
          </div>
        </>
      )
    }

    if (editable.tool === 'slack_send_message' && draft.kind === 'slack_send_message') {
      return (
        <>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-channel`}>{t('approval.edit.channel')}</label>
            <input
              id={`${baseId}-channel`}
              type="text"
              value={draft.channelId}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, channelId: e.target.value })}
            />
          </div>
          {editable.threadTs ? (
            <div className="approval-edit-header">
              <div><strong>{t('approval.edit.thread')}:</strong> {editable.threadTs}</div>
            </div>
          ) : null}
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-message`}>{t('approval.edit.message')}</label>
            <textarea
              id={`${baseId}-message`}
              rows={5}
              value={draft.text}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, text: e.target.value })}
            />
          </div>
        </>
      )
    }

    if (editable.tool === 'notion_create_page' && draft.kind === 'notion_create_page') {
      return (
        <>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-title`}>{t('approval.edit.title')}</label>
            <input
              id={`${baseId}-title`}
              type="text"
              value={draft.title}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, title: e.target.value })}
            />
          </div>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-markdown`}>{t('approval.edit.markdown')}</label>
            <textarea
              id={`${baseId}-markdown`}
              rows={6}
              value={draft.markdown}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, markdown: e.target.value })}
            />
          </div>
        </>
      )
    }

    if (editable.tool === 'notion_append' && draft.kind === 'notion_append') {
      return (
        <div className="approval-edit-field">
          <label htmlFor={`${baseId}-append-md`}>{t('approval.edit.markdown')}</label>
          <textarea
            id={`${baseId}-append-md`}
            rows={6}
            value={draft.markdown}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, markdown: e.target.value })}
          />
        </div>
      )
    }

    if (editable.tool === 'calendar_create_event' && draft.kind === 'calendar_create_event') {
      return (
        <>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-cal-title`}>{t('approval.edit.title')}</label>
            <input
              id={`${baseId}-cal-title`}
              type="text"
              value={draft.title}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, title: e.target.value })}
            />
          </div>
          <div className="approval-edit-row">
            <div className="approval-edit-field">
              <label htmlFor={`${baseId}-cal-start`}>{t('approval.edit.start')}</label>
              <input
                id={`${baseId}-cal-start`}
                type="text"
                value={draft.start}
                disabled={busy}
                onChange={(e) => onChange({ ...draft, start: e.target.value })}
              />
            </div>
            <div className="approval-edit-field">
              <label htmlFor={`${baseId}-cal-end`}>{t('approval.edit.end')}</label>
              <input
                id={`${baseId}-cal-end`}
                type="text"
                value={draft.end}
                disabled={busy}
                onChange={(e) => onChange({ ...draft, end: e.target.value })}
              />
            </div>
          </div>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-cal-loc`}>{t('approval.edit.location')}</label>
            <input
              id={`${baseId}-cal-loc`}
              type="text"
              value={draft.location}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, location: e.target.value })}
            />
          </div>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-cal-att`}>{t('approval.edit.attendees')}</label>
            <textarea
              id={`${baseId}-cal-att`}
              className="approval-edit-recipients"
              rows={2}
              value={draft.attendees}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, attendees: e.target.value })}
            />
            <span className="approval-edit-hint">{t('approval.edit.recipientsHint')}</span>
          </div>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-cal-desc`}>{t('approval.edit.description')}</label>
            <textarea
              id={`${baseId}-cal-desc`}
              rows={4}
              value={draft.description}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, description: e.target.value })}
            />
          </div>
        </>
      )
    }

    if (editable.tool === 'calendar_update_event' && draft.kind === 'calendar_update_event') {
      return (
        <>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-upd-title`}>{t('approval.edit.title')}</label>
            <input
              id={`${baseId}-upd-title`}
              type="text"
              value={draft.title}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, title: e.target.value })}
            />
          </div>
          <div className="approval-edit-row">
            <div className="approval-edit-field">
              <label htmlFor={`${baseId}-upd-start`}>{t('approval.edit.start')}</label>
              <input
                id={`${baseId}-upd-start`}
                type="text"
                value={draft.start}
                disabled={busy}
                onChange={(e) => onChange({ ...draft, start: e.target.value })}
              />
            </div>
            <div className="approval-edit-field">
              <label htmlFor={`${baseId}-upd-end`}>{t('approval.edit.end')}</label>
              <input
                id={`${baseId}-upd-end`}
                type="text"
                value={draft.end}
                disabled={busy}
                onChange={(e) => onChange({ ...draft, end: e.target.value })}
              />
            </div>
          </div>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-upd-loc`}>{t('approval.edit.location')}</label>
            <input
              id={`${baseId}-upd-loc`}
              type="text"
              value={draft.location}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, location: e.target.value })}
            />
          </div>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-upd-att`}>{t('approval.edit.attendees')}</label>
            <textarea
              id={`${baseId}-upd-att`}
              className="approval-edit-recipients"
              rows={2}
              value={draft.attendees}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, attendees: e.target.value })}
            />
            <span className="approval-edit-hint">{t('approval.edit.recipientsHint')}</span>
          </div>
          <div className="approval-edit-field">
            <label htmlFor={`${baseId}-upd-desc`}>{t('approval.edit.description')}</label>
            <textarea
              id={`${baseId}-upd-desc`}
              rows={4}
              value={draft.description}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, description: e.target.value })}
            />
          </div>
        </>
      )
    }
  }

  return null
}

export function ApprovalChip({ payload, onDecide }: {
  payload: ApprovalPayload
  onDecide: (
    approvalId: number,
    decision: 'approve' | 'discard',
    remember?: RuleDuration,
    items?: number[],
    edit?: ApprovalEditInput,
  ) => void | Promise<void>
}) {
  const t = useT()
  const [choosing, setChoosing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditorDraft | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const items = payload.items ?? []
  const [kept, setKept] = useState(() => new Set(items.map((_, i) => i)))

  useEffect(() => {
    setEditing(false)
    setChoosing(false)
    setDraft(null)
    setSubmitError(null)
  }, [payload.approvalId])

  useEffect(() => {
    if (payload.status !== 'pending') {
      setEditing(false)
      setChoosing(false)
      setDraft(null)
      setSubmitError(null)
    }
  }, [payload.status])

  const toggle = (i: number) => setKept((k) => {
    const next = new Set(k)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    return next
  })
  const scope = payload.kind && payload.target ? `${payload.kind} → ${payload.target}` : null
  const runDecision = (decision: 'approve' | 'discard', remember?: RuleDuration, subset?: number[]) => {
    const res = remember !== undefined
      ? onDecide(payload.approvalId, decision, remember)
      : subset !== undefined
        ? onDecide(payload.approvalId, decision, undefined, subset)
        : onDecide(payload.approvalId, decision)
    if (res && typeof (res as Promise<void>).finally === 'function') {
      setBusy(true)
      void (res as Promise<void>).finally(() => setBusy(false))
    }
  }
  // 全勾着就不传下标：网关默认整批放行
  const approve = () => {
    if (items.length && kept.size < items.length) {
      runDecision('approve', undefined, [...kept].sort((a, b) => a - b))
    } else {
      runDecision('approve')
    }
  }

  const startEdit = () => {
    if (!payload.editable) return
    setChoosing(false)
    setSubmitError(null)
    setDraft(createInitialDraft(payload.editable))
    setEditing(true)
  }

  const resetEdit = () => {
    if (!payload.editable) return
    setSubmitError(null)
    setDraft(createInitialDraft(payload.editable))
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft(null)
    setSubmitError(null)
  }

  // 一条你早先留下的规则已经放行了它：只是告诉你发生了什么，没有按钮
  if (payload.rule) {
    return (
      <div className="approval-chip resolved by-rule">
        <div className="approval-label">{t('approval.byRuleLabel')}</div>
        <div className="approval-action">{payload.action}</div>
        {payload.detail ? <div className="approval-detail">{payload.detail}</div> : null}
        <div className="approval-outcome">
          {t('approval.byRuleOutcome', {
            scope: `${payload.rule.kind} → ${payload.rule.target}`, until: untilLabel(payload.rule.expiresAt, t),
          })}
        </div>
        <ExecutionLine payload={payload} />
      </div>
    )
  }

  const outcomeKey = OUTCOME[payload.status]
  const outcome = outcomeKey ? t(outcomeKey) : undefined
  const approvedCount = payload.approvedItems?.length
  const isEditing = Boolean(!outcome && editing && payload.editable && draft)
  const evaluated = isEditing && payload.editable && draft ? evaluateDraft(payload.editable, draft, t) : null
  const modeError = isEditing && draft?.kind === 'mcp' ? draft.modeError : null
  const validationError = evaluated && !evaluated.ok ? evaluated.error : null
  const activeError = validationError ?? modeError ?? submitError
  const dirty = evaluated ? evaluated.dirty : false

  const submitEdit = () => {
    if (!payload.editable || !draft || busy) return
    const result = evaluateDraft(payload.editable, draft, t)
    if (!result.ok) {
      setSubmitError(result.error)
      return
    }
    setSubmitError(null)
    let res: void | Promise<void>
    try {
      res = result.dirty
        ? onDecide(payload.approvalId, 'approve', undefined, undefined, result.edit)
        : onDecide(payload.approvalId, 'approve')
    } catch (err: unknown) {
      setSubmitError(formatEditError(err, t))
      return
    }
    if (res && typeof (res as Promise<void>).then === 'function') {
      setBusy(true)
      void (res as Promise<void>)
        .catch((err: unknown) => {
          setSubmitError(formatEditError(err, t))
        })
        .finally(() => setBusy(false))
    }
  }

  return (
    <div className={`approval-chip${outcome ? ' resolved' : ''}`}>
      <div className="approval-label">{items.length ? t('approval.needsYouItems', { count: items.length }) : t('approval.needsYou')}</div>
      <div className="approval-action">{payload.action}</div>
      {!isEditing && payload.detail ? <div className="approval-detail">{payload.detail}</div> : null}
      {scope ? <div className="approval-scope">{scope}</div> : null}
      {payload.ruleHeld && !outcome ? (
        <div className="approval-note">
          {t('approval.ruleHeld', {
            scope: scope ?? t('approval.ruleHeldThis'),
            why: t(HELD_BECAUSE[payload.ruleHeld] ?? 'approval.held.unknown'),
          })}
        </div>
      ) : null}
      {payload.rememberBlocked && !outcome ? (
        <div className="approval-note">{t('approval.noAlways', { why: blockReasonText(t, payload.rememberReason, payload.rememberBlocked) })}</div>
      ) : null}
      {items.length ? (
        <BatchItems
          items={items}
          kept={kept}
          {...(outcome ? { approved: payload.approvedItems ?? [] } : { onToggle: toggle })}
        />
      ) : null}
      {outcome ? (
        <>
          <div className="approval-outcome">
            {items.length && approvedCount !== undefined
              ? t('approval.outcomeCount', { outcome, approved: approvedCount, of: items.length })
              : outcome}
            {payload.edited ? ` · ${t('approval.editedBadge')}` : ''}
            {payload.remembered && scope
              ? ` · ${t('approval.outcomeAllowed', { scope, until: untilLabel(payload.remembered.expiresAt, t) })}`
              : ''}
          </div>
          <ExecutionLine payload={payload} />
        </>
      ) : isEditing && payload.editable && draft ? (
        <div className="approval-editor">
          <ApprovalEditorFields
            editable={payload.editable}
            draft={draft}
            busy={busy}
            onChange={(next) => {
              setDraft(next)
              if (submitError) setSubmitError(null)
            }}
          />
          {activeError ? (
            <div className="approval-edit-error" role="alert">{activeError}</div>
          ) : null}
          <div className="approval-buttons">
            <button
              type="button"
              className="approve"
              disabled={busy || Boolean(validationError)}
              onClick={submitEdit}
            >
              {dirty ? t('approval.approveEdited') : t('approval.approve')}
            </button>
            <button
              type="button"
              className="reset"
              disabled={busy || !dirty}
              onClick={resetEdit}
            >
              {t('approval.reset')}
            </button>
            <button
              type="button"
              className="discard"
              disabled={busy}
              onClick={cancelEdit}
            >
              {t('approval.cancel')}
            </button>
          </div>
        </div>
      ) : choosing ? (
        <div className="approval-remember">
          <div className="approval-remember-why">{t('approval.rememberWhy', { scope: scope ?? '' })}</div>
          <div className="approval-buttons">
            {DURATIONS.map((d) => (
              <button type="button" key={d.value} className="remember" disabled={busy} onClick={() => runDecision('approve', d.value)}>
                {t(d.label)}
              </button>
            ))}
            <button type="button" className="discard" disabled={busy} onClick={() => setChoosing(false)}>{t('approval.cancel')}</button>
          </div>
        </div>
      ) : (
        <div className="approval-buttons">
          <button type="button" className="approve" disabled={busy || (items.length > 0 && kept.size === 0)} onClick={approve}>
            {!items.length
              ? t('approval.approve')
              : kept.size === items.length
                ? t('approval.approveAll', { count: items.length })
                : t('approval.approveSome', { kept: kept.size, count: items.length })}
          </button>
          {payload.editable ? (
            <button type="button" className="edit" disabled={busy} onClick={startEdit}>{t('approval.edit')}</button>
          ) : null}
          <button type="button" className="discard" disabled={busy} onClick={() => runDecision('discard')}>{t('approval.discard')}</button>
          {payload.canRemember ? (
            <button type="button" className="remember-toggle" disabled={busy} onClick={() => setChoosing(true)}>{t('approval.alwaysAllow')}</button>
          ) : null}
        </div>
      )}
    </div>
  )
}
