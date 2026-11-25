# Phase 9 Design: Wiki Auto-Sync, Validated Section Patch & Dual-List Search

**Date:** 2026-11-25  
**Status:** Approved  
**Branch:** `feat/wiki-autosync`  
**Scope:** Upgrade the zero-vector-DB Team Wiki (`gateway/src/wiki/`) with (1) hybrid structured Markdown section patching (`wiki_patch` + deterministic code-written `## Change Log` + citation/entry retention checks), (2) dual-list RRF retrieval in `wiki_search` returning both curated `pages` and bot-isolated `originals` (`messages_fts`), and (3) idle `P3 low`-priority incremental chat-to-Wiki auto-sync (`wiki_sync_state` in SQLite `v26`) plus a manual **Sync from chats** button in `WikiDialog`.

---

## 1. Goals & Security Invariants

### Goals
1. **Zero-maintenance knowledge accumulation:** Durable facts about contacts, clients, projects, and topics discussed in threads flow into the shared Team Wiki automatically once a thread has been quiet for 30 minutes (or immediately when the operator clicks **Sync from chats** in `WikiDialog`), without interrupting active turns.
2. **Lossless section-by-section updates:** Prevent LLMs from silently dropping existing bullet items or source citations during updates by validating structured section patches in gateway code and writing `## Change Log` deterministically in code rather than trusting model prose.
3. **Full backward compatibility with free-form Markdown:** Operator-written Markdown tables, custom headings, and `<data>/wiki/<kind>/<slug>.md` disk mirrors continue to work unchanged.
4. **One-call dual-list recall (`pages` + `originals`):** A single `wiki_search` call returns both curated Wiki pages and ranked original message slices so teammates verify exact historical wording before claiming something was never recorded.

### Security & Custody Invariants
1. **Strict per-bot DM isolation on `originals`:** The `originals` list in `wiki_search` queries `messages_fts` strictly restricted to `accessibleThreadIds(db, botId)` (`dm:<botId>` plus group threads where `botId` is a member). One teammate can **never** read another teammate's private DM messages via `wiki_search`.
2. **Monotonic `outside-data` taint propagation:**
   - Any `wiki_patch` called in a `tainted` turn or `webhook` origin marks the page and revision `source_tainted = 1`.
   - Any auto-sync batch whose thread window contains `webhook` messages, tainted `bot_ref` relays, or external-data tool calls (`web_*`, `browser_*`, `mail_*`, `calendar_*`, `slack_*`, `notion_*`, `polery_*`, `mcp__*`) marks touched Wiki pages `source_tainted = 1` (`edited_by = 'auto-sync'`), surfacing the amber *External source · Review & verify* banner in `WikiDialog`.
   - `wiki_search` sets `tainted: true` whenever any returned `pages` entry has `sourceTainted === true` or any returned `originals` entry is an untrusted `webhook` / tainted relay message.
3. **Secret scrubbing before persistence:** Auto-sync and `wiki_patch` run deterministic secret redaction (`sk-`, `sk-ant-`, `xai-`, `AIza`, `gsk_`, `cmp_`, `ghp_`, `github_pat_`, `xoxb-`, `Bearer <token>`) so raw API keys pasted in chat are redacted before entering `wiki_pages`, `wiki_revisions`, `wiki_fts`, or `<data>/wiki/` mirrors.
4. **`watch` routine read-only enforcement:** `wiki_patch` joins `WIKI_WRITE_TOOL_NAMES` — allowed in normal turns and `prepare` routines, hidden and refused at runtime in `watch` routines.
5. **Local LLM queue discipline:** Background idle auto-sync runs exclusively at `low` (`P3`) priority on `llmQueue`, yielding immediately between calls to interactive (`P0`), background-task (`P1`), and routine (`P2`) traffic.

---

## 2. SQLite Schema Migration `v26` (`gateway/src/db.ts`)

Append migration step `v26` to `MIGRATIONS`:

```sql
CREATE TABLE IF NOT EXISTS wiki_sync_state (
  thread_id TEXT PRIMARY KEY,
  last_synced_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

- Tracks the highest `messages.id` already evaluated for Wiki extraction per thread.
- Updating `last_synced_message_id` happens only after an auto-sync pass for that thread completes without transport/LLM errors, ensuring clean post-restart resumption without duplicate token spend.

---

## 3. Hybrid Structured Section Patcher (`gateway/src/wiki/sections.ts`)

### 3.1 Document Model
A Wiki page's `body` remains valid GitHub-Flavored Markdown parsed by top-level `## <Heading>` boundaries:

1. **Preamble & Custom Sections (Preserved Verbatim):** Any text before the first `## ` heading and any non-managed `## <Custom Heading>` sections (such as custom Markdown tables) are retained in place untouched.
2. **`## Overview` (Managed Summary Section, max `3,000` chars):**
   - Patch input: `{ mode: 'keep' } | { mode: 'rewrite', content: string, reason: string, droppedCitations?: Array<{ msgId: number; reason: string }> }`.
   - Validation rules:
     - `mode: 'rewrite'` requires non-empty `content` (≤ `3,000` chars) and non-empty `reason` (≤ `200` chars); otherwise throws `WikiValidationError`.
     - Citation check: extracts all `#msg:<id>` citations present in the previous `## Overview`. Every prior `msgId` must either still appear as `#msg:<id>` in the new `content` OR appear in `droppedCitations` with a non-empty `reason`; otherwise throws `WikiValidationError` listing the missing `#msg:<id>` references.
3. **Managed Keyed List Sections (`## Key Facts`, `## Open Items`, `## Decisions`):**
   - Canonical section keys & ID prefixes:
     - `key_facts` → `## Key Facts` (ID prefix `f`, e.g. `- [f1] Pricing agreed at $48k for 200 seats ([#msg:142])`)
     - `open_items` → `## Open Items` (ID prefix `o`, e.g. `- [o1] Send revised Monterey deposit hold ([#msg:155])`)
     - `decisions` → `## Decisions` (ID prefix `d`, e.g. `- [d1] Adopted Streamable HTTP MCP transport ([#msg:160])`)
   - Existing plain bullets (`- text` without `[<id>]`) inside these three headings are deterministically assigned sequential IDs (`[f1]`, `[f2]`, …) during parsing so legacy bullets are equally protected.
   - Patch operations per list section:
     - `add?: Array<{ text: string }>` — allocates the next unused `<prefix><n>` ID (max `500` chars per item, single-line normalized).
     - `update?: Array<{ id: string; text: string }>` — replaces the entry with matching `id` (throws `WikiValidationError` if `id` does not exist in that section; max `500` chars).
     - `remove?: Array<{ id: string; reason: string }>` — removes the entry with matching `id` only when `reason` is non-empty (throws `WikiValidationError` if `id` does not exist or `reason` is blank).
   - **Untouched entries invariant:** Every existing entry whose `id` is not listed in `update` or `remove` is preserved byte-for-byte in its original order.
   - **Capacity cap (`MAX_LIST_ITEMS = 20`):** If additions push a list past 20 entries, the oldest entries beyond 19 are merged into a single dated archive bullet (`- [<prefix>0] Earlier items (archived YYYY-MM-DD): …` truncated to `500` chars) so total bullets stay ≤ 20.
4. **App-Written `## Change Log` (Max `20` lines):**
   - Any `## Change Log` section supplied by an LLM in `wiki_patch` or `wiki_upsert` (when called by non-operator actors) is stripped/normalized as appropriate: in `applyWikiSectionPatch`, gateway code owns `## Change Log` exclusively.
   - Each successful patch prepends `- YYYY-MM-DD HH:mmZ · <actor> · <changeSummary>` to `## Change Log` and retains the newest `20` bullet lines.

### 3.2 `wiki_patch` Agent Tool (`gateway/src/wiki/tools.ts` & `store.ts`)
- New store helper `patchWikiPage(db, input, opts)` wraps `getWikiPage` + `applyWikiSectionPatch` + `upsertWikiPage` inside a single SQLite transaction so concurrent patches cannot clobber each other, writes a `wiki_revisions` snapshot with the generated change summary as `note`, syncs `wiki_fts`, and updates `<data>/wiki/<kind>/<slug>.md`.
- Exposed as tool `wiki_patch`:
  - Parameters: `kind`, `slug` (optional if `title` uniquely identifies or creates a new page), `title` (required when creating a new page, optional when patching an existing `kind/slug`), `summary?`, `tags?`, `overview?`, `keyFacts?`, `openItems?`, `decisions?`, `note?`.
  - Allowed in normal turns and `prepare` routines (`PREPARE_EXTRA_TOOL_NAMES` in `gateway/src/tools.ts` and `agent.ts` guard message updated to include `wiki_patch`); blocked in `watch` routines.

---

## 4. Dual-List `wiki_search` (`gateway/src/wiki/rrf.ts` & `gateway/src/history-search.ts`)

### 4.1 Multi-Query History RRF (`searchAccessibleHistoryRrf`)
Add `searchAccessibleHistoryRrf(db, opts)` in `gateway/src/history-search.ts`:
- Inputs: `{ botId: string; queries: readonly string[]; limit?: number }` (`limit` default `6`, max `12`).
- Computes `threadIds = accessibleThreadIds(db, opts.botId)` (`dm:<botId>` + group memberships of `botId`).
- For each of the 1–6 deduplicated queries:
  - Runs the existing trigram FTS5 query (when all terms have length ≥ 3) or parameterized `INSTR(LOWER(f.searchable_text), LOWER(?)) > 0` fallback (for 1–2 char CJK terms like `"报价"`, `"张伟"`) against `messages_fts` filtered by `f.thread_id IN (...)`.
  - Fuses per-query rankings with Reciprocal Rank Fusion ($k = 60$), breaking ties by `m.created_at DESC, m.id DESC`.
- Formats snippets with existing safety rules:
  - `webhook` messages wrapped in SHA-256 `<<<webhook` fences (`hasUntrustedHit = true`).
  - `bot_ref` messages with `payload.tainted === true` marked `hasUntrustedHit = true`.
  - `approval_request` messages redacted via `safeApprovalSummary` (never exposing `target` / standing `rule`).

### 4.2 Upgraded `wiki_search` Output Contract
- `wiki_search` adds optional boolean parameter `includeHistory` (default `true`).
- Returns JSON bounded within `MAX_WIKI_READ_OUTPUT_CHARS` (`16,000` chars):
  ```json
  {
    "total": 2,
    "pages": [ ... ],
    "originalsTotal": 3,
    "originals": [
      {
        "id": 142,
        "threadId": "dm:researcher",
        "sender": "user",
        "kind": "text",
        "createdAt": 1764050000000,
        "snippet": "…"
      }
    ]
  }
  ```
- Sets `tainted: true` if `hasTaintedPage || originalsResult.hasUntrustedHit`.
- Updates `gateway/src/prompts.ts` Wiki guidance: teammates check both `pages` (curated entity summaries) and `originals` (exact conversation records) before concluding a fact was never mentioned, and prefer `wiki_patch` for incremental updates to existing entity pages.

---

## 5. Idle Incremental Auto-Sync & Manual Sync (`gateway/src/wiki/auto-sync.ts`)

### 5.1 Selection & Extraction Pipeline (`syncWikiFromChats`)
1. **Candidate thread discovery:**
   - Queries threads that have `messages` (`kind IN ('text', 'report')`) with `id > COALESCE(wiki_sync_state.last_synced_message_id, 0)`.
   - In automatic mode (`force = false`): filters out threads currently busy (`isThreadBusy(threadId)`) and threads whose latest message in `messages` has `now - latest_created_at < 30 * 60_000` (`WIKI_IDLE_QUIET_MS = 30m`).
   - In manual mode (`force = true`, triggered by `POST /api/wiki/sync`): processes all non-busy threads with unsynced messages immediately regardless of the 30-minute quiet timer.
2. **Bounded window & existing entity context:**
   - Reads up to `MAX_SYNC_MESSAGES_PER_THREAD = 25` unsynced `'text' | 'report'` messages in chronological order (`[afterId .. batchMaxId]`), requiring at least 1 substantive message (≥ 12 chars) to invoke the LLM (trivial `"ok"` / `"thanks"` batches advance `last_synced_message_id` directly with zero LLM call).
   - Loads up to 40 existing Wiki page headers (`id`, `kind`, `title`, `summary`, `tags`) plus full bodies of up to 5 existing pages matched via `searchWikiRrf` against terms from the thread transcript so the model patches existing entities by exact `kind/slug` instead of creating duplicates.
3. **Single-shot `P3 low` LLM call:**
   - Invokes `llm.chat` with `priority: 'low'` (`P3`), zero tools, strict system prompt instructing the model to extract only durable cross-conversation facts (`contact`, `client`, `project`, `topic`), cite source message IDs (`[#msg:<id>]`), never extract transient chat chatter, behavioral rules, or credentials, and return JSON `{ operations: Array<WikiAutoSyncOp> }`.
4. **Validation, Taint & Cursor Commit:**
   - Computes `batchTainted`: `true` if any message in `(afterId .. batchMaxId]` in that thread is `webhook`, tainted `bot_ref`, or if `actions` in that thread's window invoked an external read tool.
   - Applies each operation through `patchWikiPage` (`editedBy: 'auto-sync'`, `sourceTainted: batchTainted`), catching per-operation `WikiValidationError`s so one malformed patch item logs a warning without aborting valid items in the same batch.
   - Scrubs secrets on all strings (`title`, `summary`, `overview`, list item texts) prior to `patchWikiPage`.
   - Upserts `wiki_sync_state(thread_id, batchMaxId, now)` only when the LLM call itself succeeded; broadcasts `{ type: 'wiki_changed' }` once if any page was created or updated.
   - Serialized by an in-process mutex (`runningSyncPromise`) so overlapping timer ticks and manual clicks never duplicate work.

### 5.2 Gateway Wiring, REST Endpoint & `WikiDialog` UI
- **Gateway (`server.ts` & `main.ts`):**
  - `createApp` exposes `syncWikiFromChats(opts?: { force?: boolean }): Promise<WikiSyncResult>`.
  - `main.ts` runs a `5`-minute `setInterval(...).unref()` calling `gateway.syncWikiFromChats({ force: false })`.
- **REST API (`gateway/src/wiki/api.ts`):**
  - `POST /api/wiki/sync` → runs `syncWikiFromChats({ force: true })` and returns `200` `{ ok: true, threadsSynced: number, pagesCreated: number, pagesUpdated: number }`.
- **Web Client (`web/src/api.ts`, `WikiDialog.tsx`, `en.ts`, `zh-CN.ts`):**
  - Adds `syncWikiFromChats()` API helper.
  - Adds a compact **`Sync from chats` / `从对话同步`** button (with `RotateCwIcon`) in `WikiDialog`'s sidebar toolbar beside `+ New page`, displaying a non-intrusive status banner (`Synced 2 pages from 3 threads` / `No new chat facts to sync`) and refreshing the list + open page detail when pages change.

---

## 6. Testing Strategy

1. **Unit tests (`gateway/test/wiki-sections.test.ts`):**
   - Preserves preamble and custom Markdown headings/tables verbatim across multiple patches.
   - Enforces `reason` on `overview` rewrite; rejects `overview` rewrites that drop `[#msg:123]` citations without `droppedCitations`, and accepts them when `droppedCitations` documents why.
   - Assigns deterministic IDs to legacy plain bullets; preserves unmentioned `[f1]`/`[o1]`/`[d1]` entries byte-for-byte during `add`/`update`/`remove`; archives oldest entries past 20; prepends and caps app-written `## Change Log` at 20 entries; strips model-forged `## Change Log` sections; scrubs raw API keys/tokens.
2. **Dual-list search & isolation tests (`gateway/test/wiki-dual-search.test.ts`):**
   - `wiki_search` returns both `pages` and `originals` in a single call, handles short 2-char CJK queries (`"报价"`, `"张伟"`), respects `includeHistory: false`, strictly isolates `originals` per teammate (`botA` never sees `dm:botB`), fences `webhook` hits, and propagates `tainted: true`.
3. **Auto-sync & API integration tests (`gateway/test/wiki-autosync.test.ts`):**
   - Skips active or `< 30m` recent threads when `force = false`; syncs immediately on `POST /api/wiki/sync` (`force = true`); advances `wiki_sync_state` cursor idempotently without re-calling LLM on a second run; skips LLM on trivial `"ok"` turns; marks pages `sourceTainted = true` when thread window contains `webhook` or external tool actions; dispatches LLM calls with `priority: 'low'`.
4. **Frontend tests (`web/src/components/WikiDialog.test.tsx` & `i18n.test.tsx`):**
   - Verifies the **Sync from chats** button triggers `POST /api/wiki/sync`, shows loading/result state, refreshes the list, and maintains 100% EN / `zh-CN` i18n key parity.
