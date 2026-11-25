import type { BotRow, Db, MessageKind } from '../db.js'
import type { Hub } from '../hub.js'
import type { LLM } from '../llm.js'
import { searchWikiRrf } from './rrf.js'
import { scrubWikiSecrets } from './sections.js'
import { getWikiPage, getWikiPageById, listWikiPages, patchWikiPage } from './store.js'
import { extractQueryTokens } from './tokenize.js'
import {
  WikiConflictError,
  WikiValidationError,
  type WikiKind,
  type WikiListSectionPatch,
  type WikiOverviewPatch,
} from './types.js'

export const WIKI_IDLE_QUIET_MS = 30 * 60_000
export const MAX_SYNC_MESSAGES_PER_THREAD = 25
export const MIN_SUBSTANTIVE_CHARS = 12
export const MAX_FORCE_BATCHES_PER_THREAD = 10

const MAX_MESSAGE_TRANSCRIPT_CHARS = 1200
const MAX_TOTAL_TRANSCRIPT_CHARS = 12_000
const MAX_EXISTING_PAGE_INDEX = 40
const MAX_MATCHED_FULL_PAGES = 5
const MAX_MATCHED_BODY_CHARS = 2500
const MAX_OPERATIONS_PER_BATCH = 10
const ACTION_TAINT_LOOKBACK_MS = 25 * 60_000
const ACTION_TAINT_LOOKAHEAD_MS = 60_000
const CONTEXT_MESSAGE_TAINT_LOOKBACK = 40

export type WikiSyncResult = {
  ok: true
  threadsSynced: number
  pagesCreated: number
  pagesUpdated: number
}

export type WikiAutoSyncDeps = {
  db: Db
  dataDir?: string
  hub?: Hub
  llm: LLM
  llmForThread?: (threadId: string, threadBotId: string | null) => LLM
  isThreadBusy?: (threadId: string) => boolean
  isStopping?: () => boolean
  signal?: AbortSignal
  now?: () => number
}

export function markWikiSyncThreadTainted(db: Db, threadId: string, now = Date.now()): void {
  if (!db.open || !threadId) return
  db.prepare(
    `INSERT INTO wiki_sync_state (thread_id, last_synced_message_id, pending_taint, updated_at)
     VALUES (?, 0, 1, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       pending_taint = 1,
       updated_at = excluded.updated_at`,
  ).run(threadId, now)
}

type SyncMutexState = {
  active: Promise<WikiSyncResult> | null
  activeIsForce: boolean
  queuedForce: {
    deps: WikiAutoSyncDeps
    signal?: AbortSignal
    promise: Promise<WikiSyncResult>
    resolve: (res: WikiSyncResult) => void
    reject: (err: unknown) => void
  } | null
}

const syncLocks = new WeakMap<Db, SyncMutexState>()

function getMutexState(db: Db): SyncMutexState {
  let state = syncLocks.get(db)
  if (!state) {
    state = { active: null, activeIsForce: false, queuedForce: null }
    syncLocks.set(db, state)
  }
  return state
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fenced ? fenced[1]!.trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

type RawSyncMessageRow = {
  id: number
  thread_id: string
  sender: string
  kind: MessageKind
  content: string
  payload: string | null
  created_at: number
}

function formatMessageLine(
  row: RawSyncMessageRow,
  botNames: Record<string, string>,
): { line: string; substantiveLen: number } | null {
  if (row.kind === 'text') {
    const raw = row.content.trim()
    if (!raw) return null
    const speaker = row.sender === 'user' ? 'Operator' : (botNames[row.sender] ?? row.sender)
    const scrubbed = scrubWikiSecrets(raw).slice(0, MAX_MESSAGE_TRANSCRIPT_CHARS)
    return {
      line: `[#msg:${row.id}] ${speaker}: ${scrubbed}`,
      substantiveLen: raw.length,
    }
  }
  if (row.kind === 'report' && row.payload) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      parsed = null
    }
    if (!isRecord(parsed)) return null
    const lines = Array.isArray(parsed.lines)
      ? parsed.lines
          .map((l) =>
            isRecord(l)
              ? [l.system, l.result, l.count]
                  .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
                  .join(' ')
              : '',
          )
          .filter(Boolean)
          .join('; ')
      : ''
    const closing = typeof parsed.closing === 'string' ? parsed.closing.trim() : ''
    const combined = [lines, closing].filter(Boolean).join(' — ').trim()
    if (!combined) return null
    const speaker = `${botNames[row.sender] ?? row.sender} [report]`
    const scrubbed = scrubWikiSecrets(combined).slice(0, MAX_MESSAGE_TRANSCRIPT_CHARS)
    return {
      line: `[#msg:${row.id}] ${speaker}: ${scrubbed}`,
      substantiveLen: combined.length,
    }
  }
  return null
}

function isExternalOrTaintedAction(
  db: Db,
  action: { tool: string; trigger: string; summary: string },
): boolean {
  if (action.trigger === 'webhook') return true
  const tool = action.tool
  if (
    tool === 'webhook' ||
    tool === 'web_search' ||
    tool === 'web_fetch' ||
    tool === 'wiki_search' ||
    tool === 'space_read' ||
    tool === 'search_history' ||
    tool.startsWith('browser_') ||
    tool.startsWith('mail_') ||
    tool.startsWith('calendar_') ||
    tool.startsWith('slack_') ||
    tool.startsWith('notion_') ||
    tool.startsWith('polery_') ||
    tool.startsWith('mcp__')
  ) {
    return true
  }
  if (tool === 'wiki_read') {
    const pageId = action.summary.trim()
    if (pageId && getWikiPageById(db, pageId, { includeArchived: true })?.sourceTainted === true) {
      return true
    }
  }
  return false
}

function isMessageRowTainted(m: { kind: string; payload: string | null }): boolean {
  if (m.kind === 'webhook' || m.kind === 'quiet_digest') {
    return true
  }
  if (!m.payload) return false
  try {
    const p = JSON.parse(m.payload) as unknown
    if (!isRecord(p)) return false
    if (p.tainted === true || p.sourceTainted === true) {
      return true
    }
    if (
      m.kind === 'dispatch_plan' &&
      Array.isArray(p.steps) &&
      p.steps.some((s) => isRecord(s) && s.outputTainted === true)
    ) {
      return true
    }
  } catch {
    // Ignore malformed payload JSON
  }
  return false
}

function detectBatchTainted(
  db: Db,
  threadId: string,
  afterId: number,
  batchMaxId: number,
  prevSyncedAt: number,
): boolean {
  const windowMessages = db
    .prepare(
      `SELECT id, kind, payload, created_at
       FROM messages
       WHERE thread_id = ? AND id > ? AND id <= ?
       ORDER BY id ASC`,
    )
    .all(threadId, afterId, batchMaxId) as Array<{
    id: number
    kind: string
    payload: string | null
    created_at: number
  }>

  if (windowMessages.length === 0) return false

  let minAt = Number.POSITIVE_INFINITY
  let maxAt = Number.NEGATIVE_INFINITY
  for (const m of windowMessages) {
    if (m.created_at < minAt) minAt = m.created_at
    if (m.created_at > maxAt) maxAt = m.created_at
    if (isMessageRowTainted(m)) return true
  }

  // Also inspect recent pre-afterId context messages in the thread (matching agent context window)
  const recentContextMessages = db
    .prepare(
      `SELECT id, kind, payload
       FROM messages
       WHERE thread_id = ? AND id <= ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(threadId, batchMaxId, CONTEXT_MESSAGE_TAINT_LOOKBACK) as Array<{
    id: number
    kind: string
    payload: string | null
  }>
  for (const m of recentContextMessages) {
    if (isMessageRowTainted(m)) return true
  }

  // Thread checkpoints with compressed webhook payloads
  const hadCheckpointWebhook = db
    .prepare(`SELECT 1 FROM thread_checkpoints WHERE thread_id = ? AND had_webhook = 1 LIMIT 1`)
    .get(threadId)
  if (hadCheckpointWebhook) return true

  // Tainted background tasks, dispatch plans / step outputs, feed items, or ideas bound to this thread
  const hasTaintedBg = db
    .prepare(`SELECT 1 FROM background_tasks WHERE thread_id = ? AND source_tainted = 1 LIMIT 1`)
    .get(threadId)
  if (hasTaintedBg) return true

  const hasTaintedPlan = db
    .prepare(
      `SELECT 1
       FROM dispatch_plans
       WHERE thread_id = ?
         AND (
           source_tainted = 1
           OR EXISTS (
             SELECT 1 FROM dispatch_plan_steps s
             WHERE s.plan_id = dispatch_plans.id AND s.output_tainted = 1
           )
         )
       LIMIT 1`,
    )
    .get(threadId)
  if (hasTaintedPlan) return true

  const hasTaintedFeed = db
    .prepare(`SELECT 1 FROM feed_items WHERE thread_id = ? AND tainted = 1 LIMIT 1`)
    .get(threadId)
  if (hasTaintedFeed) return true

  const hasTaintedIdea = db
    .prepare(
      `SELECT 1 FROM ideas WHERE (source_thread_id = ? OR incubation_thread_id = ?) AND tainted = 1 LIMIT 1`,
    )
    .get(threadId, threadId)
  if (hasTaintedIdea) return true

  const baselineLookback = minAt - ACTION_TAINT_LOOKBACK_MS
  const lookbackStart =
    prevSyncedAt > 0 ? Math.min(prevSyncedAt, baselineLookback) : baselineLookback
  const lookbackEnd = maxAt + ACTION_TAINT_LOOKAHEAD_MS

  const actions = db
    .prepare(
      `SELECT tool, trigger, summary
       FROM actions
       WHERE thread_id = ? AND created_at >= ? AND created_at <= ?`,
    )
    .all(threadId, lookbackStart, lookbackEnd) as Array<{
    tool: string
    trigger: string
    summary: string
  }>

  for (const act of actions) {
    if (isExternalOrTaintedAction(db, act)) {
      return true
    }
  }

  return false
}

function advanceSyncCursor(db: Db, threadId: string, messageId: number, atMs: number): void {
  const maxUnsyncedId = Number(
    db
      .prepare(
        `SELECT COALESCE(MAX(id), 0)
         FROM messages
         WHERE thread_id = ? AND kind IN ('text', 'report')`,
      )
      .pluck()
      .get(threadId) ?? 0,
  )
  const clearPendingTaint = messageId >= maxUnsyncedId ? 1 : 0

  db.prepare(
    `INSERT INTO wiki_sync_state (thread_id, last_synced_message_id, pending_taint, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       last_synced_message_id = CASE
         WHEN excluded.last_synced_message_id > wiki_sync_state.last_synced_message_id
           THEN excluded.last_synced_message_id
         ELSE wiki_sync_state.last_synced_message_id
       END,
       pending_taint = CASE
         WHEN ? = 1 THEN 0
         ELSE wiki_sync_state.pending_taint
       END,
       updated_at = excluded.updated_at`,
  ).run(threadId, messageId, atMs, clearPendingTaint)
}

function buildExistingWikiContext(db: Db, transcript: string, nowMs: number): string {
  const { pages: allPages } = listWikiPages(db, { limit: MAX_EXISTING_PAGE_INDEX })
  if (allPages.length === 0) {
    return 'Existing Wiki Pages: (none yet)'
  }

  const indexLines = allPages.map((p) => {
    const tags = p.tags.length ? ` [tags: ${p.tags.join(', ')}]` : ''
    const summary = p.summary ? ` — ${p.summary}` : ''
    return `- ${p.id}: "${p.title}"${summary}${tags}`
  })

  // Strip "[#msg:<id>] <Speaker>: " prefixes before extracting RRF query tokens
  const strippedTranscript = transcript.replace(/^\[#msg:\d+\]\s*[^:\n]{1,40}:\s*/gm, '')
  const tokens = extractQueryTokens(strippedTranscript)
  const queries: string[] = []
  if (tokens.length > 0 && tokens.length <= 2) {
    queries.push(tokens.join(' '))
  } else {
    for (let i = 0; i < tokens.length && queries.length < 4; i += 3) {
      const chunk = tokens.slice(i, i + 3).join(' ')
      if (chunk) queries.push(chunk)
    }
  }

  const matchedHits =
    queries.length > 0
      ? searchWikiRrf(db, { queries, limit: MAX_MATCHED_FULL_PAGES, now: nowMs })
      : []

  const fullBlocks: string[] = []
  for (const hit of matchedHits) {
    const detail = getWikiPage(db, hit.kind, hit.slug)
    if (!detail) continue
    const clippedBody =
      detail.body.length <= MAX_MATCHED_BODY_CHARS
        ? detail.body
        : `${detail.body.slice(0, MAX_MATCHED_BODY_CHARS)}\n…(truncated)`
    fullBlocks.push(`### ${detail.id} ("${detail.title}")\n${clippedBody}`)
  }

  return [
    `Existing Wiki Page Index (reuse exact kind/slug when updating an existing entity):\n${indexLines.join('\n')}`,
    fullBlocks.length > 0
      ? `Matched Existing Page Bodies (preserve existing #msg:<id> citations and [f*]/[o*]/[d*] IDs unless superseded):\n\n${fullBlocks.join('\n\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const AUTO_SYNC_SYSTEM_PROMPT = `You maintain a team's shared entity Wiki from recent conversation slices.
Extract ONLY durable cross-conversation factual knowledge about contacts ("contact"), clients ("client"), projects ("project"), or recurring topics ("topic").

Return ONLY a raw JSON object with this exact shape:
{
  "operations": [
    {
      "kind": "contact | client | project | topic",
      "slug": "optional-existing-slug",
      "title": "Entity Title (required when creating a new page)",
      "summary": "Optional concise 1-line summary (<= 300 chars)",
      "tags": ["optional", "short-tags"],
      "overview": {
        "mode": "keep"
      },
      "keyFacts": {
        "add": [{ "text": "Durable fact with citation ([#msg:123])" }],
        "update": [{ "id": "f1", "text": "Updated fact ([#msg:123])" }],
        "remove": [{ "id": "f2", "reason": "Why obsolete ([#msg:123])" }]
      },
      "openItems": {
        "add": [{ "text": "Open follow-up item ([#msg:123])" }]
      },
      "decisions": {
        "add": [{ "text": "Agreed decision ([#msg:123])" }]
      },
      "note": "Short summary of extracted update"
    }
  ]
}

Strict rules:
1. If there are NO durable entity facts worth keeping across conversations (e.g. casual chat, greetings, transient debugging), return {"operations": []}.
2. Cite the supporting message IDs as [#msg:<id>] in added/updated items and overview rewrites.
3. Never extract behavioral standing rules/preferences, passwords, API keys, tokens, or secrets.
4. When updating an existing page shown in the index, pass its exact "kind" and "slug". Use overview.mode = "keep" unless the overview genuinely needs a rewrite (which requires "content", "reason", and retaining prior #msg:<id> citations or listing them in "droppedCitations").
5. Match the language of the conversation. Output valid JSON only, with no markdown prose.`

function resolveEffectiveSignal(
  depsSignal?: AbortSignal,
  optsSignal?: AbortSignal,
): AbortSignal | undefined {
  if (depsSignal && optsSignal) {
    return AbortSignal.any([depsSignal, optsSignal])
  }
  return optsSignal ?? depsSignal
}

async function runSingleSyncPass(
  deps: WikiAutoSyncDeps,
  force: boolean,
  signal?: AbortSignal,
): Promise<WikiSyncResult> {
  const { db } = deps
  const shouldStop = () => !db.open || Boolean(deps.isStopping?.()) || Boolean(signal?.aborted)

  if (shouldStop()) {
    return { ok: true, threadsSynced: 0, pagesCreated: 0, pagesUpdated: 0 }
  }

  const bots = db.prepare('SELECT id, name FROM bots').all() as Array<Pick<BotRow, 'id' | 'name'>>
  const botNames: Record<string, string> = Object.fromEntries(bots.map((b) => [b.id, b.name]))

  const candidates = db
    .prepare(
      `SELECT m.thread_id AS thread_id,
              t.bot_id AS thread_bot_id
       FROM messages m
       LEFT JOIN wiki_sync_state s ON s.thread_id = m.thread_id
       LEFT JOIN threads t ON t.id = m.thread_id
       WHERE m.kind IN ('text', 'report')
         AND m.id > COALESCE(s.last_synced_message_id, 0)
       GROUP BY m.thread_id
       ORDER BY MIN(m.id) ASC, m.thread_id ASC`,
    )
    .all() as Array<{ thread_id: string; thread_bot_id: string | null }>

  let threadsSynced = 0
  let pagesCreated = 0
  let pagesUpdated = 0
  let firstLlmError: unknown = null

  try {
    for (const candidate of candidates) {
      if (shouldStop()) break

      const threadId = candidate.thread_id
      if (deps.isThreadBusy?.(threadId)) continue

      const checkNowMs = deps.now ? deps.now() : Date.now()
      if (!force) {
        const latestCreatedAt = Number(
          db
            .prepare('SELECT MAX(created_at) FROM messages WHERE thread_id = ?')
            .pluck()
            .get(threadId) ?? 0,
        )
        if (latestCreatedAt > 0 && checkNowMs - latestCreatedAt < WIKI_IDLE_QUIET_MS) {
          continue
        }
      }

      const maxBatches = force ? MAX_FORCE_BATCHES_PER_THREAD : 1
      let threadSyncedInPass = false

      for (let batchIdx = 0; batchIdx < maxBatches; batchIdx++) {
        if (shouldStop()) break
        if (deps.isThreadBusy?.(threadId)) break

        const nowMs = deps.now ? deps.now() : Date.now()
        const syncStateRow = db
          .prepare(
            `SELECT last_synced_message_id, pending_taint, updated_at
             FROM wiki_sync_state
             WHERE thread_id = ?`,
          )
          .get(threadId) as
          | { last_synced_message_id: number; pending_taint: number; updated_at: number }
          | undefined

        const afterId = syncStateRow?.last_synced_message_id ?? 0
        const pendingTaint = syncStateRow?.pending_taint === 1
        const prevSyncedAt = syncStateRow?.updated_at ?? 0

        const batchRows = db
          .prepare(
            `SELECT id, thread_id, sender, kind, content, payload, created_at
             FROM messages
             WHERE thread_id = ?
               AND id > ?
               AND kind IN ('text', 'report')
             ORDER BY id ASC
             LIMIT ?`,
          )
          .all(threadId, afterId, MAX_SYNC_MESSAGES_PER_THREAD) as RawSyncMessageRow[]

        if (batchRows.length === 0) break

        const formattedLines: string[] = []
        let transcriptLen = 0
        let hasSubstantive = false
        let lastIncludedId = batchRows[0]!.id
        let stoppedEarlyForBudget = false

        for (const row of batchRows) {
          const formatted = formatMessageLine(row, botNames)
          if (!formatted) {
            lastIncludedId = row.id
            continue
          }
          if (
            formattedLines.length > 0 &&
            transcriptLen + formatted.line.length + 1 > MAX_TOTAL_TRANSCRIPT_CHARS
          ) {
            stoppedEarlyForBudget = true
            break
          }
          if (formatted.substantiveLen >= MIN_SUBSTANTIVE_CHARS) {
            hasSubstantive = true
          }
          formattedLines.push(formatted.line)
          transcriptLen += formatted.line.length + 1
          lastIncludedId = row.id
        }

        const batchMaxId = lastIncludedId

        if (!hasSubstantive || formattedLines.length === 0) {
          advanceSyncCursor(db, threadId, batchMaxId, nowMs)
          if (!stoppedEarlyForBudget && batchRows.length < MAX_SYNC_MESSAGES_PER_THREAD) {
            break
          }
          continue
        }

        const transcript = formattedLines.join('\n')
        const wikiContext = buildExistingWikiContext(db, transcript, nowMs)
        const batchTainted =
          pendingTaint || detectBatchTainted(db, threadId, afterId, batchMaxId, prevSyncedAt)
        const threadLlm = deps.llmForThread
          ? deps.llmForThread(threadId, candidate.thread_bot_id)
          : deps.llm

        let replyContent: string | null = null
        try {
          const turn = await threadLlm.chat(
            [
              { role: 'system', content: AUTO_SYNC_SYSTEM_PROMPT },
              {
                role: 'user',
                content: `${wikiContext}\n\n=== THREAD TRANSCRIPT (${threadId}) ===\n${transcript}`,
              },
            ],
            [],
            {
              priority: 'low',
              ...(signal ? { signal } : {}),
            },
          )
          replyContent = turn.content
        } catch (err) {
          if (shouldStop()) break
          firstLlmError ??= err
          break
        }

        if (shouldStop()) break

        const commitAt = deps.now ? deps.now() : Date.now()
        const parsed = replyContent ? parseJsonLoose(replyContent) : null

        if (parsed && Array.isArray(parsed.operations)) {
          for (const rawOp of parsed.operations.slice(0, MAX_OPERATIONS_PER_BATCH)) {
            if (!isRecord(rawOp)) continue
            try {
              const slug =
                typeof rawOp.slug === 'string' && rawOp.slug.trim() !== ''
                  ? rawOp.slug.trim()
                  : undefined
              const title =
                typeof rawOp.title === 'string' ? scrubWikiSecrets(rawOp.title).trim() : undefined
              const summary =
                typeof rawOp.summary === 'string'
                  ? scrubWikiSecrets(rawOp.summary).trim()
                  : undefined
              const tags = Array.isArray(rawOp.tags)
                ? rawOp.tags
                    .filter((t): t is string => typeof t === 'string')
                    .map((t) => scrubWikiSecrets(t))
                : undefined
              const note =
                typeof rawOp.note === 'string' ? scrubWikiSecrets(rawOp.note).trim() : undefined

              const { created } = patchWikiPage(
                db,
                {
                  kind: rawOp.kind as WikiKind,
                  ...(slug !== undefined ? { slug } : {}),
                  ...(title !== undefined ? { title } : {}),
                  ...(summary !== undefined ? { summary } : {}),
                  ...(tags !== undefined ? { tags } : {}),
                  ...(rawOp.overview !== undefined
                    ? { overview: rawOp.overview as WikiOverviewPatch }
                    : {}),
                  ...(rawOp.keyFacts !== undefined
                    ? { keyFacts: rawOp.keyFacts as WikiListSectionPatch }
                    : {}),
                  ...(rawOp.openItems !== undefined
                    ? { openItems: rawOp.openItems as WikiListSectionPatch }
                    : {}),
                  ...(rawOp.decisions !== undefined
                    ? { decisions: rawOp.decisions as WikiListSectionPatch }
                    : {}),
                  ...(note !== undefined ? { note } : {}),
                  editedBy: 'auto-sync',
                  sourceTainted: batchTainted,
                },
                {
                  dataDir: deps.dataDir,
                  now: commitAt,
                },
              )
              if (created) pagesCreated += 1
              else pagesUpdated += 1
            } catch (err) {
              if (err instanceof WikiValidationError || err instanceof WikiConflictError) {
                continue
              }
              throw err
            }
          }
        }

        advanceSyncCursor(db, threadId, batchMaxId, commitAt)
        threadSyncedInPass = true

        if (!stoppedEarlyForBudget && batchRows.length < MAX_SYNC_MESSAGES_PER_THREAD) {
          break
        }
      }

      if (threadSyncedInPass) {
        threadsSynced += 1
      }
    }
  } finally {
    if (pagesCreated + pagesUpdated > 0) {
      deps.hub?.broadcast({ type: 'wiki_changed' })
    }
  }

  if (firstLlmError !== null) {
    throw firstLlmError
  }

  return {
    ok: true,
    threadsSynced,
    pagesCreated,
    pagesUpdated,
  }
}

function startActivePass(
  state: SyncMutexState,
  deps: WikiAutoSyncDeps,
  force: boolean,
  signal?: AbortSignal,
): Promise<WikiSyncResult> {
  state.activeIsForce = force
  const promise = runSingleSyncPass(deps, force, signal).finally(() => {
    const queued = state.queuedForce
    if (queued) {
      state.queuedForce = null
      const followUp = startActivePass(state, queued.deps, true, queued.signal)
      followUp.then(queued.resolve, queued.reject)
    } else {
      state.active = null
      state.activeIsForce = false
    }
  })
  state.active = promise
  return promise
}

export function syncWikiFromChats(
  deps: WikiAutoSyncDeps,
  opts?: { force?: boolean; signal?: AbortSignal },
): Promise<WikiSyncResult> {
  const force = opts?.force === true
  const effectiveSignal = resolveEffectiveSignal(deps.signal, opts?.signal)
  const state = getMutexState(deps.db)

  if (!state.active) {
    return startActivePass(state, deps, force, effectiveSignal)
  }

  if (!force) {
    return state.active
  }

  if (state.queuedForce) {
    state.queuedForce.deps = deps
    state.queuedForce.signal = effectiveSignal
    return state.queuedForce.promise
  }

  let resolve!: (res: WikiSyncResult) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<WikiSyncResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  state.queuedForce = { deps, signal: effectiveSignal, promise, resolve, reject }
  return promise
}
