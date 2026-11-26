import type { SpaceSchema, SpaceTemplateId, SpaceTemplateMeta, SpaceTheme } from './types.js'
import { RADAR_CANVAS, SCOREBOARD_CANVAS } from './canvas-templates.js'

export const SPACE_TEMPLATES: readonly SpaceTemplateMeta[] = [
  { id: 'radar', icon: '🔎' },
  { id: 'scoreboard', icon: '🏀' },
  { id: 'tracker', icon: '📊' },
  { id: 'kanban', icon: '📋' },
  { id: 'dashboard', icon: '📈' },
  { id: 'cards', icon: '🖼️' },
  { id: 'html', icon: '🎨' },
  { id: 'blank', icon: '📝' },
]

const STARTER_HTML_CANVAS = `<style>
  .studio {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'PingFang SC', sans-serif;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 4px 2px 8px;
  }
  .hero-banner {
    position: relative;
    overflow: hidden;
    border-radius: 16px;
    padding: 24px 26px;
    border: 1px solid var(--space-accent-border);
    background:
      radial-gradient(520px 220px at 92% 0%, var(--space-accent-glow), transparent 70%),
      linear-gradient(135deg, var(--space-accent-soft), var(--bg-card) 62%);
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(180px, 0.8fr);
    gap: 20px;
    align-items: center;
  }
  @media (max-width: 680px) { .hero-banner { grid-template-columns: 1fr; } }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--space-accent);
    margin-bottom: 8px;
  }
  .hero-banner h2 {
    font-size: 22px;
    line-height: 1.25;
    letter-spacing: -0.02em;
    margin: 0 0 8px;
    color: var(--text);
  }
  .hero-banner p {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-dim);
  }
  .hero-visual {
    width: 100%;
    height: 120px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .filter-bar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .pill {
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text-dim);
    font-size: 12px;
    cursor: pointer;
    transition: all 140ms ease;
  }
  .pill.active, .pill:hover {
    border-color: var(--space-accent-border);
    background: var(--space-accent-soft);
    color: var(--text);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
  }
  .card {
    border-radius: 14px;
    border: 1px solid var(--border);
    background: var(--bg-card);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: transform 160ms ease, border-color 160ms ease;
  }
  .card:hover { transform: translateY(-2px); border-color: var(--space-accent-border); }
  .card-art {
    height: 92px;
    background: linear-gradient(135deg, var(--space-accent-soft), var(--bg-raised));
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
  }
  .card-metric { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; color: var(--text); font-variant-numeric: tabular-nums; }
  .card-tag {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--space-accent-soft);
    color: var(--space-accent);
    border: 1px solid var(--space-accent-border);
  }
  .card-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
  .card-body h3 { margin: 0; font-size: 14px; color: var(--text); }
  .card-body p { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--text-dim); }
</style>

<div class="studio">
  <section class="hero-banner">
    <div>
      <div class="eyebrow">● Sandboxed HTML Space</div>
      <h2>Full HTML, CSS, SVG &amp; Interactive Cards</h2>
      <p>Edit this HTML directly, embed images or custom illustrations, or ask a teammate to redesign it with the built-in <strong>space-design</strong> skill.</p>
    </div>
    <div class="hero-visual">
      <svg viewBox="0 0 220 100" width="100%" height="100%" aria-hidden="true">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--space-accent)" stop-opacity="0.42"/>
            <stop offset="100%" stop-color="var(--space-accent)" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <path d="M12 78 C46 66, 68 34, 102 42 C136 50, 158 20, 208 16 L208 88 L12 88 Z" fill="url(#g)"/>
        <path d="M12 78 C46 66, 68 34, 102 42 C136 50, 158 20, 208 16" fill="none" stroke="var(--space-accent)" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="102" cy="42" r="4" fill="var(--bg-card)" stroke="var(--space-accent)" stroke-width="2.5"/>
        <circle cx="208" cy="16" r="4.5" fill="var(--space-accent)"/>
      </svg>
    </div>
  </section>

  <div class="filter-bar" id="filters">
    <button class="pill active" data-cat="all">All</button>
    <button class="pill" data-cat="visual">Visuals</button>
    <button class="pill" data-cat="interactive">Interactive</button>
  </div>

  <section class="cards" id="cardGrid">
    <article class="card" data-cat="visual">
      <div class="card-art"><span class="card-metric">4K</span><span class="card-tag">Media</span></div>
      <div class="card-body"><h3>Images &amp; Cover Art</h3><p>Supports HTTPS images, uploaded local images, inline SVGs, and custom gradients.</p></div>
    </article>
    <article class="card" data-cat="visual">
      <div class="card-art"><span class="card-metric">12-col</span><span class="card-tag">Layout</span></div>
      <div class="card-body"><h3>Bespoke Card Layouts</h3><p>Combine asymmetric CSS Grid, glass hairlines, rich metadata chips, and custom typography.</p></div>
    </article>
    <article class="card" data-cat="interactive">
      <div class="card-art"><span class="card-metric">JS</span><span class="card-tag">Isolated</span></div>
      <div class="card-body"><h3>Safe Interactive Widgets</h3><p>Runs inside a null-origin sandbox with live access to <code>window.SPACE_DATA</code> and auto-resizing height.</p></div>
    </article>
  </section>
</div>

<script>
  document.getElementById('filters').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    document.querySelectorAll('#filters .pill').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    var cat = btn.getAttribute('data-cat');
    document.querySelectorAll('#cardGrid .card').forEach(function (card) {
      card.style.display = cat === 'all' || card.getAttribute('data-cat') === cat ? '' : 'none';
    });
  });
</script>`

export function defaultIconForTemplate(template: SpaceTemplateId): string {
  return SPACE_TEMPLATES.find((t) => t.id === template)?.icon ?? '📊'
}

export function buildTemplateSchema(template: SpaceTemplateId, defaultBotId: string, themeOverride?: SpaceTheme): SpaceSchema {
  const pickTheme = (fallback: SpaceTheme): SpaceTheme => themeOverride ?? fallback
  switch (template) {
    case 'radar':
      return {
        theme: pickTheme({ accent: 'indigo', style: 'editorial' }),
        blocks: [
          { id: 'competitors', type: 'cards', title: 'Competitor radar', columns: 2, variant: 'competitor' },
          { id: 'canvas', type: 'html', title: 'Market pulse', frameless: true, viewOf: ['competitors'], html: RADAR_CANVAS },
          ...(defaultBotId ? [{
            id: 'refresh', type: 'action_bar' as const, title: 'Sources',
            actions: [{
              id: 'refresh-radar', label: 'Refresh from sources', botId: defaultBotId,
              prompt: 'Read this space first. Verify the competitors and changes against primary sources. Update matching items in the competitors block by their existing item id, or add a record with title, eyebrow (category), summary, url (verified source), and optional image, badge or metric. Keep records without confirmed changes. Never invent observations or rewrite the canvas for a data refresh.',
            }],
          }] : []),
        ],
      }

    case 'scoreboard':
      return {
        theme: pickTheme({ accent: 'amber', style: 'editorial' }),
        blocks: [
          { id: 'games', type: 'cards', title: 'Schedule and scores', columns: 2, variant: 'matchup' },
          { id: 'canvas', type: 'html', title: 'Scoreboard', frameless: true, viewOf: ['games', 'standings'], html: SCOREBOARD_CANVAS },
          {
            id: 'standings', type: 'table', title: 'Standings',
            columns: [
              { key: 'rank', label: '#', kind: 'number' },
              { key: 'logo', label: 'Logo', kind: 'image' },
              { key: 'conference', label: 'Conference', kind: 'text' },
              { key: 'wins', label: 'W', kind: 'number' },
              { key: 'losses', label: 'L', kind: 'number' },
              { key: 'winPct', label: 'Win %', kind: 'number' },
              { key: 'gamesBehind', label: 'GB', kind: 'number' },
              { key: 'streak', label: 'Streak', kind: 'badge' },
            ],
          },
          ...(defaultBotId ? [{
            id: 'refresh', type: 'action_bar' as const, title: 'Sources',
            actions: [{
              id: 'refresh-scores', label: 'Refresh from sources', botId: defaultBotId,
              prompt: 'Read this space and use its configured league or competition. Verify schedule, scores, and standings from a primary source. Update games by item id with ISO startsAt, awayTeam, homeTeam, separate team logo URLs, confirmed numeric scores, and status scheduled/live/final. Use merge_data=true when updating standings to keep existing team logos. Include source URLs. If the competition is unspecified, ask before fetching.',
            }],
          }] : []),
        ],
      }

    case 'tracker':
      return {
        theme: pickTheme({ accent: 'blue', style: 'editorial' }),
        blocks: [
          {
            id: 'kpi',
            type: 'metrics',
            title: 'Summary',
            span: 'full',
            cards: [
              { label: 'Total entries', blockId: 'records', agg: 'count', tone: 'accent' },
              { label: 'Active', blockId: 'records', agg: 'count', filterStatus: 'active', tone: 'positive' },
              { label: 'Total score / value', blockId: 'records', agg: 'sum', itemField: 'value', tone: 'neutral' },
            ],
          },
          {
            id: 'records',
            type: 'table',
            title: 'Records',
            subtitle: 'Structured rows kept up to date by you and your teammates.',
            span: 'full',
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
            variant: 'callout',
            span: defaultBotId ? 'wide' : 'full',
            content: 'Keep methodology, definitions, or key takeaways here.',
          },
          ...(defaultBotId
            ? [{
              id: 'actions',
              type: 'action_bar' as const,
              title: 'Quick actions',
              span: 'narrow' as const,
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
        theme: pickTheme({ accent: 'indigo', style: 'editorial' }),
        blocks: [
          {
            id: 'kpi',
            type: 'metrics',
            title: 'Board status',
            span: 'full',
            cards: [
              { label: 'Backlog', blockId: 'board', agg: 'count', filterStatus: 'backlog', tone: 'neutral' },
              { label: 'In progress', blockId: 'board', agg: 'count', filterStatus: 'doing', tone: 'accent' },
              { label: 'Done', blockId: 'board', agg: 'count', filterStatus: 'done', tone: 'positive' },
            ],
          },
          {
            id: 'board',
            type: 'kanban',
            title: 'Board',
            subtitle: 'Move cards across stages as work progresses.',
            span: 'full',
            columns: [
              { key: 'backlog', label: 'Backlog', color: 'slate' },
              { key: 'doing', label: 'In progress', color: 'blue' },
              { key: 'review', label: 'Review', color: 'amber' },
              { key: 'done', label: 'Done', color: 'emerald' },
            ],
          },
          {
            id: 'checks',
            type: 'checklist',
            title: 'Checklist',
            span: 'half',
          },
          {
            id: 'notes',
            type: 'markdown',
            title: 'Working notes',
            variant: 'callout',
            span: 'half',
            content: 'Capture scope boundaries, review criteria, or handoff notes here.',
          },
        ],
      }

    case 'dashboard':
      return {
        theme: pickTheme({ accent: 'emerald', style: 'editorial' }),
        blocks: [
          {
            id: 'kpi',
            type: 'metrics',
            title: 'Key metrics',
            span: 'full',
            cards: [
              { label: 'Data points', blockId: 'series', agg: 'count', tone: 'neutral' },
              { label: 'Total', blockId: 'series', agg: 'sum', itemField: 'value', tone: 'accent' },
              { label: 'Average', blockId: 'series', agg: 'avg', itemField: 'value', tone: 'positive' },
            ],
          },
          {
            id: 'series',
            type: 'chart',
            title: 'Breakdown',
            subtitle: 'Live native chart synced directly from your Space items.',
            span: 'wide',
            mode: 'horizontal',
            labelField: 'title',
            valueField: 'value',
          },
          {
            id: 'events',
            type: 'timeline',
            title: 'Timeline',
            span: 'narrow',
          },
          {
            id: 'notes',
            type: 'markdown',
            title: 'Summary notes',
            variant: 'callout',
            span: 'full',
            content: 'Add high-level takeaways and key decision triggers here.',
          },
        ],
      }

    case 'cards':
      return {
        theme: pickTheme({ accent: 'rose', style: 'editorial' }),
        blocks: [
          {
            id: 'kpi',
            type: 'metrics',
            title: 'Collection pulse',
            span: 'full',
            cards: [
              { label: 'Total cards', blockId: 'gallery', agg: 'count', tone: 'accent' },
              { label: 'Featured', blockId: 'gallery', agg: 'count', filterStatus: 'featured', tone: 'positive' },
              { label: 'In review', blockId: 'gallery', agg: 'count', filterStatus: 'review', tone: 'warning' },
            ],
          },
          {
            id: 'gallery',
            type: 'cards',
            title: 'Showcase cards',
            subtitle: 'Rich visual cards with cover images, key metrics, tags, and source links.',
            span: 'full',
            columns: 3,
            aspect: 'wide',
          },
          {
            id: 'notes',
            type: 'markdown',
            title: 'Editorial brief',
            variant: 'callout',
            span: defaultBotId ? 'wide' : 'full',
            content: 'Capture curation standards, visual notes, or next comparison criteria here.',
          },
          ...(defaultBotId
            ? [{
              id: 'actions',
              type: 'action_bar' as const,
              title: 'Quick actions',
              span: 'narrow' as const,
              actions: [
                {
                  id: 'curate',
                  label: 'Ask teammate to add cards',
                  botId: defaultBotId,
                  prompt: 'Review this visual card space and add or refresh cards in the gallery block with verified titles, summaries, cover images, tags, and links.',
                },
              ],
            }]
            : []),
        ],
      }

    case 'html':
      return {
        theme: pickTheme({ accent: 'indigo', style: 'editorial' }),
        blocks: [
          {
            id: 'canvas',
            type: 'html',
            title: 'HTML Canvas',
            subtitle: 'Sandboxed full HTML / CSS / SVG / JS canvas — edit directly or ask a teammate to design it.',
            span: 'full',
            frameless: true,
            html: `<!doctype html><html lang="en"><head><title>HTML Canvas</title></head><body>${STARTER_HTML_CANVAS}</body></html>`,
          },
        ],
      }

    case 'blank':
    default:
      return {
        theme: pickTheme({ accent: 'slate', style: 'minimal' }),
        blocks: [
          {
            id: 'notes',
            type: 'markdown',
            title: 'Notes',
            span: 'full',
            content: 'Start with notes or ask a teammate to design a custom Bento layout for this space.',
          },
        ],
      }
  }
}
