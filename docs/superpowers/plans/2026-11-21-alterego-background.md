# Phase 7 Implementation Plan: Meta / AlterEgo Non-Blocking Background Tasks

Spec: `docs/superpowers/specs/2026-11-21-alterego-background-design.md`  
Worktree: `/Users/qingmacbookpro/Projects/OpenSuperBot/.superpowers/worktree-phase7`  
Branch: `feat/alterego-background`

## Tasks

### Task 1: Schema v16, Browser Lease Mutex & Background Task Store/Runner
- Modify: `gateway/src/db.ts` (Migration `v16` `background_tasks`, extend `MessageKind` with `'background_task'`)
- Modify: `gateway/src/actions.ts` (extend `ActionTrigger` with `'background'`)
- Modify: `gateway/src/hub.ts` (add `{ type: 'background_task_changed'; botId: string; task: BackgroundTaskView }`)
- Create: `gateway/src/browser-lease.ts` (`BrowserLeaseHolder`, `BrowserLeasePool`, `createBrowserLeasePool`, `BROWSER_LEASE_TOOL_NAMES`)
- Create: `gateway/src/background-tasks.ts` (`BackgroundTaskStatus`, `BackgroundTaskStep`, `BackgroundTaskView`, `BackgroundTaskPayload`, `BackgroundTaskManager`, `createBackgroundTaskManager`, `reconcileStaleBackgroundTasks`, `listBackgroundTasks`, `getBackgroundTask`)
- Create: `gateway/test/background-tasks.test.ts` (v16 migration, browser lease acquire/conflict/release/idempotency, queue cap, FIFO execution, live step updates, steering queue, cancel queued & running, startup reconciliation, `stopAll`)

### Task 2: Agent Tools, Steering Loop, Browser Lease Guard & Gateway REST Wiring
- Modify: `gateway/src/tools.ts` (`BACKGROUND_TOOLS`, `BACKGROUND_CONTROL_TOOL_NAMES`, `canBackgroundTasks`, `isBackgroundTask` in `buildTools`)
- Modify: `gateway/src/prompts.ts` (brief AlterEgo delegation & background-task guidance)
- Modify: `gateway/src/agent.ts` (extend `TurnOrigin` with `'background'`, add `isBackgroundTask`, `backgroundTaskId`, `drainSteeringNotes`, `onStepProgress`, `onAcquireBrowser`, `onDelegateBackgroundTask`, `onListBackgroundTasks`, `onSteerBackgroundTask`, `onCancelBackgroundTask`, `suppressFinalText` / `onFinalText`; wire steering injection before LLM calls, browser lease checks before browser tools, runtime gates blocking recursive/non-operator background controls, `toChatMsg` for `background_task`)
- Modify: `gateway/src/server.ts` (instantiate `browserLeases` + `backgroundTasks` + run `reconcileStaleBackgroundTasks`; wire foreground browser lease acquire/release + workflow recording/run `409 browser_in_use`; wire background runner on secondary lane with `P1 background` LLM priority & isolated history snapshot; expose `GET /api/bots/:botId/background-tasks`, `backgroundTasks` in `/api/bots/:botId/computer`, `POST /api/background-tasks/:id/steer`, `POST /api/background-tasks/:id/cancel`; update `isBusy`, `stopAll`, `/api/summary`)

### Task 3: Comprehensive Gateway Integration Tests (`background-agent.test.ts` & `background-server.test.ts`)
- Create: `gateway/test/background-agent.test.ts` (tool visibility & runtime refusal in routine/webhook/relay/background turns, steering note injection mid-loop, browser lease conflict messages both directions, non-browser tools running freely while browser leased, taint propagation inside background tasks)
- Create: `gateway/test/background-server.test.ts` (end-to-end non-blocking delegation: foreground replies immediately & handles a 2nd interactive DM concurrently while background task runs at `P1` on local Ollama; browser lease conflict refusal & release after completion; workflow recording 409 when browser leased; mid-flight steer via REST & foreground tool; cancel queued & running without stopping foreground; `isBusy` true during background run; `stopAll` cancels background tasks; startup reconciliation marks stale rows cancelled)

### Task 4: Web Types, API, Bilingual i18n, UI Components, CSS (Dark & Light), Tests & Docs
- Modify: `web/src/types.ts`, `web/src/api.ts`, `web/src/i18n/en.ts`, `web/src/i18n/zh-CN.ts`, `web/src/i18n/GLOSSARY.md`
- Create: `web/src/components/BackgroundTaskChip.tsx` & `web/src/components/BackgroundTaskChip.test.tsx`
- Modify: `web/src/components/Thread.tsx`, `web/src/components/ComputerPanel.tsx`, `web/src/components/Sidebar.tsx`, `web/src/App.tsx`, `web/src/index.css`
- Modify: `web/src/components/ComputerPanel.test.tsx`, `web/src/components/Sidebar.test.tsx`, `web/src/components/Thread.test.tsx`, `web/src/App.test.tsx`, `web/src/i18n/i18n.test.tsx`
- Modify: `docs/security.md`
- Final Whole-Branch Review & Merge to `main`.
