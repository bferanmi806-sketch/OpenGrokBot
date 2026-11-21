import type { SpaceSchema, SpaceTemplateId, SpaceTemplateMeta } from './types.js'

export const SPACE_TEMPLATES: readonly SpaceTemplateMeta[] = [
  { id: 'tracker', icon: '📊' },
  { id: 'kanban', icon: '📋' },
  { id: 'dashboard', icon: '📈' },
  { id: 'blank', icon: '📝' },
]

export function defaultIconForTemplate(template: SpaceTemplateId): string {
  return SPACE_TEMPLATES.find((t) => t.id === template)?.icon ?? '📊'
}

export function buildTemplateSchema(template: SpaceTemplateId, defaultBotId: string): SpaceSchema {
  switch (template) {
    case 'tracker':
      return {
        blocks: [
          {
            id: 'kpi',
            type: 'metrics',
            title: 'Summary',
            cards: [
              { label: 'Total entries', blockId: 'records', agg: 'count' },
              { label: 'Active', blockId: 'records', agg: 'count', filterStatus: 'active' },
              { label: 'Total score / value', blockId: 'records', agg: 'sum', itemField: 'value' },
            ],
          },
          {
            id: 'records',
            type: 'table',
            title: 'Records',
            columns: [
              { key: 'category', label: 'Category', kind: 'badge' },
              { key: 'value', label: 'Value', kind: 'number' },
              { key: 'updated', label: 'Updated', kind: 'date' },
              { key: 'link', label: 'Source', kind: 'url' },
              { key: 'note', label: 'Notes', kind: 'text' },
            ],
          },
          {
            id: 'notes',
            type: 'markdown',
            title: 'Notes',
            content: 'Keep methodology, definitions, or review notes here.',
          },
          ...(defaultBotId
            ? [{
              id: 'actions',
              type: 'action_bar' as const,
              title: 'Quick actions',
              actions: [
                {
                  id: 'refresh',
                  label: 'Ask teammate to refresh table',
                  botId: defaultBotId,
                  prompt: 'Review this space, check for stale entries, and update the records block with the latest verified data.',
                },
              ],
            }]
            : []),
        ],
      }

    case 'kanban':
      return {
        blocks: [
          {
            id: 'kpi',
            type: 'metrics',
            title: 'Board status',
            cards: [
              { label: 'Backlog', blockId: 'board', agg: 'count', filterStatus: 'backlog' },
              { label: 'In progress', blockId: 'board', agg: 'count', filterStatus: 'doing' },
              { label: 'Done', blockId: 'board', agg: 'count', filterStatus: 'done' },
            ],
          },
          {
            id: 'board',
            type: 'kanban',
            title: 'Board',
            columns: [
              { key: 'backlog', label: 'Backlog' },
              { key: 'doing', label: 'In progress' },
              { key: 'review', label: 'Review' },
              { key: 'done', label: 'Done' },
            ],
          },
          {
            id: 'checks',
            type: 'checklist',
            title: 'Checklist',
          },
        ],
      }

    case 'dashboard':
      return {
        blocks: [
          {
            id: 'kpi',
            type: 'metrics',
            title: 'Key metrics',
            cards: [
              { label: 'Data points', blockId: 'series', agg: 'count' },
              { label: 'Total', blockId: 'series', agg: 'sum', itemField: 'value' },
              { label: 'Average', blockId: 'series', agg: 'avg', itemField: 'value' },
            ],
          },
          {
            id: 'series',
            type: 'chart',
            title: 'Breakdown',
            mode: 'horizontal',
            labelField: 'title',
            valueField: 'value',
          },
          {
            id: 'events',
            type: 'timeline',
            title: 'Timeline',
          },
          {
            id: 'notes',
            type: 'markdown',
            title: 'Summary notes',
            content: 'Add high-level takeaways here.',
          },
        ],
      }

    case 'blank':
    default:
      return {
        blocks: [
          {
            id: 'notes',
            type: 'markdown',
            title: 'Notes',
            content: 'Start with notes or add declarative blocks anytime.',
          },
        ],
      }
  }
}
