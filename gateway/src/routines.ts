import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Cron } from 'croner'
import type { Db } from './db.js'

export type RoutineRow = {
  id: number
  bot_id: string
  name: string
  /** 空串 = 不按时间跑，只等 webhook */
  cron: string
  instructions: string
  enabled: number
  created_at: number
  last_run_at: number | null
  /** 有值 = 外部系统带着这个密钥 POST /hooks/routines/:id 就能叫醒它；从不进模型的上下文 */
  webhook_key: string | null
  /** act = 平常的回合；watch = 只看不动；prepare = 预备简报（只读 + wiki/本地草稿，禁止外部写和 shell） */
  mode: RoutineMode
  /** thread = 仅落入对话；feed / both = 报告同时投影到今日 Feed */
  surface?: RoutineSurface
  /** 可选关联的目标 id（goals.id）；目标暂停/完成后定时触发会自动跳过 */
  goal_id?: string | null
}

export type RoutineMode = 'act' | 'watch' | 'prepare'
export type RoutineSurface = 'thread' | 'feed' | 'both'

export function normalizeMode(value: unknown): RoutineMode {
  if (value === 'watch') return 'watch'
  if (value === 'prepare') return 'prepare'
  return 'act'
}

export function normalizeSurface(value: unknown, mode: RoutineMode = 'act'): RoutineSurface {
  if (value === 'thread' || value === 'feed' || value === 'both') return value
  return mode === 'watch' ? 'both' : 'thread'
}

export function isValidCron(expr: string): boolean {
  const trimmed = expr.trim()
  // 只收标准 5 段表达式（分 时 日 月 周）：croner 也认 6 段秒级，模型一旦多写一段就会每秒跑一轮
  if (!trimmed || trimmed.split(/\s+/).length !== 5) return false
  try {
    new Cron(trimmed, { paused: true })
    return true
  } catch {
    return false
  }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** 只覆盖常见形态；认不出就把原始表达式还给用户，好过编一句错的人话。 */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string]
  if (expr.trim() === '* * * * *') return 'every minute'
  const everyN = min.match(/^\*\/(\d+)$/)
  if (everyN && hour === '*' && dom === '*' && month === '*' && dow === '*') return `every ${everyN[1]} minutes`
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && month === '*') {
    const at = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    if (dom === '*' && dow === '*') return `every day at ${at}`
    if (dom === '*' && /^[0-6]$/.test(dow)) return `every ${DAYS[Number(dow)]} at ${at}`
    if (/^\d+$/.test(dom) && dow === '*') return `day ${dom} of each month at ${at}`
  }
  return expr
}

/** 「每天 09:00」「它的 webhook 被调用时」，或两者都有 */
export function describeRoutine(r: { cron: string; webhook_key?: string | null }): string {
  const parts = [r.cron.trim() ? describeCron(r.cron) : '', r.webhook_key ? 'when its webhook is called' : '']
  return parts.filter(Boolean).join(', and ') || 'never (no schedule and no webhook)'
}

export function createRoutine(
  db: Db,
  input: {
    botId: string
    name: string
    cron: string
    instructions: string
    webhook?: boolean
    mode?: RoutineMode
    surface?: RoutineSurface
    goalId?: string | null
  },
): RoutineRow {
  const key = input.webhook ? randomBytes(18).toString('base64url') : null
  const mode = input.mode ?? 'act'
  const surface = normalizeSurface(input.surface, mode)
  const goalId = input.goalId ?? null
  const info = db.prepare(
    `INSERT INTO routines (bot_id, name, cron, instructions, enabled, created_at, webhook_key, mode, surface, goal_id)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(input.botId, input.name, input.cron, input.instructions, Date.now(), key, mode, surface, goalId)
  return db.prepare('SELECT * FROM routines WHERE id = ?').get(Number(info.lastInsertRowid)) as RoutineRow
}

export function setRoutineGoal(db: Db, id: number, goalId: string | null): RoutineRow | null {
  db.prepare('UPDATE routines SET goal_id = ? WHERE id = ?').run(goalId, id)
  return getRoutine(db, id)
}

export function listGoalRoutines(db: Db, goalId: string): RoutineRow[] {
  return db.prepare('SELECT * FROM routines WHERE goal_id = ? ORDER BY enabled DESC, id DESC').all(goalId) as RoutineRow[]
}

export function clearGoalFromRoutines(db: Db, goalId: string): number {
  return db.prepare('UPDATE routines SET goal_id = NULL WHERE goal_id = ?').run(goalId).changes
}

/** 暂停挂在某目标下的全部活跃例行任务，返回被暂停的 routine id 列表（供 scheduler 移除） */
export function pauseGoalRoutines(db: Db, goalId: string): number[] {
  const active = db
    .prepare('SELECT id FROM routines WHERE goal_id = ? AND enabled = 1')
    .all(goalId) as { id: number }[]
  if (!active.length) return []
  db.prepare('UPDATE routines SET enabled = 0 WHERE goal_id = ? AND enabled = 1').run(goalId)
  return active.map((r) => r.id)
}

/** webhook 的入口：id 对得上、密钥逐字节相等（恒定时间比较）才算数；不区分「没这条」和「密钥错」 */
export function routineForWebhook(db: Db, id: number, key: string): RoutineRow | null {
  const routine = Number.isInteger(id) ? getRoutine(db, id) : null
  if (!routine?.webhook_key || !key) return null
  const a = Buffer.from(key)
  const b = Buffer.from(routine.webhook_key)
  return a.length === b.length && timingSafeEqual(a, b) ? routine : null
}

export function listRoutines(db: Db, botId?: string): RoutineRow[] {
  return botId
    ? (db.prepare('SELECT * FROM routines WHERE bot_id = ? ORDER BY enabled DESC, id DESC').all(botId) as RoutineRow[])
    : (db.prepare('SELECT * FROM routines ORDER BY enabled DESC, id DESC').all() as RoutineRow[])
}

export function markRoutineRun(db: Db, id: number, at: number): void {
  db.prepare('UPDATE routines SET last_run_at = ? WHERE id = ?').run(at, id)
}

export function getRoutine(db: Db, id: number): RoutineRow | null {
  return (db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined) ?? null
}

export function setRoutineEnabled(db: Db, id: number, enabled: boolean): RoutineRow | null {
  db.prepare('UPDATE routines SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  return getRoutine(db, id)
}

export function deleteRoutine(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM routines WHERE id = ?').run(id).changes > 0
}

/**
 * GitHub 发 webhook 时不能加自定义头、也不该把密钥放进网址：它用你填的 Secret 给请求体算 HMAC-SHA256，
 * 放在 X-Hub-Signature-256: sha256=<hex>。这里用这条 routine 的密钥当 Secret 重算一遍，恒定时间比较。
 * 签名对不上和「没这条」一样返回 null。
 */
export function routineForSignature(db: Db, id: number, body: Buffer, signature: string): RoutineRow | null {
  const routine = Number.isInteger(id) ? getRoutine(db, id) : null
  if (!routine?.webhook_key || !signature.startsWith('sha256=')) return null
  const expected = Buffer.from(`sha256=${createHmac('sha256', routine.webhook_key).update(body).digest('hex')}`)
  const given = Buffer.from(signature.trim().toLowerCase())
  return given.length === expected.length && timingSafeEqual(given, expected) ? routine : null
}
