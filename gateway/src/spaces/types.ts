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
] as const
export type SpaceBlockType = (typeof SPACE_BLOCK_TYPES)[number]

export const SPACE_TEMPLATE_IDS = ['tracker', 'kanban', 'dashboard', 'blank'] as const
export type SpaceTemplateId = (typeof SPACE_TEMPLATE_IDS)[number]

export type MetricCardDef = {
  label: string
  value?: string
  unit?: string
  trend?: string
  blockId?: string
  agg?: 'count' | 'sum' | 'avg'
  itemField?: string
  filterStatus?: string
}

export type TableColumnKind = 'text' | 'number' | 'badge' | 'url' | 'date'
export type TableColumnDef = {
  key: string
  label: string
  kind: TableColumnKind
}

export type KanbanColumnDef = {
  key: string
  label: string
}

export type SpaceActionDef = {
  id: string
  label: string
  botId: string
  prompt: string
  confirm?: boolean
}

export type MetricsBlock = {
  id: string
  type: 'metrics'
  title: string
  cards: MetricCardDef[]
}

export type TableBlock = {
  id: string
  type: 'table'
  title: string
  columns: TableColumnDef[]
}

export type KanbanBlock = {
  id: string
  type: 'kanban'
  title: string
  columns: KanbanColumnDef[]
}

export type ChecklistBlock = {
  id: string
  type: 'checklist'
  title: string
}

export type TimelineBlock = {
  id: string
  type: 'timeline'
  title: string
}

export type ChartBlock = {
  id: string
  type: 'chart'
  title: string
  mode: 'bar' | 'horizontal'
  labelField: string
  valueField: string
  unit?: string
  sourceBlockId?: string
}

export type MarkdownBlock = {
  id: string
  type: 'markdown'
  title: string
  content: string
}

export type ActionBarBlock = {
  id: string
  type: 'action_bar'
  title: string
  actions: SpaceActionDef[]
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

export type SpaceSchema = {
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
