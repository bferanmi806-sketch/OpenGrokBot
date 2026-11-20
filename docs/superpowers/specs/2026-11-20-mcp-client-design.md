# Standard MCP Client & Approval Gate Integration — Design Spec

- **Date:** 2026-11-20
- **Status:** Draft (Pending Review)
- **Scope:** Phase 2 — Native zero-dependency Model Context Protocol (MCP) client (`stdio` + `Streamable HTTP` with automatic `2024-11-05` HTTP+SSE fallback), local `0600` secret vault (`<data>/mcp-secrets.json`), SQLite schema `v13`, dynamic tool discovery & collision-free naming (`mcp__<serverSlug>__<toolSlug>`), fail-safe read/write classification, `outside-data` taint propagation, gateway-executed frozen write approvals, `mcpServers` JSON batch import, dual-tab management UI (`Apps` / `MCP`), and bilingual (`en` / `zh-CN`) strings.

---

## 1. Goals, Non-Goals & Security Custody Boundary

### Goals
1. **Standard MCP compatibility without dependency bloat:** Implement the MCP JSON-RPC 2.0 client protocol directly on Node 22 primitives (`node:child_process`, native `fetch`, `ReadableStream`) supporting both local **`stdio`** servers (`npx`, `uvx`, binaries) and remote **`Streamable HTTP`** servers (`2025-03-26` / `2025-06-18`) with automatic fallback to **`2024-11-05` HTTP+SSE**.
2. **Default zero-access per-teammate isolation:** Newly configured MCP servers are **invisible to all teammates by default**. A teammate only sees tools from enabled MCP servers explicitly granted to it in `bot_mcp_servers`.
3. **Fail-safe read/write classification & gateway-enforced approval gate:**
   - Every MCP tool defaults to **`write` (approval-gated)** unless explicitly marked `read` by the operator in `toolPolicies` or covered by an operator-enabled `trustReadOnlyHint` server setting (when `annotations.readOnlyHint === true` and `annotations.destructiveHint !== true`).
   - **`read` MCP tools:** Allowed in `watch` routines; return bounded UTF-8 text (`<= 16,000` chars) and mark the active turn with `ruleBlock = 'outside-data'` so untrusted MCP payloads cannot trigger standing approval rules.
   - **`write` MCP tools:** Excluded from `watch` routines; intercepted before reaching the MCP server, persisted as an `ApprovalRow` (`kind: 'other'` — never auto-remembered into standing rules) with frozen `approvals.execution_json` (`kind: 'mcp'`), and executed at most once by the gateway when the operator clicks **Approve**.
4. **Frictionless configuration & dual-tab UI:** Extend `ConnectorsDialog` with top-level **`Apps` / `MCP`** tabs, supporting structured form creation/editing, Claude Desktop / Cursor standard `mcpServers` JSON import, connection test & tool refresh, per-tool `Read / Approval` overrides, and per-teammate toggles in both `ConnectorsDialog` and `ComputerPanel`.

### Non-Goals (Phase 2)
- Acting as an MCP **Server** (exposing OpenSuperBot's own tools to external clients).
- MCP `sampling/createMessage` (server-initiated LLM completions) or `roots/list` host filesystem exposure — client capabilities advertise `{}` so an external MCP server cannot silently burn the operator's LLM tokens or enumerate host directories via protocol callbacks.
- Third-party OAuth broker discovery inside MCP (`/.well-known/oauth-authorization-server` dynamic client registration) — HTTP auth uses operator-supplied `Authorization` / custom headers stored in `<data>/mcp-secrets.json`.
- Running `stdio` MCP subprocesses inside per-bot Docker containers — `stdio` servers are gateway-managed host subprocesses configured exclusively by the human operator.

### Honest Custody & Host Boundary
- **Secrets custody:** All MCP `env` values and HTTP `headers` stay exclusively on the operator's disk in `<data>/mcp-secrets.json` (`0600` POSIX mode + `restrictToOwner()`). No third-party relay sits between OpenSuperBot and an HTTP MCP server; network traffic goes directly to the operator-configured URL.
- **Host execution boundary (`stdio`):** Because a `stdio` MCP server runs as a subprocess of the gateway on the host machine (outside any teammate's `bwrap`/`sandbox-exec` or Docker computer), **only the authenticated human operator** can create, edit, import, or delete MCP servers via `/api/mcp/*`. Models have zero tools or endpoints to add or mutate MCP server definitions. Furthermore, the gateway strips its own sensitive environment variables (`OPENSUPERBOT_*`, LLM API keys, Composio keys, session tokens) before spawning `stdio` children, passing only safe OS baseline variables plus the operator's explicit per-server `env`. Both `ConnectorsDialog` and `docs/security.md` state this boundary plainly.

---

## 2. Architecture & Module Layout

All backend MCP logic lives under `gateway/src/mcp/` in focused, single-purpose modules:

```text
gateway/src/mcp/
  types.ts             # Config, tool snapshot, JSON-RPC 2.0, policy, frozen execution & manager interfaces
  secrets.ts           # <data>/mcp-secrets.json atomic 0600 store + masked key view helpers
  store.ts             # SQLite CRUD for mcp_servers & bot_mcp_servers + unique slug generation
  stdio-transport.ts   # Sanitized child_process spawn, newline-delimited JSON-RPC framing (4 MB cap), stderr ring buffer
  http-transport.ts    # Streamable HTTP (JSON + SSE responses, Mcp-Session-Id) + 2024-11-05 HTTP+SSE fallback & same-origin check
  client.ts            # McpManager connection pool, initialize handshake, tools/list pagination, list_changed refresh, callTool
  tools.ts             # Collision-free mcp__<server>__<tool> builder, read/write policy resolver, taint & frozen execution gate
  api.ts               # Hono routes (/api/mcp/*, /api/bots/:botId/mcp, JSON import parser & validator)
```

Existing files updated:
- `gateway/src/db.ts`: Append migration `v13` (`mcp_servers` and `bot_mcp_servers`).
- `gateway/src/hub.ts`: Add `{ type: 'mcp_changed' }` to `GatewayEvent`.
- `gateway/src/notices.ts`: Reuse `connector_execution` notice or add localized `mcp_execution` notice for failed/uncertain post-approval executions.
- `gateway/src/prompts.ts`: Include granted MCP servers (name, slug, connection status) in the teammate system prompt.
- `gateway/src/tools.ts` & `gateway/src/agent.ts`: Merge granted MCP `ToolDef`s into `buildTools()` (filtering to effective `read` tools when `watch: true`), route `mcp__*` calls to `onMcpTool`, and taint the turn (`ruleBlock = 'outside-data'`) when a read MCP tool runs.
- `gateway/src/server.ts`: Instantiate `McpManager`, mount `/api/mcp/*`, include `mcpServers` in `GET /api/bots/:botId/computer`, dispatch `kind === 'mcp'` frozen payloads inside `settleApproval`, and call `void mcpManager.closeAll()` in `stopAll()`.
- `web/src/types.ts`, `web/src/api.ts`, `web/src/i18n/{GLOSSARY.md,en.ts,zh-CN.ts,describe.ts}`: Typed client methods and bilingual copy.
- `web/src/components/ConnectorsDialog.tsx`, `ComputerPanel.tsx`, `Sidebar.tsx`, `App.tsx`, `index.css`: Dual-tab `Apps` / `MCP` UI, JSON import modal/drawer, tool policy toggles, and per-teammate checkboxes.
- `docs/security.md` & `docs/comparison.md`: Document MCP custody, `stdio` host boundary, taint, and write approval gate.

---

## 3. Data Model & Secret Storage

### 3.1 SQLite Schema Migration `v13` (`gateway/src/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,                         -- 'mcp-' + 8 hex chars
  name TEXT NOT NULL,                          -- Human display name, e.g. 'Filesystem' or 'Linear'
  slug TEXT NOT NULL UNIQUE,                   -- Normalized [a-z0-9_]+ slug, max 24 chars, unique
  transport TEXT NOT NULL,                     -- 'stdio' | 'http'
  enabled INTEGER NOT NULL DEFAULT 1,          -- 1 = enabled, 0 = paused
  command TEXT NOT NULL DEFAULT '',            -- stdio executable, e.g. 'npx'
  args_json TEXT NOT NULL DEFAULT '[]',        -- JSON string[] for stdio args
  cwd TEXT NOT NULL DEFAULT '',                -- Optional working directory for stdio
  url TEXT NOT NULL DEFAULT '',                -- http/https endpoint URL for 'http' transport
  env_keys_json TEXT NOT NULL DEFAULT '[]',    -- Sorted string[] of configured env var names (values in mcp-secrets.json)
  header_keys_json TEXT NOT NULL DEFAULT '[]', -- Sorted string[] of configured HTTP header names (values in mcp-secrets.json)
  trust_read_only_hint INTEGER NOT NULL DEFAULT 0, -- 1 = trust tool.annotations.readOnlyHint when not overridden
  tools_json TEXT NOT NULL DEFAULT '[]',       -- Cached McpDiscoveredTool[] from latest tools/list
  tool_policies_json TEXT NOT NULL DEFAULT '{}', -- Record<rawToolName, 'read' | 'write'> operator overrides
  status TEXT NOT NULL DEFAULT 'disconnected', -- 'disconnected' | 'connected' | 'error'
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);

CREATE TABLE IF NOT EXISTS bot_mcp_servers (
  bot_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, server_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_mcp_servers_server ON bot_mcp_servers(server_id);
```

### 3.2 Local Secret Vault (`gateway/src/mcp/secrets.ts`)
- Stored at `<data>/mcp-secrets.json` (or held in memory when `dataDir === ''` in unit tests) with structure:
  ```json
  {
    "version": 1,
    "servers": {
      "mcp-a1b2c3d4": {
        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." },
        "headers": { "Authorization": "Bearer lin_api_..." }
      }
    }
  }
  ```
- Written atomically (`<path>.<pid>.tmp` → `mode: 0o600` → `restrictToOwner()` → `chmodSync(0o600)` → `renameSync()`).
- **Update semantics (`PATCH /api/mcp/servers/:id`):**
  - Secret maps accept `Record<string, string | null>`:
    - Non-empty string → sets/replaces that key's secret value.
    - `null` or `""` → removes that key.
    - Omitted key → preserves existing stored secret unchanged (so editing `name`, `args`, or `trustReadOnlyHint` in the UI never wipes saved tokens).
- **Read view:** API responses return `envMasked: Record<string, string>` and `headersMasked: Record<string, string>` using `maskKey(value)` — never raw values.
- Deleting a server deletes its entry from `<data>/mcp-secrets.json`.

---

## 4. MCP Wire Protocol & Connection Manager (`gateway/src/mcp/`)

### 4.1 Handshake & Protocol Constants
- Supported protocol version advertised in `initialize`: `"2025-03-26"` (compatible with `2024-11-05` and `2025-06-18` servers; client accepts any valid JSON-RPC `initialize` result containing `protocolVersion` and `capabilities`).
- `initialize` params:
  ```json
  {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": { "name": "OpenSuperBot", "version": "0.6.1" }
  }
  ```
- Immediately after `initialize` resolves, client sends JSON-RPC notification `{ "jsonrpc": "2.0", "method": "notifications/initialized" }`.
- Default timeouts:
  - Handshake (`initialize` + `tools/list`): `20,000 ms`
  - Read `tools/call`: `30,000 ms`
  - Write `tools/call`: `30,000 ms`

### 4.2 `stdio` Transport (`stdio-transport.ts`)
- **Validation:** `command` must be a non-empty string without NUL bytes; `args` must be `string[]` (max 64 args, each `<= 4,096` chars); if `cwd` is non-empty, it must be an existing directory.
- **Environment sanitization:** Build child `env` from an explicit OS allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TEMP`, `TMP`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and on Windows `SYSTEMROOT`, `COMSPEC`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `PATHEXT`, `PROGRAMFILES`), then overlay the operator's per-server `secrets.env`. All `OPENSUPERBOT_*` and unrelated host secrets are excluded.
- **Framing & caps:**
  - Spawn with `shell: false`, `stdio: ['pipe', 'pipe', 'pipe']`, `windowsHide: true`.
  - Parse `stdout` line-by-line (`\n`, trimming optional `\r`). Lines that are not valid JSON objects with `"jsonrpc": "2.0"` are ignored safely (protecting against stray banner lines printed by npm/npx wrappers). If an unterminated line exceeds `4 MB`, abort the transport with a framing error.
  - Capture `stderr` into a bounded `8 KB` UTF-8 tail buffer so handshake/startup errors surface actionable diagnostics (e.g., `command not found` or missing Python package) in `last_error` — after redacting any secret values configured in `secrets.env`.
  - Respond to server-initiated `ping` requests (`{ jsonrpc: '2.0', id, result: {} }`); reject unsupported server→client requests (e.g. `sampling/createMessage`) with JSON-RPC `-32601 Method not found`.
  - Listen for `notifications/tools/list_changed` and trigger an asynchronous `refreshTools(serverId)` update.
- **Teardown:** Close `stdin`, send `SIGTERM`, wait up to `1,500 ms`, then `SIGKILL` if still alive.

### 4.3 `Streamable HTTP` + Legacy `SSE` Fallback (`http-transport.ts`)
- **URL & Header Validation:**
  - `url` must parse via `new URL(url)` with protocol `http:` or `https:` and no embedded `username`/`password`.
  - Custom header names must match RFC token characters (`/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/`), disallowing hop-by-hop/framing overrides (`host`, `content-length`, `transfer-encoding`, `connection`, `accept`, `content-type`, `mcp-session-id`), and header values must not contain `\r` or `\n`.
- **Primary Mode — Streamable HTTP (`2025-03-26`):**
  - Send `POST <url>` with headers:
    - `Content-Type: application/json`
    - `Accept: application/json, text/event-stream`
    - `Mcp-Session-Id: <sessionId>` (if returned by `initialize` response headers)
    - Operator custom headers (`secrets.headers`)
  - Response handling:
    - `202 Accepted` (used for notifications like `notifications/initialized`): consume body and resolve.
    - `Content-Type: application/json`: read bounded body (`<= 4 MB`), parse JSON-RPC response (or batch), resolve matching request `id`.
    - `Content-Type: text/event-stream`: stream SSE events (`data:` lines up to `4 MB` total), dispatch notifications (`notifications/tools/list_changed`), reply to `ping` if needed, and resolve as soon as the JSON-RPC response matching `id` arrives.
  - **Session expiry recovery (reads/discovery only):** If a `tools/list` or **read-only** `tools/call` receives HTTP `404` while holding a `Mcp-Session-Id`, clear the stale session, re-run `initialize` once, and retry the read call. **Never** auto-retry a write `tools/call`.
  - **Disconnect:** If `Mcp-Session-Id` is present, send best-effort `DELETE <url>` with `Mcp-Session-Id` (`3,000 ms` timeout).
- **Automatic Fallback — Legacy HTTP+SSE (`2024-11-05`):**
  - If the initial `POST <url>` for `initialize` fails with HTTP `400`, `404`, or `405` (and did not return a JSON-RPC `initialize` payload), open `GET <url>` with `Accept: text/event-stream` + custom headers.
  - Wait for `event: endpoint` within handshake timeout, resolve `new URL(data.trim(), url)`:
    - **Security check:** Enforce `endpointUrl.origin === baseUrl.origin` and `(http:|https:)`. Reject cross-origin `endpoint` redirects immediately to prevent SSRF/credential leakage of custom `Authorization` headers!
  - Send JSON-RPC `POST` requests to `endpointUrl` (with custom headers) and correlate JSON-RPC responses arriving over the open `GET` SSE stream.

### 4.4 `McpManager` Pool & Tool Discovery (`client.ts`)
- Deduplicates concurrent `connect(serverId)` calls per server via an in-flight promise map.
- `discoverTools(serverId)`:
  - Connects (or reuses healthy connection), loops `tools/list` (`cursor` → `nextCursor`, max 10 pages, max 256 tools per server), normalizes each tool into `McpDiscoveredTool`:
    ```ts
    export type McpDiscoveredTool = {
      name: string              // Raw MCP tool name on server
      description: string       // Truncated to 1,000 chars
      inputSchema: Record<string, unknown> // Normalized JSON Schema { type: 'object', properties, required? }
      readOnlyHint: boolean     // true iff annotations?.readOnlyHint === true && annotations?.destructiveHint !== true
      destructiveHint: boolean  // true iff annotations?.destructiveHint === true
    }
    ```
  - Persists `tools_json`, sets `status = 'connected'`, `last_error = ''`, and broadcasts `{ type: 'mcp_changed' }`.
  - On connection/handshake failure, sets `status = 'error'`, stores sanitized error message in `last_error`, and broadcasts `{ type: 'mcp_changed' }`.
- **Turn-start resilience:** If an enabled, granted server already has cached `tools` in `tools_json`, `startTurn` builds `ToolDef[]` from `tools_json` with zero startup latency and connects lazily only when the model invokes one of its tools. If an enabled, granted server has `tools.length === 0` and `status === 'disconnected'` (never probed yet), `startTurn` performs a best-effort `discoverTools(server.id)` before building tools — swallowing errors into `status = 'error'` so a broken MCP server never crashes or blocks a teammate's turn.
- Whenever a server's config/secrets are edited, paused (`enabled = 0`), or deleted, `McpManager.disconnect(serverId)` tears down any active session immediately.

---

## 5. Dynamic Tool Surface, Read/Write Policy & Approval Gate (`gateway/src/mcp/tools.ts`)

### 5.1 Collision-Free Tool Naming (`<= 64` chars)
Model providers enforce `^[a-zA-Z0-9_-]{1,64}$` on function tool names. Every granted MCP tool is exposed to the LLM as:
`mcp__<serverSlug>__<toolSlug>`
- `serverSlug`: lowercase `[a-z0-9_]+`, max `20` chars (assigned uniquely when server is created).
- `toolSlug`: raw `tool.name` normalized to lowercase `[a-z0-9_]+`.
- If `mcp__${serverSlug}__${toolSlug}` exceeds `64` chars or collides with another normalized tool on the same server, truncate `toolSlug` to `64 - 5 - serverSlug.length - 5` chars and append `_${sha256(tool.name).slice(0, 4)}`.
- Because built-in tools and Phase 1 connector tools never begin with `mcp__`, collisions with core tools are impossible.

### 5.2 Three-Tier Read/Write Policy Resolution
For a server `S` and discovered tool `T`:
```ts
export function effectiveToolMode(server: McpServerRow, tool: McpDiscoveredTool): 'read' | 'write' {
  const override = server.toolPolicies[tool.name]
  if (override === 'read' || override === 'write') return override
  if (server.trustReadOnlyHint && tool.readOnlyHint && !tool.destructiveHint) return 'read'
  return 'write'
}
```
- **Default is `'write'`**: an unknown or unannotated tool from any MCP server is held at the approval gate and hidden from `watch` runs.
- Even when `trustReadOnlyHint` is enabled on a server, a tool that simultaneously sets `destructiveHint: true` stays `'write'` unless the operator explicitly overrides that specific tool to `'read'`.

### 5.3 Read Execution & `outside-data` Taint
- When `watch === true`, `buildMcpTools(grantedServers, { watch: true })` includes **only** tools where `effectiveToolMode(S, T) === 'read'`.
- When the model invokes a `'read'` MCP tool:
  1. Gateway calls `mcpManager.callTool(server.id, tool.name, args, { write: false })`.
  2. MCP `content` blocks are formatted into clean plain text:
     - `{ type: 'text', text }` → `text`
     - `{ type: 'resource', resource: { uri, mimeType, text } }` → `[Resource ${uri}]` + `text` (or binary summary)
     - `{ type: 'image', mimeType }` / `{ type: 'audio', mimeType }` → `[Image (${mimeType}) omitted from text tool output]` (never injecting unvetted external images into vision context)
     - `structuredContent` (if no text blocks) → formatted JSON
     - Truncated at `16,000` characters with `[…truncated]` marker.
  3. **Taint propagation:** Returns `{ text, ok: !result.isError, tainted: true }`. In `gateway/src/agent.ts`, `tainted: true` sets `outsideDataRead = true` (`ctx.ruleBlock = ctx.ruleBlock ?? 'outside-data'`), identical to connector read tools.

### 5.4 Write Interception & Single-Attempt Frozen Execution Gate
- When the model invokes a `'write'` MCP tool:
  1. **Watch defense-in-depth:** If called during a `watch` run, reject immediately without calling the server.
  2. **Freeze payload:** Construct discriminated union payload in `approvals.execution_json`:
     ```ts
     export type FrozenMcpExecution = {
       kind: 'mcp'
       operationId: string
       serverId: string
       serverName: string
       serverSlug: string
       toolName: string        // Raw MCP tool name on server
       exposedToolName: string // mcp__<serverSlug>__<toolSlug>
       args: Record<string, unknown>
     }
     ```
     *(Existing Phase 1 `FrozenExecution` rows without `kind` or with `kind?: 'connector'` continue routing to the connector executor in `server.ts`.)*
  3. **Create Approval (`kind: 'other'`):**
     - `action`: `${server.name} · ${tool.name}`
     - `detail`: concise human-readable preview of `args` (`JSON.stringify(args, null, 2)` capped at `1,200` chars, or `(no arguments)` when empty)
     - `kind`: `'other'` (since `'other'` is excluded from `RULEABLE_KINDS`, `canRemember` is `false` — every MCP write asks the operator item-by-item and cannot be turned into a standing blanket rule)
     - `target`: `mcp:${server.slug}/${tool.name}`
  4. Emit `approval_request` chip message (`rememberBlock` populated automatically) and return `Held for your operator's approval (#<id>): <action>. Wait for their decision; do not retry.` to the model.
- **When Operator Clicks Approve (`settleApproval` in `gateway/src/server.ts`):**
  1. Parse `approval.execution_json`; if `parsed.kind === 'mcp'`, verify:
     - `mcp_servers` row still exists and `enabled === 1`
     - `bot_mcp_servers` still grants `serverId` to `approval.bot_id`
     - Current effective mode check: if the server was removed, disabled, or revoked since the chip was created, record `execution_status = 'failed'`, patch chip, post notice, `publishPresence(approval.bot_id)`, and stop.
  2. Execute **at most once** via `safeExecuteMcpWrite(mcpManager, frozen)`:
     - **`succeeded`** (`isError !== true`): `recordApprovalExecution(db, id, 'succeeded', summary)`, patch chip, record action, and wake the teammate (`startTurn`) with bounded result summary (`<= 2,000` chars) so it can report completion.
     - **`failed`** (pre-dispatch error: server failed to spawn/handshake, HTTP 4xx before request dispatch, or MCP returned explicit `isError: true` response): `recordApprovalExecution(db, id, 'failed', error)`, patch chip, record action, post localized notice, `publishPresence`.
     - **`uncertain`** (JSON-RPC `tools/call` request was already written to `stdin` or `fetch` body, then the process crashed, stream aborted, or timed out before a response arrived): **never retry**, `recordApprovalExecution(db, id, 'uncertain', detail)`, patch chip (`⚠ Outcome uncertain — verify before retrying`), post localized notice, `publishPresence`.

---

## 6. HTTP API, `mcpServers` JSON Import & Bilingual UI

### 6.1 Gateway HTTP Routes (`gateway/src/mcp/api.ts`)
All routes sit behind `/api/*` session auth:
- `GET /api/mcp/servers`: Returns `{ servers: McpServerView[], botGrants: Record<botId, string[]> }` (including masked `envMasked` / `headersMasked`, cached `tools` with computed `effectiveMode` + `overrideMode`, and `grantedBotIds`).
- `POST /api/mcp/servers`: Creates a server (`name`, `transport`, `command`/`args`/`cwd`/`env` or `url`/`headers`, `trustReadOnlyHint`, `botIds?`, `connectNow?: boolean`). If `connectNow !== false` and `enabled`, attempts initial `discoverTools` (saving the server even if initial connection errors so the operator can inspect `lastError` and fix credentials without retyping).
- `POST /api/mcp/servers/import`: Accepts `{ json: string, botIds?: string[], trustReadOnlyHint?: boolean }`.
  - Parses either `{ "mcpServers": { "<name>": { ... } } }` (Claude Desktop / Cursor / Windsurf standard) or a flat `{ "<name>": { ... } }` map (up to 20 servers per import).
  - Detects `stdio` (`command` string + optional `args` string[], `env` object, `cwd` string) vs `http` (`url` / `serverUrl` string + optional `headers` object).
  - Creates each server, stores secrets in `<data>/mcp-secrets.json`, attempts discovery in parallel (bounded concurrency), and returns `{ imported: McpServerView[], errors: { name: string; error: string }[] }`.
- `PATCH /api/mcp/servers/:id`: Updates metadata, `enabled`, `trustReadOnlyHint`, `toolPolicies` (`Record<toolName, 'read' | 'write' | 'default'>`), or `env` / `headers` secret patches; disconnects stale session and optionally re-tests.
- `POST /api/mcp/servers/:id/test`: Forces fresh reconnect + `discoverTools(id)` and returns updated `McpServerView`.
- `DELETE /api/mcp/servers/:id`: Disconnects session, deletes DB rows (`mcp_servers` + `bot_mcp_servers`) and secrets, broadcasts `mcp_changed`.
- `PUT /api/mcp/servers/:id/bots` & `PUT /api/bots/:botId/mcp`: Bidirectional per-teammate grant sync, broadcasting `mcp_changed`.
- `GET /api/bots/:botId/computer`: Extended with `mcpServers: BotMcpServerItem[]` alongside `connectors`.

### 6.2 Dual-Tab UI (`ConnectorsDialog.tsx`, `ComputerPanel.tsx`, `Sidebar.tsx`)
- **`Sidebar.tsx`:** Keep the single compact `Connectors` footer button; its status dot (`connectorsAttention`) lights up when any connector account is `expired`/`failed` **or** any enabled MCP server has `status === 'error'`.
- **`ConnectorsDialog.tsx`:**
  - Top tab bar: **`Apps` (`应用`)** | **`MCP` (`MCP 服务`)** (with count badges).
  - **`MCP` Tab:**
    - Custody & host note banner explaining `stdio` runs on the gateway host (operator-only config, gateway env stripped) and HTTP connects directly with local `0600` secret storage.
    - Action buttons: **`+ Add MCP server` (`+ 添加 MCP 服务`)** and **`Import JSON` (`导入 JSON`)**.
    - **Server Cards:** Name, transport badge (`stdio` / `HTTP`), connection status pill (`Connected` / `Error` / `Paused` / `Not tested`), tool count, `Test / Refresh` button, `Enable/Pause` toggle, `Edit`, `Delete`, `Trust readOnlyHint` checkbox, expandable **Tools (`N`)** list where each tool shows its name, description, hint badge, and a compact **`Needs approval` / `Read-only`** selector, plus **Teammate access** checkboxes.
- **`ComputerPanel.tsx`:**
  - Adds a **`MCP servers` (`MCP 服务`)** section right below `Connectors` whenever `mcpServers.length > 0`, letting the operator grant/revoke MCP servers for the currently selected teammate in one click.
- **Bilingual parity (`en.ts` / `zh-CN.ts`):** Strict 1-to-1 key and `{placeholder}` parity verified by `web/src/i18n/i18n.test.tsx`.

---

## 7. Verification & Test Plan

1. **Secrets & Store (`gateway/test/mcp-store.test.ts`):**
   - Migration `v13` idempotency, unique slug generation, default zero grants, cascade cleanup on delete, `<data>/mcp-secrets.json` `0600` file mode, partial secret `PATCH` preservation, and key masking.
2. **Transports & Client Pool (`gateway/test/mcp-transport.test.ts`):**
   - Real local Node `stdio` mock MCP server script testing: `initialize` handshake, `OPENSUPERBOT_*` env stripping + explicit `env` injection, stray non-JSON stdout banner resilience, `tools/list` cursor pagination, `notifications/tools/list_changed` auto-refresh, `tools/call` read/write, stderr secret redaction on startup failure, and clean process termination on `closeAll()`.
   - Local HTTP test server testing: `Streamable HTTP` direct `application/json` response, `Streamable HTTP` `text/event-stream` SSE response, `Mcp-Session-Id` propagation + `404` session re-init on read (and non-retry on write), `2024-11-05` legacy `GET` SSE fallback, and **cross-origin `endpoint` rejection**.
3. **Agent Tools, Policy & Approval Gate (`gateway/test/mcp-agent.test.ts`):**
   - `mcp__<server>__<tool>` naming & `<= 64`-char truncation hash uniqueness.
   - 3-tier read/write resolution (`override` > `trustReadOnlyHint` minus `destructiveHint` > default `write`).
   - `watch` mode exposing only effective `read` tools; `read` call setting `outside-data` taint so standing connector/browser rules are held in the same turn.
   - `write` call held as `ApprovalRow` (`kind: 'other'`, `canRemember === false`), gateway single-attempt execution on `Approve`, revoked/disabled server rejection at approval time, and mid-flight timeout `uncertain` non-replay guarantee.
4. **HTTP API & JSON Import (`gateway/test/mcp-api.test.ts`):**
   - CRUD, Claude/Cursor `mcpServers` JSON batch import (`stdio` + `http`), invalid URL / bad header rejection, secret masking, bidirectional bot grants, and `GET /api/bots/:id/computer` `mcpServers` view.
5. **Frontend & Bilingual Parity (`web/src/components/ConnectorsDialog.test.tsx`, `ComputerPanel.test.tsx`, `i18n.test.tsx`):**
   - Switching between `Apps` and `MCP` tabs, adding/importing an MCP server, toggling per-tool read/write policy, toggling teammate access in `ComputerPanel`, and full `en` / `zh-CN` parity.
