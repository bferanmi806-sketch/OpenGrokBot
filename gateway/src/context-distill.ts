import type { BotRow, Db, MessageRow } from './db.js'
import {
  createIdea,
  createTodo,
  listIdeas,
  listTodos,
  normalizeDedupeText,
  updateTodo,
} from './feed/store.js'
import {
  addGoalUpdate,
  createGoal,
  listGoals,
  listMilestones,
  updateMilestone,
} from './goals/store.js'
import type { Hub } from './hub.js'
import type { LLM } from './llm.js'

export type DistillResult = {
  ideasAdded: number
  todosAdded: number
  todosCompleted: number
  goalsAdded: number
  goalsUpdated: number
}

const EMPTY_RESULT: DistillResult = {
  ideasAdded: 0,
  todosAdded: 0,
  todosCompleted: 0,
  goalsAdded: 0,
  goalsUpdated: 0,
}

const MAX_CONTEXT_MESSAGES = 12
const MAX_MESSAGE_CHARS = 500
const MAX_TOTAL_CONTEXT_CHARS = 4200
const MAX_IDEAS_PER_PASS = 2
const MAX_TODOS_PER_PASS = 3
const MAX_GOALS_PER_PASS = 1

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fenced ? fenced[1]!.trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function formatMessageForDistill(m: MessageRow, botNames: Record<string, string>): string | null {
  if (m.kind === 'text') {
    const text = m.content.trim()
    if (!text) return null
    const speaker = m.sender === 'user' ? 'User' : (botNames[m.sender] ?? m.sender)
    return `${speaker}: ${text.slice(0, MAX_MESSAGE_CHARS)}`
  }
  if (m.kind === 'report' && isRecord(m.payload)) {
    const lines = Array.isArray(m.payload.lines)
      ? m.payload.lines
        .map((l) => (isRecord(l) ? `${String(l.system ?? '')}: ${String(l.result ?? '')}` : ''))
        .filter(Boolean)
        .join('; ')
      : ''
    const closing = typeof m.payload.closing === 'string' ? m.payload.closing : ''
    const summary = [lines, closing].filter(Boolean).join(' — ').slice(0, MAX_MESSAGE_CHARS)
    if (!summary) return null
    const speaker = botNames[m.sender] ?? m.sender
    return `${speaker} [report]: ${summary}`
  }
  return null
}

function similarTitleExists(existingNorms: Set<string>, rawTitle: string): boolean {
  const norm = normalizeDedupeText(rawTitle)
  if (norm.length < 3) return true
  if (existingNorms.has(norm)) return true
  for (const prev of existingNorms) {
    if (prev.length >= 6 && norm.length >= 6 && (prev.includes(norm) || norm.includes(prev))) {
      return true
    }
  }
  return false
}

/**
 * 从对话上下文自动提炼「灵感（Ideas）」「待办（Todos）」与「目标（Goals / 里程碑进展）」：
 * - 只读分析对话文本，零工具调用，不阻断正常对话回复；
 * - 对已有条目自动去重，仅在确有新信号时落库；
 * - 若该轮对话接触过外部数据（tainted），提取条目一律保留 tainted=true。
 */
export async function distillThreadContext(deps: {
  db: Db
  llm: LLM
  hub: Hub
  threadId: string
  defaultBotId: string
  tainted?: boolean
  now?: () => number
}): Promise<DistillResult> {
  const { db, llm, hub, threadId, defaultBotId } = deps
  const now = deps.now ?? (() => Date.now())

  const rawMessages = db
    .prepare(
      `SELECT * FROM messages
       WHERE thread_id = ? AND kind IN ('text', 'report')
       ORDER BY id DESC LIMIT ?`,
    )
    .all(threadId, MAX_CONTEXT_MESSAGES) as Array<Omit<MessageRow, 'payload'> & { payload: string | null }>

  if (rawMessages.length < 2) return EMPTY_RESULT

  const chronological: MessageRow[] = rawMessages
    .reverse()
    .map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }))

  const userMsgs = chronological.filter((m) => m.sender === 'user' && m.kind === 'text')
  const latestUser = userMsgs[userMsgs.length - 1]
  if (!latestUser || latestUser.content.trim().length < 8) return EMPTY_RESULT

  const bots = db.prepare('SELECT id, name FROM bots').all() as Array<Pick<BotRow, 'id' | 'name'>>
  const botSet = new Set(bots.map((b) => b.id))
  const botNames = Object.fromEntries(bots.map((b) => [b.id, b.name]))

  let transcript = ''
  for (const m of chronological) {
    const line = formatMessageForDistill(m, botNames)
    if (!line) continue
    if (transcript.length + line.length + 1 > MAX_TOTAL_CONTEXT_CHARS) break
    transcript += (transcript ? '\n' : '') + line
  }
  if (!transcript) return EMPTY_RESULT

  const existingIdeas = listIdeas(db, { limit: 30 })
  const existingTodos = listTodos(db, { limit: 30 })
  const existingGoals = listGoals(db, { status: 'active' }).slice(0, 15)

  const existingSummary = [
    existingIdeas.length
      ? `Existing Ideas:\n${existingIdeas.slice(0, 15).map((i) => `- ${i.title}`).join('\n')}`
      : 'Existing Ideas: (none)',
    existingTodos.length
      ? `Existing Open Todos:\n${existingTodos.filter((t) => t.status === 'open').slice(0, 15).map((t) => `- [${t.id}] ${t.title}`).join('\n')}`
      : 'Existing Open Todos: (none)',
    existingGoals.length
      ? `Existing Active Goals:\n${existingGoals.map((g) => {
        const openMs = listMilestones(db, g.id).filter((m) => m.status === 'open')
        const msStr = openMs.length ? ` | open milestones: ${openMs.map((m) => `${m.id}:${m.title}`).join('; ')}` : ''
        return `- [${g.id}] ${g.title}${msStr}`
      }).join('\n')}`
      : 'Existing Active Goals: (none)',
    `Available teammate IDs: ${bots.map((b) => `${b.id} (${b.name})`).join(', ')}`,
  ].join('\n\n')

  const systemPrompt = `You silently organize a user's workspace from their conversation context — like an attentive chief of staff.
Return ONLY a strict JSON object with these optional arrays (use empty arrays when nothing genuine applies):
{
  "ideas": [{ "title": "short idea title", "notes": "1-2 sentence context" }],
  "todos": [{ "title": "concrete short-term action item", "detail": "optional brief detail", "ownerBotId": "optional teammate id" }],
  "completeTodos": ["todo-xxxxxxxx"],
  "goals": [{ "title": "multi-step ongoing goal", "description": "brief background", "successCriteria": "what done looks like", "milestones": ["step 1", "step 2"], "ownerBotId": "optional teammate id" }],
  "goalUpdates": [{ "goalId": "goal-xxxxxxxx", "note": "concise progress update", "completeMilestones": ["ms-xxxxxxxx"] }]
}

Strict rules:
- Extract ONLY clear, genuine items explicitly supported by the conversation. Most casual chats should return empty arrays!
- Never duplicate anything already listed in Existing Ideas, Existing Open Todos, or Existing Active Goals.
- "ideas" = exploratory thoughts, future possibilities, experiments, research sparks, or product/content ideas mentioned in chat.
- "todos" = concrete near-term action items, follow-ups, deliverables, or things to track soon (not long-term goals).
- "goals" = bigger multi-step projects or ongoing objectives with clear outcomes; prefer "goalUpdates" if an existing goal already covers it.
- Match the language of the conversation (Chinese for Chinese chats, English for English chats).
- Output raw JSON only, no explanation.`

  let reply: string | null = null
  try {
    const res = await llm.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${existingSummary}\n\nRecent conversation:\n${transcript}` },
      ],
      [],
    )
    reply = res.content
  } catch {
    return EMPTY_RESULT
  }

  if (!reply) return EMPTY_RESULT
  const parsed = parseJsonLoose(reply)
  if (!parsed) return EMPTY_RESULT

  const at = now()
  const tainted = deps.tainted === true
  const result: DistillResult = { ...EMPTY_RESULT }

  const ideaNorms = new Set(existingIdeas.map((i) => normalizeDedupeText(i.title)).filter(Boolean))
  const todoNorms = new Set(existingTodos.filter((t) => t.status === 'open').map((t) => normalizeDedupeText(t.title)).filter(Boolean))
  const goalNorms = new Set(existingGoals.map((g) => normalizeDedupeText(g.title)).filter(Boolean))

  const pickBot = (raw: unknown): string => {
    const s = typeof raw === 'string' ? raw.trim() : ''
    return s && botSet.has(s) ? s : defaultBotId
  }

  if (Array.isArray(parsed.ideas)) {
    for (const raw of parsed.ideas.slice(0, MAX_IDEAS_PER_PASS)) {
      if (!isRecord(raw)) continue
      const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 140) : ''
      if (!title || similarTitleExists(ideaNorms, title)) continue
      const notes = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 1000) : ''
      createIdea(db, {
        title,
        notes,
        origin: 'conversation',
        sourceThreadId: threadId,
        assignedBotId: pickBot(raw.ownerBotId),
        tainted,
        now: at,
      })
      ideaNorms.add(normalizeDedupeText(title))
      result.ideasAdded += 1
    }
  }

  if (Array.isArray(parsed.todos)) {
    for (const raw of parsed.todos.slice(0, MAX_TODOS_PER_PASS)) {
      if (!isRecord(raw)) continue
      const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 140) : ''
      if (!title || similarTitleExists(todoNorms, title)) continue
      const detail = typeof raw.detail === 'string' ? raw.detail.trim().slice(0, 600) : ''
      createTodo(db, {
        title,
        detail,
        ownerBotId: pickBot(raw.ownerBotId),
        sourceThreadId: threadId,
        origin: 'auto',
        tainted,
        now: at,
      })
      todoNorms.add(normalizeDedupeText(title))
      result.todosAdded += 1
    }
  }

  if (Array.isArray(parsed.completeTodos)) {
    const openIds = new Set(existingTodos.filter((t) => t.status === 'open').map((t) => t.id))
    for (const rawId of parsed.completeTodos.slice(0, 5)) {
      const id = typeof rawId === 'string' ? rawId.trim() : ''
      if (!openIds.has(id)) continue
      if (updateTodo(db, id, { status: 'done', now: at })) {
        result.todosCompleted += 1
      }
    }
  }

  if (Array.isArray(parsed.goals)) {
    for (const raw of parsed.goals.slice(0, MAX_GOALS_PER_PASS)) {
      if (!isRecord(raw)) continue
      const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : ''
      if (!title || similarTitleExists(goalNorms, title)) continue
      const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, 1000) : ''
      const successCriteria = typeof raw.successCriteria === 'string' ? raw.successCriteria.trim().slice(0, 600) : ''
      const milestones = Array.isArray(raw.milestones)
        ? raw.milestones
          .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
          .slice(0, 6)
          .map((m) => ({ title: m.trim().slice(0, 140) }))
        : []
      createGoal(db, {
        title,
        description,
        successCriteria,
        ownerBotId: pickBot(raw.ownerBotId),
        sourceThreadId: threadId,
        origin: 'auto',
        tainted,
        milestones,
        authorKind: 'bot',
        authorBotId: defaultBotId,
        threadId,
        now: at,
      })
      goalNorms.add(normalizeDedupeText(title))
      result.goalsAdded += 1
    }
  }

  if (Array.isArray(parsed.goalUpdates)) {
    const activeGoalIds = new Set(existingGoals.map((g) => g.id))
    for (const raw of parsed.goalUpdates.slice(0, 3)) {
      if (!isRecord(raw)) continue
      const goalId = typeof raw.goalId === 'string' ? raw.goalId.trim() : ''
      if (!activeGoalIds.has(goalId)) continue
      const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 600) : ''
      let touched = false
      if (Array.isArray(raw.completeMilestones)) {
        const openMsIds = new Set(listMilestones(db, goalId).filter((m) => m.status === 'open').map((m) => m.id))
        for (const msRaw of raw.completeMilestones.slice(0, 5)) {
          const msId = typeof msRaw === 'string' ? msRaw.trim() : ''
          if (!openMsIds.has(msId)) continue
          const updated = updateMilestone(db, msId, { status: 'done', now: at })
          if (updated) {
            addGoalUpdate(db, {
              goalId,
              authorKind: 'bot',
              botId: defaultBotId,
              kind: 'milestone',
              summary: `Completed milestone: ${updated.title}`,
              diff: `✓ [x] ${updated.title}`,
              tainted,
              threadId,
              now: at,
            })
            touched = true
          }
        }
      }
      if (note) {
        addGoalUpdate(db, {
          goalId,
          authorKind: 'bot',
          botId: defaultBotId,
          kind: 'note',
          summary: note,
          tainted,
          threadId,
          now: at,
        })
        touched = true
      }
      if (touched) result.goalsUpdated += 1
    }
  }

  if (result.ideasAdded > 0 || result.todosAdded > 0 || result.todosCompleted > 0) {
    hub.broadcast({ type: 'feed_changed' })
  }
  if (result.goalsAdded > 0 || result.goalsUpdated > 0) {
    hub.broadcast({ type: 'goals_changed' })
  }

  return result
}
