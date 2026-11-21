import { describe, expect, it } from 'vitest'
import { listGoalActions } from '../src/actions.js'
import { createFakeComputer } from '../src/computer.js'
import { listMessages, openDb } from '../src/db.js'
import { createGoal } from '../src/goals/store.js'
import type { LLM, ToolCall } from '../src/llm.js'
import type { Pool } from '../src/pool.js'
import { MAX_SPACES_PROMPT_CHARS, spacesSection, type PromptSpace } from '../src/prompts.js'
import { createRoutine } from '../src/routines.js'
import { createApp } from '../src/server.js'
import { createSpace, listSpaceItems, upsertSpaceItem } from '../src/spaces/store.js'
import { buildTemplateSchema } from '../src/spaces/templates.js'

function scriptedLlm(steps: Array<{ content?: string; toolCalls?: ToolCall[] }>): {
  llm: LLM
  seenSystems: string[]
  seenTools: string[][]
  seenToolResults: string[]
} {
  let idx = 0
  const seenSystems: string[] = []
  const seenTools: string[][] = []
  const seenToolResults: string[] = []
  const llm: LLM = {
    async chat(messages, tools) {
      const sys = messages.find((m) => m.role === 'system')
      if (typeof sys?.content === 'string') seenSystems.push(sys.content)
      seenTools.push((tools ?? []).map((t) => t.function.name))
      for (const m of messages) {
        if (m.role === 'tool' && typeof m.content === 'string') seenToolResults.push(m.content)
      }
      const next = steps[idx++] ?? { content: 'Done.' }
      const toolCalls = next.toolCalls ?? []
      return {
        content: next.content ?? (toolCalls.length ? null : 'Done.'),
        toolCalls,
        raw: { role: 'assistant', content: next.content ?? null, ...(toolCalls.length ? { tool_calls: [] } : {}) },
      }
    },
  }
  return { llm, seenSystems, seenTools, seenToolResults }
}

function makePool(): Pool {
  const computer = createFakeComputer()
  return {
    async get() { return computer },
    peek() { return Promise.resolve(computer) },
    async disposeAll() {},
    lastUsed: () => undefined,
    async forget() {},
    async retire() {},
  }
}

function seedDb() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('chief', 'Chief', 'Chief of Staff', '🧠', '', 1)`).run()
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('scout', 'Scout', 'Research', '🔎', '', 2)`).run()
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('viewer', 'Viewer', 'Observer', '👀', '', 3)`).run()
  db.prepare(`INSERT INTO bots (id, name, role, emoji, soul_path, created_at) VALUES ('outsider', 'Outsider', 'Other', '🛠', '', 4)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:chief', 'dm', 'chief', 'Chief', 1)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:scout', 'dm', 'scout', 'Scout', 2)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:viewer', 'dm', 'viewer', 'Viewer', 3)`).run()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES ('dm:outsider', 'dm', 'outsider', 'Outsider', 4)`).run()
  return db
}

describe('spaces agent integration: zero-default isolation, role split, watch read-only, taint & budget', () => {
  it('enforces MAX_SPACES_PROMPT_CHARS budget on spacesSection', () => {
    const many: PromptSpace[] = Array.from({ length: 12 }, (_, i) => ({
      id: `space-0000000${i}`,
      slug: `long_space_slug_number_${i}`,
      title: `Comprehensive Competitor & Pricing Operations Space ${i}`,
      role: i % 2 === 0 ? 'editor' : 'viewer',
      blocks: ['kpi:metrics', 'records:table', 'board:kanban', 'checks:checklist', 'events:timeline', 'notes:markdown'],
      itemCount: i * 5,
    }))
    const section = spacesSection(many)
    expect(section.length).toBeLessThanOrEqual(MAX_SPACES_PROMPT_CHARS)
    expect(section).toContain('omitted for prompt budget')
  })

  it('enforces zero-default isolation for outsider and read-only enforcement for viewer', async () => {
    const db = seedDb()
    const space = createSpace(db, {
      title: 'Private Pricing Board',
      schema: buildTemplateSchema('tracker', 'chief'),
      grants: [
        { botId: 'scout', role: 'editor' },
        { botId: 'viewer', role: 'viewer' },
      ],
    })
    upsertSpaceItem(db, { spaceId: space.id, blockId: 'records', title: 'Alpha', updatedBy: 'operator' })

    // Outsider sees no space in prompt and cannot read/write
    const outRec = scriptedLlm([
      { toolCalls: [{ id: 'o1', name: 'space_read', args: { space_id: space.id } }] },
      { content: 'Blocked.' },
    ])
    const gwOut = createApp({ db, llm: outRec.llm, pool: makePool() })
    await gwOut.app.request('/api/threads/dm:outsider/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Read pricing board' }),
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(outRec.seenSystems[0]).not.toContain('Private Pricing Board')
    expect(outRec.seenTools[0]).not.toContain('space_read')
    expect(outRec.seenToolResults[0]).toContain('do not have access')

    // Viewer gets space_read, NOT space_upsert_item, and direct write is refused
    const viewRec = scriptedLlm([
      {
        toolCalls: [
          { id: 'v1', name: 'space_read', args: { space_id: space.id } },
          { id: 'v2', name: 'space_upsert_item', args: { space_id: space.id, block_id: 'records', title: 'Sneak' } },
        ],
      },
      { content: 'Read only.' },
    ])
    const gwView = createApp({ db, llm: viewRec.llm, pool: makePool() })
    await gwView.app.request('/api/threads/dm:viewer/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Check pricing board' }),
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(viewRec.seenTools[0]).toContain('space_read')
    expect(viewRec.seenTools[0]).not.toContain('space_upsert_item')
    expect(viewRec.seenToolResults.some((t) => t.includes('"Alpha"'))).toBe(true)
    expect(viewRec.seenToolResults.some((t) => t.includes('need editor access'))).toBe(true)
  })

  it('allows manage_space in operator turns with space_updated chips, blocks it in routines, taints routine writes with 10-write cap, and allows space_read only in watch runs', async () => {
    const db = seedDb()
    const goal = createGoal(db, { title: 'Q2 Growth', ownerBotId: 'chief', memberBotIds: ['scout'] })

    // Operator turn creates a declarative space via manage_space
    const opRec = scriptedLlm([
      {
        toolCalls: [
          {
            id: 'm1',
            name: 'manage_space',
            args: { action: 'create', title: 'Growth Tracker', template: 'tracker', goal_id: goal.id },
          },
        ],
      },
      { content: 'Created space.' },
    ])
    const gwOp = createApp({ db, llm: opRec.llm, pool: makePool(), now: () => new Date(10_000) })
    await gwOp.app.request('/api/threads/dm:scout/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Create a Growth Tracker space linked to Q2 Growth' }),
    })
    await new Promise((r) => setTimeout(r, 50))

    const chip = listMessages(db, 'dm:scout').find((m) => m.kind === 'space_updated')
    expect(chip).toBeDefined()
    const spaceId = (chip!.payload as { spaceId: string }).spaceId

    // Act routine turn: manage_space refused; 11 writes -> 10 succeed (tainted=true) & 11th blocked; actions tagged with goalId
    const writeCalls: ToolCall[] = [
      { id: 'bad-layout', name: 'manage_space', args: { action: 'set_schema', space_id: spaceId, blocks: [] } },
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `w${i}`,
        name: 'space_upsert_item',
        args: { space_id: spaceId, block_id: 'records', title: `Entry ${i + 1}`, data: { value: i + 1 } },
      })),
    ]
    const actRec = scriptedLlm([{ toolCalls: writeCalls }, { content: 'Updated.' }])
    const gwAct = createApp({ db, llm: actRec.llm, pool: makePool(), now: () => new Date(20_000) })
    const actRoutine = createRoutine(db, {
      botId: 'scout',
      name: 'Sync Growth',
      cron: '0 9 * * *',
      instructions: 'Sync metrics',
      mode: 'act',
    })
    await gwAct.runRoutine(actRoutine)

    expect(actRec.seenTools[0]).not.toContain('manage_space')
    expect(actRec.seenTools[0]).toContain('space_upsert_item')
    expect(actRec.seenToolResults.some((t) => t.includes('manage_space only works in a turn your operator started'))).toBe(true)
    expect(actRec.seenToolResults.some((t) => t.includes('already made 10 space writes'))).toBe(true)

    const items = listSpaceItems(db, spaceId)
    expect(items).toHaveLength(10)
    expect(items.every((i) => i.tainted)).toBe(true)
    expect(listGoalActions(db, goal.id).some((a) => a.tool === 'space_upsert_item')).toBe(true)

    // Watch routine turn: space_read IS available; space_upsert_item is hidden and refused
    const watchRec = scriptedLlm([
      {
        toolCalls: [
          { id: 'wr1', name: 'space_read', args: { space_id: spaceId } },
          { id: 'ww1', name: 'space_upsert_item', args: { space_id: spaceId, block_id: 'records', title: 'No write in watch' } },
        ],
      },
      { content: 'Nothing new.' },
    ])
    const gwWatch = createApp({ db, llm: watchRec.llm, pool: makePool(), now: () => new Date(30_000) })
    const watchRoutine = createRoutine(db, {
      botId: 'scout',
      name: 'Watch Growth',
      cron: '*/30 * * * *',
      instructions: 'Inspect space only',
      mode: 'watch',
    })
    await gwWatch.runRoutine(watchRoutine)

    expect(watchRec.seenTools[0]).toContain('space_read')
    expect(watchRec.seenTools[0]).not.toContain('space_upsert_item')
    expect(watchRec.seenTools[0]).not.toContain('manage_space')
    expect(watchRec.seenToolResults.some((t) => t.includes('Entry 1'))).toBe(true)
    expect(watchRec.seenToolResults.some((t) => t.includes('not available in a watch routine'))).toBe(true)
  })
})
