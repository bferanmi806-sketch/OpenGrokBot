import {
  WikiValidationError,
  type WikiListSectionPatch,
  type WikiOverviewPatch,
  type WikiSectionPatch,
} from './types.js'

export const MAX_OVERVIEW_CHARS = 3000
export const MAX_LIST_ITEMS = 20
export const MAX_LIST_ITEM_CHARS = 500
export const MAX_CHANGELOG_LINES = 20
export const MAX_PATCH_REASON_CHARS = 200

export type ManagedSectionKey = 'overview' | 'keyFacts' | 'openItems' | 'decisions' | 'changeLog'
export type ManagedListKey = 'keyFacts' | 'openItems' | 'decisions'

export type ParsedWikiSection = {
  heading: string
  managedKey: ManagedSectionKey | null
  content: string
  rawBlock: string
}

export type ParsedWikiDocument = {
  preamble: string
  sections: ParsedWikiSection[]
}

const CANONICAL_HEADING: Record<ManagedSectionKey, string> = {
  overview: 'Overview',
  keyFacts: 'Key Facts',
  openItems: 'Open Items',
  decisions: 'Decisions',
  changeLog: 'Change Log',
}

const LIST_PREFIX: Record<ManagedListKey, 'f' | 'o' | 'd'> = {
  keyFacts: 'f',
  openItems: 'o',
  decisions: 'd',
}

const LIST_SECTION_ORDER: readonly ManagedListKey[] = ['keyFacts', 'openItems', 'decisions']

const VALID_CHANGELOG_LINE_RE = /^-\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}Z\s+·\s+.+$/
const TOP_KEYED_BULLET_RE = /^\s?[-*+]\s+\[([a-zA-Z]\d+)\]\s+(.+)$/
const TOP_UNKEYED_BULLET_RE = /^\s?[-*+]\s+(.+)$/
const INDENTED_CONTINUATION_RE = /^(?:  +|\t+)/
const MSG_CITATION_RE = /#msg:(\d+)/g

const BEARER_PROSE_WORDS = new Set([
  'token',
  'tokens',
  'auth',
  'authentication',
  'authorization',
  'header',
  'headers',
  'scheme',
  'schemes',
  'credential',
  'credentials',
])

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bxai-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{8,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{8,}\b/g,
  /\bcmp_[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_-]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_-]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
]

export function scrubWikiSecrets(text: string): string {
  if (!text) return text
  let out = text
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]')
  }
  out = out.replace(
    /\b(Bearer\s+)(?!\[REDACTED\])([^\s,;)"'`<>\\\]]{8,})/gi,
    (full, prefix: string, rawTok: string) => {
      const trailingMatch = /[.,;:!?]+$/.exec(rawTok)
      const trailing = trailingMatch ? trailingMatch[0] : ''
      const core = trailing ? rawTok.slice(0, -trailing.length) : rawTok
      if (core.length < 8 || BEARER_PROSE_WORDS.has(core.toLowerCase())) {
        return full
      }
      return `${prefix}[REDACTED]${trailing}`
    },
  )
  out = out.replace(
    /([?&](?:token|key|api[-_]?key|access[-_]?token)=)(?!\[REDACTED\])([^&#\s"'<>),\]]+)/gi,
    '$1[REDACTED]',
  )
  return out
}

export function containsWikiSecret(text: string): boolean {
  if (!text) return false
  return scrubWikiSecrets(text) !== text
}

type FenceState = { char: '`' | '~'; len: number } | null

function matchFenceOpen(line: string): FenceState {
  const backtick = /^\s{0,3}(`{3,})[^`]*$/.exec(line)
  if (backtick) {
    return { char: '`', len: backtick[1]!.length }
  }
  const tilde = /^\s{0,3}(~{3,}).*$/.exec(line)
  if (tilde) {
    return { char: '~', len: tilde[1]!.length }
  }
  return null
}

function isFenceClose(line: string, active: Exclude<FenceState, null>): boolean {
  const m =
    active.char === '`'
      ? /^\s{0,3}(`+)\s*$/.exec(line)
      : /^\s{0,3}(~+)\s*$/.exec(line)
  return Boolean(m && m[1]!.length >= active.len)
}

function classifyHeading(heading: string): ManagedSectionKey | null {
  const norm = heading.trim().replace(/\s+/g, ' ').toLowerCase()
  switch (norm) {
    case 'overview':
      return 'overview'
    case 'key facts':
      return 'keyFacts'
    case 'open items':
      return 'openItems'
    case 'decisions':
      return 'decisions'
    case 'change log':
    case 'changelog':
      return 'changeLog'
    default:
      return null
  }
}

export function parseWikiSections(body: string): ParsedWikiDocument {
  const normalized = (body ?? '').replace(/\r\n?/g, '\n')
  if (!normalized) return { preamble: '', sections: [] }

  const lines = normalized.split('\n')
  const preambleLines: string[] = []
  const rawSections: Array<{ headingLine: string; heading: string; contentLines: string[] }> = []

  let activeFence: FenceState = null

  for (const line of lines) {
    if (activeFence) {
      if (isFenceClose(line, activeFence)) {
        activeFence = null
      }
      if (rawSections.length === 0) preambleLines.push(line)
      else rawSections[rawSections.length - 1]!.contentLines.push(line)
      continue
    }

    const opened = matchFenceOpen(line)
    if (opened) {
      activeFence = opened
      if (rawSections.length === 0) preambleLines.push(line)
      else rawSections[rawSections.length - 1]!.contentLines.push(line)
      continue
    }

    const headingMatch = /^##\s+(.+?)\s*$/.exec(line)
    if (headingMatch) {
      rawSections.push({
        headingLine: line,
        heading: headingMatch[1]!,
        contentLines: [],
      })
      continue
    }

    if (rawSections.length === 0) preambleLines.push(line)
    else rawSections[rawSections.length - 1]!.contentLines.push(line)
  }

  const sections: ParsedWikiSection[] = rawSections.map((s) => {
    const content = s.contentLines.join('\n')
    const rawBlock = s.contentLines.length > 0 ? `${s.headingLine}\n${content}` : s.headingLine
    return {
      heading: s.heading,
      managedKey: classifyHeading(s.heading),
      content,
      rawBlock,
    }
  })

  return {
    preamble: preambleLines.join('\n'),
    sections,
  }
}

export function stripModelChangeLogSections(markdown: string): string {
  const doc = parseWikiSections(markdown)
  const kept = doc.sections.filter((s) => s.managedKey !== 'changeLog')
  if (kept.length === doc.sections.length) return markdown.replace(/\r\n?/g, '\n')
  const parts: string[] = []
  const trimmedPreamble = doc.preamble.trimEnd()
  if (trimmedPreamble) parts.push(trimmedPreamble)
  for (const s of kept) {
    parts.push(s.rawBlock.trimEnd())
  }
  return parts.join('\n\n')
}

export function extractMsgCitations(text: string): number[] {
  const seen = new Set<number>()
  MSG_CITATION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MSG_CITATION_RE.exec(text)) !== null) {
    const id = Number(m[1])
    if (Number.isSafeInteger(id) && id >= 0) {
      seen.add(id)
    }
  }
  return [...seen]
}

function safeClampSingleLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars))
  let end = maxChars - 1
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1
  }
  return `${text.slice(0, end).trimEnd()}…`
}

type ListEntry = {
  id: string
  text: string
  rawLines: string[]
}

type ManagedListNode =
  | { kind: 'entry'; entry: ListEntry }
  | { kind: 'static'; rawLines: string[] }

function parseManagedListNodes(content: string, prefix: 'f' | 'o' | 'd'): ManagedListNode[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')

  // Pass 1: collect all explicit IDs outside fenced code blocks
  const reservedIds = new Set<string>()
  let scanFence: FenceState = null
  for (const rawLine of lines) {
    if (scanFence) {
      if (isFenceClose(rawLine, scanFence)) scanFence = null
      continue
    }
    const opened = matchFenceOpen(rawLine)
    if (opened) {
      scanFence = opened
      continue
    }
    if (INDENTED_CONTINUATION_RE.test(rawLine)) continue
    const keyed = TOP_KEYED_BULLET_RE.exec(rawLine.trimEnd())
    if (keyed) {
      reservedIds.add(keyed[1]!)
    }
  }

  // Pass 2: build ordered nodes (entries with continuations + static non-bullet/fenced blocks)
  const seenExplicitIds = new Set<string>()
  let nextSeq = 1
  const allocateFreshId = (): string => {
    while (reservedIds.has(`${prefix}${nextSeq}`) || seenExplicitIds.has(`${prefix}${nextSeq}`)) {
      nextSeq += 1
    }
    const id = `${prefix}${nextSeq}`
    reservedIds.add(id)
    seenExplicitIds.add(id)
    nextSeq += 1
    return id
  }

  const nodes: ManagedListNode[] = []
  let currentEntry: ListEntry | null = null
  let currentStatic: string[] | null = null
  let activeFence: FenceState = null
  let fenceInEntry = false

  const appendStatic = (line: string) => {
    currentEntry = null
    if (!currentStatic) {
      currentStatic = [line]
      nodes.push({ kind: 'static', rawLines: currentStatic })
    } else {
      currentStatic.push(line)
    }
  }

  for (const rawLine of lines) {
    if (activeFence) {
      if (fenceInEntry && currentEntry) {
        currentEntry.rawLines.push(rawLine)
      } else {
        appendStatic(rawLine)
      }
      if (isFenceClose(rawLine, activeFence)) {
        activeFence = null
        fenceInEntry = false
      }
      continue
    }

    const opened = matchFenceOpen(rawLine)
    if (opened) {
      activeFence = opened
      if (currentEntry && INDENTED_CONTINUATION_RE.test(rawLine)) {
        fenceInEntry = true
        currentEntry.rawLines.push(rawLine)
      } else {
        fenceInEntry = false
        appendStatic(rawLine)
      }
      continue
    }

    if (rawLine.trim() === '') {
      currentEntry = null
      currentStatic = null
      continue
    }

    if (INDENTED_CONTINUATION_RE.test(rawLine)) {
      if (currentEntry) {
        currentEntry.rawLines.push(rawLine.trimEnd())
      } else {
        appendStatic(rawLine.trimEnd())
      }
      continue
    }

    const trimmedEnd = rawLine.trimEnd()
    const keyed = TOP_KEYED_BULLET_RE.exec(trimmedEnd)
    if (keyed) {
      currentStatic = null
      const rawId = keyed[1]!
      const text = keyed[2]!
      let id = rawId
      let firstLine = trimmedEnd.trimStart()
      if (seenExplicitIds.has(rawId)) {
        // Duplicate explicit ID (e.g. merged duplicate sections): assign fresh non-colliding ID
        id = allocateFreshId()
        firstLine = `- [${id}] ${text}`
      } else {
        seenExplicitIds.add(rawId)
        if (!firstLine.startsWith('- ')) {
          firstLine = `- [${id}] ${text}`
        }
      }
      const entry: ListEntry = { id, text, rawLines: [firstLine] }
      currentEntry = entry
      nodes.push({ kind: 'entry', entry })
      continue
    }

    const unkeyed = TOP_UNKEYED_BULLET_RE.exec(trimmedEnd)
    if (unkeyed) {
      const text = unkeyed[1]!.trim()
      if (text) {
        currentStatic = null
        const id = allocateFreshId()
        const entry: ListEntry = { id, text, rawLines: [`- [${id}] ${text}`] }
        currentEntry = entry
        nodes.push({ kind: 'entry', entry })
        continue
      }
    }

    appendStatic(trimmedEnd)
  }

  return nodes
}

function normalizeSingleLineItem(raw: unknown, label: string): string {
  if (typeof raw !== 'string') {
    throw new WikiValidationError(`${label} text must be a string`)
  }
  const collapsed = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*+]\s+(?:\[[a-zA-Z]\d+\]\s+)?/, '')
    .trim()
  const scrubbed = scrubWikiSecrets(collapsed)
  if (!scrubbed) {
    throw new WikiValidationError(`${label} text must not be empty`)
  }
  if (scrubbed.length > MAX_LIST_ITEM_CHARS) {
    throw new WikiValidationError(`${label} text exceeds ${MAX_LIST_ITEM_CHARS} characters`)
  }
  return scrubbed
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function applyManagedListPatch(
  existingContent: string,
  patch: WikiListSectionPatch | undefined,
  key: ManagedListKey,
  atMs: number,
): { renderedBody: string | null; changed: boolean; summaryParts: string[] } {
  const prefix = LIST_PREFIX[key]
  const heading = CANONICAL_HEADING[key]
  const initialNodes = parseManagedListNodes(existingContent, prefix)
  const initialEntries = initialNodes
    .filter((n): n is { kind: 'entry'; entry: ListEntry } => n.kind === 'entry')
    .map((n) => n.entry)

  if (!patch) {
    return { renderedBody: null, changed: false, summaryParts: [] }
  }
  if (!isPlainRecord(patch)) {
    throw new WikiValidationError(`${heading} patch must be an object`)
  }

  if (patch.add !== undefined && !Array.isArray(patch.add)) {
    throw new WikiValidationError(`${heading} "add" must be an array`)
  }
  if (patch.update !== undefined && !Array.isArray(patch.update)) {
    throw new WikiValidationError(`${heading} "update" must be an array`)
  }
  if (patch.remove !== undefined && !Array.isArray(patch.remove)) {
    throw new WikiValidationError(`${heading} "remove" must be an array`)
  }

  const existingById = new Map(initialEntries.map((e) => [e.id, e]))
  const touchedIds = new Set<string>()
  const removeMap = new Map<string, string>()
  const updateMap = new Map<string, string>()

  for (const item of patch.remove ?? []) {
    if (!isPlainRecord(item) || typeof item.id !== 'string') {
      throw new WikiValidationError(`${heading} remove entry requires string "id" and "reason"`)
    }
    const id = item.id.trim()
    if (!id || !existingById.has(id)) {
      throw new WikiValidationError(`Cannot remove unknown id "${id}" in ${heading}`)
    }
    if (touchedIds.has(id)) {
      throw new WikiValidationError(`Duplicate patch operation on id "${id}" in ${heading}`)
    }
    const reason = typeof item.reason === 'string' ? scrubWikiSecrets(item.reason.replace(/\s+/g, ' ').trim()) : ''
    if (!reason) {
      throw new WikiValidationError(`Removing "${id}" in ${heading} requires a non-empty reason`)
    }
    if (reason.length > MAX_PATCH_REASON_CHARS) {
      throw new WikiValidationError(`Removal reason for "${id}" in ${heading} exceeds ${MAX_PATCH_REASON_CHARS} characters`)
    }
    touchedIds.add(id)
    removeMap.set(id, reason)
  }

  for (const item of patch.update ?? []) {
    if (!isPlainRecord(item) || typeof item.id !== 'string') {
      throw new WikiValidationError(`${heading} update entry requires string "id" and "text"`)
    }
    const id = item.id.trim()
    if (!id || !existingById.has(id)) {
      throw new WikiValidationError(`Cannot update unknown id "${id}" in ${heading}`)
    }
    if (touchedIds.has(id)) {
      throw new WikiValidationError(`Duplicate patch operation on id "${id}" in ${heading}`)
    }
    const text = normalizeSingleLineItem(item.text, `${heading} [${id}]`)
    touchedIds.add(id)
    updateMap.set(id, text)
  }

  let maxNum = 0
  for (const entry of initialEntries) {
    if (entry.id.startsWith(prefix)) {
      const n = Number(entry.id.slice(prefix.length))
      if (Number.isInteger(n) && n > maxNum) maxNum = n
    }
  }

  const addedEntries: ListEntry[] = []
  for (const item of patch.add ?? []) {
    if (!isPlainRecord(item)) {
      throw new WikiValidationError(`${heading} add entry must be an object with "text"`)
    }
    const text = normalizeSingleLineItem(item.text, heading)
    maxNum += 1
    const id = `${prefix}${maxNum}`
    addedEntries.push({
      id,
      text,
      rawLines: [`- [${id}] ${text}`],
    })
  }

  const changed = removeMap.size > 0 || updateMap.size > 0 || addedEntries.length > 0
  if (!changed) {
    return { renderedBody: null, changed: false, summaryParts: [] }
  }

  let nextEntries: ListEntry[] = []
  for (const entry of initialEntries) {
    if (removeMap.has(entry.id)) continue
    const updatedText = updateMap.get(entry.id)
    if (updatedText !== undefined) {
      nextEntries.push({
        id: entry.id,
        text: updatedText,
        rawLines: [`- [${entry.id}] ${updatedText}`],
      })
    } else {
      nextEntries.push(entry)
    }
  }
  nextEntries.push(...addedEntries)

  let archivedOverflow = false
  if (nextEntries.length > MAX_LIST_ITEMS) {
    archivedOverflow = true
    const keepCount = MAX_LIST_ITEMS - 1
    const overflow = nextEntries.slice(0, nextEntries.length - keepCount)
    const kept = nextEntries.slice(nextEntries.length - keepCount)
    const dateStr = formatUtcDate(atMs)
    const archiveId = `${prefix}0`
    const bulletPrefix = `- [${archiveId}] `
    const pieces = overflow.map((e) => {
      if (e.id === archiveId) {
        return e.text.replace(/^Earlier items \(archived \d{4}-\d{2}-\d{2}\):\s*/, '')
      }
      return e.text
    })
    const rawArchiveText = `Earlier items (archived ${dateStr}): ${pieces.join('; ')}`
    const clampedArchiveText = safeClampSingleLine(rawArchiveText, MAX_LIST_ITEM_CHARS - bulletPrefix.length)
    nextEntries = [
      {
        id: archiveId,
        text: clampedArchiveText,
        rawLines: [`${bulletPrefix}${clampedArchiveText}`],
      },
      ...kept,
    ]
  }

  // Reconstruct section body preserving any static blocks (notes, subheadings, top-level code fences) in place
  const staticBlocks = initialNodes.filter((n): n is { kind: 'static'; rawLines: string[] } => n.kind === 'static')
  const renderedLines: string[] = []
  if (!archivedOverflow && staticBlocks.length > 0) {
    const updatedById = new Map(nextEntries.map((e) => [e.id, e]))
    const addedSet = new Set(addedEntries)
    let emittedAnyEntry = false
    for (const node of initialNodes) {
      if (node.kind === 'static') {
        renderedLines.push(node.rawLines.join('\n'))
      } else {
        const survived = updatedById.get(node.entry.id)
        if (survived) {
          renderedLines.push(survived.rawLines.join('\n'))
          emittedAnyEntry = true
        }
      }
    }
    for (const added of addedEntries) {
      if (addedSet.has(added)) {
        renderedLines.push(added.rawLines.join('\n'))
        emittedAnyEntry = true
      }
    }
    if (!emittedAnyEntry && staticBlocks.length === 0) {
      return { renderedBody: '', changed: true, summaryParts: [`${heading} (-${removeMap.size})`] }
    }
  } else {
    for (const s of staticBlocks) {
      renderedLines.push(s.rawLines.join('\n'))
    }
    for (const entry of nextEntries) {
      renderedLines.push(entry.rawLines.join('\n'))
    }
  }

  const counts: string[] = []
  if (addedEntries.length > 0) counts.push(`+${addedEntries.length}`)
  if (updateMap.size > 0) counts.push(`~${updateMap.size}`)
  if (removeMap.size > 0) counts.push(`-${removeMap.size}`)

  return {
    renderedBody: renderedLines.join('\n'),
    changed: true,
    summaryParts: [`${heading} (${counts.join(' ')})`],
  }
}

function applyOverviewPatch(
  existingContent: string | undefined,
  patch: WikiOverviewPatch | undefined,
): { content: string | undefined; changed: boolean; summaryPart?: string } {
  if (!patch) {
    return { content: existingContent, changed: false }
  }
  if (!isPlainRecord(patch)) {
    throw new WikiValidationError('Overview patch must be an object')
  }
  if (patch.mode === 'keep') {
    return { content: existingContent, changed: false }
  }
  if (patch.mode !== 'rewrite') {
    throw new WikiValidationError('Invalid overview patch mode; expected "keep" or "rewrite"')
  }

  if (typeof patch.content !== 'string') {
    throw new WikiValidationError('Overview rewrite requires string "content"')
  }
  if (typeof patch.reason !== 'string') {
    throw new WikiValidationError('Overview rewrite requires string "reason"')
  }

  const withoutChangeLog = stripModelChangeLogSections(patch.content)
    .replace(/^\s*##\s+overview\s*(?:\n|$)/i, '')
    .trim()

  // Reject top-level "## " headings outside fenced code blocks inside overview.content
  const nestedDoc = parseWikiSections(withoutChangeLog)
  if (nestedDoc.sections.length > 0) {
    throw new WikiValidationError(
      `Overview content cannot contain top-level "## " headings (found "## ${nestedDoc.sections[0]!.heading}"); use ### subheadings instead`,
    )
  }

  const cleanedContent = scrubWikiSecrets(withoutChangeLog)
  if (!cleanedContent) {
    throw new WikiValidationError('Overview rewrite content must not be empty')
  }
  if (cleanedContent.length > MAX_OVERVIEW_CHARS) {
    throw new WikiValidationError(`Overview content exceeds ${MAX_OVERVIEW_CHARS} characters`)
  }

  const cleanedReason = scrubWikiSecrets(patch.reason.replace(/\s+/g, ' ').trim())
  if (!cleanedReason) {
    throw new WikiValidationError('Overview rewrite requires a non-empty reason')
  }
  if (cleanedReason.length > MAX_PATCH_REASON_CHARS) {
    throw new WikiValidationError(`Overview rewrite reason exceeds ${MAX_PATCH_REASON_CHARS} characters`)
  }

  const droppedReasons = new Map<number, string>()
  if (patch.droppedCitations !== undefined) {
    if (!Array.isArray(patch.droppedCitations)) {
      throw new WikiValidationError('Overview droppedCitations must be an array')
    }
    for (const entry of patch.droppedCitations) {
      if (
        !isPlainRecord(entry) ||
        typeof entry.msgId !== 'number' ||
        !Number.isSafeInteger(entry.msgId) ||
        entry.msgId < 0
      ) {
        throw new WikiValidationError('droppedCitations entries require a valid integer msgId')
      }
      const r = typeof entry.reason === 'string' ? scrubWikiSecrets(entry.reason.replace(/\s+/g, ' ').trim()) : ''
      if (!r) {
        throw new WikiValidationError(`droppedCitations reason for #msg:${entry.msgId} must not be empty`)
      }
      if (r.length > MAX_PATCH_REASON_CHARS) {
        throw new WikiValidationError(
          `droppedCitations reason for #msg:${entry.msgId} exceeds ${MAX_PATCH_REASON_CHARS} characters`,
        )
      }
      droppedReasons.set(entry.msgId, r)
    }
  }

  if (existingContent) {
    const prevIds = extractMsgCitations(existingContent)
    if (prevIds.length > 0) {
      const nextIds = new Set(extractMsgCitations(cleanedContent))
      const missing = prevIds.filter((id) => !nextIds.has(id) && !droppedReasons.has(id))
      if (missing.length > 0) {
        throw new WikiValidationError(
          `Overview rewrite dropped citation(s) without droppedCitations justification: ${missing.map((id) => `#msg:${id}`).join(', ')}`,
        )
      }
    }
  }

  return {
    content: cleanedContent,
    changed: cleanedContent !== (existingContent ?? '').trim(),
    summaryPart: `Overview (${cleanedReason})`,
  }
}

function formatUtcDate(atMs: number): string {
  const d = new Date(Number.isFinite(atMs) ? atMs : Date.now())
  return Number.isNaN(d.getTime()) ? '1970-01-01' : d.toISOString().slice(0, 10)
}

function formatUtcStamp(atMs: number): string {
  const d = new Date(Number.isFinite(atMs) ? atMs : Date.now())
  if (Number.isNaN(d.getTime())) return '1970-01-01 00:00Z'
  const iso = d.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`
}

function extractValidChangeLogLines(sections: readonly ParsedWikiSection[]): string[] {
  const valid: string[] = []
  for (const sec of sections) {
    if (sec.managedKey !== 'changeLog') continue
    for (const raw of sec.content.split('\n')) {
      const trimmed = raw.trim()
      if (VALID_CHANGELOG_LINE_RE.test(trimmed)) {
        valid.push(trimmed)
      }
    }
  }
  return valid
}

function renderUntouchedSingleSection(sec: ParsedWikiSection, canonicalTitle: string): string {
  const trimmedContent = sec.content.replace(/^\n+/, '').trimEnd()
  return trimmedContent ? `## ${canonicalTitle}\n${trimmedContent}` : `## ${canonicalTitle}`
}

export function applyWikiSectionPatch(
  existingBody: string,
  patch: WikiSectionPatch,
  meta: {
    actor: string
    at: number
    note?: string
    fallbackNote?: string
  },
): { body: string; changed: boolean; changeSummary: string } {
  if (!isPlainRecord(patch)) {
    throw new WikiValidationError('Wiki section patch must be an object')
  }

  const actor = scrubWikiSecrets(meta.actor.replace(/\s+/g, ' ').trim()) || 'bot'
  const atMs = meta.at
  const parsed = parseWikiSections(existingBody)

  // Collect ALL existing Overview sections so duplicate ## Overview sections are never silently dropped
  const existingOverviewSecs = parsed.sections.filter((s) => s.managedKey === 'overview')
  const combinedExistingOverview =
    existingOverviewSecs.length === 0
      ? undefined
      : existingOverviewSecs
          .map((s) => s.content.replace(/^\n+/, '').trimEnd())
          .filter(Boolean)
          .join('\n\n')

  const overviewRes = applyOverviewPatch(combinedExistingOverview, patch.overview)

  const listResults = {} as Record<
    ManagedListKey,
    {
      renderedBody: string | null
      changed: boolean
      summaryParts: string[]
      existingSecs: ParsedWikiSection[]
    }
  >
  for (const key of LIST_SECTION_ORDER) {
    const existingSecs = parsed.sections.filter((s) => s.managedKey === key)
    const combinedExisting = existingSecs.map((s) => s.content).join('\n')
    const res = applyManagedListPatch(combinedExisting, patch[key], key, atMs)
    listResults[key] = {
      ...res,
      existingSecs,
    }
  }

  const summaryParts: string[] = []
  if (overviewRes.changed && overviewRes.summaryPart) {
    summaryParts.push(overviewRes.summaryPart)
  }
  for (const key of LIST_SECTION_ORDER) {
    if (listResults[key].changed) {
      summaryParts.push(...listResults[key].summaryParts)
    }
  }

  const bodyChanged =
    overviewRes.changed ||
    LIST_SECTION_ORDER.some((k) => listResults[k].changed)

  const cleanNote = meta.note ? scrubWikiSecrets(meta.note.replace(/\s+/g, ' ').trim()) : ''
  const cleanFallback = meta.fallbackNote ? scrubWikiSecrets(meta.fallbackNote.replace(/\s+/g, ' ').trim()) : ''

  if (!bodyChanged && !cleanFallback) {
    const stripped = stripModelChangeLogSections(existingBody)
    const validExistingLogs = extractValidChangeLogLines(parsed.sections)
    if (validExistingLogs.length === 0) {
      return { body: stripped, changed: false, changeSummary: '' }
    }
    const parts: string[] = []
    if (stripped.trimEnd()) parts.push(stripped.trimEnd())
    parts.push(`## Change Log\n${validExistingLogs.slice(0, MAX_CHANGELOG_LINES).join('\n')}`)
    return { body: parts.join('\n\n'), changed: false, changeSummary: '' }
  }

  const baseSummary = summaryParts.join('; ') || cleanFallback || 'updated page'
  const fullSummary = cleanNote && !baseSummary.includes(cleanNote)
    ? `${baseSummary} — ${cleanNote}`
    : baseSummary
  const changeSummary = safeClampSingleLine(fullSummary, MAX_PATCH_REASON_CHARS)

  const validExistingLogs = extractValidChangeLogLines(parsed.sections)
  const newLogLine = `- ${formatUtcStamp(atMs)} · ${actor} · ${changeSummary}`
  const nextLogLines = [newLogLine, ...validExistingLogs].slice(0, MAX_CHANGELOG_LINES)

  const outBlocks: string[] = []
  const trimmedPreamble = parsed.preamble.trimEnd()
  if (trimmedPreamble) {
    outBlocks.push(trimmedPreamble)
  }

  const emittedManaged = new Set<ManagedSectionKey>()

  const renderManagedSection = (key: Exclude<ManagedSectionKey, 'changeLog'>): string | null => {
    if (key === 'overview') {
      if (overviewRes.changed && overviewRes.content !== undefined) {
        return `## ${CANONICAL_HEADING.overview}\n${overviewRes.content.trimEnd()}`
      }
      if (existingOverviewSecs.length === 1) {
        return renderUntouchedSingleSection(existingOverviewSecs[0]!, CANONICAL_HEADING.overview)
      }
      if (existingOverviewSecs.length > 1) {
        return combinedExistingOverview
          ? `## ${CANONICAL_HEADING.overview}\n${combinedExistingOverview}`
          : `## ${CANONICAL_HEADING.overview}`
      }
      return null
    }

    const res = listResults[key]
    if (!res.changed) {
      if (res.existingSecs.length === 0) return null
      if (res.existingSecs.length === 1) {
        // Untouched single managed list section: preserve raw content verbatim!
        return renderUntouchedSingleSection(res.existingSecs[0]!, CANONICAL_HEADING[key])
      }
      // Multiple duplicate sections when untouched: merge cleanly without collisions
      const mergedNodes = parseManagedListNodes(
        res.existingSecs.map((s) => s.content).join('\n'),
        LIST_PREFIX[key],
      )
      const mergedBody = mergedNodes
        .map((n) => (n.kind === 'static' ? n.rawLines.join('\n') : n.entry.rawLines.join('\n')))
        .join('\n')
      return mergedBody
        ? `## ${CANONICAL_HEADING[key]}\n${mergedBody}`
        : `## ${CANONICAL_HEADING[key]}`
    }

    if (!res.renderedBody) return null
    return `## ${CANONICAL_HEADING[key]}\n${res.renderedBody}`
  }

  if (existingOverviewSecs.length === 0 && overviewRes.changed && overviewRes.content !== undefined) {
    emittedManaged.add('overview')
    outBlocks.push(`## ${CANONICAL_HEADING.overview}\n${overviewRes.content.trimEnd()}`)
  }

  for (const sec of parsed.sections) {
    if (sec.managedKey === null) {
      outBlocks.push(sec.rawBlock.trimEnd())
      continue
    }
    if (sec.managedKey === 'changeLog') {
      continue
    }
    if (emittedManaged.has(sec.managedKey)) {
      continue
    }
    emittedManaged.add(sec.managedKey)
    const rendered = renderManagedSection(sec.managedKey)
    if (rendered !== null) {
      outBlocks.push(rendered)
    }
  }

  for (const key of ['overview', ...LIST_SECTION_ORDER] as const) {
    if (emittedManaged.has(key)) continue
    emittedManaged.add(key)
    const rendered = renderManagedSection(key)
    if (rendered !== null) {
      outBlocks.push(rendered)
    }
  }

  outBlocks.push(`## ${CANONICAL_HEADING.changeLog}\n${nextLogLines.join('\n')}`)

  return {
    body: outBlocks.join('\n\n'),
    changed: true,
    changeSummary,
  }
}
