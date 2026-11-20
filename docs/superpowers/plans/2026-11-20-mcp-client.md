# Standard MCP Client & Approval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency native Model Context Protocol (MCP) client supporting `stdio` subprocesses and `Streamable HTTP` (with automatic `2024-11-05` HTTP+SSE fallback), local `0600` secret storage (`<data>/mcp-secrets.json`), per-teammate explicit grants, a 3-tier fail-safe read/write policy with `outside-data` taint and gateway-executed frozen write approvals, Claude/Cursor `mcpServers` JSON batch import, and a bilingual (`en` / `zh-CN`) dual-tab (`Apps` / `MCP`) management UI.

**Architecture:** All MCP client logic lives under `gateway/src/mcp/` (`types`, `secrets`, `store`, `stdio-transport`, `http-transport`, `client`, `tools`, `api`). Metadata and cached tool schemas live in SQLite `v13` (`mcp_servers`, `bot_mcp_servers`) while secret `env` and HTTP `headers` live in `<data>/mcp-secrets.json` (`0600` + `restrictToOwner()`). Read-classified MCP tools run directly, are exposed to `watch` routines, and taint the turn (`outside-data`); write-classified MCP tools (the default for all unverified tools) freeze `{ kind: 'mcp', ... }` into `approvals.execution_json` (`kind: 'other'`, never auto-remembered) and execute at most once from the gateway when approved.

**Tech Stack:** Node.js >=22 (`node:child_process`, native `fetch`, `ReadableStream`), TypeScript 7 (`ESM`, `.js` import specifiers in `gateway`), Hono 4, `better-sqlite3` 13, React 19, Vite, Vitest 5, Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-20-mcp-client-design.md`

## Global Constraints

- Node.js `>=22` and `pnpm`; **zero new runtime npm dependencies** in `gateway`, `web`, or `desktop` (do not install `@modelcontextprotocol/sdk` or any other package).
- Gateway TypeScript uses ESM relative imports with `.js` extensions (e.g., `import { ... } from './types.js'`).
- Never use `rg` in shell commands (not installed on this host); use `git grep` or `find`.
- Secret storage: MCP `env` values and HTTP `headers` live exclusively in `<data>/mcp-secrets.json` (`0o600` + `restrictToOwner()` + atomic `renameSync()`, or in-memory map when `dataDir === ''`). SQLite stores only sorted key names (`env_keys_json`, `header_keys_json`), never secret values. API views return only masked values (`maskKey(v)`).
- Default zero-access isolation: MCP servers are invisible to all teammates unless explicitly granted in `bot_mcp_servers`.
- Environment sanitization for `stdio`: child processes receive only safe OS baseline env vars (`PATH`, `HOME`, `USER`, `TMPDIR`, `LANG`, etc.) overlaid with the server's explicit `secrets.env`. Never pass `OPENSUPERBOT_*` or unrelated host env vars to `stdio` children.
- Same-origin protection on legacy HTTP+SSE fallback: when `GET <url>` emits `event: endpoint`, resolve against `<url>` and reject unless `endpointUrl.origin === baseUrl.origin` and protocol is `http:` or `https:`.
- Fail-safe read/write classification: `toolPolicies[tool.name]` override (`'read' | 'write'`) wins; else if `server.trustReadOnlyHint && tool.readOnlyHint && !tool.destructiveHint` → `'read'`; else **`'write'`**.
- Taint & write non-replay: calling any `'read'` MCP tool marks the turn `outside-data`. Calling any `'write'` MCP tool creates an `ApprovalRow` (`kind: 'other'`) with frozen `execution_json` (`kind: 'mcp'`). Post-approval gateway execution never retries once the JSON-RPC write request has been dispatched; mid-flight timeouts/disconnects record `execution_status = 'uncertain'`.
- Every UI string added to `web/src/i18n/en.ts` MUST have a matching key and identical `{placeholder}` names in `web/src/i18n/zh-CN.ts`, following `web/src/i18n/GLOSSARY.md`.

---

## File Map

### Created Files
- `gateway/src/mcp/types.ts` — MCP domain types (`McpTransportKind`, `McpServerStatus`, `McpToolMode`, `McpDiscoveredTool`, `McpServerRow`, `McpServerView`, `FrozenMcpExecution`, `McpWriteExecutionResult`, `McpManager`).
- `gateway/src/mcp/secrets.ts` — Atomic `0600` `<data>/mcp-secrets.json` vault (plus in-memory fallback when `dataDir === ''`), partial `PATCH` merge, removal, masking, and secret redaction helper.
- `gateway/src/mcp/store.ts` — SQLite CRUD for `mcp_servers` & `bot_mcp_servers`, unique `[a-z0-9_]` slug assignment (`<= 20` chars), tool cache updates, and per-bot grant helpers.
- `gateway/src/mcp/stdio-transport.ts` — Sanitized `child_process.spawn` JSON-RPC 2.0 client transport (`4 MB` line cap, `8 KB` redacted `stderr` tail, `ping` reply, `notifications/tools/list_changed`, `SIGTERM` → `SIGKILL` teardown).
- `gateway/src/mcp/http-transport.ts` — `Streamable HTTP` (`POST` JSON & SSE responses, `Mcp-Session-Id` tracking, `DELETE` teardown) + automatic `2024-11-05` HTTP+SSE fallback with same-origin `endpoint` enforcement.
- `gateway/src/mcp/client.ts` — `createMcpManager()` connection pool (`discoverTools`, `ensureDiscovered`, `callTool`, `disconnect`, `closeAll`) with `tools/list` cursor pagination and `list_changed` refresh.
- `gateway/src/mcp/tools.ts` — `mcp__<serverSlug>__<toolSlug>` (`<= 64` chars) builder, `effectiveToolMode`, `runMcpToolCall`, and `safeExecuteMcpWrite`.
- `gateway/src/mcp/api.ts` — Hono routes (`/api/mcp/servers`, `/api/mcp/servers/import`, `/api/mcp/servers/:id`, `/api/mcp/servers/:id/test`, `/api/mcp/servers/:id/bots`, `/api/bots/:botId/mcp`) and `parseMcpServersImportJson`.
- `gateway/test/mcp-store.test.ts` — Unit tests for migration `v13`, store CRUD, unique slugs, zero-default bot grants, and `0600` secret vault.
- `gateway/test/mcp-transport.test.ts` — Integration tests against a real local Node `stdio` mock MCP script and a local `http.createServer` MCP server (JSON, SSE, session 404 recovery, legacy SSE fallback, cross-origin `endpoint` rejection).
- `gateway/test/mcp-api.test.ts` — API tests for CRUD, `mcpServers` JSON batch import, secret masking, test/refresh, bot grants, and `/ws` `mcp_changed` events.
- `gateway/test/mcp-agent.test.ts` — Agent & approval gate tests for `<= 64`-char tool naming, 3-tier read/write policy, `watch` filtering, `outside-data` taint, frozen `kind: 'mcp'` approval execution, revoked/disabled guard, and `uncertain` non-replay.
- `web/src/components/McpTab.tsx` — Dedicated MCP management tab component (custody banner, server cards, add/edit form, `mcpServers` JSON import panel, expandable discovered tools with per-tool `Read-only` / `Needs approval` selector, and teammate access checkboxes).

### Modified Files
- `gateway/src/db.ts` — Append migration `v13` (`mcp_servers`, `bot_mcp_servers`).
- `gateway/src/hub.ts` — Add `| { type: 'mcp_changed' }` to `GatewayEvent`.
- `gateway/src/tools.ts` — Extend `buildTools()` with `mcpTools?: ToolDef[]` and `mcpReadToolNames?: ReadonlySet<string>` so `watch: true` keeps read-classified `mcp__*` tools while blocking write-classified ones.
- `gateway/src/prompts.ts` — Add `PromptMcpServer` and `mcpServers?: PromptMcpServer[]` section to `buildSystemPrompt()`.
- `gateway/src/agent.ts` — Add `mcpServers`, `mcpTools`, `mcpReadToolNames`, `onMcpTool` to `AgentDeps`; permit `mcpReadToolNames` through the `watch` gate; route `isMcpToolName(call.name)` to `onMcpTool`; taint turn when `res.tainted`; summarize `mcp__*` actions cleanly.
- `gateway/src/server.ts` — Instantiate `mcpManager` (or `deps.mcpManager`), mount `/api/mcp/*`, include `mcpServers` in `GET /api/bots/:botId/computer`, wire MCP tools into `startTurn`, handle `parsed.kind === 'mcp'` inside `settleApproval`, and call `void mcpManager.closeAll()` inside `stopAll()`.
- `web/src/types.ts` & `web/src/api.ts` — Add MCP types, `mcp_changed` WS event, `ComputerView.mcpServers`, and `/api/mcp/*` client functions.
- `web/src/i18n/GLOSSARY.md`, `web/src/i18n/en.ts`, `web/src/i18n/zh-CN.ts` — Bilingual `mcp.*` and tab strings.
- `web/src/components/ConnectorsDialog.tsx`, `web/src/components/ComputerPanel.tsx`, `web/src/App.tsx`, `web/src/index.css` — Wire `Apps` / `MCP` tabs, `mcpState` fetching & WS refresh, `connectorsAttention` dot for errored enabled MCP servers, and `ComputerPanel` MCP toggles.
- `web/src/components/ConnectorsDialog.test.tsx`, `web/src/components/ComputerPanel.test.tsx`, `web/src/i18n/i18n.test.tsx` — Component and bilingual parity tests.
- `docs/security.md` & `docs/comparison.md` — Document MCP custody, `stdio` host boundary, `outside-data` taint, and comparison matrix row.

---

### Task 1: SQLite Migration v13, Secret Vault (`<data>/mcp-secrets.json`) & MCP Store

**Files:**
- Create: `gateway/src/mcp/types.ts`
- Create: `gateway/src/mcp/secrets.ts`
- Create: `gateway/src/mcp/store.ts`
- Modify: `gateway/src/db.ts:285-295`
- Modify: `gateway/src/hub.ts:10-18`
- Test: `gateway/test/mcp-store.test.ts`

**Interfaces:**
- Consumes: `Db` from `gateway/src/db.ts`, `restrictToOwner` from `gateway/src/auth.ts`, `maskKey` from `gateway/src/settings.ts`.
- Produces:
  - `McpTransportKind = 'stdio' | 'http'`
  - `McpServerStatus = 'disconnected' | 'connected' | 'error'`
  - `McpToolMode = 'read' | 'write'`
  - `McpDiscoveredTool`, `McpServerRow`, `McpServerSecrets`, `McpSecretVault`, `FrozenMcpExecution`, `McpWriteExecutionResult`, `McpManager`
  - `createMcpSecretVault(dataDir: string)` → `{ get(serverId): McpServerSecrets; patch(serverId, update: { env?: Record<string, string | null>; headers?: Record<string, string | null> }): McpServerSecrets; remove(serverId): void; masked(serverId): { envMasked: Record<string, string>; headersMasked: Record<string, string> }; redactText(serverId, text: string): string }`
  - `normalizeMcpSlug(raw: string): string`
  - `createMcpServer(db, input)`, `updateMcpServer(db, id, patch, now?)`, `getMcpServer(db, id)`, `listMcpServers(db)`, `saveMcpDiscoveredTools(db, id, tools, now?)`, `markMcpServerStatus(db, id, status, lastError?, now?)`, `deleteMcpServer(db, id)`
  - `setBotMcpServers(db, botId, serverIds, now?)`, `setMcpServerBots(db, serverId, botIds, now?)`, `listBotMcpServerIds(db, botId)`, `listAllBotMcpGrants(db)`, `listEnabledBotMcpServers(db, botId)`, `listBotMcpServersAllStatuses(db, botId)`

- [ ] **Step 1: Write the failing test (`gateway/test/mcp-store.test.ts`)**

```ts
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, schemaVersion, upsertBot } from '../src/db.js'
import { createMcpSecretVault } from '../src/mcp/secrets.js'
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listAllBotMcpGrants,
  listEnabledBotMcpServers,
  listMcpServers,
  markMcpServerStatus,
  normalizeMcpSlug,
  saveMcpDiscoveredTools,
  setBotMcpServers,
  setMcpServerBots,
  updateMcpServer,
} from '../src/mcp/store.js'

describe('mcp store & secrets vault', () => {
  it('migrates to v13, deduplicates slugs, and enforces default zero teammate grants', () => {
    const db = openDb(':memory:')
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(13)
    upsertBot(db, { id: 'coder', name: 'Builder', role: 'dev', emoji: '🛠', soul_path: '' })
    upsertBot(db, { id: 'scout', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })

    expect(normalizeMcpSlug('GitHub Enterprise MCP!')).toBe('github_enterprise_mc')

    const s1 = createMcpServer(db, {
      name: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      envKeys: ['GITHUB_TOKEN'],
      now: 1000,
    })
    const s2 = createMcpServer(db, {
      name: 'GitHub',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headerKeys: ['Authorization'],
      trustReadOnlyHint: true,
      now: 1001,
    })

    expect(s1.id).toMatch(/^mcp-[0-9a-f]{8}$/)
    expect(s1.slug).toBe('github')
    expect(s2.slug).toBe('github_2')
    expect(listEnabledBotMcpServers(db, 'coder')).toEqual([])

    setBotMcpServers(db, 'coder', [s1.id, s2.id], 1002)
    expect(listEnabledBotMcpServers(db, 'coder').map((s) => s.id)).toEqual([s1.id, s2.id])
    expect(listEnabledBotMcpServers(db, 'scout')).toEqual([])

    updateMcpServer(db, s1.id, { enabled: false, toolPolicies: { create_issue: 'write', get_issue: 'read' } }, 1003)
    expect(listEnabledBotMcpServers(db, 'coder').map((s) => s.id)).toEqual([s2.id])
    expect(getMcpServer(db, s1.id)?.toolPolicies).toEqual({ create_issue: 'write', get_issue: 'read' })

    saveMcpDiscoveredTools(db, s2.id, [
      {
        name: 'list_issues',
        description: 'List open issues',
        inputSchema: { type: 'object', properties: {} },
        readOnlyHint: true,
        destructiveHint: false,
      },
    ], 1004)
    expect(getMcpServer(db, s2.id)?.status).toBe('connected')
    expect(getMcpServer(db, s2.id)?.tools).toHaveLength(1)

    markMcpServerStatus(db, s2.id, 'error', 'connection refused', 1005)
    expect(getMcpServer(db, s2.id)?.lastError).toBe('connection refused')

    setMcpServerBots(db, s2.id, ['scout'], 1006)
    expect(listAllBotMcpGrants(db)).toEqual({ coder: [s1.id], scout: [s2.id] })

    expect(deleteMcpServer(db, s2.id)).toBe(true)
    expect(listMcpServers(db).map((s) => s.id)).toEqual([s1.id])
    expect(listAllBotMcpGrants(db).scout).toEqual([])
  })

  it('stores secrets in 0600 mcp-secrets.json, preserves omitted keys on patch, masks values, and redacts errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osb-mcp-secrets-'))
    const vault = createMcpSecretVault(dir)

    vault.patch('mcp-11112222', {
      env: { GITHUB_TOKEN: 'ghp_secret_value_123456', EXTRA_KEY: 'extra_secret_9876' },
      headers: { Authorization: 'Bearer lin_api_abcdef123456' },
    })

    const file = join(dir, 'mcp-secrets.json')
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }

    // Partial patch keeps GITHUB_TOKEN, removes EXTRA_KEY, updates Authorization
    vault.patch('mcp-11112222', {
      env: { EXTRA_KEY: null },
      headers: { 'X-Custom': 'custom_token_9999' },
    })

    const reloaded = createMcpSecretVault(dir)
    expect(reloaded.get('mcp-11112222')).toEqual({
      env: { GITHUB_TOKEN: 'ghp_secret_value_123456' },
      headers: {
        Authorization: 'Bearer lin_api_abcdef123456',
        'X-Custom': 'custom_token_9999',
      },
    })

    const masked = reloaded.masked('mcp-11112222')
    expect(masked.envMasked.GITHUB_TOKEN).not.toContain('secret_value')
    expect(masked.headersMasked.Authorization).not.toContain('lin_api_abcdef')

    const dirty = 'Failed with token ghp_secret_value_123456 and Bearer lin_api_abcdef123456'
    expect(reloaded.redactText('mcp-11112222', dirty)).not.toContain('ghp_secret_value_123456')
    expect(reloaded.redactText('mcp-11112222', dirty)).not.toContain('lin_api_abcdef123456')

    reloaded.remove('mcp-11112222')
    expect(reloaded.get('mcp-11112222')).toEqual({ env: {}, headers: {} })
    expect(readFileSync(file, 'utf8')).not.toContain('ghp_secret_value_123456')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opensuperbot/gateway test -- test/mcp-store.test.ts`
Expected: FAIL with module `../src/mcp/secrets.js` / `../src/mcp/store.js` not found.

- [ ] **Step 3: Implement `types.ts`, `secrets.ts`, `store.ts`, migration `v13` in `db.ts`, and `mcp_changed` in `hub.ts`**

Create `gateway/src/mcp/types.ts` defining:
- `McpTransportKind = 'stdio' | 'http'`
- `McpServerStatus = 'disconnected' | 'connected' | 'error'`
- `McpToolMode = 'read' | 'write'`
- `McpDiscoveredTool`: `{ name: string; description: string; inputSchema: Record<string, unknown>; readOnlyHint: boolean; destructiveHint: boolean }`
- `McpServerRow`: `{ id: string; name: string; slug: string; transport: McpTransportKind; enabled: boolean; command: string; args: string[]; cwd: string; url: string; envKeys: string[]; headerKeys: string[]; trustReadOnlyHint: boolean; tools: McpDiscoveredTool[]; toolPolicies: Record<string, McpToolMode>; status: McpServerStatus; lastError: string; createdAt: number; updatedAt: number }`
- `McpServerSecrets = { env: Record<string, string>; headers: Record<string, string> }`
- `McpToolView = McpDiscoveredTool & { overrideMode: McpToolMode | null; effectiveMode: McpToolMode; exposedName: string }`
- `McpServerView`: `{ id: string; name: string; slug: string; transport: McpTransportKind; enabled: boolean; command: string; args: string[]; cwd: string; url: string; envKeys: string[]; headerKeys: string[]; envMasked: Record<string, string>; headersMasked: Record<string, string>; trustReadOnlyHint: boolean; tools: McpToolView[]; toolPolicies: Record<string, McpToolMode>; status: McpServerStatus; lastError: string; grantedBotIds: string[]; createdAt: number; updatedAt: number }`
- `FrozenMcpExecution`: `{ kind: 'mcp'; operationId: string; serverId: string; serverName: string; serverSlug: string; toolName: string; exposedToolName: string; args: Record<string, unknown> }`
- `McpCallResult`: `{ content: Array<Record<string, unknown>>; structuredContent?: unknown; isError?: boolean }`
- `McpWriteExecutionResult`: `| { status: 'succeeded'; summary: string } | { status: 'failed'; error: string } | { status: 'uncertain'; detail: string }`
- `McpCallError` class with `code: 'connect_failed' | 'protocol_error' | 'timeout' | 'uncertain_write' | 'not_found' | 'disabled'` and `dispatched: boolean` (indicating whether the JSON-RPC `tools/call` payload already left the gateway).
- `McpManager` interface:
  ```ts
  export type McpManager = {
    discoverTools(serverId: string): Promise<McpDiscoveredTool[]>
    ensureDiscovered(serverId: string): Promise<McpServerRow | null>
    callTool(
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
      opts?: { write?: boolean; signal?: AbortSignal },
    ): Promise<McpCallResult>
    disconnect(serverId: string): Promise<void>
    closeAll(): Promise<void>
  }
  ```

Create `gateway/src/mcp/secrets.ts`:
- When `dataDir` is non-empty, read/write `<data>/mcp-secrets.json` atomically (`${path}.${process.pid}.tmp`, `mode: 0o600`, `restrictToOwner(tmp)`, `chmodSync(tmp, 0o600)`, `renameSync(tmp, path)`). When `dataDir === ''`, maintain an in-memory `Map<string, McpServerSecrets>`.
- `redactText(serverId, text)` replaces every secret string (`length >= 4`) configured in `env` or `headers` (plus raw token suffix after `Bearer `) with `[REDACTED]`.

Create `gateway/src/mcp/store.ts` and add migration `v13` in `gateway/src/db.ts` (creating `mcp_servers` and `bot_mcp_servers`), plus `| { type: 'mcp_changed' }` in `gateway/src/hub.ts`.
- `normalizeMcpSlug(raw)`: lowercase, replace `[^a-z0-9]+` with `_`, trim leading/trailing `_`, slice to max `20` chars (fallback `'server'`). In `createMcpServer`, if `slug` is already taken in `mcp_servers`, try `${base.slice(0, 17)}_2`, `_3`, etc.

- [ ] **Step 4: Run test & typecheck to verify they pass**

Run: `pnpm --filter @opensuperbot/gateway test -- test/mcp-store.test.ts && pnpm --filter @opensuperbot/gateway typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/db.ts gateway/src/hub.ts gateway/src/mcp/types.ts gateway/src/mcp/secrets.ts gateway/src/mcp/store.ts gateway/test/mcp-store.test.ts
git commit -m "feat(gateway): add v13 MCP tables, 0600 secret vault, and server store"
```

---

### Task 2: Native `stdio` & `Streamable HTTP` (+ Legacy SSE Fallback) Transports & `McpManager`

**Files:**
- Create: `gateway/src/mcp/stdio-transport.ts`
- Create: `gateway/src/mcp/http-transport.ts`
- Create: `gateway/src/mcp/client.ts`
- Test: `gateway/test/mcp-transport.test.ts`

**Interfaces:**
- Consumes: `Db` from `gateway/src/db.ts`, `Hub` from `gateway/src/hub.ts`, `McpSecretVault` from `gateway/src/mcp/secrets.js`, `getMcpServer`, `saveMcpDiscoveredTools`, `markMcpServerStatus` from `gateway/src/mcp/store.js`, types from `gateway/src/mcp/types.js`.
- Produces:
  - `sanitizeStdioEnv(hostEnv: Record<string, string | undefined>, serverEnv: Record<string, string>): Record<string, string>`
  - `validateMcpHttpConfig(url: string, headers: Record<string, string>): { url: URL; headers: Record<string, string> }`
  - `createStdioSession(opts)` & `createHttpSession(opts)` implementing `McpSession`:
    `{ listTools(signal?: AbortSignal): Promise<McpDiscoveredTool[]>; callTool(name: string, args: Record<string, unknown>, opts?: { write?: boolean; signal?: AbortSignal }): Promise<McpCallResult>; close(): Promise<void>; isHealthy(): boolean }`
  - `createMcpManager(deps: { db: Db; secrets: McpSecretVault; hub?: Hub; hostEnv?: Record<string, string | undefined>; fetchImpl?: typeof fetch; handshakeTimeoutMs?: number; callTimeoutMs?: number; now?: () => number }): McpManager`

- [ ] **Step 1: Write the failing test (`gateway/test/mcp-transport.test.ts`)**

Write comprehensive tests using:
1. A temporary `.mjs` Node child script spawned over `stdio` (`process.execPath`) verifying:
   - `OPENSUPERBOT_AUTH_TOKEN` and `OPENAI_API_KEY` from `hostEnv` are **stripped** while `PATH` and explicit `CUSTOM_TOKEN` from `secrets.env` arrive intact.
   - Non-JSON startup banner lines on `stdout` are ignored cleanly.
   - `tools/list` cursor pagination (`page1` → `nextCursor: 'p2'` → `page2`) normalizes `inputSchema`, `readOnlyHint`, and `destructiveHint`.
   - `notifications/tools/list_changed` emitted by the server triggers automatic cache refresh in `db` and `mcp_changed` on `hub`.
   - Server-sent `ping` receives `{ jsonrpc: '2.0', id, result: {} }`.
   - Startup failure writes redacted `stderr` to `lastError` without leaking secret values.
   - Mid-flight child exit after receiving a `write: true` `tools/call` throws `McpCallError` with `dispatched === true` (`code === 'uncertain_write'`), whereas failing to spawn throws `dispatched === false`.
   - `closeAll()` terminates the child process cleanly.
2. A local `node:http` test server on `127.0.0.1:0` verifying:
   - **Streamable HTTP JSON mode**: `initialize` returns `Mcp-Session-Id: sess-1`, `notifications/initialized` gets `202`, `tools/list` & `tools/call` carry `Mcp-Session-Id: sess-1` and `Authorization` header, `disconnect` sends `DELETE` with `Mcp-Session-Id: sess-1`.
   - **Streamable HTTP SSE mode**: `POST` returning `Content-Type: text/event-stream` with `event: message\ndata: {...}\n\n` resolves the matching JSON-RPC request.
   - **Session 404 recovery on read (and non-retry on write)**: when `sess-1` returns `404` on a read `callTool`, `McpManager` re-initializes `sess-2` and succeeds; when `404`/abort happens mid-write after dispatch, write is NOT re-sent twice when stream drops mid-body.
   - **Legacy `2024-11-05` HTTP+SSE fallback**: when `POST /sse` returns `405 Method Not Allowed`, transport falls back to `GET /sse`, parses `event: endpoint\ndata: /messages?sessionId=abc\n\n`, posts JSON-RPC requests to `/messages?sessionId=abc`, and reads responses from the SSE stream.
   - **Cross-origin `endpoint` SSRF block**: if `GET /sse` emits `event: endpoint\ndata: http://169.254.169.254/latest/meta-data\n\n`, handshake fails immediately with a cross-origin error and never sends a `POST` to that origin.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opensuperbot/gateway test -- test/mcp-transport.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `stdio-transport.ts`, `http-transport.ts`, and `client.ts`**

Key implementation details:
- **`stdio-transport.ts`:**
  - Safe OS env allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TEMP`, `TMP`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `SYSTEMROOT`, `COMSPEC`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `PATHEXT`, `PROGRAMFILES`. Overlay `serverEnv`.
  - Line framing cap: `4 * 1024 * 1024` bytes (`4 MB`); `stderr` tail ring cap: `8 * 1024` chars (`8 KB`).
  - Track per-request `dispatched: boolean` (becomes `true` as soon as `child.stdin.write(line)` is invoked for that request). If the child exits or times out after `dispatched && write`, reject with `new McpCallError('uncertain_write', '...', true)`.
- **`http-transport.ts`:**
  - Validate `http:` / `https:` URL with no `username`/`password`, and validate custom header names (forbid `host`, `content-length`, `transfer-encoding`, `connection`, `accept`, `content-type`, `mcp-session-id`, or CR/LF in values).
  - Implement SSE frame reader over `ReadableStream<Uint8Array>` (`\r?\n` line splitting, accumulating `event:` and `data:` lines until blank line, enforcing `4 MB` stream cap per call on Streamable HTTP POST responses).
  - For Streamable HTTP `POST`: once `fetchImpl` has been called with a `tools/call` body (`write === true`), treat network abort/timeout or HTTP `5xx` as `dispatched = true` (`uncertain_write`), whereas HTTP `400/401/403/404/422` where the server explicitly rejected the HTTP request before executing MCP `tools/call` (or JSON-RPC `error`) is `dispatched = false` (`protocol_error` / `connect_failed`).
  - For legacy SSE fallback: trigger when `initialize` `POST` returns HTTP `400`, `404`, or `405` without a valid JSON-RPC envelope; open persistent `GET <url>` SSE stream, enforce `endpointUrl.origin === baseUrl.origin`, then POST JSON-RPC messages to `endpointUrl`.
- **`client.ts`:**
  - Normalize `inputSchema`: ensure `{ type: 'object', properties: {...}, ...(Array.isArray(s.required) ? { required: s.required } : {}) }`.
  - Cap `tools/list` pagination at `10` pages and `256` tools total.
  - `ensureDiscovered(serverId)`: if server exists, is `enabled`, has `tools.length === 0`, and `status === 'disconnected'`, run `await discoverTools(serverId).catch(() => {})` and return refreshed `getMcpServer(db, serverId)`.

- [ ] **Step 4: Run test & typecheck to verify they pass**

Run: `pnpm --filter @opensuperbot/gateway test -- test/mcp-transport.test.ts && pnpm --filter @opensuperbot/gateway typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/mcp/stdio-transport.ts gateway/src/mcp/http-transport.ts gateway/src/mcp/client.ts gateway/test/mcp-transport.test.ts
git commit -m "feat(mcp): implement native stdio and Streamable HTTP/SSE client pool"
```

---

### Task 3: MCP Management HTTP API & `mcpServers` JSON Batch Import

**Files:**
- Create: `gateway/src/mcp/api.ts`
- Modify: `gateway/src/server.ts:40-60,115-120,250-260,420-435,1200-1245,1560-1580`
- Test: `gateway/test/mcp-api.test.ts`

**Interfaces:**
- Consumes: `McpManager` from `gateway/src/mcp/client.js`, `McpSecretVault` from `gateway/src/mcp/secrets.js`, store helpers from `gateway/src/mcp/store.js`, `validateMcpHttpConfig` from `gateway/src/mcp/http-transport.js`, `effectiveToolMode` & `buildExposedMcpToolNames` (or shared naming helper — define `buildExposedMcpToolNames` & `effectiveToolMode` in `gateway/src/mcp/tools.ts` or `store.ts`; let's define `effectiveToolMode` & `computeExposedToolNames` in `gateway/src/mcp/store.ts` so both `api.ts` in Task 3 and `tools.ts` in Task 4 import the exact same pure functions!).
  - **Interface lock:** Put pure helpers `effectiveToolMode(server: Pick<McpServerRow, 'toolPolicies' | 'trustReadOnlyHint'>, tool: Pick<McpDiscoveredTool, 'name' | 'readOnlyHint' | 'destructiveHint'>): McpToolMode` and `computeExposedToolNames(serverSlug: string, tools: readonly Pick<McpDiscoveredTool, 'name'>[]): Map<string, string>` inside `gateway/src/mcp/store.ts` (or export them from `gateway/src/mcp/tools-naming.ts` — let's put them in `gateway/src/mcp/store.ts` or a dedicated `gateway/src/mcp/naming.ts` created in Task 3 so Task 3 and Task 4 share one single source of truth!). Let's create `gateway/src/mcp/naming.ts` in Task 3 with `effectiveToolMode`, `computeExposedToolNames`, and `isMcpToolName`.
- Produces:
  - `effectiveToolMode`, `computeExposedToolNames`, `isMcpToolName` in `gateway/src/mcp/naming.ts`
  - `parseMcpServersImportJson(raw: string): { entries: ParsedMcpImportEntry[]; errors: { name: string; error: string }[] }`
  - `mountMcp(app: Hono, deps: { db: Db; secrets: McpSecretVault; manager: McpManager; hub: Hub; now?: () => number })`
  - `AppDeps.mcpManager?: McpManager` in `gateway/src/server.ts`
  - `GET /api/bots/:botId/computer` includes `mcpServers: Array<{ id: string; name: string; slug: string; transport: McpTransportKind; enabled: boolean; status: McpServerStatus; toolCount: number; granted: boolean }>`

- [ ] **Step 1: Write the failing test (`gateway/test/mcp-api.test.ts`)**

Test all routes via `createApp`:
- `GET /api/mcp/servers` starts empty (`{ servers: [], botGrants: { ... } }`).
- `POST /api/mcp/servers` creates `stdio` and `http` servers, validates URL/headers/command, masks `env` and `headers`, triggers `discoverTools` when `connectNow !== false`, and keeps the saved server with `status: 'error'` if initial discovery fails.
- `POST /api/mcp/servers/import` parses standard Claude Desktop / Cursor `{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "pkg"], "env": { "KEY": "val" } }, "linear": { "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer secret" } } } }`, imports both, masks secrets, grants optional `botIds`, and reports per-entry validation errors cleanly.
- `PATCH /api/mcp/servers/:id` updates `trustReadOnlyHint`, `toolPolicies` (`'read' | 'write' | 'default'`), `enabled`, and partial `env` / `headers` without wiping untouched secrets, disconnecting any live session via `mcpManager.disconnect(id)`.
- `POST /api/mcp/servers/:id/test` runs `discoverTools(id)` and returns refreshed `tools` with `exposedName`, `overrideMode`, and `effectiveMode`.
- `PUT /api/mcp/servers/:id/bots` and `PUT /api/bots/:botId/mcp` update grants bidirectionally, broadcast `{ type: 'mcp_changed' }`, and appear in `GET /api/bots/:botId/computer`.
- `DELETE /api/mcp/servers/:id` disconnects, removes DB rows & secrets, and broadcasts `{ type: 'mcp_changed' }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opensuperbot/gateway test -- test/mcp-api.test.ts`
Expected: FAIL with `../src/mcp/api.js` not found.

- [ ] **Step 3: Implement `gateway/src/mcp/naming.ts`, `gateway/src/mcp/api.ts`, and mount in `gateway/src/server.ts`**

Naming & policy contract in `gateway/src/mcp/naming.ts`:
- `isMcpToolName(name: string): boolean` → `name.startsWith('mcp__')`
- `computeExposedToolNames(serverSlug: string, tools: readonly Pick<McpDiscoveredTool, 'name'>[]): Map<string, string>`:
  - Prefix is `mcp__${serverSlug}__`.
  - Normalize `tool.name` to `rawSlug = tool.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'`.
  - Candidate `full = prefix + rawSlug`. If `full.length <= 64` and not yet used in this map, assign `full`.
  - Otherwise compute `hash = createHash('sha256').update(tool.name).digest('hex').slice(0, 4)`, max toolSlug length `maxToolLen = Math.max(1, 64 - prefix.length - 5)`, and assign `${prefix}${rawSlug.slice(0, maxToolLen)}_${hash}` (guaranteed `<= 64` chars because `serverSlug.length <= 20`, so `prefix.length <= 25`, leaving at least `34` chars).
- `effectiveToolMode(server, tool)`:
  - Check `const o = server.toolPolicies[tool.name]`; if `o === 'read' || o === 'write'` return `o`.
  - If `server.trustReadOnlyHint && tool.readOnlyHint && !tool.destructiveHint` return `'read'`.
  - Return `'write'`.

Wire `mcpSecrets = createMcpSecretVault(dataDir)` and `mcpManager = deps.mcpManager ?? createMcpManager({ db, secrets: mcpSecrets, hub, hostEnv: env })` in `gateway/src/server.ts`, call `mountMcp(app, ...)`, add `mcpServers` to `GET /api/bots/:botId/computer`, and call `void mcpManager.closeAll()` inside `stopAll()`.

- [ ] **Step 4: Run test & typecheck to verify they pass**

Run: `pnpm --filter @opensuperbot/gateway test -- test/mcp-api.test.ts && pnpm --filter @opensuperbot/gateway typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/mcp/naming.ts gateway/src/mcp/api.ts gateway/src/server.ts gateway/test/mcp-api.test.ts
git commit -m "feat(mcp): add MCP management API, JSON batch import, and computer view"
```

---

### Task 4: Dynamic MCP Tools, 3-Tier Policy, `outside-data` Taint & Gateway-Executed Approvals

**Files:**
- Create: `gateway/src/mcp/tools.ts`
- Modify: `gateway/src/tools.ts:370-413`
- Modify: `gateway/src/prompts.ts:85-105,155-193`
- Modify: `gateway/src/agent.ts:10-20,100-115,355-460,560-595`
- Modify: `gateway/src/server.ts:45-65,510-560,910-960`
- Test: `gateway/test/mcp-agent.test.ts`

**Interfaces:**
- Consumes: `McpManager`, `McpServerRow`, `FrozenMcpExecution`, `McpWriteExecutionResult` from `gateway/src/mcp/types.js`, `effectiveToolMode`, `computeExposedToolNames`, `isMcpToolName` from `gateway/src/mcp/naming.js`, `createApproval`, `recordApprovalExecution` from `gateway/src/approvals.js`.
- Produces:
  - `buildMcpToolSet(servers: readonly McpServerRow[], opts?: { watch?: boolean }): { tools: ToolDef[]; readToolNames: Set<string>; lookup: Map<string, { server: McpServerRow; tool: McpDiscoveredTool; mode: McpToolMode; exposedName: string }> }`
  - `formatMcpCallResult(result: McpCallResult): string`
  - `runMcpToolCall(input: { db: Db; manager: McpManager; botId: string; threadId: string; trigger: ActionTrigger; name: string; args: Record<string, unknown>; watch?: boolean; events: AgentEvents; now: number }): Promise<{ text: string; ok: boolean; tainted?: boolean }>`
  - `safeExecuteMcpWrite(manager: McpManager, frozen: FrozenMcpExecution): Promise<McpWriteExecutionResult>`

- [ ] **Step 1: Write the failing test (`gateway/test/mcp-agent.test.ts`)**

Test end-to-end through `createApp`:
1. **Default zero access & naming:** An enabled MCP server with tools (`get_issue`, `create_issue`, and a 90-character tool name) is invisible to ungranted bots; when granted, exposed tool names match `^mcp__[a-z0-9_]+$` and `length <= 64`.
2. **3-tier read/write & `watch` filtering:**
   - By default (`trustReadOnlyHint: false`, no `toolPolicies`), even a tool with `readOnlyHint: true` is treated as `'write'`, hidden from `watch` runs, and held for approval on normal turns.
   - When `trustReadOnlyHint: true`, `readOnlyHint: true` (`destructiveHint: false`) runs directly and is exposed in `watch` runs, while a tool with both `readOnlyHint: true` AND `destructiveHint: true` stays `'write'`.
   - Operator `toolPolicies` override (`'read'` or `'write'`) overrides `trustReadOnlyHint` in both directions.
3. **`outside-data` taint propagation:** Calling a `'read'` MCP tool (`mcp__linear__get_issue`) sets `outside-data` taint on the turn so a subsequent standing rule (`Always allow email to boss@acme.com`) in the same turn is **held** (`ruleHeld: true`) instead of auto-executing!
4. **Frozen write approval gate (`kind: 'other'`, never rememberable) & single-attempt gateway execution:**
   - Calling `'write'` MCP tool (`mcp__linear__create_issue`) does NOT invoke `mcpManager.callTool` during the model turn; it emits an `approval_request` chip (`kind: 'other'`, `rememberBlock` non-null; `POST /api/approvals/:id` with `remember: 'always'` returns `400`).
   - Clicking `Approve` calls `mcpManager.callTool` exactly once with the frozen `args`, updates `execution_status = 'succeeded'` on the chip, and wakes the teammate to report completion.
   - If the server is paused (`enabled = false`) or revoked from `bot_mcp_servers` before `Approve`, gateway blocks execution (`execution_status = 'failed'`) without calling `mcpManager.callTool`.
   - If `mcpManager.callTool` throws `McpCallError` with `dispatched === true` (mid-flight timeout/disconnect), gateway records `execution_status = 'uncertain'`, posts the `connector_execution` (`uncertain`) notice, and never retries.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opensuperbot/gateway test -- test/mcp-agent.test.ts`
Expected: FAIL with `../src/mcp/tools.js` not found.

- [ ] **Step 3: Implement `gateway/src/mcp/tools.ts` and wire `tools.ts`, `prompts.ts`, `agent.ts`, and `server.ts`**

Key details:
- In `gateway/src/tools.ts`: add `mcpTools?: ToolDef[]` and `mcpReadToolNames?: ReadonlySet<string>` to `buildTools()`. In line 412, when `opts.watch` is true, keep tools where `WATCH_TOOL_NAMES.has(t.function.name) || Boolean(opts.mcpReadToolNames?.has(t.function.name))`.
- In `gateway/src/agent.ts`:
  - In `execTool`: change `if (deps.watch && !WATCH_TOOL_NAMES.has(call.name))` to `if (deps.watch && !WATCH_TOOL_NAMES.has(call.name) && !deps.mcpReadToolNames?.has(call.name))`.
  - Before `COMPUTER_TOOL_NAMES` check, add `if (isMcpToolName(call.name))` routing to `deps.onMcpTool`, calling `onOutsideDataRead?.()` whenever `deps.mcpReadToolNames?.has(call.name) || res.tainted`.
  - In `summarize(tool, args)`: for `isMcpToolName(tool)`, format up to 3 top-level argument keys concisely (`k=v`, redacting keys matching `token|secret|password|key|auth`).
- In `gateway/src/prompts.ts`: add `export type PromptMcpServer = { id: string; name: string; slug: string; enabled: boolean; status: string; toolCount: number }` and render a `## MCP servers` section for granted servers explaining `mcp__<slug>__*` tools and automatic gateway approval holding for write tools.
- In `gateway/src/server.ts`:
  - In `startTurn`: load `botMcpServers = listBotMcpServersAllStatuses(db, bot.id)`. For any server with `enabled && tools.length === 0 && status === 'disconnected'`, run `await mcpManager.ensureDiscovered(s.id)`. Build `{ tools: mcpTools, readToolNames: mcpReadToolNames }` from `enabled` servers and pass into `runTurn`.
  - In `settleApproval`: inspect parsed `approval.execution_json`. If `parsed && typeof parsed === 'object' && (parsed as { kind?: unknown }).kind === 'mcp'`, run the MCP post-approval verification (`enabled`, granted in `bot_mcp_servers`), execute `safeExecuteMcpWrite(mcpManager, frozenMcp)`, record `succeeded` / `failed` / `uncertain`, patch chip, post `connector_execution` notice on `failed`/`uncertain`, wake `bot` on `succeeded` (or `publishPresence`), and `return 'ok'`. Otherwise fall through to the existing Phase 1 `FrozenExecution` connector handler!

- [ ] **Step 4: Run test & typecheck to verify they pass**

Run: `pnpm --filter @opensuperbot/gateway test -- test/mcp-agent.test.ts test/connectors-agent.test.ts && pnpm --filter @opensuperbot/gateway typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/mcp/tools.ts gateway/src/tools.ts gateway/src/prompts.ts gateway/src/agent.ts gateway/src/server.ts gateway/test/mcp-agent.test.ts
git commit -m "feat(gateway): wire dynamic MCP tools, outside-data taint, and frozen write approvals"
```

---

### Task 5: Web Types, API Client & Bilingual (`en` / `zh-CN`) Copy

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/i18n/GLOSSARY.md`
- Modify: `web/src/i18n/en.ts`
- Modify: `web/src/i18n/zh-CN.ts`
- Modify: `web/src/i18n/i18n.test.tsx`

**Interfaces:**
- Produces in `web/src/types.ts`:
  - `McpTransportKind = 'stdio' | 'http'`
  - `McpServerStatus = 'disconnected' | 'connected' | 'error'`
  - `McpToolMode = 'read' | 'write'`
  - `McpToolView`, `McpServerView`, `McpServersSnapshot`, `BotMcpServerItem`
  - Extend `ComputerView` with `mcpServers?: BotMcpServerItem[]`
  - Extend `ServerEvent` with `| { type: 'mcp_changed' }`
- Produces in `web/src/api.ts`:
  - `fetchMcpServers(): Promise<McpServersSnapshot | null>` (returns `null` on `404` for older gateways)
  - `createMcpServer(input): Promise<{ server: McpServerView }>`
  - `importMcpServers(input: { json: string; botIds?: string[]; trustReadOnlyHint?: boolean }): Promise<{ imported: McpServerView[]; errors: { name: string; error: string }[] }>`
  - `updateMcpServer(id: string, patch): Promise<{ server: McpServerView }>`
  - `testMcpServer(id: string): Promise<{ server: McpServerView }>`
  - `deleteMcpServer(id: string): Promise<void>`
  - `setMcpServerBots(id: string, botIds: string[]): Promise<void>`
  - `setBotMcpServers(botId: string, serverIds: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test in `web/src/i18n/i18n.test.tsx`**

Add assertions verifying the new `connectors.tab.apps`, `connectors.tab.mcp`, `mcp.*`, and `panel.mcpServers` keys exist in both `en` and `zhCN` with identical placeholder tokens.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opensuperbot/web test -- src/i18n/i18n.test.tsx`
Expected: FAIL with missing `mcp.*` keys.

- [ ] **Step 3: Implement `types.ts`, `api.ts`, `GLOSSARY.md`, `en.ts`, and `zh-CN.ts`**

Add clean, plain-language English & Chinese UI strings for:
- Dialog tabs: `connectors.tab.apps` (`Apps` / `应用`), `connectors.tab.mcp` (`MCP` / `MCP 服务`)
- MCP custody & host note: `mcp.custody` explaining `stdio` runs on the gateway host (configured only by you, gateway secrets stripped) and HTTP connects directly with credentials stored locally at `0600`.
- Actions, form fields (`Name`, `Transport`, `Command`, `Arguments`, `Working folder`, `Server URL`, `Environment variables`, `HTTP headers`, `Trust server readOnlyHint`), JSON import (`Paste Claude Desktop or Cursor mcpServers JSON`, `Import`), status badges (`Connected`, `Error`, `Paused`, `Not tested`), tool list (`Discovered tools ({count})`, `Needs approval`, `Read-only`, `Default ({mode})`), delete confirm, and `panel.mcpServers` / `panel.mcpServersHint`.

- [ ] **Step 4: Run test & typecheck to verify they pass**

Run: `pnpm --filter @opensuperbot/web test -- src/i18n/i18n.test.tsx && pnpm --filter @opensuperbot/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/src/i18n/GLOSSARY.md web/src/i18n/en.ts web/src/i18n/zh-CN.ts web/src/i18n/i18n.test.tsx
git commit -m "feat(web): add MCP client types, API helpers, and bilingual i18n copy"
```

---

### Task 6: Dual-Tab `ConnectorsDialog` (`Apps` / `MCP`), `McpTab` & `ComputerPanel` Toggles

**Files:**
- Create: `web/src/components/McpTab.tsx`
- Modify: `web/src/components/ConnectorsDialog.tsx`
- Modify: `web/src/components/ComputerPanel.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/index.css`
- Modify: `web/src/components/ConnectorsDialog.test.tsx`
- Modify: `web/src/components/ComputerPanel.test.tsx`

**Interfaces:**
- Consumes: `McpServersSnapshot`, `McpServerView`, `BotMcpServerItem`, `fetchMcpServers`, `createMcpServer`, `importMcpServers`, `updateMcpServer`, `testMcpServer`, `deleteMcpServer`, `setMcpServerBots`, `setBotMcpServers` from Task 5.
- Produces:
  - `McpTab` component in `web/src/components/McpTab.tsx`
  - `ConnectorsDialog` accepting optional `mcpState?: McpServersSnapshot | null`, `onMcpChange?: (next: McpServersSnapshot) => void`, and `initialTab?: 'apps' | 'mcp'` (backwards-compatible when `mcpState` is omitted in existing tests!)
  - `ComputerPanel` accepting optional `onToggleMcpServer?: (serverId: string, granted: boolean) => void | Promise<void>` and rendering `info.mcpServers` checkboxes
  - `App.tsx` loading `fetchMcpServers()`, refreshing on `{ type: 'mcp_changed' }`, lighting up `connectorsAttention` when any enabled MCP server has `status === 'error'`, and passing `mcpState` / `onToggleMcpServer`.

- [ ] **Step 1: Write failing UI tests (`ConnectorsDialog.test.tsx` & `ComputerPanel.test.tsx`)**

Add component tests verifying:
1. `ConnectorsDialog` renders `Apps` and `MCP` tabs when `mcpState` is provided; switching to `MCP` displays configured servers, allows importing `mcpServers` JSON, testing/refreshing a server, expanding discovered tools to switch a tool from `Needs approval` to `Read-only` (`updateMcpServer`), and toggling teammate access.
2. `ComputerPanel` renders the `MCP` section when `info.mcpServers` is non-empty and calls `onToggleMcpServer(id, checked)` when toggled.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opensuperbot/web test -- src/components/ConnectorsDialog.test.tsx src/components/ComputerPanel.test.tsx`
Expected: FAIL on the new MCP tab and ComputerPanel MCP assertions.

- [ ] **Step 3: Implement `McpTab.tsx`, update `ConnectorsDialog.tsx`, `ComputerPanel.tsx`, `App.tsx`, and `index.css`**

Key UI polish details:
- Keep `TeammateCheckList` reusable (export from `ConnectorsDialog.tsx` or share cleanly).
- In `McpTab.tsx`:
  - Top custody callout + `+ Add MCP server` + `Import JSON` buttons.
  - Inline Add/Edit card: `stdio` (`command`, space/line-separated or JSON `args`, optional `cwd`, key/value `env` rows showing masked placeholders for already-saved keys) vs `http` (`url`, key/value `headers` rows with quick `Authorization: Bearer …` hint), `trustReadOnlyHint` checkbox, and initial `TeammateCheckList`.
  - Inline `Import JSON` card: `<textarea>` accepting `{ "mcpServers": { ... } }`, optional `trustReadOnlyHint` checkbox + `TeammateCheckList`, showing imported count and any per-entry validation errors.
  - Each server card: name, `stdio` / `HTTP` pill, status pill (`Connected` / `Error` / `Paused` / `Not tested`), tool count, `Test` button, `Enable/Pause` switch, `Edit`, `Delete` (via `ConfirmDialog`), expandable `Tools (N)` list with per-tool policy `<select>` (`default` / `read` / `write`) + `readOnlyHint` badge, and collapsible `Access` `TeammateCheckList`.

- [ ] **Step 4: Run web tests & typecheck to verify they pass**

Run: `pnpm --filter @opensuperbot/web test && pnpm --filter @opensuperbot/web typecheck`
Expected: PASS across all web test files.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/McpTab.tsx web/src/components/ConnectorsDialog.tsx web/src/components/ComputerPanel.tsx web/src/App.tsx web/src/index.css web/src/components/ConnectorsDialog.test.tsx web/src/components/ComputerPanel.test.tsx
git commit -m "feat(web): add MCP tab, JSON import, tool policy controls, and panel toggles"
```

---

### Task 7: Security & Comparison Documentation + Full Workspace Verification

**Files:**
- Modify: `docs/security.md`
- Modify: `docs/comparison.md`

**Interfaces:**
- Consumes: Implemented Phase 2 MCP Client behavior from Tasks 1–6.
- Produces: Updated honest security boundary documentation and comparison matrix, verified green across the full monorepo check suite.

- [ ] **Step 1: Update `docs/security.md` and `docs/comparison.md`**

In `docs/security.md`:
- Add a clear **MCP servers (`stdio` and `Streamable HTTP`)** subsection covering:
  - `<data>/mcp-secrets.json` `0600` local custody (direct HTTP connection with zero third-party relay).
  - Honest `stdio` host boundary: `stdio` subprocesses run on the gateway host outside per-teammate `bwrap`/`sandbox-exec` or Docker containers; therefore only the authenticated operator can configure MCP servers, models have no tool to add/modify MCP servers, and `OPENSUPERBOT_*` / gateway secrets are stripped from child environments.
  - Same-origin check on legacy SSE `endpoint` redirects.
  - Default-write approval gate (`kind: 'other'`, never auto-remembered, single-attempt gateway execution with `uncertain` non-replay) and `outside-data` taint on MCP read tools.
In `docs/comparison.md`:
- Update the MCP / external tool extensibility comparison notes so OpenSuperBot reflects both native OAuth App Connectors (`ComposioDriver`) and the built-in Standard MCP Client (`stdio` + `Streamable HTTP`) with code-enforced approval gating.

- [ ] **Step 2: Run the full repository verification suite (`CONTRIBUTING.md`)**

Run:
```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @opensuperbot/desktop build
```
Expected: All 4 commands exit `0` with pristine test output.

- [ ] **Step 3: Commit**

```bash
git add docs/security.md docs/comparison.md
git commit -m "docs: document standard MCP client security boundaries and comparison matrix"
```
