import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n'
import type { SpaceAccent, SpaceActionDef, SpaceBlock, SpaceItem, SpaceItemData } from '../types'
import { BotAvatar } from './BotAvatar'
import type { Roster } from './ConnectorsDialog'
import { ExternalLinkIcon, PlusIcon, XIcon } from './Icons'
import { Markdown } from './Markdown'
import { SpaceHtmlFrame } from './SpaceHtmlFrame'

const GATEWAY_IMG_RE = /^\/api\/(?:uploads\/[a-zA-Z0-9._-]+|screenshots\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+|spaces\/space-[0-9a-f]{8}\/assets\/[0-9a-f]{16}\.(?:png|jpg|webp|gif))$/
const DATA_IMG_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif|avif|svg\+xml);base64,[A-Za-z0-9+/=]+$/

function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isSafeImageUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  if (GATEWAY_IMG_RE.test(trimmed)) return !trimmed.includes('..')
  if (DATA_IMG_RE.test(trimmed)) return trimmed.length <= 12_000
  return isSafeHttpUrl(trimmed)
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

function formatUrlHost(raw: string): string {
  try {
    const u = new URL(raw.trim())
    const host = u.hostname.replace(/^www\./, '')
    const path = u.pathname && u.pathname !== '/' ? u.pathname : ''
    const compact = `${host}${path}`
    return compact.length > 30 ? `${compact.slice(0, 29)}…` : compact
  } catch {
    return raw.replace(/^https?:\/\//, '').slice(0, 30)
  }
}

const BADGE_PALETTE: readonly SpaceAccent[] = ['blue', 'emerald', 'indigo', 'amber', 'rose', 'slate']

function badgeTone(raw: string): SpaceAccent {
  const lower = raw.trim().toLowerCase()
  if (/^(done|active|live|ok|pass|paid|ready|completed|verified|已完成|活跃|通过|正常|已发布)$/.test(lower)) return 'emerald'
  if (/^(review|pending|waiting|beta|medium|warn|待审|待确认|进行中|中)$/.test(lower)) return 'amber'
  if (/^(blocked|fail|error|high|urgent|critical|risk|阻塞|失败|高|紧急|风险)$/.test(lower)) return 'rose'
  if (/^(pro|enterprise|team|core|primary|doing|in progress|核心|主力|专业版|企业版)$/.test(lower)) return 'blue'
  if (/^(research|draft|idea|plan|planning|backlog|草稿|调研|待办|计划)$/.test(lower)) return 'indigo'
  let hash = 0
  for (let i = 0; i < lower.length; i++) hash = ((hash << 5) - hash + lower.charCodeAt(i)) | 0
  return BADGE_PALETTE[Math.abs(hash) % BADGE_PALETTE.length]!
}

function trendKind(trend?: string): 'up' | 'down' | 'flat' {
  const s = (trend ?? '').trim()
  if (!s) return 'flat'
  if (/^(\+|↑|▲)/.test(s)) return 'up'
  if (/^(-|↓|▼)/.test(s)) return 'down'
  return 'flat'
}

const DEFAULT_KANBAN_COLORS: readonly SpaceAccent[] = ['slate', 'blue', 'amber', 'emerald', 'indigo', 'rose']

const DONUT_SLICE_COLORS = [
  'var(--space-accent)',
  '#818cf8',
  '#34d399',
  '#f59e0b',
  '#f472b6',
  '#38bdf8',
]

function spanClass(block: SpaceBlock): string {
  const span = block.span ?? 'full'
  return `space-span-${span}`
}

export type SpaceBlockCallbacks = {
  busy: boolean
  roster: Roster
  spaceTitle?: string
  spaceAccent?: SpaceAccent
  onCreateItem: (input: { blockId: string; title: string; status?: string; data?: SpaceItemData }) => Promise<boolean | void>
  onUpdateItem: (itemId: string, patch: { title?: string; status?: string; data?: SpaceItemData }) => Promise<boolean | void>
  onDeleteItem: (itemId: string) => Promise<void>
  onRequestAction: (action: SpaceActionDef) => void
  onUpdateHtmlBlock?: (blockId: string, html: string) => Promise<boolean | void>
  onUploadAsset?: (file: File) => Promise<string>
}

function BlockShell({
  block,
  right,
  variant,
  children,
}: {
  block: SpaceBlock
  right?: ReactNode
  variant?: 'default' | 'callout'
  children: ReactNode
}) {
  return (
    <section className={`space-block ${spanClass(block)}${variant === 'callout' ? ' space-block-callout' : ''}`}>
      <div className="space-block-head">
        <div className="space-block-heading">
          <h4 className="space-block-title">{block.title}</h4>
          {block.subtitle ? <p className="space-block-subtitle">{block.subtitle}</p> : null}
        </div>
        {right ? <div className="space-block-tools">{right}</div> : null}
      </div>
      {children}
    </section>
  )
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
        <BlockShell block={block} variant={block.variant}>
          <div className="space-markdown markdown">
            <Markdown text={block.content} />
          </div>
        </BlockShell>
      )
    case 'action_bar':
      return (
        <BlockShell block={block}>
          <div className="space-action-bar">
            {block.actions.map((a) => {
              const bot = cb.roster[a.botId]
              return (
                <button
                  key={a.id}
                  type="button"
                  className="space-action-btn"
                  disabled={cb.busy}
                  onClick={() => cb.onRequestAction(a)}
                >
                  <BotAvatar seed={a.botId} emoji={bot?.emoji} size="xs" />
                  <span className="space-action-label">{a.label}</span>
                  <span className="space-action-bot">@{bot?.name ?? a.botId}</span>
                </button>
              )
            })}
          </div>
        </BlockShell>
      )
    case 'cards':
      return <CardsBlockView block={block} items={blockItems} cb={cb} />
    case 'html':
      return <HtmlBlockView block={block} allItems={allItems} cb={cb} />
  }
}

function MetricsBlockView({
  block,
  allItems,
}: {
  block: Extract<SpaceBlock, { type: 'metrics' }>
  allItems: SpaceItem[]
}) {
  const t = useT()
  return (
    <BlockShell block={block}>
      <div className="space-metrics-grid">
        {block.cards.map((card, idx) => {
          let display = card.value ?? '—'
          let numericVal: number | null = card.value !== undefined && Number.isFinite(Number(card.value)) ? Number(card.value) : null
          if (card.blockId && card.agg) {
            const matched = allItems.filter(
              (i) => i.blockId === card.blockId && (!card.filterStatus || i.status === card.filterStatus),
            )
            if (card.agg === 'count') {
              numericVal = matched.length
              display = formatNumber(matched.length)
            } else if (card.itemField) {
              const nums = matched
                .map((i) => numericValue(i, card.itemField!))
                .filter((n): n is number => n !== null)
              if (nums.length > 0) {
                const sum = nums.reduce((a, b) => a + b, 0)
                const computed = card.agg === 'avg' ? sum / nums.length : sum
                numericVal = computed
                display = formatNumber(computed)
              } else {
                numericVal = 0
                display = '0'
              }
            }
          }
          const tone = card.tone ?? 'neutral'
          const targetPct = card.target && numericVal !== null
            ? Math.max(0, Math.min(100, Math.round((numericVal / card.target) * 100)))
            : null
          return (
            <div className={`space-metric-card tone-${tone}`} key={`${card.label}-${idx}`}>
              <div className="space-metric-top">
                <span className="space-metric-label">{card.label}</span>
                {card.trend ? (
                  <span className={`space-metric-trend trend-${trendKind(card.trend)}`}>{card.trend}</span>
                ) : null}
              </div>
              <div className="space-metric-value">
                <span>{display}</span>
                {card.unit ? <span className="space-metric-unit">{card.unit}</span> : null}
              </div>
              {targetPct !== null && card.target ? (
                <div className="space-metric-progress">
                  <div className="space-metric-bar" aria-hidden="true">
                    <div className="space-metric-bar-fill" style={{ width: `${targetPct}%` }} />
                  </div>
                  <span className="space-metric-target">
                    {t('spaces.targetOf', { target: formatNumber(card.target) })} · {targetPct}%
                  </span>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </BlockShell>
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
  const [adding, setAdding] = useState(false)
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
    setAdding(false)
  }

  return (
    <BlockShell
      block={block}
      right={
        <>
          {items.length > 0 ? (
            <input
              type="text"
              className="space-table-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('spaces.table.filterPlaceholder')}
            />
          ) : null}
          <button
            type="button"
            className="space-inline-trigger"
            disabled={cb.busy}
            onClick={() => setAdding((v) => !v)}
          >
            <PlusIcon size={12} />
            <span>{t('spaces.table.addRow')}</span>
          </button>
        </>
      }
    >
      {rows.length === 0 ? (
        <div className="space-empty-inline">{t('spaces.table.empty')}</div>
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
                  <th key={col.key} className={col.kind === 'number' ? 'num' : undefined}>
                    <button type="button" className="space-sort-btn" onClick={() => toggleSort(col.key)}>
                      {col.label}{sortKey === col.key ? (sortAsc ? ' ↑' : ' ↓') : ''}
                    </button>
                  </th>
                ))}
                <th aria-label={t('spaces.itemDelete')} className="space-table-act-col" />
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
                      <td key={col.key} className={col.kind === 'number' ? 'num' : undefined}>
                        {col.kind === 'image' && str && isSafeImageUrl(str) ? (
                          <img className="space-table-thumb" src={str} alt={item.title} loading="lazy" />
                        ) : col.kind === 'url' && str && isSafeHttpUrl(str) ? (
                          <a className="space-link" href={str} target="_blank" rel="noopener noreferrer">
                            <span>{formatUrlHost(str)}</span>
                            <ExternalLinkIcon size={11} />
                          </a>
                        ) : col.kind === 'badge' && str ? (
                          <span className={`space-semantic-badge tone-${badgeTone(str)}`}>{str}</span>
                        ) : col.kind === 'number' && typeof val === 'number' ? (
                          <span className="space-num">{formatNumber(val)}</span>
                        ) : col.kind === 'date' && str ? (
                          <span className="space-date-pill">{str}</span>
                        ) : (
                          str || <span className="space-dash">—</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="space-table-act-col">
                    <button
                      type="button"
                      className="goal-icon-btn space-row-delete"
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

      {adding ? (
        <form className="space-table-add" onSubmit={(e) => void submitRow(e)}>
          <input
            type="text"
            autoFocus
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
          <button type="submit" className="vault-small-btn primary" disabled={cb.busy || !newTitle.trim()}>
            {t('spaces.kanban.addBtn')}
          </button>
          <button type="button" className="vault-small-btn" onClick={() => setAdding(false)}>
            {t('spaces.form.cancel')}
          </button>
        </form>
      ) : null}
    </BlockShell>
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
  const [openCol, setOpenCol] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const fallbackKey = block.columns[0]?.key ?? ''

  return (
    <BlockShell block={block}>
      <div className="space-kanban-grid">
        {block.columns.map((col, colIdx) => {
          const colItems = items.filter((i) => (i.status || fallbackKey) === col.key)
          const colColor = col.color ?? DEFAULT_KANBAN_COLORS[colIdx % DEFAULT_KANBAN_COLORS.length]!
          const isAdding = openCol === col.key
          return (
            <div className={`space-kanban-col col-${colColor}`} key={col.key}>
              <div className="space-kanban-col-head">
                <span className="space-kanban-col-name">
                  <span className={`space-col-dot dot-${colColor}`} aria-hidden="true" />
                  <span>{col.label}</span>
                </span>
                <span className="space-col-count">{colItems.length}</span>
              </div>
              <div className="space-kanban-cards">
                {colItems.map((item) => {
                  const metaEntries = Object.entries(item.data)
                    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
                    .slice(0, 3)
                  return (
                    <div className="space-kanban-card" key={item.id}>
                      <div className="space-kanban-card-top">
                        <span className="space-kanban-card-title">{item.title}</span>
                        <button
                          type="button"
                          className="goal-icon-btn space-row-delete"
                          aria-label={t('spaces.itemDelete')}
                          disabled={cb.busy}
                          onClick={() => void cb.onDeleteItem(item.id)}
                        >
                          <XIcon size={12} />
                        </button>
                      </div>
                      {metaEntries.length > 0 ? (
                        <div className="space-kanban-card-meta">
                          {metaEntries.map(([k, v]) => (
                            <span key={k} className="space-mini-tag">
                              {String(v)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {item.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}
                      <div className="space-kanban-move">
                        {colIdx > 0 ? (
                          <button
                            type="button"
                            className="space-move-btn"
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
                            className="space-move-btn"
                            aria-label={t('spaces.kanban.moveRight')}
                            disabled={cb.busy}
                            onClick={() => void cb.onUpdateItem(item.id, { status: block.columns[colIdx + 1]!.key })}
                          >
                            {block.columns[colIdx + 1]!.label} →
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
              {isAdding ? (
                <form
                  className="space-kanban-add"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const title = (drafts[col.key] ?? '').trim()
                    if (!title) return
                    void cb.onCreateItem({ blockId: block.id, title, status: col.key }).then(() => {
                      setDrafts((prev) => ({ ...prev, [col.key]: '' }))
                      setOpenCol(null)
                    })
                  }}
                >
                  <input
                    type="text"
                    autoFocus
                    value={drafts[col.key] ?? ''}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [col.key]: e.target.value }))}
                    placeholder={t('spaces.kanban.addCard')}
                    disabled={cb.busy}
                  />
                  <button type="submit" className="vault-small-btn primary" disabled={cb.busy || !(drafts[col.key] ?? '').trim()}>
                    {t('spaces.kanban.addBtn')}
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="space-kanban-add-trigger"
                  disabled={cb.busy}
                  onClick={() => setOpenCol(col.key)}
                >
                  <PlusIcon size={12} />
                  <span>{t('spaces.kanban.addCard')}</span>
                </button>
              )}
            </div>
          )
        })}
      </div>
    </BlockShell>
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
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const doneCount = items.filter((i) => i.status === 'done').length
  const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0

  return (
    <BlockShell
      block={block}
      right={
        <>
          {items.length > 0 ? (
            <span className="space-pct-pill">{doneCount}/{items.length} · {pct}%</span>
          ) : null}
          <button
            type="button"
            className="space-inline-trigger"
            disabled={cb.busy}
            onClick={() => setAdding((v) => !v)}
          >
            <PlusIcon size={12} />
            <span>{t('spaces.kanban.addBtn')}</span>
          </button>
        </>
      }
    >
      {items.length > 0 ? (
        <div className="space-progress-track" aria-hidden="true">
          <div className="space-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {items.length === 0 ? (
        <div className="space-empty-inline">{t('spaces.checklist.empty')}</div>
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
                  className="goal-icon-btn space-row-delete"
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
      {adding ? (
        <form
          className="goal-inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!draft.trim()) return
            void cb.onCreateItem({ blockId: block.id, title: draft.trim(), status: 'open' }).then(() => {
              setDraft('')
              setAdding(false)
            })
          }}
        >
          <input
            type="text"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('spaces.checklist.addPlaceholder')}
            disabled={cb.busy}
          />
          <button type="submit" className="vault-small-btn primary" disabled={cb.busy || !draft.trim()}>
            {t('spaces.kanban.addBtn')}
          </button>
        </form>
      ) : null}
    </BlockShell>
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
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')

  return (
    <BlockShell
      block={block}
      right={
        <button
          type="button"
          className="space-inline-trigger"
          disabled={cb.busy}
          onClick={() => setAdding((v) => !v)}
        >
          <PlusIcon size={12} />
          <span>{t('spaces.kanban.addBtn')}</span>
        </button>
      }
    >
      {items.length === 0 ? (
        <div className="space-empty-inline">{t('spaces.timeline.empty')}</div>
      ) : (
        <ul className="space-timeline">
          {items.map((item) => (
            <li key={item.id} className="space-timeline-row">
              <span className="space-timeline-dot" aria-hidden="true" />
              <div className="space-timeline-body">
                <div className="space-timeline-top">
                  <strong>{item.title}</strong>
                  {typeof item.data.date === 'string' && item.data.date ? (
                    <span className="space-date-pill">{item.data.date}</span>
                  ) : null}
                  {item.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}
                </div>
                {typeof item.data.detail === 'string' && item.data.detail ? (
                  <div className="space-timeline-detail">{item.data.detail}</div>
                ) : null}
              </div>
              <button
                type="button"
                className="goal-icon-btn space-row-delete"
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
      {adding ? (
        <form
          className="goal-inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!title.trim()) return
            const data: SpaceItemData = detail.trim() ? { detail: detail.trim() } : {}
            void cb.onCreateItem({ blockId: block.id, title: title.trim(), data }).then(() => {
              setTitle('')
              setDetail('')
              setAdding(false)
            })
          }}
        >
          <input
            type="text"
            autoFocus
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
          <button type="submit" className="vault-small-btn primary" disabled={cb.busy || !title.trim()}>
            {t('spaces.kanban.addBtn')}
          </button>
        </form>
      ) : null}
    </BlockShell>
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
  const gradId = `sg-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [adding, setAdding] = useState(false)
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
  const totalVal = points.reduce((acc, p) => acc + Math.max(0, p.value), 0)

  const renderChart = () => {
    if (points.length === 0) return <div className="space-empty-inline">{t('spaces.chart.empty')}</div>

    if (block.mode === 'donut') {
      const r = 56
      const circumference = 2 * Math.PI * r
      const sum = totalVal || 1
      let offset = 0
      return (
        <div className="space-donut-layout">
          <svg className="space-donut-svg" role="img" aria-label={block.title} viewBox="0 0 156 156">
            <circle cx="78" cy="78" r={r} fill="none" stroke="var(--bg-track)" strokeWidth="18" />
            {points.map((p, idx) => {
              const frac = Math.max(0, p.value) / sum
              const dash = frac * circumference
              const currentOffset = offset
              offset += dash
              return (
                <circle
                  key={p.id}
                  cx="78"
                  cy="78"
                  r={r}
                  fill="none"
                  stroke={DONUT_SLICE_COLORS[idx % DONUT_SLICE_COLORS.length]}
                  strokeWidth="18"
                  strokeDasharray={`${Math.max(1, dash - 1.5)} ${circumference}`}
                  strokeDashoffset={-currentOffset}
                  transform="rotate(-90 78 78)"
                />
              )
            })}
            <text x="78" y="74" textAnchor="middle" className="space-donut-total">
              {formatNumber(totalVal)}
            </text>
            <text x="78" y="91" textAnchor="middle" className="space-donut-sub">
              {block.unit || t('spaces.chart.total')}
            </text>
          </svg>
          <ul className="space-donut-legend">
            {points.map((p, idx) => {
              const pct = totalVal > 0 ? Math.round((Math.max(0, p.value) / totalVal) * 100) : 0
              return (
                <li key={p.id} className="space-donut-legend-row">
                  <span
                    className="space-donut-swatch"
                    style={{ background: DONUT_SLICE_COLORS[idx % DONUT_SLICE_COLORS.length] }}
                  />
                  <span className="space-donut-name">{p.label}</span>
                  <span className="space-donut-val">
                    {formatNumber(p.value)}{block.unit ? ` ${block.unit}` : ''} · {pct}%
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )
    }

    if (block.mode === 'area') {
      const w = 520
      const h = 190
      const padL = 22
      const padR = 22
      const padT = 26
      const padB = 30
      const innerW = w - padL - padR
      const innerH = h - padT - padB
      const coords = points.map((p, idx) => {
        const x = points.length === 1 ? padL + innerW / 2 : padL + (idx / (points.length - 1)) * innerW
        const y = padT + innerH - (Math.max(0, p.value) / maxVal) * innerH
        return { ...p, x, y }
      })
      const linePath = coords.map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ')
      const areaPath = coords.length > 1
        ? `${linePath} L ${coords[coords.length - 1]!.x.toFixed(1)} ${(padT + innerH).toFixed(1)} L ${coords[0]!.x.toFixed(1)} ${(padT + innerH).toFixed(1)} Z`
        : ''
      return (
        <svg className="space-chart-svg" role="img" aria-label={block.title} viewBox={`0 0 ${w} ${h}`}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--space-accent)" stopOpacity="0.34" />
              <stop offset="100%" stopColor="var(--space-accent)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75, 1].map((g) => (
            <line
              key={g}
              x1={padL}
              x2={w - padR}
              y1={padT + innerH * (1 - g)}
              y2={padT + innerH * (1 - g)}
              className="space-chart-grid"
            />
          ))}
          <line x1={padL} x2={w - padR} y1={padT + innerH} y2={padT + innerH} className="space-chart-axis" />
          {areaPath ? <path d={areaPath} fill={`url(#${gradId})`} /> : null}
          {coords.length > 1 ? <path d={linePath} fill="none" className="space-chart-line" /> : null}
          {coords.map((c) => (
            <g key={c.id}>
              <circle cx={c.x} cy={c.y} r="4" className="space-chart-dot" />
              <text x={c.x} y={Math.max(13, c.y - 9)} textAnchor="middle" className="space-chart-val">
                {formatNumber(c.value)}{block.unit ? ` ${block.unit}` : ''}
              </text>
              <text x={c.x} y={h - 9} textAnchor="middle" className="space-chart-label">
                {c.label.slice(0, 12)}
              </text>
            </g>
          ))}
        </svg>
      )
    }

    if (block.mode === 'bar') {
      const w = 520
      const h = 196
      const padL = 16
      const padR = 16
      const padT = 26
      const padB = 34
      const innerW = w - padL - padR
      const innerH = h - padT - padB
      const slot = innerW / points.length
      const barW = Math.min(44, Math.max(16, slot * 0.54))
      return (
        <svg className="space-chart-svg" role="img" aria-label={block.title} viewBox={`0 0 ${w} ${h}`}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--space-accent)" stopOpacity="0.96" />
              <stop offset="100%" stopColor="var(--space-accent)" stopOpacity="0.52" />
            </linearGradient>
          </defs>
          {[0.33, 0.66, 1].map((g) => (
            <line
              key={g}
              x1={padL}
              x2={w - padR}
              y1={padT + innerH * (1 - g)}
              y2={padT + innerH * (1 - g)}
              className="space-chart-grid"
            />
          ))}
          <line x1={padL} x2={w - padR} y1={padT + innerH} y2={padT + innerH} className="space-chart-axis" />
          {points.map((p, idx) => {
            const barH = Math.max(4, Math.round((Math.abs(p.value) / maxVal) * innerH))
            const cx = padL + idx * slot + slot / 2
            const y = padT + innerH - barH
            return (
              <g key={p.id}>
                <rect x={cx - barW / 2} y={y} width={barW} height={barH} rx="5" fill={`url(#${gradId})`} />
                <text x={cx} y={Math.max(13, y - 6)} textAnchor="middle" className="space-chart-val">
                  {formatNumber(p.value)}{block.unit ? ` ${block.unit}` : ''}
                </text>
                <text x={cx} y={h - 10} textAnchor="middle" className="space-chart-label">
                  {p.label.slice(0, 12)}
                </text>
              </g>
            )
          })}
        </svg>
      )
    }

    // Default: crisp horizontal bar chart with background track + gradient fill
    const trackW = 264
    return (
      <svg
        className="space-chart-svg"
        role="img"
        aria-label={block.title}
        viewBox={`0 0 520 ${Math.max(54, points.length * 36 + 10)}`}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--space-accent)" stopOpacity="0.65" />
            <stop offset="100%" stopColor="var(--space-accent)" stopOpacity="0.98" />
          </linearGradient>
        </defs>
        {points.map((p, idx) => {
          const y = idx * 36 + 8
          const barWidth = Math.max(6, Math.round((Math.abs(p.value) / maxVal) * trackW))
          return (
            <g key={p.id} transform={`translate(0, ${y})`}>
              <text x="0" y="16" className="space-chart-label">
                {p.label.slice(0, 20)}
              </text>
              <rect x="148" y="3" width={trackW} height="18" rx="6" className="space-chart-track" />
              <rect x="148" y="3" width={barWidth} height="18" rx="6" fill={`url(#${gradId})`} />
              <text x="516" y="16" textAnchor="end" className="space-chart-val">
                {formatNumber(p.value)}{block.unit ? ` ${block.unit}` : ''}
              </text>
            </g>
          )
        })}
      </svg>
    )
  }

  return (
    <BlockShell
      block={block}
      right={
        sourceId === block.id ? (
          <button
            type="button"
            className="space-inline-trigger"
            disabled={cb.busy}
            onClick={() => setAdding((v) => !v)}
          >
            <PlusIcon size={12} />
            <span>{t('spaces.kanban.addBtn')}</span>
          </button>
        ) : null
      }
    >
      {renderChart()}
      {sourceId === block.id && adding ? (
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
            }).then(() => { setLabel(''); setVal(''); setAdding(false) })
          }}
        >
          <input
            type="text"
            autoFocus
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
          <button type="submit" className="vault-small-btn primary" disabled={cb.busy || !label.trim() || val.trim() === ''}>
            {t('spaces.kanban.addBtn')}
          </button>
        </form>
      ) : null}
    </BlockShell>
  )
}

const RESERVED_CARD_KEYS = new Set(['image', 'eyebrow', 'subtitle', 'badge', 'summary', 'metric', 'metricLabel', 'tags', 'url', 'urlLabel'])
const MATCH_FIELDS = ['awayTeam', 'homeTeam', 'awayLogo', 'homeLogo', 'awayScore', 'homeScore', 'startsAt'] as const
const MATCH_CARD_KEYS = new Set([...MATCH_FIELDS, 'awayRecord', 'homeRecord'])
const MATCH_STATUSES = ['scheduled', 'live', 'final'] as const
type MatchStatus = typeof MATCH_STATUSES[number]
type MatchDraft = Record<typeof MATCH_FIELDS[number], string>
const EMPTY_MATCH: MatchDraft = { awayTeam: '', homeTeam: '', awayLogo: '', homeLogo: '', awayScore: '', homeScore: '', startsAt: '' }

function dateValue(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function localDateInput(value: unknown): string {
  const date = dateValue(value)
  if (!date) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function CardLogo({ name, source }: { name: string; source: unknown }) {
  const [broken, setBroken] = useState('')
  const url = typeof source === 'string' && isSafeImageUrl(source) ? source.trim() : ''
  return (
    <span className="space-card-logo" aria-hidden="true">
      {url && url !== broken ? (
        <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(url)} />
      ) : name.slice(0, 2).toUpperCase()}
    </span>
  )
}

function MatchupCard({ item }: { item: SpaceItem }) {
  const t = useT()
  const team = (side: 'away' | 'home') => {
    const name = String(item.data[`${side}Team`] || '—')
    const record = item.data[`${side}Record`]
    return (
      <div className="space-match-team">
        <CardLogo name={name} source={item.data[`${side}Logo`]} />
        <strong>{name}</strong>
        {record ? <small>{record}</small> : null}
      </div>
    )
  }
  const away = numericValue(item, 'awayScore')
  const home = numericValue(item, 'homeScore')
  const start = dateValue(item.data.startsAt)
  return (
    <>
      {start ? <time className="space-match-time" dateTime={start.toISOString()}>
        {new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(start)}
      </time> : null}
      <div className="space-matchup">
        {team('away')}
        <strong className="space-match-score">{away !== null && home !== null ? `${away} : ${home}` : 'VS'}</strong>
        {team('home')}
      </div>
    </>
  )
}

function CardsBlockView({
  block,
  items,
  cb,
}: {
  block: Extract<SpaceBlock, { type: 'cards' }>
  items: SpaceItem[]
  cb: SpaceBlockCallbacks
}) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [title, setTitle] = useState('')
  const [eyebrow, setEyebrow] = useState('')
  const [badge, setBadge] = useState('')
  const [image, setImage] = useState('')
  const [summary, setSummary] = useState('')
  const [metric, setMetric] = useState('')
  const [tags, setTags] = useState('')
  const [url, setUrl] = useState('')
  const [match, setMatch] = useState<MatchDraft>(EMPTY_MATCH)
  const [matchStatus, setMatchStatus] = useState<MatchStatus>('scheduled')
  const matchup = block.variant === 'matchup'
  const competitor = block.variant === 'competitor'

  const openEditor = (item?: SpaceItem) => {
    setEditingId(item?.id ?? null)
    setTitle(item?.title ?? '')
    setEyebrow(String(item?.data.eyebrow ?? ''))
    setBadge(String(item?.data.badge ?? ''))
    setImage(String(item?.data.image ?? ''))
    setSummary(String(item?.data.summary ?? ''))
    setMetric(String(item?.data.metric ?? ''))
    setTags(String(item?.data.tags ?? ''))
    setUrl(String(item?.data.url ?? ''))
    setMatch({
      awayTeam: String(item?.data.awayTeam ?? ''), homeTeam: String(item?.data.homeTeam ?? ''),
      awayLogo: String(item?.data.awayLogo ?? ''), homeLogo: String(item?.data.homeLogo ?? ''),
      awayScore: String(item?.data.awayScore ?? ''), homeScore: String(item?.data.homeScore ?? ''),
      startsAt: localDateInput(item?.data.startsAt),
    })
    setMatchStatus(MATCH_STATUSES.find((status) => status === item?.status) ?? 'scheduled')
    setAdding(true)
  }

  const handleUpload = async (file: File | undefined) => {
    if (!file || !cb.onUploadAsset) return
    setUploading(true)
    try {
      const uploadedUrl = await cb.onUploadAsset(file)
      setImage(uploadedUrl)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const submitCard = async (e: React.FormEvent) => {
    e.preventDefault()
    const cardTitle = matchup ? `${match.awayTeam.trim()} @ ${match.homeTeam.trim()}` : title.trim()
    if (matchup ? !match.awayTeam.trim() || !match.homeTeam.trim() : !cardTitle) return
    const existing = items.find((item) => item.id === editingId)
    if (editingId && !existing) return
    const data: SpaceItemData = { ...existing?.data }
    const textFields = matchup ? { eyebrow, badge, summary, url, ...match } : { eyebrow, badge, image, summary, metric, tags, url }
    for (const [key, raw] of Object.entries(textFields)) {
      const value = raw.trim()
      if (!value) delete data[key]
      else if (key === 'startsAt') data[key] = dateValue(value)?.toISOString() ?? value
      else if (key === 'awayScore' || key === 'homeScore') data[key] = Number(value)
      else data[key] = value
    }
    const status = matchup ? matchStatus : badge.trim().toLowerCase() || existing?.status || ''
    const patch = { title: cardTitle, status, data }
    const saved = existing ? await cb.onUpdateItem(existing.id, patch) : await cb.onCreateItem({ blockId: block.id, ...patch })
    if (saved !== false) setAdding(false)
  }

  const aspect = block.aspect ?? 'wide'
  const colsClass = block.columns === 2 ? ' cols-2' : block.columns === 3 ? ' cols-3' : ''

  return (
    <BlockShell
      block={block}
      right={
        <button
          type="button"
          className="space-inline-trigger"
          disabled={cb.busy}
          onClick={() => adding && !editingId ? setAdding(false) : openEditor()}
        >
          <PlusIcon size={12} />
          <span>{t('spaces.cards.addCard')}</span>
        </button>
      }
    >
      {adding ? (
        <form className="space-card-add-form" onSubmit={(e) => void submitCard(e)}>
          {matchup ? (
            <div className="space-match-editor">
              {MATCH_FIELDS.map((key, index) => (
                <label key={key}>
                  <span>{t(`spaces.matchup.${key}`)}</span>
                  <input
                    type={key === 'startsAt' ? 'datetime-local' : key.endsWith('Score') ? 'number' : 'text'}
                    min={key.endsWith('Score') ? 0 : undefined}
                    required={key.endsWith('Team')}
                    autoFocus={index === 0}
                    value={match[key]}
                    onChange={(e) => setMatch((current) => ({ ...current, [key]: e.target.value }))}
                    disabled={cb.busy}
                  />
                </label>
              ))}
              <label>
                <span>{t('spaces.matchup.status')}</span>
                <select value={matchStatus} onChange={(e) => setMatchStatus(e.target.value as MatchStatus)} disabled={cb.busy}>
                  {MATCH_STATUSES.map((status) => (
                    <option key={status} value={status}>{t(`spaces.matchup.status.${status}`)}</option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <>
              <div className="space-card-add-row">
                <input
                  type="text"
                  autoFocus
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('spaces.cards.titlePlaceholder')}
                  disabled={cb.busy}
                />
                <input
                  type="text"
                  value={eyebrow}
                  onChange={(e) => setEyebrow(e.target.value)}
                  placeholder={t('spaces.cards.eyebrowPlaceholder')}
                  disabled={cb.busy}
                />
                <input
                  type="text"
                  value={badge}
                  onChange={(e) => setBadge(e.target.value)}
                  placeholder={t('spaces.cards.badgePlaceholder')}
                  disabled={cb.busy}
                />
              </div>
              <div className="space-card-add-row">
                <input
                  type="text"
                  value={image}
                  onChange={(e) => setImage(e.target.value)}
                  placeholder={t('spaces.cards.imagePlaceholder')}
                  disabled={cb.busy || uploading}
                />
                {cb.onUploadAsset ? (
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      hidden
                      onChange={(e) => void handleUpload(e.target.files?.[0])}
                    />
                    <button
                      type="button"
                      className="vault-small-btn"
                      disabled={cb.busy || uploading}
                      onClick={() => fileRef.current?.click()}
                    >
                      {uploading ? t('spaces.cards.uploading') : t('spaces.cards.uploadImage')}
                    </button>
                  </>
                ) : null}
                <input
                  type="text"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                  placeholder={t('spaces.cards.metricPlaceholder')}
                  disabled={cb.busy}
                />
              </div>
            </>
          )}
          <textarea
            rows={2}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder={t('spaces.cards.summaryPlaceholder')}
            disabled={cb.busy}
          />
          <div className="space-card-add-row">
            {!matchup ? <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('spaces.cards.tagsPlaceholder')}
              disabled={cb.busy}
            /> : null}
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('spaces.cards.urlPlaceholder')}
              disabled={cb.busy}
            />
            <button type="submit" className="vault-small-btn primary" disabled={cb.busy || uploading || (matchup ? !match.awayTeam.trim() || !match.homeTeam.trim() : !title.trim())}>
              {editingId ? t('spaces.cards.saveCard') : t('spaces.kanban.addBtn')}
            </button>
            <button type="button" className="vault-small-btn" onClick={() => setAdding(false)}>
              {t('spaces.form.cancel')}
            </button>
          </div>
        </form>
      ) : null}

      {items.length === 0 ? (
        <div className="space-empty-inline">{t('spaces.cards.empty')}</div>
      ) : (
        <div className={`space-cards-grid${colsClass}${matchup ? ' space-cards-matchups' : ''}`}>
          {(competitor ? [...items].sort((a, b) => b.updatedAt - a.updatedAt || a.sortOrder - b.sortOrder) : items).map((item) => {
            const img = typeof item.data.image === 'string' && isSafeImageUrl(item.data.image) ? item.data.image : ''
            const cardEyebrow = typeof item.data.eyebrow === 'string' ? item.data.eyebrow : typeof item.data.subtitle === 'string' ? item.data.subtitle : ''
            const cardBadge = typeof item.data.badge === 'string' ? item.data.badge : ''
            const cardSummary = typeof item.data.summary === 'string' ? item.data.summary : ''
            const cardMetric = item.data.metric !== undefined && item.data.metric !== null && String(item.data.metric).trim() !== ''
              ? String(item.data.metric)
              : ''
            const cardMetricLabel = typeof item.data.metricLabel === 'string' ? item.data.metricLabel : ''
            const cardTags = typeof item.data.tags === 'string'
              ? item.data.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 6)
              : []
            const cardUrl = typeof item.data.url === 'string' && isSafeHttpUrl(item.data.url) ? item.data.url : ''
            const cardUrlLabel = typeof item.data.urlLabel === 'string' && item.data.urlLabel.trim() ? item.data.urlLabel.trim() : ''
            const extraSpecs = Object.entries(item.data)
              .filter(([k, v]) => !RESERVED_CARD_KEYS.has(k) && (!matchup || !MATCH_CARD_KEYS.has(k)) && v !== null && v !== undefined && String(v).trim() !== '')
              .slice(0, 4)

            return (
              <article className={`space-visual-card${competitor ? ' space-radar-card' : ''}`} key={item.id}>
                {img && !competitor && !matchup ? (
                  <div className={`space-card-cover aspect-${aspect}`}>
                    <img src={img} alt={item.title} loading="lazy" referrerPolicy="no-referrer" />
                    {cardBadge ? (
                      <span className={`space-semantic-badge tone-${badgeTone(cardBadge)} space-card-cover-badge`}>
                        {cardBadge}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="space-card-body">
                  <div className="space-card-head">
                    {competitor ? <CardLogo name={item.title} source={item.data.image} /> : null}
                    <div className="space-card-titles">
                      {cardEyebrow ? <span className="space-card-eyebrow">{cardEyebrow}</span> : null}
                      <h5 className="space-card-title">{item.title}</h5>
                    </div>
                    <div className="space-card-head-right">
                      {(!img || competitor || matchup) && cardBadge ? (
                        <span className={`space-semantic-badge tone-${badgeTone(cardBadge)}`}>{cardBadge}</span>
                      ) : matchup ? (
                        <span className={`space-semantic-badge tone-${item.status === 'final' ? 'emerald' : item.status === 'live' ? 'amber' : 'slate'}`}>
                          {t(`spaces.matchup.status.${MATCH_STATUSES.find((status) => status === item.status) ?? 'scheduled'}`)}
                        </span>
                      ) : null}
                      <button type="button" className="vault-small-btn" disabled={cb.busy} onClick={() => openEditor(item)}>
                        {t('spaces.cards.editCard')}
                      </button>
                      <button
                        type="button"
                        className="goal-icon-btn space-row-delete"
                        aria-label={t('spaces.itemDelete')}
                        disabled={cb.busy}
                        onClick={() => void cb.onDeleteItem(item.id)}
                      >
                        <XIcon size={12} />
                      </button>
                    </div>
                  </div>

                  {matchup ? <MatchupCard item={item} /> : cardMetric ? (
                    <div className="space-card-metric">
                      <strong>{cardMetric}</strong>
                      {cardMetricLabel ? <span>{cardMetricLabel}</span> : null}
                    </div>
                  ) : null}

                  {cardSummary ? <p className="space-card-summary">{cardSummary}</p> : null}

                  {extraSpecs.length > 0 ? (
                    <dl className="space-card-specs">
                      {extraSpecs.map(([k, v]) => (
                        <div key={k} className="space-card-spec">
                          <dt>{k}</dt>
                          <dd>{String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}

                  {item.tainted ? <span className="feed-tainted-badge">{t('feed.tainted')}</span> : null}

                  {cardTags.length > 0 || cardUrl ? (
                    <div className="space-card-foot">
                      <div className="space-card-tags">
                        {cardTags.map((tag) => (
                          <span key={tag} className="space-mini-tag">{tag}</span>
                        ))}
                      </div>
                      {cardUrl ? (
                        <a className="space-link" href={cardUrl} target="_blank" rel="noopener noreferrer">
                          <span>{cardUrlLabel || formatUrlHost(cardUrl)}</span>
                          <ExternalLinkIcon size={11} />
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </BlockShell>
  )
}

function HtmlBlockView({
  block,
  allItems,
  cb,
}: {
  block: Extract<SpaceBlock, { type: 'html' }>
  allItems: SpaceItem[]
  cb: SpaceBlockCallbacks
}) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(block.html)
  const [expanded, setExpanded] = useState(false)
  const [uploading, setUploading] = useState(false)

  const toggleEdit = () => {
    if (!editing) setDraft(block.html)
    setEditing((v) => !v)
  }

  const insertUploadedImage = async (file: File | undefined) => {
    if (!file || !cb.onUploadAsset) return
    setUploading(true)
    try {
      const uploadedUrl = await cb.onUploadAsset(file)
      const safeAlt = file.name.replace(/["<>]/g, '')
      setDraft((prev) => `${prev}\n<img src="${uploadedUrl}" alt="${safeAlt}" style="max-width:100%;border-radius:12px;" />`)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const saveHtml = async () => {
    if (!cb.onUpdateHtmlBlock) return
    const saved = await cb.onUpdateHtmlBlock(block.id, draft)
    if (saved !== false) setEditing(false)
  }

  const toolbar = (
    <>
      <button
        type="button"
        className="space-inline-trigger"
        onClick={() => setExpanded((v) => !v)}
      >
        <span>{expanded ? t('spaces.html.collapse') : t('spaces.html.expand')}</span>
      </button>
      {cb.onUpdateHtmlBlock ? (
        <button
          type="button"
          className="space-inline-trigger"
          disabled={cb.busy}
          onClick={toggleEdit}
        >
          <span>{editing ? t('spaces.html.preview') : t('spaces.html.edit')}</span>
        </button>
      ) : null}
    </>
  )

  const content = (
    <>
      {editing ? (
        <div className="space-html-editor">
          <div className="space-html-editor-head">
            <span className="space-html-note">{t('spaces.html.sandboxNote')}</span>
            <div className="space-html-editor-actions">
              {cb.onUploadAsset ? (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    hidden
                    onChange={(e) => void insertUploadedImage(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    className="vault-small-btn"
                    disabled={cb.busy || uploading}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploading ? t('spaces.cards.uploading') : t('spaces.html.insertImage')}
                  </button>
                </>
              ) : null}
              <button type="button" className="vault-small-btn" onClick={() => setEditing(false)} disabled={cb.busy}>
                {t('spaces.form.cancel')}
              </button>
              <button type="button" className="vault-small-btn primary" onClick={() => void saveHtml()} disabled={cb.busy}>
                {t('spaces.html.save')}
              </button>
            </div>
          </div>
          <textarea
            rows={14}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('spaces.html.placeholder')}
            disabled={cb.busy}
          />
        </div>
      ) : null}
      <SpaceHtmlFrame
        title={block.title}
        html={editing ? draft : block.html}
        fixedHeight={block.height}
        expanded={expanded}
        accent={cb.spaceAccent ?? 'indigo'}
        spaceTitle={cb.spaceTitle ?? block.title}
        items={allItems}
      />
    </>
  )

  if (block.frameless) {
    return (
      <section className={`space-block space-block-frameless ${spanClass(block)}`}>
        <div className="space-html-bar">
          <div className="space-block-heading">
            <h4 className="space-block-title">{block.title}</h4>
            {block.subtitle ? <p className="space-block-subtitle">{block.subtitle}</p> : null}
          </div>
          <div className="space-block-tools">{toolbar}</div>
        </div>
        {content}
      </section>
    )
  }

  return (
    <BlockShell block={block} right={toolbar}>
      {content}
    </BlockShell>
  )
}
