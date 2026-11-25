# Phase 9 实施计划：Wiki 自动按段沉淀、代码级变更校验与一搜双榜检索

**日期：** 2026-11-25  
**规格文档：** `docs/superpowers/specs/2026-11-25-wiki-autosync-design.md`  
**分支：** `feat/wiki-autosync`

---

## 任务 1：Schema `v26`、密钥脱敏器与混合分段修补器（`gateway`）
- `gateway/src/db.ts`：追加 `v26` 迁移表 `wiki_sync_state`（含 `last_synced_message_id` 与 `pending_taint`）。
- `gateway/src/wiki/sections.ts`：实现 `scrubWikiSecrets`、`parseWikiSections` 与 `applyWikiSectionPatch`（保留前言与自定义段落/表格、校验 `Overview` 重写理由与 `#msg:<id>` 引用、管理 `[f*]`/`[o*]`/`[d*]` 条目并归档超限旧项、由代码维护最新 20 条 `## Change Log`）。
- `gateway/src/wiki/store.ts`：新增事务级 `patchWikiPage` 并覆盖单元测试 `gateway/test/wiki-sections.test.ts`。

## 任务 2：一搜双榜 `wiki_search` 与 `wiki_patch` 工具（`gateway`）
- `gateway/src/history-search.ts`：新增 `searchAccessibleHistoryRrf`（严格按 `accessibleThreadIds(db, botId)` 隔离，支持 1–6 词 RRF 融合与中文短词回退）。
- `gateway/src/wiki/tools.ts`、`tools.ts`、`agent.ts`、`prompts.ts`：升级 `wiki_search` 返回 `{ total, pages, originalsTotal, originals }`，新增 `wiki_patch` 并接入 `prepare` 白名单与系统提示词，补齐 `gateway/test/wiki-dual-search.test.ts`。

## 任务 3：`P3` 闲时自动沉淀与 `POST /api/wiki/sync`（`gateway`）
- `gateway/src/wiki/auto-sync.ts`：实现 30 分钟静默判定、琐碎短消息免调模型快进、`priority: 'low'` 提取、多通道污点传播、手动多批排空与退出中止。
- `gateway/src/wiki/api.ts`、`server.ts`、`main.ts`：挂载 `POST /api/wiki/sync` 与 5 分钟后台巡检定时器，补齐 `gateway/test/wiki-autosync.test.ts`。

## 任务 4：`WikiDialog` 同步按钮、双语文案与安全文档（`web` + `docs`）
- `web/src/types.ts`、`api.ts`、`WikiDialog.tsx`、`en.ts`、`zh-CN.ts`：新增「从对话同步」按钮、并发刷新保护、`auto-sync` 更新者展示与双语提示，补齐 `WikiDialog.test.tsx` 与 `docs/security.md`。
