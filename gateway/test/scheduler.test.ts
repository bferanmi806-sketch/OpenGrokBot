import { describe, expect, it, vi } from 'vitest'
import type { RoutineRow } from '../src/routines.js'
import { createScheduler, dueCatchUpAt } from '../src/scheduler.js'

function routine(id: number, cron = '0 9 * * *'): RoutineRow {
  return {
    id, bot_id: 'market-watch', name: `R${id}`, cron, instructions: 'do it', enabled: 1, created_at: 1, last_run_at: null,
    webhook_key: null, mode: 'act',
  }
}

/** 假 cron：不看时间，暴露一个手动触发的 tick。 */
function fakeCronFactory() {
  const jobs: { expr: string; tick: () => void; stopped: boolean }[] = []
  const makeCron = (expr: string, onTick: () => void) => {
    const job = { expr, tick: onTick, stopped: false }
    jobs.push(job)
    return { stop() { job.stopped = true } }
  }
  return { jobs, makeCron }
}

describe('createScheduler', () => {
  it('registers one job per routine and fires the callback with the routine', () => {
    const fired: number[] = []
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: (r) => { fired.push(r.id) }, makeCron })
    scheduler.load([routine(1), routine(2)])
    expect(scheduler.size()).toBe(2)
    expect(jobs.map((j) => j.expr)).toEqual(['0 9 * * *', '0 9 * * *'])
    jobs[1]!.tick()
    expect(fired).toEqual([2])
  })

  it('load replaces the previous set, stopping the old jobs', () => {
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => {}, makeCron })
    scheduler.load([routine(1)])
    scheduler.load([routine(2)])
    expect(jobs[0]!.stopped).toBe(true)
    expect(scheduler.size()).toBe(1)
  })

  it('adding the same routine id twice keeps only the newest job', () => {
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => {}, makeCron })
    scheduler.add(routine(1, '0 9 * * *'))
    scheduler.add(routine(1, '0 17 * * *'))
    expect(jobs[0]!.stopped).toBe(true)
    expect(scheduler.size()).toBe(1)
  })

  it('skips disabled routines and invalid expressions instead of throwing', () => {
    const { makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => {}, makeCron })
    scheduler.load([{ ...routine(1), enabled: 0 }, { ...routine(2), cron: 'every morning' }])
    expect(scheduler.size()).toBe(0)
  })

  it('a throwing run callback does not kill the job', () => {
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => { throw new Error('boom') }, makeCron })
    scheduler.load([routine(1)])
    expect(() => jobs[0]!.tick()).not.toThrow()
  })

  it('stopAll stops everything', () => {
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => {}, makeCron })
    scheduler.load([routine(1), routine(2)])
    scheduler.stopAll()
    expect(jobs.every((j) => j.stopped)).toBe(true)
    expect(scheduler.size()).toBe(0)
  })
})

describe('remove', () => {
  it('stops and forgets one routine, leaving the rest', () => {
    const { makeCron, jobs } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => {}, makeCron })
    scheduler.load([routine(1), routine(2)])
    scheduler.remove(1)
    expect(scheduler.size()).toBe(1)
    expect(jobs.map((j) => j.stopped)).toEqual([true, false])
  })
})

describe('latest-only catch-up and delivery floor', () => {
  it('computes only the latest missed occurrence within the catch-up window', () => {
    // Routine runs every hour on the hour (UTC); last ran at 08:00, now is 11:25 -> latest missed is 11:00
    const r: RoutineRow = {
      ...routine(1, '0 * * * *'),
      created_at: Date.parse('2026-09-27T07:00:00Z'),
      last_run_at: Date.parse('2026-09-27T08:00:00Z'),
    }
    const due = dueCatchUpAt(r, Date.parse('2026-09-27T11:25:00Z'), { timeZone: 'UTC' })
    expect(due).toBe(Date.parse('2026-09-27T11:00:00Z'))

    // Already ran at 11:00:05 -> nothing due at 11:25
    const fresh = { ...r, last_run_at: Date.parse('2026-09-27T11:00:05Z') }
    expect(dueCatchUpAt(fresh, Date.parse('2026-09-27T11:25:00Z'), { timeZone: 'UTC' })).toBeNull()

    // Weekly Monday 09:00 missed by 49 hours (> 24h default window) -> skipped as stale
    const weekly: RoutineRow = {
      ...routine(2, '0 9 * * 1'),
      created_at: Date.parse('2026-09-20T00:00:00Z'),
      last_run_at: Date.parse('2026-09-21T09:00:00Z'), // Mon Sep 21
    }
    // Missed Mon Sep 28 09:00; waking Wed Sep 30 10:00 (> 24h past)
    expect(dueCatchUpAt(weekly, Date.parse('2026-09-30T10:00:00Z'), { timeZone: 'UTC' })).toBeNull()
  })

  it('fires at most one catch-up on load when catchUp:true and enforces minimum delivery interval', () => {
    const fired: number[] = []
    let clock = Date.parse('2026-09-27T11:25:00Z')
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({
      run: (r) => { fired.push(r.id) },
      makeCron,
      timeZone: 'UTC',
      catchUp: true,
      minIntervalMs: 60_000,
      wakeCheckIntervalMs: 0,
      now: () => clock,
    })
    const missed: RoutineRow = {
      ...routine(1, '0 * * * *'),
      created_at: Date.parse('2026-09-27T07:00:00Z'),
      last_run_at: Date.parse('2026-09-27T08:00:00Z'),
    }
    scheduler.load([missed])
    expect(fired).toEqual([1])

    // Immediate cron tick 10s later is suppressed by the 60s delivery floor
    clock += 10_000
    jobs[0]!.tick()
    expect(fired).toEqual([1])

    // Once 60s elapse, normal ticks resume
    clock += 60_000
    jobs[0]!.tick()
    expect(fired).toEqual([1, 1])
    scheduler.stopAll()
  })

  it('triggers latest-only catch-up when wall clock jumps forward after laptop sleep', () => {
    vi.useFakeTimers()
    try {
      const fired: number[] = []
      let wallNow = Date.parse('2026-09-27T08:30:00Z')
      const { makeCron } = fakeCronFactory()
      const scheduler = createScheduler({
        run: (r) => { fired.push(r.id) },
        makeCron,
        timeZone: 'UTC',
        catchUp: true,
        wakeCheckIntervalMs: 30_000,
        now: () => wallNow,
      })
      scheduler.load([{
        ...routine(7, '0 9 * * *'),
        created_at: Date.parse('2026-09-26T08:00:00Z'),
        last_run_at: Date.parse('2026-09-26T09:00:00Z'),
      }])
      expect(fired).toEqual([])

      // Laptop sleeps across 09:00 and wakes at 10:15 (wall clock jumped +1h45m)
      wallNow = Date.parse('2026-09-27T10:15:00Z')
      vi.advanceTimersByTime(30_000)
      expect(fired).toEqual([7])

      // Subsequent normal heartbeat does not re-fire
      wallNow += 30_000
      vi.advanceTimersByTime(30_000)
      expect(fired).toEqual([7])

      scheduler.stopAll()
    } finally {
      vi.useRealTimers()
    }
  })
})
