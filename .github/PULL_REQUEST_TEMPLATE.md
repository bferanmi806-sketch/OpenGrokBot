## Summary

<!-- What does this PR change, and why? Link any related issue (e.g. Refs #1). -->

## Security & boundary check

- [ ] Keeps credentials, tokens, and `MEMORY.md` outside bot workspaces and model prompts
- [ ] Outbound / state-changing actions go through the approval gate and action log
- [ ] English (`web/src/i18n/en.ts`) and Chinese (`web/src/i18n/zh-CN.ts`) strings stay in sync (if UI changed)

## Verification

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
