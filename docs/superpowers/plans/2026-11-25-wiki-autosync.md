# Phase 9 Implementation Plan: Wiki Auto-Sync, Validated Section Patch & Dual-List Search

**Date:** 2026-11-25  
**Spec:** `docs/superpowers/specs/2026-11-25-wiki-autosync-design.md`  
**Branch:** `feat/wiki-autosync`

---

## Task 1: Schema `v26`, Secret Scrubber & Hybrid Section Patcher (`gateway`)

**Files:**
- Modify `gateway/src/db.ts` — append migration `v26` creating `wiki_sync_state (thread_id TEXT PRIMARY KEY, last_synced_message_id INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`.
- Create `gateway/src/wiki/sections.ts`:
  - `scrubWikiSecrets(text: string): string` — redacts raw API keys and bearer tokens (`sk-`, `sk-ant-`, `xai-`, `AIza`, `gsk_`, `cmp_`, `ghp_`, `github_pat_`, `xoxb-`, `Bearer …`).
  - `parseWikiSections(body: string)` & `applyWikiSectionPatch(existingBody: string, patch: WikiSectionPatch, meta: { actor: string; at: number; fallbackNote?: string })`:
    - Preserves preamble and custom `## <Heading>` sections verbatim.
    - Validates `## Overview` (`keep` vs `rewrite` with required `reason` ≤ 200 chars, content ≤ 3,000 chars, and `[#msg:<id>]` citation retention unless listed in `droppedCitations` with non-empty `reason`).
    - Manages `## Key Facts` (`f`), `## Open Items` (`o`), and `## Decisions` (`d`): assigns deterministic sequential IDs to legacy plain bullets, supports `add` / `update(id)` / `remove(id, reason)`, preserves unmentioned items byte-for-byte, and archives oldest overflow beyond 20 items into `[<prefix>0]`.
    - Strips any model-supplied `## Change Log` and prepends `- YYYY-MM-DD HH:mmZ · <actor> · <summary>` (retaining newest 20 lines).
- Modify `gateway/src/wiki/types.ts` & `gateway/src/wiki/store.ts`:
  - Add `WikiSectionPatch`, `WikiPatchInput`, and transactional `patchWikiPage(db, input, opts)` (updating `wiki_pages`, `wiki_revisions`, `wiki_fts`, and `<data>/wiki/` mirror).
- Create `gateway/test/wiki-sections.test.ts` — unit & store tests covering all validation, preservation, overflow archiving, changelog capping, taint monotonicity, and secret scrubbing rules.

---

## Task 2: Dual-List `wiki_search` (`pages` + `originals`) & `wiki_patch` Agent Tool (`gateway`)

**Files:**
- Modify `gateway/src/history-search.ts`:
  - Add `searchAccessibleHistoryRrf(db, { botId, queries, limit })`: multi-query RRF ($k = 60$) over `messages_fts` (trigram FTS5 + 1–2 char CJK substring fallback) strictly bounded to `accessibleThreadIds(db, botId)`, preserving `<<<webhook` SHA-256 fences, `safeApprovalSummary`, and `hasUntrustedHit`.
- Modify `gateway/src/wiki/tools.ts`:
  - Upgrade `wiki_search` with optional `includeHistory?: boolean` (default `true`), returning `{ total, pages, originalsTotal, originals }` within `MAX_WIKI_READ_OUTPUT_CHARS` and propagating `tainted: true` from either list.
  - Add `wiki_patch` tool to `WIKI_TOOLS` and `WIKI_WRITE_TOOL_NAMES` (blocked in `watch`, allowed in `prepare` and normal turns).
- Modify `gateway/src/tools.ts`, `gateway/src/agent.ts`, `gateway/src/prompts.ts`:
  - Include `wiki_patch` in `PREPARE_EXTRA_TOOL_NAMES`, `agent.ts` tool dispatch & `prepare` guard notice, and update system prompt guidance in `prompts.ts` (dual-list verification before claiming "never recorded", prefer `wiki_patch` for incremental entity updates).
- Create `gateway/test/wiki-dual-search.test.ts` — tests for dual-list output, CJK short-term queries, `includeHistory: false`, strict cross-bot DM isolation, webhook fencing/taint, and `wiki_patch` in normal/`prepare`/`watch` modes.

---

## Task 3: Idle `P3` Chat-to-Wiki Auto-Sync & `POST /api/wiki/sync` (`gateway`)

**Files:**
- Create `gateway/src/wiki/auto-sync.ts`:
  - `syncWikiFromChats(deps, opts?: { force?: boolean })`:
    - Discovers threads with unsynced `'text' | 'report'` messages (`id > last_synced_message_id`), skipping busy threads and (when `!force`) threads active within the last 30 minutes (`WIKI_IDLE_QUIET_MS`).
    - Fast-forwards trivial batches (no message ≥ 12 chars) with zero LLM call.
    - Calls `llm.chat` at `priority: 'low'` (`P3`) with existing Wiki index + matched page bodies, parses JSON `operations`, detects thread-window taint (`webhook`, tainted `bot_ref`, external read tool `actions`), scrubs secrets, applies `patchWikiPage` (`editedBy: 'auto-sync'`), advances `wiki_sync_state` on LLM success, and broadcasts `{ type: 'wiki_changed' }`.
    - Coalesces concurrent invocations with an in-memory mutex.
- Modify `gateway/src/wiki/api.ts`, `gateway/src/server.ts`, `gateway/src/main.ts`:
  - Wire `syncWikiFromChats` on `createApp`, expose `POST /api/wiki/sync` (`force: true`), and schedule a 5-minute `setInterval(...).unref()` in `main.ts`.
- Create `gateway/test/wiki-autosync.test.ts` — integration tests covering 30m idle threshold, `POST /api/wiki/sync` force sync, cursor idempotency, trivial-turn skip, `priority: 'low'` assertion, taint propagation from webhooks/external actions, and malformed-op resilience.

---

## Task 4: `WikiDialog` Sync Button, Bilingual i18n & Docs (`web` + `docs`)

**Files:**
- Modify `web/src/types.ts` & `web/src/api.ts` — add `WikiSyncResponse` and `syncWikiFromChats()`.
- Modify `web/src/i18n/en.ts` & `web/src/i18n/zh-CN.ts` — add `wiki.sync`, `wiki.syncing`, `wiki.syncDone`, `wiki.syncEmpty`, `wiki.error.syncFailed`.
- Modify `web/src/components/WikiDialog.tsx` (& `web/src/index.css` if styling needed) — add compact **Sync from chats** button next to `+ New page`, loading state, result notice, and list/detail refresh.
- Modify `web/src/components/WikiDialog.test.tsx` & `docs/security.md` — add UI sync tests and document `wiki_patch` / auto-sync taint & DM-isolation invariants.
