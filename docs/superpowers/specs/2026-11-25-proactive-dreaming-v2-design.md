# Phase 10 Design: Conversational Dreaming (`Clue → RuleProposal`) & Proactive Delivery Pacing

**Date:** 2026-11-25  
**Status:** Draft (Pending Spec Review)  
**Branch:** `feat/proactive-dreaming-v2` (based on `feat/wiki-autosync`)  
**Scope:** Extend proactive teamwork (`gateway/src/proactive/`) with (1) two-tier conversational feedback learning (`proactive_clues` + `proactive_dream_state` in SQLite `v27`, promoting repeated implicit clues or explicit preferences into operator-approved `RuleProposalChip`s with `source: 'dreaming'`), and (2) three-dimensional proactive delivery pacing (60-second multi-event webhook coalescing, 3-minute active-chat deferral via persistent `proactive_deferred`, and a 5/day per-teammate non-urgent reminder cap routing overflow to `Feed` / `quiet_digest_items`).

---

## 1. Goals & Security Invariants

### Goals
1. **Learn how and when to interrupt from natural replies — without silent `MEMORY.md` mutation:** When a teammate reaches out proactively (`routine`, `watch`, `prepare`, `webhook`, or `quiet_digest`) and the operator pushes back in chat ("too late for this", "don't push shipping updates", "tell me client replies right away"), a low-priority Dreaming pass records an internal **Clue** (`seen = 1`). Once a second clue of the same area + leaning arrives (`seen >= 2`), or when the operator states an explicit standing rule ("from now on…"), Dreaming posts an editable **`RuleProposalChip`** (`source: 'dreaming'`) so the operator stays in 100% control of `MEMORY.md`.
2. **Respect active focus & attention budgets:**
   - **60s Webhook Coalescing:** Burst webhooks hitting `/hooks/routines/:id` within a 60-second window (or while the previous run of that routine is still in flight) coalesce up to 10 payloads into one turn instead of firing redundant runs or dropping bursts with `409`.
   - **3-Minute Quiet-Chat Floor:** Non-urgent scheduled outputs wait in `proactive_deferred` if the thread has an active turn or received an operator message within the last 3 minutes, delivering automatically once the chat has been quiet for 3 minutes (surviving restarts).
   - **Daily Non-Urgent Cap (`5` / teammate / local day):** Beyond 5 non-urgent thread deliveries in one local calendar day, additional non-urgent scheduled outputs route to Today `Feed` (when `surface` includes `feed`) and/or `quiet_digest_items` instead of pinging the thread again.
3. **Zero blockage of urgent or interactive paths:** `urgent: true` on `message_user`, `approval_request`, `question`, `login_request`, and manual `force: true` routine runs **always** bypass deferral and daily caps.

### Security & Custody Invariants
1. **Never mutates `MEMORY.md` directly:** Conversational Dreaming outputs exclusively call `createRuleProposal(..., { source: 'dreaming' })`. Only an authenticated operator click on **Save to MEMORY.md** (`POST /api/rule-proposals/:id/resolve`) writes to `<data>/bots/<botId>/MEMORY.md`.
2. **Monotonic `outside-data` taint propagation:**
   - Every `proactive_clues` row records `source_tainted` (`1` if any message in the evaluated proactive exchange or prior clue was tainted: `webhook`, `quiet_digest`, tainted `bot_ref`, `wiki_sync_state.pending_taint`, or external read tool `actions`).
   - When clues promote to a `RuleProposalChip`, `sourceTainted = true` is preserved monotonically so the amber external-data warning badge renders on the card.
   - Prompt-injection guard: conversation/event text is framed strictly as untrusted evidence (`<<<exchange ... >>>`), never instructions; secret scrubbing (`scrubWikiSecrets`) runs on all extracted `area`, `evidence`, `rule`, and `reason` strings.
3. **Time-window safety:** Feedback about the hour ("too late at night") produces a window-scoped deferral rule (`After 21:00, hold non-urgent <area> updates for follow-up / morning digest instead of pinging immediately`), **never** unconditional 24-hour silence.
4. **Local LLM queue discipline:** Dreaming evaluations run exclusively at `priority: 'low'` (`P3`) on `llmQueue` with `AbortSignal` support on `gateway.stopAll()`.

---

## 2. SQLite Schema Migration `v27` (`gateway/src/db.ts`)

Append migration step `v27` to `MIGRATIONS`:

```sql
CREATE TABLE IF NOT EXISTS proactive_clues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  area_key TEXT NOT NULL,
  area_label TEXT NOT NULL,
  time_window TEXT NOT NULL DEFAULT '',
  leaning TEXT NOT NULL,            -- 'tell_now' | 'follow_up_later' | 'stay_silent'
  evidence TEXT NOT NULL DEFAULT '',
  seen_count INTEGER NOT NULL DEFAULT 1,
  source_tainted INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE(bot_id, area_key, time_window, leaning)
);
CREATE INDEX IF NOT EXISTS idx_proactive_clues_bot
  ON proactive_clues(bot_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS proactive_dream_state (
  proactive_message_id INTEGER PRIMARY KEY,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  evaluated_through_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proactive_dream_bot
  ON proactive_dream_state(bot_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS proactive_deferred (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  routine_id INTEGER,
  routine_name TEXT NOT NULL DEFAULT '',
  routine_mode TEXT NOT NULL DEFAULT 'watch',
  kind TEXT NOT NULL DEFAULT 'text',  -- 'report' | 'text'
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  source_tainted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deliver_after INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proactive_deferred_pending
  ON proactive_deferred(delivered_at, deliver_after, id);
```

---

## 3. Conversational Dreaming Engine (`gateway/src/proactive/dreaming.ts`)

### 3.1 Identifying Proactive Exchanges
A message `M` in `dm:<botId>` is an eligible proactive anchor when:
- `M.sender = botId` and `M.kind IN ('text', 'report', 'quiet_digest')`, AND
- `M` was emitted by a proactive run (either `M.kind === 'quiet_digest'`, or an `actions` row exists for `(botId, threadId)` with `trigger IN ('routine', 'watch', 'prepare', 'webhook')` within `[M.created_at - 25m, M.created_at + 5s]`, or `M` immediately follows a `kind = 'webhook'` message in that thread).
- After `M.id` (and before the next proactive anchor in that thread, capped at the next `20` messages), at least **1** operator message (`sender = 'user'`, `kind = 'text'`) exists with `id > COALESCE(proactive_dream_state.evaluated_through_id, M.id)`.
- In automatic mode (`force = false`), the thread must not be busy and the latest message in the thread must be at least `DREAM_QUIET_MS = 15 * 60_000` old so the operator's reply sequence has settled.

### 3.2 Strict Signal Classification & Promotion
1. **Single-shot `P3 low` LLM call:** Receives the proactive message `M`, the subsequent ≤ 20 messages (fenced as untrusted transcript data), the bot's existing `MEMORY.md` rules, and the bot's current `proactive_clues` (max `30`).
2. **Strict Negative Filters (enforced by prompt & post-validator):**
   - Ignores content opinions ("interesting article", "too pricey"), one-off status ("done", "already handled"), simple agreement ("thanks", "got it"), or unrelated follow-up questions.
   - Accepts only meta-feedback on *whether, when, or how* to surface proactive updates:
     - `kind`: normalized `area_key` (lowercase slug, e.g. `vendor-invoices`, `package-deliveries`, `standup-changes`) + human `area_label` (in the operator's language).
     - `leaning`: `'tell_now' | 'follow_up_later' | 'stay_silent'`.
     - `timeWindow`: optional normalized window (e.g. `'after 21:00'`). **Code invariant:** whenever `timeWindow` is non-empty and `leaning === 'stay_silent'`, code coerces `leaning` to `'follow_up_later'` so late-night pushback never silences a topic all day!
     - `explicitRule`: `boolean` — `true` only when the operator explicitly stated a standing preference ("from now on", "always", "never push this kind", "以后这类都…").
3. **Clue Pool & Promotion (`MAX_CLUES_PER_BOT = 30`):**
   - If `explicitRule === true`: proposes a `RuleProposalChip` immediately (`createRuleProposal(db, { source: 'dreaming', dedupeKey: 'dream:<area_key>:<time_window>:<leaning>', ... })`) without waiting for a second occurrence.
   - If `explicitRule === false`: upserts `(bot_id, area_key, time_window, leaning)` in `proactive_clues` (`seen_count = seen_count + 1`, monotonic `source_tainted`, `last_seen_at = now`), pruning oldest rows if count > 30. When `seen_count >= 2`, calls `createRuleProposal` (`source: 'dreaming'`) and deletes the consumed clue row once proposed (if `previously_dismissed` or `already_in_memory`, also retires the clue so it never re-fires).
   - Contradictory feedback on the same `(bot_id, area_key, time_window)` with a *different* `leaning` replaces the older opposite clue cleanly.
4. **Cursor Persistence:** Upserts `proactive_dream_state(M.id, botId, threadId, windowMaxId, now)` only after the LLM call succeeds.

### 3.3 `RuleProposalChip` & API Updates (`gateway` + `web`)
- Extend `RuleProposalSource` to `'agent' | 'discard_pattern' | 'dreaming'` in `gateway/src/proactive/rule-proposals.ts` and `web/src/types.ts`.
- In `web/src/components/RuleProposalChip.tsx`, map `source === 'dreaming'` to `t('ruleProposal.sourceDreaming')`:
  - EN: `'Suggested from your feedback'`
  - `zh-CN`: `'根据你的对话反馈提议'`
- Expose `POST /api/proactive/dream` (authenticated, `force: true` manual/test trigger returning `{ ok: true, evaluated: number, cluesUpdated: number, proposalsCreated: number }`) and `gateway.runProactiveDreaming(opts?: { force?: boolean })` on `createApp`, scheduled every 10 minutes (`.unref()`, cleared & aborted cleanly on `stopAll()`).

---

## 4. Three-Dimensional Proactive Delivery Pacing (`gateway/src/proactive/pacing.ts` & `server.ts`)

Enabled in production (`main.ts`) via `proactivePacing: true` on `ServerDeps` (or granular `{ quietChatMs?: number; webhookCoalesceMs?: number; dailyNonUrgentCap?: number }`, defaulting to off when omitted in legacy unit tests so synchronous test harnesses stay 100% deterministic):

### 4.1 60-Second Multi-Event Webhook Coalescer (`webhookCoalesceMs = 60_000`)
- When `POST /hooks/routines/:id` validates signature/key, size, `ping`, replay marks, and `routine.enabled`:
  - If `webhookCoalesceMs > 0`: instead of firing `runRoutine` immediately (or returning `409` while a prior run is in flight), appends the formatted webhook payload to an in-memory per-routine coalescing bucket (capped at `MAX_COALESCED_WEBHOOKS = 10` events and `256 KB` combined text) and returns `202 { ok: true, coalesced: true }`.
  - Starts a `webhookCoalesceMs` timer from the **first** event in the bucket. When the timer fires (or immediately after an in-flight run of that routine finishes if the timer already elapsed), merges the buffered events (`Event 1/N … Event N/N`) into a single `runRoutine` invocation!
  - On `gateway.stopAll()`, clears pending coalescing timers cleanly without firing against a closing DB.

### 4.2 3-Minute Active-Chat Deferral (`quietChatMs = 3 * 60_000`)
- Helper `lastOperatorActivityAt(db, threadId)`: returns `MAX(created_at)` of `messages` in `threadId` where `sender = 'user'`.
- During a non-forced scheduled routine (`!opts.force && payload === undefined`, when not already in `quietHours` buffering):
  - When the turn produces a non-urgent `'text'` or `'report'` output (via the same `onProactiveOutput` / buffer hook in `agent.ts`, where `args.urgent !== true` and no pending approval/question was created in that turn):
  - Checks if `isThreadBusyForInteractive(threadId)` OR `now - lastOperatorActivityAt(db, threadId) < quietChatMs`:
    - If active within 3 minutes: inserts into `proactive_deferred` with `deliver_after = Math.max(now, lastUserAt + quietChatMs)` instead of posting to the thread immediately!
- Periodic flusher `flushDeferredProactiveIfDue()` (runs every 30s in `main.ts` and exposed on `createApp` + `POST /api/proactive/flush-deferred`):
  - For each undelivered `proactive_deferred` row where `now >= deliver_after`, thread is not currently busy, and `now - lastOperatorActivityAt(db, threadId) >= quietChatMs`:
    - Posts the deferred `'text'` or `'report'` message to `threadId` (marking `markWikiSyncThreadTainted` if `source_tainted = 1`), sets `delivered_at = now`, and broadcasts `{ type: 'message', ... }`!
    - If Quiet Hours started while the item was deferred, transfers it cleanly into `quiet_digest_items` instead of pinging during Quiet Hours!

### 4.3 Daily Non-Urgent Proactive Cap (`dailyNonUrgentCap = 5`)
- Before delivering a non-forced, non-urgent scheduled routine `'text'` or `'report'` message into `dm:<botId>` (either live or when flushing `proactive_deferred`):
  - Counts today's already-delivered non-urgent proactive messages for `botId` since `startOfLocalDay(now, timeZone)` (via `actions` / `messages` from `routine` / `watch` / `prepare` triggers, excluding manual `force` runs and `urgent: true`).
  - If `deliveredToday >= dailyNonUrgentCap`:
    - Suppresses the thread ping: writes a briefing card into Today `Feed` (if not already written by `feedSurface`) AND enqueues into `quiet_digest_items` for the next digest summary!
  - `urgent: true` on `message_user`, approvals, questions, login requests, and manual `force: true` runs **never** count against or get blocked by `dailyNonUrgentCap`.

---

## 5. Testing Strategy

1. **Unit & Store Tests (`gateway/test/proactive-dreaming.test.ts`):**
   - Schema `v27` migration creates `proactive_clues`, `proactive_dream_state`, and `proactive_deferred`.
   - Implicit feedback (`seen = 1`) stores a clue without posting a chip; second matching feedback (`seen = 2`) promotes to `RuleProposalChip` (`source: 'dreaming'`) and retires the clue.
   - Explicit standing feedback (`"From now on, tell me client replies right away"`) bypasses the 2-clue wait and proposes immediately.
   - Content opinions (`"Great article"`), task completion (`"Done"`), and silence produce zero clues and zero proposals.
   - Late-night pushback (`"Too late at night for standup changes"`) coerces `stay_silent` + `timeWindow` to `follow_up_later` window rule (never 24h silence).
   - Contradictory leaning replaces prior clue; taint on exchange or prior clue propagates `sourceTainted: true` to `RuleProposalChip`; LLM runs at `priority: 'low'` (`P3`).
2. **Pacing Integration Tests (`gateway/test/proactive-pacing.test.ts`):**
   - 60-second webhook coalescing merges 3 rapid `/hooks/routines/:id` events into 1 `runRoutine` call with combined payload, and queues events arriving while a run is in flight without `409`.
   - 3-minute active-chat floor defers non-urgent routine output into `proactive_deferred` when the operator messaged 1 minute ago, and delivers once 3 quiet minutes have passed (surviving simulated app recreation on the same SQLite DB).
   - Daily cap (`dailyNonUrgentCap: 5`) delivers the first 5 non-urgent routine reports to the thread and routes the 6th to `quiet_digest_items` / `Feed`, while `urgent: true` on the 7th still breaks through immediately!
3. **Web Tests (`web/src/components/RuleProposalChip` / `Thread.test.tsx` & `i18n.test.tsx`):**
   - Verifies `source: 'dreaming'` renders `'Suggested from your feedback'` / `'根据你的对话反馈提议'` in `RuleProposalChip` with full EN / `zh-CN` i18n parity.
