# Phase 5 Implementation Plan: Proactive Routines, Quiet Hours & Controlled Dreaming

Spec: `docs/superpowers/specs/2026-11-21-proactive-dreaming-design.md`  
Worktree: `/Users/qingmacbookpro/Projects/OpenSuperBot/.superpowers/worktree-phase5`  
Branch: `feat/proactive-dreaming`

## Execution Strategy

5 self-contained TDD tasks, each implemented by a fresh subagent in `.superpowers/worktree-phase5` and reviewed for spec compliance + code quality before advancing, followed by a whole-branch final review and merge to `main`.

---

## Task 1: Schema v15, Quiet Hours Settings/Store & Rule Proposals Engine

**Files:**
- Modify: `gateway/src/db.ts` (Migration `v15`: `quiet_digest_items`, `rule_proposals`, `idx_approvals_discard_lookup`; extend `MessageKind`)
- Modify: `gateway/src/hub.ts` (add `{ type: 'quiet_digest_changed' }`)
- Modify: `gateway/src/actions.ts` (add `'prepare'` to `ActionTrigger`)
- Modify: `gateway/src/routines.ts` (extend `RoutineMode = 'act' | 'watch' | 'prepare'`, update `normalizeMode`)
- Modify: `gateway/src/settings.ts` (add `quietHoursEnabled`, `quietHoursStart`, `quietHoursEnd` + `HH:MM` validation)
- Modify: `gateway/src/settings-api.ts` (add `onSettingsSaved` callback to `SettingsDeps`)
- Create: `gateway/src/proactive/quiet-hours.ts` (`parseHhMm`, `isInQuietHours`, `enqueueQuietDigestItem`, `listPendingDigestItems`, `getQuietDigestSummary`, `flushQuietDigests`)
- Create: `gateway/src/proactive/rule-proposals.ts` (`sanitizeRuleLine`, `comparableRule`, `createRuleProposal`, `maybeProposeRuleFromDiscard`, `listRuleProposals`, `getRuleProposal`, `resolveRuleProposal`)
- Create: `gateway/test/proactive-store.test.ts`

**TDD Verification:**
- Schema migrates cleanly to `v15`; old DB upgrades seamlessly.
- `isInQuietHours` handles overnight wrap (`22:00`–`08:00`), daytime window (`13:00`–`15:00`), boundary `[start, end)`, equal start/end (`false`), disabled (`false`), and explicit IANA timezones (`Asia/Shanghai`, `America/Los_Angeles`, `UTC`).
- `enqueueQuietDigestItem` + `flushQuietDigests` groups per `(bot_id, thread_id)`, inserts one `quiet_digest` message per bot, marks `delivered_at`, broadcasts events, and is idempotent on repeat flush.
- `createRuleProposal` sanitizes newlines/bullets, dedupes against `MEMORY.md`, pending proposals, and previously dismissed proposals.
- `maybeProposeRuleFromDiscard` fires at ≥ 2 discards in 14 days (ignores older than 14 days), respects target vs empty-target action matching, never re-proposes after dismiss.
- `resolveRuleProposal` supports accept with inline rule edit (writes `MEMORY.md` + emits `memory_updated` chip with `by: 'operator'`) and dismiss, rejecting double-resolution (`'settled'`).

---

## Task 2: `prepare` Mode, `propose_memory_rule`, Quiet Hours Interception & Gateway REST/Scheduler Wiring

**Files:**
- Modify: `gateway/src/tools.ts` (`PREPARE_TOOL_NAMES`, `PROPOSE_MEMORY_RULE_TOOL`, `canProposeRule`, `routineMode` in `buildTools`, `urgent?: boolean` on `MESSAGE_USER_TOOL`, `'prepare'` in `create_routine`)
- Modify: `gateway/src/prompts.ts` (add `mode?: RoutineMode` on `PromptRoutine`, add concise `propose_memory_rule` & `prepare` guidance)
- Modify: `gateway/src/connectors/tools.ts` (add `readOnly?: boolean` defense-in-depth guard to `runConnectorToolCall`)
- Modify: `gateway/src/agent.ts` (`routineMode`, `quietBuffer`, `onQuietBuffer`, `onProposeMemoryRule`, `prepare` tool gate & silent `"Nothing to prepare."`, `message_user` `urgent` breakthrough vs quiet buffering, final text quiet buffering, 1-per-turn cap & server-derived `sourceTainted` on `propose_memory_rule`, `toChatMsg` for `quiet_digest` & `rule_proposal`)
- Modify: `gateway/src/server.ts` (wire `prepare` mode in `startTurn`/`runRoutine`, quiet-hours interception for scheduled non-forced `watch`/`prepare`, auto-flush on `onSettingsSaved`, `flushQuietDigestsIfDue()`, `GET /api/quiet-digest`, `POST /api/quiet-digest/flush`, `GET /api/rule-proposals`, `POST /api/rule-proposals/:id`, call `maybeProposeRuleFromDiscard` in `settleApproval` discard path)
- Modify: `gateway/src/main.ts` (startup & 60s `unref()` periodic `gateway.flushQuietDigestsIfDue()`)

**TDD Verification:**
- Existing `buildTools` exact-equality tests stay 100% green.
- `prepare` mode exposes `wiki_upsert`, `write_file`, `propose_memory_rule`, and read-only tools, while hiding AND refusing at runtime: `shell`, `browser_click`, `browser_type`, `browser_press`, `message_bot`, connector writes, MCP writes, and `OPERATOR_ONLY_TOOL_NAMES`.
- `watch` mode still blocks `wiki_upsert` and `write_file`.

---

## Task 3: Comprehensive Gateway Integration Tests (`proactive-agent.test.ts` & `proactive-server.test.ts`)

**Files:**
- Create: `gateway/test/proactive-agent.test.ts` (unit/agent-loop tests for `prepare` mode capabilities & runtime refusals, `"Nothing to prepare."` silence, `propose_memory_rule` taint propagation & 1-per-turn cap, quiet-hours report/text buffering vs `urgent: true` breakthrough vs approval breakthrough)
- Create: `gateway/test/proactive-server.test.ts` (end-to-end HTTP + `createApp` tests covering: scheduled watch/prepare buffering during Quiet Hours, manual `POST /api/routines/:id/run` bypassing Quiet Hours, morning flush via `flushQuietDigestsIfDue()` and `POST /api/quiet-digest/flush` and disabling Quiet Hours via `PUT /api/settings`, 2× discard auto-proposal → inline edit accept → `MEMORY.md` updated & `memory_updated` chip, dismiss suppressing re-proposal, `propose_memory_rule` from tainted webhook/browser turn showing `sourceTainted: true`, `pending` count unaffected by non-blocking `rule_proposal`)

**TDD Verification:**
- Full `pnpm --filter @opensuperbot/gateway test -- test/proactive-server.test.ts` and `pnpm typecheck` pass.

---

## Task 4: Web Types, API Client & Bilingual i18n (`en` / `zh-CN`)

**Files:**
- Modify: `web/src/types.ts` (extend `RoutineMode`, `MessageKind`, `GatewayEvent`, `SettingsView['values']`; add `QuietDigestEntry`, `QuietDigestPayload`, `QuietDigestSummary`, `RuleProposalPayload`, `RuleProposalView`)
- Modify: `web/src/api.ts` (`fetchQuietDigest`, `flushQuietDigest`, `fetchRuleProposals`, `resolveRuleProposal`)
- Modify: `web/src/i18n/en.ts` (all copy for Quiet Hours settings, Morning Digest chip, Rule Proposal chip, `prepare` mode tags/hints, sidebar previews)
- Modify: `web/src/i18n/zh-CN.ts` (exact matching Simplified Chinese keys)
- Modify: `web/src/i18n/i18n.test.ts` (verify key parity automatically via existing test suite)

**TDD Verification:**
- `pnpm typecheck` and `pnpm --filter @opensuperbot/web test -- src/i18n/i18n.test.ts` pass.

---

## Task 5: Web UI Components, CSS (Dark & Light), Component Tests & Security Docs

**Files:**
- Create: `web/src/components/RuleProposalChip.tsx` (editable rule textarea, amber `External source` warning badge when tainted, Save to MEMORY.md / Dismiss buttons, optimistic busy lock & error recovery, resolved state)
- Create: `web/src/components/QuietDigestChip.tsx` (Morning Digest header with window & count, collapsible/clean list of buffered reports & updates with routine name, mode tag, timestamp)
- Modify: `web/src/components/Thread.tsx` (render `rule_proposal` & `quiet_digest`, pass `onResolveRuleProposal`)
- Modify: `web/src/components/RoutineChip.tsx` (support `mode === 'prepare'` label, icon, and hint)
- Modify: `web/src/components/ComputerPanel.tsx` (show `prepare` tag on routines)
- Modify: `web/src/components/Sidebar.tsx` (previews for `rule_proposal` & `quiet_digest`)
- Modify: `web/src/components/SettingsDialog.tsx` (Quiet Hours toggle, start/end time pickers, live pending digest summary & **Deliver now** button, graceful fallback when `/api/quiet-digest` unavailable)
- Modify: `web/src/App.tsx` (wire `onResolveRuleProposal`, handle `quiet_digest_changed` WS event to notify `SettingsDialog`, refresh ComputerPanel when `rule_proposal` / `memory_updated` arrives)
- Modify: `web/src/index.css` (semantic variable styles for `.rule-proposal-chip`, `.quiet-digest-chip`, `.settings-quiet-hours`, `.panel-routine-tag.prepare` across Dark & Light themes)
- Create: `web/src/components/RuleProposalChip.test.tsx`
- Create: `web/src/components/QuietDigestChip.test.tsx`
- Modify: `web/src/components/RoutineChip.test.tsx` (add `prepare` mode test)
- Modify: `web/src/components/SettingsDialog.test.tsx` (add Quiet Hours toggle/save & Deliver now tests)
- Modify: `docs/security.md` (document `prepare` capability boundaries, Quiet Hours buffering/urgent breakthrough, Controlled Dreaming human gate & taint warning)

**TDD Verification:**
- `pnpm typecheck`, all gateway/web/desktop test suites, and `pnpm build` pass completely.
