import type { RuleBlock } from '../agent.js'
import type { BotRow, Db } from '../db.js'
import { getGoal, isGoalId } from '../goals/store.js'
import type { Hub } from '../hub.js'
import type { ToolDef } from '../llm.js'
import { parseSpaceSchema, parseSpaceTheme, sanitizeItemData, SpaceSchemaError } from './schema.js'
import {
  createSpace,
  deleteSpaceItem,
  getBotSpaceRole,
  getSpaceItem,
  listSpaceItems,
  resolveSpace,
  updateSpace,
  upsertSpaceItem,
} from './store.js'
import { buildTemplateSchema, defaultIconForTemplate } from './templates.js'
import { SPACE_ACCENTS, SPACE_TEMPLATE_IDS, type SpaceTemplateId, type SpaceTheme, type SpaceUpdatedPayload } from './types.js'

export const MANAGE_SPACE_TOOL_NAME = 'manage_space'
export const SPACE_READ_TOOL_NAME = 'space_read'
export const SPACE_UPSERT_ITEM_TOOL_NAME = 'space_upsert_item'
export const SPACE_DELETE_ITEM_TOOL_NAME = 'space_delete_item'
export const MAX_SPACE_WRITES_PER_TURN = 10

export const MANAGE_SPACE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: MANAGE_SPACE_TOOL_NAME,
    description:
      'Create or update a Space (live dashboard, rich card gallery, or full sandboxed HTML/CSS/SVG/JS canvas) when your operator asks. Call read_skill("space-design") first to craft strong visual hierarchy, themes, Bento layouts, rich image cards, or bespoke HTML designs. Only available in operator-started turns.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update_meta', 'set_schema'],
          description: 'Action to perform.',
        },
        space_id: {
          type: 'string',
          description: 'Existing space id or slug (required for update_meta and set_schema).',
        },
        title: { type: 'string', description: 'Space title (1-120 chars).' },
        description: { type: 'string', description: 'Optional short description (<=1000 chars).' },
        icon: { type: 'string', description: 'Optional emoji icon (e.g. "📊").' },
        goal_id: { type: 'string', description: 'Optional goal id (e.g. "goal-a1b2c3d4") to link, or empty string to unlink.' },
        template: {
          type: 'string',
          enum: [...SPACE_TEMPLATE_IDS],
          description: 'Optional built-in template for action="create". Use radar for competitor monitoring and scoreboard for game schedules, team logos, scores, and standings.',
        },
        theme: {
          type: 'object',
          description: `Optional visual theme: { accent: ${SPACE_ACCENTS.join('|')}, style?: "editorial"|"minimal" }.`,
          properties: {
            accent: { type: 'string', enum: [...SPACE_ACCENTS] },
            style: { type: 'string', enum: ['editorial', 'minimal'] },
          },
        },
        blocks: {
          type: 'array',
          description:
            'Blocks array: metrics, table (columns: text|number|badge|url|date|image), kanban, checklist, timeline, chart (bar|horizontal|donut|area), markdown (default|callout), action_bar, cards (columns: 2|3, aspect: wide|square|compact, optional variant: competitor|matchup), and html ({ html, height?, frameless?, viewOf? } — full sandboxed HTML/CSS/SVG/JS canvas; viewOf lists native block IDs for a switchable view of the same records). Each block supports optional span ("full"|"wide"|"half"|"narrow") and subtitle.',
          items: { type: 'object' },
        },
      },
      required: ['action'],
    },
  },
}

export const SPACE_READ_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: SPACE_READ_TOOL_NAME,
    description:
      'Read the declarative blocks and structured items of a Space you have viewer or editor access to. Safe in read-only watch runs.',
    parameters: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'Space id (e.g. "space-a1b2c3d4") or slug.' },
        block_id: { type: 'string', description: 'Optional block id to filter items.' },
        limit: { type: 'number', description: 'Max items to return (default 50, max 100).' },
      },
      required: ['space_id'],
    },
  },
}

export const SPACE_UPSERT_ITEM_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: SPACE_UPSERT_ITEM_TOOL_NAME,
    description:
      'Insert or update a structured record in a Space you have editor access to (at most 10 writes per turn). Provide item_id to update an existing record, or omit to create a new one.',
    parameters: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'Space id or slug.' },
        block_id: { type: 'string', description: 'Target block id inside the space schema.' },
        item_id: { type: 'string', description: 'Optional existing item id (e.g. "item-1a2b3c4d") to update in place.' },
        title: { type: 'string', description: 'Record title (1-160 chars).' },
        status: { type: 'string', description: 'Column key (kanban), "open"/"done" (checklist), or status tag.' },
        data: {
          type: 'object',
          description: 'Flat JSON key-value fields (strings, numbers, booleans, or null; URL columns require http(s)).',
        },
        merge_data: { type: 'boolean', description: 'Update only supplied fields on an existing record. Defaults to true for competitor and matchup cards, false for other blocks. Set a field to null to clear it.' },
      },
      required: ['space_id', 'block_id', 'title'],
    },
  },
}

export const SPACE_DELETE_ITEM_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: SPACE_DELETE_ITEM_TOOL_NAME,
    description: 'Delete a single record from a Space you have editor access to.',
    parameters: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'Space id or slug.' },
        item_id: { type: 'string', description: 'Item id to remove (e.g. "item-1a2b3c4d").' },
      },
      required: ['space_id', 'item_id'],
    },
  },
}

export type SpaceToolResult = {
  ok: boolean
  text: string
  spaceId?: string
  goalId?: string | null
  chip?: SpaceUpdatedPayload
}

const botExists = (db: Db, id: string): boolean =>
  Boolean(db.prepare('SELECT id FROM bots WHERE id = ?').get(id) as BotRow | undefined)

function validateActionBarBots(db: Db, blocks: ReturnType<typeof parseSpaceSchema>['blocks']): string | null {
  for (const b of blocks) {
    if (b.type !== 'action_bar') continue
    for (const a of b.actions) {
      if (!botExists(db, a.botId)) return `action "${a.id}" references unknown teammate "${a.botId}"`
    }
  }
  return null
}

export function runManageSpaceCall(input: {
  db: Db
  hub: Hub
  botId: string
  args: Record<string, unknown>
  now?: number
}): SpaceToolResult {
  const { db, hub, botId, args } = input
  const at = input.now ?? Date.now()
  const action = typeof args.action === 'string' ? args.action.trim() : ''

  if (action === 'create') {
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title || title.length > 120) {
      return { ok: false, text: 'manage_space(create) needs a "title" of 1 to 120 characters.' }
    }
    let goalId: string | null = null
    if (typeof args.goal_id === 'string' && args.goal_id.trim()) {
      const ref = args.goal_id.trim()
      if (!isGoalId(ref) || !getGoal(db, ref)) return { ok: false, text: `Unknown goal_id "${ref}".` }
      goalId = ref
    }
    const templateRaw = typeof args.template === 'string' ? args.template.trim() : ''
    const template: SpaceTemplateId = (SPACE_TEMPLATE_IDS as readonly string[]).includes(templateRaw)
      ? (templateRaw as SpaceTemplateId)
      : 'blank'
    let themeOverride: SpaceTheme | undefined
    try {
      themeOverride = parseSpaceTheme(args.theme)
    } catch (err) {
      return { ok: false, text: err instanceof SpaceSchemaError ? err.message : 'Invalid space theme.' }
    }
    let schema
    try {
      schema = Array.isArray(args.blocks)
        ? parseSpaceSchema({ ...(themeOverride ? { theme: themeOverride } : {}), blocks: args.blocks })
        : parseSpaceSchema(buildTemplateSchema(template, botId, themeOverride))
    } catch (err) {
      return { ok: false, text: err instanceof SpaceSchemaError ? err.message : 'Invalid space schema.' }
    }
    const badAction = validateActionBarBots(db, schema.blocks)
    if (badAction) return { ok: false, text: badAction }

    const icon = typeof args.icon === 'string' && args.icon.trim()
      ? args.icon.trim().slice(0, 8)
      : defaultIconForTemplate(template)
    const space = createSpace(db, {
      title,
      description: typeof args.description === 'string' ? args.description : '',
      icon,
      goalId,
      schema,
      grants: [{ botId, role: 'editor' }],
      now: at,
    })
    hub.broadcast({ type: 'spaces_changed' })
    if (goalId) hub.broadcast({ type: 'goals_changed' })
    const diff = [
      `+ Space: ${space.icon} ${space.title} (${space.id})`,
      ...space.schema.blocks.map((b) => `+ [${b.type}] ${b.title} (${b.id})`),
    ].join('\n')
    return {
      ok: true,
      spaceId: space.id,
      goalId: space.goalId,
      text: `Created declarative Space "${space.title}" (${space.id}, slug: ${space.slug}) with ${space.schema.blocks.length} block(s).`,
      chip: {
        spaceId: space.id,
        spaceTitle: space.title,
        kind: 'space',
        summary: `Created space "${space.title}"`,
        diff,
        by: 'bot',
      },
    }
  }

  const ref = typeof args.space_id === 'string' ? args.space_id.trim() : ''
  const existing = ref ? resolveSpace(db, ref) : null
  if (!existing) return { ok: false, text: `No space found matching "${ref}".` }
  const role = getBotSpaceRole(db, botId, existing.id)
  if (role !== 'editor') {
    return { ok: false, text: `You do not have editor access to space "${existing.title}" (${existing.id}).` }
  }

  if (action === 'update_meta') {
    const patch: Parameters<typeof updateSpace>[2] = { now: at }
    const diffs: string[] = []
    if (args.title !== undefined) {
      if (typeof args.title !== 'string' || !args.title.trim() || args.title.trim().length > 120) {
        return { ok: false, text: 'title must be 1 to 120 characters.' }
      }
      patch.title = args.title.trim()
      if (patch.title !== existing.title) diffs.push(`~ Title: ${patch.title}`)
    }
    if (args.description !== undefined) {
      if (typeof args.description !== 'string') return { ok: false, text: 'description must be a string.' }
      patch.description = args.description
      if (patch.description.trim() !== existing.description) diffs.push('~ Updated description')
    }
    if (args.icon !== undefined) {
      if (typeof args.icon !== 'string' || !args.icon.trim()) return { ok: false, text: 'icon must be a non-empty string.' }
      patch.icon = args.icon.trim()
      if (patch.icon !== existing.icon) diffs.push(`~ Icon: ${patch.icon}`)
    }
    if (args.goal_id !== undefined) {
      if (args.goal_id === null || args.goal_id === '') {
        patch.goalId = null
        if (existing.goalId !== null) diffs.push('- Unlinked goal')
      } else if (typeof args.goal_id === 'string' && isGoalId(args.goal_id.trim()) && getGoal(db, args.goal_id.trim())) {
        patch.goalId = args.goal_id.trim()
        if (patch.goalId !== existing.goalId) diffs.push(`~ Linked goal: ${patch.goalId}`)
      } else {
        return { ok: false, text: 'goal_id must be a valid existing goal id or empty string.' }
      }
    }
    if (!diffs.length) return { ok: true, spaceId: existing.id, goalId: existing.goalId, text: `Space "${existing.title}" is already up to date.` }
    const updated = updateSpace(db, existing.id, patch)!
    hub.broadcast({ type: 'spaces_changed' })
    if (existing.goalId !== updated.goalId) hub.broadcast({ type: 'goals_changed' })
    return {
      ok: true,
      spaceId: updated.id,
      goalId: updated.goalId,
      text: `Updated space "${updated.title}" (${updated.id}).`,
      chip: {
        spaceId: updated.id,
        spaceTitle: updated.title,
        kind: 'space',
        summary: diffs[0]!.replace(/^[+~-]\s*/, ''),
        diff: diffs.join('\n'),
        by: 'bot',
      },
    }
  }

  if (action === 'set_schema') {
    if (!Array.isArray(args.blocks)) return { ok: false, text: 'set_schema needs a "blocks" array.' }
    let nextSchema
    try {
      const nextTheme = args.theme !== undefined ? parseSpaceTheme(args.theme) : existing.schema.theme
      nextSchema = parseSpaceSchema({ ...(nextTheme ? { theme: nextTheme } : {}), blocks: args.blocks })
    } catch (err) {
      return { ok: false, text: err instanceof SpaceSchemaError ? err.message : 'Invalid blocks schema.' }
    }
    const badAction = validateActionBarBots(db, nextSchema.blocks)
    if (badAction) return { ok: false, text: badAction }
    const updated = updateSpace(db, existing.id, { schema: nextSchema, now: at })!
    hub.broadcast({ type: 'spaces_changed' })
    const diff = updated.schema.blocks.map((b) => `~ [${b.type}] ${b.title} (${b.id})`).join('\n') || '~ (empty layout)'
    return {
      ok: true,
      spaceId: updated.id,
      goalId: updated.goalId,
      text: `Updated layout of space "${updated.title}" (${updated.schema.blocks.length} blocks).`,
      chip: {
        spaceId: updated.id,
        spaceTitle: updated.title,
        kind: 'schema',
        summary: `Updated layout (${updated.schema.blocks.length} blocks)`,
        diff,
        by: 'bot',
      },
    }
  }

  return { ok: false, text: 'manage_space action must be one of: create, update_meta, set_schema.' }
}

export function runSpaceReadCall(input: {
  db: Db
  botId: string
  args: Record<string, unknown>
}): { ok: boolean; text: string; spaceId?: string; goalId?: string | null; tainted?: boolean } {
  const { db, botId, args } = input
  const ref = typeof args.space_id === 'string' ? args.space_id.trim() : ''
  const space = ref ? resolveSpace(db, ref) : null
  if (!space) return { ok: false, text: `No space found matching "${ref}".` }
  const role = getBotSpaceRole(db, botId, space.id)
  if (!role) return { ok: false, text: `You do not have access to space "${space.title}" (${space.id}).` }

  const blockId = typeof args.block_id === 'string' && args.block_id.trim() ? args.block_id.trim() : undefined
  const limitRaw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 50
  const limit = Math.max(1, Math.min(limitRaw, 100))
  const items = listSpaceItems(db, space.id, { ...(blockId ? { blockId } : {}), limit })
  const hasTaintedItems = items.some((i) => i.tainted)
  const payload = {
    id: space.id,
    slug: space.slug,
    title: space.title,
    role,
    ...(space.schema.theme ? { theme: space.schema.theme } : {}),
    blocks: space.schema.blocks,
    items: items.map((i) => ({
      id: i.id,
      blockId: i.blockId,
      title: i.title,
      status: i.status,
      data: i.data,
      ...(i.tainted ? { tainted: true } : {}),
      updatedBy: i.updatedBy,
    })),
  }
  const serialized = JSON.stringify(payload, null, 2)
  const text = serialized.length > 24_000 ? `${serialized.slice(0, 24_000)}\n…(truncated)` : serialized
  return { ok: true, text, spaceId: space.id, goalId: space.goalId, tainted: hasTaintedItems }
}

export function runSpaceUpsertItemCall(input: {
  db: Db
  hub: Hub
  botId: string
  args: Record<string, unknown>
  ruleBlock: RuleBlock | null
  now?: number
}): SpaceToolResult {
  const { db, hub, botId, args, ruleBlock } = input
  const at = input.now ?? Date.now()
  const ref = typeof args.space_id === 'string' ? args.space_id.trim() : ''
  const space = ref ? resolveSpace(db, ref) : null
  if (!space) return { ok: false, text: `No space found matching "${ref}".` }
  const role = getBotSpaceRole(db, botId, space.id)
  if (role !== 'editor') {
    return { ok: false, text: `You need editor access to write to space "${space.title}" (${space.id}).` }
  }
  const blockId = typeof args.block_id === 'string' ? args.block_id.trim() : ''
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const itemId = typeof args.item_id === 'string' && args.item_id.trim() ? args.item_id.trim() : undefined
  const tainted = ruleBlock !== null

  try {
    const block = space.schema.blocks.find((entry) => entry.id === blockId)
    const existing = itemId ? getSpaceItem(db, itemId) : null
    const merge = (args.merge_data === true || (args.merge_data !== false && block?.type === 'cards' && block.variant))
      && existing?.spaceId === space.id && existing.blockId === blockId
    const data = merge ? { ...existing.data, ...sanitizeItemData(args.data, block) } : args.data
    const status = typeof args.status === 'string' ? args.status.trim() : merge ? existing.status : ''
    const { item, created } = upsertSpaceItem(db, {
      spaceId: space.id,
      ...(itemId ? { itemId } : {}),
      blockId,
      title,
      status,
      data,
      tainted,
      updatedBy: botId,
      now: at,
    })
    hub.broadcast({ type: 'spaces_changed' })
    const summary = `${created ? 'Added' : 'Updated'} "${item.title}" in ${item.blockId}`
    const diff = `${created ? '+' : '~'} [${item.blockId}] ${item.title}${item.status ? ` (${item.status})` : ''}`
    return {
      ok: true,
      spaceId: space.id,
      goalId: space.goalId,
      text: `${summary} (${item.id}).`,
      chip: {
        spaceId: space.id,
        spaceTitle: space.title,
        kind: 'item',
        summary,
        diff,
        ...(item.tainted ? { tainted: true } : {}),
        by: 'bot',
      },
    }
  } catch (err) {
    return { ok: false, spaceId: space.id, goalId: space.goalId, text: err instanceof Error ? err.message : String(err) }
  }
}

export function runSpaceDeleteItemCall(input: {
  db: Db
  hub: Hub
  botId: string
  args: Record<string, unknown>
  ruleBlock: RuleBlock | null
  now?: number
}): SpaceToolResult {
  const { db, hub, botId, args, ruleBlock } = input
  const at = input.now ?? Date.now()
  const ref = typeof args.space_id === 'string' ? args.space_id.trim() : ''
  const space = ref ? resolveSpace(db, ref) : null
  if (!space) return { ok: false, text: `No space found matching "${ref}".` }
  const role = getBotSpaceRole(db, botId, space.id)
  if (role !== 'editor') {
    return { ok: false, text: `You need editor access to delete items in space "${space.title}" (${space.id}).` }
  }
  const itemId = typeof args.item_id === 'string' ? args.item_id.trim() : ''
  const removed = deleteSpaceItem(db, space.id, itemId, at)
  if (!removed) return { ok: false, spaceId: space.id, goalId: space.goalId, text: `Item "${itemId}" not found in space "${space.title}".` }
  hub.broadcast({ type: 'spaces_changed' })
  const tainted = ruleBlock !== null
  return {
    ok: true,
    spaceId: space.id,
    goalId: space.goalId,
    text: `Deleted "${removed.title}" (${removed.id}) from "${space.title}".`,
    chip: {
      spaceId: space.id,
      spaceTitle: space.title,
      kind: 'item',
      summary: `Removed "${removed.title}" from ${removed.blockId}`,
      diff: `- [${removed.blockId}] ${removed.title}`,
      ...(tainted ? { tainted: true } : {}),
      by: 'bot',
    },
  }
}
