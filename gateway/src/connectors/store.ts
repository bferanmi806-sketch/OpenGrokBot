import { randomBytes } from 'node:crypto'
import type { Db } from '../db.js'
import type { AppKey, ConnectorAccountRow, ConnectorStatus } from './types.js'

const ID_RE = /^ca-[0-9a-f]{8}$/

export const isConnectorId = (id: string): boolean => ID_RE.test(id)

export function createConnectorAccount(
  db: Db,
  input: {
    app: AppKey
    driver?: string
    remoteId: string
    authConfigId?: string
    accountLabel?: string
    status?: ConnectorStatus
    now?: number
  },
): ConnectorAccountRow {
  const at = input.now ?? Date.now()
  const id = `ca-${randomBytes(4).toString('hex')}`
  db.prepare(
    `INSERT INTO connector_accounts
     (id, app, driver, remote_id, auth_config_id, account_label, status, last_error, notified_expired, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?)`,
  ).run(
    id, input.app, input.driver ?? 'composio', input.remoteId, input.authConfigId ?? '',
    input.accountLabel ?? '', input.status ?? 'pending', at, at,
  )
  return getConnectorAccount(db, id)!
}

export function getConnectorAccount(db: Db, id: string): ConnectorAccountRow | null {
  if (!isConnectorId(id)) return null
  return (db.prepare('SELECT * FROM connector_accounts WHERE id = ?').get(id) as ConnectorAccountRow | undefined) ?? null
}

export function listConnectorAccounts(db: Db): ConnectorAccountRow[] {
  return db.prepare('SELECT * FROM connector_accounts ORDER BY created_at ASC, id ASC').all() as ConnectorAccountRow[]
}

export function activateConnectorAccount(
  db: Db,
  id: string,
  patch: { remoteId: string; accountLabel: string; authConfigId?: string },
  now = Date.now(),
): ConnectorAccountRow | null {
  const info = db.prepare(
    `UPDATE connector_accounts
     SET remote_id = ?, account_label = ?, auth_config_id = COALESCE(?, auth_config_id),
         status = 'active', last_error = '', notified_expired = 0, updated_at = ?
     WHERE id = ?`,
  ).run(patch.remoteId, patch.accountLabel, patch.authConfigId ?? null, now, id)
  return info.changes === 0 ? null : getConnectorAccount(db, id)
}

export function markConnectorStatus(
  db: Db,
  id: string,
  status: ConnectorStatus,
  lastError = '',
  now = Date.now(),
): boolean {
  const resetNotify = status === 'active' ? 0 : undefined
  const info = resetNotify === 0
    ? db.prepare(`UPDATE connector_accounts SET status = ?, last_error = ?, notified_expired = 0, updated_at = ? WHERE id = ?`)
        .run(status, lastError.slice(0, 500), now, id)
    : db.prepare(`UPDATE connector_accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
        .run(status, lastError.slice(0, 500), now, id)
  return info.changes > 0
}

export function markExpiredNotified(db: Db, id: string): boolean {
  const info = db.prepare(
    `UPDATE connector_accounts SET notified_expired = 1 WHERE id = ? AND notified_expired = 0`,
  ).run(id)
  return info.changes > 0
}

export function deleteConnectorAccount(db: Db, id: string): boolean {
  if (!isConnectorId(id)) return false
  let removed = false
  db.transaction(() => {
    db.prepare('DELETE FROM bot_connectors WHERE connector_id = ?').run(id)
    removed = db.prepare('DELETE FROM connector_accounts WHERE id = ?').run(id).changes > 0
  })()
  return removed
}

export function setBotConnectors(db: Db, botId: string, connectorIds: string[], now = Date.now()): string[] {
  const valid = [...new Set(connectorIds)].filter((id) => Boolean(getConnectorAccount(db, id)))
  db.transaction(() => {
    db.prepare('DELETE FROM bot_connectors WHERE bot_id = ?').run(botId)
    const ins = db.prepare('INSERT INTO bot_connectors (bot_id, connector_id, created_at) VALUES (?, ?, ?)')
    for (const cid of valid) ins.run(botId, cid, now)
  })()
  return listBotConnectorIds(db, botId)
}

export function setConnectorBots(db: Db, connectorId: string, botIds: string[], now = Date.now()): void {
  if (!getConnectorAccount(db, connectorId)) return
  const existingBots = new Set((db.prepare('SELECT id FROM bots').all() as { id: string }[]).map((r) => r.id))
  const valid = [...new Set(botIds)].filter((b) => existingBots.has(b))
  db.transaction(() => {
    db.prepare('DELETE FROM bot_connectors WHERE connector_id = ?').run(connectorId)
    const ins = db.prepare('INSERT INTO bot_connectors (bot_id, connector_id, created_at) VALUES (?, ?, ?)')
    for (const bid of valid) ins.run(bid, connectorId, now)
  })()
}

export function listBotConnectorIds(db: Db, botId: string): string[] {
  return (db.prepare('SELECT connector_id FROM bot_connectors WHERE bot_id = ? ORDER BY connector_id').all(botId) as { connector_id: string }[])
    .map((r) => r.connector_id)
}

export function listAllBotGrants(db: Db): Record<string, string[]> {
  const bots = (db.prepare('SELECT id FROM bots ORDER BY id').all() as { id: string }[]).map((r) => r.id)
  const out: Record<string, string[]> = Object.fromEntries(bots.map((id) => [id, []]))
  const rows = db.prepare('SELECT bot_id, connector_id FROM bot_connectors ORDER BY connector_id').all() as { bot_id: string; connector_id: string }[]
  for (const r of rows) {
    if (out[r.bot_id]) out[r.bot_id]!.push(r.connector_id)
  }
  return out
}

export function listActiveBotConnectors(db: Db, botId: string): ConnectorAccountRow[] {
  return db.prepare(
    `SELECT c.* FROM connector_accounts c
     JOIN bot_connectors b ON b.connector_id = c.id
     WHERE b.bot_id = ? AND c.status = 'active'
     ORDER BY c.created_at ASC, c.id ASC`,
  ).all(botId) as ConnectorAccountRow[]
}

export function listBotConnectorsAllStatuses(db: Db, botId: string): ConnectorAccountRow[] {
  return db.prepare(
    `SELECT c.* FROM connector_accounts c
     JOIN bot_connectors b ON b.connector_id = c.id
     WHERE b.bot_id = ?
     ORDER BY c.created_at ASC, c.id ASC`,
  ).all(botId) as ConnectorAccountRow[]
}
