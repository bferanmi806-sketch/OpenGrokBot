import { recordAction } from '../actions.js'
import type { ApprovalKind, ApprovalRow } from '../approvals.js'
import { getMessage, insertMessage, updateMessagePayload, type Db, type MessageRow } from '../db.js'
import type { Hub } from '../hub.js'
import { appendMemoryRule, listMemoryRules } from '../memory.js'

export const MAX_RULE_CHARS = 300
export const MAX_REASON_CHARS = 300
export const DISCARD_LOOKBACK_MS = 14 * 24 * 60 * 60_000
export const DISCARD_THRESHOLD = 2

export type RuleProposalSource = 'agent' | 'discard_pattern' | 'dreaming'
export type RuleProposalStatus = 'pending' | 'accepted' | 'dismissed'

export function normalizeRuleProposalSource(raw: unknown): RuleProposalSource {
  if (raw === 'discard_pattern' || raw === 'dreaming') return raw
  return 'agent'
}

export type RuleProposalRow = {
  id: number
  bot_id: string
  thread_id: string
  rule: string
  reason: string
  source: RuleProposalSource
  dedupe_key: string
  source_tainted: number
  status: RuleProposalStatus
  message_id: number | null
  created_at: number
  resolved_at: number | null
}

export type RuleProposalView = {
  id: number
  botId: string
  threadId: string
  rule: string
  reason: string
  source: RuleProposalSource
  sourceTainted: boolean
  status: RuleProposalStatus
  messageId: number | null
  createdAt: number
  resolvedAt: number | null
}

export type RuleProposalPayload = {
  proposalId: number
  rule: string
  reason: string
  source: RuleProposalSource
  sourceTainted: boolean
  status: RuleProposalStatus
  edited?: boolean
  resolvedAt?: number
}

export type CreateRuleProposalInput = {
  botId: string
  threadId: string
  rule: string
  reason: string
  source: RuleProposalSource
  dedupeKey?: string
  sourceTainted?: boolean
  dataDir?: string
  existingMemoryRules?: string[]
  hub?: Hub
  now?: number
}

export type CreateRuleProposalResult =
  | { created: true; proposal: RuleProposalView; message: MessageRow }
  | { created: false; reason: 'invalid_rule' | 'already_in_memory' | 'already_pending' | 'previously_dismissed' }

export type ResolveRuleProposalInput = {
  id: number
  decision: 'accept' | 'dismiss'
  rule?: string
  dataDir?: string
  hub?: Hub
  now?: number
}

export type ResolveRuleProposalResult =
  | { ok: true; proposal: RuleProposalView; memoryUpdated: boolean }
  | { ok: false; code: 'gone' | 'settled' | 'invalid_rule' | 'memory_unavailable' | 'invalid_decision' }

/**
 * Sanitize a single-line standing rule safe to append to MEMORY.md as `- <rule>`.
 * Collapses CR/LF and whitespace to single spaces, strips leading `- ` bullet prefixes repeatedly,
 * trims, and returns null when empty or exceeding MAX_RULE_CHARS.
 */
export function sanitizeRuleLine(raw: string): string | null {
  if (typeof raw !== 'string') return null
  let clean = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  while (/^-\s*/.test(clean)) {
    clean = clean.replace(/^-+\s*/, '').trim()
  }
  if (!clean || clean.length > MAX_RULE_CHARS) return null
  return clean
}

export function sanitizeReason(raw: string): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON_CHARS)
}

/** Matches memory.ts normalization: collapse whitespace, strip trailing punctuation, lowercase. */
export function comparableRule(text: string): string {
  return text.trim().replace(/\s+/g, ' ').replace(/[.。!！]+$/, '').toLowerCase()
}

export function formatProposalView(row: RuleProposalRow): RuleProposalView {
  return {
    id: row.id,
    botId: row.bot_id,
    threadId: row.thread_id,
    rule: row.rule,
    reason: row.reason,
    source: normalizeRuleProposalSource(row.source),
    sourceTainted: row.source_tainted === 1,
    status: row.status === 'accepted' || row.status === 'dismissed' ? row.status : 'pending',
    messageId: row.message_id ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  }
}

function getProposalRow(db: Db, id: number): RuleProposalRow | null {
  if (!Number.isInteger(id) || id <= 0) return null
  return (db.prepare('SELECT * FROM rule_proposals WHERE id = ?').get(id) as RuleProposalRow | undefined) ?? null
}

export function getRuleProposal(db: Db, id: number): RuleProposalView | null {
  const row = getProposalRow(db, id)
  return row ? formatProposalView(row) : null
}

export function listRuleProposals(
  db: Db,
  opts: { botId?: string; status?: RuleProposalStatus; limit?: number } = {},
): RuleProposalView[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.botId) {
    clauses.push('bot_id = ?')
    params.push(opts.botId)
  }
  if (opts.status) {
    clauses.push('status = ?')
    params.push(opts.status)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rawLimit = opts.limit !== undefined && Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 100
  const limit = Math.max(1, Math.min(rawLimit, 500))
  params.push(limit)
  const rows = db.prepare(
    `SELECT * FROM rule_proposals ${where} ORDER BY id DESC LIMIT ?`,
  ).all(...params) as RuleProposalRow[]
  return rows.map(formatProposalView)
}

export async function createRuleProposal(
  db: Db,
  input: CreateRuleProposalInput,
): Promise<CreateRuleProposalResult> {
  const cleanRule = sanitizeRuleLine(input.rule)
  if (!cleanRule) return { created: false, reason: 'invalid_rule' }
  const cleanReason = sanitizeReason(input.reason)
  const normalizedRule = comparableRule(cleanRule)
  const dedupeKey = input.dedupeKey?.trim() || `rule:${normalizedRule}`

  const existingMemoryRules = input.existingMemoryRules
    ?? (input.dataDir ? await listMemoryRules(input.dataDir, input.botId) : [])
  const memorySet = new Set(existingMemoryRules.map(comparableRule))
  if (memorySet.has(normalizedRule)) {
    return { created: false, reason: 'already_in_memory' }
  }

  const at = input.now ?? Date.now()
  const sourceTainted = Boolean(input.sourceTainted)

  const outcome = db.transaction((): CreateRuleProposalResult => {
    const byKey = db.prepare(
      `SELECT status, rule FROM rule_proposals
       WHERE bot_id = ? AND dedupe_key = ? AND status IN ('pending', 'dismissed', 'accepted')
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END, id DESC`,
    ).all(input.botId, dedupeKey) as Array<{ status: RuleProposalStatus; rule: string }>

    if (byKey.some((r) => r.status === 'pending')) {
      return { created: false, reason: 'already_pending' }
    }
    if (byKey.some((r) => r.status === 'dismissed')) {
      return { created: false, reason: 'previously_dismissed' }
    }
    if (byKey.some((r) => r.status === 'accepted' && memorySet.has(comparableRule(r.rule)))) {
      return { created: false, reason: 'already_in_memory' }
    }

    // Also dedupe across differing dedupe keys (e.g. discard_pattern vs agent proposal) by normalized rule text.
    const byBot = db.prepare(
      `SELECT rule, status FROM rule_proposals
       WHERE bot_id = ? AND status IN ('pending', 'dismissed')
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC`,
    ).all(input.botId) as Array<{ rule: string; status: RuleProposalStatus }>

    let matchedDismissed = false
    for (const row of byBot) {
      if (comparableRule(row.rule) !== normalizedRule) continue
      if (row.status === 'pending') return { created: false, reason: 'already_pending' }
      if (row.status === 'dismissed') matchedDismissed = true
    }
    if (matchedDismissed) return { created: false, reason: 'previously_dismissed' }

    const source = normalizeRuleProposalSource(input.source)
    const info = db.prepare(
      `INSERT INTO rule_proposals
         (bot_id, thread_id, rule, reason, source, dedupe_key, source_tainted, status, message_id, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
    ).run(
      input.botId,
      input.threadId,
      cleanRule,
      cleanReason,
      source,
      dedupeKey,
      sourceTainted ? 1 : 0,
      at,
    )
    const proposalId = Number(info.lastInsertRowid)
    const payload: RuleProposalPayload = {
      proposalId,
      rule: cleanRule,
      reason: cleanReason,
      source,
      sourceTainted,
      status: 'pending',
    }
    const message = insertMessage(db, {
      threadId: input.threadId,
      sender: input.botId,
      kind: 'rule_proposal',
      payload,
    })
    db.prepare('UPDATE rule_proposals SET message_id = ? WHERE id = ?').run(message.id, proposalId)
    const row = getProposalRow(db, proposalId)!
    return { created: true, proposal: formatProposalView(row), message }
  })()

  if (outcome.created) {
    input.hub?.broadcast({ type: 'message', threadId: outcome.message.thread_id, message: outcome.message })
  }
  return outcome
}

function clampDisplay(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

function buildTargetDiscardRule(kind: ApprovalKind, target: string, action: string): string {
  const displayTarget = clampDisplay(target)
  switch (kind) {
    case 'email':
      return `Do not send emails to ${displayTarget} unless explicitly asked`
    case 'message':
      return `Do not send messages to ${displayTarget} unless explicitly asked`
    case 'post':
      return `Do not post to ${displayTarget} unless explicitly asked`
    case 'purchase':
      return `Do not make purchases at ${displayTarget} unless explicitly asked`
    case 'booking':
      return `Do not make bookings with ${displayTarget} unless explicitly asked`
    case 'other': {
      const otherTarget = clampDisplay(target, 160)
      const displayAction = clampDisplay(action, 80)
      return displayAction
        ? `Do not "${displayAction}" for ${otherTarget} unless explicitly asked`
        : `Do not act on ${otherTarget} unless explicitly asked`
    }
  }
}

export async function maybeProposeRuleFromDiscard(
  db: Db,
  input: {
    approval: Pick<ApprovalRow, 'bot_id' | 'thread_id' | 'kind' | 'target' | 'action' | 'workflow_run_id'>
    dataDir?: string
    hub?: Hub
    now?: number
  },
): Promise<CreateRuleProposalResult | null> {
  if (!input.dataDir) return null
  const { approval } = input
  if (approval.workflow_run_id) return null

  const at = input.now ?? Date.now()
  const cutoff = at - DISCARD_LOOKBACK_MS
  const trimmedTarget = approval.target.trim()

  if (trimmedTarget) {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM approvals
       WHERE bot_id = ? AND status = 'discarded' AND kind = ? AND target = ? AND resolved_at >= ?
         AND workflow_run_id IS NULL`,
    ).get(approval.bot_id, approval.kind, approval.target, cutoff) as { n: number }
    if (row.n < DISCARD_THRESHOLD) return null

    const rule = buildTargetDiscardRule(approval.kind, trimmedTarget, approval.action)
    const reason = `You discarded ${row.n} similar ${approval.kind} requests for ${clampDisplay(trimmedTarget, 120)} in the past 14 days.`
    const dedupeKey = `discard:${approval.kind}:${approval.target}`
    return createRuleProposal(db, {
      botId: approval.bot_id,
      threadId: approval.thread_id,
      rule,
      reason,
      source: 'discard_pattern',
      dedupeKey,
      sourceTainted: false,
      dataDir: input.dataDir,
      hub: input.hub,
      now: at,
    })
  }

  const normalizedAction = approval.action.trim().toLowerCase()
  if (!normalizedAction) return null
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM approvals
     WHERE bot_id = ? AND status = 'discarded' AND kind = ? AND target = '' AND lower(trim(action)) = ? AND resolved_at >= ?
       AND workflow_run_id IS NULL`,
  ).get(approval.bot_id, approval.kind, normalizedAction, cutoff) as { n: number }
  if (row.n < DISCARD_THRESHOLD) return null

  const displayAction = clampDisplay(approval.action, 180)
  const rule = `Do not "${displayAction}" unless explicitly asked`
  const reason = `You discarded ${row.n} similar "${clampDisplay(approval.action, 120)}" requests in the past 14 days.`
  const dedupeKey = `discard:${approval.kind}:action:${normalizedAction}`
  return createRuleProposal(db, {
    botId: approval.bot_id,
    threadId: approval.thread_id,
    rule,
    reason,
    source: 'discard_pattern',
    dedupeKey,
    sourceTainted: false,
    dataDir: input.dataDir,
    hub: input.hub,
    now: at,
  })
}

function patchProposalMessage(
  db: Db,
  existing: RuleProposalRow,
  patch: { status: RuleProposalStatus; rule?: string; edited?: boolean; resolvedAt: number },
): MessageRow | null {
  if (existing.message_id === null) return null
  const msg = getMessage(db, existing.message_id)
  if (!msg || msg.kind !== 'rule_proposal') return null
  const prev = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) as Partial<RuleProposalPayload>
  const nextPayload: RuleProposalPayload = {
    proposalId: existing.id,
    rule: patch.rule ?? prev.rule ?? existing.rule,
    reason: prev.reason ?? existing.reason,
    source: normalizeRuleProposalSource(prev.source ?? existing.source),
    sourceTainted: prev.sourceTainted ?? (existing.source_tainted === 1),
    status: patch.status,
    ...(patch.edited !== undefined ? { edited: patch.edited } : {}),
    resolvedAt: patch.resolvedAt,
  }
  updateMessagePayload(db, msg.id, nextPayload)
  return getMessage(db, msg.id)
}

export async function resolveRuleProposal(
  db: Db,
  input: ResolveRuleProposalInput,
): Promise<ResolveRuleProposalResult> {
  if (input.decision !== 'accept' && input.decision !== 'dismiss') {
    return { ok: false, code: 'invalid_decision' }
  }
  const existing = getProposalRow(db, input.id)
  if (!existing) return { ok: false, code: 'gone' }
  if (existing.status !== 'pending') return { ok: false, code: 'settled' }

  const at = input.now ?? Date.now()

  if (input.decision === 'accept') {
    if (!input.dataDir) return { ok: false, code: 'memory_unavailable' }
    const finalRule = input.rule !== undefined ? sanitizeRuleLine(input.rule) : sanitizeRuleLine(existing.rule)
    if (!finalRule) return { ok: false, code: 'invalid_rule' }

    const claimed = db.prepare(
      `UPDATE rule_proposals SET status = 'accepted', rule = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(finalRule, at, existing.id)
    if (claimed.changes === 0) return { ok: false, code: 'settled' }

    let saved: { rule: string; diff: string; total: number }
    try {
      saved = await appendMemoryRule(input.dataDir, existing.bot_id, finalRule)
    } catch (err) {
      db.prepare(
        `UPDATE rule_proposals SET status = 'pending', rule = ?, resolved_at = NULL
         WHERE id = ? AND status = 'accepted' AND resolved_at = ?`,
      ).run(existing.rule, existing.id, at)
      throw err
    }

    const edited = finalRule !== existing.rule
    const { updated, toBroadcast } = db.transaction(() => {
      const messages: MessageRow[] = []
      const patched = patchProposalMessage(db, existing, { status: 'accepted', rule: finalRule, edited, resolvedAt: at })
      if (patched) messages.push(patched)

      if (saved.diff) {
        const memMsg = insertMessage(db, {
          threadId: existing.thread_id,
          sender: existing.bot_id,
          kind: 'memory_updated',
          payload: { rule: saved.rule, diff: saved.diff, total: saved.total, by: 'operator' },
        })
        messages.push(memMsg)
      }

      recordAction(db, {
        botId: existing.bot_id,
        threadId: existing.thread_id,
        trigger: 'you',
        tool: 'rule_proposal',
        summary: `accepted rule proposal: ${finalRule}`,
        at,
      })

      return { updated: getProposalRow(db, existing.id)!, toBroadcast: messages }
    })()

    for (const msg of toBroadcast) {
      input.hub?.broadcast({ type: 'message', threadId: msg.thread_id, message: msg })
    }
    return { ok: true, proposal: formatProposalView(updated), memoryUpdated: Boolean(saved.diff) }
  }

  const outcome = db.transaction(() => {
    const claimed = db.prepare(
      `UPDATE rule_proposals SET status = 'dismissed', resolved_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(at, existing.id)
    if (claimed.changes === 0) return null

    const patched = patchProposalMessage(db, existing, { status: 'dismissed', resolvedAt: at })

    recordAction(db, {
      botId: existing.bot_id,
      threadId: existing.thread_id,
      trigger: 'you',
      tool: 'rule_proposal',
      summary: `dismissed rule proposal: ${existing.rule}`,
      at,
    })

    return { updated: getProposalRow(db, existing.id)!, patched }
  })()

  if (!outcome) return { ok: false, code: 'settled' }
  if (outcome.patched) {
    input.hub?.broadcast({ type: 'message', threadId: outcome.patched.thread_id, message: outcome.patched })
  }
  return { ok: true, proposal: formatProposalView(outcome.updated), memoryUpdated: false }
}
