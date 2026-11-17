# Contributing to OpenSuperBot

Focused pull requests and clear bug reports are welcome. Keep changes small, self-hosted, and honest about security boundaries.

## Development Setup

Requirements: **Node.js 22+** (see `.nvmrc`) and **pnpm 10+** (`corepack enable`). Docker is optional unless you are working on `docker/bot` or container computers.

```bash
pnpm install
OPENSUPERBOT_MODEL=stub pnpm dev
```

- Gateway runs on `http://127.0.0.1:4747` (prints a one-time sign-in link on first start).
- Web dev server runs on `http://localhost:5173`.
- To run the Electron desktop shell from source:
  ```bash
  pnpm --filter @opensuperbot/desktop install-electron
  pnpm desktop
  ```

## Before Opening a PR

Run the full check suite from the repository root:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @opensuperbot/desktop build
```

If your change touches local computers, browser automation, or desktop packaging, also run the relevant smoke script when possible:

- Local computer smoke: `pnpm --filter @opensuperbot/gateway run smoke:local`
- Docker computer smoke: `pnpm --filter @opensuperbot/gateway run smoke:docker`
- Packaged desktop smoke: `pnpm desktop:package && pnpm run smoke:desktop`

## Conventions

- **Custody first.** OpenSuperBot runs strictly on the operator's own hardware with zero third-party cloud middlemen, telemetry, or hosted relays.
- **Security boundaries need tests.** Any change to auth, `browser_goto`, `workspacePath`, sandboxes, approvals, routines, uploads, or Electron IPC/navigation must include unit tests covering the boundary and keep [docs/security.md](docs/security.md) accurate.
- **Bilingual UI (`en` + `zh-CN`).** Every UI string added to `web/src/i18n/en.ts` must have a matching translation in `web/src/i18n/zh-CN.ts` with identical `{placeholder}` names, following [web/src/i18n/GLOSSARY.md](web/src/i18n/GLOSSARY.md).
- **One concern per PR.** For larger features (such as [teach-mode #1](https://github.com/wolfqing/OpenSuperBot/issues/1)), discuss the shape in an issue before writing code and split the work into reviewable slices.
