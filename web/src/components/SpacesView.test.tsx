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

    await userEvent.click(screen.getByRole('button', { name: 'New space' }))
    await userEvent.type(screen.getByPlaceholderText(/Competitor Pricing Tracker/), 'Competitor Pricing')
    await userEvent.selectOptions(screen.getByLabelText('Scout access'), 'editor')
    await userEvent.click(screen.getByRole('button', { name: 'Create space' }))

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Competitor Pricing',
      template: 'tracker',
      grants: [{ botId: 'scout', role: 'editor' }],
    }))
    expect(onChange).toHaveBeenCalledWith(SNAPSHOT)
    createSpy.mockRestore()
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
