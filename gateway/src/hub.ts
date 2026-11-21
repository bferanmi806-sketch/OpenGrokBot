import type { BackgroundTaskView } from './background-tasks.js'
import type { BrowserStatus } from './browsers.js'
import type { MessageRow } from './db.js'
import type { DispatchPlanView } from './dispatch-plans.js'

/**
 * 侧栏上每位同事的状态：在干活 / 在等你（审批、问题、登录） / 卡住了（出错、超额、步数用完） / 闲着。
 * 「刚干完」是界面自己记的：在你没看着的时候从 thinking 落回来。
 */
export type Presence = 'thinking' | 'waiting' | 'blocked' | 'idle'

export type GatewayEvent =
  | { type: 'message'; threadId: string; message: MessageRow }
  | { type: 'status'; botId: string; state: Presence }
  | { type: 'hello'; statuses: Record<string, Presence> }
  /** 本机模式的浏览器状态（下载进度）；向导里用 */
  | { type: 'setup.browser'; browser: BrowserStatus }
  | { type: 'connectors_changed' }
  | { type: 'mcp_changed' }
  | { type: 'vault_changed' }
  | { type: 'feed_changed' }
  | { type: 'goals_changed' }
  | { type: 'spaces_changed' }
  | { type: 'wiki_changed' }
  | { type: 'quiet_digest_changed' }
  | { type: 'background_task_changed'; botId: string; task: BackgroundTaskView }
  | { type: 'dispatch_plan_changed'; threadId: string; plan: DispatchPlanView }
  | { type: 'team_charter_changed'; threadId: string }

type WsLike = { send(data: string): void }

export type Hub = {
  add(ws: WsLike): void
  remove(ws: WsLike): void
  broadcast(event: GatewayEvent): void
  size(): number
}

export function createHub(): Hub {
  const clients = new Set<WsLike>()
  return {
    add: (ws) => clients.add(ws),
    remove: (ws) => clients.delete(ws),
    broadcast(event) {
      const data = JSON.stringify(event)
      for (const ws of clients) {
        try { ws.send(data) } catch { clients.delete(ws) }
      }
    },
    size: () => clients.size,
  }
}
