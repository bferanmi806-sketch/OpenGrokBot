/**
 * 每个 bot 一条车道：同一时刻只跑一个回合。两个回合同时开同一台电脑的浏览器只会互相踩，
 * 而且先结束的那个会把「思考中」提前熄灭。状态灯由车道发：忙起来亮一次，排空了灭一次。
 */
export type TurnJob = (signal: AbortSignal) => Promise<void>
export type TurnState = 'thinking' | 'idle'

type Entry = {
  threadId: string
  job: TurnJob
  controller: AbortController
  resolve: () => void
  done: Promise<void>
  coalesceKey?: string
}
type Lane = { running: Entry | null; waiting: Entry[]; held: boolean }

export type TurnQueue = {
  /**
   * 排队执行；回合结束（或被停掉）时兑现。回合自己负责把错误变成线程里的消息。
   * 带 coalesceKey 时，若已有同 key 的回合还在排队（没开跑），就并进去：它开跑时会看到所有已落库的消息。
   */
  run(laneId: string, threadId: string, job: TurnJob, opts?: { coalesceKey?: string }): Promise<void>
  /** 停掉某个线程的工作：正在跑的收到 abort，排着队的直接丢弃。返回受影响的回合数。 */
  stopThread(threadId: string): number
  /** 网关退出时停掉全部正在跑和排着队的回合 */
  stopAll(): number
  /** Reserve an idle bot lane for browser recording. Returns null if work is already running or queued. */
  hold(laneId: string): (() => void) | null
  statuses(): Record<string, TurnState>
  /** 车道被占用（正在跑回合，或操作者正在录流程） */
  isBusy(laneId: string): boolean
  /** 指定线程是否正在跑回合或有排队中的回合 */
  isThreadBusy(threadId: string): boolean
  /** 同事自己正在跑回合（不含操作者录流程时的占位，免得侧栏误报「思考中」） */
  isWorking(laneId: string): boolean
}

export function createTurnQueue(onStatus: (laneId: string, state: TurnState) => void): TurnQueue {
  const lanes = new Map<string, Lane>()

  async function drain(laneId: string, lane: Lane): Promise<void> {
    if (lane.held || lanes.get(laneId) !== lane) return
    onStatus(laneId, 'thinking')
    while (lane.waiting.length > 0) {
      if (lane.held) return
      const entry = lane.waiting.shift()!
      lane.running = entry
      try {
        await entry.job(entry.controller.signal)
      } catch (err) {
        console.error(`[turns] ${laneId} turn failed:`, err)
      }
      lane.running = null
      entry.resolve()
    }
    if (!lane.held && lanes.get(laneId) === lane) {
      lanes.delete(laneId)
      onStatus(laneId, 'idle')
    }
  }

  return {
    run(laneId, threadId, job, opts = {}) {
      const lane = lanes.get(laneId)
      const twin = opts.coalesceKey ? lane?.waiting.find((e) => e.coalesceKey === opts.coalesceKey) : undefined
      if (twin) return twin.done
      let resolve!: () => void
      const done = new Promise<void>((r) => { resolve = r })
      const entry: Entry = { threadId, job, controller: new AbortController(), resolve, done, coalesceKey: opts.coalesceKey }
      if (lane) {
        lane.waiting.push(entry)
      } else {
        const fresh: Lane = { running: null, waiting: [entry], held: false }
        lanes.set(laneId, fresh)
        void drain(laneId, fresh)
      }
      return done
    },
    stopThread(threadId) {
      let stopped = 0
      for (const lane of lanes.values()) {
        if (lane.running?.threadId === threadId && !lane.running.controller.signal.aborted) {
          lane.running.controller.abort()
          stopped++
        }
        const keep: Entry[] = []
        for (const entry of lane.waiting) {
          if (entry.threadId === threadId) {
            entry.resolve()
            stopped++
          } else {
            keep.push(entry)
          }
        }
        lane.waiting = keep
      }
      return stopped
    },
    stopAll() {
      let stopped = 0
      for (const lane of lanes.values()) {
        if (lane.running && !lane.running.controller.signal.aborted) {
          lane.running.controller.abort()
          stopped++
        }
        for (const entry of lane.waiting.splice(0)) {
          entry.resolve()
          stopped++
        }
      }
      return stopped
    },
    hold(laneId) {
      if (lanes.has(laneId)) return null
      const lane: Lane = { running: null, waiting: [], held: true }
      lanes.set(laneId, lane)
      let released = false
      return () => {
        if (released) return
        released = true
        if (lanes.get(laneId) !== lane) return
        lane.held = false
        if (lane.waiting.length > 0) void drain(laneId, lane)
        else lanes.delete(laneId)
      }
    },
    statuses: () => Object.fromEntries(
      [...lanes.entries()].filter(([, lane]) => !lane.held).map(([id]) => [id, 'thinking' as const]),
    ),
    isBusy: (laneId) => lanes.has(laneId),
    isThreadBusy: (threadId) => {
      for (const lane of lanes.values()) {
        if (lane.running?.threadId === threadId) return true
        if (lane.waiting.some((e) => e.threadId === threadId)) return true
      }
      return false
    },
    isWorking: (laneId) => {
      const lane = lanes.get(laneId)
      return Boolean(lane && !lane.held)
    },
  }
}
