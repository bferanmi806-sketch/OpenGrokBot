# Security Policy

## Architecture & Enforced Boundaries

Before filing a report, please read **[docs/security.md](docs/security.md)**, which documents in detail:

- **What is enforced in code** (gateway token auth, loopback binding, same-origin + JSON CSRF gates, per-bot workspace confinement, `http(s)`-only `browser_goto`, read-only `watch` routines, operator-only standing rule / routine tools, Seatbelt / bubblewrap command sandboxes, per-container tokens, Electron renderer sandboxing and origin-checked IPC).
- **What is a convention rather than a sandbox wall** (e.g. `hold_for_approval` relies on model instruction discipline when a teammate already has an authenticated browser session, which is why teammates should be given dedicated accounts).

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities (such as authentication bypasses, cross-site request forgery against the gateway, sandbox or workspace escapes, secret exposure, or Electron privilege escalation).

Instead, report vulnerabilities privately through **[GitHub Private Vulnerability Reporting](https://github.com/wolfqing/OpenSuperBot/security/advisories/new)**.

Include:

1. Affected version or commit, and operating system (`macOS`, `Linux`, `Windows`, Docker vs. local computer, desktop app vs. source).
2. Minimal reproduction steps or proof-of-concept.
3. Which enforced boundary in [docs/security.md](docs/security.md) is crossed and what impact follows.

We aim to acknowledge reports within 72 hours and ship a fix with regression tests before public disclosure.
