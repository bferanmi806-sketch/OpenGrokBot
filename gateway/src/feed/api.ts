import type { Hono } from 'hono'
import type { BotRow, Db } from '../db.js'
import type { Hub } from '../hub.js'
import { isValidCron } from '../routines.js'
import {
  countRecentCustomFeedItems,
  createFeedTopic,
  createIdea,
  deleteFeedItem,
  deleteFeedTopic,
  deleteIdea,
  deleteTodo,
  getFeedItem,
  getFeedTopic,
  getIdea,
  getTodo,
  isFeedItemId,
  isFeedTopicId,
  isIdeaId,
  isTodoId,
  listFeedItems,
  listFeedTopics,
  listIdeas,
  listNeedsYou,
  listTodos,
  markAllFeedRead,
  unreadFeedCount,
  updateFeedItemStatus,
  updateFeedTopic,
  updateIdea,
  updateTodo,
} from './store.js'
import {
  FEED_ITEM_KINDS,
  FEED_ITEM_STATUSES,
  IDEA_STATUSES,
  MAX_DAILY_CUSTOM_FEED_ITEMS,
  TODO_STATUSES,
  type FeedItemKind,
  type FeedItemRow,
  type FeedItemStatus,
  type FeedSnapshot,
  type FeedTopicRow,
  type IdeaRow,
  type IdeaStatus,
  type TodoStatus,
} from './types.js'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export type FeedApiDeps = {
  db: Db
  hub: Hub
  chiefId: string
  now?: () => number
  isTopicRunning?: (id: string) => boolean
  syncTopicSchedule?: (topic: FeedTopicRow | null, id?: string) => void
  runFeedTopic?: (topic: FeedTopicRow, opts?: { force?: boolean }) => Promise<'ran' | 'skipped' | 'gone'>
  distillRecentThreads?: () => Promise<{ ideasAdded: number; todosAdded: number; todosCompleted: number; goalsAdded: number; goalsUpdated: number }>
  startFollowup: (bot: BotRow, item: FeedItemRow, note?: string) => { threadId: string }
  startIncubation: (bot: BotRow, idea: IdeaRow) => { threadId: string }
  startDispatch: (bot: BotRow, idea: IdeaRow, instructions?: string) => { threadId: string }
}

export function mountFeed(app: Hono, deps: FeedApiDeps): { snapshot: () => FeedSnapshot } {
  const { db, hub, chiefId } = deps
  const now = deps.now ?? (() => Date.now())

  const botById = (id: string): BotRow | undefined =>
    db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined

  const defaultBot = (): BotRow | undefined =>
    botById(chiefId) ?? (db.prepare('SELECT * FROM bots ORDER BY created_at ASC, id ASC LIMIT 1').get() as BotRow | undefined)

  const defaultFeedBot = (): BotRow | undefined =>
    botById('researcher')
    ?? botById('scout')
    ?? botById('market-watch')
    ?? defaultBot()

  const snapshot = (opts?: { status?: FeedItemStatus | 'active'; kind?: FeedItemKind; botId?: string; topicId?: string; includeArchivedIdeas?: boolean }): FeedSnapshot => ({
    needsYou: listNeedsYou(db),
    items: listFeedItems(db, {
      status: opts?.status ?? 'active',
      ...(opts?.kind ? { kind: opts.kind } : {}),
      ...(opts?.botId ? { botId: opts.botId } : {}),
      ...(opts?.topicId ? { topicId: opts.topicId } : {}),
    }),
    ideas: listIdeas(db, { includeArchived: opts?.includeArchivedIdeas === true }),
    todos: listTodos(db),
    topics: listFeedTopics(db, deps.isTopicRunning),
    unreadCount: unreadFeedCount(db),
    dailyCustomCount: countRecentCustomFeedItems(db, now() - 24 * 60 * 60_000),
    dailyCustomCap: MAX_DAILY_CUSTOM_FEED_ITEMS,
  })

  app.get('/api/feed', (c) => {
    const statusRaw = c.req.query('status')
    const kindRaw = c.req.query('kind')
    const botId = c.req.query('botId') || undefined
    const topicIdRaw = c.req.query('topicId')
    const topicId = topicIdRaw && isFeedTopicId(topicIdRaw) ? topicIdRaw : undefined
    const status: FeedItemStatus | 'active' =
      statusRaw === 'unread' || statusRaw === 'read' || statusRaw === 'archived' || statusRaw === 'active'
        ? statusRaw
        : 'active'
    const kind = (FEED_ITEM_KINDS as readonly string[]).includes(kindRaw ?? '') ? (kindRaw as FeedItemKind) : undefined
    const includeArchivedIdeas = c.req.query('archivedIdeas') === '1'
    return c.json(snapshot({ status, kind, botId, topicId, includeArchivedIdeas }))
  })

  app.post('/api/feed/read-all', (c) => {
    const changed = markAllFeedRead(db, now())
    if (changed > 0) hub.broadcast({ type: 'feed_changed' })
    return c.json({ ok: true, updated: changed, snapshot: snapshot() })
  })

  app.patch('/api/feed/:id', async (c) => {
    const id = c.req.param('id')
    if (!isFeedItemId(id)) return c.json({ error: 'invalid feed item id' }, 400)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body) || typeof body.status !== 'string' || !(FEED_ITEM_STATUSES as readonly string[]).includes(body.status)) {
      return c.json({ error: `status must be one of: ${FEED_ITEM_STATUSES.join(', ')}` }, 400)
    }
    const updated = updateFeedItemStatus(db, id, body.status as FeedItemStatus, now())
    if (!updated) return c.json({ error: 'unknown feed item' }, 404)
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ item: updated, snapshot: snapshot() })
  })

  app.delete('/api/feed/:id', (c) => {
    const id = c.req.param('id')
    if (!isFeedItemId(id)) return c.json({ error: 'invalid feed item id' }, 400)
    if (!deleteFeedItem(db, id)) return c.json({ error: 'unknown feed item' }, 404)
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ ok: true, snapshot: snapshot() })
  })

  app.post('/api/feed/:id/followup', async (c) => {
    const id = c.req.param('id')
    if (!isFeedItemId(id)) return c.json({ error: 'invalid feed item id' }, 400)
    const item = getFeedItem(db, id)
    if (!item) return c.json({ error: 'unknown feed item' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null
    const requestedBotId = isObject(body) && typeof body.botId === 'string' && body.botId.trim()
      ? body.botId.trim()
      : (item.body.suggestedBotId || item.botId)
    const bot = botById(requestedBotId) ?? defaultBot()
    if (!bot) return c.json({ error: 'no teammate available' }, 404)
    const note = isObject(body) && typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : ''

    if (item.status === 'unread') updateFeedItemStatus(db, id, 'read', now())
    const { threadId } = deps.startFollowup(bot, item, note || undefined)
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ ok: true, botId: bot.id, threadId, snapshot: snapshot() }, 202)
  })

  app.post('/api/feed/:id/idea', (c) => {
    const id = c.req.param('id')
    if (!isFeedItemId(id)) return c.json({ error: 'invalid feed item id' }, 400)
    const item = getFeedItem(db, id)
    if (!item) return c.json({ error: 'unknown feed item' }, 404)

    const notesParts = [
      item.summary,
      item.body.suggestedAction ? `Suggested next step: ${item.body.suggestedAction}` : '',
    ].filter(Boolean)
    const idea = createIdea(db, {
      title: item.title,
      notes: notesParts.join('\n\n'),
      origin: 'proposal',
      sourceFeedId: item.id,
      // 严禁洗白：来源若含外部数据，转入灵感箱继续保留 tainted 标记
      tainted: item.tainted,
      assignedBotId: item.body.suggestedBotId && botById(item.body.suggestedBotId) ? item.body.suggestedBotId : item.botId,
      now: now(),
    })
    if (item.status === 'unread') updateFeedItemStatus(db, id, 'read', now())
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ idea, snapshot: snapshot() }, 201)
  })

  app.post('/api/ideas', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title || title.length > 140) return c.json({ error: 'title must be 1 to 140 characters' }, 400)
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : ''
    const assignedBotId = typeof body.assignedBotId === 'string' && body.assignedBotId.trim()
      ? (botById(body.assignedBotId.trim()) ? body.assignedBotId.trim() : null)
      : null
    const idea = createIdea(db, { title, notes, origin: 'operator', assignedBotId, now: now() })
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ idea, snapshot: snapshot() }, 201)
  })

  app.patch('/api/ideas/:id', async (c) => {
    const id = c.req.param('id')
    if (!isIdeaId(id)) return c.json({ error: 'invalid idea id' }, 400)
    const existing = getIdea(db, id)
    if (!existing) return c.json({ error: 'unknown idea' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)

    const patch: Parameters<typeof updateIdea>[2] = { now: now() }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 140) {
        return c.json({ error: 'title must be 1 to 140 characters' }, 400)
      }
      patch.title = body.title.trim()
    }
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string') return c.json({ error: 'notes must be a string' }, 400)
      patch.notes = body.notes
    }
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !(IDEA_STATUSES as readonly string[]).includes(body.status)) {
        return c.json({ error: `status must be one of: ${IDEA_STATUSES.join(', ')}` }, 400)
      }
      patch.status = body.status as IdeaStatus
    }
    if (body.assignedBotId !== undefined) {
      if (body.assignedBotId === null || body.assignedBotId === '') {
        patch.assignedBotId = null
      } else if (typeof body.assignedBotId === 'string' && botById(body.assignedBotId.trim())) {
        patch.assignedBotId = body.assignedBotId.trim()
      } else {
        return c.json({ error: 'unknown teammate' }, 400)
      }
    }

    const updated = updateIdea(db, id, patch)!
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ idea: updated, snapshot: snapshot() })
  })

  app.delete('/api/ideas/:id', (c) => {
    const id = c.req.param('id')
    if (!isIdeaId(id)) return c.json({ error: 'invalid idea id' }, 400)
    if (!deleteIdea(db, id)) return c.json({ error: 'unknown idea' }, 404)
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ ok: true, snapshot: snapshot() })
  })

  app.post('/api/ideas/:id/incubate', async (c) => {
    const id = c.req.param('id')
    if (!isIdeaId(id)) return c.json({ error: 'invalid idea id' }, 400)
    const idea = getIdea(db, id)
    if (!idea) return c.json({ error: 'unknown idea' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null
    const requestedBotId = isObject(body) && typeof body.botId === 'string' && body.botId.trim()
      ? body.botId.trim()
      : (idea.assignedBotId ?? chiefId)
    const bot = botById(requestedBotId) ?? defaultBot()
    if (!bot) return c.json({ error: 'no teammate available' }, 404)

    const { threadId } = deps.startIncubation(bot, idea)
    const updated = updateIdea(db, id, {
      status: 'incubating',
      assignedBotId: bot.id,
      incubationThreadId: threadId,
      now: now(),
    })!
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ idea: updated, botId: bot.id, threadId, snapshot: snapshot() }, 202)
  })

  app.post('/api/ideas/:id/dispatch', async (c) => {
    const id = c.req.param('id')
    if (!isIdeaId(id)) return c.json({ error: 'invalid idea id' }, 400)
    const idea = getIdea(db, id)
    if (!idea) return c.json({ error: 'unknown idea' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null
    const requestedBotId = isObject(body) && typeof body.botId === 'string' && body.botId.trim()
      ? body.botId.trim()
      : (idea.assignedBotId ?? chiefId)
    const bot = botById(requestedBotId) ?? defaultBot()
    if (!bot) return c.json({ error: 'no teammate available' }, 404)
    const instructions = isObject(body) && typeof body.instructions === 'string'
      ? body.instructions.trim().slice(0, 1000)
      : ''

    const { threadId } = deps.startDispatch(bot, idea, instructions || undefined)
    const updated = updateIdea(db, id, {
      status: 'promoted',
      assignedBotId: bot.id,
      incubationThreadId: threadId,
      now: now(),
    })!
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ idea: updated, botId: bot.id, threadId, snapshot: snapshot() }, 202)
  })

  app.post('/api/feed/topics', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt || prompt.length > 1500) return c.json({ error: 'prompt must be 1 to 1500 characters' }, 400)
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
    const title = (rawTitle || prompt.split(/\r?\n/)[0]!.slice(0, 40)).trim().slice(0, 80)
    if (!title) return c.json({ error: 'title is required' }, 400)

    const cron = typeof body.cron === 'string' ? body.cron.trim() : ''
    if (cron && !isValidCron(cron)) {
      return c.json({ error: 'cron must be empty (continuous) or a valid 5-field cron expression' }, 400)
    }

    const requestedBotId = typeof body.botId === 'string' && body.botId.trim() ? body.botId.trim() : ''
    const bot = requestedBotId ? botById(requestedBotId) : defaultFeedBot()
    if (!bot) return c.json({ error: requestedBotId ? 'unknown teammate' : 'no teammate available' }, requestedBotId ? 400 : 404)

    const enabled = body.enabled !== false
    const topic = createFeedTopic(db, { title, prompt, botId: bot.id, cron, enabled, now: now() }, deps.isTopicRunning)
    deps.syncTopicSchedule?.(topic)

    let running = false
    if (body.runNow === true && deps.runFeedTopic) {
      running = true
      void deps.runFeedTopic(topic, { force: true }).catch(() => {})
    }
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ topic: getFeedTopic(db, topic.id, deps.isTopicRunning) ?? topic, running, snapshot: snapshot() }, 201)
  })

  app.patch('/api/feed/topics/:id', async (c) => {
    const id = c.req.param('id')
    if (!isFeedTopicId(id)) return c.json({ error: 'invalid feed topic id' }, 400)
    const existing = getFeedTopic(db, id, deps.isTopicRunning)
    if (!existing) return c.json({ error: 'unknown feed topic' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)

    const patch: Parameters<typeof updateFeedTopic>[2] = { now: now() }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 80) {
        return c.json({ error: 'title must be 1 to 80 characters' }, 400)
      }
      patch.title = body.title.trim()
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.trim().length > 1500) {
        return c.json({ error: 'prompt must be 1 to 1500 characters' }, 400)
      }
      patch.prompt = body.prompt.trim()
    }
    if (body.cron !== undefined) {
      if (typeof body.cron !== 'string') return c.json({ error: 'cron must be a string' }, 400)
      const cron = body.cron.trim()
      if (cron && !isValidCron(cron)) {
        return c.json({ error: 'cron must be empty (manual) or a valid 5-field cron expression' }, 400)
      }
      patch.cron = cron
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400)
      patch.enabled = body.enabled
    }
    if (body.botId !== undefined) {
      if (typeof body.botId !== 'string' || !botById(body.botId.trim())) {
        return c.json({ error: 'unknown teammate' }, 400)
      }
      patch.botId = body.botId.trim()
    }

    const updated = updateFeedTopic(db, id, patch, deps.isTopicRunning)!
    deps.syncTopicSchedule?.(updated)
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ topic: updated, snapshot: snapshot() })
  })

  app.delete('/api/feed/topics/:id', (c) => {
    const id = c.req.param('id')
    if (!isFeedTopicId(id)) return c.json({ error: 'invalid feed topic id' }, 400)
    if (!deleteFeedTopic(db, id)) return c.json({ error: 'unknown feed topic' }, 404)
    deps.syncTopicSchedule?.(null, id)
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ ok: true, snapshot: snapshot() })
  })

  app.post('/api/feed/topics/run-all', (c) => {
    const enabled = listFeedTopics(db, deps.isTopicRunning).filter((t) => t.enabled)
    const started: string[] = []
    if (deps.runFeedTopic) {
      for (const topic of enabled) {
        if (!deps.isTopicRunning?.(topic.id)) {
          started.push(topic.id)
          void deps.runFeedTopic(topic, { force: true }).catch(() => {})
        }
      }
    }
    return c.json({ ok: true, started, snapshot: snapshot() }, 202)
  })

  app.post('/api/feed/topics/:id/run', (c) => {
    const id = c.req.param('id')
    if (!isFeedTopicId(id)) return c.json({ error: 'invalid feed topic id' }, 400)
    const topic = getFeedTopic(db, id, deps.isTopicRunning)
    if (!topic) return c.json({ error: 'unknown feed topic' }, 404)
    let started = false
    if (deps.runFeedTopic && !deps.isTopicRunning?.(topic.id)) {
      started = true
      void deps.runFeedTopic(topic, { force: true }).catch(() => {})
    }
    return c.json({ ok: true, started, topic: getFeedTopic(db, id, deps.isTopicRunning) ?? topic, snapshot: snapshot() }, 202)
  })

  app.patch('/api/todos/:id', async (c) => {
    const id = c.req.param('id')
    if (!isTodoId(id)) return c.json({ error: 'invalid todo id' }, 400)
    const existing = getTodo(db, id)
    if (!existing) return c.json({ error: 'unknown todo' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!isObject(body)) return c.json({ error: 'JSON object body required' }, 400)

    const patch: Parameters<typeof updateTodo>[2] = { now: now() }
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !(TODO_STATUSES as readonly string[]).includes(body.status)) {
        return c.json({ error: `status must be one of: ${TODO_STATUSES.join(', ')}` }, 400)
      }
      patch.status = body.status as TodoStatus
    }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 140) {
        return c.json({ error: 'title must be 1 to 140 characters' }, 400)
      }
      patch.title = body.title.trim()
    }
    if (body.detail !== undefined) {
      if (typeof body.detail !== 'string') return c.json({ error: 'detail must be a string' }, 400)
      patch.detail = body.detail
    }
    const updated = updateTodo(db, id, patch)!
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ todo: updated, snapshot: snapshot() })
  })

  app.delete('/api/todos/:id', (c) => {
    const id = c.req.param('id')
    if (!isTodoId(id)) return c.json({ error: 'invalid todo id' }, 400)
    if (!deleteTodo(db, id)) return c.json({ error: 'unknown todo' }, 404)
    hub.broadcast({ type: 'feed_changed' })
    return c.json({ ok: true, snapshot: snapshot() })
  })

  app.post('/api/feed/distill', async (c) => {
    const summary = deps.distillRecentThreads
      ? await deps.distillRecentThreads()
      : { ideasAdded: 0, todosAdded: 0, todosCompleted: 0, goalsAdded: 0, goalsUpdated: 0 }
    return c.json({ ok: true, ...summary, snapshot: snapshot() })
  })

  return { snapshot }
}
