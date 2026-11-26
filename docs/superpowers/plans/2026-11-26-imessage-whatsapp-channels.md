# Implementation Plan: Local iMessage & WhatsApp Channels (`gateway/src/channels/`)

Spec: `docs/superpowers/specs/2026-11-26-imessage-whatsapp-channels-design.md`  
Branch: `feat/local-messaging-channels`  
Status: Scheduled (3 Phases)

## Phase 1: Channel Core & macOS iMessage

### Task 1: Schema `v26`, Channel Store, OTP Redaction & Channel Manager
- Modify: `gateway/src/db.ts` (Migration `v26` adding `channel_accounts`, `bot_channels`, `channel_dedup`; add index on `channel_dedup(seen_at)` for bounded pruning)
- Modify: `gateway/src/hub.ts` (add `channel_status_changed` and `channel_qr_updated` to `GatewayEvent`)
- Create: `gateway/src/channels/types.ts` (`ChannelKind`, `ChannelDriver`, `ChannelStatus`, `InboundMessage`, `ChannelChat`, `SendMessageInput`, `ChannelAdapter`, `ChannelConfig`, `BotChannelGrant`)
- Create: `gateway/src/channels/sanitize.ts` (shared 2FA/OTP & password-reset/magic-login link redaction reusing `gateway/src/connectors/mail-sanitize.ts` patterns, returning `[redacted-otp]` / `[redacted-security-link]`)
- Create: `gateway/src/channels/store.ts` (CRUD for `channel_accounts`, `bot_channels` zero-default grants, `channel_dedup` insert-or-ignore & retention pruning, cursor persistence)
- Create: `gateway/src/channels/manager.ts` (adapter lifecycle `startAll`/`stopAll`/`reconnect`, allowlist enforcement before any model sees message content, `is_from_me` echo suppression, dedup guard, outbound send wrapper)
- Create: `gateway/test/channels-core.test.ts` (v26 migration, zero-default `bot_channels`, allowlist filtering, OTP/link redaction on EN/ZH verification SMS/chats, dedup & echo loop prevention)

### Task 2: macOS iMessage Local Driver (`macos_local`)
- Create: `gateway/src/channels/imessage-typedstream.ts` (pure binary decoder for macOS Ventura+ `message.attributedBody` `NSAttributedString` `typedstream` payloads with graceful fallback to `message.text`)
- Create: `gateway/src/channels/imessage.ts` (macOS-only `ChannelAdapter`: read-only `better-sqlite3` on `~/Library/Messages/chat.db`, `last_rowid` cursor + `fs.watch` on `chat.db-wal` with 2–3s fallback poll, Full Disk Access & `Automation → Messages` health probe with macOS System Settings deep link metadata, positional-argv `execFile('osascript', ...)` sender restricted in v1 to verified existing 1:1 iMessage handles/chats)
- Create: `gateway/test/channels-imessage.test.ts` (fixture SQLite `chat.db` with `text` + `attributedBody` blobs, cursor resume across restart, FDA permission-denied error mapping, `osascript` argv injection resistance)

### Task 3: Unified Channel Tools, Frozen Write Approvals, REST API & Connectors **Channels** Tab
- Create: `gateway/src/channels/tools.ts` (`channel_list_chats`, `channel_read_messages` in `WATCH_TOOL_NAMES` marking turn `outside-data`; `channel_send_message` creating a frozen `FrozenExecution` approval with exact recipient + body and *Edit & Approve* support, `uncertain` on timeout with zero auto-retry, no standing wildcard allow rules)
- Create: `gateway/src/channels/api.ts` (REST routes: `GET /api/channels`, `POST /api/channels`, `PATCH /api/channels/:id`, `DELETE /api/channels/:id`, `POST /api/channels/:id/test`, `GET /api/channels/:id/chats`, `GET/PUT /api/bots/:botId/channels`)
- Modify: `gateway/src/tools.ts`, `gateway/src/approval-edit.ts`, `gateway/src/agent.ts`, `gateway/src/server.ts` (expose channel tools only for bots with granted `bot_channels` permissions; mount `channels` API + lifecycle hooks; include channel health in `/api/summary`)
- Create: `gateway/test/channels-server.test.ts` (end-to-end: unauthorized bot cannot see channel tools; `channel_read_messages` taints turn and redacts OTPs; `channel_send_message` freezes recipient/body, supports inline edit-and-approve, blocks unallowlisted recipients)
- Modify: `web/src/types.ts`, `web/src/api.ts`, `web/src/i18n/en.ts`, `web/src/i18n/zh-CN.ts`, `web/src/i18n/GLOSSARY.md`
- Create: `web/src/components/ChannelsTab.tsx` & `web/src/components/ChannelsTab.test.tsx` (third tab inside `ConnectorsDialog` alongside *Apps* and *MCP*; macOS iMessage permission status + System Settings link + contact allowlist + teammate read/send grants)
- Modify: `web/src/components/ConnectorsDialog.tsx`, `web/src/components/ComputerPanel.tsx`, `web/src/App.tsx`, `web/src/index.css` (wire *Channels* tab and per-teammate **Channel access** row in `ComputerPanel`)

## Phase 2: WhatsApp Local Linked Device (`baileys`)

### Task 4: WhatsApp Local Adapter, Auth Custody & QR Pairing UI
- Modify: `gateway/package.json` (add `@whiskeysockets/baileys` + lightweight QR renderer or SVG data output)
- Create: `gateway/src/channels/whatsapp-baileys.ts` (outbound encrypted WebSocket linked-device driver; multi-device auth state stored strictly in `<data>/channels/whatsapp-auth/<channelId>/` with `0700` dir / `0600` files outside every bot workspace/sandbox; QR code event stream via `hub.ts`; exponential reconnect backoff; per-message pacing & anti-ban guardrails with zero bulk-broadcast capability; keep driver interface pluggable for future Meta `whatsapp_cloud_api`)
- Create: `gateway/test/channels-whatsapp.test.ts` (auth directory permission enforcement `0700`/`0600`, QR pairing state transitions, disconnect/logout wiping auth files, rate-limit pacing, allowlist + OTP redaction + frozen send approval reuse)
- Modify: `web/src/components/ChannelsTab.tsx`, `web/src/components/ChannelsTab.test.tsx`, `web/src/i18n/en.ts`, `web/src/i18n/zh-CN.ts` (live QR pairing card, connected phone badge, disconnect/logout button, contact allowlist & teammate grants)

## Phase 3: Remote Operator Control, Mobile Approvals & Telegram Companion

### Task 5: Mode B Operator Router, Explicit `#ID` Approvals & Companion Adapter
- Create: `gateway/src/channels/operator-router.ts` (strict separation between Mode A external contacts and Mode B `operatorHandles`; DM-only enforcement — group chats never elevate to operator mode even when operator speaks; route operator messages to bound default teammate / Chief with optional `@name` or `/bot` prefix; explicit `approve #ID` / `discard #ID` / `批准 #ID` / `拒绝 #ID` parser rejecting ambiguous `"ok"` replies; block high-risk security mutations like adding MCP/connectors, mutating Vault, or widening standing approval rules from remote channels)
- Create: `gateway/src/channels/approval-notifier.ts` (push concise pending-approval alerts with `#ID`, action summary, and reply hint to bound operator channel, respecting Quiet Hours config)
- Create: `gateway/src/channels/telegram.ts` (optional Telegram Bot API long-polling `ChannelAdapter` — zero public webhook needed, ideal low-risk companion for mobile alerts and Mode B operator commands)
- Modify: `gateway/src/channels/manager.ts`, `gateway/src/server.ts` (hook operator router into inbound DMs from `operatorHandles` and approval notifier into `onApprovalCreated`)
- Modify: `web/src/components/ChannelsTab.tsx`, `web/src/i18n/en.ts`, `web/src/i18n/zh-CN.ts` (collapsible **Remote Control** section for `operatorHandles`, default teammate selector, mobile approval push toggle, and Telegram bot token card)
- Create: `gateway/test/channels-operator.test.ts` (group-chat privilege escalation blocked, explicit `#ID` approval settlement vs ambiguous `"ok"` rejection, high-risk config mutation blocked remotely, quiet-hours suppression)
- Modify: `docs/security.md`, `CHANGELOG.md` (document channel threat model, `0700`/`0600` WhatsApp auth custody, Mode A vs Mode B trust boundaries, OTP redaction, and macOS FDA/Automation permissions)

## Verification Before Each Phase Merge
- `pnpm typecheck`
- `pnpm --filter @opensuperbot/gateway test`
- `pnpm --filter @opensuperbot/web test`
- `pnpm --filter @opensuperbot/desktop test`
- `pnpm build`
