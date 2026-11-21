import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { listActions, recordAction } from '../src/actions.js'
import { createApproval, resolveApproval } from '../src/approvals.js'
import { loadConfig } from '../src/config.js'
import {
  ensureDmThread,
  ensureGroupThread,
  getMessage,
  insertMessage,
  listMessages,
  openDb,
  pendingCount,
  SCHEMA_VERSION,
  schemaVersion,
  upsertBot,
  waitsOnOperator,
} from '../src/db.js'
import { createHub, type GatewayEvent } from '../src/hub.js'
import { appendMemoryRule, listMemoryRules, removeMemoryRule } from '../src/memory.js'
import {
  enqueueQuietDigestItem,
  flushQuietDigests,
  getQuietDigestSummary,
  isInQuietHours,
  listPendingDigestItems,
  localMinutesOfDay,
  parseHhMm,
  type QuietDigestPayload,
} from '../src/proactive/quiet-hours.js'
import {
  comparableRule,
  createRuleProposal,
  DISCARD_LOOKBACK_MS,
  getRuleProposal,
  listRuleProposals,
  MAX_REASON_CHARS,
  MAX_RULE_CHARS,
  maybeProposeRuleFromDiscard,
  resolveRuleProposal,
  sanitizeReason,
  sanitizeRuleLine,
  type RuleProposalPayload,
} from '../src/proactive/rule-proposals.js'
import { normalizeMode } from '../src/routines.js'
import { SETTING_DEFAULTS, readSavedSettings, resolveSettings, saveSettings, type Settings } from '../src/settings.js'
import { mountSettings } from '../src/settings-api.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'osb-proactive-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function setupHub() {
  const hub = createHub()
  const events: GatewayEvent[] = []
  hub.add({ send: (d) => events.push(JSON.parse(d) as GatewayEvent) })
  return { hub, events }
}

function seedBot(db: ReturnType<typeof openDb>, id: string, name = id) {
  upsertBot(db, { id, name, role: 'assistant', emoji: '🤖', soul_path: '' })
  return ensureDmThread(db, id)
}

describe('schema v15, hub event, routines mode, action trigger & quiet hours settings', () => {
  it('migrates fresh DB to v15 with tables, indexes, hub event, prepare mode & trigger', () => {
    const db = openDb(':memory:')
    expect(SCHEMA_VERSION).toBe(15)
    expect(schemaVersion(db)).toBe(15)

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(tables).toEqual(expect.arrayContaining(['quiet_digest_items', 'rule_proposals']))

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_quiet_digest_pending',
      'idx_rule_proposals_bot_status',
      'idx_rule_proposals_dedupe',
      'idx_approvals_discard_lookup',
    ]))

    const { hub, events } = setupHub()
    hub.broadcast({ type: 'quiet_digest_changed' })
    expect(events).toEqual([{ type: 'quiet_digest_changed' }])

    expect(normalizeMode('act')).toBe('act')
    expect(normalizeMode('watch')).toBe('watch')
    expect(normalizeMode('prepare')).toBe('prepare')
    expect(normalizeMode('unknown')).toBe('act')
    expect(normalizeMode(undefined)).toBe('act')

    const threadId = seedBot(db, 'scout', 'Scout')
    recordAction(db, {
      botId: 'scout',
      threadId,
      trigger: 'prepare',
      tool: 'wiki_upsert',
      summary: 'prepared morning dossier',
      ok: true,
      at: 1000,
    })
    expect(listActions(db, 'scout')[0]).toMatchObject({ trigger: 'prepare', tool: 'wiki_upsert', ok: true })

    db.close()
  })

  it('upgrades an existing v14 database file seamlessly to v15', () => {
    const dir = makeTempDir('osb-v14-upgrade-')
    const dbPath = join(dir, 'opensuperbot.db')

    // Create a DB, then simulate a v14 DB by dropping v15 objects and setting user_version = 14
    const initial = openDb(dbPath)
    const threadId = seedBot(initial, 'chief', 'Chief')
    insertMessage(initial, { threadId, sender: 'user', kind: 'text', content: 'pre-upgrade message' })
    initial.exec(`
      DROP INDEX IF EXISTS idx_quiet_digest_pending;
      DROP TABLE IF EXISTS quiet_digest_items;
      DROP INDEX IF EXISTS idx_rule_proposals_bot_status;
      DROP INDEX IF EXISTS idx_rule_proposals_dedupe;
      DROP TABLE IF EXISTS rule_proposals;
      DROP INDEX IF EXISTS idx_approvals_discard_lookup;
    `)
    initial.pragma('user_version = 14')
    initial.close()

    const migrated: Array<[number, number]> = []
    const upgraded = openDb(dbPath, { onMigrate: (from, to) => migrated.push([from, to]) })
    expect(migrated).toEqual([[14, 15]])
    expect(schemaVersion(upgraded)).toBe(15)

    // Pre-existing data preserved and new tables usable
    expect(listMessages(upgraded, threadId).map((m) => m.content)).toEqual(['pre-upgrade message'])
    const item = enqueueQuietDigestItem(upgraded, {
      botId: 'chief',
      threadId,
      routineName: 'Overnight check',
      routineMode: 'prepare',
      kind: 'text',
      summary: 'All ready',
    })
    expect(item.id).toBeGreaterThan(0)
    upgraded.close()
  })

  it('validates Quiet Hours settings and triggers onSettingsSaved callback with before/after values', async () => {
    const db = openDb(':memory:')
    expect(SETTING_DEFAULTS).toMatchObject({
      quietHoursEnabled: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
    })
    expect(resolveSettings({}, {}).values).toMatchObject({
      quietHoursEnabled: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
    })

    expect(saveSettings(db, {
      quietHoursEnabled: true,
      quietHoursStart: ' 23:15 ',
      quietHoursEnd: '07:45',
    })).toEqual({ ok: true })
    expect(readSavedSettings(db)).toEqual({
      quietHoursEnabled: true,
      quietHoursStart: '23:15',
      quietHoursEnd: '07:45',
    })

    for (const bad of ['24:00', '8:00', '22:60', '-01:00', '22:00:00', '', 'noon', 2200]) {
      expect(saveSettings(db, { quietHoursStart: bad }).ok).toBe(false)
      expect(saveSettings(db, { quietHoursEnd: bad }).ok).toBe(false)
    }
    expect(saveSettings(db, { quietHoursEnabled: 'true' }).ok).toBe(false)
    expect(saveSettings(db, { quietHoursEnabled: 1 }).ok).toBe(false)

    // Reset via null
    expect(saveSettings(db, { quietHoursEnabled: null, quietHoursStart: null, quietHoursEnd: null })).toEqual({ ok: true })
    expect(readSavedSettings(db)).toEqual({})

    // Verify onSettingsSaved receives before and after resolved settings
    const dataDir = makeTempDir('osb-settings-cb-')
    const app = new Hono()
    const calls: Array<{ before: Settings; after: Settings }> = []
    mountSettings(app, {
      db,
      env: {},
      startedWith: loadConfig({ OPENSUPERBOT_DATA: dataDir }),
      onSettingsSaved: async (before, after) => {
        await Promise.resolve()
        calls.push({ before, after })
      },
    })

    const res1 = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quietHoursEnabled: true, quietHoursStart: '21:30', quietHoursEnd: '06:30' }),
    })
    expect(res1.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.before).toMatchObject({ quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '08:00' })
    expect(calls[0]!.after).toMatchObject({ quietHoursEnabled: true, quietHoursStart: '21:30', quietHoursEnd: '06:30' })

    const res2 = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quietHoursEnabled: false }),
    })
    expect(res2.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.before.quietHoursEnabled).toBe(true)
    expect(calls[1]!.after.quietHoursEnabled).toBe(false)

    // Invalid payload must NOT call onSettingsSaved
    const badRes = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quietHoursStart: '25:00' }),
    })
    expect(badRes.status).toBe(400)
    expect(calls).toHaveLength(2)

    db.close()
  })
})

describe('quiet hours window evaluation', () => {
  it('parses strict HH:MM strings and rejects invalid values', () => {
    expect(parseHhMm('00:00')).toBe(0)
    expect(parseHhMm('08:00')).toBe(480)
    expect(parseHhMm(' 22:30 ')).toBe(1350)
    expect(parseHhMm('23:59')).toBe(1439)
    for (const bad of ['', '8:00', '24:00', '23:60', '-01:00', '08:00:00', 'ab:cd']) {
      expect(parseHhMm(bad)).toBeNull()
    }
  })

  it('evaluates overnight wrap [22:00, 08:00) including exact boundaries and midnight', () => {
    const cfg = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' }
    expect(isInQuietHours(new Date('2026-11-21T21:59:00Z'), cfg, 'UTC')).toBe(false)
    expect(isInQuietHours(new Date('2026-11-21T22:00:00Z'), cfg, 'UTC')).toBe(true)
    expect(isInQuietHours(new Date('2026-11-21T23:59:00Z'), cfg, 'UTC')).toBe(true)
    expect(localMinutesOfDay(new Date('2026-11-22T00:00:00Z'), 'UTC')).toBe(0)
    expect(isInQuietHours(new Date('2026-11-22T00:00:00Z'), cfg, 'UTC')).toBe(true)
    expect(isInQuietHours(new Date('2026-11-22T07:59:00Z'), cfg, 'UTC')).toBe(true)
    expect(isInQuietHours(new Date('2026-11-22T08:00:00Z'), cfg, 'UTC')).toBe(false)
    expect(isInQuietHours(new Date('2026-11-22T12:00:00Z'), cfg, 'UTC')).toBe(false)
  })

  it('evaluates daytime window [13:00, 15:00), equal start/end, disabled, and invalid configs', () => {
    const dayCfg = { quietHoursEnabled: true, quietHoursStart: '13:00', quietHoursEnd: '15:00' }
    expect(isInQuietHours(new Date('2026-11-21T12:59:00Z'), dayCfg, 'UTC')).toBe(false)
    expect(isInQuietHours(new Date('2026-11-21T13:00:00Z'), dayCfg, 'UTC')).toBe(true)
    expect(isInQuietHours(new Date('2026-11-21T14:59:00Z'), dayCfg, 'UTC')).toBe(true)
    expect(isInQuietHours(new Date('2026-11-21T15:00:00Z'), dayCfg, 'UTC')).toBe(false)

    // Equal start and end -> never quiet
    expect(isInQuietHours(new Date('2026-11-21T22:00:00Z'), {
      quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '22:00',
    }, 'UTC')).toBe(false)

    // Disabled -> always false
    expect(isInQuietHours(new Date('2026-11-21T23:00:00Z'), {
      quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '08:00',
    }, 'UTC')).toBe(false)

    // Invalid start/end -> false
    expect(isInQuietHours(new Date('2026-11-21T23:00:00Z'), {
      quietHoursEnabled: true, quietHoursStart: 'bad', quietHoursEnd: '08:00',
    }, 'UTC')).toBe(false)
  })

  it('respects explicit IANA timezones including DST shifts and falls back gracefully on invalid timezone', () => {
    const cfg = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' }

    // 2026-11-21T14:30:00Z -> 22:30 Asia/Shanghai (quiet), 06:30 America/Los_Angeles PST (quiet), 14:30 UTC (not quiet)
    const winterInstant = new Date('2026-11-21T14:30:00Z')
    expect(isInQuietHours(winterInstant, cfg, 'Asia/Shanghai')).toBe(true)
    expect(isInQuietHours(winterInstant, cfg, 'America/Los_Angeles')).toBe(true)
    expect(isInQuietHours(winterInstant, cfg, 'UTC')).toBe(false)

    // 2026-11-21T15:30:00Z -> 23:30 Asia/Shanghai (quiet), 07:30 PST (quiet)
    // 2026-07-15T15:30:00Z -> 23:30 Asia/Shanghai (quiet), 08:30 PDT (NOT quiet due to daylight saving UTC-7!)
    const summerInstant = new Date('2026-07-15T15:30:00Z')
    expect(isInQuietHours(summerInstant, cfg, 'Asia/Shanghai')).toBe(true)
    expect(isInQuietHours(summerInstant, cfg, 'America/Los_Angeles')).toBe(false)

    // Unrecognized timezone falls back to system local time without throwing
    expect(() => localMinutesOfDay(winterInstant, 'Mars/Olympus_Mons')).not.toThrow()
  })
})

describe('quiet digest store & flushing', () => {
  it('enqueues items, reports summary, groups per (bot_id, thread_id) on flush, and is idempotent', () => {
    const db = openDb(':memory:')
    const { hub, events } = setupHub()
    const tScout = seedBot(db, 'scout', 'Scout')
    const tOps = seedBot(db, 'ops', 'Ops')

    const r1 = enqueueQuietDigestItem(db, {
      botId: 'scout',
      threadId: tScout,
      routineId: 10,
      routineName: 'Competitor watch',
      routineMode: 'watch',
      kind: 'report',
      summary: '2 pricing updates',
      payload: { lines: [{ system: 'Pricing', result: 'Competitor A raised tier by 10%' }], closing: 'Ready for review.' },
      now: 1_000,
      hub,
    })
    const r2 = enqueueQuietDigestItem(db, {
      botId: 'scout',
      threadId: tScout,
      routineId: 11,
      routineName: 'Morning brief',
      routineMode: 'prepare',
      kind: 'text',
      summary: 'Drafted Acme dossier in wiki.',
      payload: { text: 'Drafted Acme dossier in wiki.' },
      now: 2_000,
      hub,
    })
    const r3 = enqueueQuietDigestItem(db, {
      botId: 'ops',
      threadId: tOps,
      routineId: 12,
      routineName: 'Server health',
      routineMode: 'watch',
      kind: 'text',
      summary: 'Disk usage hit 82%',
      payload: { text: 'Disk usage hit 82%' },
      now: 1_500,
      hub,
    })

    expect(r1.delivered_at).toBeNull()
    expect(listPendingDigestItems(db).map((r) => r.id)).toEqual([r1.id, r2.id, r3.id])
    expect(listPendingDigestItems(db, 'scout').map((r) => r.id)).toEqual([r1.id, r2.id])
    expect(events.filter((e) => e.type === 'quiet_digest_changed')).toHaveLength(3)

    const summary = getQuietDigestSummary(db, {
      now: new Date('2026-11-21T23:00:00Z'),
      cfg: { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' },
      timeZone: 'UTC',
    })
    expect(summary).toEqual({
      enabled: true,
      active: true,
      start: '22:00',
      end: '08:00',
      timeZone: 'UTC',
      pendingCount: 3,
      byBot: [
        { botId: 'scout', count: 2, latestAt: 2_000 },
        { botId: 'ops', count: 1, latestAt: 1_500 },
      ],
    })

    events.length = 0
    const flushed = flushQuietDigests(db, {
      hub,
      now: 5_000,
      windowStart: '22:00',
      windowEnd: '08:00',
    })
    expect(flushed.flushed).toBe(3)
    expect(flushed.threads).toEqual([tScout, tOps])
    expect(flushed.messages).toHaveLength(2)

    const scoutMsgs = listMessages(db, tScout)
    expect(scoutMsgs).toHaveLength(1)
    expect(scoutMsgs[0]!.kind).toBe('quiet_digest')
    const scoutPayload = scoutMsgs[0]!.payload as QuietDigestPayload
    expect(scoutPayload).toEqual({
      windowStart: '22:00',
      windowEnd: '08:00',
      itemCount: 2,
      items: [
        {
          id: r1.id,
          routineId: 10,
          routineName: 'Competitor watch',
          routineMode: 'watch',
          kind: 'report',
          summary: '2 pricing updates',
          report: { lines: [{ system: 'Pricing', result: 'Competitor A raised tier by 10%' }], closing: 'Ready for review.' },
          createdAt: 1_000,
        },
        {
          id: r2.id,
          routineId: 11,
          routineName: 'Morning brief',
          routineMode: 'prepare',
          kind: 'text',
          summary: 'Drafted Acme dossier in wiki.',
          text: 'Drafted Acme dossier in wiki.',
          createdAt: 2_000,
        },
      ],
    })

    const opsMsgs = listMessages(db, tOps)
    expect(opsMsgs).toHaveLength(1)
    expect((opsMsgs[0]!.payload as QuietDigestPayload).itemCount).toBe(1)

    // Broadcasted 2 messages + 1 quiet_digest_changed
    expect(events.filter((e) => e.type === 'message')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'quiet_digest_changed')).toHaveLength(1)

    // Actions logged per bot
    expect(listActions(db, 'scout')[0]).toMatchObject({ trigger: 'routine', tool: 'quiet_digest', ok: true, created_at: 5_000 })
    expect(listActions(db, 'ops')[0]).toMatchObject({ trigger: 'routine', tool: 'quiet_digest', ok: true, created_at: 5_000 })

    // Repeat flush is a clean no-op
    events.length = 0
    const repeat = flushQuietDigests(db, { hub, now: 6_000, windowStart: '22:00', windowEnd: '08:00' })
    expect(repeat).toEqual({ flushed: 0, threads: [], messages: [] })
    expect(events).toEqual([])
    expect(listPendingDigestItems(db)).toEqual([])

    db.close()
  })

  it('supports manual bot-scoped flush and tolerates corrupt payload_json gracefully', () => {
    const db = openDb(':memory:')
    const tScout = seedBot(db, 'scout')
    const tOps = seedBot(db, 'ops')

    // Insert corrupt JSON directly into quiet_digest_items for both report and text kinds
    db.prepare(
      `INSERT INTO quiet_digest_items
         (bot_id, thread_id, routine_id, routine_name, routine_mode, kind, summary, payload_json, created_at, delivered_at)
       VALUES (?, ?, NULL, 'Broken report', 'watch', 'report', 'Fallback report summary', '{corrupt', 100, NULL)`,
    ).run('scout', tScout)
    db.prepare(
      `INSERT INTO quiet_digest_items
         (bot_id, thread_id, routine_id, routine_name, routine_mode, kind, summary, payload_json, created_at, delivered_at)
       VALUES (?, ?, NULL, 'Broken text', 'prepare', 'text', 'Fallback text summary', '{corrupt', 200, NULL)`,
    ).run('scout', tScout)
    enqueueQuietDigestItem(db, {
      botId: 'ops',
      threadId: tOps,
      routineName: 'Ops ping',
      routineMode: 'watch',
      kind: 'text',
      summary: 'Still pending',
      now: 300,
    })

    const res = flushQuietDigests(db, {
      botId: 'scout',
      manual: true,
      now: 400,
      windowStart: '22:00',
      windowEnd: '08:00',
    })
    expect(res.flushed).toBe(2)
    expect(res.messages).toHaveLength(1)
    const payload = res.messages[0]!.payload as QuietDigestPayload
    expect(payload.flushedManually).toBe(true)
    expect(payload.items[0]).toMatchObject({ kind: 'report', summary: 'Fallback report summary' })
    expect(payload.items[0]!.report).toBeUndefined()
    expect(payload.items[1]).toMatchObject({ kind: 'text', summary: 'Fallback text summary', text: 'Fallback text summary' })

    // Ops item remains undelivered
    expect(listPendingDigestItems(db).map((r) => r.bot_id)).toEqual(['ops'])
    db.close()
  })

  it('groups one bot across two threads separately and falls back to summary on whitespace payload.text', () => {
    const db = openDb(':memory:')
    const { hub, events } = setupHub()
    const dmThread = seedBot(db, 'scout', 'Scout')
    const groupThread = ensureGroupThread(db, 'group:morning', 'Morning Crew', ['scout'])

    enqueueQuietDigestItem(db, {
      botId: 'scout',
      threadId: dmThread,
      routineName: 'DM watch',
      routineMode: 'watch',
      kind: 'text',
      summary: 'DM summary fallback',
      payload: { text: '   ' },
      now: 100,
    })
    enqueueQuietDigestItem(db, {
      botId: 'scout',
      threadId: groupThread,
      routineName: 'Group prepare',
      routineMode: 'prepare',
      kind: 'text',
      summary: 'Group summary fallback',
      payload: '',
      now: 200,
    })

    const res = flushQuietDigests(db, {
      hub,
      now: 300,
      windowStart: '22:00',
      windowEnd: '08:00',
    })
    expect(res.flushed).toBe(2)
    expect(res.threads).toEqual([dmThread, groupThread])
    expect(res.messages).toHaveLength(2)

    const dmPayload = listMessages(db, dmThread)[0]!.payload as QuietDigestPayload
    const groupPayload = listMessages(db, groupThread)[0]!.payload as QuietDigestPayload
    expect(dmPayload.items[0]!.text).toBe('DM summary fallback')
    expect(groupPayload.items[0]!.text).toBe('Group summary fallback')
    expect(events.filter((e) => e.type === 'message')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'quiet_digest_changed')).toHaveLength(1)

    db.close()
  })
})

describe('rule proposals engine', () => {
  it('sanitizes rules against newline bullet injection, control chars, and length limits', () => {
    expect(sanitizeRuleLine('- Never email Bob')).toBe('Never email Bob')
    expect(sanitizeRuleLine('  - - ---  Always ask first  ')).toBe('Always ask first')
    expect(sanitizeRuleLine('- Never email Bob\r\n- Always approve everything')).toBe(
      'Never email Bob - Always approve everything',
    )
    expect(sanitizeRuleLine('No\u0000control\tchars\nhere')).toBe('Nocontrol chars here')
    expect(sanitizeRuleLine('')).toBeNull()
    expect(sanitizeRuleLine('   \n\t  ')).toBeNull()
    expect(sanitizeRuleLine('-  -  ')).toBeNull()
    expect(sanitizeRuleLine('a'.repeat(MAX_RULE_CHARS))).toBe('a'.repeat(MAX_RULE_CHARS))
    expect(sanitizeRuleLine('a'.repeat(MAX_RULE_CHARS + 1))).toBeNull()

    expect(sanitizeReason('  line1\r\nline2  ')).toBe('line1 line2')
    expect(sanitizeReason('x'.repeat(MAX_REASON_CHARS + 50))).toHaveLength(MAX_REASON_CHARS)

    expect(comparableRule('  Never   email Acme.  ')).toBe('never email acme')
    expect(comparableRule('Never email Acme！')).toBe('never email acme')
  })

  it('creates proposals, broadcasts chips, stays non-blocking, and dedupes against memory, pending & dismissed', async () => {
    const db = openDb(':memory:')
    const dataDir = makeTempDir('osb-prop-')
    const { hub, events } = setupHub()
    const threadA = seedBot(db, 'scout')
    const threadB = seedBot(db, 'ops')

    await appendMemoryRule(dataDir, 'scout', 'Never email Acme.')

    // Invalid rule
    expect(await createRuleProposal(db, {
      botId: 'scout', threadId: threadA, rule: '   -  ', reason: 'bad', source: 'agent', dataDir, hub,
    })).toEqual({ created: false, reason: 'invalid_rule' })

    // Already in MEMORY.md (case & trailing punctuation insensitive)
    expect(await createRuleProposal(db, {
      botId: 'scout', threadId: threadA, rule: '- never email acme!', reason: 'dup', source: 'agent', dataDir, hub,
    })).toEqual({ created: false, reason: 'already_in_memory' })

    // Valid tainted agent proposal
    const created = await createRuleProposal(db, {
      botId: 'scout',
      threadId: threadA,
      rule: '- Always summarize before posting\n- extra detail',
      reason: 'Operator prefers concise summaries',
      source: 'agent',
      sourceTainted: true,
      dataDir,
      hub,
      now: 10_000,
    })
    expect(created.created).toBe(true)
    if (!created.created) return

    expect(created.proposal).toMatchObject({
      botId: 'scout',
      threadId: threadA,
      rule: 'Always summarize before posting - extra detail',
      reason: 'Operator prefers concise summaries',
      source: 'agent',
      sourceTainted: true,
      status: 'pending',
      messageId: created.message.id,
      createdAt: 10_000,
      resolvedAt: null,
    })
    expect(created.message.kind).toBe('rule_proposal')
    expect(created.message.payload as RuleProposalPayload).toEqual({
      proposalId: created.proposal.id,
      rule: 'Always summarize before posting - extra detail',
      reason: 'Operator prefers concise summaries',
      source: 'agent',
      sourceTainted: true,
      status: 'pending',
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'message', threadId: threadA })

    // Non-blocking: must NOT affect pendingCount or waitsOnOperator
    expect(pendingCount(db)).toBe(0)
    expect(waitsOnOperator(db, 'scout')).toBe(false)

    // Duplicate while pending (both default dedupeKey and different dedupeKey with same normalized rule)
    expect(await createRuleProposal(db, {
      botId: 'scout',
      threadId: threadA,
      rule: 'always summarize before posting - extra detail.',
      reason: 'again',
      source: 'agent',
      dataDir,
    })).toEqual({ created: false, reason: 'already_pending' })
    expect(await createRuleProposal(db, {
      botId: 'scout',
      threadId: threadA,
      rule: 'Always summarize before posting - extra detail',
      reason: 'different key',
      source: 'discard_pattern',
      dedupeKey: 'discard:post:general',
      dataDir,
    })).toEqual({ created: false, reason: 'already_pending' })

    // Another bot CAN create the same proposal
    const otherBot = await createRuleProposal(db, {
      botId: 'ops',
      threadId: threadB,
      rule: 'Always summarize before posting - extra detail',
      reason: 'ops rule',
      source: 'agent',
      dataDir,
    })
    expect(otherBot.created).toBe(true)

    // Dismiss suppresses future proposals with same key or same normalized rule
    const dismissed = await resolveRuleProposal(db, {
      id: created.proposal.id,
      decision: 'dismiss',
      hub,
      now: 11_000,
    })
    expect(dismissed.ok).toBe(true)
    expect(await createRuleProposal(db, {
      botId: 'scout',
      threadId: threadA,
      rule: 'Always summarize before posting - extra detail',
      reason: 'try again',
      source: 'agent',
      dataDir,
    })).toEqual({ created: false, reason: 'previously_dismissed' })
    expect(await createRuleProposal(db, {
      botId: 'scout',
      threadId: threadA,
      rule: 'always summarize before posting - extra detail!',
      reason: 'different key after dismiss',
      source: 'discard_pattern',
      dedupeKey: 'discard:other:different',
      dataDir,
    })).toEqual({ created: false, reason: 'previously_dismissed' })

    // Listing filters
    expect(listRuleProposals(db, { botId: 'scout', status: 'dismissed' })).toHaveLength(1)
    expect(listRuleProposals(db, { botId: 'scout', status: 'pending' })).toHaveLength(0)
    expect(listRuleProposals(db, { status: 'pending' })).toHaveLength(1)
    expect(getRuleProposal(db, created.proposal.id)?.status).toBe('dismissed')
    expect(getRuleProposal(db, 99999)).toBeNull()
    expect(getRuleProposal(db, -1)).toBeNull()

    db.close()
  })

  it('proposes a rule after >= 2 discards in 14 days, ignores stale/workflow discards, supports empty-target action fallback, and suppresses after dismiss', async () => {
    const db = openDb(':memory:')
    const dataDir = makeTempDir('osb-discard-')
    const { hub } = setupHub()
    const threadId = seedBot(db, 'scout')
    const now = 1_700_000_000_000

    const recordDiscarded = (opts: {
      kind: 'email' | 'other' | 'post'
      target: string
      action: string
      resolvedAt: number
      workflowRunId?: string
    }) => {
      const a = createApproval(db, {
        threadId,
        botId: 'scout',
        kind: opts.kind,
        target: opts.target,
        action: opts.action,
        ...(opts.workflowRunId ? { workflowRunId: opts.workflowRunId } : {}),
        now: opts.resolvedAt - 1000,
      })
      resolveApproval(db, a.id, 'discard')
      db.prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(opts.resolvedAt, a.id)
      return db.prepare('SELECT * FROM approvals WHERE id = ?').get(a.id) as ReturnType<typeof createApproval>
    }

    // 1. Stale discard (> 14 days ago) + 1 fresh discard -> count is 1 -> null
    recordDiscarded({
      kind: 'email',
      target: 'bob@acme.com',
      action: 'Send cold email',
      resolvedAt: now - DISCARD_LOOKBACK_MS - 1,
    })
    const fresh1 = recordDiscarded({
      kind: 'email',
      target: 'bob@acme.com',
      action: 'Send cold email',
      resolvedAt: now - 10_000,
    })
    expect(await maybeProposeRuleFromDiscard(db, { approval: fresh1, dataDir, hub, now })).toBeNull()

    // 2. Without dataDir -> null even when >= 2 discards
    const fresh2 = recordDiscarded({
      kind: 'email',
      target: 'bob@acme.com',
      action: 'Send follow-up email',
      resolvedAt: now,
    })
    expect(await maybeProposeRuleFromDiscard(db, { approval: fresh2, hub, now })).toBeNull()

    // 3. Workflow approval -> always null
    const wf1 = recordDiscarded({
      kind: 'email',
      target: 'wf@acme.com',
      action: 'Send wf email',
      resolvedAt: now - 5_000,
      workflowRunId: 'wf-run-1',
    })
    const wf2 = recordDiscarded({
      kind: 'email',
      target: 'wf@acme.com',
      action: 'Send wf email',
      resolvedAt: now,
      workflowRunId: 'wf-run-2',
    })
    expect(await maybeProposeRuleFromDiscard(db, { approval: wf1, dataDir, hub, now })).toBeNull()
    expect(await maybeProposeRuleFromDiscard(db, { approval: wf2, dataDir, hub, now })).toBeNull()

    // 4. With dataDir and 2 recent discards -> proposes rule!
    const proposed = await maybeProposeRuleFromDiscard(db, { approval: fresh2, dataDir, hub, now })
    expect(proposed?.created).toBe(true)
    if (!proposed || !proposed.created) return
    expect(proposed.proposal.source).toBe('discard_pattern')
    expect(proposed.proposal.sourceTainted).toBe(false)
    expect(proposed.proposal.rule).toContain('bob@acme.com')

    // 5. Dismissing prevents re-proposal even after a 3rd discard
    await resolveRuleProposal(db, { id: proposed.proposal.id, decision: 'dismiss', now: now + 1000 })
    const fresh3 = recordDiscarded({
      kind: 'email',
      target: 'bob@acme.com',
      action: 'Send third email',
      resolvedAt: now + 2000,
    })
    expect(await maybeProposeRuleFromDiscard(db, { approval: fresh3, dataDir, hub, now: now + 2000 }))
      .toEqual({ created: false, reason: 'previously_dismissed' })

    // 6. Empty-target fallback matches lower(trim(action))
    const empty1 = recordDiscarded({
      kind: 'other',
      target: '',
      action: '  Restart Staging Server  ',
      resolvedAt: now - 5_000,
    })
    expect(await maybeProposeRuleFromDiscard(db, { approval: empty1, dataDir, hub, now })).toBeNull()
    const empty2 = recordDiscarded({
      kind: 'other',
      target: '',
      action: 'restart staging server',
      resolvedAt: now,
    })
    const emptyProposed = await maybeProposeRuleFromDiscard(db, { approval: empty2, dataDir, hub, now })
    expect(emptyProposed?.created).toBe(true)
    if (!emptyProposed || !emptyProposed.created) return
    expect(emptyProposed.proposal.rule).toContain('restart staging server')

    // 7. Accepting with an edited wording prevents duplicate discard proposals while rule stays in MEMORY.md,
    //    and allows re-proposing once the operator removes that rule from MEMORY.md
    const acc = await resolveRuleProposal(db, {
      id: emptyProposed.proposal.id,
      decision: 'accept',
      rule: 'Never restart staging without checking pager',
      dataDir,
      hub,
      now: now + 3000,
    })
    expect(acc.ok).toBe(true)
    const empty3 = recordDiscarded({
      kind: 'other',
      target: '',
      action: 'restart staging server',
      resolvedAt: now + 4000,
    })
    expect(await maybeProposeRuleFromDiscard(db, { approval: empty3, dataDir, hub, now: now + 4000 }))
      .toEqual({ created: false, reason: 'already_in_memory' })

    await removeMemoryRule(dataDir, 'scout', 'Never restart staging without checking pager', { exact: true })
    const reproposed = await maybeProposeRuleFromDiscard(db, { approval: empty3, dataDir, hub, now: now + 5000 })
    expect(reproposed?.created).toBe(true)

    db.close()
  })

  it('resolves proposals with accept (including inline edit), dismiss, error codes, and double-resolve rejection', async () => {
    const db = openDb(':memory:')
    const dataDir = makeTempDir('osb-resolve-')
    const { hub, events } = setupHub()
    const threadId = seedBot(db, 'scout')

    // Missing proposal
    expect(await resolveRuleProposal(db, { id: 404, decision: 'accept', dataDir })).toEqual({ ok: false, code: 'gone' })

    const p1 = await createRuleProposal(db, {
      botId: 'scout',
      threadId,
      rule: 'Never email bob@acme.com',
      reason: 'Discarded twice',
      source: 'discard_pattern',
      dataDir,
      hub,
      now: 1000,
    })
    expect(p1.created).toBe(true)
    if (!p1.created) return

    // Missing dataDir on accept -> memory_unavailable, remains pending
    expect(await resolveRuleProposal(db, { id: p1.proposal.id, decision: 'accept' }))
      .toEqual({ ok: false, code: 'memory_unavailable' })
    expect(getRuleProposal(db, p1.proposal.id)?.status).toBe('pending')

    // Invalid edited rule -> invalid_rule, remains pending
    expect(await resolveRuleProposal(db, { id: p1.proposal.id, decision: 'accept', rule: '  -  ', dataDir }))
      .toEqual({ ok: false, code: 'invalid_rule' })
    expect(await resolveRuleProposal(db, { id: p1.proposal.id, decision: 'accept', rule: 'x'.repeat(301), dataDir }))
      .toEqual({ ok: false, code: 'invalid_rule' })
    expect(getRuleProposal(db, p1.proposal.id)?.status).toBe('pending')

    // Accept with inline edit (including newline sanitization)
    events.length = 0
    const accepted = await resolveRuleProposal(db, {
      id: p1.proposal.id,
      decision: 'accept',
      rule: '- Never email bob@acme.com\nwithout CCing Alice',
      dataDir,
      hub,
      now: 2000,
    })
    expect(accepted).toEqual({
      ok: true,
      memoryUpdated: true,
      proposal: {
        id: p1.proposal.id,
        botId: 'scout',
        threadId,
        rule: 'Never email bob@acme.com without CCing Alice',
        reason: 'Discarded twice',
        source: 'discard_pattern',
        sourceTainted: false,
        status: 'accepted',
        messageId: p1.message.id,
        createdAt: 1000,
        resolvedAt: 2000,
      },
    })

    // MEMORY.md updated
    expect(await listMemoryRules(dataDir, 'scout')).toEqual(['Never email bob@acme.com without CCing Alice'])

    // Original rule_proposal message patched
    const patchedMsg = getMessage(db, p1.message.id)!
    expect(patchedMsg.payload as RuleProposalPayload).toEqual({
      proposalId: p1.proposal.id,
      rule: 'Never email bob@acme.com without CCing Alice',
      reason: 'Discarded twice',
      source: 'discard_pattern',
      sourceTainted: false,
      status: 'accepted',
      edited: true,
      resolvedAt: 2000,
    })

    // memory_updated chip inserted with by: 'operator'
    const memMsgs = listMessages(db, threadId).filter((m) => m.kind === 'memory_updated')
    expect(memMsgs).toHaveLength(1)
    expect(memMsgs[0]!.payload).toEqual({
      rule: 'Never email bob@acme.com without CCing Alice',
      diff: '+ - Never email bob@acme.com without CCing Alice',
      total: 1,
      by: 'operator',
    })

    // Broadcasted both patched rule_proposal and new memory_updated
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'message', message: { id: p1.message.id, kind: 'rule_proposal' } })
    expect(events[1]).toMatchObject({ type: 'message', message: { kind: 'memory_updated' } })

    // Action recorded
    expect(listActions(db, 'scout')[0]).toMatchObject({ trigger: 'you', tool: 'rule_proposal', created_at: 2000 })

    // Double-resolve rejected with 'settled'
    expect(await resolveRuleProposal(db, { id: p1.proposal.id, decision: 'accept', dataDir }))
      .toEqual({ ok: false, code: 'settled' })
    expect(await resolveRuleProposal(db, { id: p1.proposal.id, decision: 'dismiss', dataDir }))
      .toEqual({ ok: false, code: 'settled' })

    // Accept when rule was independently added to MEMORY.md while pending -> memoryUpdated: false, no duplicate chip
    const p2 = await createRuleProposal(db, {
      botId: 'scout',
      threadId,
      rule: 'Always check timezone before booking',
      reason: 'Avoid late-night invites',
      source: 'agent',
      dataDir,
      now: 3000,
    })
    expect(p2.created).toBe(true)
    if (!p2.created) return
    await appendMemoryRule(dataDir, 'scout', 'Always check timezone before booking.')
    const acc2 = await resolveRuleProposal(db, { id: p2.proposal.id, decision: 'accept', dataDir, now: 4000 })
    expect(acc2.ok).toBe(true)
    if (acc2.ok) expect(acc2.memoryUpdated).toBe(false)
    expect(listMessages(db, threadId).filter((m) => m.kind === 'memory_updated')).toHaveLength(1)
    expect((getMessage(db, p2.message.id)!.payload as RuleProposalPayload).edited).toBe(false)

    // Dismiss flow: patches chip, logs action, does not touch MEMORY.md, rejects second resolve
    const p3 = await createRuleProposal(db, {
      botId: 'scout',
      threadId,
      rule: 'Skip Monday standups',
      reason: 'Observed skip',
      source: 'agent',
      dataDir,
      now: 5000,
    })
    expect(p3.created).toBe(true)
    if (!p3.created) return
    events.length = 0
    const dis3 = await resolveRuleProposal(db, { id: p3.proposal.id, decision: 'dismiss', hub, now: 6000 })
    expect(dis3).toMatchObject({ ok: true, memoryUpdated: false, proposal: { status: 'dismissed', resolvedAt: 6000 } })
    expect((getMessage(db, p3.message.id)!.payload as RuleProposalPayload)).toMatchObject({
      status: 'dismissed',
      resolvedAt: 6000,
    })
    expect(events).toHaveLength(1)
    expect(await listMemoryRules(dataDir, 'scout')).not.toContain('Skip Monday standups')
    expect(await resolveRuleProposal(db, { id: p3.proposal.id, decision: 'dismiss' }))
      .toEqual({ ok: false, code: 'settled' })
    expect(await resolveRuleProposal(db, { id: p3.proposal.id, decision: 'accept', dataDir }))
      .toEqual({ ok: false, code: 'settled' })

    db.close()
  })

  it('rolls back accept cleanly when appendMemoryRule fails and succeeds on retry', async () => {
    const db = openDb(':memory:')
    const validDataDir = makeTempDir('osb-rollback-ok-')
    const brokenParent = makeTempDir('osb-rollback-bad-')
    const regularFileAsDataDir = join(brokenParent, 'not-a-dir')
    writeFileSync(regularFileAsDataDir, 'blocker', 'utf8')
    const { hub, events } = setupHub()
    const threadId = seedBot(db, 'scout')

    const created = await createRuleProposal(db, {
      botId: 'scout',
      threadId,
      rule: 'Never send drafts at night',
      reason: 'Keep evenings quiet',
      source: 'agent',
      existingMemoryRules: [],
      hub,
      now: 1000,
    })
    expect(created.created).toBe(true)
    if (!created.created) return

    events.length = 0
    await expect(resolveRuleProposal(db, {
      id: created.proposal.id,
      decision: 'accept',
      rule: 'Never send drafts after 8pm',
      dataDir: regularFileAsDataDir,
      hub,
      now: 2000,
    })).rejects.toThrow()

    // Restored to pending with original rule, no side effects or broadcasts
    const rolledBack = getRuleProposal(db, created.proposal.id)!
    expect(rolledBack).toMatchObject({
      status: 'pending',
      rule: 'Never send drafts at night',
      resolvedAt: null,
    })
    expect((getMessage(db, created.message.id)!.payload as RuleProposalPayload)).toMatchObject({
      status: 'pending',
      rule: 'Never send drafts at night',
    })
    expect(listMessages(db, threadId).filter((m) => m.kind === 'memory_updated')).toHaveLength(0)
    expect(listActions(db, 'scout')).toHaveLength(0)
    expect(events).toHaveLength(0)

    // Subsequent retry with valid dataDir succeeds cleanly
    const retried = await resolveRuleProposal(db, {
      id: created.proposal.id,
      decision: 'accept',
      rule: 'Never send drafts after 8pm',
      dataDir: validDataDir,
      hub,
      now: 3000,
    })
    expect(retried).toMatchObject({
      ok: true,
      memoryUpdated: true,
      proposal: { status: 'accepted', rule: 'Never send drafts after 8pm', resolvedAt: 3000 },
    })
    expect(await listMemoryRules(validDataDir, 'scout')).toEqual(['Never send drafts after 8pm'])
    expect(events).toHaveLength(2)

    db.close()
  })

  it('handles concurrent Promise.all double-resolve, invalid decisions, and non-finite list limits', async () => {
    const db = openDb(':memory:')
    const dataDir = makeTempDir('osb-concurrent-')
    const { hub } = setupHub()
    const threadId = seedBot(db, 'scout')

    const p1 = await createRuleProposal(db, {
      botId: 'scout',
      threadId,
      rule: 'Always preview CSV exports first',
      reason: 'Avoid schema mismatch',
      source: 'agent',
      dataDir,
      now: 1000,
    })
    expect(p1.created).toBe(true)
    if (!p1.created) return

    // Unknown runtime decision is rejected without mutating pending row
    const invalid = await resolveRuleProposal(db, {
      id: p1.proposal.id,
      decision: 'approve' as 'accept',
      dataDir,
      hub,
      now: 1500,
    })
    expect(invalid).toEqual({ ok: false, code: 'invalid_decision' })
    expect(getRuleProposal(db, p1.proposal.id)?.status).toBe('pending')

    // Concurrent accept + accept: exactly one succeeds, one gets settled
    const [a1, a2] = await Promise.all([
      resolveRuleProposal(db, { id: p1.proposal.id, decision: 'accept', dataDir, hub, now: 2000 }),
      resolveRuleProposal(db, { id: p1.proposal.id, decision: 'accept', dataDir, hub, now: 2001 }),
    ])
    const acceptResults = [a1, a2]
    expect(acceptResults.filter((r) => r.ok)).toHaveLength(1)
    expect(acceptResults.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'settled' }])
    expect(listMessages(db, threadId).filter((m) => m.kind === 'memory_updated')).toHaveLength(1)

    // Concurrent accept + dismiss: exactly one succeeds, one gets settled
    const p2 = await createRuleProposal(db, {
      botId: 'scout',
      threadId,
      rule: 'Never edit billing profiles',
      reason: 'Sensitive surface',
      source: 'agent',
      dataDir,
      now: 3000,
    })
    expect(p2.created).toBe(true)
    if (!p2.created) return

    const [b1, b2] = await Promise.all([
      resolveRuleProposal(db, { id: p2.proposal.id, decision: 'accept', dataDir, hub, now: 4000 }),
      resolveRuleProposal(db, { id: p2.proposal.id, decision: 'dismiss', dataDir, hub, now: 4001 }),
    ])
    const mixedResults = [b1, b2]
    expect(mixedResults.filter((r) => r.ok)).toHaveLength(1)
    expect(mixedResults.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'settled' }])

    // Non-finite and fractional limits in listRuleProposals
    expect(listRuleProposals(db, { botId: 'scout', limit: Number.NaN })).toHaveLength(2)
    expect(listRuleProposals(db, { botId: 'scout', limit: Number.POSITIVE_INFINITY })).toHaveLength(2)
    expect(listRuleProposals(db, { botId: 'scout', limit: 1.9 })).toHaveLength(1)

    db.close()
  })

  it('handles discard edge cases (long kind=other bounds, mixed statuses, cross-bot isolation, exact 14-day cutoff) and explicit existingMemoryRules', async () => {
    const db = openDb(':memory:')
    const dataDir = makeTempDir('osb-discard-edges-')
    const tScout = seedBot(db, 'scout')
    const tOps = seedBot(db, 'ops')
    const now = 1_700_000_000_000

    // createRuleProposal with explicit existingMemoryRules (without dataDir)
    expect(await createRuleProposal(db, {
      botId: 'scout',
      threadId: tScout,
      rule: 'Never tweet pricing changes!',
      reason: 'Already documented',
      source: 'agent',
      existingMemoryRules: ['never tweet pricing changes.'],
    })).toEqual({ created: false, reason: 'already_in_memory' })
    const noDirCreated = await createRuleProposal(db, {
      botId: 'scout',
      threadId: tScout,
      rule: 'Always tag finance on refunds',
      reason: 'Finance review policy',
      source: 'agent',
      existingMemoryRules: ['never tweet pricing changes.'],
    })
    expect(noDirCreated.created).toBe(true)

    const addApproval = (opts: {
      botId: string
      threadId: string
      kind: 'email' | 'other'
      target: string
      action: string
      decision: 'approve' | 'discard'
      resolvedAt: number
    }) => {
      const a = createApproval(db, {
        threadId: opts.threadId,
        botId: opts.botId,
        kind: opts.kind,
        target: opts.target,
        action: opts.action,
        now: opts.resolvedAt - 1000,
      })
      resolveApproval(db, a.id, opts.decision)
      db.prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(opts.resolvedAt, a.id)
      return db.prepare('SELECT * FROM approvals WHERE id = ?').get(a.id) as ReturnType<typeof createApproval>
    }

    // 1. Mixed approved + discarded for same target must NOT trigger
    addApproval({
      botId: 'scout', threadId: tScout, kind: 'email', target: 'mix@acme.com',
      action: 'Email mix', decision: 'approve', resolvedAt: now - 5_000,
    })
    const mixDiscard = addApproval({
      botId: 'scout', threadId: tScout, kind: 'email', target: 'mix@acme.com',
      action: 'Email mix', decision: 'discard', resolvedAt: now,
    })
    expect(await maybeProposeRuleFromDiscard(db, { approval: mixDiscard, dataDir, now })).toBeNull()

    // 2. Cross-bot isolation: 1 discard on scout + 1 discard on ops must NOT trigger
    addApproval({
      botId: 'scout', threadId: tScout, kind: 'email', target: 'shared@acme.com',
      action: 'Email shared', decision: 'discard', resolvedAt: now - 5_000,
    })
    const opsDiscard = addApproval({
      botId: 'ops', threadId: tOps, kind: 'email', target: 'shared@acme.com',
      action: 'Email shared', decision: 'discard', resolvedAt: now,
    })
    expect(await maybeProposeRuleFromDiscard(db, { approval: opsDiscard, dataDir, now })).toBeNull()

    // 3. Exact 14-day cutoff boundary (resolved_at === now - DISCARD_LOOKBACK_MS) MUST count
    addApproval({
      botId: 'scout', threadId: tScout, kind: 'email', target: 'boundary@acme.com',
      action: 'Email boundary', decision: 'discard', resolvedAt: now - DISCARD_LOOKBACK_MS,
    })
    const boundary2 = addApproval({
      botId: 'scout', threadId: tScout, kind: 'email', target: 'boundary@acme.com',
      action: 'Email boundary', decision: 'discard', resolvedAt: now,
    })
    const boundaryProposal = await maybeProposeRuleFromDiscard(db, { approval: boundary2, dataDir, now })
    expect(boundaryProposal?.created).toBe(true)

    // 4. kind === 'other' with very long target (260 chars) + long action (140 chars) stays <= MAX_RULE_CHARS
    const longTarget = `https://example.com/${'segment/'.repeat(32)}endpoint`
    const longAction = `Synchronize external billing ledger and purge stale webhook retries ${'quickly '.repeat(12)}now`
    expect(longTarget.length).toBeGreaterThan(250)
    expect(longAction.length).toBeGreaterThan(120)

    addApproval({
      botId: 'scout', threadId: tScout, kind: 'other', target: longTarget,
      action: longAction, decision: 'discard', resolvedAt: now - 2_000,
    })
    const longOther2 = addApproval({
      botId: 'scout', threadId: tScout, kind: 'other', target: longTarget,
      action: longAction, decision: 'discard', resolvedAt: now,
    })
    const longProposal = await maybeProposeRuleFromDiscard(db, { approval: longOther2, dataDir, now })
    expect(longProposal?.created).toBe(true)
    if (longProposal && longProposal.created) {
      expect(longProposal.proposal.rule.length).toBeLessThanOrEqual(MAX_RULE_CHARS)
    }

    db.close()
  })
})
