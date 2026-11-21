# Phase 3 Implementation Plan: Inline Editable Approval Card ("Edit & Approve")

**Spec:** `docs/superpowers/specs/2026-11-20-editable-approvals-design.md`  
**Branch:** `feat/editable-approvals`  
**Goal:** Enable operators to edit pending App Connector writes, MCP write tool arguments, and prompt-convention `hold_for_approval` drafts directly inside `ApprovalChip` before approving, with atomic server-side validation, TOCTOU-safe remote draft updates, post-edit standing-rule re-evaluation, and full audit trail.

---

## Workspace Rules & Verification Commands

- Never use `rg` (use `git grep` or `find`).
- Never run bare `pnpm test` via tool sandbox; always run per-package vitest commands with `--`:
  - `pnpm --filter @opensuperbot/gateway test -- test/approval-edit.test.ts`
  - `pnpm --filter @opensuperbot/web test -- src/components/ApprovalChip.test.tsx`
  - `pnpm --filter @opensuperbot/desktop test -- test/ipc.test.ts`
  - `pnpm typecheck`
  - `pnpm build`

---

## Task 1: Core Approval-Edit Engine & Atomic `resolveApproval` Patching

**Files:**
- Create `gateway/src/approval-edit.ts`
- Modify `gateway/src/approvals.ts`
- Modify `gateway/src/connectors/types.ts`
- Create `gateway/test/approval-edit.test.ts`

### Steps
1. **`gateway/src/connectors/types.ts`:** Add optional `MailReplyMeta` (`{ to: string[]; allCc: string[]; subject: string; threadId?: string }`) and `replyMeta?: MailReplyMeta` on `FrozenExecution`.
2. **`gateway/src/approvals.ts`:**
   - Extend `resolveApproval(db, id, decision, patch?)` where optional `patch?: { action?: string; detail?: string; target?: string; executionJson?: string }` updates those columns in the same conditional `UPDATE approvals SET ... WHERE id = ? AND status = 'pending'` statement.
   - Keep backwards compatibility when `patch` is omitted.
3. **`gateway/src/approval-edit.ts`:**
   - Export types `ApprovalEditable`, `ApprovalEditInput`, `AppliedApprovalEdit`, `DraftUpdateRequest`, and size constants (`MAX_EDIT_TEXT_CHARS = 64_000`, `MAX_EDIT_ACTION_CHARS = 500`, `MAX_MCP_ARGS_BYTES = 128_000`, `MAX_EDITABLE_SCHEMA_BYTES = 32_768`, `MAX_DETAIL_BODY_CHARS = 4_000`).
   - Export projection builders:
     - `buildConnectorEditable(frozen: FrozenExecution): ApprovalEditable | undefined` (covers `mail_send`, `mail_reply`, `slack_send_message`, `notion_create_page`, `notion_append`, `calendar_create_event`, `calendar_update_event`; returns `undefined` for `mail_archive`).
     - `buildMcpEditable(frozen: FrozenMcpExecution, inputSchema?: Record<string, unknown>): EditableMcp` (compacts/omits `inputSchema` if `JSON.stringify(inputSchema).length > 32_768`).
     - `buildPromptEditable(action: string, detail: string): EditablePrompt`.
   - Export `applyApprovalEdit(approval: ApprovalRow, rawEdit: unknown): { ok: true; applied: AppliedApprovalEdit } | { ok: false; error: string }`:
     - Validates `rawEdit` shape and ensures `kind` matches `approval.execution_json` (`connector` vs `mcp` vs `prompt`) and `tool` matches `frozen.tool`.
     - Rejects CR/LF characters (`[\r\n]`) in email addresses (`to`, `cc`, `bcc`) and `subject` (header-injection guard), rejects empty required fields, enforces length limits, and recursively rejects `__proto__`, `constructor`, `prototype` keys and oversized JSON (`> 128 KB`) in MCP `args`.
     - For `mail_send` with `draftId`: returns `draftToctouSnapshot` (the pre-edit `frozen.resolvedDraftSnapshot`), `draftUpdate` (`{ draftId, to, cc, bcc, subject, body }`), and updates `resolvedDraftSnapshot` inside `nextExecutionJson` while keeping `args: { draftId }`.
     - For `mail_reply`: uses `frozen.replyMeta` to recompute exact `To`, `Cc`, `action`, `detail`, and `target` when `replyAll` or `body` changes.
     - For `calendar_update_event`: ensures at least one update field remains populated alongside `eventId`.
     - Computes accurate `changed: boolean` (true no-op edit returns `changed: false`).
4. **Tests (`gateway/test/approval-edit.test.ts`):**
   - Unit tests for all 7 editable connector tools, `mail_archive` non-editable rejection, `draftId` snapshot & update separation, `mail_reply` `replyAll` toggle target recomputation, `calendar_update_event` empty-patch rejection, MCP valid/oversized/`__proto__`/non-object rejection, prompt edit, CR/LF email header rejection, and no-op `changed: false` detection.
   - Run `pnpm typecheck` and `pnpm --filter @opensuperbot/gateway test -- test/approval-edit.test.ts`.
   - Commit on `feat/editable-approvals`.

---

## Task 2: Gateway Emitters, Outlook Draft Clear Fix & `settleApproval` Integration

**Files:**
- Modify `gateway/src/connectors/composio-driver.ts`
- Modify `gateway/src/connectors/tools.ts`
- Modify `gateway/src/mcp/tools.ts`
- Modify `gateway/src/agent.ts`
- Modify `gateway/src/server.ts`
- Modify `gateway/test/connectors-agent.test.ts`
- Modify `gateway/test/mcp-agent.test.ts`
- Modify `gateway/test/server.test.ts`

### Steps
1. **`gateway/src/connectors/composio-driver.ts`:**
   - In `createOrUpdateDraft` (`app === 'outlook'`), when `existingId` is present and `input.cc !== undefined` (or `input.bcc !== undefined`), always include `ccRecipients: toGraphRecipients(input.cc)` / `bccRecipients: toGraphRecipients(input.bcc)` even when empty `[]`, so clearing CC/BCC on an edited Outlook draft actually clears them on Microsoft Graph.
2. **`gateway/src/connectors/tools.ts`:**
   - In `prepareConnectorWrite` (`mail_reply`), always compute `allCc` from `orig` (even when `replyAll === false`) and return `replyMeta: { to, allCc, subject, ...(orig.threadId ? { threadId: orig.threadId } : {}) }`, attaching it onto `FrozenExecution`.
   - Attach `editable: buildConnectorEditable(frozen)` onto pending connector `approval_request` message payloads (when defined).
3. **`gateway/src/mcp/tools.ts`:**
   - Attach `editable: buildMcpEditable(frozen, tool.inputSchema)` onto pending MCP `approval_request` message payloads.
4. **`gateway/src/agent.ts`:**
   - Attach `editable: buildPromptEditable(action, detail)` onto pending non-batch `hold_for_approval` `approval_request` message payloads (omitted when `rule` pre-approves or `items` batch is present).
5. **`gateway/src/server.ts`:**
   - Update `POST /api/approvals/:id` and `/api/approvals/:id/decide` (`decideApproval`) to parse optional `edit` from JSON body and map `bad-edit` → HTTP `400` `{ error, code: 'invalid_edit' }`.
   - Update `settleApproval(id, decision, remember, keep, edit)`:
     - Check `existing.status !== 'pending'` → `'settled'` (`409`) before edit validation so repeated clicks stay idempotent `409`.
     - Validate `edit` via `applyApprovalEdit(existing, edit)` **before** calling `resolveApproval` (rejecting edits on `discard`, `workflowApproval`, or batch `items`).
     - Re-evaluate `canRemember({ kind: existing.kind, target: effectiveTarget })` against the **post-edit** `effectiveTarget` (before `resolveApproval`).
     - Pass edited `{ action, detail, target, executionJson }` into atomic `resolveApproval(db, id, decision, patch)`.
     - Patch chip payload with updated `action`, `detail`, `target`, `editable`, and `...(edited ? { edited: true } : {})`; add `...(edited ? { edited: true } : {})` to `approval_resolved` payload; append ` (edited by you)` to `recordAction` summary.
     - For `mail_send` with `draftId`: when `applied.draftUpdate` is present, verify `draftToctouSnapshot` against `readMail({ draftId })`, then call `connectorDriver.createOrUpdateDraft(currentAcc, applied.draftUpdate)` (handling `auth_expired` and errors cleanly without sending if update fails), and then call `safeExecuteWrite` for `{ draftId }`.
     - For prompt holds (`execution_json === null`) with `edited === true`: wake the bot with explicit edited-version instructions (`Carry out this exact edited version (not your earlier draft)...`).
     - For connector/MCP executions with `edited === true`: note `(edited by your operator)` in the post-execution wake-up message.
6. **Tests:**
   - Add integration tests in `gateway/test/connectors-agent.test.ts` (inline `mail_send` edit, `draftId` edit with TOCTOU + `createOrUpdateDraft` + Outlook CC clear, `mail_reply` `replyAll` toggle, `slack_send_message` / `notion_create_page` / `calendar_create_event` edit, invalid edit returning `400` while keeping approval `pending`, edited multi-recipient email rejecting `remember: '1h'` with `400` while staying `pending`).
   - Add integration test in `gateway/test/mcp-agent.test.ts` (editing MCP write args executes updated args, logs `edited`, rejects invalid MCP edit with `400` keeping `pending`).
   - Add integration test in `gateway/test/server.test.ts` (editing `hold_for_approval` `action` & `detail` updates chip + `approval_resolved` with `edited: true` and wakes bot with the edited text; `👍` shortcut continues working unchanged).
   - Run `pnpm typecheck` and `pnpm --filter @opensuperbot/gateway test -- test/connectors-agent.test.ts`.
   - Commit on `feat/editable-approvals`.

---

## Task 3: Web Types, API Client & Bilingual i18n

**Files:**
- Modify `web/src/types.ts`
- Modify `web/src/api.ts`
- Modify `web/src/i18n/GLOSSARY.md`
- Modify `web/src/i18n/en.ts`
- Modify `web/src/i18n/zh-CN.ts`
- Modify `web/src/i18n/i18n.test.tsx`

### Steps
1. **`web/src/types.ts`:**
   - Add `ApprovalEditable` (all 9 variants) and `ApprovalEditInput` matching `gateway/src/approval-edit.ts`.
   - Add `editable?: ApprovalEditable` and `edited?: boolean` to `ApprovalPayload`.
   - Add `edited?: boolean` to `ApprovalResolvedPayload`.
2. **`web/src/api.ts`:**
   - Update `resolveApproval(approvalId, decision, remember?, items?, edit?)` to include `...(edit ? { edit } : {})` in the `POST /api/approvals/${approvalId}` body.
3. **`web/src/i18n/{GLOSSARY.md,en.ts,zh-CN.ts}`:**
   - Add English & Simplified Chinese keys for:
     - Edit action buttons (`approval.edit`, `approval.approveEdited`, `approval.reset`, `approval.editedBadge`, `thread.editedBadge`).
     - Form labels (`approval.edit.to`, `approval.edit.cc`, `approval.edit.bcc`, `approval.edit.subject`, `approval.edit.body`, `approval.edit.replyAll`, `approval.edit.channel`, `approval.edit.thread`, `approval.edit.message`, `approval.edit.title`, `approval.edit.markdown`, `approval.edit.start`, `approval.edit.end`, `approval.edit.location`, `approval.edit.attendees`, `approval.edit.description`, `approval.edit.action`, `approval.edit.detail`, `approval.edit.argsJson`, `approval.edit.formMode`, `approval.edit.jsonMode`).
     - Validation messages (`approval.edit.invalidJson`, `approval.edit.jsonMustBeObject`, `approval.edit.requiredField`, `approval.edit.recipientsHint`, `approval.edit.failed`).
4. **Tests (`web/src/i18n/i18n.test.tsx`):**
   - Assert key/placeholder parity across `en` and `zh-CN` and unit-test `resolveApproval` forwarding `edit` in request body.
   - Run `pnpm typecheck` and `pnpm --filter @opensuperbot/web test -- src/i18n/i18n.test.tsx`.
   - Commit on `feat/editable-approvals`.

---

## Task 4: `ApprovalChip` Inline Editor UI, Error Handling, Styles & Docs

**Files:**
- Modify `web/src/components/ApprovalChip.tsx`
- Modify `web/src/components/Thread.tsx`
- Modify `web/src/App.tsx`
- Modify `web/src/index.css`
- Modify `web/src/components/ApprovalChip.test.tsx`
- Modify `docs/security.md`

### Steps
1. **`web/src/App.tsx` & `web/src/components/Thread.tsx`:**
   - Update `onDecide` signature to `(approvalId, decision, remember?, items?, edit?) => void | Promise<void>`.
   - In `App.tsx`: catch `SignedOut` via `setSignedOut(true)` and re-throw other errors (`ApiError`) when `edit` is present (or always let `ApprovalChip` catch and show errors cleanly) so `400 invalid_edit` errors surface inline inside the open edit form without closing it or losing user input.
   - In `Thread.tsx`: display `· ${t('thread.editedBadge')}` on `approval_resolved` timeline rows when `p.edited === true`.
2. **`web/src/components/ApprovalChip.tsx` & `web/src/index.css`:**
   - Add `Edit` button beside `Approve` / `Discard` when `payload.editable && !outcome && !choosing`.
   - Implement clean sub-editors for each `payload.editable` kind:
     - `mail_send`: `To`, `Cc`, `Bcc`, `Subject`, `Body` `<textarea>`.
     - `mail_reply`: Read-only `To` / `Subject` header, `Reply all` checkbox (showing live `Cc` preview when checked), `Body` `<textarea>`.
     - `slack_send_message`: `Channel` input, optional read-only `Thread` hint, `Message` `<textarea>`.
     - `notion_create_page` / `notion_append`: `Title` (create only) + `Markdown` `<textarea>`.
     - `calendar_create_event` / `calendar_update_event`: `Title`, `Start`, `End`, `Location`, `Attendees`, `Description`.
     - `mcp`: Automatic primitive-property form mode when `inputSchema.properties` covers all top-level keys with `string`/`number`/`integer`/`boolean` types (with a `JSON` / `Form` toggle button), otherwise monospace `JSON` `<textarea>` with live `JSON.parse` plain-object validation.
     - `prompt`: `Action` input + `Detail` `<textarea>`.
   - Track `dirty` state, `Reset` button (restores initial `payload.editable`), `Cancel` button, `Approve edited` / `Approve` primary button, and inline `.approval-edit-error` banner.
   - In resolved state (`outcome`), show `· ${t('approval.editedBadge')}` when `payload.edited === true`.
   - Style `.approval-editor`, `.approval-edit-field`, `.approval-edit-row`, `.approval-edit-error`, and `.approval-edit-mode` cleanly in `web/src/index.css` matching the dark obsidian zinc theme.
3. **Tests (`web/src/components/ApprovalChip.test.tsx`) & Docs (`docs/security.md`):**
   - Add component tests covering: `Edit` button hidden when `editable` absent, `mail_send` edit + reset + cancel + submit, `mail_reply` `replyAll` toggle preview + submit, `slack_send_message` / `notion_create_page` / `calendar_create_event` edits, `mcp` primitive form mode + raw JSON toggle + invalid JSON blocking submit, `prompt` edit, server `ApiError` shown inline while keeping edits intact, and `Approved · Edited by you` badge rendering.
   - Briefly document operator-edited approvals (atomic validation, TOCTOU check on drafts, post-edit rule re-evaluation, audit log) in `docs/security.md`.
   - Run full verification (`pnpm typecheck`, `gateway`, `web`, `desktop` tests, `pnpm build`) and commit on `feat/editable-approvals`.
