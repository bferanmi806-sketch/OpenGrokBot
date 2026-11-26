# Design Spec: Local iMessage & WhatsApp Channels (`gateway/src/channels/`)

Date: 2026-11-26  
Status: Planned / Design Recorded  
Branch target: `main` (future feature branch)

## 1. Goal & Local-First Premise

Connect **iMessage** and **WhatsApp** to a locally running OpenSuperBot gateway **without requiring a public IP, domain, tunnel, or cloud server**:

- **iMessage (macOS local):** macOS `Messages.app` syncs messages into `~/Library/Messages/chat.db` via Apple Push automatically. The gateway reads `chat.db` read-only with its bundled `better-sqlite3` and sends approved messages through `Messages.app` via argument-safe `osascript`.
- **WhatsApp (local Linked Device):** Like WhatsApp Web / Desktop, the gateway opens an outbound encrypted WebSocket connection (e.g., `@whiskeysockets/baileys`) paired once via QR code in the Connectors modal. A future Meta WhatsApp Cloud API driver can plug into the same adapter interface for business numbers.
- **No inbound ports needed for remote control:** Messages sent from a phone while away travel through Apple / WhatsApp servers to the local Mac running OpenSuperBot (as long as the host Mac stays awake and online; after sleep/wake, cursor catch-up resumes automatically).

---

## 2. Two Strictly Separated Modes

To preserve OpenSuperBot's security boundaries, inbound and outbound messaging is split into two distinct trust modes sharing one underlying transport layer:

### Mode A — External Contact Connector (e.g., Sorter triaging chats)
- Teammates explicitly granted channel access read allowlisted chats/groups, summarize threads, and draft replies.
- **Trust level:** Strictly untrusted (`outside-data`). Any message read or inbound trigger from external contacts taints the turn and disables standing *Always allow…* rules.
- **Outward writes:** Always intercepted by the gateway as a frozen approval (`FrozenExecution`) supporting inline *Edit & Approve*; never auto-sent.

### Mode B — Remote Operator Channel (commanding Chief & approving from phone)
- Only explicitly bound `operatorHandles` (strongly recommended: a dedicated secondary Apple ID or secondary WhatsApp number, or an explicit prefix like `/bot`) can talk to teammates or settle approvals remotely.
- **Guardrails:**
  - Group chats are **never** treated as operator mode (even if the operator posts inside a group alongside others).
  - Remote approvals require explicit approval IDs (e.g. `approve #42` / `批准 #42`, never ambiguous `"ok"`).
  - High-risk security mutations (adding connectors/MCP servers, changing Vault items, widening standing approval rules) remain desktop/web-only by default.

---

## 3. Architecture: `gateway/src/channels/`

Keep persistent bidirectional channels decoupled from request-response OAuth `gateway/src/connectors/`:

- **Unified `ChannelAdapter` interface** (reusable for future Telegram long-polling, Signal, Feishu, etc.):
  - `connect()` / `disconnect()` / `status()` (including QR pairing callback or macOS permission probe)
  - `onMessage(handler)` emitting normalized `InboundMessage` (`channel`, `chatId`, `senderId`, `isFromMe`, `isGroup`, `text`, `attachments`, `timestamp`, `externalId`)
  - `listChats()` / `readMessages(chatId, opts)`
  - `sendMessage({ to, text, replyToId })` (callable only by gateway approval execution or verified Mode B replies)
  - `healthCheck()`
- **Unified model tools** (3 compact tools routed by `channel_id`):
  - Read-only (`WATCH_TOOL_NAMES`, marks turn `outside-data`): `channel_list_chats`, `channel_read_messages`
  - Approval-gated write (`FrozenExecution`, supports *Edit & Approve*, `uncertain` on timeout with zero auto-retry): `channel_send_message`

### Platform Driver Notes

1. **iMessage (`macos_local`, macOS only):**
   - **Read:** `better-sqlite3` (`readonly: true`) on `~/Library/Messages/chat.db`; must decode both `message.text` and macOS Ventura+ binary `typedstream` `attributedBody` blobs. Track `last_rowid` cursor + `fs.watch` on `chat.db-wal` with 2–3s fallback poll.
   - **Permissions UX:** Probe `Full Disk Access` + `Automation → Messages` on load; guide user with direct macOS System Settings deep link when missing.
   - **Send:** `execFile('osascript', ...)` with positional argv parameters (never shell-interpolated strings). Restrict v1 sending to verified existing 1:1 iMessage handles/chats.
   - **Loop prevention:** Ignore `is_from_me` echoes and deduplicate via `channel_dedup`.
2. **WhatsApp (`baileys` local Linked Device, cross-platform; pluggable `cloud_api` later):**
   - **Auth custody:** Store encrypted multi-device auth state in `<data>/channels/whatsapp-auth/` (`0700` dir / `0600` files), outside every bot container, workspace, and sandbox.
   - **Anti-ban & rate guardrails:** Per-message pacing, no bulk broadcast tool, send only to allowlisted contacts or operator-approved recipients.

---

## 4. Security Invariants (Non-Negotiable)

1. **2FA / OTP & security link redaction:** Reuse `mail-sanitize.ts` patterns to replace 4–8 digit OTP codes, bank verification codes, and password-reset / magic-login URLs with `[redacted-otp]` / `[redacted-security-link]` before any message text enters model context.
2. **Two-tier allowlists (zero default exposure):**
   - **Channel contact/chat allowlist:** Unlisted personal/family chats are filtered at the gateway layer and never reach any model.
   - **Per-teammate grants (`bot_channels`):** Zero access by default (`can_read`, `can_send`).
3. **Strict `outside-data` taint & frozen write approvals:** Every external read taints the turn; every outbound `channel_send_message` freezes exact recipient + body in SQLite for explicit approval and never creates broad wildcard rules.
4. **Echo & replay deduplication:** Persist `(channel_id, external_id)` in `channel_dedup` and track outbound message IDs to prevent bot-to-self feedback loops.
5. **Minimal local retention:** Persist only channel config, allowlists, sync cursors, dedup IDs, and audit logs — do not mirror the user's entire chat history into gateway SQLite; fetch attachments only on explicit user action.

---

## 5. Data Model & UI Placement

- **SQLite tables (future migration):**
  - `channel_accounts (id, kind, driver, label, status, config_json, cursor_json, last_error, created_at, updated_at)`
  - `bot_channels (bot_id, channel_id, can_read, can_send, created_at)`
  - `channel_dedup (channel_id, external_id, seen_at)`
- **UI integration:**
  - Add a third tab **Channels (通讯通道)** inside the existing **Connectors** dialog alongside *Apps* and *MCP*:
    - iMessage card (macOS only): permission checks, System Settings deep link, contact allowlist, teammate grants.
    - WhatsApp card: live QR pairing widget, connected phone badge, disconnect/logout, contact allowlist, teammate grants.
    - Collapsible **Remote Control** section for binding `operatorHandles`, default teammate, and mobile approval alerts.
  - Add a **Channel access** grant row inside `ComputerPanel` matching Connectors, MCP, Vault, and Spaces.

---

## 6. Phased Rollout

1. **Phase 1 — Channel Core + macOS iMessage:** `gateway/src/channels/` core, `chat.db` read-only + `attributedBody` decoder, OTP redaction, contact allowlist, `osascript` frozen-approval sending, Connectors *Channels* tab.
2. **Phase 2 — WhatsApp Local Linked Device (`baileys`):** QR pairing UI, `<data>/channels/whatsapp-auth/` storage, auto-reconnect and rate guardrails reusing Phase 1 allowlists, redaction, and approval cards.
3. **Phase 3 — Remote Operator Control & Mobile Approvals:** Operator-handle routing, explicit `#ID` approval settlement (`approve #42` / `discard #42`), quiet hours, and optional Telegram Bot long-polling companion adapter.
