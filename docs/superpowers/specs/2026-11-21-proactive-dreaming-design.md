# Phase 5 Design Spec: Proactive Routines, Quiet Hours & Controlled Dreaming

Date: 2026-11-21  
Branch: `feat/proactive-dreaming`  
Base: `main` (`7babb92`)

## 1. Goal

Upgrade OpenSuperBot's proactive teammate loop from basic `act` / `watch` routines into a calm, low-interruption, operator-controlled workflow with three cohesive capabilities:

1. **Quiet Hours & Morning Digest:** Opt-in daily quiet window (`quietHoursEnabled: false`, `22:00`–`08:00` default, evaluated in the gateway timezone) that buffers non-urgent scheduled `watch` and `prepare` outputs in SQLite and flushes them as a single Morning Digest card per teammate when Quiet Hours end (or immediately when the user clicks **Deliver now** or turns Quiet Hours off). Urgent alerts (`urgent: true`), approvals, operator questions, login requests, operator-initiated turns, and manual routine runs (`force: true`) always break through immediately.
2. **`prepare` Routine Mode (`RoutineMode = 'act' | 'watch' | 'prepare'`):** A pre-work briefing tier between `watch` (strictly read-only) and `act` (full computer & external tools). A `prepare` routine has all `watch` read-only tools plus `wiki_upsert` and workspace `write_file` so teammates can assemble dossiers, briefs, and local drafts overnight, while still forbidding `shell`, interactive browser mutations (`browser_click`, `browser_type`, `browser_press`), teammate relays (`message_bot`), external connector writes, and MCP writes. Silent on `"Nothing to prepare."` (or `"Nothing new."`).
3. **Controlled Dreaming (`RuleProposalChip`):** Teammates never mutate `MEMORY.md` autonomously. Instead, two triggers produce an editable `rule_proposal` card (`Save to MEMORY.md` / `Dismiss`) stored in SQLite (`rule_proposals`):
   - **Deterministic repeated-discard detector:** ≥ 2 operator `discard` decisions within 14 days for the same `(bot_id, kind, target)` (or `(bot_id, kind, action)` when target is empty) automatically proposes a standing rule — suppressed permanently if already in `MEMORY.md`, already pending, or previously dismissed.
   - **Explicit `propose_memory_rule` tool:** Teammates can propose at most 1 standing rule per turn (including during `routine`, `watch`, and `prepare` runs). If the turn is tainted by outside data (`turnTainted` or `origin === 'webhook'`), the proposal carries `sourceTainted: true` and displays an amber **External source — review carefully** badge in the UI.

---

## 2. Database Schema (Migration `v15`)

Appended as `MIGRATIONS[14]` in `gateway/src/db.ts` (`SCHEMA_VERSION` becomes `15`):

```sql
CREATE TABLE IF NOT EXISTS quiet_digest_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  routine_id INTEGER,
  routine_name TEXT NOT NULL DEFAULT '',
  routine_mode TEXT NOT NULL DEFAULT 'watch',
  kind TEXT NOT NULL DEFAULT 'text',
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_quiet_digest_pending
  ON quiet_digest_items(delivered_at, bot_id, id);

CREATE TABLE IF NOT EXISTS rule_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'agent',
  dedupe_key TEXT NOT NULL DEFAULT '',
  source_tainted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  message_id INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rule_proposals_bot_status
  ON rule_proposals(bot_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_rule_proposals_dedupe
  ON rule_proposals(bot_id, dedupe_key, status);

CREATE INDEX IF NOT EXISTS idx_approvals_discard_lookup
  ON approvals(bot_id, status, kind, target, resolved_at DESC);
```

`MessageKind` in `gateway/src/db.ts` and `web/src/types.ts` adds:
- `'quiet_digest'`
- `'rule_proposal'`

`GatewayEvent` in `gateway/src/hub.ts` and `web/src/types.ts` adds:
- `{ type: 'quiet_digest_changed' }`

`ActionTrigger` in `gateway/src/actions.ts` adds:
- `'prepare'`

---

## 3. Quiet Hours & Morning Digest

### 3.1 Settings (`gateway/src/settings.ts`)

Add three keys to `Settings` & `SETTING_DEFAULTS`:
- `quietHoursEnabled: false`
- `quietHoursStart: '22:00'`
- `quietHoursEnd: '08:00'`

Validation (`PARSE`):
- `quietHoursEnabled`: boolean.
- `quietHoursStart`, `quietHoursEnd`: trimmed string matching `/^([01]\d|2[0-3]):[0-5]\d$/`.

Add optional callback `onSettingsSaved?: (before: Settings, after: Settings) => void | Promise<void>` to `SettingsDeps` in `gateway/src/settings-api.ts`. When `PUT /api/settings` saves settings and either `quietHoursEnabled` becomes `false` or the updated window no longer contains `now()`, `server.ts` flushes pending quiet-digest items automatically.

### 3.2 Timezone Window Evaluation (`gateway/src/proactive/quiet-hours.ts`)

- `parseHhMm(value: string): number | null` parses `"HH:MM"` → minutes `[0, 1439]`.
- `localMinutesOfDay(now: Date, timeZone?: string): number` uses `Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })`, normalizing `hour % 24`.
- `isInQuietHours(now: Date, cfg: QuietHoursConfig, timeZone?: string): boolean`:
  - Returns `false` if `!cfg.quietHoursEnabled`, invalid times, or `start === end`.
  - If `start < end` (same-day window, e.g. `13:00`–`15:00`): `m >= start && m < end`.
  - If `start > end` (overnight wrap, e.g. `22:00`–`08:00`): `m >= start || m < end`.

### 3.3 Buffering & Breakthrough Rules

- Scheduled (`payload === undefined && !opts.force`) `watch` and `prepare` routines compute `quietBuffer = isInQuietHours(now(), quietCfg, deps.timeZone)` at run start.
- Operator-started turns, manual `POST /api/routines/:id/run` (`force: true`), `act` routines, and webhook routines are never buffered.
- Inside a `quietBuffer` turn:
  - Live `activity` chips are suppressed (actions still log to the `actions` table).
  - System/seed prompt informs the teammate that Quiet Hours are active (`HH:MM–HH:MM`) and non-urgent reports/summaries will wait for the morning digest unless `urgent: true` is set on `message_user`.
  - `message_user({ kind: 'report', payload, urgent?: boolean })`:
    - If `urgent === true`: posts `report` immediately to the thread as usual.
    - Otherwise: calls `onQuietBuffer({ kind: 'report', summary, payload })`, storing an undelivered row in `quiet_digest_items`, and returns a tool response confirming buffering + reminding of `urgent: true` for time-critical items.
  - Final non-silent plain text reply: stored via `onQuietBuffer({ kind: 'text', summary: text, payload: { text } })` instead of posting a `text` message.
  - `hold_for_approval`, `ask_operator`, `ask_for_login`, connector/MCP write approvals, and error/budget notices ALWAYS post immediately.

### 3.4 Flushing & REST Endpoints

- `flushQuietDigests(db, opts: { hub?, now, windowStart, windowEnd, botId?, manual? })`:
  - Atomically selects all `delivered_at IS NULL` rows (filtered by `botId` if given) ordered by `id ASC` inside a SQLite transaction, groups them by `(bot_id, thread_id)`, marks their `delivered_at = now`, and inserts one `kind: 'quiet_digest'` message per group with `QuietDigestPayload`:
    ```ts
    export type QuietDigestEntry = {
      id: number
      routineId: number | null
      routineName: string
      routineMode: RoutineMode
      kind: 'report' | 'text'
      summary: string
      report?: ReportPayload
      text?: string
      createdAt: number
    }
    export type QuietDigestPayload = {
      windowStart: string
      windowEnd: string
      itemCount: number
      items: QuietDigestEntry[]
      flushedManually?: boolean
    }
    ```
  - Broadcasts each inserted message (`type: 'message'`) and `{ type: 'quiet_digest_changed' }`, and logs an action entry per bot.
- `gateway.flushQuietDigestsIfDue()` checks `!isInQuietHours(now(), cfg, timeZone)` and flushes pending items. `gateway/src/main.ts` calls it on startup and on a 60-second `unref()` interval.
- REST routes in `gateway/src/server.ts`:
  - `GET /api/quiet-digest` → `{ enabled, active, start, end, timeZone, pendingCount, byBot }`
  - `POST /api/quiet-digest/flush` (optional body `{ botId?: string }`) → flushes immediately (even during active Quiet Hours) with `manual: true` and returns `{ flushed, threads }`.

---

## 4. `prepare` Routine Mode

- `RoutineMode = 'act' | 'watch' | 'prepare'`, `normalizeMode` recognizes `'watch'`, `'prepare'`, else `'act'`.
- `PREPARE_TOOL_NAMES = new Set([...WATCH_TOOL_NAMES, 'wiki_upsert', 'write_file'])`.
- `WATCH_TOOL_NAMES` includes `'propose_memory_rule'` (offered only when `canProposeRule: true`).
- `buildTools(opts)` supports `routineMode?: RoutineMode` (and backward-compatible `watch?: boolean`) and `canProposeRule?: boolean`:
  - `'watch'` → `WATCH_TOOL_NAMES` + `mcpReadToolNames`.
  - `'prepare'` → `PREPARE_TOOL_NAMES` + `mcpReadToolNames`.
  - `'act'` → full tool set (still respecting `operatorTurn`, `shell`, `hasComputer`, `hasWiki`, `canRelay`, `hasSkills`, `canProposeRule`).
- Defense-in-depth runtime gates:
  - `agent.ts` `execToolCall` enforces `WATCH_TOOL_NAMES` for `watch` and `PREPARE_TOOL_NAMES` for `prepare`.
  - `connectors/tools.ts` `runConnectorToolCall` accepts `readOnly?: boolean` and refuses `CONNECTOR_WRITE_TOOL_NAMES` when `readOnly` is true (set for both `watch` and `prepare`).
  - `mcp/tools.ts` `buildMcpToolSet` & `runMcpToolCall` receive `watch: isWatch || isPrepare` (read-only external MCP tools only).
  - `wiki/tools.ts` `runWikiToolCall` receives `watch: isWatch` only, allowing `wiki_upsert` during `prepare` while keeping it blocked during `watch`.
- Silent replies:
  - `watch`: `/^nothing new\.?$/i`
  - `prepare`: `/^nothing (?:new|to prepare)\.?$/i`

---

## 5. Controlled Dreaming (`RuleProposalChip`)

### 5.1 Module (`gateway/src/proactive/rule-proposals.ts`)

- Constants: `MAX_RULE_CHARS = 300`, `MAX_REASON_CHARS = 300`, `DISCARD_LOOKBACK_MS = 14 * 24 * 60 * 60_000`, `DISCARD_THRESHOLD = 2`.
- `sanitizeRuleLine(raw: string): string`: collapses CR/LF and whitespace to single spaces, trims, strips leading bullet markers (`^-+\s*`), rejects empty strings or strings exceeding `MAX_RULE_CHARS`.
- `comparableRule(text: string): string`: mirrors `memory.ts` normalization (collapse whitespace, strip trailing `.。!！`, lowercase).
- `createRuleProposal(db, input)`:
  - Validates `rule` and `reason`.
  - Checks `existingMemoryRules` (caller reads `listMemoryRules(dataDir, botId)`) — returns `{ created: false, reason: 'already_in_memory' }` if already present.
  - Checks `rule_proposals` for `(bot_id, dedupe_key)` with `status IN ('pending', 'dismissed')` — returns `{ created: false, reason: 'already_pending' | 'previously_dismissed' }`.
  - Inserts `rule_proposals` row, inserts `rule_proposal` message into `messages`, updates `rule_proposals.message_id`, broadcasts via `hub`, and returns `{ created: true, proposal, message }`.
- `maybeProposeRuleFromDiscard(db, input)`:
  - Triggered after `settleApproval` successfully records a `'discard'` decision (for non-workflow approvals).
  - Counts `approvals` rows in the last 14 days for the same `(bot_id, kind, target)` (if `target` non-empty) or `(bot_id, kind, lower(trim(action)))` (when `target` is empty).
  - When count ≥ 2, builds a clean editable rule suggestion + reason + deterministic `dedupeKey`, and calls `createRuleProposal` with `source: 'discard_pattern'`, `sourceTainted: false`.
- `resolveRuleProposal(db, input)`:
  - Looks up proposal by `id` (`'gone'` if missing, `'settled'` if not `'pending'`).
  - Validates edited `rule` if `decision === 'accept'` and `rule` is provided (`'invalid_rule'` on empty/too-long).
  - Atomically updates `rule_proposals` (`WHERE id = ? AND status = 'pending'`).
  - On `'accept'`: appends `finalRule` via `appendMemoryRule(dataDir, botId, finalRule)`, patches original `rule_proposal` message payload (`status: 'accepted'`, `rule: finalRule`, `edited`, `resolvedAt`), broadcasts updated chip, and if `saved.diff` is non-empty, inserts & broadcasts `memory_updated` (`by: 'operator'`).
  - On `'dismiss'`: patches original `rule_proposal` message payload (`status: 'dismissed'`, `resolvedAt`) and broadcasts updated chip.

### 5.2 Agent Tool & REST API

- `propose_memory_rule({ rule, reason })`:
  - Max 1 created proposal per turn (`proposedRuleThisTurn` flag in `runTurn`).
  - Server computes `sourceTainted = ctx.turnTainted || deps.origin === 'webhook'` (never model-controlled).
  - Dedupe key: `rule:${comparableRule(cleanRule)}`.
- REST endpoints:
  - `GET /api/rule-proposals` (optional `?botId=&status=`)
  - `POST /api/rule-proposals/:id` with `{ decision: 'accept' | 'dismiss', rule?: string }`
- Presence / badge policy:
  - Pending `rule_proposal` cards are non-blocking suggestions; they do NOT set `waitsOnOperator` or increment the blocking `pending` badge counter.

---

## 6. Frontend UI & Documentation

- **`RuleProposalChip.tsx`**:
  - Pending state: shows title ("Rule proposal" / "规矩提议"), source label (repeated discard vs teammate suggestion), amber warning pill (`External source — review carefully` / `来自外部内容，请仔细核对`) when `sourceTainted` is true, editable `<textarea>` prefilled with `payload.rule` (live char limit 300), reason subtitle, **Save to MEMORY.md** primary button, and **Dismiss** button.
  - Resolved state: compact status card showing Accepted (with optional Edited badge) or Dismissed.
- **`QuietDigestChip.tsx`**:
  - Renders consolidated Morning Digest card (`Morning digest · N updates` / `晨报汇总 · N 条更新`) with Quiet Hours window (`22:00–08:00`), grouped items showing routine name, mode tag (`watch` / `prepare`), timestamp, and either compact `ReportChip`-style lines or summary text.
- **`SettingsDialog.tsx`**:
  - New **Quiet Hours** section: enable toggle, start/end `<input type="time">` (24-hour `HH:MM`), save button, live status & pending digest count from `GET /api/quiet-digest` (fetched gracefully with `.catch(() => null)`), and **Deliver now** button calling `POST /api/quiet-digest/flush`.
- **`RoutineChip.tsx` & `ComputerPanel.tsx` & `Sidebar.tsx`**:
  - Show `prepare` badge / hint alongside `watch`.
  - Sidebar previews for `rule_proposal` (`💡 ...`) and `quiet_digest` (`🌅 ...`).
- **Styling (`web/src/index.css`)**:
  - Uses semantic CSS variables so both Dark and Light themes render cleanly.
- **Docs (`docs/security.md`)**:
  - Document `prepare` mode boundaries, Quiet Hours buffering & urgent breakthrough, and Controlled Dreaming (`MEMORY.md` human-in-the-loop gate + tainted warning).
