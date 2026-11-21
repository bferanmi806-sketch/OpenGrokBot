# Phase 3 Design: Inline Editable Approval Card ("Edit & Approve")

**Date:** 2026-11-20  
**Status:** Proposed  
**Branch:** `feat/editable-approvals`  
**Scope:** Allow operators to edit held drafts and arguments directly inside `ApprovalChip` before approving, covering App Connectors (`mail_send`, `mail_reply`, `slack_send_message`, `notion_create_page`, `notion_append`, `calendar_create_event`, `calendar_update_event`), MCP write tools, and prompt-convention `hold_for_approval` actions, with atomic server-side validation, TOCTOU-safe draft updates, re-evaluated standing-rule safety, and full audit trail.

---

## 1. Goals & Non-Goals

### Goals
1. **Zero-round-trip draft refinement:** Operators can fix typos, tweak recipients/subjects/body text, adjust calendar fields, edit MCP arguments, or refine a prompt-held action draft directly inside the pending `ApprovalChip` and execute once with **Approve edited** — without discarding and re-prompting the teammate.
2. **Full-coverage layered editing:**
   - **App Connectors (`kind: 'connector'`):** Dedicated structured forms for email (`mail_send`, `mail_reply`), Slack (`slack_send_message`), Notion (`notion_create_page`, `notion_append`), and Calendar (`calendar_create_event`, `calendar_update_event`). `mail_archive` (ID-only) remains one-click Approve/Discard.
   - **MCP Write Tools (`kind: 'mcp'`):** Structured inputs for top-level primitive properties (`string`, `number`, `integer`, `boolean`) derived from `tool.inputSchema`, plus a validated JSON editor for complex/nested properties or schemaless arguments.
   - **Prompt-Convention Holds (`kind: 'prompt'`):** Editable `action` (one-line summary) and `detail` (full draft text) on non-batch `hold_for_approval` chips, waking the teammate with explicit instructions to carry out the operator's exact edited version.
3. **Atomic validate-before-settle semantics:** Submitting an invalid edit returns HTTP `400` (`code: 'invalid_edit'`) while keeping the approval `pending`, so typos never burn or lock an approval card.
4. **Zero database schema migration:** Reuses existing `approvals` (`action`, `detail`, `target`, `execution_json`) and `messages.payload` JSON columns; completely backwards-compatible with `v0.7.0` (`v13`) SQLite databases and pre-existing pending approvals.
5. **Security & audit invariants preserved:**
   - No secrets or internal IDs (`remoteId`, `connectorId`, `serverId`) are exposed in `payload.editable`.
   - For `mail_send` with `draftId`, edits still enforce the existing TOCTOU snapshot check against the remote draft before updating the draft via `driver.createOrUpdateDraft` and sending it once.
   - Standing rules (`remember`) submitted alongside an `edit` are always re-validated against the **post-edit** `kind` and `target`.
   - Approved-with-edit chips, `approval_resolved` timeline rows, and `actions` logs explicitly record `edited: true` / `(edited by you)`.

### Non-Goals
- **No collaborative CRDT / Yjs canvas:** Keeps OpenSuperBot's single-process SQLite architecture with zero new runtime dependencies.
- **No editing on deterministic workflow approvals (`workflow_run_id !== null`) or batch item approvals (`items !== null`):** Workflow approvals resume an exact recorded browser step index; batch approvals already provide per-item checkboxes.
- **No separate `PATCH /api/approvals/:id` draft-save endpoint:** Edits are submitted atomically with `POST /api/approvals/:id` (and alias `/decide`) when approving.

---

## 2. Data Model & `ApprovalEditable` Contract

### 2.1 Shared Module: `gateway/src/approval-edit.ts`
A single dedicated gateway module owns:
1. Constructing safe `ApprovalEditable` projections from prepared connector writes, MCP write holds, and prompt holds.
2. Validating and applying an incoming `ApprovalEditInput` against an `ApprovalRow` (and optional connector account display context).
3. Recomputing normalized `action`, `detail`, `target`, `execution_json`, and `edited: boolean` (detecting true no-op edits where values are unchanged).

### 2.2 `ApprovalEditable` Projection (Emitted on `approval_request` Payload)
Added as an optional `editable?: ApprovalEditable` property on `approval_request` message payloads (omitted for `workflow_run_id`, batch `items`, `mail_archive`, and pre-approved `rule` chips):

```ts
export type EditableMailSend = {
  kind: 'connector'
  tool: 'mail_send'
  accountLabel: string
  draftId?: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
}

export type EditableMailReply = {
  kind: 'connector'
  tool: 'mail_reply'
  accountLabel: string
  to: string[]
  /** Extra recipients that will be CC'd when replyAll is true */
  replyAllCc: string[]
  subject: string
  body: string
  replyAll: boolean
}

export type EditableSlackMessage = {
  kind: 'connector'
  tool: 'slack_send_message'
  accountLabel: string
  channelId: string
  threadTs?: string
  text: string
}

export type EditableNotionCreatePage = {
  kind: 'connector'
  tool: 'notion_create_page'
  accountLabel: string
  parentPageId: string
  title: string
  markdown: string
}

export type EditableNotionAppend = {
  kind: 'connector'
  tool: 'notion_append'
  accountLabel: string
  pageId: string
  markdown: string
}

export type EditableCalendarCreateEvent = {
  kind: 'connector'
  tool: 'calendar_create_event'
  accountLabel: string
  title: string
  start: string
  end: string
  location: string
  attendees: string[]
  description: string
}

export type EditableCalendarUpdateEvent = {
  kind: 'connector'
  tool: 'calendar_update_event'
  accountLabel: string
  eventId: string
  title?: string
  start?: string
  end?: string
  location?: string
  attendees?: string[]
  description?: string
}

export type EditableMcp = {
  kind: 'mcp'
  serverName: string
  toolName: string
  args: Record<string, unknown>
  /** Compact JSON Schema (omitted if serialized size exceeds 32 KB) */
  inputSchema?: Record<string, unknown>
}

export type EditablePrompt = {
  kind: 'prompt'
  action: string
  detail: string
}

export type ApprovalEditable =
  | EditableMailSend
  | EditableMailReply
  | EditableSlackMessage
  | EditableNotionCreatePage
  | EditableNotionAppend
  | EditableCalendarCreateEvent
  | EditableCalendarUpdateEvent
  | EditableMcp
  | EditablePrompt
```

**Un-truncated draft text:** `ApprovalPayload.detail` continues to truncate long previews at `MAX_DETAIL_BODY_CHARS` (`4,000` chars) for thread scannability, while `payload.editable` stores the full body/markdown/args (bounded at `64,000` chars per text field / `128 KB` JSON for MCP args) so opening **Edit** never silently drops the tail of a long draft.

**Reply metadata on `FrozenExecution`:** `FrozenExecution` gains an optional gateway-internal `replyMeta?: { to: string[]; allCc: string[]; subject: string; threadId?: string }` populated when holding `mail_reply` (mirroring `resolvedDraftSnapshot` on `mail_send`). `prepareConnectorWrite` always computes `allCc` from the original message (`from`, `to`, `cc` excluding `to` and the account's own address) even when `replyAll` is initially `false`, while including `Cc` in `detail` and `target` only when `replyAll === true`. This lets `ApprovalChip` preview exact CC recipients when toggling `Reply all` and lets `applyApprovalEdit` recompute exact `action`, `detail`, `target`, and `canRemember` deterministically with zero extra upstream API calls.

### 2.3 Incoming `ApprovalEditInput` (Request Body of `POST /api/approvals/:id` & `/decide`)

Request body extends the existing shape:

```ts
{
  decision: 'approve' | 'discard',
  remember?: '1h' | '24h' | 'always',
  items?: number[],
  edit?: ApprovalEditInput
}
```

Where `ApprovalEditInput` is a discriminated union matching the approval type:
- **Connector (`kind: 'connector'`):**
  - `tool: 'mail_send'`: `{ to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string }`
  - `tool: 'mail_reply'`: `{ body: string; replyAll?: boolean }`
  - `tool: 'slack_send_message'`: `{ channelId: string; text: string }`
  - `tool: 'notion_create_page'`: `{ title: string; markdown: string }`
  - `tool: 'notion_append'`: `{ markdown: string }`
  - `tool: 'calendar_create_event'`: `{ title: string; start: string; end: string; location?: string; attendees?: string[]; description?: string }`
  - `tool: 'calendar_update_event'`: `{ title?: string; start?: string; end?: string; location?: string; attendees?: string[]; description?: string }` (at least one field must be present)
- **MCP (`kind: 'mcp'`):**
  - `{ kind: 'mcp'; args: Record<string, unknown> }`
- **Prompt (`kind: 'prompt'`):**
  - `{ kind: 'prompt'; action: string; detail: string }`

---

## 3. Gateway Flow, Validation & Security Invariants

### 3.1 Atomic Validate-Before-Settle Ordering in `settleApproval`
Inside `settleApproval(id, decision, remember, keep, edit)` (`gateway/src/server.ts`):
1. Look up `existing = getApproval(db, id)`. Return `'gone'` (`404`) if missing.
2. Check workflow continuation & batch `items` rules.
3. **If `edit !== undefined`:**
   - Reject with `'bad-edit'` (`400`) if `decision !== 'approve'`, `workflowApproval`, `items` (batch), or `existing.status !== 'pending'` (note: check `existing.status !== 'pending'` → `'settled'` `409` first so double-clicking an already-approved edited chip returns `409` idempotently!).
   - Call `applyApprovalEdit(existing, edit)`:
     - Verifies `edit.kind` matches the stored approval (`connector` vs `mcp` vs `prompt`) and for connectors verifies `edit.tool === frozen.tool`.
     - Validates field types, required non-empty fields, email address hygiene (no CR/LF header injection in `to`/`cc`/`bcc`/`subject`), bounded sizes (`<= 64,000` chars per text field, `<= 128 KB` serialized MCP `args`), and prototype-key rejection (`__proto__`, `constructor`, `prototype`) recursively inside MCP `args`.
     - Rejects unknown or read-only/internal field tampering (`connectorId`, `remoteId`, `serverId`, `toolName`, `draftId`, `messageId`, `parentPageId`, `pageId`, `eventId`, `threadTs` cannot be swapped by `edit`).
     - If invalid, returns `{ ok: false, error }` → `settleApproval` returns `{ outcome: 'bad-edit', error }` → HTTP `400` `{ error, code: 'invalid_edit' }` while the approval stays `pending` in SQLite.
     - Computes `nextAction`, `nextDetail`, `nextTarget`, `nextExecutionJson`, `nextEditable`, and `changed: boolean` (if the operator submitted identical values to the original, `changed = false`).
4. **Re-validate `remember` (`Always allow…`):**
   - Check `canRemember({ kind: existing.kind, target: effectiveTarget })` using the **post-edit** `effectiveTarget`. If invalid, return `'unrememberable'` (`400`) **before** marking the row approved.
5. **Atomically persist resolution + edited fields:**
   - `resolveApproval(db, id, decision, patch?)` executes a single conditional `UPDATE approvals SET status = ?, resolved_at = ?, action = ?, detail = ?, target = ?, execution_json = ? WHERE id = ? AND status = 'pending'`. If `changes === 0`, return `'settled'` (`409`).
6. **Broadcast updated chip & audit trail:**
   - `patchChip` updates `action`, `detail`, `target`, `status`, `editable: nextEditable` (or strips/updates it so history shows the final text), and sets `edited: true` when `changed` is `true`.
   - `approval_resolved` message payload includes `edited: true` when `changed` is `true`.
   - `recordAction` appends ` (edited by you)` to the `approval` action-log summary when `changed` is `true`.

### 3.2 `mail_send` with `draftId` When Edited
When `frozen.tool === 'mail_send'` has a `draftId`:
1. **Unchanged (`changed === false`):** Preserves the exact `v0.7.0` behavior — re-read remote draft, verify `draftSnapshotsMatch(frozen.resolvedDraftSnapshot, buildDraftSnapshot(currentMsg))`, then send `draftId`.
2. **Edited (`changed === true`):**
   - `applyApprovalEdit` preserves the original pre-edit snapshot as `draftToctouSnapshot` and returns `draftUpdate: { draftId, to, cc, bcc, subject, body }` alongside the updated `execution_json` (whose `resolvedDraftSnapshot` reflects the operator's final edited draft).
   - `settleApproval` first re-reads the remote draft and verifies `draftSnapshotsMatch(draftToctouSnapshot, buildDraftSnapshot(currentMsg))` (preventing silent overwrite if an external mail client already modified the draft while it was pending!).
   - If the snapshot still matches, `settleApproval` calls `driver.createOrUpdateDraft(currentAcc, draftUpdate)` to update the draft in-place before calling `safeExecuteWrite(driver, { ...frozen, args: { draftId: pendingDraftId } })`.
   - Fix `composio-driver.ts` Outlook `PATCH /v1.0/me/messages/:draftId` so when updating an existing draft (`existingId` present), empty `cc` / `bcc` explicitly sends `ccRecipients: []` / `bccRecipients: []` (clearing prior recipients instead of leaving stale ones on Microsoft Graph).
   - If `createOrUpdateDraft` fails (including `auth_expired`), record `execution_status = 'failed'`, emit `connector_execution` notice, and do **not** send the draft.

### 3.3 Prompt-Hold (`hold_for_approval`) Wake-Up Seed When Edited
When `execution_json === null` and `changed === true`, `settleApproval` wakes the teammate with an unambiguous instruction:

```text
Your operator edited and approved #${approval.id}.
Final action: ${effectiveAction}
Final edited detail:
${effectiveDetail}

Carry out this exact edited version (not your earlier draft) and report what actually happened.
```

When `changed === false`, the existing wake-up string is preserved verbatim.

### 3.4 MCP & Connector Execution Wake-Up Seed When Edited
When `execution_json !== null` and `changed === true`, the gateway executes the updated `frozen` payload directly and wakes the teammate noting `(edited by your operator)` alongside the execution summary so the teammate knows what actually went out.

---

## 4. Frontend Design (`web/`)

### 4.1 API & Types (`web/src/types.ts`, `web/src/api.ts`)
- Mirror `ApprovalEditable` and `ApprovalEditInput` types in `web/src/types.ts`.
- Extend `ApprovalPayload` with `editable?: ApprovalEditable` and `edited?: boolean`.
- Extend `ApprovalResolvedPayload` with `edited?: boolean`.
- Extend `resolveApproval(approvalId, decision, remember?, items?, edit?)` in `web/src/api.ts` to send `edit` in the JSON body when provided, and pass `{ strict: false }` while allowing `400` (`ApiError`) to surface inline validation messages directly inside `ApprovalChip` without closing the edit form.

### 4.2 `ApprovalChip.tsx` Inline Editor UX
- **Collapsed pending state (default):** Unchanged density and visual hierarchy, with a secondary **`Edit`** button placed beside `Approve` and `Discard` whenever `payload.editable` is present and `!outcome` and `!choosing`.
- **Expanded edit state (`editing === true`):**
  - Replaces the static read-only `detail` block with a clean, compact `.approval-editor` form matching the dark zinc surface palette (`web/src/index.css`):
    - **`mail_send`:** `To` (comma/newline-separated addresses), `Cc`, `Bcc` (collapsible or compact row), `Subject`, multi-line `Body` `<textarea>`.
    - **`mail_reply`:** Read-only `To` & `Subject` summary line, `Reply all` checkbox (dynamically showing `replyAllCc` when checked), multi-line `Body` `<textarea>`.
    - **`slack_send_message`:** `Channel` text input (with optional read-only thread timestamp hint) and `Message` `<textarea>`.
    - **`notion_create_page` / `notion_append`:** `Title` input (create only) and `Markdown` `<textarea>`.
    - **`calendar_create_event` / `calendar_update_event`:** `Title`, `Start`, `End`, `Location`, `Attendees` (comma-separated), `Description` `<textarea>`.
    - **`mcp`:** Renders labelled inputs for top-level `string`, `number`/`integer`, and `boolean` schema properties when `inputSchema.properties` is present and every key in `args` fits cleanly (with a toggle to switch to **Raw JSON** mode at any time); otherwise defaults to a monospace **JSON** `<textarea>` with live parse validation.
    - **`prompt`:** `Action` single-line input + `Details` `<textarea>`.
  - **Action bar while editing:**
    - Primary button: **`Approve edited`** (or **`Approve`** when unchanged), disabled while `busy` or while client-side required/JSON validation fails.
    - Secondary buttons: **`Reset`** (restores initial `payload.editable` values, disabled if untouched) and **`Cancel`** (exits edit mode without modifying state).
    - Inline error banner (`.approval-edit-error`) showing client-side validation issues or server `400` `ApiError` text without losing user edits.
  - Note: While `editing === true`, `Always allow…` is hidden so operators explicitly review edited sends one at a time.
- **Resolved state (`outcome` present):**
  - Displays the updated final `action`, `detail`, and `scope`.
  - When `payload.edited === true`, appends a subtle **`Edited by you` / `你已修改`** badge on the outcome line (`Approved · Edited by you` / `已批准 · 你已修改`).
- **i18n (`web/src/i18n/en.ts`, `web/src/i18n/zh-CN.ts`, `GLOSSARY.md`):**
  - Complete English and Simplified Chinese copy for all edit button labels, field labels, validation messages, and resolved-with-edit badges.

---

## 5. File Map & Module Boundaries

| File | Responsibility |
| :--- | :--- |
| `gateway/src/approval-edit.ts` *(new)* | `ApprovalEditable`, `ApprovalEditInput`, projection builders, strict validators, `applyApprovalEdit`, MCP schema compaction, no-op diff detection. |
| `gateway/src/approvals.ts` | Extend `resolveApproval` to accept optional atomic `{ action, detail, target, executionJson }` patch inside the `WHERE status = 'pending'` update. |
| `gateway/src/connectors/types.ts` | Add optional `replyMeta` to `FrozenExecution`. |
| `gateway/src/connectors/composio-driver.ts` | Ensure Outlook `createOrUpdateDraft` clears `ccRecipients` / `bccRecipients` when explicitly emptied on an existing draft. |
| `gateway/src/connectors/tools.ts` | Attach `replyMeta` on `mail_reply` frozen execution and `editable` projection on held connector `approval_request` payloads. |
| `gateway/src/mcp/tools.ts` | Attach `editable` projection (`kind: 'mcp'` with args + bounded `inputSchema`) on held MCP `approval_request` payloads. |
| `gateway/src/agent.ts` | Attach `editable` projection (`kind: 'prompt'`) on non-batch `hold_for_approval` `approval_request` payloads. |
| `gateway/src/server.ts` | Accept `edit` in `POST /api/approvals/:id` & `/decide`, validate before settle in `settleApproval`, update remote draft in-place when `draftId` mail is edited, re-check `canRemember` against edited target, broadcast `edited: true`, and pass edited prompt wake-up seed. |
| `web/src/types.ts` & `web/src/api.ts` | Mirror `ApprovalEditable` / `ApprovalEditInput`, add `edited?: boolean`, thread `edit` through `resolveApproval`. |
| `web/src/components/ApprovalChip.tsx`, `Thread.tsx`, `App.tsx`, `index.css` | Inline edit UI, validation, error banner, `edited` resolved badge, and `onDecide` wiring. |
| `web/src/i18n/en.ts`, `zh-CN.ts`, `GLOSSARY.md` | Full bilingual strings for Phase 3 approval editing. |
| `gateway/test/approval-edit.test.ts` *(new)* | Unit tests for every connector tool edit, MCP arg edit, prompt edit, header injection rejection, size bounds, prototype-key rejection, and no-op detection. |
| `gateway/test/connectors-agent.test.ts`, `mcp-agent.test.ts`, `server.test.ts` | Integration tests for `POST /api/approvals/:id/decide` with `edit`, `draftId` TOCTOU + in-place update, Outlook CC clearing, `remember` re-evaluation, and prompt wake-up seed. |
| `web/src/components/ApprovalChip.test.tsx`, `web/src/i18n/i18n.test.tsx` | Component interaction tests for mail, Slack, Notion, calendar, MCP (form + raw JSON), prompt editing, error display, and bilingual parity. |

---

## 6. Testing & Verification Strategy
1. **Unit tests (`gateway/test/approval-edit.test.ts`):** Every editable connector tool, MCP args (valid, malformed, oversized, `__proto__`), prompt edit, CR/LF email header rejection, immutable field protection, and no-op `changed: false` detection.
2. **Gateway integration tests:**
   - Edited `mail_send` (inline and `draftId` with TOCTOU verification + `createOrUpdateDraft` + Outlook CC clear) executes with edited recipients/subject/body and logs `(edited by you)`.
   - Edited `mail_send` changing a single recipient to multiple recipients with `remember: '1h'` fails `400` and leaves approval `pending`.
   - Edited `mail_reply` toggling `replyAll` updates target, `Cc`, and passes `replyAll` to `executeWrite`.
   - Edited `slack_send_message`, `notion_create_page`, `notion_append`, `calendar_create_event`, `calendar_update_event` execute updated args.
   - Edited MCP write executes updated `args` via `McpManager.callTool` with `write: true`.
   - Edited prompt `hold_for_approval` wakes teammate with the exact edited text.
   - Invalid `edit` returns `400` (`code: 'invalid_edit'`) while leaving the approval `pending` so a subsequent valid approval succeeds.
3. **Web tests (`ApprovalChip.test.tsx`, `i18n.test.tsx`):** Opening/resetting/cancelling editor, submitting edited forms across connector/MCP/prompt variants, displaying inline validation & server errors without losing edits, rendering `Approved · Edited by you`, and full `en`/`zh-CN` key coverage.
4. **Full suite verification:** `pnpm typecheck`, full `gateway` / `web` / `desktop` test suites, and `pnpm build`.
