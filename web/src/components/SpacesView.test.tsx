import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { SpacesSnapshot, SpaceView } from '../types'
import { SpacesView } from './SpacesView'

const ROSTER = {
  chief: { name: 'Chief', emoji: '🧠' },
  scout: { name: 'Scout', emoji: '🔎' },
}

const SPACE_FULL: SpaceView = {
  id: 'space-11111111',
  slug: 'competitor_pricing',
  title: 'Competitor Pricing',
  description: 'Live vendor comparison.',
  icon: '📊',
  kind: 'declarative',
  goalId: 'goal-11111111',
  goalTitle: 'Q2 Pricing Audit',
  grants: [{ botId: 'scout', role: 'editor' }],
  createdAt: 1,
  updatedAt: 1,
  schema: {
    blocks: [
      {
        id: 'kpi',
        type: 'metrics',
        title: 'Summary',
        cards: [
          { label: 'Total vendors', blockId: 'records', agg: 'count' },
          { label: 'Total price', blockId: 'records', agg: 'sum', itemField: 'price', unit: 'USD' },
        ],
      },
      {
        id: 'records',
        type: 'table',
        title: 'Vendors',
        columns: [
          { key: 'price', label: 'Price', kind: 'number' },
          { key: 'site', label: 'Site', kind: 'url' },
        ],
      },
      {
        id: 'board',
        type: 'kanban',
        title: 'Work',
        columns: [
          { key: 'todo', label: 'To do' },
          { key: 'done', label: 'Done' },
        ],
      },
      { id: 'checks', type: 'checklist', title: 'Checklist' },
      { id: 'chart', type: 'chart', title: 'Price Chart', mode: 'horizontal', labelField: 'title', valueField: 'price', sourceBlockId: 'records', unit: 'USD' },
      {
        id: 'acts',
        type: 'action_bar',
        title: 'Actions',
        actions: [{ id: 'refresh', label: 'Refresh prices', botId: 'scout', prompt: 'Check latest prices' }],
      },
    ],
  },
  items: [
    {
      id: 'item-11111111',
      spaceId: 'space-11111111',
      blockId: 'records',
      title: 'Acme Cloud',
      status: 'active',
      data: { price: 120, site: 'https://acme.test' },
      sortOrder: 0,
      tainted: true,
      updatedBy: 'scout',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'item-22222222',
      spaceId: 'space-11111111',
      blockId: 'records',
      title: 'Evil Link',
      status: 'active',
      data: { price: 80, site: 'javascript:alert(1)' },
      sortOrder: 1,
      tainted: false,
      updatedBy: 'operator',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'item-33333333',
      spaceId: 'space-11111111',
      blockId: 'board',
      title: 'Verify Enterprise plan',
      status: 'todo',
      data: {},
      sortOrder: 0,
      tainted: false,
      updatedBy: 'operator',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'item-44444444',
      spaceId: 'space-11111111',
      blockId: 'checks',
      title: 'Sign off sheet',
      status: 'open',
      data: {},
      sortOrder: 0,
      tainted: false,
      updatedBy: 'operator',
      createdAt: 1,
      updatedAt: 1,
    },
  ],
}

const SNAPSHOT: SpacesSnapshot = {
  spaces: [SPACE_FULL],
  templates: [
    { id: 'tracker', icon: '📊' },
    { id: 'kanban', icon: '📋' },
    { id: 'dashboard', icon: '📈' },
    { id: 'blank', icon: '📝' },
  ],
}

describe('SpacesView', () => {
  it('creates a new space from template with teammate grants', async () => {
    const createSpy = vi.spyOn(api, 'createSpace').mockResolvedValue({
      space: SPACE_FULL,
      snapshot: SNAPSHOT,
    })
    const onChange = vi.fn()
    render(
      <SpacesView
        embedded
        state={{ spaces: [], templates: SNAPSHOT.templates }}
        roster={ROSTER}
        onChange={onChange}
        onOpenThread={() => {}}
      />,
    )

    await userEvent.click(screen.getAllByRole('button', { name: 'New space' })[0]!)
    await userEvent.type(screen.getByPlaceholderText(/Competitor Pricing Tracker/), 'Competitor Pricing')
    await userEvent.click(screen.getByRole('radio', { name: 'Emerald' }))
    await userEvent.selectOptions(screen.getByLabelText('Scout access'), 'editor')
    await userEvent.click(screen.getByRole('button', { name: 'Create space' }))

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Competitor Pricing',
      template: 'tracker',
      theme: { accent: 'emerald', style: 'editorial' },
      grants: [{ botId: 'scout', role: 'editor' }],
    }))
    expect(onChange).toHaveBeenCalledWith(SNAPSHOT)
    createSpy.mockRestore()
  })

  it('supports Design with AI invoking the built-in space-design skill and renders donut/area charts, Bento spans, and theme switching', async () => {
    const onDesignWithBot = vi.fn().mockResolvedValue(undefined)
    const updateSpy = vi.spyOn(api, 'updateSpace').mockResolvedValue({
      space: SPACE_FULL,
      snapshot: SNAPSHOT,
    })

    const richSpace: SpaceView = {
      ...SPACE_FULL,
      schema: {
        theme: { accent: 'indigo', style: 'editorial' },
        blocks: [
          {
            id: 'kpi',
            type: 'metrics',
            title: 'Pulse',
            span: 'full',
            cards: [{ label: 'Vendors', blockId: 'records', agg: 'count', tone: 'accent', target: 4 }],
          },
          { id: 'mix', type: 'chart', title: 'Price Share', span: 'half', mode: 'donut', labelField: 'title', valueField: 'price', sourceBlockId: 'records', unit: 'USD' },
          { id: 'trend', type: 'chart', title: 'Price Trend', span: 'half', mode: 'area', labelField: 'title', valueField: 'price', sourceBlockId: 'records', unit: 'USD' },
          { id: 'note', type: 'markdown', title: 'Takeaway', span: 'full', variant: 'callout', content: 'Enterprise tiers rose 10%.' },
        ],
      },
    }

    const { container } = render(
      <SpacesView
        embedded
        state={{ spaces: [richSpace], templates: SNAPSHOT.templates }}
        roster={ROSTER}
        onChange={() => {}}
        onOpenThread={() => {}}
        onDesignWithBot={onDesignWithBot}
      />,
    )

    expect(container.querySelector('.space-canvas[data-space-accent="indigo"]')).toBeTruthy()
    expect(container.querySelector('.space-block.space-span-half')).toBeTruthy()
    expect(container.querySelector('.space-block-callout')).toBeTruthy()
    expect(screen.getByText('Target 4 · 50%')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Price Share' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Price Trend' })).toBeInTheDocument()

    // Switch color theme directly from Space hero toolbar
    await userEvent.click(screen.getByRole('button', { name: 'Switch color theme to Rose' }))
    expect(updateSpy).toHaveBeenCalledWith(richSpace.id, {
      schema: expect.objectContaining({ theme: { accent: 'rose', style: 'editorial' } }),
    })

    // Trigger Design with AI flow
    await userEvent.click(screen.getByRole('button', { name: 'Design with AI' }))
    await userEvent.type(screen.getByPlaceholderText(/AI model pricing/), 'Build an AI vendor comparison radar')
    await userEvent.click(screen.getByRole('button', { name: 'Start designing' }))
    expect(onDesignWithBot).toHaveBeenCalledWith(
      'chief',
      expect.stringContaining('read_skill("space-design")'),
    )
    updateSpy.mockRestore()
  })

  it('renders rich image cards and sandboxed full HTML blocks with inline editing and strict null-origin isolation', async () => {
    const updateSpy = vi.spyOn(api, 'updateSpace').mockResolvedValue({
      space: SPACE_FULL,
      snapshot: SNAPSHOT,
    })

    const mediaSpace: SpaceView = {
      ...SPACE_FULL,
      schema: {
        theme: { accent: 'rose', style: 'editorial' },
        blocks: [
          { id: 'gallery', type: 'cards', title: 'Showcase', columns: 3, aspect: 'wide', span: 'full' },
          {
            id: 'canvas',
            type: 'html',
            title: 'Bespoke Canvas',
            frameless: true,
            span: 'full',
            html: '<base href="https://evil.test"><div class="hero"><h2>Live Studio</h2><img src="https://cdn.example/hero.jpg" /></div>',
          },
        ],
      },
      items: [
        {
          id: 'item-card1',
          spaceId: SPACE_FULL.id,
          blockId: 'gallery',
          title: 'Claude 4.5',
          status: 'featured',
          data: {
            eyebrow: 'Frontier Model',
            badge: 'Featured',
            image: 'https://cdn.example/claude.png',
            metric: '$3 / 1M',
            metricLabel: 'input tokens',
            summary: 'High-craft reasoning and long context.',
            tags: 'Coding, Vision',
            url: 'https://anthropic.com',
            context: '200K',
          },
          sortOrder: 0,
          tainted: false,
          updatedBy: 'operator',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'item-card2',
          spaceId: SPACE_FULL.id,
          blockId: 'gallery',
          title: 'Blocked Image Card',
          status: '',
          data: { image: 'javascript:alert(1)' },
          sortOrder: 1,
          tainted: false,
          updatedBy: 'operator',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }

    render(
      <SpacesView
        embedded
        state={{ spaces: [mediaSpace], templates: SNAPSHOT.templates }}
        roster={ROSTER}
        onChange={() => {}}
        onOpenThread={() => {}}
      />,
    )

    // Rich visual card renders cover image, eyebrow, badge, metric, summary, tags, spec, safe link
    const coverImg = screen.getByAltText('Claude 4.5')
    expect(coverImg).toHaveAttribute('src', 'https://cdn.example/claude.png')
    expect(screen.getByText('Frontier Model')).toBeInTheDocument()
    expect(screen.getByText('$3 / 1M')).toBeInTheDocument()
    expect(screen.getByText('Coding')).toBeInTheDocument()
    expect(screen.getByText('200K')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /anthropic\.com/ })).toHaveAttribute('href', 'https://anthropic.com')
    // Unsafe javascript: image does not render an <img>
    expect(screen.queryByAltText('Blocked Image Card')).toBeNull()

    // Sandboxed HTML iframe enforces allow-scripts WITHOUT allow-same-origin, injects strict CSP, strips <base>
    const iframe = screen.getByTitle('Bespoke Canvas') as HTMLIFrameElement
    expect(iframe.tagName).toBe('IFRAME')
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    const srcDoc = iframe.getAttribute('srcdoc') ?? ''
    expect(srcDoc).toContain("connect-src 'none'")
    expect(srcDoc).toContain('window.SPACE_DATA')
    expect(srcDoc).toContain('Live Studio')
    expect(srcDoc).not.toContain('<base href=')

    // Inline HTML editing saves back into space schema
    await userEvent.click(screen.getByRole('button', { name: 'Edit HTML' }))
    const editor = screen.getByPlaceholderText(/Write HTML/)
    await userEvent.clear(editor)
    await userEvent.type(editor, '<p>Updated HTML</p>')
    await userEvent.click(screen.getByRole('button', { name: 'Save HTML' }))
    expect(updateSpy).toHaveBeenCalledWith(mediaSpace.id, {
      schema: expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({ id: 'canvas', type: 'html', html: '<p>Updated HTML</p>' }),
        ]),
      }),
    })
    updateSpy.mockRestore()
  })

  it('switches between native cards and full HTML, then sends new and edited records to the same canvas', async () => {
    const html = '<!doctype html><html data-space-live><head><script>window.firstCount = window.SPACE_DATA.items.length</script></head><body><main></main></body></html>'
    const space: SpaceView = {
      ...SPACE_FULL,
      schema: {
        blocks: [
          { id: 'competitors', type: 'cards', title: 'Competitors', variant: 'competitor' },
          { id: 'canvas', type: 'html', title: 'Market pulse', html, frameless: true, viewOf: ['competitors'] },
        ],
      },
      items: [{ ...SPACE_FULL.items[0]!, blockId: 'competitors', title: 'Aster Cloud', data: { summary: 'Starter plan' } }],
    }
    const page = (view: SpaceView) => (
      <SpacesView embedded state={{ spaces: [view], templates: [] }} roster={ROSTER} onChange={() => {}} onOpenThread={() => {}} />
    )
    const { rerender } = render(page(space))
    expect(screen.getByText('Aster Cloud')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'HTML canvas' }))
    const frame = screen.getByTitle('Market pulse') as HTMLIFrameElement
    const srcDoc = frame.srcdoc
    expect(srcDoc.indexOf('window.SPACE_DATA =')).toBeLessThan(srcDoc.indexOf('window.firstCount ='))
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    const updated: SpaceView = {
      ...space,
      items: [
        { ...space.items[0]!, data: { summary: 'Updated plan' } },
        { ...space.items[0]!, id: 'item-new', title: 'Nova Labs', data: { summary: 'New record' } },
      ],
    }
    rerender(page(updated))
    expect(screen.getByTitle('Market pulse')).toBe(frame)
    expect(frame.srcdoc).toBe(srcDoc)
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'osb-space-data',
      data: expect.objectContaining({
        items: [
          expect.objectContaining({ title: 'Aster Cloud', data: { summary: 'Updated plan' } }),
          expect.objectContaining({ title: 'Nova Labs' }),
        ],
      }),
    }), '*')
    await userEvent.click(screen.getByRole('button', { name: 'Cards' }))
    expect(screen.getByText('Updated plan')).toBeVisible()
    expect(screen.getByText('Nova Labs')).toBeVisible()
  })

  it('renders two logos and a zero score, and edits a matchup without discarding its existing fields', async () => {
    const data = {
      awayTeam: 'Away Team', homeTeam: 'Home Team',
      awayLogo: 'https://league.example/away.svg', homeLogo: 'https://league.example/home.svg',
      awayScore: 0, homeScore: 17, awayRecord: '5–3', startsAt: '2026-11-26T20:00:00Z',
    }
    const game = { ...SPACE_FULL.items[0]!, blockId: 'games', title: 'Away Team @ Home Team', status: 'live', data }
    const space: SpaceView = {
      ...SPACE_FULL,
      schema: { blocks: [{ id: 'games', type: 'cards', title: 'Scores', variant: 'matchup' }] },
      items: [game],
    }
    const snapshot = { spaces: [space], templates: [] }
    const update = vi.spyOn(api, 'updateSpaceItem').mockResolvedValue({ item: game, space, snapshot })
    const { container } = render(
      <SpacesView embedded state={snapshot} roster={ROSTER} onChange={() => {}} onOpenThread={() => {}} />,
    )
    expect(container.querySelector('img[src="https://league.example/away.svg"]')).toBeInTheDocument()
    expect(container.querySelector('img[src="https://league.example/home.svg"]')).toBeInTheDocument()
    expect(screen.getByText('0 : 17')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    const score = screen.getByLabelText('Away score')
    await userEvent.clear(score)
    await userEvent.type(score, '22')
    await userEvent.click(screen.getByRole('button', { name: 'Save card' }))
    expect(update).toHaveBeenCalledWith(space.id, game.id, expect.objectContaining({
      data: expect.objectContaining({ awayScore: 22, awayLogo: data.awayLogo, homeLogo: data.homeLogo, awayRecord: '5–3' }),
    }))
    update.mockRestore()
  })

  it('renders live metrics, safe links only, tainted badges, kanban move, checklist toggle, SVG chart, and triggers actions', async () => {
    const updSpy = vi.spyOn(api, 'updateSpaceItem').mockResolvedValue({
      item: SPACE_FULL.items[2]!,
      space: SPACE_FULL,
      snapshot: SNAPSHOT,
    })
    const grantSpy = vi.spyOn(api, 'setSpaceGrants').mockResolvedValue({
      space: SPACE_FULL,
      snapshot: SNAPSHOT,
    })
    const actSpy = vi.spyOn(api, 'triggerSpaceAction').mockResolvedValue({
      botId: 'scout',
      threadId: 'dm:scout',
    })
    const onOpenThread = vi.fn()
    const onOpenGoal = vi.fn()

    render(
      <SpacesView
        embedded
        state={SNAPSHOT}
        roster={ROSTER}
        onChange={() => {}}
        onOpenThread={onOpenThread}
        onOpenGoal={onOpenGoal}
      />,
    )

    // Live aggregated metrics: 2 vendors, sum = 200 USD
    expect(screen.getByText('200')).toBeInTheDocument()
    // Tainted badge rendered
    expect(screen.getByText('Based on outside data')).toBeInTheDocument()
    // Safe HTTPS link renders as <a>, javascript: URL does NOT render as a link
    const safeLink = screen.getByRole('link', { name: /acme\.test/ })
    expect(safeLink).toHaveAttribute('href', 'https://acme.test')
    expect(screen.queryByRole('link', { name: /javascript:/ })).toBeNull()
    // Native SVG chart rendered
    expect(screen.getByRole('img', { name: 'Price Chart' })).toBeInTheDocument()

    // Linked goal button
    await userEvent.click(screen.getByRole('button', { name: 'Goal: Q2 Pricing Audit' }))
    expect(onOpenGoal).toHaveBeenCalledTimes(1)

    // Move Kanban card right
    await userEvent.click(screen.getByRole('button', { name: 'Move right' }))
    expect(updSpy).toHaveBeenCalledWith('space-11111111', 'item-33333333', { status: 'done' })

    // Toggle Checklist item
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sign off sheet' }))
    expect(updSpy).toHaveBeenCalledWith('space-11111111', 'item-44444444', { status: 'done' })

    // Update Chief role to viewer
    await userEvent.selectOptions(screen.getByLabelText('Chief space role'), 'viewer')
    expect(grantSpy).toHaveBeenCalledWith('space-11111111', [
      { botId: 'scout', role: 'editor' },
      { botId: 'chief', role: 'viewer' },
    ])

    // Trigger safe action button
    await userEvent.click(screen.getByRole('button', { name: /Refresh prices/ }))
    expect(actSpy).toHaveBeenCalledWith('space-11111111', 'refresh')
    expect(onOpenThread).toHaveBeenCalledWith('dm:scout')

    updSpy.mockRestore()
    grantSpy.mockRestore()
    actSpy.mockRestore()
  })
})
