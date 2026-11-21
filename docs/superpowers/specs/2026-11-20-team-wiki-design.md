# Phase 4 Design: Zero-Vector Shared Team Entity Wiki (SQLite FTS5 + Multi-Query RRF)

**Date:** 2026-11-20  
**Status:** Approved  
**Branch:** `feat/team-wiki`  
**Scope:** Shared structured Markdown entity Wiki (`contact`, `client`, `project`, `topic`) backed by SQLite `v14` (`wiki_pages`, `wiki_revisions`, `wiki_fts`) + `<data>/wiki/<kind>/<slug>.md` disk mirror, CJK + English FTS5 tokenization, multi-query Reciprocal Rank Fusion (RRF) with gentle time decay, cross-agent `outside-data` taint propagation, three agent tools (`wiki_search`, `wiki_read`, `wiki_upsert`), REST API (`/api/wiki/*`), and bilingual Dark/Light UI (`WikiDialog`).

---

## 1. Goals & Security Invariants

### Goals
1. **Break teammate knowledge silos with zero external infrastructure:** Facts learned by one teammate (a client preference, contact detail, project status, or research topic) are immediately searchable by every teammate via SQLite's built-in FTS5 engine — zero vector database, zero embedding downloads, zero background daemons.
2. **Bilingual CJK + English precision:** Search works accurately for short Chinese names/terms (`"极光"`, `"张伟"`, `"报价"`), English identifiers (`"Acme"`, `"Q3 roadmap"`), and mixed queries via CJK bigram + English token indexing.
3. **Multi-query RRF + gentle recency bias:** `wiki_search` accepts 1–6 query rewrites (synonyms, bilingual translations, aliases) and merges FTS5 BM25 ranked lists via RRF ($k = 60$) multiplied by gentle time decay so recent context surfaces first without burying long-lived client profiles.
4. **Prompt-cache preservation:** Dynamic Wiki pages are **never** injected into the fixed System Prompt. Teammates receive a short static prompt guideline and call `wiki_search` / `wiki_read` on demand.
5. **Human-readable & reversible:** Every active Wiki page is mirrored atomically to `<data>/wiki/<kind>/<slug>.md` with YAML frontmatter, and SQLite retains up to 20 revisions per page for one-click inspection and revert.

### Security & Custody Boundaries
1. **Lives outside every bot workspace/container:** `<data>/wiki/` resides in the gateway data directory (never mounted in Docker containers, never writable by local Seatbelt/bubblewrap sandboxes). Teammates interact with the Wiki exclusively through gateway tools.
2. **Cross-agent `outside-data` taint propagation:**
   - Any `wiki_upsert` performed during a turn already marked `tainted` (`outside-data`, e.g. after reading a webpage, email, webhook, or MCP output) or originating from `webhook` sets `source_tainted = 1` on the page and its revision.
   - Any teammate calling `wiki_read` on a page with `source_tainted = 1` receives `tainted: true`, immediately tainting the reading turn as `outside-data` so standing approval rules (`Always allow…`) cannot be bypassed by laundering untrusted web/email text through the Wiki.
   - When the operator reviews and saves the page in the UI (`PUT /api/wiki/:kind/:slug`), `source_tainted` is cleared to `0` (`updated_by = 'operator'`). Reverting to a historical revision via `POST /api/wiki/:kind/:slug/revert` sets `source_tainted = 0` when the operator explicitly confirms the revert (or preserves the target revision's content under `edited_by = 'operator'`, since the operator reviewed the revision text they are restoring).
3. **`watch` routines are read-only:** `wiki_search` and `wiki_read` are included in `WATCH_TOOL_NAMES`; `wiki_upsert` is omitted from tool schemas and refused at runtime in `watch` mode.
4. **Never touches `MEMORY.md`:** Wiki stores shared factual knowledge only; per-teammate behavioral rules remain exclusively in tamper-evident `<data>/bots/<botId>/MEMORY.md`.

---

## 2. Storage Schema (`v14`) & Disk Mirror

### 2.1 SQLite Migration `v14` (`gateway/src/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS wiki_pages (
  id TEXT PRIMARY KEY,              -- "<kind>/<slug>", e.g. "client/acme-corp"
  kind TEXT NOT NULL,               -- "contact" | "client" | "project" | "topic"
  slug TEXT NOT NULL,               -- lowercase [a-z0-9][a-z0-9-]{0,63}
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  source_tainted INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL DEFAULT 'operator',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE(kind, slug)
);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_active ON wiki_pages(archived_at, kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS wiki_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL DEFAULT '',
  edited_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source_tainted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(page_id, version)
);
CREATE INDEX IF NOT EXISTS idx_wiki_revisions_page ON wiki_revisions(page_id, version DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  page_id UNINDEXED,
  title,
  tags,
  summary,
  body,
  search_text,
  tokenize='unicode61 remove_diacritics 2'
);
```

### 2.2 CJK + English Tokenization (`gateway/src/wiki/tokenize.ts`)
- `buildSearchText(parts: string[]): string`:
  - Extracts Latin/alphanumeric tokens (lowercased) verbatim.
  - For every contiguous CJK run (`[\u3400-\u9FFF\uF900-\uFAFF]+`): emits every adjacent 2-character bigram (`"极光项目"` → `"极光 光项 项目"`) plus individual characters for single-character runs (or runs ≤ 4 chars so single-char terms also match).
- `buildFtsQuery(rawQuery: string): string | null`:
  - Normalizes the raw query with the same Latin + CJK bigram rules (never passing raw FTS5 operators like `*`, `"`, `:`, `-`, `NEAR`, `AND`, `OR`, `NOT` unquoted).
  - Quotes each extracted token (`"tok"`) and joins them with `AND` (falling back to `OR` when an `AND` query of ≥ 3 tokens returns 0 hits so longer natural-language phrases still recall relevant pages).
  - Returns `null` for blank/punctuation-only input.

### 2.3 Atomic Disk Mirror (`gateway/src/wiki/mirror.ts`)
- Active pages are written atomically (temp file + `renameSync`) to `<data>/wiki/<kind>/<slug>.md` with deterministic YAML frontmatter (`id`, `kind`, `slug`, `title`, `summary`, `tags`, `version`, `updated_by`, `source_tainted`, `updated_at`) followed by the Markdown body.
- Strict path validation ensures `kind` is one of the 4 enum values and `slug` matches `/^[a-z0-9][a-z0-9-]{0,63}$/` (zero path-traversal possibility).
- Archiving/deleting a page removes `<data>/wiki/<kind>/<slug>.md` cleanly (`rmSync(..., { force: true })`).
- If `dataDir` is empty (in-memory tests), mirror writes are cleanly skipped.

---

## 3. Multi-Query RRF Retrieval (`gateway/src/wiki/rrf.ts`)

- Accepts `queries: string[]` (trimmed, deduplicated, 1–6 queries), optional `kind`, and `limit` (default `8`, clamped `1..20`).
- For each query `q`:
  1. Executes FTS5 BM25 query (`bm25(wiki_fts, 0.0, 5.0, 3.0, 2.0, 1.0, 2.0)` weighting `title` > `tags` > `summary`/`search_text` > `body`) joined with `wiki_pages` (`archived_at IS NULL`, optional `kind = ?`), returning top `30` ranked `page_id`s.
  2. If `AND` returns 0 rows and query has ≥ 3 tokens, runs an `OR` fallback with a `0.5` weight multiplier so exact matches always outrank partial matches.
- Combines ranks across all queries using Reciprocal Rank Fusion (`K = 60`):
  $$\text{rrf}(p) = \sum_{q} w_q \cdot \frac{1}{60 + \text{rank}_q(p)}$$
- Applies gentle recency weighting:
  $$\text{decay}(p) = 0.85 + 0.15 \cdot \exp\left(-\frac{\max(0, \text{ageDays}_p)}{90}\right)$$
  $$\text{score}(p) = \text{rrf}(p) \cdot \text{decay}(p)$$
- Returns top `limit` entries sorted by `score DESC, updated_at DESC`, each with an excerpt snippet (~220 chars) centered around the first matched term.

---

## 4. Agent Tools (`gateway/src/wiki/tools.ts`) & Prompt Integration

### 4.1 Tool Definitions
1. **`wiki_search`** (read-only, included in `WATCH_TOOL_NAMES`):
   - Parameters: `queries: string[]` (1–6 short keyword/synonym/bilingual queries), `kind?: 'contact' | 'client' | 'project' | 'topic'`, `limit?: number` (default 8, max 20).
   - Output: concise JSON list of `{ id, kind, slug, title, summary, tags, sourceTainted, updatedBy, updatedAt, snippet }`.
   - Note: `wiki_search` returns short index metadata; reading full page content goes through `wiki_read`. If any returned snippet/summary comes from a `source_tainted` page, `wiki_search` ALSO marks `tainted: true` so prompt injection hidden in a title/summary/snippet cannot bypass `outside-data` taint!
2. **`wiki_read`** (read-only, included in `WATCH_TOOL_NAMES`):
   - Parameters: `id: string` (e.g. `"client/acme-corp"`).
   - Output: full Markdown body + metadata (`title`, `kind`, `tags`, `version`, `updatedBy`, `sourceTainted`, `updatedAt`), bounded at `16,000` chars.
   - Taint rule: returns `tainted: true` whenever `page.source_tainted === 1`.
3. **`wiki_upsert`** (write tool, **excluded from `WATCH_TOOL_NAMES`** and refused at runtime when `watch === true`):
   - Parameters: `kind` (required), `slug?` (optional — derived cleanly from `title` with ASCII/Unicode slugger + collision suffix if omitted), `title` (required, ≤ 160 chars), `summary?` (≤ 300 chars), `tags?` (up to 12 short tags), `body` (required, ≤ 64,000 chars), `note?` (≤ 200 chars revision summary).
   - Taint rule: `sourceTainted = turnTainted || origin === 'webhook'` (if updating an existing page whose `source_tainted === 1` from an untainted bot turn, `source_tainted` stays `1` unless cleared by the operator via the UI — preventing a bot from accidentally "washing" an external-sourced page!).
   - Records an entry in `actions` (`tool: 'wiki_upsert'`) and broadcasts `{ type: 'wiki_changed' }` on `hub`.

### 4.2 Static Prompt Note (`gateway/src/prompts.ts`)
Adds a fixed 3-line section (`## Shared team wiki`) instructing teammates to call `wiki_search` before asking the operator for background on contacts, clients, projects, or recurring topics, and to call `wiki_upsert` when they learn durable factual context useful to other teammates (never storing behavioral rules or passwords/secrets in the Wiki).

---

## 5. REST API (`gateway/src/wiki/api.ts`) & WebSocket

Mounted under `/api/wiki` (protected by existing gateway auth + CSRF middleware):
- `GET /api/wiki` — query params: `q` (optional search string, split on `|` or single query fed through RRF), `kind` (optional filter), `limit` (default 50, max 200). Returns `{ pages: WikiPageSummary[], total: number }`.
- `GET /api/wiki/:kind/:slug` — returns `{ page: WikiPageDetail, revisions: WikiRevision[] }` or `404`.
- `PUT /api/wiki/:kind/:slug` — body `{ title, summary?, tags?, body, note? }`. Creates or updates the page as `updated_by = 'operator'`, sets `source_tainted = 0` (operator-verified!), writes revision + disk mirror, broadcasts `wiki_changed`, returns `200`/`201` `{ page, revisions }`.
- `POST /api/wiki/:kind/:slug/revert` — body `{ version: number, note?: string }`. Restores `title`, `summary`, `tags`, `body` from the specified historical revision into a new incremented version (`edited_by = 'operator'`, `source_tainted = 0`), updates FTS5 & disk mirror, broadcasts `wiki_changed`, returns `200` `{ page, revisions }`.
- `DELETE /api/wiki/:kind/:slug` — soft-archives page (`archived_at = now`), removes row from `wiki_fts`, deletes disk mirror file, broadcasts `wiki_changed`, returns `200` `{ ok: true }`.

---

## 6. Frontend UI (`web/`)

- **Entry point (`Sidebar.tsx` + `Icons.tsx`):** Add `BookOpenIcon` button (`sidebar-foot-icon`) in `.sidebar-footer` opening `WikiDialog` (accessible label `Team wiki` / `团队知识库`).
- **Modal (`WikiDialog.tsx`):** Two-pane workbench dialog (matching `ConnectorsDialog` & `ModelsDialog` styling, Dark & Light theme tokens):
  - **Left pane:** Kind filter pills (`All`, `Contacts`, `Clients`, `Projects`, `Topics`), instant search box, `+ New page` button, and scrollable page list displaying title, kind pill, summary preview, updated timestamp, and amber `External source` badge when `sourceTainted === true`.
  - **Right pane:**
    - View mode: Title, kind badge, tags, `updated by` & `vN`, external-source warning banner (with one-click **Review & verify** → opens editor), rendered Markdown body, Delete button (uses in-app confirm dialog), and collapsible **History (N)** drawer with one-click **Revert** on prior revisions.
    - Create / Edit mode: Kind selector (on create), Title, optional Slug (auto-generated when blank on create), Summary, Tags (comma-separated), Markdown `<textarea>`, optional Change note, Save (shows `Save & verify` when clearing `sourceTainted`), and Cancel.
- **Live updates (`App.tsx`):** Subscribe to `{ type: 'wiki_changed' }` WS events so open `WikiDialog` refreshes automatically when a teammate runs `wiki_upsert`.

---

## 7. File Map

| File | Responsibility |
| :--- | :--- |
| `gateway/src/db.ts` | Migration `v14` (`wiki_pages`, `wiki_revisions`, `wiki_fts`). |
| `gateway/src/hub.ts` | Add `{ type: 'wiki_changed' }` event type. |
| `gateway/src/wiki/types.ts` *(new)* | Shared Wiki types, kind enum, validation constants. |
| `gateway/src/wiki/tokenize.ts` *(new)* | CJK bigram + English token normalizer & safe FTS5 query builder. |
| `gateway/src/wiki/mirror.ts` *(new)* | Atomic `<data>/wiki/<kind>/<slug>.md` frontmatter mirror & path safety. |
| `gateway/src/wiki/store.ts` *(new)* | Transactional SQLite CRUD, FTS5 sync, 20-version revision pruning, revert, archive. |
| `gateway/src/wiki/rrf.ts` *(new)* | Multi-query BM25 + RRF + time-decay scorer + snippet extractor. |
| `gateway/src/wiki/api.ts` *(new)* | `/api/wiki/*` Hono routes. |
| `gateway/src/wiki/tools.ts` *(new)* | `wiki_search`, `wiki_read`, `wiki_upsert` tool definitions & runner with taint enforcement. |
| `gateway/src/{tools,prompts,agent,server}.ts` | Wire Wiki tools (`WATCH_TOOL_NAMES`), static prompt note, `mountWiki`, and `onWikiTool`. |
| `web/src/{types,api}.ts`, `web/src/i18n/*` | Wiki types, REST helpers, `wiki_changed` event, full bilingual copy. |
| `web/src/components/{WikiDialog.tsx,Sidebar.tsx,Icons.tsx}`, `web/src/{App.tsx,index.css}` | Two-pane Wiki workbench dialog, sidebar trigger, live WS refresh, Dark/Light styling. |
| `docs/{security.md,comparison.md}` | Document shared Wiki custody & cross-agent taint boundaries. |
