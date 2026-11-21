import { describe, expect, it } from 'vitest'
import {
  isSafeHttpUrl,
  MAX_BLOCKS_PER_SPACE,
  parseSpaceSchema,
  sanitizeItemData,
  SpaceSchemaError,
} from '../src/spaces/schema.js'
import { buildTemplateSchema } from '../src/spaces/templates.js'
import { SPACE_TEMPLATE_IDS, type TableBlock } from '../src/spaces/types.js'

describe('spaces declarative schema validation', () => {
  it('validates all 4 built-in templates and all 8 declarative block types', () => {
    for (const id of SPACE_TEMPLATE_IDS) {
      const schema = parseSpaceSchema(buildTemplateSchema(id, 'chief'))
      expect(schema.blocks.length).toBeGreaterThan(0)
    }

    const full = parseSpaceSchema({
      blocks: [
        { id: 'kpi', type: 'metrics', title: 'KPIs', cards: [{ label: 'Count', blockId: 'tbl', agg: 'count' }] },
        { id: 'tbl', type: 'table', title: 'Table', columns: [{ key: 'url', label: 'URL', kind: 'url' }, { key: 'price', label: 'Price', kind: 'number' }] },
        { id: 'kb', type: 'kanban', title: 'Board', columns: [{ key: 'todo', label: 'To do' }, { key: 'done', label: 'Done' }] },
        { id: 'chk', type: 'checklist', title: 'Checks' },
        { id: 'tl', type: 'timeline', title: 'Events' },
        { id: 'ch', type: 'chart', title: 'Chart', mode: 'bar', labelField: 'title', valueField: 'price', sourceBlockId: 'tbl', unit: 'USD' },
        { id: 'md', type: 'markdown', title: 'Notes', content: '# Hello\nSafe markdown only.' },
        { id: 'act', type: 'action_bar', title: 'Actions', actions: [{ id: 'refresh', label: 'Refresh', botId: 'chief', prompt: 'Update prices', confirm: true }] },
      ],
    })
    expect(full.blocks).toHaveLength(8)
  })

  it('rejects unknown block types, duplicate ids, excessive blocks, and prototype pollution keys', () => {
    expect(() => parseSpaceSchema({ blocks: [{ id: 'bad', type: 'iframe', title: 'Script' }] })).toThrow(SpaceSchemaError)
    expect(() => parseSpaceSchema({
      blocks: [
        { id: 'dup', type: 'checklist', title: 'One' },
        { id: 'dup', type: 'timeline', title: 'Two' },
      ],
    })).toThrow(/Duplicate block\.id/)

    const tooMany = Array.from({ length: MAX_BLOCKS_PER_SPACE + 1 }, (_, i) => ({
      id: `b${i}`,
      type: 'checklist',
      title: `Block ${i}`,
    }))
    expect(() => parseSpaceSchema({ blocks: tooMany })).toThrow(/at most/)

    const protoObj = JSON.parse('{"blocks":[],"__proto__":{"polluted":true}}')
    expect(() => parseSpaceSchema(protoObj)).toThrow(/Forbidden key/)
  })

  it('enforces safe http(s) URLs and flat primitive item data', () => {
    expect(isSafeHttpUrl('https://example.com/pricing')).toBe(true)
    expect(isSafeHttpUrl('http://localhost:3000')).toBe(true)
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false)

    const tableBlock: TableBlock = {
      id: 'tbl',
      type: 'table',
      title: 'Vendors',
      columns: [
        { key: 'site', label: 'Site', kind: 'url' },
        { key: 'cost', label: 'Cost', kind: 'number' },
      ],
    }

    expect(sanitizeItemData({ site: 'https://acme.test', cost: 49 }, tableBlock)).toEqual({
      site: 'https://acme.test',
      cost: 49,
    })
    expect(() => sanitizeItemData({ site: 'javascript:alert(1)' }, tableBlock)).toThrow(/http:\/\/ or https:\/\//)
    expect(() => sanitizeItemData({ nested: { bad: true } }, tableBlock)).toThrow(/string, number, boolean, or null/)
    const pollutedItem = JSON.parse('{"constructor":"bad"}')
    expect(() => sanitizeItemData(pollutedItem, tableBlock)).toThrow(/Forbidden key/)
  })
})
