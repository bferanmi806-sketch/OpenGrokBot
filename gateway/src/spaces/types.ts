export const SPACE_KINDS = ['declarative'] as const
export type SpaceKind = (typeof SPACE_KINDS)[number]

export const SPACE_ROLES = ['viewer', 'editor'] as const
export type SpaceRole = (typeof SPACE_ROLES)[number]

export const SPACE_BLOCK_TYPES = [
  'metrics',
  'table',
  'kanban',
  'checklist',
  'timeline',
  'chart',
  'markdown',
  'action_bar',
  'cards',
  'html',
] as const
export type SpaceBlockType = (typeof SPACE_BLOCK_TYPES)[number]

export const SPACE_TEMPLATE_IDS = ['radar', 'scoreboard', 'tracker', 'kanban', 'dashboard', 'cards', 'html', 'blank'] as const
export type SpaceTemplateId = (typeof SPACE_TEMPLATE_IDS)[number]

export const CARDS_ASPECTS = ['wide', 'square', 'compact'] as const
export type CardsAspect = (typeof CARDS_ASPECTS)[number]
export const CARD_VARIANTS = ['competitor', 'matchup'] as const
export type CardVariant = (typeof CARD_VARIANTS)[number]

export const SPACE_ACCENTS = ['slate', 'blue', 'indigo', 'emerald', 'amber', 'rose'] as const
export type SpaceAccent = (typeof SPACE_ACCENTS)[number]

export const SPACE_HEADER_STYLES = ['editorial', 'minimal'] as const
export type SpaceHeaderStyle = (typeof SPACE_HEADER_STYLES)[number]

export const SPACE_BLOCK_SPANS = ['full', 'wide', 'half', 'narrow'] as const
export type SpaceBlockSpan = (typeof SPACE_BLOCK_SPANS)[number]

export const METRIC_TONES = ['neutral', 'accent', 'positive', 'warning', 'danger'] as const
export type MetricTone = (typeof METRIC_TONES)[number]

export const CHART_MODES = ['bar', 'horizontal', 'donut', 'area'] as const
export type ChartMode = (typeof CHART_MODES)[number]

export const MARKDOWN_VARIANTS = ['default', 'callout'] as const
export type MarkdownVariant = (typeof MARKDOWN_VARIANTS)[number]

export type SpaceTheme = {
  accent: SpaceAccent
  style?: SpaceHeaderStyle
}

export type MetricCardDef = {
  label: string
  value?: string
  unit?: string
  trend?: string
  tone?: MetricTone
  target?: number
  blockId?: string
  agg?: 'count' | 'sum' | 'avg'
  itemField?: string
  filterStatus?: string
}

export type TableColumnKind = 'text' | 'number' | 'badge' | 'url' | 'date' | 'image'
export type TableColumnDef = {
  key: string
  label: string
  kind: TableColumnKind
}

export type KanbanColumnDef = {
  key: string
  label: string
  color?: SpaceAccent
}

export type SpaceActionDef = {
  id: string
  label: string
  botId: string
  prompt: string
  confirm?: boolean
}

type BlockMeta = {
  id: string
  title: string
  subtitle?: string
  span?: SpaceBlockSpan
}

export type MetricsBlock = BlockMeta & {
  type: 'metrics'
  cards: MetricCardDef[]
}

export type TableBlock = BlockMeta & {
  type: 'table'
  columns: TableColumnDef[]
}

export type KanbanBlock = BlockMeta & {
  type: 'kanban'
  columns: KanbanColumnDef[]
}

export type ChecklistBlock = BlockMeta & {
  type: 'checklist'
}

export type TimelineBlock = BlockMeta & {
  type: 'timeline'
}

export type ChartBlock = BlockMeta & {
  type: 'chart'
  mode: ChartMode
  labelField: string
  valueField: string
  unit?: string
  sourceBlockId?: string
}

export type MarkdownBlock = BlockMeta & {
  type: 'markdown'
  content: string
  variant?: MarkdownVariant
}

export type ActionBarBlock = BlockMeta & {
  type: 'action_bar'
  actions: SpaceActionDef[]
}

export type CardsBlock = BlockMeta & {
  type: 'cards'
  columns?: 2 | 3
  aspect?: CardsAspect
  variant?: CardVariant
}

export type HtmlBlock = BlockMeta & {
  type: 'html'
  html: string
  height?: number
  frameless?: boolean
  viewOf?: string[]
}

export type SpaceBlock =
  | MetricsBlock
  | TableBlock
  | KanbanBlock
  | ChecklistBlock
  | TimelineBlock
  | ChartBlock
  | MarkdownBlock
  | ActionBarBlock
  | CardsBlock
  | HtmlBlock

export type SpaceSchema = {
  theme?: SpaceTheme
  blocks: SpaceBlock[]
}

export type SpaceItemPrimitive = string | number | boolean | null
export type SpaceItemData = Record<string, SpaceItemPrimitive>

export type SpaceRow = {
  id: string
  slug: string
  title: string
  description: string
  icon: string
  kind: SpaceKind
  goalId: string | null
  schema: SpaceSchema
  createdAt: number
  updatedAt: number
}

export type SpaceItemRow = {
  id: string
  spaceId: string
  blockId: string
  title: string
  status: string
  data: SpaceItemData
  sortOrder: number
  tainted: boolean
  updatedBy: string
  createdAt: number
  updatedAt: number
}

export type SpaceGrant = {
  botId: string
  role: SpaceRole
}

export type SpaceView = SpaceRow & {
  items: SpaceItemRow[]
  grants: SpaceGrant[]
  goalTitle: string | null
}

export type SpaceTemplateMeta = {
  id: SpaceTemplateId
  icon: string
}

export type SpacesSnapshot = {
  spaces: SpaceView[]
  templates: SpaceTemplateMeta[]
}

export type SpaceUpdatedPayload = {
  spaceId: string
  spaceTitle: string
  kind: 'space' | 'schema' | 'item'
  summary: string
  diff: string
  tainted?: boolean
  by?: 'operator' | 'bot'
}
