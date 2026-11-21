import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../i18n'
import type { QuietDigestPayload } from '../types'
import { QuietDigestChip } from './QuietDigestChip'

describe('QuietDigestChip', () => {
  it('renders singular title, Quiet Hours window, report lines with closing, and mode tag', () => {
    const payload: QuietDigestPayload = {
      windowStart: '22:00',
      windowEnd: '08:00',
      itemCount: 1,
      items: [
        {
          id: 1,
          routineId: 4,
          routineName: 'Inbox watch',
          routineMode: 'watch',
          kind: 'report',
          summary: '2 VIP emails',
          report: {
            lines: [
              { system: 'Gmail', result: '2 unread threads from Acme', count: '2' },
              { system: 'Calendar', result: 'No conflicts tomorrow' },
            ],
            closing: 'Ready for your morning review.',
          },
          createdAt: Date.UTC(2026, 10, 21, 6, 30),
        },
      ],
    }

    const { container } = render(<QuietDigestChip payload={payload} />)
    expect(screen.getByText('Morning digest · 1 update')).toBeInTheDocument()
    expect(screen.getByText('Held during Quiet Hours (22:00–08:00)')).toBeInTheDocument()
    expect(screen.queryByText('Delivered early')).toBeNull()
    expect(screen.getByText('Inbox watch')).toBeInTheDocument()
    expect(screen.getByText('watch')).toBeInTheDocument()
    expect(screen.getByText('Gmail')).toBeInTheDocument()
    expect(screen.getByText(/2 unread threads from Acme/)).toBeInTheDocument()
    expect(screen.getByText('Ready for your morning review.')).toBeInTheDocument()
    expect(container.querySelector('time.quiet-digest-time')).not.toBeNull()
  })

  it('renders plural title, deliveredEarly tag, prepare items, text fallback, and skips bogus timestamps', () => {
    const payload: QuietDigestPayload = {
      windowStart: '23:00',
      windowEnd: '07:30',
      itemCount: 2,
      flushedManually: true,
      items: [
        {
          id: 10,
          routineId: 7,
          routineName: 'Client dossier prep',
          routineMode: 'prepare',
          kind: 'text',
          summary: 'Updated Acme dossier',
          text: 'Updated **Acme Corp** dossier in Team Wiki.',
          createdAt: 42,
        },
        {
          id: 11,
          routineId: null,
          routineName: '',
          routineMode: 'watch',
          kind: 'text',
          summary: 'Status page stayed green overnight.',
          createdAt: 100,
        },
      ],
    }

    const { container } = render(<QuietDigestChip payload={payload} />)
    expect(screen.getByText('Morning digest · 2 updates')).toBeInTheDocument()
    expect(screen.getByText('Delivered early')).toBeInTheDocument()
    expect(screen.getByText('Held during Quiet Hours (23:00–07:30)')).toBeInTheDocument()
    expect(screen.getByText('Client dossier prep')).toBeInTheDocument()
    expect(screen.getByText('prepare')).toBeInTheDocument()
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('Scheduled check')).toBeInTheDocument()
    expect(screen.getByText('Status page stayed green overnight.')).toBeInTheDocument()
    expect(container.querySelector('time.quiet-digest-time')).toBeNull()
  })

  it('renders localized Chinese copy', () => {
    const payload: QuietDigestPayload = {
      windowStart: '22:00',
      windowEnd: '08:00',
      itemCount: 2,
      flushedManually: true,
      items: [
        {
          id: 1,
          routineId: 1,
          routineName: '夜间备料',
          routineMode: 'prepare',
          kind: 'text',
          summary: '已整理客户背景。',
          createdAt: 10,
        },
        {
          id: 2,
          routineId: 2,
          routineName: '状态巡检',
          routineMode: 'watch',
          kind: 'text',
          summary: '所有服务正常。',
          createdAt: 20,
        },
      ],
    }

    render(
      <I18nProvider lang="zh-CN">
        <QuietDigestChip payload={payload} />
      </I18nProvider>,
    )
    expect(screen.getByText('晨报汇总 · 2 条更新')).toBeInTheDocument()
    expect(screen.getByText('免打扰时段（22:00–08:00）暂存')).toBeInTheDocument()
    expect(screen.getByText('已提前投递')).toBeInTheDocument()
    expect(screen.getByText('备料')).toBeInTheDocument()
    expect(screen.getByText('值守')).toBeInTheDocument()
  })

  it('handles missing or malformed items without crashing and omits empty items container', () => {
    const malformed = {
      windowStart: '22:00',
      windowEnd: '08:00',
      itemCount: 0,
      items: undefined,
    } as unknown as QuietDigestPayload

    const { container, rerender } = render(<QuietDigestChip payload={malformed} />)
    expect(screen.getByText('Morning digest · 0 updates')).toBeInTheDocument()
    expect(screen.getByText('Held during Quiet Hours (22:00–08:00)')).toBeInTheDocument()
    expect(container.querySelector('.quiet-digest-items')).toBeNull()

    rerender(
      <QuietDigestChip
        payload={{ ...malformed, itemCount: 2, items: null as unknown as QuietDigestPayload['items'] }}
      />,
    )
    expect(screen.getByText('Morning digest · 2 updates')).toBeInTheDocument()
    expect(container.querySelector('.quiet-digest-items')).toBeNull()
  })
})
