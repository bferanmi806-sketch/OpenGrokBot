# Connectors Framework & Email/Productivity Connectors — Design Spec

- **Date:** 2026-11-19
- **Status:** Draft (Pending Review)
- **Scope:** Phase 1 — Unified `ConnectorDriver` framework, Composio v3.1 backend, 6 catalog apps (`gmail`, `outlook`, `google_calendar`, `outlook_calendar`, `notion`, `slack`), email sanitization, code-enforced deferred execution approvals, per-teammate access grants, and bilingual (`en` / `zh-CN`) management UI. (Phase 2 — Standard MCP Client is scoped separately.)

---

## 1. Goals, Non-Goals & Custody Boundary

### Goals
1. **5-second OAuth onboarding across 6 core apps:** Let the operator connect **Gmail, Outlook, Google Calendar, Outlook Calendar, Notion, and Slack** via one-click browser OAuth without registering custom Google Cloud or Microsoft Entra OAuth applications.
2. **Driver-agnostic domain boundary:** Define a clean `ConnectorDriver` interface and normalized domain tools (`mail_*`, `calendar_*`, `notion_*`, `slack_*`) owned by OpenSuperBot so adding a future `NativeOAuthDriver` requires zero changes to agent tools, approvals, prompts, or UI.
3. **Least-privilege per-teammate blast radius:** Connected accounts are **invisible to all teammates by default**. A teammate only sees tools and accounts explicitly granted to it in `bot_connectors`.
4. **Code-enforced approval gate (Deferred Execution):** Outward-facing connector writes (`mail_send`, `mail_reply`, `mail_archive`, `calendar_create_event`, `calendar_update_event`, `notion_create_page`, `notion_append`, `slack_send_message`) never execute directly during a model tool call unless covered by an eligible standing rule. Instead, the gateway freezes the exact call arguments in SQLite, renders an `ApprovalChip` from those real arguments (reading back actual draft contents when sending a draft), and executes the frozen call directly from the gateway when the operator clicks **Approve** — never relying on the model to re-emit arguments.
5. **Seamless integration with existing `Routine` & `Watch` engine:** Read-only connector tools join `WATCH_TOOL_NAMES` so existing cron and `watch` routines can silently monitor inboxes, calendars, channels, and pages out of the box.

### Non-Goals (Phase 1)
- Standard MCP Client (`stdio` / `Streamable HTTP`) — scheduled for Phase 2.
- Native Google / Microsoft OAuth PKCE client registration or raw IMAP/SMTP driver — interface reserved, not implemented in Phase 1.
- Standalone background inbox poller separate from `routines` / `watch`.
- Arbitrary uncurated Composio raw tool pass-through (`connector_raw_call`).

### Honest Custody Boundary
OpenSuperBot's local model keys and browser profiles stay 100% on the operator's disk. When the operator opts in to the **Composio** connector driver, OAuth refresh/access tokens for connected apps are vaulted by Composio (`backend.composio.dev`), while the operator's Composio API key stays in `<data>/composio-key` (`0600` / Windows owner ACL) on the gateway host and never enters any teammate container, workspace, or model context. Both `ConnectorsDialog` and `docs/security.md` state this boundary explicitly.

---

## 2. Architecture & Module Layout

All new backend connector logic lives under `gateway/src/connectors/` with single-purpose modules:

```text
gateway/src/connectors/
  types.ts             # Catalog types, ConnectorDriver interface, normalized domain payloads & errors
  catalog.ts           # Static metadata & grouping for the 6 supported apps
  keys.ts              # <data>/composio-key (0600 / restrictToOwner) + OPENSUPERBOT_COMPOSIO_API_KEY env lock
  store.ts             # CRUD for connector_accounts & bot_connectors tables
  oauth-pendings.ts    # Bounded in-memory one-time nonce store (15-min TTL, max 32 pending)
  mail-sanitize.ts     # Automated-sender detection, tracking-URL stripping, OTP & magic-link redaction
  composio-driver.ts   # Composio v3.1 HTTP client, AuthConfig lookup/creation, proxy & action adapters
  tools.ts             # Dynamic ToolDef builder per bot's active grants + execution dispatcher
  api.ts               # Hono routes (/api/connectors/*, /api/bots/:id/connectors, /oauth/connector/:nonce)
```

Existing files touched:
- `gateway/src/db.ts`: Append migration `v11` (`connector_accounts`, `bot_connectors`, and deferred-execution columns on `approvals`).
- `gateway/src/approvals.ts`: Helpers to store and read frozen connector write executions and execution outcomes.
- `gateway/src/tools.ts` & `gateway/src/prompts.ts`: Merge active per-bot connector `ToolDef`s into `buildTools()`, add read-only connector tools to `WATCH_TOOL_NAMES`, and list granted accounts concisely in the system prompt.
- `gateway/src/agent.ts`: Track `outsideDataRead` within a turn whenever a connector read tool executes; route connector write tools into the deferred execution approval gate.
- `gateway/src/server.ts` & `gateway/src/hub.ts`: Mount connector routes, execute frozen connector writes inside `/api/approvals/:id/decide` (and bare 👍 approval), and broadcast `{ type: 'connectors_changed' }` over `/ws`.
- `gateway/src/bots.ts`: Delete `bot_connectors` rows when a bot is removed (if applicable) and support initial grants.
- `web/vite.config.ts`: Proxy `'/oauth': 'http://127.0.0.1:4747'` alongside `'/hooks'` in dev mode.
- `web/src/components/ConnectorsDialog.tsx`, `Sidebar.tsx`, `ComputerPanel.tsx`, `ApprovalChip.tsx`, `App.tsx`, `api.ts`, `types.ts`, and `i18n/{en,zh-CN}.ts`.
- `docs/security.md`: Document connector custody, taint rules, OTP redaction, and gateway-executed approvals.

---

## 3. Data Model & Secret Storage

### 3.1 Composio API Key Storage (`gateway/src/connectors/keys.ts`)
- Environment override: `OPENSUPERBOT_COMPOSIO_API_KEY` (when non-empty, stays in memory only, never written to disk, marks key `source: 'env'` and `locked: true`).
- Saved file: `<data>/composio-key`, written atomically via temp-file + `0600` mode + `restrictToOwner()` + `renameSync()`, matching `gateway/src/connections.ts`.
- Base URL: defaults to `https://backend.composio.dev` (overridable via `OPENSUPERBOT_COMPOSIO_BASE` for testing/enterprise self-hosted gateways).
- UI view only exposes `{ set: boolean, masked: string, source: 'env' | 'file' | 'none', locked: boolean }`.

### 3.2 SQLite Schema Migration `v11` (`gateway/src/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS connector_accounts (
  id TEXT PRIMARY KEY,                  -- 'ca-' + 8 hex chars
  app TEXT NOT NULL,                    -- 'gmail' | 'outlook' | 'google_calendar' | 'outlook_calendar' | 'notion' | 'slack'
  driver TEXT NOT NULL DEFAULT 'composio',
  remote_id TEXT NOT NULL,              -- Composio connected_account_id
  auth_config_id TEXT NOT NULL DEFAULT '',
  account_label TEXT NOT NULL DEFAULT '', -- Verified email, calendar summary, workspace name
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'active' | 'expired' | 'failed'
  last_error TEXT NOT NULL DEFAULT '',
  notified_expired INTEGER NOT NULL DEFAULT 0, -- Prevents repeated expiry notices across watch runs
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connector_accounts_app ON connector_accounts(app, status);

CREATE TABLE IF NOT EXISTS bot_connectors (
  bot_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, connector_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_connectors_connector ON bot_connectors(connector_id);

-- Extend approvals for gateway-executed connector writes:
ALTER TABLE approvals ADD COLUMN execution_json TEXT;
ALTER TABLE approvals ADD COLUMN execution_status TEXT; -- NULL | 'succeeded' | 'failed' | 'uncertain'
ALTER TABLE approvals ADD COLUMN execution_detail TEXT;
ALTER TABLE approvals ADD COLUMN operation_id TEXT;
```

*(Migration checks `pragma('table_info(approvals)')` before `ALTER TABLE` so re-runs on partially migrated test DBs remain idempotent, matching `v7` and `v9`.)*

---

## 4. Catalog & OAuth Authorization Lifecycle

### 4.1 Supported Catalog (`gateway/src/connectors/catalog.ts`)

| Group ID | App Key | Composio Toolkit Slug | Auth Scheme | Identity Lookup |
| :--- | :--- | :--- | :--- | :--- |
| `mail_calendar` | `gmail` | `gmail` | `OAUTH2` | `GET /gmail/v1/users/me/profile` → `emailAddress` |
| `mail_calendar` | `outlook` | `outlook` | `OAUTH2` | `GET /v1.0/me` → `mail` or `userPrincipalName` |
| `mail_calendar` | `google_calendar` | `googlecalendar` | `OAUTH2` | `GET /users/me/calendarList/primary` → `summary` / `id` |
| `mail_calendar` | `outlook_calendar` | `outlook` | `OAUTH2` | `GET /v1.0/me` → `mail` or `userPrincipalName` |
| `productivity` | `notion` | `notion` | `OAUTH2` | `GET /v1/users/me` → workspace/bot owner name |
| `messaging` | `slack` | `slack` | `OAUTH2` | `POST /api/auth.test` → `team` + `user` |

*(If identity lookup returns non-200 or omits a label while Composio reports the connection `ACTIVE`, fallback label `<App Name> (<short remote_id>)` is saved so valid connections never fail onboarding due to narrow OAuth scopes.)*

### 4.2 OAuth Handshake & Callback Flow

```text
Operator (Web / Desktop)             Gateway (127.0.0.1:4747)                  Composio API
        │                                       │                                    │
        ├── POST /api/connectors/connect ──────►│ 1. Find or create managed          │
        │   { app: 'gmail', botIds: ['inbox'] } │    AuthConfig for toolkit          ├──► GET/POST /api/v3.1/auth_configs
        │                                       │ 2. Mint 24-byte hex nonce (15m TTL)│
        │                                       │    callback = <self>/oauth/connector/<nonce>
        │                                       │ 3. Create link                     ├──► POST /api/v3.1/connected_accounts/link
        │                                       │ 4. Insert 'pending' row + grants   │
        │◄── { connectorId, redirectUrl } ──────┤                                    │
        │                                       │                                    │
        ├── window.open(redirectUrl) ────────────────────────────────────────────────► (Browser OAuth Consent)
        │   (Desktop opens system browser)      │                                    │
        │                                       │◄── GET /oauth/connector/<nonce> ───┘
        │                                       │ 5. Consume nonce, verify status    ├──► GET /api/v3.1/connected_accounts/:id
        │                                       │ 6. Fetch account_label, mark active│
        │◄── WS { type: 'connectors_changed' } ─┤ 7. Return self-closing HTML page   │
```

- **Reconnect flow (`POST /api/connectors/:id/reconnect`):** Reuses the existing `connector_accounts.id` (preserving all `bot_connectors` grants!), creates a fresh link via Composio, updates `remote_id` & `status = 'pending'` (or swaps `remote_id` upon callback completion so the active token isn't lost if the user cancels the browser tab!), and marks `notified_expired = 0` on success.
  - *Exact Reconnect Rule:* Pending reconnect stores `candidateRemoteId` on the in-memory `nonce` entry rather than overwriting `connector_accounts.remote_id` prematurely. Only when `GET /oauth/connector/:nonce` confirms `ACTIVE` does `store` atomically update `remote_id`, `account_label`, `status = 'active'`, `last_error = ''`, `notified_expired = 0`, and best-effort revoke the old `remote_id` upstream.

---

## 5. Domain Tools & Multi-Account Routing

### 5.1 Tool Inventory (16 Tools)

Tools are grouped by capability domain:
- **Mail domain** (enabled if bot has ≥1 `active` `gmail` or `outlook` account):
  1. `mail_list` (**read-only**): `{ account?, folder?: 'inbox' | 'sent' | 'all', unread?: boolean, query?: string, includeAutomated?: boolean, limit?: number, cursor?: string }`
  2. `mail_read` (**read-only**): `{ account?, messageId?: string, threadId?: string, draftId?: string }` (exactly one selector required; never flips unread state)
  3. `mail_draft` (**draft-write**, unheld): `{ account?, draftId?: string, to: string[], cc?: string[], bcc?: string[], subject: string, body: string }` (creates or updates an unsent draft in the provider's Drafts folder; omitted in `watch` mode)
  4. `mail_send` (**gated write**, `kind: 'email'`): `{ account?, draftId?: string, to?: string[], cc?: string[], bcc?: string[], subject?: string, body?: string }` (either `draftId` OR `to + subject + body`)
  5. `mail_reply` (**gated write**, `kind: 'email'`): `{ account?, messageId: string, body: string, replyAll?: boolean }`
  6. `mail_archive` (**gated write**, `kind: 'other'`): `{ account?, messageId: string }`
- **Calendar domain** (enabled if bot has ≥1 `active` `google_calendar` or `outlook_calendar` account):
  7. `calendar_list` (**read-only**): `{ account?, start: string, end: string, query?: string, limit?: number }` (ISO 8601 timestamps)
  8. `calendar_create_event` (**gated write**, `kind: 'booking'`): `{ account?, title: string, start: string, end: string, attendees?: string[], location?: string, description?: string }`
  9. `calendar_update_event` (**gated write**, `kind: 'booking'`): `{ account?, eventId: string, title?: string, start?: string, end?: string, attendees?: string[], location?: string, description?: string }`
- **Notion domain** (enabled if bot has ≥1 `active` `notion` account):
  10. `notion_search` (**read-only**): `{ account?, query: string, limit?: number }`
  11. `notion_read_page` (**read-only**): `{ account?, pageId: string }`
  12. `notion_create_page` (**gated write**, `kind: 'post'`): `{ account?, parentPageId: string, title: string, markdown: string }`
  13. `notion_append` (**gated write**, `kind: 'post'`): `{ account?, pageId: string, markdown: string }`
- **Slack domain** (enabled if bot has ≥1 `active` `slack` account):
  14. `slack_list_channels` (**read-only**): `{ account?, limit?: number, cursor?: string }`
  15. `slack_read_messages` (**read-only**): `{ account?, channelId: string, threadTs?: string, limit?: number }`
  16. `slack_send_message` (**gated write**, `kind: 'message'`): `{ account?, channelId: string, text: string, threadTs?: string }`

### 5.2 Multi-Account Resolution Rule
- If the bot has **1 active account** in that domain, `account` is optional in the JSON Schema and automatically resolves to that single account (if `account` is passed anyway, it must match that account's `id` or `account_label`, otherwise rejected).
- If the bot has **≥2 active accounts** in that domain (e.g., `work@acme.com` on Gmail + `me@outlook.com` on Outlook), `account` becomes **required** with `enum: [<id1>, <id2>, ...]` and descriptions showing `ca-xxxx (Gmail · work@acme.com)`. Ambiguous writes never guess an account.

### 5.3 `Watch` Routine & Prompt Integration
- The 7 read-only tools (`mail_list`, `mail_read`, `calendar_list`, `notion_search`, `notion_read_page`, `slack_list_channels`, `slack_read_messages`) are added to `WATCH_TOOL_NAMES` in `gateway/src/tools.ts`.
- In `watch` mode, `hold_for_approval` remains available for surfacing actionable findings, while gated connector write tools and `mail_draft` are excluded from `buildTools({ watch: true })` so a watch run stays strictly look-only.
- `buildSystemPrompt()` adds a compact `Connected accounts:` block listing only the teammate's active granted accounts (`- gmail: alice@gmail.com [id: ca-1a2b3c4d]`).

---

## 6. Email Sanitization & Taint Tracking

### 6.1 Three-Stage Mail Sanitizer (`gateway/src/connectors/mail-sanitize.ts`)
1. **Automated / Bulk Classification (`isAutomatedMail`):**
   - Inspects structural headers (`Auto-Submitted` ≠ `'no'`, `List-Unsubscribe` present, `List-Id` present, `Precedence` in `bulk | list | junk`) and sender local-part (`no-reply`, `noreply`, `do-not-reply`, `notifications`, `notify`, `mailer-daemon`, `postmaster`).
   - `mail_list` marks each summary `{ automated: boolean }` and defaults to `includeAutomated: false` so routine inbox checks focus on human correspondence unless the model explicitly asks for `includeAutomated: true`.
2. **HTML-to-Text & Tracking Parameter Stripping (`cleanMailBody`):**
   - Strips `<script>` / `<style>` blocks, converts block tags to newlines, decodes HTML entities, collapses excessive blank lines, and caps returned body text to `12,000` chars.
   - Rewrites `http(s)://` links to strip known click-tracking parameters (`utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `mkt_tok`, `yclid`, `igshid`, `spm`) and query values longer than 32 chars on tracking domains.
3. **OTP & Account-Recovery Link Redaction (`redactAuthSecrets`):**
   - Redacts URLs whose path or query matches password-reset, magic-login, OAuth-code, or email-verification patterns (`reset-password`, `password_reset`, `magic-link`, `verify-email`, `token=`, `code=`, `otp=`) → `[redacted-security-link]`.
   - When subject or surrounding line matches verification/login/2FA/security-code context, redacts standalone 4–8 digit one-time codes → `[redacted-otp]`.

### 6.2 Turn-Level `outside-data` Taint Enforcement (`gateway/src/agent.ts`)
- Reading external content from any of the 7 connector read tools (`mail_list`, `mail_read`, `calendar_list`, `notion_search`, `notion_read_page`, `slack_list_channels`, `slack_read_messages` — including external calendar invite titles/descriptions) sets `taintedByOutsideData = true` for the remainder of that `runTurn()`.
- Once `taintedByOutsideData` is `true`, `ctx.ruleBlock` becomes `'outside-data'` (even if `deps.origin === 'operator'`). Any subsequent `hold_for_approval` or gated connector write in that turn **cannot** auto-approve via a standing `Always allow…` rule — it always pauses for human confirmation and explains why (`approval.held.outsideData`), matching webhook payload protection in `docs/security.md`.

---

## 7. Code-Enforced Deferred Execution Gate

### 7.1 Intercepting a Connector Write Call
When a teammate calls any of the 8 gated connector write tools:
1. **Authorization & argument check:** Verify `bot_connectors` grant is still present and `connector_accounts.status === 'active'`, and validate all tool arguments. Invalid arguments return a normal tool error to the model immediately without creating an approval.
2. **Real target & detail construction (never model-authored prose):**
   - If `mail_send` is called with `draftId`, the gateway first calls `driver.readMail({ draftId })` to resolve the draft's actual `to`, `cc`, `bcc`, `subject`, and `body`.
   - If `mail_reply` is called with `messageId`, the gateway fetches the original message's `From` / `To` / `Cc` / `Subject` / `threadId` so the approval card displays the exact recipients and subject being replied to.
   - `action`: deterministic one-line title, e.g. `Send email via alice@gmail.com to bob@acme.com` or `Post Slack message to #ops (Acme Slack)`.
   - `detail`: formatted multi-line preview built strictly from the validated parameters (`Account`, `To`, `Cc`, `Bcc`, `Subject`, and body/content truncated at `4,000` chars).
   - `kind` & `target`:
     - `mail_send` / `mail_reply`: `kind = 'email'`. If there is exactly **one** total recipient (`to.length === 1 && !cc?.length && !bcc?.length`), `target = normalizeTarget(to[0])`; if multiple recipients exist, `target = to.join(', ')` (which `destinationReason` automatically blocks from becoming a standing rule!).
     - `slack_send_message`: `kind = 'message'`, `target = normalizeTarget(`${accountLabel}:${channelLabelOrId}`)`.
     - `notion_create_page` / `notion_append`: `kind = 'post'`, `target = normalizeTarget(`notion:${parentOrPageId}`)`.
     - `calendar_create_event` / `calendar_update_event`: `kind = 'booking'`, `target = ''` (bookings never become standing rules).
     - `mail_archive`: `kind = 'other'`, `target = ''`.
3. **Standing rule check vs. Hold:**
   - Mint `operationId = randomUUID()`.
   - Build `FrozenExecution = { version: 1, connectorId, app, accountLabel, tool, args, resolvedDraftSnapshot?, operationId }`.
   - If `rulesAllowed` is true (`origin === 'operator'` and no webhook / connector `outside-data` taint in context) AND `findMatchingRule()` matches `(botId, kind, target)`:
     - Execute `driver.executeWrite(frozen)` immediately!
     - Record an auto-approved `approvals` row (`rule_id`, `execution_json`, `execution_status`, `operation_id`) + `approval_request` chip (showing `byRule`), and return the execution result directly to the model so its turn continues seamlessly.
   - Otherwise:
     - Insert `pending` `approvals` row with `execution_json = JSON.stringify(frozen)` and `operation_id = operationId`.
     - Broadcast `approval_request` chip to the thread.
     - Return to the model: `"Held for operator approval (approval #<id>). Stop here and wait — when your operator approves, the gateway sends this action directly."`

### 7.2 Executing Upon Operator Approval (`/api/approvals/:id/decide` & Bare `👍`)
When `resolveApproval(db, id, 'approve')` succeeds (idempotent `WHERE status = 'pending'`):
- **Case A — Classic browser/workspace approval (`execution_json IS NULL`):** Unchanged! Wakes the bot to perform the approved action.
- **Case B — Frozen connector execution (`execution_json IS NOT NULL`):**
  1. Re-verify that `connector_accounts` row still exists, `status === 'active'`, and `bot_connectors` still grants `(approval.bot_id, frozen.connectorId)`. If revoked or disconnected meanwhile, record `execution_status = 'failed'`, post a clear `Notice` in the thread, and **do not** call the upstream provider.
  2. Call `driver.executeWrite(frozen)` **once** (no automatic retry on network timeout or 5xx!).
  3. **Three deterministic outcomes:**
     - `succeeded`: Update `execution_status = 'succeeded'`, `execution_detail = summary`, record action in `actions` log (`trigger: 'approval'`), broadcast updated approval payload, and enqueue a short notification turn to the teammate (`The operator approved #<id> and the gateway executed ${frozen.tool} (${summary}).`) so the teammate can close out or proceed if there are next steps.
     - `failed` (confirmed upstream rejection, e.g., 400/401/403/404 before effect): Update `execution_status = 'failed'` (if 401/403, also mark connector `'expired'`), post translated error `Notice` to the thread.
     - `uncertain` (network timeout / socket hangup / 502/503/504 where upstream may have delivered the email/message): Update `execution_status = 'uncertain'`, post translated warning `Notice`: *"The request timed out before confirmation; it was NOT retried automatically to prevent sending duplicates. Please check your sent folder / target app."*

---

## 8. Gateway HTTP API Contract

All `/api/*` routes sit behind existing `authMiddleware` (token + same-origin CSRF + `application/json` check):

| Method & Path | Purpose | Request / Response Shape |
| :--- | :--- | :--- |
| `GET /api/connectors` | Snapshot of key state, catalog, accounts, and per-bot grants | `{ key: KeyView, catalog: CatalogApp[], accounts: ConnectorAccountView[], botGrants: Record<string, string[]> }` |
| `PUT /api/connectors/key` | Save, test-and-save, or clear (`""` / `null`) Composio API key | Body `{ apiKey: string \| null }` → validates via `GET /api/v3.1/auth_configs?limit=1` when non-empty; returns updated snapshot |
| `POST /api/connectors/key/test` | Test a candidate or saved Composio API key without saving | Body `{ apiKey?: string }` → `{ ok: boolean, code?: string, detail?: string }` |
| `POST /api/connectors/connect` | Start OAuth flow for an app + initial teammate grants | Body `{ app: AppKey, botIds?: string[] }` → `201 { connectorId, redirectUrl, state: Snapshot }` |
| `POST /api/connectors/:id/reconnect` | Start fresh OAuth flow for an expired/failed account | Body `{}` → `200 { connectorId, redirectUrl }` |
| `POST /api/connectors/:id/refresh` | Manually re-check upstream status & identity label | Body `{}` → `200 Snapshot` |
| `DELETE /api/connectors/:id` | Revoke upstream (best-effort) + delete account & grants | Returns `200 Snapshot` |
| `PUT /api/bots/:botId/connectors` | Replace the set of `connector_id`s granted to one teammate | Body `{ connectorIds: string[] }` → `200 { botId, connectorIds: string[] }` |
| `GET /oauth/connector/:nonce` | Public one-time OAuth return callback (outside `/api/`) | Consumes nonce, activates account, broadcasts `{ type: 'connectors_changed' }`, returns CSP-locked HTML page |

---

## 9. Web UI & Bilingual (`en` / `zh-CN`) Specification

1. **Sidebar Footer (`web/src/components/Sidebar.tsx`):**
   - Add a `Connectors` / `连接器` footer button beside `AI Models` / `AI 模型`, showing a subtle amber dot when any connected account has `status === 'expired' | 'failed'`.
2. **`ConnectorsDialog.tsx`:**
   - **Header & Custody Note:** One honest sentence explaining that connected apps run through the gateway with write actions held for approval (and noting Composio token custody when using Composio).
   - **Composio Key Bar:** Masked key status + `[Change]` / `[Test]` when configured; inline input + `[Test & Save]` when unconfigured; lock badge when `OPENSUPERBOT_COMPOSIO_API_KEY` is set.
   - **Grouped Catalog Grid (`Mail & Calendar`, `Productivity`, `Messaging`):**
     - Each app card lists connected accounts (`account_label`, status pill `Active` / `Authorizing…` / `Needs reconnect`, and which teammates have access).
     - `[+ Connect]` opens an inline teammate-checkbox picker (defaults: none checked, operator ticks e.g. `Sorter`) + `[Authorize in browser]` which calls `POST /api/connectors/connect` and opens `redirectUrl` via `window.open(url, '_blank', 'noopener')`.
     - Expired/failed accounts show `[Reconnect]` and `[Disconnect]`; active accounts show `[Manage access]` (teammate checkboxes) and `[Disconnect]` (with `ConfirmDialog`).
3. **`ComputerPanel.tsx` ("Connectors" section):**
   - When ≥1 connector account exists in the gateway, displays a `Connectors` / `连接器` section in the teammate's right-hand computer panel with per-account toggle switches (`alice@gmail.com (Gmail)`), calling `PUT /api/bots/:botId/connectors`.
4. **`ApprovalChip.tsx`:**
   - Displays optional `executionStatus` (`succeeded` / `failed` / `uncertain`) and `executionDetail` below the resolved outcome so gateway-executed writes clearly report `"Approved · Sent via alice@gmail.com"` or the `"Outcome unconfirmed — not retried"` warning.
5. **i18n Parity:**
   - Every new key added in `web/src/i18n/en.ts` has a 1-to-1 counterpart in `web/src/i18n/zh-CN.ts` with identical `{placeholder}` variables, verified by `i18n.test.tsx`.

---

## 10. Error Handling & Automated Test Matrix

### Error Handling Rules
- **Expired / Revoked OAuth (`401` / `403` / `410` / `EXPIRED`):** Marks `connector_accounts.status = 'expired'`, broadcasts `connectors_changed`, and if `notified_expired === 0`, flips `notified_expired = 1` and posts a translated `Notice` in the active thread prompting reconnection (preventing recurring `watch` runs from spamming identical errors every 15 minutes).
- **Rate Limits (`429`):** Read calls honor `Retry-After` (capped at 5s, max 1 retry); write calls never auto-retry and report rate-limit errors cleanly.
- **Unconfigured / Disconnected State:** If all accounts in a domain become `expired`, those tools are omitted from `buildTools()` and a brief note in the system prompt tells the teammate which account needs reconnection so it can inform the operator instead of hallucinating.

### Automated Test Suite
1. `gateway/src/connectors/keys.test.ts`: `0600` file permissions, env lock precedence, key masking, atomic overwrite/delete.
2. `gateway/src/connectors/mail-sanitize.test.ts`: Automated sender/header classification, HTML-to-text, `utm_*`/`fbclid` link stripping, OTP & password-reset URL redaction without mangling normal numbers/links.
3. `gateway/src/connectors/composio-driver.test.ts`: AuthConfig discovery/creation, OAuth link creation, safe reconnect (preserving active `remote_id` if user abandons browser tab), Gmail/Outlook/Calendar/Notion/Slack normalization against recorded fixture payloads.
4. `gateway/src/connectors/oauth-callback.test.ts`: One-time nonce consumption, TTL expiry, max-32 cap, replay rejection, `/ws` broadcast.
5. `gateway/src/connectors/connector-approvals.test.ts`:
   - Default zero-access isolation (`bot_connectors` empty → zero connector tools in `buildTools()`).
   - Multi-account `account` enum requirement when ≥2 mail accounts are granted.
   - `outside-data` taint: reading `mail_read` in an operator-started turn blocks a standing `Always allow…` rule on a subsequent `mail_send`.
   - Real draft readback when `mail_send({ draftId })` is called.
   - Gateway direct execution on `Approve`, revocation re-check before execution, and `uncertain` timeout handling (guaranteed single HTTP POST attempt).
6. `web/src/components/ConnectorsDialog.test.tsx`, `ComputerPanel.test.tsx`, `ApprovalChip.test.tsx`, and `i18n.test.tsx` / `zh-render.test.tsx`.
