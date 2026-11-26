import { describe, expect, it } from 'vitest'
import {
  isSafeHttpUrl,
  isSafeImageUrl,
  MAX_BLOCKS_PER_SPACE,
  parseSpaceSchema,
  sanitizeItemData,
  SpaceSchemaError,
} from '../src/spaces/schema.js'
import { buildTemplateSchema } from '../src/spaces/templates.js'
import { SPACE_TEMPLATE_IDS, type TableBlock } from '../src/spaces/types.js'

describe('spaces declarative schema validation', () => {
  it('validates the built-in templates and the original block types', () => {
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

  it('validates visual design primitives (theme, Bento spans, tones, kanban colors, donut/area charts, callout markdown)', () => {
    const designed = parseSpaceSchema({
      theme: { accent: 'emerald', style: 'editorial' },
      blocks: [
        {
          id: 'kpi',
          type: 'metrics',
          title: 'Pulse',
          subtitle: 'Live weekly numbers',
          span: 'full',
          cards: [{ label: 'Revenue', value: '80', unit: 'k', tone: 'positive', target: 100 }],
        },
        { id: 'trend', type: 'chart', title: 'Trend', span: 'wide', mode: 'area', labelField: 'title', valueField: 'v' },
        { id: 'share', type: 'chart', title: 'Mix', span: 'narrow', mode: 'donut', labelField: 'title', valueField: 'v' },
        { id: 'kb', type: 'kanban', title: 'Flow', span: 'full', columns: [{ key: 'todo', label: 'Todo', color: 'indigo' }] },
        { id: 'note', type: 'markdown', title: 'Takeaway', span: 'half', variant: 'callout', content: 'Key insight.' },
      ],
    })
    expect(designed.theme).toEqual({ accent: 'emerald', style: 'editorial' })
    expect(designed.blocks[0]!.span).toBe('full')
    expect(designed.blocks[1]!.span).toBe('wide')
    expect(designed.blocks[2]!.span).toBe('narrow')

    expect(() => parseSpaceSchema({ theme: { accent: 'neon-pink' }, blocks: [] })).toThrow(SpaceSchemaError)
    expect(() => parseSpaceSchema({ blocks: [{ id: 'a', type: 'checklist', title: 'X', span: 'giant' }] })).toThrow(SpaceSchemaError)
    expect(() => parseSpaceSchema({ blocks: [{ id: 'a', type: 'chart', title: 'C', mode: '3d-pie', valueField: 'v' }] })).toThrow(SpaceSchemaError)
    expect(() => parseSpaceSchema({
      blocks: [{ id: 'a', type: 'metrics', title: 'M', cards: [{ label: 'Bad', target: -5 }] }],
    })).toThrow(SpaceSchemaError)
  })

  it('validates cards blocks, full html blocks, and safe image URLs', () => {
    const rich = parseSpaceSchema({
      theme: { accent: 'rose', style: 'editorial' },
      blocks: [
        { id: 'gallery', type: 'cards', title: 'Showcase', columns: 3, aspect: 'wide', span: 'full' },
        { id: 'canvas', type: 'html', title: 'Custom HTML', frameless: true, height: 520, html: '<section class="hero"><h1>Hello</h1></section>' },
        { id: 'tbl', type: 'table', title: 'With Thumbs', columns: [{ key: 'logo', label: 'Logo', kind: 'image' }] },
      ],
    })
    expect(rich.blocks).toHaveLength(3)
    expect(rich.blocks[0]!.type).toBe('cards')
    expect(rich.blocks[1]!.type).toBe('html')

    expect(isSafeImageUrl('https://cdn.example.com/pic.png')).toBe(true)
    expect(isSafeImageUrl('/api/uploads/abc123.png')).toBe(true)
    expect(isSafeImageUrl('/api/screenshots/scout/12.png')).toBe(true)
    expect(isSafeImageUrl('/api/spaces/space-11111111/assets/0123456789abcdef.png')).toBe(true)
    expect(isSafeImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeImageUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false)
    expect(isSafeImageUrl('/api/uploads/../auth-token')).toBe(false)

    const cardsBlock = rich.blocks[0]!
    expect(sanitizeItemData({ image: '/api/spaces/space-11111111/assets/0123456789abcdef.png', url: 'https://acme.test', metric: '$29' }, cardsBlock)).toEqual({
      image: '/api/spaces/space-11111111/assets/0123456789abcdef.png',
      url: 'https://acme.test',
      metric: '$29',
    })
    expect(() => sanitizeItemData({ image: 'javascript:alert(1)' }, cardsBlock)).toThrow(SpaceSchemaError)
    expect(() => sanitizeItemData({ url: 'javascript:alert(1)' }, cardsBlock)).toThrow(SpaceSchemaError)

    expect(() => parseSpaceSchema({ blocks: [{ id: 'bad', type: 'cards', title: 'Bad', columns: 5 }] })).toThrow(SpaceSchemaError)
    expect(() => parseSpaceSchema({ blocks: [{ id: 'bad', type: 'html', title: 'Bad' }] })).toThrow(SpaceSchemaError)
    expect(() => parseSpaceSchema({ blocks: [{ id: 'bad', type: 'html', title: 'Bad', html: '<p>x</p>', height: 50 }] })).toThrow(SpaceSchemaError)
  })

  it('pairs full HTML views with native radar and scoreboard blocks, and validates both team logo fields', () => {
    const radar = parseSpaceSchema(buildTemplateSchema('radar', 'chief'))
    expect(radar.blocks).toContainEqual(expect.objectContaining({ id: 'competitors', type: 'cards', variant: 'competitor' }))
    expect(radar.blocks).toContainEqual(expect.objectContaining({
      type: 'html', viewOf: ['competitors'], html: expect.stringMatching(/^<!doctype html>/i),
    }))
    const scoreboard = parseSpaceSchema(buildTemplateSchema('scoreboard', 'chief'))
    expect(scoreboard.blocks).toContainEqual(expect.objectContaining({ type: 'html', viewOf: ['games', 'standings'] }))
    const games = scoreboard.blocks.find((block) => block.id === 'games')!
    expect(sanitizeItemData({
      awayLogo: 'https://league.example/away.svg',
      homeLogo: '/api/spaces/space-11111111/assets/0123456789abcdef.png',
      awayScore: 0,
    }, games)).toEqual({
      awayLogo: 'https://league.example/away.svg',
      homeLogo: '/api/spaces/space-11111111/assets/0123456789abcdef.png',
      awayScore: 0,
    })
    expect(() => sanitizeItemData({ homeLogo: '/api/uploads/../auth-token' }, games)).toThrow(SpaceSchemaError)
    expect(() => parseSpaceSchema({
      blocks: [{ id: 'canvas', type: 'html', title: 'Canvas', html: '<main></main>', viewOf: ['missing'] }],
    })).toThrow(/refer to native blocks/)
  })
})
