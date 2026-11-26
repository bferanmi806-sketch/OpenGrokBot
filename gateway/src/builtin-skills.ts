/**
 * 随网关内置的共享技能（只读）；若操作者在 <dataDir>/skills/<name>.md 写了同名文件，用户版本自动覆盖内置版本。
 * 这样技能随 dist 一起打包、零外部路径依赖，同时保持系统提示词只放一行简介、按需 read_skill 加载的省 token 设计。
 */
export type BuiltinSkill = {
  name: string
  description: string
  body: string
}

export const SPACE_DESIGN_SKILL_NAME = 'space-design'

const SPACE_DESIGN_BODY = `# Declarative Space Design Playbook

Use this playbook before calling \`manage_space(action="create")\` or \`manage_space(action="set_schema")\` so every Space looks like an intentional, publication-grade workspace — never a raw dump of unstyled tables.

## 1. Choose the output before drawing the layout
- Competitor monitoring: start from the \`radar\` template. Use the same competitor items for the native cards and the filterable canvas.
- Sports fixtures or scores: start from the \`scoreboard\` template. Use one item per game in \`games\`, with \`awayTeam\`, \`homeTeam\`, separate \`awayLogo\` / \`homeLogo\` image URLs, ISO \`startsAt\` with a timezone, and numeric \`awayScore\` / \`homeScore\` only when scores are known. Use \`scheduled\`, \`live\` or \`final\` status and a verified source URL. Store standings separately in \`standings\` with a real logo, conference, rank, wins and losses. Leave unconfirmed results empty.
- Visual collections: use a populated \`cards\` block, with an image when it helps identify the item and a summary and source on every record where available.
- An explicit request for full HTML or bespoke interaction needs an actual \`html\` block with a self-contained document. Include a clear empty state if records are unavailable.

For a dense operations dashboard, use a three-layer hierarchy:
1. **Pulse strip (top, \`span: "full"\`)** — 3 to 4 \`metrics\` cards that answer "how are we doing right now?" before the user reads a single row. Prefer live aggregation (\`blockId\` + \`agg: "count" | "sum" | "avg"\`) over static text so numbers stay alive.
2. **Primary canvas (middle, Bento grid)** — Pair a primary workspace block with a complementary block instead of stacking everything full-width:
   - **7:5 split** (\`span: "wide"\` + \`span: "narrow"\`): \`chart\` or \`table\` on the left, \`timeline\`, \`checklist\`, or \`markdown\` (\`variant: "callout"\`) on the right.
   - **6:6 split** (\`span: "half"\` + \`span: "half"\`): two peer charts (e.g., \`donut\` + \`area\`), or \`checklist\` + \`markdown\` callout below a full-width \`kanban\` or \`table\`.
   - Keep wide tables (\`>= 4 columns\`) and 4-column \`kanban\` boards at \`span: "full"\` so columns never feel cramped.
3. **Action & context footer** — Put an \`action_bar\` with 1–3 crisp teammate actions (e.g. "Refresh data", "Run weekly audit") and/or a concise executive \`markdown\` note (\`variant: "callout"\`) summarizing methodology or key takeaways.

## 2. Cohesive Theme & Semantic Color
Pick **one** \`theme.accent\` that matches the Space's domain (and \`theme.style: "editorial"\` for dashboards/trackers, \`"minimal"\` for quiet notes):
- \`blue\` — Operations, product tracking, competitor & vendor radars
- \`indigo\` — Research briefs, knowledge hubs, roadmap & kanban boards
- \`emerald\` — Finance, pricing, KPI dashboards, growth & market metrics
- \`amber\` — Reviews, deadlines, audit checklists, risk watchlists
- \`rose\` — Incidents, blockers, escalations, high-urgency tracking
- \`slate\` — Neutral reference notes or personal lists

Use semantic accents sparingly inside blocks:
- **Metrics \`tone\`**: \`accent\` for the primary KPI, \`positive\` for completed/healthy counts, \`warning\` for pending/at-risk items, \`danger\` for overdue/blocked items, \`neutral\` for totals. Add \`target\` (number) on goal-bound KPIs to show a clean progress bar.
- **Kanban column \`color\`**: progress left-to-right naturally (e.g. \`slate\` → \`blue\` → \`amber\` → \`emerald\`).

## 3. Chart Selection (Native SVG)
Choose the chart \`mode\` that actually fits the data instead of defaulting blindly:
- \`horizontal\` — Ranked comparisons with readable labels (competitor prices, vendor scores, top topics).
- \`bar\` — Compact vertical comparisons across 3–8 short categories (monthly totals, quarterly buckets).
- \`donut\` — Part-to-whole composition across 2–6 slices (budget split, task distribution, share by category).
- \`area\` — Sequential trends over time (daily/weekly metrics, price history, burn-down).

Whenever possible, bind \`chart.sourceBlockId\` to a \`table\` block so adding or updating one record updates both the table and the chart automatically.

## 4. Rich Visual Cards (\`cards\` block) & Images
When items deserve visual presence — products, competitors, reading picks, inspiration boards, travel options, or multi-field profiles — use a \`cards\` block (\`columns: 2 | 3\`, \`aspect: "wide" | "square" | "compact"\`) and populate items via \`space_upsert_item\` with structured \`data\`:
- \`image\`: verified \`https://\` image URL, uploaded \`/api/uploads/<id>\`, bot screenshot \`/api/screenshots/<bot>/<file>\`, or compact base64 \`data:image/*\`
- \`eyebrow\`: crisp uppercase category/source label above the title
- \`badge\`: status or tier pill (auto-colored semantically)
- \`metric\` + \`metricLabel\`: headline figure (e.g. \`"$29/mo"\` + \`"Pro tier"\`)
- \`summary\`: 1–3 concise lines describing what matters
- \`tags\`: comma-separated chips (e.g. \`"Fast, Open Weights, Vision"\`)
- \`url\` + \`urlLabel\`: verified \`http(s)\` source link

Tables also support \`kind: "image"\` columns for crisp avatars, thumbnails, or logos alongside numbers and badges.

## 5. Full Sandboxed HTML Canvas (\`html\` block)
When the operator asks for a bespoke visual design, magazine/editorial hero, complex multi-layer cards, custom infographic/SVG diagrams, interactive tabs/filters/calculators, or high-craft product showcase, use an \`html\` block (\`{ id, type: "html", title, span: "full", frameless: true, html: "..." }\`):
- **Sandbox rules**: \`html\` renders inside a null-origin \`<iframe sandbox="allow-scripts">\` with \`connect-src 'none'\` and \`script-src 'unsafe-inline'\`. Never depend on external JS/CSS CDNs — write completely self-contained inline \`<style>\`, \`<svg>\`, and \`<script>\`. External \`https://\` images, \`/api/uploads/...\`, \`/api/screenshots/...\`, and \`data:image/*\` all render cleanly.
- **Native theme harmony**: Use the host-injected CSS custom properties (\`--bg\`, \`--bg-card\`, \`--bg-raised\`, \`--text\`, \`--text-dim\`, \`--text-faint\`, \`--border\`, \`--border-strong\`, \`--space-accent\`, \`--space-accent-soft\`, \`--space-accent-border\`, \`--space-accent-glow\`, \`--green\`, \`--amber\`, \`--red\`) so your HTML adapts seamlessly to both Dark and Light themes.
- **Live data binding**: \`window.SPACE_DATA\` is available before your scripts run. It exposes \`{ spaceTitle, theme, accent, locale, items }\`. Render once from \`window.SPACE_DATA\`. For a page with interactive controls, mark the document with \`<html data-space-live>\` and subscribe to \`window.addEventListener("space-data", event => render(event.detail))\` so record changes preserve the active filter. Create DOM text with \`textContent\` for records from outside sources.
- **Shared view**: set the HTML block's \`viewOf\` to an array of existing native block IDs to add a Cards / HTML switch. Keep the same block IDs and update records by item ID so both views refresh. Source links and team logos can come from stored image URLs or uploaded assets. Use the workspace's refresh action to request verified updates.
- **Art direction discipline**:
  - Give the top a memorable editorial hero or visual anchor (custom SVG graphic, cover image with gradient scrim, or asymmetric KPI spotlight).
  - Build complex cards with layered structure: visual header/cover → eyebrow + status pill → crisp title → structured metric strip or spec grid → footer tags/links.
  - Keep spacing generous (\`16–24px\` card padding, \`12–16px\` gaps), use \`font-variant-numeric: tabular-nums\` for numbers, and ensure responsive CSS Grid (\`repeat(auto-fit, minmax(240px, 1fr))\`).
  - Omit \`height\` unless you need a fixed viewport — the host auto-resizes the iframe to fit your content cleanly without double scrollbars.

## 6. Restraint & Copy Craft
- **Block count**: Aim for **1 to 6 blocks** total (a full-page bespoke HTML Space can simply be 1 frameless \`html\` block, optionally paired with an \`action_bar\` or live \`table\`/\`cards\` block underneath). Never add empty filler blocks "just in case".
- **Titles & subtitles**: Block titles should be 2–4 crisp words; add a short one-line \`subtitle\` only when it clarifies scope or cadence (e.g. "Updated Mondays by @Scout").
- **Tables**: Keep to **3 to 5 columns**. Put status/tier/category in \`badge\`, metrics in \`number\`, primary sources in \`url\`, thumbnails in \`image\`, dates in \`date\`. Avoid walls of text in table cells.
- **Populate immediately**: Right after creating a Space, seed it with real initial records via \`space_upsert_item\` or rich initial HTML content (never fabricate facts — clearly mark placeholders if data is pending).

## 7. Proven Recipes
- **Editorial Visual Showcase / Custom App** (\`accent: "indigo"\`): \`html\` (\`full\`, \`frameless: true\`, bespoke hero + complex image/SVG cards + interactive filter/tabs) + optional \`action_bar\` (\`full\`, refresh/update with teammate).
- **Rich Visual Card Wall** (\`accent: "rose"\`): \`metrics\` (\`full\`, 3 cards) → \`cards\` (\`full\`, 3-col \`wide\` aspect with cover images, metrics, tags, links) → \`markdown\` callout (\`wide\`) + \`action_bar\` (\`narrow\`).
- **Competitor / Vendor Radar** (\`accent: "blue"\`): \`metrics\` (\`full\`, 3 cards) → \`chart\` (\`wide\`, \`horizontal\`, bound to \`records\`) + \`markdown\` callout (\`narrow\`, key takeaways) → \`table\` (\`full\`, \`records\`, 4 columns) → \`action_bar\` (\`full\`).
- **Project / Launch Board** (\`accent: "indigo"\`): \`metrics\` (\`full\`, backlog/active/done + completion target) → \`kanban\` (\`full\`, 4 colored columns) → \`checklist\` (\`half\`) + \`timeline\` (\`half\`).
- **Executive KPI Dashboard** (\`accent: "emerald"\`): \`metrics\` (\`full\`, 4 cards with tones) → \`chart\` (\`wide\`, \`area\` or \`bar\`) + \`chart\` (\`narrow\`, \`donut\`) → \`timeline\` (\`wide\`) + \`action_bar\` (\`narrow\`).`

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  {
    name: SPACE_DESIGN_SKILL_NAME,
    description: 'Visual hierarchy, Bento layout recipes, rich image cards, and full sandboxed HTML/CSS/SVG/JS craft rules for designing Spaces.',
    body: SPACE_DESIGN_BODY,
  },
]

export function findBuiltinSkill(name: string): BuiltinSkill | undefined {
  const wanted = name.trim().toLowerCase().replace(/\.md$/, '')
  return BUILTIN_SKILLS.find((s) => s.name === wanted)
}
