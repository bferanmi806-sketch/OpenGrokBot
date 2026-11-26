const CANVAS_STYLE = `
  :root { --canvas-raised: var(--bg-card); }
  main { display: grid; gap: 20px; padding: 2px 2px 12px; }
  .overview {
    display: flex; justify-content: space-between; align-items: end; gap: 24px;
    padding: clamp(18px, 4vw, 34px); border: 1px solid var(--space-accent-border);
    border-radius: 16px; background: var(--space-accent-soft);
  }
  h1, h2, p { margin: 0; }
  h1 { font-size: clamp(23px, 4vw, 36px); line-height: 1.13; letter-spacing: -.045em; }
  .overview p { margin-top: 8px; color: var(--text-dim); }
  .updated { color: var(--text-dim); white-space: nowrap; font-size: 12px; font-variant-numeric: tabular-nums; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px; }
  button {
    padding: 6px 11px; border: 1px solid var(--border); border-radius: 7px;
    background: var(--canvas-raised); color: var(--text-dim); font: inherit; cursor: pointer;
  }
  button[aria-pressed="true"] { color: var(--text); font-weight: 650; background: var(--space-accent-soft); border-color: var(--space-accent-border); }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--space-accent); outline-offset: 3px; }
  .records { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .scoreboard .records { grid-template-columns: 1fr; }
  .record {
    min-width: 0; display: grid; align-content: start; gap: 12px; padding: clamp(14px, 3vw, 22px);
    border: 1px solid var(--border); border-radius: 12px; background: var(--canvas-raised); overflow-wrap: anywhere;
  }
  .record-top, .title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .record-top { justify-content: space-between; }
  .record h2 { font-size: 17px; line-height: 1.25; }
  .record p, .meta { color: var(--text-dim); }
  .label { padding: 2px 7px; border-radius: 5px; background: var(--space-accent-soft); color: var(--text); font-size: 11px; }
  .metric { display: flex; align-items: baseline; gap: 7px; font-variant-numeric: tabular-nums; }
  .metric strong { font-size: 20px; }
  .record a { width: fit-content; text-underline-offset: 3px; }
  .logo {
    width: 38px; height: 38px; flex: none; display: inline-grid; place-items: center;
    border: 1px solid var(--border); background: var(--bg-raised); border-radius: 9px;
    color: var(--text-dim); font-size: 12px; font-weight: 650;
  }
  .logo img { width: 100%; height: 100%; padding: 4px; object-fit: contain; }
  .match {
    display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center; gap: clamp(10px, 4vw, 32px); text-align: center;
  }
  .team { display: grid; justify-items: center; gap: 6px; min-width: 0; }
  .team .logo { width: 56px; height: 56px; }
  .score { font-size: clamp(22px, 6vw, 42px); font-weight: 720; letter-spacing: -.04em; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .empty { padding: 18px; border: 1px dashed var(--border-strong); border-radius: 10px; color: var(--text-dim); grid-column: 1 / -1; }
  .standings { display: grid; gap: 10px; }
  .standings[hidden] { display: none; }
  .standings h2 { font-size: 19px; }
  .table-wrap { max-width: 100%; overflow: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--canvas-raised); }
  table { width: 100%; min-width: 480px; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 9px 12px; text-align: right; border-bottom: 1px solid var(--border); }
  th { color: var(--text-dim); font-size: 12px; background: var(--bg-raised); }
  th:nth-child(2), td:nth-child(2) { text-align: left; }
  tbody tr:last-child td { border-bottom: 0; }
  .standing-team { display: flex; align-items: center; gap: 8px; }
  .standing-team .logo { width: 28px; height: 28px; border-radius: 6px; }
  @media (max-width: 620px) {
    .overview { align-items: start; flex-direction: column; gap: 9px; }
    .records { grid-template-columns: 1fr; }
  }
  @media (max-width: 360px) {
    .team .logo { width: 42px; height: 42px; }
  }
`

const CANVAS_SCRIPT = String.raw`
  const scoreboard = document.body.classList.contains('scoreboard');
  const blockId = scoreboard ? 'games' : 'competitors';
  const zh = String(window.SPACE_DATA.locale).startsWith('zh');
  const locale = zh ? 'zh-CN' : 'en';
  const labels = zh
    ? { radar: '竞品动向', radarNote: '按类别查看产品变化、关键指标和一手来源。', games: '赛程与比分', gamesNote: '按日期查看开赛时间和比赛结果。', all: '全部', today: '今天', updated: '更新于', empty: '暂无记录。添加记录后，这里会自动更新。', other: '未分类', source: '查看来源', scheduled: '待开赛', live: '进行中', final: '已结束', tainted: '来自外部来源' }
    : { radar: 'Market pulse', radarNote: 'Explore product changes, key metrics, and primary sources by category.', games: 'Schedule and scores', gamesNote: 'Browse start times and results by date.', all: 'All', today: 'Today', updated: 'Updated', empty: 'Add a record to see it here. This view updates automatically.', other: 'Uncategorized', source: 'View source', scheduled: 'Scheduled', live: 'Live', final: 'Final', tainted: 'External source' };
  const rankings = zh
    ? { title: '联盟排名', east: '东部', west: '西部', columns: ['#', '球队', '胜', '负', '胜率', '胜差', '近况'] }
    : { title: 'Standings', east: 'East', west: 'West', columns: ['#', 'Team', 'W', 'L', 'Win %', 'GB', 'Streak'] };
  const filters = document.querySelector('.filters');
  const records = document.querySelector('.records');
  let selected = '';
  let conference = '';
  const day = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateLabel = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', weekday: 'short' });
  const timeLabel = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const updateLabel = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  document.documentElement.lang = locale;
  document.querySelector('h1').textContent = scoreboard ? labels.games : labels.radar;
  document.querySelector('.overview p').textContent = scoreboard ? labels.gamesNote : labels.radarNote;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function safeUrl(value, image) {
    if (typeof value !== 'string') return '';
    if (image && /^data:image\//i.test(value)) return value;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {}
    return '';
  }
  function logo(name, value) {
    const fallback = String(name || '?').trim().slice(0, 2).toLocaleUpperCase(locale);
    const box = element('span', 'logo', fallback);
    box.setAttribute('aria-hidden', 'true');
    const src = safeUrl(value, true);
    if (src) {
      const img = element('img');
      img.src = src;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { box.textContent = fallback; }, { once: true });
      box.replaceChildren(img);
    }
    return box;
  }
  function startOf(item) {
    const raw = item.data.startsAt;
    if (typeof raw !== 'string' || !raw) return null;
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function groupOf(item) {
    if (!scoreboard) return String(item.data.eyebrow || labels.other);
    const started = startOf(item);
    return started ? dateKey(started) : labels.other;
  }
  function dateKey(date) {
    const parts = Object.fromEntries(day.formatToParts(date).map(({ type, value }) => [type, value]));
    return [parts.year, parts.month, parts.day].join('-');
  }
  function linkFor(item) {
    const url = safeUrl(item.data.url, false);
    if (!url) return null;
    const link = element('a', '', item.data.urlLabel || labels.source);
    link.href = url;
    return link;
  }
  function competitorCard(item) {
    const card = element('article', 'record');
    const top = element('div', 'record-top');
    top.append(element('span', 'meta', groupOf(item)));
    if (item.data.badge) top.append(element('span', 'label', item.data.badge));
    const title = element('div', 'title-row');
    title.append(logo(item.title, item.data.image), element('h2', '', item.title));
    card.append(top, title);
    if (item.data.summary) card.append(element('p', '', item.data.summary));
    if (item.data.metric != null && item.data.metric !== '') {
      const metric = element('div', 'metric');
      metric.append(element('strong', '', item.data.metric), element('span', 'meta', item.data.metricLabel));
      card.append(metric);
    }
    return card;
  }
  function team(name, image, record) {
    const side = element('div', 'team');
    side.append(logo(name, image), element('strong', '', name));
    if (record) side.append(element('span', 'meta', record));
    return side;
  }
  function gameCard(item) {
    const card = element('article', 'record');
    const data = item.data;
    const top = element('div', 'record-top');
    const start = startOf(item);
    top.append(element('span', 'label', data.badge || labels[item.status] || item.status || labels.scheduled));
    if (start) {
      const time = element('time', 'meta', timeLabel.format(start));
      time.dateTime = start.toISOString();
      top.append(time);
    }
    const match = element('div', 'match');
    const scores = [data.awayScore, data.homeScore];
    const result = scores.every((value) => typeof value === 'number' || (typeof value === 'string' && value.trim()))
      ? scores.join(' : ') : 'VS';
    match.append(
      team(data.awayTeam || item.title, data.awayLogo, data.awayRecord),
      element('strong', 'score', result),
      team(data.homeTeam || '—', data.homeLogo, data.homeRecord),
    );
    card.append(top, match);
    if (data.summary) card.append(element('p', '', data.summary));
    return card;
  }
  function renderStandings(items) {
    const section = document.querySelector('.standings');
    const rows = items.filter(item => item.blockId === 'standings').sort((a, b) =>
      (Number(a.data.rank) || Infinity) - (Number(b.data.rank) || Infinity) || a.sortOrder - b.sortOrder,
    );
    const regions = [...new Set(rows.map(item => String(item.data.conference || labels.other)))];
    if (!regions.includes(conference)) conference = regions[0] || '';
    const selector = section.querySelector('.filters');
    selector.replaceChildren();
    for (const key of regions) {
      const lower = key.toLowerCase();
      const text = /^(east|东)/.test(lower) ? rankings.east : /^(west|西)/.test(lower) ? rankings.west : key;
      const button = element('button', '', text);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(key === conference));
      button.addEventListener('click', () => {
        conference = key;
        renderStandings(items);
        selector.querySelector('[aria-pressed="true"]')?.focus();
      });
      selector.append(button);
    }
    const header = section.querySelector('thead tr');
    header.replaceChildren(...rankings.columns.map(label => {
      const cell = element('th', '', label);
      cell.scope = 'col';
      return cell;
    }));
    const body = section.querySelector('tbody');
    body.replaceChildren();
    for (const item of rows.filter(item => String(item.data.conference || labels.other) === conference)) {
      const row = element('tr');
      const title = element('div', 'standing-team');
      title.append(logo(item.title, item.data.logo), element('strong', '', item.title));
      const teamCell = element('td');
      teamCell.append(title);
      row.append(element('td', '', item.data.rank ?? '—'), teamCell);
      for (const key of ['wins', 'losses', 'winPct', 'gamesBehind', 'streak']) row.append(element('td', '', item.data[key] ?? '—'));
      body.append(row);
    }
    section.querySelector('h2').textContent = rankings.title;
    section.hidden = !rows.length;
  }
  function render(state) {
    const items = state.items.filter(item => item.blockId === blockId);
    items.sort((a, b) => scoreboard
      ? (startOf(a)?.getTime() ?? Infinity) - (startOf(b)?.getTime() ?? Infinity) || a.sortOrder - b.sortOrder
      : b.updatedAt - a.updatedAt || a.sortOrder - b.sortOrder);
    const allGroups = [...new Set(items.map(groupOf))];
    if (!allGroups.includes(selected)) selected = '';
    const lastUpdate = Math.max(0, ...state.items.filter(item => scoreboard || item.blockId === blockId).map(item => item.updatedAt));
    document.querySelector('.updated').textContent = lastUpdate > 0
      ? labels.updated + ' ' + updateLabel.format(new Date(lastUpdate)) : '';
    filters.replaceChildren();
    if (allGroups.length) {
      for (const key of ['', ...allGroups]) {
        const date = new Date(key + 'T12:00:00');
        const label = scoreboard && Number.isFinite(date.getTime())
          ? (key === dateKey(new Date()) ? labels.today : dateLabel.format(date)) : key;
        const button = element('button', '', label || labels.all);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(key === selected));
        button.addEventListener('click', () => {
          selected = key;
          render(window.SPACE_DATA);
          const active = [...filters.querySelectorAll('button')].find(control => control.getAttribute('aria-pressed') === 'true');
          active?.focus();
        });
        filters.append(button);
      }
    }
    records.replaceChildren();
    for (const item of items.filter(item => !selected || groupOf(item) === selected)) {
      const card = scoreboard ? gameCard(item) : competitorCard(item);
      if (item.tainted) card.append(element('span', 'meta', labels.tainted));
      const link = linkFor(item);
      if (link) card.append(link);
      records.append(card);
    }
    if (!records.childElementCount) records.append(element('p', 'empty', labels.empty));
    if (scoreboard) renderStandings(state.items);
  }
  render(window.SPACE_DATA);
  window.addEventListener('space-data', (event) => render(event.detail));
`

function buildCanvas(layout: 'radar' | 'scoreboard'): string {
  return `<!doctype html>
<html lang="en" data-space-live>
<head><title>${layout === 'radar' ? 'Market pulse' : 'Schedule and scores'}</title><style>${CANVAS_STYLE}</style></head>
<body class="${layout}">
  <main>
    <header class="overview"><div><h1></h1><p></p></div><span class="updated"></span></header>
    <div class="filters"></div>
    <div class="records"></div>
    ${layout === 'scoreboard' ? '<section class="standings" hidden><h2></h2><div class="filters"></div><div class="table-wrap"><table><thead><tr></tr></thead><tbody></tbody></table></div></section>' : ''}
  </main>
  <script>${CANVAS_SCRIPT}</script>
</body>
</html>`
}

export const RADAR_CANVAS = buildCanvas('radar')
export const SCOREBOARD_CANVAS = buildCanvas('scoreboard')
