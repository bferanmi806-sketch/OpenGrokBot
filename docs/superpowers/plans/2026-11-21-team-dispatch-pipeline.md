# Phase 8 Implementation Plan: Group Room `team.md` & DAG Dispatch Pipeline

Spec: `docs/superpowers/specs/2026-11-21-team-dispatch-pipeline-design.md`  
Worktree: `/Users/qingmacbookpro/Projects/OpenSuperBot/.superpowers/worktree-phase8`  
Branch: `feat/team-dispatch-pipeline`

## Tasks

### Task 1: Schema v17, Team Charter Store (`team-charter.ts`) & Dispatch Plan DAG Engine (`dispatch-plans.ts`)
- Modify: `gateway/src/db.ts` (Migration `v17` `dispatch_plans` + `dispatch_plan_steps`, extend `MessageKind` with `'dispatch_plan'`)
- Modify: `gateway/src/actions.ts` (extend `ActionTrigger` with `'pipeline'`)
- Modify: `gateway/src/hub.ts` (add `dispatch_plan_changed` and `team_charter_changed` to `GatewayEvent`)
- Create: `gateway/src/team-charter.ts` (Windows-safe `safeThreadDirName`, `readTeamCharter`, `writeTeamCharter`, `MAX_TEAM_CHARTER_CHARS`)
- Create: `gateway/src/dispatch-plans.ts` (`validateDispatchSteps` with Kahn topological sort & cycle rejection, `createDispatchPlanManager` with draft/start/cancel/parallel-branch/downstream-dependency/approval-wait-and-resume/failure-skip/taint-propagation/reconcile-on-startup/stopAll)
- Create: `gateway/test/dispatch-plans.test.ts` (v17 migration, Windows-safe `team.md` read/write/limits, DAG validation & cycle rejection, parallel wave execution, upstream outputs + taint inheritance, waiting-approval pause + approve-resume + discard-fail-skip, cancellation, restart reconciliation, `stopAll`)

### Task 2: `create_dispatch_plan` Tool, `team.md` Prompt Injection & Gateway REST / Approval-Resume Wiring
- Modify: `gateway/src/tools.ts` (`CREATE_DISPATCH_PLAN_TOOL`, `canDispatchPlan`, `isPipelineStep` in `buildTools`)
- Modify: `gateway/src/prompts.ts` (inject `teamCharter` into `groupBriefing`, add concise Chief pipeline-planning guidance when `canDispatchPlan`)
- Modify: `gateway/src/agent.ts` (add `canDispatchPlan`, `isPipelineStep`, `teamCharter`, `onCreateDispatchPlan`, `onApprovalCreated`, `onQuestionCreated`; runtime gate for `create_dispatch_plan`; server-derived `sourceTainted`; `toChatMsg` for `dispatch_plan`)
- Modify: `gateway/src/server.ts` (instantiate `dispatchPlans` + `reconcileStaleDispatchPlans`; pass `teamCharter` in group turns & pipeline steps; pass `onCreateDispatchPlan` ONLY for Chief operator group turns; wire pipeline step runner with `origin: 'relay'`, `priority: 'background'`, `trigger: 'pipeline'`, `isPipelineStep: true`, upstream fenced output + taint; wire `settleApproval` and `POST /api/questions/:id` to call `dispatchPlans.resumeStepAfterWait(...)` after resumed turn completes; mount `GET/PUT /api/threads/:id/team`, `GET /api/threads/:id/dispatch-plans`, `POST /api/dispatch-plans/:id/start`, `POST /api/dispatch-plans/:id/cancel`; include `dispatchPlans.hasActive()` in `isBusy`, `stopAll`, `/api/summary`)

### Task 3: Comprehensive Gateway Integration Tests (`dispatch-server.test.ts`)
- Create: `gateway/test/dispatch-server.test.ts` (end-to-end tests: `team.md` CRUD + prompt injection in group rounds & pipeline steps; Chief creating DAG plan → starts in `draft` without running; operator clicking `POST /api/dispatch-plans/:id/start` → parallel Stage 1 bots run concurrently, Stage 2 receives Stage 1 fenced outputs + propagates taint; non-Chief & DM & non-operator refused from calling `create_dispatch_plan`; approval hold pauses downstream step, approving resumes & unblocks downstream, discarding fails step & skips downstream; cancelling running plan aborts active step; startup reconciliation preserves draft & paused plans while cancelling running ones)

### Task 4: Web Types, API, Bilingual i18n, `DispatchPlanChip`, `TeamCharterDialog`, CSS, Tests & Docs
- Modify: `web/src/types.ts`, `web/src/api.ts`, `web/src/i18n/en.ts`, `web/src/i18n/zh-CN.ts`, `web/src/i18n/GLOSSARY.md`
- Create: `web/src/components/DispatchPlanChip.tsx` & `web/src/components/DispatchPlanChip.test.tsx`
- Create: `web/src/components/TeamCharterDialog.tsx` & `web/src/components/TeamCharterDialog.test.tsx`
- Modify: `web/src/components/Thread.tsx`, `web/src/components/Sidebar.tsx`, `web/src/components/ComputerPanel.tsx`, `web/src/App.tsx`, `web/src/index.css`
- Modify: `web/src/components/Sidebar.test.tsx`, `web/src/components/Thread.test.tsx`, `web/src/components/ComputerPanel.test.tsx`, `web/src/App.test.tsx`, `web/src/i18n/i18n.test.tsx`
- Modify: `docs/security.md`
- Final Whole-Branch Review & Merge to `main`.
