import {
  CARDS_ASPECTS,
  CARD_VARIANTS,
  CHART_MODES,
  MARKDOWN_VARIANTS,
  METRIC_TONES,
  SPACE_ACCENTS,
  SPACE_BLOCK_SPANS,
  SPACE_BLOCK_TYPES,
  SPACE_HEADER_STYLES,
  type ActionBarBlock,
  type CardsAspect,
  type CardsBlock,
  type CardVariant,
  type ChartBlock,
  type ChartMode,
  type ChecklistBlock,
  type HtmlBlock,
  type KanbanBlock,
  type KanbanColumnDef,
  type MarkdownBlock,
  type MarkdownVariant,
  type MetricCardDef,
  type MetricTone,
  type MetricsBlock,
  type SpaceAccent,
  type SpaceActionDef,
  type SpaceBlock,
  type SpaceBlockSpan,
  type SpaceHeaderStyle,
  type SpaceItemData,
  type SpaceItemPrimitive,
  type SpaceSchema,
  type SpaceTheme,
  type TableBlock,
  type TableColumnDef,
  type TableColumnKind,
  type TimelineBlock,
} from './types.js'

export const MAX_BLOCKS_PER_SPACE = 12
export const MAX_SCHEMA_BYTES = 262_144
export const MAX_HTML_BLOCK_CHARS = 120_000
export const MAX_ITEM_DATA_KEYS = 24
export const MAX_ITEM_DATA_BYTES = 16_384
export const MAX_ITEMS_PER_SPACE = 200

const BLOCK_ID_RE = /^[a-z0-9_-]{1,32}$/
const KEY_RE = /^[a-zA-Z0-9_-]{1,40}$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const TABLE_COL_KINDS: ReadonlySet<TableColumnKind> = new Set(['text', 'number', 'badge', 'url', 'date', 'image'])
const METRIC_AGGS = new Set(['count', 'sum', 'avg'])
const ACCENT_SET: ReadonlySet<string> = new Set(SPACE_ACCENTS)
const HEADER_STYLE_SET: ReadonlySet<string> = new Set(SPACE_HEADER_STYLES)
const SPAN_SET: ReadonlySet<string> = new Set(SPACE_BLOCK_SPANS)
const TONE_SET: ReadonlySet<string> = new Set(METRIC_TONES)
const CHART_MODE_SET: ReadonlySet<string> = new Set(CHART_MODES)
const MARKDOWN_VARIANT_SET: ReadonlySet<string> = new Set(MARKDOWN_VARIANTS)
const CARDS_ASPECT_SET: ReadonlySet<string> = new Set(CARDS_ASPECTS)
const GATEWAY_IMAGE_PATH_RE = /^\/api\/(?:uploads\/[a-zA-Z0-9._-]+|screenshots\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+|spaces\/space-[0-9a-f]{8}\/assets\/[0-9a-f]{16}\.(?:png|jpg|webp|gif))$/
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif|avif|svg\+xml);base64,[A-Za-z0-9+/=]+$/

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

/** 允许 http(s) 图片链接、网关托管的上传/截图路径（防路径穿越）或 base64 image data URI */
export function isSafeImageUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  if (GATEWAY_IMAGE_PATH_RE.test(trimmed)) return !trimmed.includes('..')
  if (DATA_IMAGE_RE.test(trimmed)) return trimmed.length <= 12_000
  return isSafeHttpUrl(trimmed)
}

export function parseSpaceTheme(raw: unknown): SpaceTheme | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) throw new SpaceSchemaError('theme must be an object')
  checkForbiddenKeys(raw, 'schema.theme')
  const accentRaw = raw.accent === undefined ? 'slate' : raw.accent
  if (typeof accentRaw !== 'string' || !ACCENT_SET.has(accentRaw)) {
    throw new SpaceSchemaError(`theme.accent must be one of: ${SPACE_ACCENTS.join(', ')}`)
  }
  const styleRaw = raw.style
  if (styleRaw !== undefined && (typeof styleRaw !== 'string' || !HEADER_STYLE_SET.has(styleRaw))) {
    throw new SpaceSchemaError(`theme.style must be one of: ${SPACE_HEADER_STYLES.join(', ')}`)
  }
  return {
    accent: accentRaw as SpaceAccent,
    ...(styleRaw ? { style: styleRaw as SpaceHeaderStyle } : {}),
  }
}

type BlockMetaFields = { subtitle?: string; span?: SpaceBlockSpan }

function parseBlockMeta(raw: Record<string, unknown>, id: string): BlockMetaFields {
  const subtitle = optString(raw.subtitle, `block "${id}".subtitle`, 140)
  const spanRaw = raw.span
  if (spanRaw !== undefined && (typeof spanRaw !== 'string' || !SPAN_SET.has(spanRaw))) {
    throw new SpaceSchemaError(`block "${id}".span must be one of: ${SPACE_BLOCK_SPANS.join(', ')}`)
  }
  return {
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(spanRaw ? { span: spanRaw as SpaceBlockSpan } : {}),
  }
}

function parseMetricsBlock(id: string, title: string, meta: BlockMetaFields, raw: Record<string, unknown>): MetricsBlock {
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
    const toneRaw = c.tone
    if (toneRaw !== undefined && (typeof toneRaw !== 'string' || !TONE_SET.has(toneRaw))) {
      throw new SpaceSchemaError(`card.tone must be one of: ${METRIC_TONES.join(', ')}`)
    }
    let target: number | undefined
    if (c.target !== undefined && c.target !== null) {
      if (typeof c.target !== 'number' || !Number.isFinite(c.target) || c.target <= 0) {
        throw new SpaceSchemaError('card.target must be a positive finite number')
      }
      target = c.target
    }
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
      ...(toneRaw ? { tone: toneRaw as MetricTone } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(blockId !== undefined ? { blockId } : {}),
      ...(aggRaw ? { agg: aggRaw as 'count' | 'sum' | 'avg' } : {}),
      ...(itemField !== undefined ? { itemField } : {}),
      ...(filterStatus !== undefined ? { filterStatus } : {}),
    }
  })
  return { id, type: 'metrics', title, ...meta, cards }
}

function parseTableBlock(id: string, title: string, meta: BlockMetaFields, raw: Record<string, unknown>): TableBlock {
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
  return { id, type: 'table', title, ...meta, columns }
}

function parseKanbanBlock(id: string, title: string, meta: BlockMetaFields, raw: Record<string, unknown>): KanbanBlock {
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
    const colorRaw = c.color
    if (colorRaw !== undefined && (typeof colorRaw !== 'string' || !ACCENT_SET.has(colorRaw))) {
      throw new SpaceSchemaError(`kanban column.color must be one of: ${SPACE_ACCENTS.join(', ')}`)
    }
    return { key, label, ...(colorRaw ? { color: colorRaw as SpaceAccent } : {}) }
  })
  return { id, type: 'kanban', title, ...meta, columns }
}

function parseChartBlock(id: string, title: string, meta: BlockMetaFields, raw: Record<string, unknown>): ChartBlock {
  const modeRaw = raw.mode === undefined ? 'bar' : raw.mode
  if (typeof modeRaw !== 'string' || !CHART_MODE_SET.has(modeRaw)) {
    throw new SpaceSchemaError(`chart block "${id}" mode must be one of: ${CHART_MODES.join(', ')}`)
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
    ...meta,
    mode: modeRaw as ChartMode,
    labelField,
    valueField,
    ...(unit !== undefined ? { unit } : {}),
    ...(sourceBlockId !== undefined ? { sourceBlockId } : {}),
  }
}

function parseMarkdownBlock(id: string, title: string, meta: BlockMetaFields, raw: Record<string, unknown>): MarkdownBlock {
  const content = typeof raw.content === 'string' ? raw.content : ''
  if (content.length > 8000) throw new SpaceSchemaError(`markdown block "${id}" content exceeds 8000 characters`)
  const variantRaw = raw.variant
  if (variantRaw !== undefined && (typeof variantRaw !== 'string' || !MARKDOWN_VARIANT_SET.has(variantRaw))) {
    throw new SpaceSchemaError(`markdown block "${id}" variant must be one of: ${MARKDOWN_VARIANTS.join(', ')}`)
  }
  return {
    id,
    type: 'markdown',
    title,
    ...meta,
    content,
    ...(variantRaw ? { variant: variantRaw as MarkdownVariant } : {}),
  }
}

function parseActionBarBlock(id: string, title: string, meta: BlockMetaFields, raw: Record<string, unknown>): ActionBarBlock {
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
  return { id, type: 'action_bar', title, ...meta, actions }
}

function parseCardsBlock(id: string, title: string, meta: BlockMetaFields, raw: Record<string, unknown>): CardsBlock {
  let columns: 2 | 3 | undefined
  if (raw.columns !== undefined && raw.columns !== null) {
    if (raw.columns !== 2 && raw.columns !== 3) {
      throw new SpaceSchemaError(`cards block "${id}" columns must be 2 or 3`)
    }
    columns = raw.columns
  }
  const aspectRaw = raw.aspect
  if (aspectRaw !== undefined && (typeof aspectRaw !== 'string' || !CARDS_ASPECT_SET.has(aspectRaw))) {
    throw new SpaceSchemaError(`cards block "${id}" aspect must be one of: ${CARDS_ASPECTS.join(', ')}`)
  }
  const variant = optString(raw.variant, 'cards.variant', 20)
  if (variant && !(CARD_VARIANTS as readonly string[]).includes(variant)) {
    throw new SpaceSchemaError(`cards block "${id}" variant must be one of: ${CARD_VARIANTS.join(', ')}`)
  }
  return {
    id,
    type: 'cards',
    title,
    ...meta,
    ...(columns !== undefined ? { columns } : {}),
    ...(aspectRaw ? { aspect: aspectRaw as CardsAspect } : {}),
    ...(variant ? { variant: variant as CardVariant } : {}),
  }
}

function parseHtmlBlock(id: string, title: string, meta: BlockMetaFields, raw: Record<string, unknown>): HtmlBlock {
  if (typeof raw.html !== 'string' || !raw.html.trim()) {
    throw new SpaceSchemaError(`html block "${id}" requires an "html" string`)
  }
  if (raw.html.length > MAX_HTML_BLOCK_CHARS) {
    throw new SpaceSchemaError(`html block "${id}" html exceeds ${MAX_HTML_BLOCK_CHARS} characters`)
  }
  let height: number | undefined
  if (raw.height !== undefined && raw.height !== null) {
    if (typeof raw.height !== 'number' || !Number.isFinite(raw.height) || raw.height < 160 || raw.height > 2400) {
      throw new SpaceSchemaError(`html block "${id}" height must be between 160 and 2400`)
    }
    height = Math.round(raw.height)
  }
  const frameless = raw.frameless === true
  let viewOf: string[] | undefined
  if (raw.viewOf !== undefined) {
    if (!Array.isArray(raw.viewOf) || !raw.viewOf.length || raw.viewOf.length >= MAX_BLOCKS_PER_SPACE) {
      throw new SpaceSchemaError(`html block "${id}" viewOf must list one or more native block IDs`)
    }
    viewOf = raw.viewOf.map((source) => reqString(source, 'html.viewOf block id', 32))
  }
  return {
    id,
    type: 'html',
    title,
    ...meta,
    html: raw.html,
    ...(height !== undefined ? { height } : {}),
    ...(frameless ? { frameless: true } : {}),
    ...(viewOf ? { viewOf } : {}),
  }
}

export function parseSpaceSchema(raw: unknown): SpaceSchema {
  if (!isRecord(raw)) throw new SpaceSchemaError('Space schema must be a JSON object')
  checkForbiddenKeys(raw, 'schema')
  if (!Array.isArray(raw.blocks)) throw new SpaceSchemaError('Space schema must include a blocks array')
  if (raw.blocks.length > MAX_BLOCKS_PER_SPACE) {
    throw new SpaceSchemaError(`Space schema allows at most ${MAX_BLOCKS_PER_SPACE} blocks`)
  }

  const theme = parseSpaceTheme(raw.theme)

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
    const meta = parseBlockMeta(item, id)

    switch (type) {
      case 'metrics': return parseMetricsBlock(id, title, meta, item)
      case 'table': return parseTableBlock(id, title, meta, item)
      case 'kanban': return parseKanbanBlock(id, title, meta, item)
      case 'checklist': return { id, type: 'checklist', title, ...meta } as ChecklistBlock
      case 'timeline': return { id, type: 'timeline', title, ...meta } as TimelineBlock
      case 'chart': return parseChartBlock(id, title, meta, item)
      case 'markdown': return parseMarkdownBlock(id, title, meta, item)
      case 'action_bar': return parseActionBarBlock(id, title, meta, item)
      case 'cards': return parseCardsBlock(id, title, meta, item)
      case 'html': return parseHtmlBlock(id, title, meta, item)
      default:
        throw new SpaceSchemaError(`Unsupported block type "${type}"`)
    }
  })

  const pairedBlocks = new Set<string>()
  for (const block of blocks) {
    if (block.type !== 'html' || !block.viewOf) continue
    for (const sourceId of block.viewOf) {
      if (!blocks.some((source) => source.id === sourceId && source.type !== 'html')) {
        throw new SpaceSchemaError(`html block "${block.id}" viewOf must refer to native blocks`)
      }
      if (pairedBlocks.has(sourceId)) {
        throw new SpaceSchemaError(`Block "${sourceId}" already has an HTML view`)
      }
      pairedBlocks.add(sourceId)
    }
  }

  const schema: SpaceSchema = { ...(theme ? { theme } : {}), blocks }
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
      : targetBlock?.type === 'cards'
        ? ['url']
        : [],
  )
  const imageCols = new Set(
    targetBlock?.type === 'table'
      ? targetBlock.columns.filter((c) => c.kind === 'image').map((c) => c.key)
      : targetBlock?.type === 'cards'
        ? ['image', 'homeLogo', 'awayLogo']
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
      const maxStr = imageCols.has(key) ? 12_000 : 2_000
      if (val.length > maxStr) throw new SpaceSchemaError(`Field "${key}" exceeds ${maxStr} characters`)
      if (urlCols.has(key) && val.trim() && !isSafeHttpUrl(val)) {
        throw new SpaceSchemaError(`Field "${key}" must be an http:// or https:// URL`)
      }
      if (imageCols.has(key) && val.trim() && !isSafeImageUrl(val)) {
        throw new SpaceSchemaError(`Field "${key}" must be an http(s) URL, /api/uploads/ path, or base64 image data URI`)
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
