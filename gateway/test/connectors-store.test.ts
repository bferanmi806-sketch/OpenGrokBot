import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApproval, getApproval, recordApprovalExecution } from '../src/approvals.js'
import { CATALOG, catalogByApp, isAppKey } from '../src/connectors/catalog.js'
import { composioBaseUrl, composioKeyView, resolveComposioKey, saveComposioKey } from '../src/connectors/keys.js'
import {
  activateConnectorAccount, createConnectorAccount, deleteConnectorAccount, getConnectorAccount,
  listActiveBotConnectors, listAllBotGrants, listBotConnectorIds, listBotConnectorsAllStatuses,
  listConnectorAccounts, markConnectorStatus, markExpiredNotified, setBotConnectors, setConnectorBots,
} from '../src/connectors/store.js'
import { openDb, schemaVersion, upsertBot } from '../src/db.js'

describe('connectors store & keys', () => {
  it('migrates to v11 and manages connector accounts and bot grants with zero default access', () => {
    const db = openDb(':memory:')
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(11)
    upsertBot(db, { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' })
    upsertBot(db, { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })

    const acc = createConnectorAccount(db, {
      app: 'gmail', driver: 'composio', remoteId: 'ca_remote_1', authConfigId: 'ac_1', now: 1000,
    })
    expect(acc.id).toMatch(/^ca-[0-9a-f]{8}$/)
    expect(acc.status).toBe('pending')
    expect(listActiveBotConnectors(db, 'inbox-keeper')).toEqual([])

    setBotConnectors(db, 'inbox-keeper', [acc.id], 1001)
    // Still pending, so active list stays empty
    expect(listActiveBotConnectors(db, 'inbox-keeper')).toEqual([])

    activateConnectorAccount(db, acc.id, { remoteId: 'ca_remote_1', accountLabel: 'alice@gmail.com' }, 1002)
    expect(listActiveBotConnectors(db, 'inbox-keeper').map((x) => x.account_label)).toEqual(['alice@gmail.com'])
    expect(listActiveBotConnectors(db, 'researcher')).toEqual([])
    expect(listAllBotGrants(db)).toEqual({ 'inbox-keeper': [acc.id], researcher: [] })

    markConnectorStatus(db, acc.id, 'expired', 'token revoked', 1003)
    expect(listActiveBotConnectors(db, 'inbox-keeper')).toEqual([])

    expect(deleteConnectorAccount(db, acc.id)).toBe(true)
    expect(listConnectorAccounts(db)).toEqual([])
    expect(listAllBotGrants(db)['inbox-keeper']).toEqual([])
  })

  it('stores composio key with 0600 permissions and honors env lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osb-conn-key-'))
    expect(composioKeyView({}, dir)).toEqual({ set: false, masked: '', source: 'none', locked: false })

    saveComposioKey(dir, 'cmp_live_1234567890abcdef')
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'composio-key')).mode & 0o777).toBe(0o600)
    }
    expect(resolveComposioKey({}, dir)).toEqual({ key: 'cmp_live_1234567890abcdef', source: 'file' })
    expect(composioKeyView({}, dir).masked).toBe('cmp…cdef')

    const locked = composioKeyView({ OPENSUPERBOT_COMPOSIO_API_KEY: 'cmp_env_secret9999' }, dir)
    expect(locked).toEqual({ set: true, masked: 'cmp…9999', source: 'env', locked: true })

    saveComposioKey(dir, '')
    expect(composioKeyView({}, dir).set).toBe(false)
  })

  it('persists frozen connector execution metadata on approvals', () => {
    const db = openDb(':memory:')
    const row = createApproval(db, {
      threadId: 'dm:inbox-keeper',
      botId: 'inbox-keeper',
      action: 'Send email to bob@acme.com',
      detail: 'Subject: Hi',
      kind: 'email',
      target: 'bob@acme.com',
      executionJson: '{"version":1,"tool":"mail_send"}',
      operationId: 'op-123',
    })
    expect(row.execution_json).toBe('{"version":1,"tool":"mail_send"}')
    expect(row.operation_id).toBe('op-123')
    expect(row.execution_status).toBeNull()

    recordApprovalExecution(db, row.id, 'succeeded', 'Sent message msg_1')
    const updated = getApproval(db, row.id)!
    expect(updated.execution_status).toBe('succeeded')
    expect(updated.execution_detail).toBe('Sent message msg_1')

    recordApprovalExecution(db, row.id, 'uncertain', 'x'.repeat(2500))
    expect(getApproval(db, row.id)!.execution_detail).toHaveLength(2000)
  })

  it('exposes the 7 catalog apps in 3 groups including native Polery Docs', () => {
    expect(CATALOG.map((c) => c.app)).toEqual([
      'gmail', 'outlook', 'google_calendar', 'outlook_calendar', 'polery', 'notion', 'slack',
    ])
    expect(catalogByApp('polery')?.native).toBe(true)
    expect(catalogByApp('gmail')?.toolkitSlug).toBe('gmail')
    expect(catalogByApp('google_calendar')?.toolkitSlug).toBe('googlecalendar')
    expect(catalogByApp('unknown')).toBeUndefined()
    expect(isAppKey('slack')).toBe(true)
    expect(isAppKey('unknown')).toBe(false)
    expect(isAppKey(null)).toBe(false)
  })

  it('supports reverse bot grants, expiry notification deduping, and key/url validation', () => {
    const db = openDb(':memory:')
    upsertBot(db, { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' })
    upsertBot(db, { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })

    const acc = createConnectorAccount(db, { app: 'slack', remoteId: 'ca_slack_1', now: 10 })
    expect(getConnectorAccount(db, 'bad-id')).toBeNull()
    expect(deleteConnectorAccount(db, 'bad-id')).toBe(false)

    setConnectorBots(db, acc.id, ['inbox-keeper', 'researcher', 'ghost-bot'], 20)
    expect(listBotConnectorIds(db, 'inbox-keeper')).toEqual([acc.id])
    expect(listBotConnectorIds(db, 'researcher')).toEqual([acc.id])
    expect(listBotConnectorsAllStatuses(db, 'inbox-keeper').map((r) => r.id)).toEqual([acc.id])

    expect(markExpiredNotified(db, acc.id)).toBe(true)
    expect(markExpiredNotified(db, acc.id)).toBe(false)
    expect(markConnectorStatus(db, acc.id, 'active', '', 30)).toBe(true)
    expect(markExpiredNotified(db, acc.id)).toBe(true)

    const dir = mkdtempSync(join(tmpdir(), 'osb-conn-key-bad-'))
    expect(() => saveComposioKey(dir, 'bad key with spaces')).toThrow(/invalid API key/)
    expect(composioBaseUrl({})).toBe('https://backend.composio.dev')
    expect(composioBaseUrl({ OPENSUPERBOT_COMPOSIO_BASE: 'https://api.example.com/v3///' })).toBe('https://api.example.com/v3')
    expect(composioBaseUrl({ OPENSUPERBOT_COMPOSIO_BASE: 'https://u:p@api.example.com' })).toBe('https://backend.composio.dev')
    expect(composioBaseUrl({ OPENSUPERBOT_COMPOSIO_BASE: 'ftp://api.example.com' })).toBe('https://backend.composio.dev')
  })
})
