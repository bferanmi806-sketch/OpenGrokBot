import { Cron } from 'croner'
import { isValidCron, type RoutineRow } from './routines.js'

export type CronJob = { stop(): void }
export type CronFactory = (expr: string, onTick: () => void) => CronJob

export const DEFAULT_CATCHUP_WINDOW_MS = 24 * 60 * 60_000
export const DEFAULT_MIN_DELIVERY_INTERVAL_MS = 60_000
export const DEFAULT_WAKE_CHECK_MS = 30_000
const MAX_CATCHUP_STEPS = 2_000

export type Scheduler = {
  load(routines: RoutineRow[]): void
  add(routine: RoutineRow): void
  remove(id: number): void
  /** 检查并执行停机/休眠期间错过的最近一次到期任务（Latest-only catch-up）。 */
  checkCatchUp?(): number
  stopAll(): void
  size(): number
}

const realCron = (timeZone?: string): CronFactory => (expr, onTick) =>
  new Cron(expr, timeZone ? { timezone: timeZone } : {}, onTick)

/**
 * 计算一条定时任务在 (anchor, nowMs] 区间内错过的「最近一次」到期时间戳（Latest-only，绝不连环补跑）：
 * - anchor 取 last_run_at ?? created_at；
 * - 超过 catchUpWindowMs（默认 24 小时）的过旧点忽略；
 * - 若不存在到期点返回 null。
 */
export function dueCatchUpAt(
  routine: Pick<RoutineRow, 'cron' | 'enabled' | 'created_at' | 'last_run_at'>,
  nowMs: number,
  opts: { timeZone?: string; catchUpWindowMs?: number } = {},
): number | null {
  if (!routine.enabled || !isValidCron(routine.cron)) return null
  const anchor = routine.last_run_at ?? routine.created_at
  if (!Number.isFinite(anchor) || anchor <= 0 || anchor >= nowMs) return null
  const windowMs = opts.catchUpWindowMs ?? DEFAULT_CATCHUP_WINDOW_MS
  if (windowMs <= 0) return null

  const startMs = Math.max(anchor, nowMs - windowMs - 1)
  let cron: Cron
  try {
    cron = new Cron(routine.cron.trim(), { paused: true, ...(opts.timeZone ? { timezone: opts.timeZone } : {}) })
  } catch {
    return null
  }
  let cursor = new Date(startMs)
  let latest: number | null = null
  for (let i = 0; i < MAX_CATCHUP_STEPS; i++) {
    const next = cron.nextRun(cursor)
    if (!next) break
    const ts = next.getTime()
    if (ts > nowMs) break
    latest = ts
    cursor = next
  }
  if (latest === null || latest <= anchor || nowMs - latest > windowMs) return null
  return latest
}

export function createScheduler(deps: {
  run: (routine: RoutineRow) => void | Promise<void>
  makeCron?: CronFactory
  timeZone?: string
  /** 是否在启动 load 与休眠唤醒时执行 Latest-only 补跑（默认 false 保持单测确定性；网关 main.ts 开启） */
  catchUp?: boolean
  catchUpWindowMs?: number
  minIntervalMs?: number
  wakeCheckIntervalMs?: number
  now?: () => number
}): Scheduler {
  const makeCron = deps.makeCron ?? realCron(deps.timeZone)
  const now = deps.now ?? (() => Date.now())
  const catchUpEnabled = deps.catchUp === true
  const catchUpWindowMs = deps.catchUpWindowMs ?? DEFAULT_CATCHUP_WINDOW_MS
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_DELIVERY_INTERVAL_MS
  const wakeCheckMs = deps.wakeCheckIntervalMs ?? DEFAULT_WAKE_CHECK_MS

  const jobs = new Map<number, CronJob>()
  const tracked = new Map<number, RoutineRow>()
  const lastDispatched = new Map<number, number>()
  let wakeTimer: ReturnType<typeof setInterval> | null = null
  let lastHeartbeatAt = now()

  const dispatch = (routine: RoutineRow): boolean => {
    const ts = now()
    const prev = lastDispatched.get(routine.id)
    if (prev !== undefined && minIntervalMs > 0 && ts - prev < minIntervalMs) {
      return false
    }
    lastDispatched.set(routine.id, ts)
    // 同步推进内存快照的 last_run_at，避免下一次唤醒检查重复补跑同一时间槽
    const current = tracked.get(routine.id)
    if (current) tracked.set(routine.id, { ...current, last_run_at: ts })
    try {
      void Promise.resolve(deps.run(routine)).catch(() => {})
    } catch { /* 一次触发失败不该停掉这条 routine */ }
    return true
  }

  const checkCatchUp = (): number => {
    const currentMs = now()
    let triggered = 0
    for (const routine of [...tracked.values()]) {
      const due = dueCatchUpAt(routine, currentMs, { timeZone: deps.timeZone, catchUpWindowMs })
      if (due !== null && dispatch(routine)) triggered++
    }
    return triggered
  }

  const ensureWakeWatch = (): void => {
    if (!catchUpEnabled || wakeTimer || wakeCheckMs <= 0) return
    lastHeartbeatAt = now()
    wakeTimer = setInterval(() => {
      const currentMs = now()
      const elapsed = currentMs - lastHeartbeatAt
      lastHeartbeatAt = currentMs
      // 挂钟跳跃超过心跳间隔 3 倍视为系统休眠/合盖唤醒：检查是否有错过的定时任务需 Latest-only 补跑
      if (elapsed > wakeCheckMs * 3) checkCatchUp()
    }, wakeCheckMs)
    wakeTimer.unref?.()
  }

  const stopWakeWatch = (): void => {
    if (!wakeTimer) return
    clearInterval(wakeTimer)
    wakeTimer = null
  }

  const stopAll = (): void => {
    stopWakeWatch()
    for (const job of jobs.values()) job.stop()
    jobs.clear()
    tracked.clear()
  }

  const add = (routine: RoutineRow): void => {
    jobs.get(routine.id)?.stop()
    jobs.delete(routine.id)
    tracked.delete(routine.id)
    // 停用或表达式坏掉的 routine 只是不排期，不该让整批注册失败
    if (!routine.enabled || !isValidCron(routine.cron)) return
    tracked.set(routine.id, { ...routine })
    jobs.set(routine.id, makeCron(routine.cron, () => {
      dispatch(tracked.get(routine.id) ?? routine)
    }))
    ensureWakeWatch()
  }

  return {
    add,
    remove(id) {
      jobs.get(id)?.stop()
      jobs.delete(id)
      tracked.delete(id)
      lastDispatched.delete(id)
    },
    checkCatchUp,
    stopAll,
    load(routines) {
      stopAll()
      for (const routine of routines) add(routine)
      if (catchUpEnabled && tracked.size > 0) checkCatchUp()
    },
    size: () => jobs.size,
  }
}
