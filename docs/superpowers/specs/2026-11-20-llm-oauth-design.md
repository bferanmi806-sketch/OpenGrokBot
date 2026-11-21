# LLM Account OAuth & Experimental Subscription Guardrails — Design Spec

- **Date:** 2026-11-20
- **Status:** Draft (Pending Review)
- **Scope:**
  - **Phase 1 (Official Compliant Implementation):** Unified `LlmAuthDriver` subsystem (`gateway/src/llm-auth/`), local `0600` OAuth token store (`<data>/llm-oauth/`), SQLite migration `v14`, single-flight concurrent token refresh, **OpenAI "Sign in with ChatGPT"** (`dynamic_agent_client` + PKCE + Responses API using Plus/Pro/Team subscription allowances), **OpenRouter OAuth PKCE** (one-click account sign-in issuing a user-bound `sk-or-v1-…` key), remote/VPS manual callback URL fallback, and bilingual (`en` / `zh-CN`) UI across `SetupWizard` and `ModelsDialog`.
  - **Phase 2 (Architecture & Guardrail Design — Deferred Implementation):** Extensible driver contracts and a code-enforced **three-layer risk guardrail** for experimental account sign-ins (**xAI SuperGrok**, **Kimi Code**, and **MiniMax Portal**), including global opt-in gating, per-provider risk acknowledgement, persistent warning badges, and unattended routine protection (`runRoutine` gate).

---

## 1. Goals, Non-Goals & Security Custody Boundary

### Goals
1. **Use existing AI subscriptions without hunting for API keys:** Operators with eligible **ChatGPT Plus / Pro / Team** plans can sign in with their ChatGPT account during first-launch onboarding or in **AI models** and drive OpenSuperBot teammates directly via OpenAI's official Responses API.
2. **One-click multi-model onboarding via OpenRouter:** Operators can sign in with OpenRouter via OAuth PKCE to automatically provision and save a scoped `sk-or-v1-…` API key without leaving OpenSuperBot to copy-paste credentials.
3. **Connection-as-auth-profile model (no extra top-level entity):** Keep OpenSuperBot's existing `Connection` model (`main` + additional rows in `connections`). Each provider stays a single card in the picker (with a badge indicating account/subscription sign-in support) and switches between **Sign in with account** and **API key** inside the connection form. Operators can still create multiple connections for the same provider (e.g., one ChatGPT subscription + one pay-as-you-go OpenAI API key, or two separate accounts).
4. **Concurrency-safe token lifecycle for multi-bot teams:** Protect single-use rotating refresh tokens with a per-connection **single-flight in-memory mutex** so parallel teammates never trigger `401 refresh_token_reused` stampedes.
5. **Strict ToS hygiene & three-layer guardrails for experimental providers:** Never ship prohibited consumer OAuth workarounds (Claude Pro/Max `sk-ant-oat…`, Google Gemini CLI token proxying, deprecated Qwen `portal.qwen.ai`). Reserve clean driver hooks and enforce three-layer guardrails for experimental providers (xAI / Kimi / MiniMax) so Phase 2 drops in with zero architectural churn.

### Non-Goals
- Implementing Claude Pro/Max OAuth, Gemini Google-account OAuth, Qwen `portal.qwen.ai` OAuth, GitHub Copilot unofficial client-ID borrowing, or GLM Coding Plan presets — these violate vendor ToS or risk main-account suspension under unattended routines.
- Importing or sharing OAuth token files from external CLIs (`codex`, `claude`, `kimi`, etc.) — OpenSuperBot acts as an independent **Token Sink** so external tools and OpenSuperBot never invalidate each other's rotating refresh tokens.
- Adding a separate top-level `llm_accounts` table — teammates already pick individual models per connection (`BotModelPicker`), so connection-scoped credentials satisfy multi-account and multi-model use cases without extra UI indirection.
- Shipping Phase 2 driver code (`xai`, `kimi`, `minimax`) or showing an empty **Experimental** toggle in `SettingsDialog` during Phase 1 (schema, registry hooks, and backend gate are pre-built and unit-tested in Phase 1; UI toggle surfaces only when the first Phase 2 driver ships).

### Honest Custody & Storage Boundary
- **100% local disk custody:** OAuth access tokens, refresh tokens, dynamically issued `client_id`s, and API keys live exclusively on the gateway host under `<data>/` (`0600` POSIX mode + `restrictToOwner()` Windows ACL). No third-party proxy or broker (such as Composio) touches LLM credentials.
- **Why `<data>/llm-oauth/*.json` (`0600`) instead of Electron `safeStorage` / macOS Keychain:**
  1. The gateway runs as a standalone Node process in source/VPS/always-on deployments with no Electron runtime.
  2. Desktop builds are currently ad-hoc signed; changing ad-hoc signatures across local rebuilds or upgrades causes macOS Keychain prompts or decryption failures.
  3. OpenSuperBot explicitly supports copying `<data>/` verbatim between source checkouts and the desktop app (`docs/desktop.md`).
  4. Storage is encapsulated behind `gateway/src/llm-auth/store.ts` so an optional OS Keychain backend can be introduced later once official code signing/notarization is adopted.
- **Isolation guarantees:** OAuth tokens never enter SQLite, never mount into teammate Docker containers or local workspaces, and are never returned to the web renderer or model context.

---

## 2. Architecture & Module Layout

All LLM account authentication logic lives under `gateway/src/llm-auth/` in small, single-responsibility modules:

```text
gateway/src/llm-auth/
  types.ts             # AuthMode, AuthStatus, AuthGrant, OAuthSession, LlmAuthDriver, RoutinePolicy
  store.ts             # Atomic 0600 read/write/delete for <data>/llm-oauth/<id>.json & persistent host-id
  pendings.ts          # In-memory one-time OAuth pending + staged-grant store (15-min TTL, max 32 entries)
  refresh.ts           # Per-connection single-flight refresh mutex + 401 expiry state updater
  registry.ts          # Maps providerId + experimentalLlmOAuth flag to active LlmAuthDriver & metadata
  api.ts               # Hono routes (/api/llm-auth/*, GET /oauth/llm/callback, GET /oauth/llm/callback/:state)
  drivers/
    openai.ts          # Phase 1: Sign in with ChatGPT (dynamic_agent_client + PKCE + Responses API)
    openrouter.ts      # Phase 1: OpenRouter OAuth PKCE (exchanges code for sk-or-v1-… key)
```

*(Phase 2 adds `drivers/xai.ts`, `drivers/kimi.ts`, and optionally `drivers/minimax.ts` implementing the exact same `LlmAuthDriver` interface.)*

Existing files updated:
- `gateway/src/db.ts`: Append idempotent migration `v14` (auth metadata & guardrail columns on `connections`).
- `gateway/src/providers.ts`: Add declarative `oauth` metadata block on supported `Provider` entries (`openai`, `openrouter`, and Phase 2 capability declarations).
- `gateway/src/settings.ts`: Add `main` connection auth metadata keys + `experimentalLlmOAuth` setting key (default `false`, lockable via `OPENSUPERBOT_EXPERIMENTAL_LLM_OAUTH`); update `needsSetup()` to treat `main` as configured when `authMode === 'oauth'` and `<data>/llm-oauth/main.json` exists with `authStatus === 'active'` (or when OpenRouter's exchanged key exists in `<data>/llm-key`).
- `gateway/src/connections.ts` & `gateway/src/connections-api.ts`: Expose sanitized `auth` view per connection, expose `resolveBotTarget()` attaching `resolveAuth` for subscription OAuth connections, accept `authSessionId` on `POST /api/connections`, `PATCH /api/connections/:id`, and `POST /api/connections/test`, and enforce mutual cleanup when switching providers/modes or deleting connections.
- `gateway/src/llm.ts`, `gateway/src/llm-responses.ts`, `gateway/src/llm-check.ts`: Support optional async `resolveAuth?: (opts?: { forceRefresh?: boolean }) => Promise<string>` on `LlmTarget` with single `401` retry.
- `gateway/src/hub.ts`: Add `{ type: 'connections_changed' }` and `{ type: 'llm_auth_session'; sessionId: string; status: 'ready' | 'cancelled' | 'error' }` to `GatewayEvent`.
- `gateway/src/main.ts` & `gateway/src/server.ts`: Wire `createOAuthRefresher`, pass `resolveAuth` into `llmFor(botId)` / `live`, mount `mountLlmAuth`, and enforce the `routinePolicy` guardrail at the top of `runRoutine()`.
- `web/src/types.ts`, `web/src/api.ts`, `web/src/App.tsx`, `web/src/components/SetupWizard.tsx`, `web/src/components/ModelsDialog.tsx`, `web/src/i18n/{en,zh-CN,describe}.ts`, `web/src/index.css`: Bilingual account sign-in UI, waiting/manual-callback state, badges, and expiry recovery.
- `docs/models.md` & `docs/security.md`: Update subscription table (`ChatGPT Plus / Pro` → supported, OpenRouter sign-in) and document `<data>/llm-oauth/` custody & Token Sink guarantees.

---

## 3. Data Model & Secret Storage

### 3.1 SQLite Schema Migration `v14` (`gateway/src/db.ts`)

Add non-sensitive metadata columns to `connections` using idempotent `pragma('table_info(connections)')` checks (matching `v9`, `v11`, `v12`):

```sql
ALTER TABLE connections ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'api_key';    -- 'api_key' | 'oauth'
ALTER TABLE connections ADD COLUMN account_label TEXT NOT NULL DEFAULT '';       -- Sanitized email / workspace label
ALTER TABLE connections ADD COLUMN auth_status TEXT NOT NULL DEFAULT 'none';     -- 'none' | 'active' | 'expired' | 'revoked'
ALTER TABLE connections ADD COLUMN auth_error TEXT NOT NULL DEFAULT '';          -- Latest refresh/auth failure code or message
ALTER TABLE connections ADD COLUMN experimental_ack_at INTEGER;                  -- Phase 2: timestamp of operator risk consent
ALTER TABLE connections ADD COLUMN allow_routines INTEGER NOT NULL DEFAULT 1;    -- Phase 2: 0 = block unattended routines
```

For the built-in `main` connection (which lives in the `settings` KV table rather than `connections`), mirror the same six fields as setting keys: `authMode`, `accountLabel`, `authStatus`, `authError`, `experimentalAckAt`, `allowRoutines`, plus the global setting `experimentalLlmOAuth` (boolean, default `false`).

### 3.2 Environment Variable Precedence
- When `OPENSUPERBOT_API_KEY` or `OPENSUPERBOT_API_BASE` is set, the built-in `main` connection is locked to `authMode: 'api_key'` (matching existing `mainLocks()` behavior). The UI disables switching `main` to OAuth with an explanation, while still allowing operators to create additional OAuth connections in **AI models**.
- When `OPENSUPERBOT_EXPERIMENTAL_LLM_OAUTH` is set (`'0'`/`'false'` or `'1'`/`'true'`), it overrides and locks `experimentalLlmOAuth` in memory (never written to SQLite).

### 3.3 Secret Files (`gateway/src/llm-auth/store.ts`)
- **OpenRouter (`kind: 'key_exchange'`):** Stores the issued `sk-or-v1-…` API key in the existing key path (`<data>/llm-key` for `main`, `<data>/llm-keys/<id>` for extra connections, mode `0600` + `restrictToOwner()`). Sets `auth_mode = 'oauth'`, `auth_status = 'active'`, `account_label = 'OpenRouter'`. Runtime inference uses the stored key directly with zero refresh overhead.
- **OpenAI & rotating-token drivers (`kind: 'subscription'`):** Atomically writes `<data>/llm-oauth/<id>.json` (`<id>` strictly validated by `isConnectionId(id)` — `'main'` or `/^c-[0-9a-f]{8}$/`; directory `0700`, temp file `0600` + `restrictToOwner()` + `renameSync`):
  ```json
  {
    "version": 1,
    "provider": "openai",
    "clientId": "oaiapp_...",
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1795200000000,
    "accountLabel": "user@example.com",
    "scopes": ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
    "updatedAt": 1795196400000
  }
  ```
- **Persistent Host ID:** `<data>/llm-oauth/host-id` stores a once-generated random UUID (`0600`), passed as `ext_agent_host_id` to OpenAI so usage/rate limits stay bound to the same machine across restarts.

### 3.4 Mutual-Exclusion & Cleanup Invariants
Never allow credentials from one provider or auth mode to leak into another:
1. Changing a connection's `provider` or `baseURL` deletes `<data>/llm-oauth/<id>.json` and resets `auth_mode = 'api_key'`, `auth_status = 'none'`, `account_label = ''`, `auth_error = ''`.
2. Switching a connection from `oauth` to `api_key` (or clicking **Sign out**) deletes `<data>/llm-oauth/<id>.json` (and for `key_exchange` connections, deletes the stored key file when signing out).
3. Committing an `oauth_tokens` grant onto a connection deletes any prior `<data>/llm-key` / `<data>/llm-keys/<id>` for that connection.
4. Deleting a connection deletes both `<data>/llm-keys/<id>` and `<data>/llm-oauth/<id>.json`.

### 3.5 Sanitized Connection View (`/api/connections`)
Raw tokens never leave the gateway. Each item in `GET /api/connections` adds:
```ts
auth: {
  mode: 'api_key' | 'oauth'
  status: 'none' | 'active' | 'expired' | 'revoked'
  accountLabel: string
  error: string
  expiresAt?: number
  experimental?: boolean
  allowRoutines: boolean
}
```

---

## 4. `LlmAuthDriver` Interface & Phase 1 Official Drivers

### 4.1 Driver Contract (`gateway/src/llm-auth/types.ts`)

```ts
export type AuthGrant =
  | { kind: 'api_key'; apiKey: string; accountLabel: string }
  | {
      kind: 'oauth_tokens'
      accessToken: string
      refreshToken: string
      expiresAt: number
      clientId?: string
      scopes?: string[]
      accountLabel: string
    }

export type RoutinePolicy = 'allow' | 'warn' | 'block_default'

export type LlmAuthDriverMeta = {
  providerId: string
  tier: 'official' | 'experimental'
  kind: 'subscription' | 'key_exchange'
  flow: 'browser_pkce' | 'device_code'
  routinePolicy: RoutinePolicy
  riskVersion?: string
  defaultApi?: LlmApi
}
```

Drivers implement a discriminated union by `flow`:
- **`BrowserPkceDriver`:** `buildAuthorizeUrl(params) → string`, `exchangeCode(params, fetchImpl) → Promise<AuthGrant>`, optional `refresh?(session, fetchImpl) → Promise<AuthGrant>`, optional `revoke?(session, fetchImpl) → Promise<void>`.
- **`DeviceCodeDriver` (Phase 2):** `startDevice(params, fetchImpl) → Promise<DeviceStart>`, `pollDevice(params, fetchImpl) → Promise<DevicePollResult>`, `refresh(session, fetchImpl) → Promise<AuthGrant>`.

### 4.2 Phase 1 Driver 1: OpenAI — Sign in with ChatGPT (`drivers/openai.ts`)
- **Meta:** `tier: 'official'`, `kind: 'subscription'`, `flow: 'browser_pkce'`, `routinePolicy: 'allow'`.
- **Authorization server (`https://auth.openai.com`):**
  - Authorize endpoint: `https://auth.openai.com/api/accounts/authorize`
  - Token endpoint: `https://auth.openai.com/api/accounts/oauth/token`
  - Resource target: `https://api.openai.com/v1` (inference routes through existing `createResponsesLLM` → `POST /v1/responses` and `GET /v1/models`).
- **Dynamic Client Registration (`dynamic_agent_client`):**
  - First sign-in (no saved `clientId` on the connection): send `client_id=dynamic_agent_client`, `agent_name_hint=OpenSuperBot`, `ext_agent_host_id=<hostId>`.
  - Re-authentication (saved `oaiapp_…` `clientId` exists): send `client_id=<savedClientId>`, `ext_agent_host_id=<hostId>`, and omit `agent_name_hint`.
- **Authorization parameters:**
  - `response_type=code`
  - `redirect_uri=http://127.0.0.1:<port>/oauth/llm/callback` (normalizes `localhost` loopback to explicit `127.0.0.1` per RFC 8252 and OpenAI loopback guidance)
  - `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`
  - `resource=https://api.openai.com/v1`
  - `code_challenge=<S256>`, `code_challenge_method=S256`, `state=<24-byte base64url>`, `nonce=<16-byte base64url>`
- **Callback & Token Exchange:**
  - Callback query carries `code`, `state`, and (on dynamic registration) `issued_client_id` (falling back to `client_id` query param or existing saved `clientId`).
  - `POST https://auth.openai.com/api/accounts/oauth/token` (`application/x-www-form-urlencoded`) with `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`, `redirect_uri`.
  - Extract display-only `accountLabel` from the returned `id_token` JWT payload (`email` → `name` → fallback `'ChatGPT'`). Do not rely on `id_token` claims for security decisions; upstream OpenAI enforces authorization on every `/v1/responses` call.
- **Token Refresh:**
  - `POST https://auth.openai.com/api/accounts/oauth/token` with `grant_type=refresh_token`, `client_id`, `refresh_token`.
  - Persists the new `access_token`, rotated `refresh_token` (preserving existing if omitted), and computed `expiresAt = now + expires_in * 1000`.

### 4.3 Phase 1 Driver 2: OpenRouter — OAuth PKCE (`drivers/openrouter.ts`)
- **Meta:** `tier: 'official'`, `kind: 'key_exchange'`, `flow: 'browser_pkce'`, `routinePolicy: 'allow'`.
- **Authorization URL:**
  - `https://openrouter.ai/auth?callback_url=<encodeURIComponent(origin + '/oauth/llm/callback/' + state)>&code_challenge=<S256>&code_challenge_method=S256`
  - Uses path-embedded `:state` so OpenRouter cleanly appends `?code=…` without double-`?` corruption.
- **Key Exchange:**
  - `POST https://openrouter.ai/api/v1/auth/keys` (JSON body `{ code, code_verifier, code_challenge_method: 'S256' }`) → receives `{ key: 'sk-or-v1-…' }`.
  - Returns `{ kind: 'api_key', apiKey: key, accountLabel: 'OpenRouter' }`. No refresh cycle is needed.

---

## 5. OAuth Session Lifecycle, HTTP API & Staging Flow

### 5.1 Staging vs. Immediate Commit
To match OpenSuperBot's existing "test before saving" flow in `SetupWizard` and `ModelsDialog` without leaving orphan token files on disk:
- **Staged mode (`commit: false`, used by `SetupWizard` and `ConnectionForm` for new/edited connections):**
  - Completing the browser callback stores the resolved `AuthGrant` inside the in-memory `pendings` entry keyed by `sessionId` (15-min TTL, max 32 entries) and broadcasts `{ type: 'llm_auth_session', sessionId, status: 'ready' }`.
  - The UI calls `POST /api/connections/test` with `{ authSessionId, provider, model, ... }` to verify connectivity and list models **before** persisting anything (the test route resolves `grant.apiKey` for `key_exchange` or `grant.accessToken` for `oauth_tokens` as the temporary Bearer credential).
  - Clicking **Save** / **Next** sends `{ authSessionId, ... }` to `POST /api/connections` or `PATCH /api/connections/:id`, which consumes the staged grant once, writes `<data>/llm-oauth/<id>.json` (or `llm-key` for OpenRouter), updates DB/settings, and broadcasts `{ type: 'connections_changed' }`.
  - Canceling or switching providers leaves zero files on disk.
- **Commit mode (`commit: true`, used for one-click "Re-sign in" on an existing connection):**
  - Completing the browser callback immediately writes credentials for `connectionId`, sets `auth_status = 'active'`, clears `auth_error`, and broadcasts both `{ type: 'llm_auth_session', sessionId, status: 'ready' }` and `{ type: 'connections_changed' }`.

### 5.2 Gateway HTTP Endpoints (`gateway/src/llm-auth/api.ts`)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/llm-auth/start` | Gateway token | Body: `{ provider, connectionId?, commit?, acknowledgedRiskVersion?, region? }`. Validates provider, env locks, and experimental gates; creates pending PKCE/device entry; returns `{ sessionId, flow, authorizeUrl, callbackUrl }` (or device code payload in Phase 2). |
| `GET /oauth/llm/callback` | Public (one-time `state`) | Standard OAuth redirect receiver (`?code=&state=&issued_client_id=` or `?error=`). Consumes `state` once, exchanges code, commits or stages grant, broadcasts `{ type: 'llm_auth_session', ... }` (plus `{ type: 'connections_changed' }` on commit), returns CSP-locked HTML page (`default-src 'none'; style-src 'unsafe-inline'`). |
| `GET /oauth/llm/callback/:state` | Public (one-time `state`) | Path-state receiver for OpenRouter (`?code=` or `?error=`). Shares exact handler and CSP-locked HTML template. |
| `POST /api/llm-auth/manual-callback` | Gateway token | **Remote/VPS/SSH fallback.** Body: `{ sessionId, callbackUrl }`. Parses `code`, `state`, `issued_client_id`, `error` from the pasted browser URL and runs the exact same completion pipeline. |
| `GET /api/llm-auth/session/:sessionId` | Gateway token | Returns `{ status: 'pending' | 'ready' | 'cancelled' | 'error' | 'expired', accountLabel?, error?, provider }` (never returns tokens). |
| `POST /api/llm-auth/cancel/:sessionId` | Gateway token | Drops a pending or staged session from memory. |
| `POST /api/llm-auth/disconnect/:connectionId` | Gateway token | Best-effort upstream revoke (if driver supports it), deletes `<data>/llm-oauth/<id>.json` (and key file for `key_exchange`), sets `auth_mode = 'api_key'`, `auth_status = 'none'`, broadcasts `{ type: 'connections_changed' }`. |

*(Both `gateway/src/web.ts` `RESERVED` list and `web/vite.config.ts` dev proxy already allow `/oauth/`.)*

---

## 6. Runtime Token Resolution & Single-Flight Refresh

### 6.1 Async Auth Hook in `llm.ts` & `llm-check.ts`
Extend `LlmTarget` cleanly without breaking existing callers:
```ts
export type AuthResolver = (opts?: { forceRefresh?: boolean }) => Promise<string>
export type LlmTarget = Pick<Config, 'baseURL' | 'apiKey' | 'model' | 'extraBody' | 'llmTimeoutMs' | 'llmRetries'> & {
  api?: LlmApi
  resolveAuth?: AuthResolver
}
```
- `postJson()` (shared by `createResponsesLLM` and OpenAI-compatible `createLLM`) resolves the Bearer token via `target.resolveAuth ? await target.resolveAuth() : target.apiKey`.
- On `HTTP 401`, if `target.resolveAuth` is provided and no refresh retry has occurred yet for this call, `postJson()` calls `await target.resolveAuth({ forceRefresh: true })` and retries the request **once** before failing.
- `llm-check.ts` (`checkConnection` and `listModels`) accepts the same optional `resolveAuth` so connection testing and `/models` listing automatically refresh expiring tokens.

### 6.2 Single-Flight Refresher (`gateway/src/llm-auth/refresh.ts`)
`createOAuthRefresher({ db, dataDir, hub, fetchImpl, now })` exposes `tokenFor(connectionId, { forceRefresh })`:
1. Loads `<data>/llm-oauth/<id>.json`. If missing, marks connection `expired` and throws `OAuthExpiredError`.
2. Fast path: if `!forceRefresh && session.expiresAt - now() > 60_000`, returns `session.accessToken` immediately without locking.
3. Mutex path: checks `inFlight.get(connectionId)`. If another teammate's request is already refreshing this connection, awaits the same Promise and receives the newly minted `accessToken`.
4. Only one caller invokes `driver.refresh(session, fetchImpl)`.
   - **On success:** Atomically writes the updated session (including any rotated `refreshToken`) to `<data>/llm-oauth/<id>.json`, ensures `auth_status = 'active'` and `auth_error = ''`, and resolves all waiting callers.
   - **On terminal auth failure (`invalid_grant`, `invalid_client`, HTTP `400`/`401`):** Updates DB/settings to `auth_status = 'expired'` (or `'revoked'`), persists a sanitized short `auth_error`, broadcasts `{ type: 'connections_changed' }` over `/ws`, and rejects waiting callers with `OAuthExpiredError`.
   - **On transient network/5xx failure:** Does **not** mark the account permanently expired; throws a retryable upstream error so the next turn can try again once connectivity recovers.

---

## 7. Phase 2 Design: Experimental Account Logins & Three-Layer Risk Guardrails

Phase 2 is intentionally deferred from Phase 1 implementation, but all schema columns, driver types, registry gating, and `runRoutine` hooks are designed now so Phase 2 plugs in without breaking migrations or refactors.

### 7.1 Planned Experimental Drivers

| Provider | Flow | Endpoints & Region | Specific Risk Disclosures | `routinePolicy` |
|---|---|---|---|---|
| **xAI (`xai`)** | `device_code` (RFC 8628 — avoids fixed port `56121` required by Grok CLI browser redirect, works on desktop & VPS) | `https://auth.x.ai` → `https://api.x.ai/v1` (existing Responses API) | Reuses Grok CLI public `client_id` (`b1a00492-073a-47ea-816f-4c329264a828`), not an open third-party client registration program; server-side allowlists may return `HTTP 403` on some SuperGrok / X Premium+ accounts (clear diagnostic prompts fallback to `XAI_API_KEY`). | `'warn'` |
| **Kimi (`kimi`)** | `device_code` (RFC 8628) | Explicit region picker at sign-in: `kimi.com/code` (CN) vs `kimi.ai/code` (Global) to prevent cross-region `invalid_grant` | Kimi Code guidelines limit usage to personal interactive workflows and prohibit unattended automation or User-Agent spoofing; background routines risk throttling or account suspension. | **`'block_default'`** |
| **MiniMax (`minimax-plan-cn`, `minimax-plan`)** | `browser_pkce` or `device_code` (**pre-implementation probe gate:** verify MiniMax Portal OAuth accepts independent open-source clients without partner-private credentials; if not, stay on existing M Plan dedicated API key) | `platform.minimax.cn` / `platform.minimax.io` | M Plan allows compatible tools but targets personal interactive development; high-volume production automation is directed to pay-as-you-go API keys. | `'warn'` |

### 7.2 Three-Layer Guardrail Enforcement (Frontend + Backend)

1. **Layer 1 — Global Opt-In Gate (`experimentalLlmOAuth`, default `false`):**
   - When `false`, `/api/providers` omits `oauth` metadata for any `tier === 'experimental'` driver, keeping the wizard and **AI models** completely clean for default users.
   - `POST /api/llm-auth/start` enforces server-side `403 { error: 'experimental_disabled' }` whenever `driver.tier === 'experimental'` and `experimentalLlmOAuth !== true`.
   - Operators opt in via **Settings → Experimental** (with a one-time global disclaimer). Deployments can permanently disable it via `OPENSUPERBOT_EXPERIMENTAL_LLM_OAUTH=0`.
2. **Layer 2 — Mandatory Per-Provider Risk Consent & Persistent Badge:**
   - Even when Layer 1 is enabled, experimental providers still default to the **API key** tab (opposite of official providers OpenAI / OpenRouter, which default to **Account sign-in**).
   - Switching to **Account sign-in (Experimental)** displays a provider-specific amber risk box detailing ToS restrictions, 403/breakage risk, and account-suspension exposure.
   - The sign-in button remains disabled until the operator checks "I understand the terms and account risks". The request includes `acknowledgedRiskVersion`, verified server-side against `driver.riskVersion`, and persisted in `experimental_ack_at`.
   - Active experimental OAuth connections display a persistent amber **Experimental** badge in `ModelsDialog`, `BotModelPicker`, and `ComputerPanel`.
3. **Layer 3 — Code-Enforced Routine Guard (`runRoutine()` in `gateway/src/server.ts`):**
   - Before starting any unattended `cron`, `watch`, or `webhook` turn, `runRoutine()` inspects the bot's resolved connection (`authMode`, `driver.routinePolicy`, `allowRoutines`):
     - If `authMode === 'oauth' && routinePolicy === 'block_default' && !allowRoutines`: the gateway **blocks execution before any LLM request is sent**, logs a skipped-by-policy action, and posts a concise localized notice in the teammate's thread instructing the operator either to assign a pay-as-you-go connection to that teammate or to explicitly opt into background routines on that connection.
     - Opting into routines on a `block_default` connection requires a dedicated secondary checkbox inside `ConnectionForm` ("Allow background routines on this experimental account (at your own risk)") setting `allow_routines = 1`.
   - In `ComputerPanel`, any routine belonging to a teammate bound to a blocked experimental connection displays an inline amber warning badge.

---

## 8. Frontend UX & Desktop Integration

### 8.1 First-Launch Setup Wizard (`web/src/components/SetupWizard.tsx`)
- **Provider grid step:** Keeps the exact same provider cards; adds a subtle pill badge on official OAuth providers:
  - `OpenAI`: `ChatGPT sign-in` / `ChatGPT 订阅`
  - `OpenRouter`: `Sign in` / `账号登录`
- **Credentials step:** For providers with an active OAuth driver:
  - Renders a compact two-tab switcher at the top: **Sign in with account** (default for `official`) | **API key** (default for `experimental` in Phase 2).
  - **Sign in tab:** Concise one-line explanation + primary button (**Sign in with ChatGPT** / **Sign in with OpenRouter**).
  - **Waiting state:** Calls `POST /api/llm-auth/start`, opens `authorizeUrl` via `window.open(url, '_blank', 'noopener')`, listens for `/ws` `llm_auth_session` (with 2s polling fallback against `GET /api/llm-auth/session/:sessionId`), shows **Re-open browser** and **Cancel**, plus a collapsible **"Browser didn't redirect back? Paste the callback URL"** input calling `POST /api/llm-auth/manual-callback`.
  - **Authorized state:** Displays `Signed in as <accountLabel>`, immediately triggers `POST /api/connections/test` with `authSessionId` to validate access and populate available models, then advances smoothly to the **Choose model** step.

### 8.2 AI Models Dialog (`web/src/components/ModelsDialog.tsx`)
- **Connection cards:**
  - `auth.mode === 'oauth'` shows `ChatGPT account · user@example.com` (or `OpenRouter account · sk-…`).
  - `auth.status === 'expired' | 'revoked'` shows a prominent warning strip with a one-click **Sign in again** button (`commit: true`).
  - Supports multiple connections per provider cleanly (e.g., `OpenAI (ChatGPT Plus)` + `OpenAI (API)`).
- **Connection form (`ConnectionForm`):**
  - Supports switching between **Sign in with account** and **API key**, signing out (`POST /api/llm-auth/disconnect/:id`), and honoring `locked` env fields on `main`.

### 8.3 Desktop App Parity (`desktop/src/security.ts`)
- No Electron preload changes are required: `window.open(authorizeUrl, '_blank', 'noopener')` already matches `windowOpenDecision → 'external'` and invokes `shell.openExternal()`, launching the user's real system browser (reusing existing ChatGPT/OpenRouter sessions & passkeys/2FA) and redirecting cleanly back to `http://127.0.0.1:<port>/oauth/llm/callback`.

---

## 9. Error Handling & Diagnostics

| Failure Scenario | Gateway Behavior | User-Facing Message |
|---|---|---|
| User cancels in browser (`?error=access_denied`) | Marks pending session `cancelled`; returns clean HTML callback page | Restores sign-in button with neutral "Sign-in cancelled" hint (no error banner) |
| Unknown / expired / replayed `state` | Consumes once; returns `404` HTML callback page; never mutates existing credentials | "This sign-in link has expired or was already used. Return to OpenSuperBot and try again." |
| Upstream timeout / unreachable (`auth.openai.com`) | Returns `502` / `504` structured code (`oauth_unreachable`, `oauth_timeout`) | Clear network/proxy hint with retry button |
| Token exchange rejected (`invalid_grant`, `invalid_request`) | Returns `422` (`oauth_exchange_failed`) with sanitized upstream error | Displays provider message; offers retry or switch to API key |
| ChatGPT plan ineligible or app usage cap reached (`402` / `429` / `insufficient_quota`) | Maps distinctly from `401` expiry in `llm-check.ts` and `llm.ts` | "ChatGPT plan limit reached or plan does not include API access. Check ChatGPT settings or use an API key." |
| Refresh token revoked / expired during background turn | Single-flight refresh catches `invalid_grant`, sets `auth_status = 'expired'`, broadcasts `connections_changed`, stops refresh loops | Thread shows "<Connection> sign-in expired — sign in again in AI models." |
| `main` connection locked by `OPENSUPERBOT_API_KEY` | Rejects `start` / `PATCH` with `400 locked` | Disables OAuth tab on `main` ("Controlled by OPENSUPERBOT_API_KEY; add another connection to use account sign-in") |

---

## 10. Verification & Testing Strategy

All automated tests inject mock `fetchImpl` and deterministic clocks — zero live network calls or flakiness.

### Gateway Tests (`gateway/test/`)
1. `llm-auth-store.test.ts`: Atomic writes, `0600` file mode & `0700` directory mode, `host-id` stability across reads, connection ID path validation, complete cleanup on provider switch / mode switch / connection delete.
2. `llm-auth-pendings.test.ts`: 15-minute TTL expiration, 32-entry cap eviction, one-time `state` consumption rejecting replay attempts, staged-grant single consumption.
3. `llm-auth-openai.test.ts`: First-time `dynamic_agent_client` + `agent_name_hint` + `ext_agent_host_id` + `127.0.0.1` loopback normalization; `issued_client_id` capture and reuse on re-auth (omitting `agent_name_hint`); PKCE `S256` token exchange; `id_token` email/name label extraction; refresh token rotation.
4. `llm-auth-openrouter.test.ts`: PKCE authorize URL with path-embedded `:state`, `POST /api/v1/auth/keys` exchange returning `sk-or-v1-…`, persistence into existing `llm-key` / `llm-keys/<id>`.
5. `llm-auth-refresh.test.ts`: 10 concurrent callers trigger exactly 1 upstream refresh (single-flight mutex); rotated refresh token persisted atomically; `postJson` single `401` retry with forced refresh; `invalid_grant` marks `expired`, broadcasts `connections_changed`, and prevents repeated refresh storms; transient `503` leaves status `active`.
6. `llm-auth-api.test.ts`: End-to-end Hono route tests covering `start`, `/oauth/llm/callback`, `/oauth/llm/callback/:state`, `manual-callback`, staged `test` + `create`/`patch`, `commit: true` re-auth, `disconnect`, `OPENSUPERBOT_API_KEY` lock rejection, Phase 2 `experimental_disabled` (`403`) gate, `acknowledgedRiskVersion` validation, and `runRoutine` `block_default` guardrail enforcement.

### Web Tests (`web/src/components/`)
1. `SetupWizard.test.tsx`: Provider badges (`OpenAI`, `OpenRouter`), default account-login tab, start → callback/WS ready → auto-test → model pick → save flow, manual callback URL paste fallback, switch back to API key, cancel cleanup.
2. `ModelsDialog.test.tsx`: Account label rendering, multiple same-provider connections (OAuth + API key), `expired` state with one-click re-auth, disconnect confirmation, `env`-locked `main` connection behavior.

### End-to-End & Packaging Verification
- `pnpm typecheck && pnpm test && pnpm build` all green across `gateway`, `web`, and `desktop`.
- Rebuild local macOS `.dmg` (`node desktop/scripts/stage.mjs` + `electron-builder`) and manually exercise real-browser **Sign in with ChatGPT** and **Sign in with OpenRouter** flows in the packaged desktop app.
