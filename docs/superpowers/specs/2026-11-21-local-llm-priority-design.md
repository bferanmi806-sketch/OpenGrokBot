# Phase 6 Design Spec: Local LLM Priority Semaphore Queue

Date: 2026-11-21  
Branch: `feat/local-llm-priority`  
Base: `main` (`ce318fc`)

## 1. Goal

Prevent local model GPU/memory contention (Ollama, LM Studio, llama.cpp, vLLM, or self-hosted LAN endpoints) when multiple teammates run scheduled routines, webhooks, handoffs, and interactive chats simultaneously — ensuring interactive operator turns always cut to the front of the line between LLM steps while adding zero overhead to cloud APIs.

---

## 2. Core Design

### 2.1 Priority Tiers (`LlmPriority`)

Four strictly ordered tiers (`rank ASC`, FIFO `seq ASC` within each tier):

| Rank | Priority Name | Used For |
|------|---------------|----------|
| `0` (`P0`) | `'interactive'` | Operator DM messages, group turns, approval resumptions, operator question answers, manual `POST /api/routines/:id/run` (`force: true`) |
| `1` (`P1`) | `'background'` | Teammate A2A relays (`origin: 'relay'`), webhook routines (`origin: 'webhook'`), and Phase 7 background tasks |
| `2` (`P2`) | `'routine'` | Scheduled `act` / `watch` / `prepare` routines (`origin: 'routine'`) |
| `3` (`P3`) | `'low'` | Low-priority maintenance / digest / reflection tasks |

### 2.2 Per-Step Granularity (Preemption Between Steps)

The semaphore wraps each individual `LLM.chat(...)` call — NOT an entire 40-step agent turn.
- If a scheduled `watch` routine (`P2`) is in the middle of step 3 of 10 and the operator sends a message (`P0`), the `P0` call cuts ahead of step 4 as soon as step 3 completes.
- Because the semaphore wraps `llm.chat(...)` *outside* `postJson`'s `AbortSignal.timeout(llmTimeoutMs)`, time spent waiting in the local queue does not prematurely consume the HTTP request timeout.

### 2.3 Automatic Local Endpoint Detection (`localEndpointKey`)

`localEndpointKey(baseURL: string): string | null` classifies URLs (strictly `http:` / `https:`):
- **Loopback / container-host aliases** → shared key `local:loopback:<port>` (so `http://localhost:11434/v1`, `http://127.0.0.1:11434/v1`, and `http://[::1]:11434/v1` share the same GPU semaphore!):
  - `localhost`, `*.localhost`
  - `127.0.0.0/8`, `0.0.0.0`
  - `::1`, `::`
  - IPv4-mapped IPv6 loopback (`::ffff:127.x.x.x` / WHATWG hex `::ffff:7fxx:xxxx` and `::ffff:0.0.0.0` / `::ffff:0:0`)
  - `host.docker.internal`, `host.containers.internal`
- **Private LAN & mDNS self-hosted servers** → per-host key:
  - `*.local` → `local:mdns:<host>:<port>`
  - RFC-1918 IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), IPv4 link-local (`169.254.0.0/16`), and their IPv4-mapped IPv6 forms (both dotted and hex) → `local:lan:<canonical-ip>:<port>`
  - IPv6 ULA (`fc00::/7`) and link-local (`fe80::/10`) → `local:lan:[<ipv6>]:<port>`
- **Public cloud endpoints** (`api.openai.com`, `api.anthropic.com`, `api.deepseek.com`, etc.) → `null` (completely bypasses the queue; zero overhead).
- **`model === 'stub'`** → always bypasses the queue.

### 2.4 Configuration & Dynamic Concurrency (`localLlmConcurrency`)

- Setting & Config key: `localLlmConcurrency`
  - Default: `1` (strict single-slot serialization per local endpoint — avoids Ollama model swap and KV-cache thrashing).
  - Valid values: integer `0..8` (`0` = unlimited / queue disabled; `1..8` = max concurrent in-flight requests per local endpoint key).
  - Environment variable override: `OPENSUPERBOT_LOCAL_LLM_CONCURRENCY` (locks UI setting like other env-backed settings).
- When `localLlmConcurrency` is raised (or set to `0`) via `PUT /api/settings`, `llmQueue.notifyConcurrencyChange()` immediately wakes queued waiters up to the new limit.

### 2.5 Cancellation & Leak Safety

- If `signal` is already aborted before acquiring a slot, `run()` rejects immediately with `AbortError` without entering the queue.
- If `signal` aborts while queued, the waiter is synchronously removed from the wait queue, its `abort` listener is detached, and it rejects with `AbortError` without ever calling the underlying `LLM.chat`.
- When an in-flight call finishes or throws, `finally` decrements `active`, pumps the highest-priority non-aborted waiter, and deletes the lane entry when `active === 0 && waiters.length === 0`.

### 2.6 Observability (`GET /api/llm-queue`)

```ts
export type LlmQueueEndpointView = {
  key: string
  active: number
  queued: number
  byPriority: Record<LlmPriority, number>
}
export type LlmQueueSnapshot = {
  concurrency: number
  endpoints: LlmQueueEndpointView[]
}
```

- Exposed at `GET /api/llm-queue` (authenticated like all `/api/*` endpoints).
- Displayed in `SettingsDialog` alongside the Local model concurrency selector (gracefully `.catch(() => null)` for older gateways).
