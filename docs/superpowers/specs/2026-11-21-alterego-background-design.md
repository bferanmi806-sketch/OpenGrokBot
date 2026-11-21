# Phase 7 Design Spec: Meta / AlterEgo Non-Blocking Background Tasks

Date: 2026-11-21  
Branch: `feat/alterego-background`  
Base: `main` (`116866d`)

## 1. Goal

Decouple long-running teammate work from interactive chat (the **Meta / AlterEgo** pattern): a teammate can offload a multi-step research, drafting, or scraping job into a dedicated **background lane** (`AlterEgo`) while its **foreground lane** (`Meta`) immediately returns to idle so the operator can keep chatting, ask status questions, send mid-flight steering notes, or cancel the background task — all while preventing browser page collisions on the teammate's single persistent computer.

---

## 2. Database Schema (Migration `v16`) & Event Types

Appended as `MIGRATIONS[15]` in `gateway/src/db.ts` (`SCHEMA_VERSION = 16`):

```sql
CREATE TABLE IF NOT EXISTS background_tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  step_count INTEGER NOT NULL DEFAULT 0,
  last_step TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  uses_browser INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_background_tasks_bot
  ON background_tasks(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_background_tasks_status
  ON background_tasks(status, bot_id);
```

- `MessageKind` (`gateway/src/db.ts`, `web/src/types.ts`): add `'background_task'`.
- `ActionTrigger` (`gateway/src/actions.ts`): add `'background'`.
- `TurnOrigin` (`gateway/src/agent.ts`): add `'background'` (`'operator' | 'routine' | 'webhook' | 'relay' | 'background'`).
- `GatewayEvent` (`gateway/src/hub.ts`, `web/src/types.ts`): add `{ type: 'background_task_changed'; botId: string; task: BackgroundTaskView }`.

### Startup Reconciliation
`reconcileStaleBackgroundTasks(db, { now })` runs on gateway startup (`createApp`): any leftover `'queued'` or `'running'` rows from a previous crash/restart are marked `'cancelled'` (`error: 'Gateway restarted before this background task finished.'`, `finished_at = now`) and their `background_task` thread message payload is patched so the UI never shows zombie running cards.

---

## 3. Per-Bot Browser Lease Mutex (`gateway/src/browser-lease.ts`)

User-confirmed policy (**A1**): background tasks MAY use the teammate's browser on demand, with a per-bot session lease preventing foreground and background turns from clobbering the same persistent page.

- `BrowserLeaseHolder`:
  - `{ kind: 'foreground'; label: string }` (held by a foreground turn or workflow recording/run once it uses the browser, released on turn/recording/run completion)
  - `{ kind: 'background'; taskId: string; title: string }` (acquired lazily on a background task's FIRST browser tool call, held until that background task completes/fails/cancels)
- **Browser tools governed by the lease (`BROWSER_LEASE_TOOL_NAMES`):**
  - `browser_goto`, `browser_extract`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_back`, `browser_screenshot`, `ask_for_login`.
- **Conflict behavior (non-blocking, zero deadlock):**
  - Non-browser tools (`wiki_*`, `read_file`, `write_file`, `shell`, connectors, MCP, `hold_for_approval`, `ask_operator`, `propose_memory_rule`) NEVER acquire the browser lease and run freely in parallel!
  - If a background task holds the lease and a **foreground** turn invokes a browser tool, the tool call returns a clear refusal (never mutating the browser):
    `"Your browser is currently in use by background task ${taskId} (\"${title}\"). You can keep chatting, use non-browser tools, wait for it to finish, or cancel it with cancel_background_task."`
  - If foreground or a workflow recording/run holds the lease and a **background** task invokes a browser tool, it returns:
    `"Your browser is currently in use by ${label}. Continue with non-browser work or wait until it finishes."`
  - Workflow recording (`POST /api/bots/:botId/workflows/record`) and workflow replay (`POST /api/workflows/:id/run`) acquire `{ kind: 'foreground', label: 'workflow recording' | 'workflow run' }` and return HTTP `409 { error: 'browser_in_use', taskId, title }` if a background task currently holds the browser lease (releasing on finish/stop).

---

## 4. Background Task Engine (`gateway/src/background-tasks.ts`)

- **Queue & concurrency:** Secondary lane per bot: max **1 running** + up to **5 queued** tasks per bot (`MAX_ACTIVE_TASKS_PER_BOT = 6`). Task IDs use `bg-<8 hex chars>`.
- **Lifecycle:** `'queued' → 'running' → 'completed' | 'failed' | 'cancelled'`.
- **LLM priority:** Background tasks run at `priority: 'background'` (`P1`), so interactive foreground chats (`P0`) preempt waiting background steps on local models automatically (Phase 6 integration!).
- **Security invariants:**
  - Background tasks run with `origin: 'background'` and `isBackgroundTask: true`.
  - **No recursive spawning:** `delegate_background_task`, `steer_background_task`, and `cancel_background_task` are NOT advertised and are refused at runtime inside background turns, routines, webhooks, and relays.
  - **No standing mutations:** `OPERATOR_ONLY_TOOL_NAMES` (`save_memory`, `forget_memory`, `create_routine`, `stop_routine`) are blocked (standing rule proposals via `propose_memory_rule` remain allowed and carry `sourceTainted` if external data was read).
  - **Approval discipline preserved:** `origin: 'background'` holds outward actions (`hold_for_approval`, connector writes, MCP writes) for operator approval (`ruleBlock: 'background'`).
- **Live progress & thread hygiene:**
  - Starting a task inserts ONE `kind: 'background_task'` chip in the thread (`BackgroundTaskPayload`).
  - During execution, noisy `activity` chips are suppressed; each tool step updates the `background_task` row (`step_count`, `last_step`, bounded last 25 `steps`) and patches the `background_task` chip in-place + broadcasts `{ type: 'message' }` and `{ type: 'background_task_changed' }`.
  - When a background task uses a browser tool for the first time, `uses_browser = 1` is recorded and broadcast.
  - On completion, the `background_task` chip is patched with `status: 'completed'` and `summary`; if the task produced a final text response (and didn't only file a report/approval), a concise completion text message is posted to the thread so the operator sees it at the bottom and future foreground turns see it in history.
- **Mid-flight steering (`steer`):**
  - Operator (via UI / `POST /api/background-tasks/:id/steer`) or foreground teammate (via `steer_background_task`) pushes a steering note (`1–1000` chars) to a `'queued'` or `'running'` task.
  - Immediately recorded as a `{ tool: 'steer', summary: note }` step on the task card and delivered into the background `runTurn` loop before the next LLM call via `drainSteeringNotes()`.
- **Cancellation & Shutdown:**
  - `cancel(taskId)` cancels a `'queued'` or `'running'` task without affecting foreground chat (and releases `browserLease` in `finally`).
  - `gateway.isBusy(botId)` includes `backgroundTasks.hasActive(botId)` so idle container reaping never kills a computer running background work.
  - `gateway.stopAll()` aborts all running and queued background tasks on shutdown.
  - `presenceOf(botId)` keeps foreground presence responsive (`'idle'` / `'waiting'` when foreground is idle) so the operator can chat immediately; `GET /api/summary` adds `backgroundTasks: number` (and keeps `working` counting active bots including background work so desktop quit warning remains safe).

---

## 5. Foreground Tools & REST Endpoints

### Tools (`gateway/src/tools.ts`, gated by `canBackgroundTasks: true`)
- `delegate_background_task({ title, instructions })` — operator foreground DM/group turns only (`origin === 'operator' && !isBackgroundTask && !watch && !prepare`).
- `list_background_tasks()` — returns active & recent background tasks for this bot (id, title, status, stepCount, lastStep, usesBrowser, summary).
- `steer_background_task({ taskId, note })` — operator foreground turns only; steers one of this bot's active background tasks.
- `cancel_background_task({ taskId })` — operator foreground turns only; cancels one of this bot's active background tasks.

### REST API (`gateway/src/server.ts`)
- `GET /api/bots/:botId/background-tasks` → `{ tasks: BackgroundTaskView[] }` (also included as `backgroundTasks` on `GET /api/bots/:botId/computer`!).
- `POST /api/background-tasks/:id/steer` (`{ note: string }`) → `200 { ok: true, task }` | `400` | `404` | `409` (already finished).
- `POST /api/background-tasks/:id/cancel` → `200 { ok: true, task }` | `404` | `409` (already finished).

---

## 6. Frontend UI & Documentation

- **`BackgroundTaskChip.tsx`**:
  - Live card in thread showing status pill (`Queued` / `Running` / `Completed` / `Failed` / `Cancelled`), task title, step counter, browser-in-use badge (`Using browser` when `usesBrowser` is active), expandable/recent steps list, inline **Steer** input (`Send note` while queued/running), **Cancel** button, and final `summary` / `error`.
- **`ComputerPanel.tsx`**:
  - Dedicated **Background tasks** section showing live tasks for the teammate with status, latest step, browser lock indicator, quick inline steer input, and Cancel button (updates live via WS `background_task_changed`!).
- **`Thread.tsx` / `App.tsx` / `Sidebar.tsx`**:
  - Wire `onSteerBackgroundTask` & `onCancelBackgroundTask`.
  - Render a compact live **Background task** pill in the DM thread header when the selected teammate has an active background task (clicking opens `ComputerPanel`!).
  - Sidebar preview for `background_task` (`⚡ ...`).
- **CSS (`web/src/index.css`)**: semantic CSS variables only (Dark & Light themes).
- **Docs (`docs/security.md`)**: document background task isolation (`origin: 'background'`, no recursive spawn, no standing-rule mutations, approvals still held, per-bot browser lease mutex).
