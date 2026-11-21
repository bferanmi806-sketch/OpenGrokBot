import {
  SPACE_BLOCK_TYPES,
  type ActionBarBlock,
  type ChartBlock,
  type ChecklistBlock,
  type KanbanBlock,
  type KanbanColumnDef,
  type MarkdownBlock,
  type MetricCardDef,
  type MetricsBlock,
  type SpaceActionDef,
  type SpaceBlock,
  type SpaceItemData,
  type SpaceItemPrimitive,
  type SpaceSchema,
  type TableBlock,
  type TableColumnDef,
  type TableColumnKind,
  type TimelineBlock,
} from './types.js'

export const MAX_BLOCKS_PER_SPACE = 12
export const MAX_SCHEMA_BYTES = 65_536
export const MAX_ITEM_DATA_KEYS = 24
export const MAX_ITEM_DATA_BYTES = 8_192
export const MAX_ITEMS_PER_SPACE = 200

const BLOCK_ID_RE = /^[a-z0-9_-]{1,32}$/
const KEY_RE = /^[a-zA-Z0-9_-]{1,40}$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const TABLE_COL_KINDS: ReadonlySet<TableColumnKind> = new Set(['text', 'number', 'badge', 'url', 'date'])
const METRIC_AGGS = new Set(['count', 'sum', 'avg'])

export class SpaceSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpaceSchemaError'
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function checkForbiddenKeys(obj: Record<string, unknown>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) throw new SpaceSchemaError(`Forbidden key "${key}" in ${where}`)
  }
}

function reqString(v: unknown, name: string, maxLen: number): string {
  if (typeof v !== 'string') throw new SpaceSchemaError(`${name} must be a string`)
  const trimmed = v.trim()
  if (!trimmed || trimmed.length > maxLen) {
    throw new SpaceSchemaError(`${name} must be 1 to ${maxLen} characters`)
  }
  return trimmed
}

function optString(v: unknown, name: string, maxLen: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new SpaceSchemaError(`${name} must be a string`)
  const trimmed = v.trim()
  if (!trimmed) return undefined
  if (trimmed.length > maxLen) throw new SpaceSchemaError(`${name} must be at most ${maxLen} characters`)
  return trimmed
}

/** 仅允许 http: / https: 链接，彻底阻断 javascript: / data: / vbscript: 注入 */
export function isSafeHttpUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function parseMetricsBlock(id: string, title: string, raw: Record<string, unknown>): MetricsBlock {
  if (!Array.isArray(raw.cards) || raw.cards.length === 0 || raw.cards.length > 8) {
    throw new SpaceSchemaError(`metrics block "${id}" must have 1 to 8 cards`)
  }
  const cards: MetricCardDef[] = raw.cards.map((c, idx) => {
    if (!isRecord(c)) throw new SpaceSchemaError(`metrics card #${idx + 1} must be an object`)
    checkForbiddenKeys(c, `metrics.${id}.cards[${idx}]`)
    const label = reqString(c.label, 'card.label', 60)
    const value = optString(c.value, 'card.value', 60)
    const unit = optString(c.unit, 'card.unit', 24)
    const trend = optString(c.trend, 'card.trend', 32)
    const blockId = optString(c.blockId, 'card.blockId', 32)
    if (blockId && !BLOCK_ID_RE.test(blockId)) throw new SpaceSchemaError(`invalid card.blockId "${blockId}"`)
    const aggRaw = optString(c.agg, 'card.agg', 16)
    if (aggRaw && !METRIC_AGGS.has(aggRaw)) throw new SpaceSchemaError(`card.agg must be count, sum, or avg`)
    const itemField = optString(c.itemField, 'card.itemField', 40)
    if (itemField && (!KEY_RE.test(itemField) || FORBIDDEN_KEYS.has(itemField))) {
      throw new SpaceSchemaError(`invalid card.itemField "${itemField}"`)
    }
    const filterStatus = optString(c.filterStatus, 'card.filterStatus', 40)
    return {
      label,
      ...(value !== undefined ? { value } : {}),
      ...(unit !== undefined ? { unit } : {}),
      ...(trend !== undefined ? { trend } : {}),
      ...(blockId !== undefined ? { blockId } : {}),
      ...(aggRaw ? { agg: aggRaw as 'count' | 'sum' | 'avg' } : {}),
      ...(itemField !== undefined ? { itemField } : {}),
      ...(filterStatus !== undefined ? { filterStatus } : {}),
    }
  })
  return { id, type: 'metrics', title, cards }
}

function parseTableBlock(id: string, title: string, raw: Record<string, unknown>): TableBlock {
  if (!Array.isArray(raw.columns) || raw.columns.length === 0 || raw.columns.length > 12) {
    throw new SpaceSchemaError(`table block "${id}" must have 1 to 12 columns`)
  }
  const seen = new Set<string>()
  const columns: TableColumnDef[] = raw.columns.map((c, idx) => {
    if (!isRecord(c)) throw new SpaceSchemaError(`table column #${idx + 1} must be an object`)
    checkForbiddenKeys(c, `table.${id}.columns[${idx}]`)
    const key = reqString(c.key, 'column.key', 40)
    if (!KEY_RE.test(key) || FORBIDDEN_KEYS.has(key)) throw new SpaceSchemaError(`invalid column.key "${key}"`)
    if (seen.has(key)) throw new SpaceSchemaError(`duplicate column.key "${key}" in table "${id}"`)
    seen.add(key)
    const label = reqString(c.label, 'column.label', 60)
    const kindRaw = c.kind === undefined ? 'text' : c.kind
    if (typeof kindRaw !== 'string' || !TABLE_COL_KINDS.has(kindRaw as TableColumnKind)) {
      throw new SpaceSchemaError(`column.kind must be one of: ${[...TABLE_COL_KINDS].join(', ')}`)
    }
    return { key, label, kind: kindRaw as TableColumnKind }
  })
  return { id, type: 'table', title, columns }
}

function parseKanbanBlock(id: string, title: string, raw: Record<string, unknown>): KanbanBlock {
  if (!Array.isArray(raw.columns) || raw.columns.length === 0 || raw.columns.length > 8) {
    throw new SpaceSchemaError(`kanban block "${id}" must have 1 to 8 columns`)
  }
  const seen = new Set<string>()
  const columns: KanbanColumnDef[] = raw.columns.map((c, idx) => {
    if (!isRecord(c)) throw new SpaceSchemaError(`kanban column #${idx + 1} must be an object`)
    checkForbiddenKeys(c, `kanban.${id}.columns[${idx}]`)
    const key = reqString(c.key, 'column.key', 32)
    if (!KEY_RE.test(key) || FORBIDDEN_KEYS.has(key)) throw new SpaceSchemaError(`invalid kanban column.key "${key}"`)
    if (seen.has(key)) throw new SpaceSchemaError(`duplicate kanban column.key "${key}"`)
    seen.add(key)
    const label = reqString(c.label, 'column.label', 48)
    return { key, label }
  })
  return { id, type: 'kanban', title, columns }
}

function parseChartBlock(id: string, title: string, raw: Record<string, unknown>): ChartBlock {
  const modeRaw = raw.mode === undefined ? 'bar' : raw.mode
  if (modeRaw !== 'bar' && modeRaw !== 'horizontal') {
    throw new SpaceSchemaError(`chart block "${id}" mode must be "bar" or "horizontal"`)
  }
  const labelField = optString(raw.labelField, 'chart.labelField', 40) ?? 'title'
  const valueField = reqString(raw.valueField, 'chart.valueField', 40)
  if (!KEY_RE.test(labelField) || FORBIDDEN_KEYS.has(labelField)) {
    throw new SpaceSchemaError(`invalid chart.labelField "${labelField}"`)
  }
  if (!KEY_RE.test(valueField) || FORBIDDEN_KEYS.has(valueField)) {
    throw new SpaceSchemaError(`invalid chart.valueField "${valueField}"`)
  }
  const unit = optString(raw.unit, 'chart.unit', 24)
  const sourceBlockId = optString(raw.sourceBlockId, 'chart.sourceBlockId', 32)
  if (sourceBlockId && !BLOCK_ID_RE.test(sourceBlockId)) {
    throw new SpaceSchemaError(`invalid chart.sourceBlockId "${sourceBlockId}"`)
  }
  return {
    id,
    type: 'chart',
    title,
    mode: modeRaw,
    labelField,
    valueField,
    ...(unit !== undefined ? { unit } : {}),
    ...(sourceBlockId !== undefined ? { sourceBlockId } : {}),
  }
}

function parseMarkdownBlock(id: string, title: string, raw: Record<string, unknown>): MarkdownBlock {
  const content = typeof raw.content === 'string' ? raw.content : ''
  if (content.length > 8000) throw new SpaceSchemaError(`markdown block "${id}" content exceeds 8000 characters`)
  return { id, type: 'markdown', title, content }
}

function parseActionBarBlock(id: string, title: string, raw: Record<string, unknown>): ActionBarBlock {
  if (!Array.isArray(raw.actions) || raw.actions.length === 0 || raw.actions.length > 6) {
    throw new SpaceSchemaError(`action_bar block "${id}" must have 1 to 6 actions`)
  }
  const seen = new Set<string>()
  const actions: SpaceActionDef[] = raw.actions.map((a, idx) => {
    if (!isRecord(a)) throw new SpaceSchemaError(`action #${idx + 1} must be an object`)
    checkForbiddenKeys(a, `action_bar.${id}.actions[${idx}]`)
    const actionId = reqString(a.id, 'action.id', 32)
    if (!BLOCK_ID_RE.test(actionId)) throw new SpaceSchemaError(`invalid action.id "${actionId}"`)
    if (seen.has(actionId)) throw new SpaceSchemaError(`duplicate action.id "${actionId}"`)
    seen.add(actionId)
    const label = reqString(a.label, 'action.label', 60)
    const botId = reqString(a.botId, 'action.botId', 64)
    const prompt = reqString(a.prompt, 'action.prompt', 600)
    const confirm = a.confirm === true
    return { id: actionId, label, botId, prompt, ...(confirm ? { confirm: true } : {}) }
  })
  return { id, type: 'action_bar', title, actions }
}

export function parseSpaceSchema(raw: unknown): SpaceSchema {
  if (!isRecord(raw)) throw new SpaceSchemaError('Space schema must be a JSON object')
  checkForbiddenKeys(raw, 'schema')
  if (!Array.isArray(raw.blocks)) throw new SpaceSchemaError('Space schema must include a blocks array')
  if (raw.blocks.length > MAX_BLOCKS_PER_SPACE) {
    throw new SpaceSchemaError(`Space schema allows at most ${MAX_BLOCKS_PER_SPACE} blocks`)
  }

  const seenIds = new Set<string>()
  const blocks: SpaceBlock[] = raw.blocks.map((item, idx) => {
    if (!isRecord(item)) throw new SpaceSchemaError(`Block #${idx + 1} must be an object`)
    checkForbiddenKeys(item, `blocks[${idx}]`)
    const id = reqString(item.id, 'block.id', 32)
    if (!BLOCK_ID_RE.test(id)) throw new SpaceSchemaError(`block.id "${id}" must match /^[a-z0-9_-]{1,32}$/`)
    if (seenIds.has(id)) throw new SpaceSchemaError(`Duplicate block.id "${id}"`)
    seenIds.add(id)

    const type = item.type
    if (typeof type !== 'string' || !(SPACE_BLOCK_TYPES as readonly string[]).includes(type)) {
      throw new SpaceSchemaError(`Unsupported block type "${String(type)}"`)
    }
    const title = reqString(item.title, 'block.title', 80)

    switch (type) {
      case 'metrics': return parseMetricsBlock(id, title, item)
      case 'table': return parseTableBlock(id, title, item)
      case 'kanban': return parseKanbanBlock(id, title, item)
      case 'checklist': return { id, type: 'checklist', title } as ChecklistBlock
      case 'timeline': return { id, type: 'timeline', title } as TimelineBlock
      case 'chart': return parseChartBlock(id, title, item)
      case 'markdown': return parseMarkdownBlock(id, title, item)
      case 'action_bar': return parseActionBarBlock(id, title, item)
      default:
        throw new SpaceSchemaError(`Unsupported block type "${type}"`)
    }
  })

  const schema: SpaceSchema = { blocks }
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8')
  if (bytes > MAX_SCHEMA_BYTES) {
    throw new SpaceSchemaError(`Space schema exceeds ${MAX_SCHEMA_BYTES} bytes`)
  }
  return schema
}

/**
 * 清洗单条 space_items.data_json：仅允许扁平原始值（string / finite number / boolean / null），
 * 拦截原型污染键、嵌套对象、超长字符串与超大载荷；若目标区块是 table 且含 url 列，强校验 http(s) URL。
 */
export function sanitizeItemData(raw: unknown, targetBlock?: SpaceBlock): SpaceItemData {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) throw new SpaceSchemaError('Item data must be a flat JSON object')
  checkForbiddenKeys(raw, 'item.data')
  const entries = Object.entries(raw)
  if (entries.length > MAX_ITEM_DATA_KEYS) {
    throw new SpaceSchemaError(`Item data supports at most ${MAX_ITEM_DATA_KEYS} fields`)
  }
  const urlCols = new Set(
    targetBlock?.type === 'table'
      ? targetBlock.columns.filter((c) => c.kind === 'url').map((c) => c.key)
      : [],
  )
  const out: SpaceItemData = Object.create(null) as SpaceItemData
  for (const [key, val] of entries) {
    if (!KEY_RE.test(key) || FORBIDDEN_KEYS.has(key)) {
      throw new SpaceSchemaError(`Invalid item data key "${key}"`)
    }
    let clean: SpaceItemPrimitive
    if (val === null || typeof val === 'boolean') {
      clean = val
    } else if (typeof val === 'number') {
      if (!Number.isFinite(val)) throw new SpaceSchemaError(`Field "${key}" must be a finite number`)
      clean = val
    } else if (typeof val === 'string') {
      if (val.length > 1000) throw new SpaceSchemaError(`Field "${key}" exceeds 1000 characters`)
      if (urlCols.has(key) && val.trim() && !isSafeHttpUrl(val)) {
        throw new SpaceSchemaError(`Field "${key}" must be an http:// or https:// URL`)
      }
      clean = val.trim()
    } else {
      throw new SpaceSchemaError(`Field "${key}" must be a string, number, boolean, or null`)
    }
    out[key] = clean
  }
  const plain = { ...out }
  if (Buffer.byteLength(JSON.stringify(plain), 'utf8') > MAX_ITEM_DATA_BYTES) {
    throw new SpaceSchemaError(`Item data exceeds ${MAX_ITEM_DATA_BYTES} bytes`)
  }
  return plain
}
