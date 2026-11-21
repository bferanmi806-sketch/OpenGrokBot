/**
 * Per-bot browser session lease mutex.
 *
 * A teammate has a single persistent Chromium browser session. Foreground chats,
 * workflow recordings/replays, and background tasks may all need the browser, so
 * any browser tool call lazily acquires this per-bot lease for the duration of
 * that turn/task/recording. Non-browser tools never touch the lease and run
 * freely in parallel.
 */

export const BROWSER_LEASE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'browser_goto',
  'browser_extract',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_back',
  'browser_screenshot',
  'ask_for_login',
])

export type BrowserLeaseHolder =
  | { kind: 'foreground'; token: string; label: string }
  | { kind: 'background'; taskId: string; title: string }

export type BrowserLeaseAcquireResult =
  | { ok: true; newlyAcquired: boolean }
  | { ok: false; holder: BrowserLeaseHolder }

export type BrowserLeasePool = {
  acquire(botId: string, holder: BrowserLeaseHolder): BrowserLeaseAcquireResult
  release(botId: string, holder: BrowserLeaseHolder): boolean
  holder(botId: string): BrowserLeaseHolder | null
  isHeldByBackground(botId: string): boolean
}

function sameHolder(a: BrowserLeaseHolder, b: BrowserLeaseHolder): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'foreground' && b.kind === 'foreground') return a.token === b.token
  if (a.kind === 'background' && b.kind === 'background') return a.taskId === b.taskId
  return false
}

export function createBrowserLeasePool(): BrowserLeasePool {
  const leases = new Map<string, BrowserLeaseHolder>()

  return {
    acquire(botId, holder) {
      const existing = leases.get(botId)
      if (!existing) {
        leases.set(botId, { ...holder })
        return { ok: true, newlyAcquired: true }
      }
      if (sameHolder(existing, holder)) {
        return { ok: true, newlyAcquired: false }
      }
      return { ok: false, holder: { ...existing } }
    },

    release(botId, holder) {
      const existing = leases.get(botId)
      if (!existing || !sameHolder(existing, holder)) return false
      leases.delete(botId)
      return true
    },

    holder(botId) {
      const existing = leases.get(botId)
      return existing ? { ...existing } : null
    },

    isHeldByBackground(botId) {
      return leases.get(botId)?.kind === 'background'
    },
  }
}

export function formatBrowserConflict(
  requester: 'foreground' | 'background',
  holder: BrowserLeaseHolder,
): string {
  if (requester === 'foreground' && holder.kind === 'background') {
    return (
      `Your browser is currently in use by background task ${holder.taskId} ("${holder.title}"). `
      + 'You can keep chatting, use non-browser tools, wait for it to finish, or cancel it with cancel_background_task.'
    )
  }
  if (requester === 'background' && holder.kind === 'foreground') {
    return (
      `Your browser is currently in use by ${holder.label}. `
      + 'Continue with non-browser work or wait until it finishes.'
    )
  }
  if (holder.kind === 'background') {
    return `Your browser is currently in use by background task ${holder.taskId} ("${holder.title}"). Wait until it finishes before using the browser.`
  }
  return `Your browser is currently in use by ${holder.label}. Wait until it finishes before using the browser.`
}
