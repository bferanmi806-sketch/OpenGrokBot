# Phase 8 Design Spec: Group Room `team.md` & DAG Dispatch Pipeline

Date: 2026-11-21  
Branch: `feat/team-dispatch-pipeline`  
Base: `main` (`091b378`)

## 1. Goal

Upgrade OpenSuperBot's group thread from a single-round parallel status check into a coordinated multi-teammate execution room with two tightly integrated capabilities:

1. **Group Team Charter (`team.md`):** An operator-owned shared collaboration playbook per group thread stored outside bot workspaces (`<data>/groups/<safe-key>/team.md`), automatically injected into every teammate's system prompt when speaking in that group or executing a pipeline step.
2. **Sequential / DAG Dispatch Pipeline (`DispatchPlanChip`):** When complex multi-teammate work has dependencies (e.g. Scout researches → Market Watch prices → Inbox Keeper drafts outreach), Chief calls `create_dispatch_plan` to post an interactive DAG pipeline card (`status: 'draft'`). Per user decision (**A2**), nothing runs until the operator clicks **Start pipeline**; once started, independent steps execute in parallel, downstream steps receive fenced upstream outputs & taint propagation, approval/question holds cleanly pause downstream dependents and auto-resume when approved, and the operator can cancel at any point.

---

## 2. Database Schema (Migration `v17`) & Types

Appended as `MIGRATIONS[16]` in `gateway/src/db.ts` (`SCHEMA_VERSION = 17`):

```sql
CREATE TABLE IF NOT EXISTS dispatch_plans (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source_tainted INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dispatch_plans_thread
  ON dispatch_plans(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_plans_status
  ON dispatch_plans(status);

CREATE TABLE IF NOT EXISTS dispatch_plan_steps (
  plan_id TEXT NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  bot_id TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  output TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  output_tainted INTEGER NOT NULL DEFAULT 0,
  waiting_approval_id INTEGER,
  waiting_question_id INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (plan_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_dispatch_plan_steps_plan
  ON dispatch_plan_steps(plan_id, seq ASC);
CREATE INDEX IF NOT EXISTS idx_dispatch_plan_steps_wait
  ON dispatch_plan_steps(status, waiting_approval_id, waiting_question_id);
```

- `MessageKind` (`gateway/src/db.ts`, `web/src/types.ts`): add `'dispatch_plan'`.
- `ActionTrigger` (`gateway/src/actions.ts`): add `'pipeline'`.
- `GatewayEvent` (`gateway/src/hub.ts`, `web/src/types.ts`): add:
  - `{ type: 'dispatch_plan_changed'; threadId: string; plan: DispatchPlanView }`
  - `{ type: 'team_charter_changed'; threadId: string }`

---

## 3. Group Team Charter (`gateway/src/team-charter.ts`)

- Stored outside bot workspaces at `<data>/groups/<safeThreadDirName(threadId)>/team.md`.
- `safeThreadDirName(threadId)`: replaces any character outside `[a-zA-Z0-9._-]` (including `:` in `group:offsite-crew`, which is illegal on Windows!) with `_`, guards Windows reserved device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`), and appends an 8-char SHA-256 suffix of `threadId` so distinct thread IDs never collide.
- `MAX_TEAM_CHARTER_CHARS = 16_384`.
- `readTeamCharter(dataDir, threadId)` → `{ content: string; updatedAt: number | null }` (returns empty string if file does not exist).
- `writeTeamCharter(dataDir, threadId, content)` → validates `<= MAX_TEAM_CHARTER_CHARS`, writes atomically via temp file + rename (or removes/truncates cleanly when empty), returns `{ content, updatedAt }`.
- Bots have NO write tool for `team.md`; only the operator edits it via `PUT /api/threads/:id/team`.
- Injected into `groupBriefing(...)` in `gateway/src/prompts.ts` whenever non-empty (`## Team charter (team.md)`).

---

## 4. DAG Dispatch Plan Engine (`gateway/src/dispatch-plans.ts`)

### 4.1 Validation & Topological Ordering
- `MAX_DISPATCH_STEPS = 12`, `MAX_PLAN_TITLE_CHARS = 120`, `MAX_STEP_TITLE_CHARS = 120`, `MAX_STEP_INSTRUCTIONS_CHARS = 4000`, `MAX_STEP_OUTPUT_CHARS = 2000`.
- Step IDs: `^[a-z0-9][a-z0-9_-]{0,31}$` (lowercased/trimmed), unique within the plan.
- Every `botId` must be a valid member of the group thread (`allowedBotIds`).
- Every `dependsOn` reference must point to another step in the same plan (no unknown IDs, no self-dependencies).
- **Cycle detection:** Kahn's algorithm validates the graph is a strict DAG and assigns deterministic topological `seq` (`0..n-1`) and `wave` depth for clean UI presentation. Rejects cycles with a clear error naming the cyclic step IDs.

### 4.2 Plan & Step Lifecycle
- Plan statuses: `'draft' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'`.
- Step statuses: `'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'skipped' | 'cancelled'`.
- **Draft creation (`createPlan`):**
  - Inserts `dispatch_plans` (`status = 'draft'`, `source_tainted = sourceTainted ? 1 : 0`) + `dispatch_plan_steps` (`status = 'pending'`) + one `kind: 'dispatch_plan'` message in `threadId` inside a single SQLite transaction, then broadcasts `message` and `dispatch_plan_changed`.
- **Explicit operator start (`startPlan(planId)`):**
  - Only transitions `'draft' → 'running'` (`404` if missing, `409` if not `'draft'`).
  - Schedules ready steps (`status === 'pending'` whose `dependsOn` are ALL `'completed'`) in parallel across bots!
- **Upstream output & taint forwarding:**
  - Each step receives its direct dependencies' completed outputs fenced with clear step headers (`[upstream step <id> by @<botId>: <title>]`).
  - Step starts tainted iff `plan.sourceTainted || deps.some(d => d.outputTainted)`.
  - If a step reads untrusted external data during execution, `output_tainted` is persisted as `1` and propagated to all downstream dependents!
- **Approval / Question hold pause & auto-resume:**
  - If a step completes its turn with a newly created pending approval (`waitingApprovalId`) or open question (`waitingQuestionId`), the step transitions to `'waiting_approval'` and downstream dependents wait (if no other steps are running, the plan shows `'paused'`).
  - When `settleApproval` or `POST /api/questions/:id` settles that item (and after any resumed bot turn finishes):
    - On `'approve'` (or question answered): `resumeStepAfterWait({ approvalId | questionId, outcome: 'completed', output, tainted })` marks the step `'completed'`, transitions `'paused' → 'running'`, and immediately pumps newly unblocked downstream steps!
    - On `'discard'`: `resumeStepAfterWait({ approvalId, outcome: 'failed', error: 'Approval discarded by operator.' })` marks the step `'failed'`, marks transitive downstream dependents `'skipped'`, and settles or continues unaffected branches cleanly.
- **Failure, cancellation & restart recovery:**
  - Failing a step marks transitive downstream dependents `'skipped'`; independent branches can finish, and the final plan status becomes `'failed'` once no active/waiting steps remain.
  - Cancelling a plan (`'draft' | 'running' | 'paused'`) aborts in-flight step `AbortController`s, marks pending/running/waiting steps `'cancelled'`, sets plan `'cancelled'`, and updates the chip.
  - On gateway startup, `reconcileStaleDispatchPlans(db, { now })` marks leftover `'running'` steps/plans as `'cancelled'` (`error: 'Gateway restarted before this pipeline finished.'`), while preserving `'draft'` plans and `'paused'`/`'waiting_approval'` steps (so approving a held card after restart can still resume the pipeline cleanly!).

---

## 5. Agent Tool, Security & REST Wiring

### Tool (`gateway/src/tools.ts`, gated by `canDispatchPlan: true`)
- `create_dispatch_plan({ title, steps: [{ id, botId, title, instructions, dependsOn? }] })`
  - Advertised and allowed ONLY when `origin === 'operator' && isChiefInGroup && !isBackgroundTask && effectiveMode === 'act'`.
  - Refused at runtime for non-Chief teammates, DM threads, non-operator turns, background tasks, watch/prepare routines, and pipeline steps.
- Pipeline steps run with:
  - `origin: 'relay'` (blocking `OPERATOR_ONLY_TOOL_NAMES` and standing *Always allow…* rules, recording `ruleHeld: 'relay'` if a standing rule would match)
  - `priority: 'background'` (`P1` — interactive operator chats `P0` preempt pipeline steps on local models)
  - `trigger: 'pipeline'`
  - `isPipelineStep: true` (forbids recursive `create_dispatch_plan` and `delegate_background_task`)

### REST API (`gateway/src/server.ts`)
- `GET /api/threads/:id/team` → `{ threadId, content, updatedAt }` (`404` if missing or not a group thread)
- `PUT /api/threads/:id/team` (`{ content: string }`) → `200 { threadId, content, updatedAt }` | `400` | `404`
- `GET /api/threads/:id/dispatch-plans` → `{ plans: DispatchPlanView[] }` (`404` if missing or not a group thread)
- `POST /api/dispatch-plans/:id/start` → `200 { ok: true, plan }` | `404` | `409`
- `POST /api/dispatch-plans/:id/cancel` → `200 { ok: true, plan }` | `404` | `409`

---

## 6. Frontend UI & Documentation

- **`DispatchPlanChip.tsx`**:
  - Visual DAG pipeline card rendered in group threads: header with title, status pill, amber `External source` badge when `sourceTainted`, ordered step rows with assignee avatar/name, dependency chips, per-step status pill, expandable output/error, and **Start pipeline** / **Cancel** action buttons (with synchronous lock, immediate 200 patch, and 409 resync).
- **`TeamCharterDialog.tsx`**:
  - Clean modal opened via a **Team charter** (`team.md`) button in the group thread header: editable Markdown textarea with 16,384-char counter, live refresh on WS `team_charter_changed`, Save & Cancel buttons.
- **`Sidebar.tsx` / `ComputerPanel.tsx` / `Thread.tsx` / `App.tsx`**:
  - Sidebar preview (`🔀 ...`), `panel.trigger.pipeline` in Recent Actions, WS handling for `dispatch_plan_changed` and `team_charter_changed`.
- **Dark & Light CSS (`web/src/index.css`)** using only semantic CSS variables.
- **`docs/security.md`**: document `team.md` operator-only write boundary, explicit operator **Start pipeline** gate, `origin: 'relay'` step approval discipline, and cross-step `outside-data` taint propagation.
