import { useMemo, useState } from 'react'
import { useT } from '../i18n'
import type { SpaceActionDef, SpaceBlock, SpaceItem, SpaceItemData } from '../types'
import type { Roster } from './ConnectorsDialog'
import { ExternalLinkIcon, XIcon } from './Icons'
import { Markdown } from './Markdown'

function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function numericValue(item: SpaceItem, field: string): number | null {
  const raw = field === 'title' ? item.title : item.data[field]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export type SpaceBlockCallbacks = {
  busy: boolean
  roster: Roster
  onCreateItem: (input: { blockId: string; title: string; status?: string; data?: SpaceItemData }) => Promise<void>
  onUpdateItem: (itemId: string, patch: { title?: string; status?: string; data?: SpaceItemData }) => Promise<void>
  onDeleteItem: (itemId: string) => Promise<void>
  onRequestAction: (action: SpaceActionDef) => void
}

export function SpaceBlockView({
  block,
  allItems,
  cb,
}: {
  block: SpaceBlock
  allItems: SpaceItem[]
  cb: SpaceBlockCallbacks
}) {
  const blockItems = useMemo(() => allItems.filter((i) => i.blockId === block.id), [allItems, block.id])

  switch (block.type) {
    case 'metrics':
      return <MetricsBlockView block={block} allItems={allItems} />
    case 'table':
      return <TableBlockView block={block} items={blockItems} cb={cb} />
    case 'kanban':
      return <KanbanBlockView block={block} items={blockItems} cb={cb} />
    case 'checklist':
      return <ChecklistBlockView block={block} items={blockItems} cb={cb} />
    case 'timeline':
      return <TimelineBlockView block={block} items={blockItems} cb={cb} />
    case 'chart':
      return <ChartBlockView block={block} allItems={allItems} cb={cb} />
    case 'markdown':
      return (
        <section className="space-block">
          <h4 className="space-block-title">{block.title}</h4>
          <div className="space-markdown markdown">
            <Markdown text={block.content} />
          </div>
        </section>
      )
    case 'action_bar':
      return (
        <section className="space-block">
          <h4 className="space-block-title">{block.title}</h4>
          <div className="space-action-bar">
            {block.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                className="vault-small-btn primary"
                disabled={cb.busy}
                onClick={() => cb.onRequestAction(a)}
              >
                <span>{a.label}</span>
                <span className="space-action-bot">· @{cb.roster[a.botId]?.name ?? a.botId}</span>
              </button>
            ))}
          </div>
        </section>
      )
  }
}

function MetricsBlockView({
  block,
  allItems,
}: {
  block: Extract<SpaceBlock, { type: 'metrics' }>
  allItems: SpaceItem[]
}) {
  return (
    <section className="space-block">
      <h4 className="space-block-title">{block.title}</h4>
      <div className="space-metrics-grid">
        {block.cards.map((card, idx) => {
          let display = card.value ?? '—'
          if (card.blockId && card.agg) {
            const matched = allItems.filter(
              (i) => i.blockId === card.blockId && (!card.filterStatus || i.status === card.filterStatus),
            )
            if (card.agg === 'count') {
              display = formatNumber(matched.length)
            } else if (card.itemField) {
              const nums = matched
                .map((i) => numericValue(i, card.itemField!))
                .filter((n): n is number => n !== null)
              if (nums.length > 0) {
                const sum = nums.reduce((a, b) => a + b, 0)
                display = formatNumber(card.agg === 'avg' ? sum / nums.length : sum)
              } else {
                display = '0'
              }
            }
          }
          return (
            <div className="space-metric-card" key={`${card.label}-${idx}`}>
              <div className="space-metric-label">{card.label}</div>
              <div className="space-metric-value">
                <span>{display}</span>
                {card.unit ? <span className="space-metric-unit">{card.unit}</span> : null}
              </div>
              {card.trend ? <div className="space-metric-trend">{card.trend}</div> : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function TableBlockView({
  block,
  items,
  cb,
}: {
  block: Extract<SpaceBlock, { type: 'table' }>
  items: SpaceItem[]
  cb: SpaceBlockCallbacks
}) {
  const t = useT()
  const [filter, setFilter] = useState('')
  const [sortKey, setSortKey] = useState<string>('title')
  const [sortAsc, setSortAsc] = useState(true)
  const [newTitle, setNewTitle] = useState('')
  const [newFields, setNewFields] = useState<Record<string, string>>({})

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const filtered = q
      ? items.filter(
        (i) => i.title.toLowerCase().includes(q)
          || Object.values(i.data).some((v) => String(v ?? '').toLowerCase().includes(q)),
      )
      : items
    return [...filtered].sort((a, b) => {
      const av = sortKey === 'title' ? a.title : a.data[sortKey]
      const bv = sortKey === 'title' ? b.title : b.data[sortKey]
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''))
      return sortAsc ? cmp : -cmp
    })
  }, [items, filter, sortKey, sortAsc])

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortAsc((a) => !a)
    else { setSortKey(key); setSortAsc(true) }
  }

  const submitRow = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTitle.trim()) return
    const data: SpaceItemData = {}
    for (const col of block.columns) {
      const raw = (newFields[col.key] ?? '').trim()
      if (!raw) continue
      if (col.kind === 'number') {
        const num = Number(raw)
        if (Number.isFinite(num)) data[col.key] = num
      } else {
        data[col.key] = raw
      }
    }
    await cb.onCreateItem({ blockId: block.id, title: newTitle.trim(), data })
    setNewTitle('')
    setNewFields({})
  }

  return (
    <section className="space-block">
      <div className="space-block-head">
        <h4 className="space-block-title">{block.title}</h4>
        <input
          type="text"
          className="space-table-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('spaces.table.filterPlaceholder')}
        />
      </div>

      {rows.length === 0 ? (
        <div className="goal-muted">{t('spaces.table.empty')}</div>
      ) : (
        <div className="space-table-wrap">
          <table className="space-table">
            <thead>
              <tr>
                <th>
                  <button type="button" className="space-sort-btn" onClick={() => toggleSort('title')}>
                    {t('spaces.table.colTitle')}{sortKey === 'title' ? (sortAsc ? ' ↑' : ' ↓') : ''}
                  </button>
                </th>
                {block.columns.map((col) => (
                  <th key={col.key}>
                    <button type="button" className="space-sort-btn" onClick={() => toggleSort(col.key)}>
                      {col.label}{sortKey === col.key ? (sortAsc ? ' ↑' : ' ↓') : ''}
                    </button>
                  </th>
                ))}
                <th aria-label={t('spaces.itemDelete')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <td className="space-table-title-cell">
                    <span>{item.title}</span>
                    {item.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}
                  </td>
                  {block.columns.map((col) => {
                    const val = item.data[col.key]
                    const str = val === null || val === undefined ? '' : String(val)
                    return (
                      <td key={col.key}>
                        {col.kind === 'url' && str && isSafeHttpUrl(str) ? (
                          <a className="space-link" href={str} target="_blank" rel="noopener noreferrer">
                            <span>{str.replace(/^https?:\/\//, '').slice(0, 32)}</span>
                            <ExternalLinkIcon size={11} />
                          </a>
                        ) : col.kind === 'badge' && str ? (
                          <span className="vault-badge subtle">{str}</span>
                        ) : col.kind === 'number' && typeof val === 'number' ? (
                          <span className="space-num">{formatNumber(val)}</span>
                        ) : (
                          str || '—'
                        )}
                      </td>
                    )
                  })}
                  <td>
                    <button
                      type="button"
                      className="goal-icon-btn"
                      aria-label={t('spaces.itemDelete')}
                      disabled={cb.busy}
                      onClick={() => void cb.onDeleteItem(item.id)}
                    >
                      <XIcon size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="space-table-add" onSubmit={(e) => void submitRow(e)}>
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder={t('spaces.table.titlePlaceholder')}
          disabled={cb.busy}
        />
        {block.columns.slice(0, 3).map((col) => (
          <input
            key={col.key}
            type={col.kind === 'number' ? 'number' : 'text'}
            step={col.kind === 'number' ? 'any' : undefined}
            value={newFields[col.key] ?? ''}
            onChange={(e) => setNewFields((prev) => ({ ...prev, [col.key]: e.target.value }))}
            placeholder={col.label}
            disabled={cb.busy}
          />
        ))}
        <button type="submit" className="vault-small-btn" disabled={cb.busy || !newTitle.trim()}>
          {t('spaces.table.addRow')}
        </button>
      </form>
    </section>
  )
}

function KanbanBlockView({
  block,
  items,
  cb,
}: {
  block: Extract<SpaceBlock, { type: 'kanban' }>
  items: SpaceItem[]
  cb: SpaceBlockCallbacks
}) {
  const t = useT()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const fallbackKey = block.columns[0]?.key ?? ''

  return (
    <section className="space-block">
      <h4 className="space-block-title">{block.title}</h4>
      <div className="space-kanban-grid">
        {block.columns.map((col, colIdx) => {
          const colItems = items.filter((i) => (i.status || fallbackKey) === col.key)
          return (
            <div className="space-kanban-col" key={col.key}>
              <div className="space-kanban-col-head">
                <span>{col.label}</span>
                <span className="feed-tab-count subtle">{colItems.length}</span>
              </div>
              <div className="space-kanban-cards">
                {colItems.map((item) => (
                  <div className="space-kanban-card" key={item.id}>
                    <div className="space-kanban-card-top">
                      <span className="space-kanban-card-title">{item.title}</span>
                      <button
                        type="button"
                        className="goal-icon-btn"
                        aria-label={t('spaces.itemDelete')}
                        disabled={cb.busy}
                        onClick={() => void cb.onDeleteItem(item.id)}
                      >
                        <XIcon size={12} />
                      </button>
                    </div>
                    {item.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}
                    <div className="space-kanban-move">
                      {colIdx > 0 ? (
                        <button
                          type="button"
                          className="vault-small-btn"
                          aria-label={t('spaces.kanban.moveLeft')}
                          disabled={cb.busy}
                          onClick={() => void cb.onUpdateItem(item.id, { status: block.columns[colIdx - 1]!.key })}
                        >
                          ← {block.columns[colIdx - 1]!.label}
                        </button>
                      ) : null}
                      {colIdx < block.columns.length - 1 ? (
                        <button
                          type="button"
                          className="vault-small-btn"
                          aria-label={t('spaces.kanban.moveRight')}
                          disabled={cb.busy}
                          onClick={() => void cb.onUpdateItem(item.id, { status: block.columns[colIdx + 1]!.key })}
                        >
                          {block.columns[colIdx + 1]!.label} →
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              <form
                className="space-kanban-add"
                onSubmit={(e) => {
                  e.preventDefault()
                  const title = (drafts[col.key] ?? '').trim()
                  if (!title) return
                  void cb.onCreateItem({ blockId: block.id, title, status: col.key }).then(() => {
                    setDrafts((prev) => ({ ...prev, [col.key]: '' }))
                  })
                }}
              >
                <input
                  type="text"
                  value={drafts[col.key] ?? ''}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [col.key]: e.target.value }))}
                  placeholder={t('spaces.kanban.addCard')}
                  disabled={cb.busy}
                />
                <button type="submit" className="vault-small-btn" disabled={cb.busy || !(drafts[col.key] ?? '').trim()}>
                  {t('spaces.kanban.addBtn')}
                </button>
              </form>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ChecklistBlockView({
  block,
  items,
  cb,
}: {
  block: Extract<SpaceBlock, { type: 'checklist' }>
  items: SpaceItem[]
  cb: SpaceBlockCallbacks
}) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const doneCount = items.filter((i) => i.status === 'done').length
  const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0

  return (
    <section className="space-block">
      <div className="space-block-head">
        <h4 className="space-block-title">{block.title}</h4>
        {items.length > 0 ? <span className="goal-muted-inline">{doneCount} / {items.length}</span> : null}
      </div>
      {items.length > 0 ? (
        <div className="goal-progress-bar" aria-hidden="true">
          <div className="goal-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {items.length === 0 ? (
        <div className="goal-muted">{t('spaces.checklist.empty')}</div>
      ) : (
        <ul className="goal-milestones">
          {items.map((item) => (
            <li key={item.id} className={`goal-milestone-row${item.status === 'done' ? ' done' : ''}`}>
              <label className="goal-milestone-label">
                <input
                  type="checkbox"
                  checked={item.status === 'done'}
                  disabled={cb.busy}
                  onChange={() => void cb.onUpdateItem(item.id, { status: item.status === 'done' ? 'open' : 'done' })}
                />
                <span className="goal-milestone-text">{item.title}</span>
              </label>
              <span className="goal-milestone-meta">
                {item.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}
                <button
                  type="button"
                  className="goal-icon-btn"
                  aria-label={t('spaces.itemDelete')}
                  disabled={cb.busy}
                  onClick={() => void cb.onDeleteItem(item.id)}
                >
                  <XIcon size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="goal-inline-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!draft.trim()) return
          void cb.onCreateItem({ blockId: block.id, title: draft.trim(), status: 'open' }).then(() => setDraft(''))
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('spaces.checklist.addPlaceholder')}
          disabled={cb.busy}
        />
        <button type="submit" className="vault-small-btn" disabled={cb.busy || !draft.trim()}>
          {t('spaces.kanban.addBtn')}
        </button>
      </form>
    </section>
  )
}

function TimelineBlockView({
  block,
  items,
  cb,
}: {
  block: Extract<SpaceBlock, { type: 'timeline' }>
  items: SpaceItem[]
  cb: SpaceBlockCallbacks
}) {
  const t = useT()
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')

  return (
    <section className="space-block">
      <h4 className="space-block-title">{block.title}</h4>
      {items.length === 0 ? (
        <div className="goal-muted">{t('spaces.timeline.empty')}</div>
      ) : (
        <ul className="space-timeline">
          {items.map((item) => (
            <li key={item.id} className="space-timeline-row">
              <span className="space-timeline-dot" aria-hidden="true" />
              <div className="space-timeline-body">
                <div className="space-timeline-top">
                  <strong>{item.title}</strong>
                  {typeof item.data.date === 'string' && item.data.date ? (
                    <span className="goal-muted-inline">{item.data.date}</span>
                  ) : null}
                  {item.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}
                </div>
                {typeof item.data.detail === 'string' && item.data.detail ? (
                  <div className="space-timeline-detail">{item.data.detail}</div>
                ) : null}
              </div>
              <button
                type="button"
                className="goal-icon-btn"
                aria-label={t('spaces.itemDelete')}
                disabled={cb.busy}
                onClick={() => void cb.onDeleteItem(item.id)}
              >
                <XIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="goal-inline-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!title.trim()) return
          const data: SpaceItemData = detail.trim() ? { detail: detail.trim() } : {}
          void cb.onCreateItem({ blockId: block.id, title: title.trim(), data }).then(() => {
            setTitle('')
            setDetail('')
          })
        }}
      >
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('spaces.timeline.addPlaceholder')}
          disabled={cb.busy}
        />
        <input
          type="text"
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder={t('spaces.timeline.detailPlaceholder')}
          disabled={cb.busy}
        />
        <button type="submit" className="vault-small-btn" disabled={cb.busy || !title.trim()}>
          {t('spaces.kanban.addBtn')}
        </button>
      </form>
    </section>
  )
}

function ChartBlockView({
  block,
  allItems,
  cb,
}: {
  block: Extract<SpaceBlock, { type: 'chart' }>
  allItems: SpaceItem[]
  cb: SpaceBlockCallbacks
}) {
  const t = useT()
  const [label, setLabel] = useState('')
  const [val, setVal] = useState('')
  const sourceId = block.sourceBlockId ?? block.id
  const points = useMemo(() => {
    return allItems
      .filter((i) => i.blockId === sourceId)
      .map((i) => {
        const v = numericValue(i, block.valueField)
        const lbl = block.labelField === 'title' ? i.title : String(i.data[block.labelField] ?? i.title)
        return v === null ? null : { id: i.id, label: lbl, value: v, tainted: i.tainted }
      })
      .filter((p): p is { id: string; label: string; value: number; tainted: boolean } => p !== null)
  }, [allItems, sourceId, block.labelField, block.valueField])

  const maxVal = points.reduce((m, p) => Math.max(m, Math.abs(p.value)), 0) || 1

  return (
    <section className="space-block">
      <h4 className="space-block-title">{block.title}</h4>
      {points.length === 0 ? (
        <div className="goal-muted">{t('spaces.chart.empty')}</div>
      ) : (
        <svg
          className="space-chart-svg"
          role="img"
          aria-label={block.title}
          viewBox={`0 0 520 ${Math.max(54, points.length * 34 + 12)}`}
        >
          {points.map((p, idx) => {
            const y = idx * 34 + 8
            const barWidth = Math.max(4, Math.round((Math.abs(p.value) / maxVal) * 280))
            return (
              <g key={p.id} transform={`translate(0, ${y})`}>
                <text x="0" y="16" className="space-chart-label">
                  {p.label.slice(0, 20)}
                </text>
                <rect x="150" y="3" width={barWidth} height="18" rx="4" className="space-chart-bar" />
                <text x={158 + barWidth} y="16" className="space-chart-val">
                  {formatNumber(p.value)}{block.unit ? ` ${block.unit}` : ''}
                </text>
              </g>
            )
          })}
        </svg>
      )}
      {sourceId === block.id ? (
        <form
          className="goal-inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            const num = Number(val)
            if (!label.trim() || !Number.isFinite(num)) return
            void cb.onCreateItem({
              blockId: block.id,
              title: label.trim(),
              data: { [block.valueField]: num },
            }).then(() => { setLabel(''); setVal('') })
          }}
        >
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('spaces.chart.addLabelPlaceholder')}
            disabled={cb.busy}
          />
          <input
            type="number"
            step="any"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={t('spaces.chart.addValuePlaceholder')}
            disabled={cb.busy}
          />
          <button type="submit" className="vault-small-btn" disabled={cb.busy || !label.trim() || val.trim() === ''}>
            {t('spaces.kanban.addBtn')}
          </button>
        </form>
      ) : null}
    </section>
  )
}
