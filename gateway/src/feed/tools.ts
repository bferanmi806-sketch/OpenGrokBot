import type { RuleBlock } from '../agent.js'
import type { Db, MessageRow } from '../db.js'
import type { Hub } from '../hub.js'
import type { ToolDef } from '../llm.js'
import type { ReportPayload } from '../report.js'
import { createFeedItem, isDuplicateCustomFeedCard } from './store.js'
import { FEED_ITEM_KINDS, type FeedItemKind, type FeedItemRow, type FeedSourceLink } from './types.js'

export const PUBLISH_FEED_TOOL_NAME = 'publish_feed'
export const MAX_FEED_ITEMS_PER_TURN = 3

export const PUBLISH_FEED_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: PUBLISH_FEED_TOOL_NAME,
    description:
      'Post a concise card to your operator\'s Today Feed (briefings, watch signals, or low-frequency proposals). '
      + 'Use it for cross-teammate updates and curated web digests worth surfacing on the dashboard, not ordinary chat replies. '
      + 'Proposals are read-only suggestions that your operator must explicitly approve or dispatch — never assume they run automatically.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...FEED_ITEM_KINDS],
          description: '"briefing" for scheduled summaries or curated web digests, "signal" for watch alerts, "proposal" for an optional suggested follow-up.',
        },
        title: {
          type: 'string',
          description: 'One concise headline (up to 120 characters).',
        },
        summary: {
          type: 'string',
          description: '2-4 short plain sentences summarizing the finding or recommendation (up to 1200 characters).',
        },
        tags: {
          type: 'array',
          maxItems: 5,
          items: { type: 'string' },
          description: 'Optional up to 5 short topic tags.',
        },
        sources: {
          type: 'array',
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short source title or site name.' },
              url: { type: 'string', description: 'Public http:// or https:// URL you actually fetched.' },
            },
            required: ['url'],
          },
          description: 'Optional up to 5 real http/https source links backing this card.',
        },
        suggested_action: {
          type: 'string',
          description: 'Optional next step (mainly for "proposal" cards, up to 300 characters).',
        },
        suggested_bot_id: {
          type: 'string',
          description: 'Optional teammate id best suited to follow up.',
        },
      },
      required: ['kind', 'title', 'summary'],
    },
  },
}

function sanitizeSources(raw: unknown): FeedSourceLink[] {
  if (!Array.isArray(raw)) return []
  const out: FeedSourceLink[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const urlRaw = typeof rec.url === 'string' ? rec.url.trim() : ''
    if (!urlRaw) continue
    let parsed: URL
    try {
      parsed = new URL(urlRaw)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    const cleanUrl = parsed.toString()
    if (seen.has(cleanUrl)) continue
    seen.add(cleanUrl)
    const rawTitle = typeof rec.title === 'string' ? rec.title.trim() : ''
    const title = (rawTitle || parsed.hostname.replace(/^www\./, '')).slice(0, 80)
    out.push({ title, url: cleanUrl })
    if (out.length >= 5) break
  }
  return out
}

export function runPublishFeedCall(input: {
  db: Db
  hub: Hub
  botId: string
  threadId: string
  args: Record<string, unknown>
  ruleBlock: RuleBlock | null
  sourceLabel: string
  topicId?: string | null
  now: number
}): { ok: boolean; text: string; item?: FeedItemRow } {
  const kindRaw = String(input.args.kind ?? '').trim().toLowerCase()
  if (!(FEED_ITEM_KINDS as readonly string[]).includes(kindRaw)) {
    return { ok: false, text: `publish_feed requires kind to be one of: ${FEED_ITEM_KINDS.join(', ')}.` }
  }
  const title = String(input.args.title ?? '').trim()
  const summary = String(input.args.summary ?? '').trim()
  if (!title || !summary) {
    return { ok: false, text: 'publish_feed requires non-empty "title" and "summary".' }
  }
  const rawTags = Array.isArray(input.args.tags) ? input.args.tags.map((t) => String(t ?? '').trim()).filter(Boolean) : []
  const sources = sanitizeSources(input.args.sources)
  const suggestedAction = typeof input.args.suggested_action === 'string'
    ? input.args.suggested_action.trim().slice(0, 300)
    : ''
  const suggestedBotId = typeof input.args.suggested_bot_id === 'string'
    ? input.args.suggested_bot_id.trim().slice(0, 64)
    : ''

  // 自定义联网动态自动去重：近 7 天内已抓过的同标题或同原文链接不再重复发卡
  if (input.sourceLabel === 'custom-feed') {
    const sevenDaysAgo = input.now - 7 * 24 * 60 * 60_000
    if (isDuplicateCustomFeedCard(input.db, { title, sources, sinceMs: sevenDaysAgo })) {
      return { ok: true, text: `Skipped duplicate feed card "${title}" (already covered in recent Today Feed).` }
    }
  }

  // 安全门禁：非操作者直接触发或上下文已含外部数据时，强制标记 tainted=true，模型不可伪造
  const tainted = input.ruleBlock !== null
  const item = createFeedItem(input.db, {
    kind: kindRaw as FeedItemKind,
    botId: input.botId,
    threadId: input.threadId,
    topicId: input.topicId ?? null,
    title,
    summary,
    body: {
      ...(suggestedAction ? { suggestedAction } : {}),
      ...(suggestedBotId ? { suggestedBotId } : {}),
      ...(sources.length ? { sources } : {}),
    },
    tags: rawTags,
    tainted,
    sourceLabel: input.sourceLabel || (kindRaw === 'proposal' ? 'proposal' : 'briefing'),
    now: input.now,
  })
  input.hub.broadcast({ type: 'feed_changed' })
  return { ok: true, item, text: `Published ${item.kind} card "${item.title}" to Today Feed (${item.id}).` }
}

export function projectReportToFeed(input: {
  db: Db
  hub: Hub
  botId: string
  threadId: string
  message: MessageRow
  payload: ReportPayload
  watch: boolean
  routineName?: string
  ruleBlock: RuleBlock | null
  sourceLabel: string
  now: number
}): FeedItemRow {
  const first = input.payload.lines[0]
  const fallbackTitle = first
    ? `${first.system} → ${first.result}${first.count ? ` · ${first.count}` : ''}`
    : 'Status report'
  const title = input.routineName?.trim()
    ? `${input.routineName.trim()}${first ? ` · ${first.result}` : ''}`
    : fallbackTitle
  const summary = input.payload.closing?.trim()
    || input.payload.lines
      .map((l) => `${l.system}: ${l.result}${l.count ? ` (${l.count})` : ''}`)
      .join(' · ')
  const item = createFeedItem(input.db, {
    kind: input.watch ? 'signal' : 'briefing',
    botId: input.botId,
    threadId: input.threadId,
    sourceMessageId: input.message.id,
    title,
    summary,
    body: { report: input.payload },
    tainted: input.ruleBlock !== null,
    sourceLabel: input.sourceLabel,
    now: input.now,
  })
  input.hub.broadcast({ type: 'feed_changed' })
  return item
}
