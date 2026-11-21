# Phase 6 Implementation Plan: Local LLM Priority Semaphore Queue

Spec: `docs/superpowers/specs/2026-11-21-local-llm-priority-design.md`  
Worktree: `/Users/qingmacbookpro/Projects/OpenSuperBot/.superpowers/worktree-phase6`  
Branch: `feat/local-llm-priority`

## Tasks

### Task 1: Priority Semaphore Queue Engine (`gateway/src/llm-queue.ts`) & Config/Settings
- Modify: `gateway/src/config.ts` (add `localLlmConcurrency: number`, `OPENSUPERBOT_LOCAL_LLM_CONCURRENCY`, bounded integer `0..8`, default `1`)
- Modify: `gateway/src/settings.ts` (add `localLlmConcurrency` to `Settings`, `SETTING_DEFAULTS`, `ENV`, `PARSE`, `applySettings`)
- Modify: `gateway/src/llm.ts` (add optional `priority?: LlmPriority` to `ChatOptions`, re-export `LlmPriority`)
- Create: `gateway/src/llm-queue.ts` (`LlmPriority`, `LLM_PRIORITY_RANK`, `localEndpointKey`, `createLlmQueue`, `LlmQueue`, `LlmQueueSnapshot`, `LlmQueueEndpointView`)
- Create: `gateway/test/llm-queue.test.ts` (endpoint classification including loopback aliasing, LAN RFC-1918/ULA/mDNS, IPv4-mapped IPv6 hex/dotted, public cloud bypass; `P0 > P1 > P2 > P3` ordering; FIFO within tier; AbortSignal cancellation before/during wait; error slot release; dynamic concurrency resize `1 -> 2` and `1 -> 0`; `wrap()` stub & cloud bypass; settings/config parsing)

### Task 2: Gateway Priority Propagation, Wiring & End-to-End Integration Tests
- Modify: `gateway/src/agent.ts` (add `priority?: LlmPriority` on `AgentDeps`, derive default from `origin`, forward `priority` in `llm.chat` and `closeOut`)
- Modify: `gateway/src/server.ts` (add `llmQueue?: LlmQueue` on `AppDeps`, derive `priority` in `startTurn` / `runRoutine` with manual `force: true` runs at `'interactive'`, notify `llmQueue.notifyConcurrencyChange()` in `onSettingsSaved`, mount `GET /api/llm-queue`)
- Modify: `gateway/src/main.ts` (instantiate shared `llmQueue`, wrap `live` `llm` and `llmFor` clients, pass `llmQueue` to `createApp`)
- Create: `gateway/test/llm-queue-server.test.ts` (multi-bot shared local Ollama endpoint contention: `P0` operator DM & manual `force: true` run preempt queued `P1` relay and `P2` watch/prepare routines between steps; `GET /api/llm-queue` live snapshot; `POST /api/threads/:id/stop` cancels queued turn immediately; `PUT /api/settings` concurrency `1 -> 2` unblocks waiting turn immediately)

### Task 3: Web Settings UI, Bilingual i18n, Tests & Whole-Branch Verification
- Modify: `web/src/types.ts` (add `localLlmConcurrency?: number` on `SettingsView['values']`, `LlmPriority`, `LlmQueueEndpointView`, `LlmQueueSnapshot`)
- Modify: `web/src/api.ts` (add `fetchLlmQueue()`)
- Modify: `web/src/i18n/en.ts`, `web/src/i18n/zh-CN.ts`, `web/src/i18n/GLOSSARY.md`
- Modify: `web/src/components/SettingsDialog.tsx` & `web/src/index.css` (Local model concurrency selector inside Models section + env lock notice + live queue indicator when busy)
- Modify: `web/src/components/SettingsDialog.test.tsx`, `web/src/i18n/i18n.test.tsx`
- Final whole-branch review, fix wave if needed, merge to `main`, push `origin main`.
