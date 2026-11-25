# Phase 9 设计规格：Wiki 自动按段沉淀、代码级变更校验与一搜双榜检索

**日期：** 2026-11-25  
**状态：** 已批准并实现（`feat/wiki-autosync`）  
**范围：** 升级零向量库团队实体知识库（`gateway/src/wiki/`）：（1）混合结构化 Markdown 按段修补器（`wiki_patch` 工具 + 网关代码确定性维护 `## Change Log` + 引用与未提及条目保留校验）；（2）`wiki_search` 原地升级一搜双榜（同时返回 `pages` 实体概览榜与按同事严格隔离的 `originals` 原始消息榜）；（3）线程静默 30 分钟后的 `P3 low` 低优自动增量沉淀（SQLite `v26` `wiki_sync_state`）及 `WikiDialog` 内「从对话同步」按钮。

---

## 1. 核心目标与安全不变量

1. **零维护自动积累：** 对话中出现的联系人、客户、项目与主题事实，在线程安静满 30 分钟后（或点击弹窗「从对话同步」时）自动走本地 `P3 low` 优先级提取入库，绝不抢占前台对话算力。
2. **无损按段增量更新：** 通过 `gateway/src/wiki/sections.ts` 在代码层强校验分段补丁——重写 `## Overview` 必须附带理由并保留原有 `#msg:<id>` 来源引用（除非在 `droppedCitations` 中注明移除原因）；受管列表段（`## Key Facts`、`## Open Items`、`## Decisions`）按稳定短 ID（`[f1]`、`[o1]`、`[d1]`）增删改，未提及条目逐字原样保留；自定义 Markdown 段落与表格原封不动保留；`## Change Log` 仅由网关代码写入并保留最新 20 条。
3. **跨同事私聊严格隔离：** `wiki_search` 新增返回的 `originals` 原始记录榜严格限定在 `accessibleThreadIds(db, botId)`（仅当前同事私聊及所属群聊），杜绝跨同事私聊泄漏。
4. **单调 `outside-data` 污点传播与密钥脱敏：** 凡线程同步窗口接触过 `webhook`、带污点转发、外部工具读取或 `pending_taint = 1`，生成的 Wiki 页一律标记 `source_tainted = 1`；所有非操作者写入内容均经 `scrubWikiSecrets` 自动脱敏常见 API Key 与 Bearer Token。

---

## 2. Schema `v26`（`gateway/src/db.ts`）

```sql
CREATE TABLE IF NOT EXISTS wiki_sync_state (
  thread_id TEXT PRIMARY KEY,
  last_synced_message_id INTEGER NOT NULL DEFAULT 0,
  pending_taint INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

---

## 3. 关键模块落点

- `gateway/src/wiki/sections.ts`：CommonMark 代码围栏感知解析、混合分段合并、引用保留校验、列表超 20 条归档、代码级 `## Change Log` 与密钥脱敏。
- `gateway/src/history-search.ts` & `gateway/src/wiki/tools.ts`：`searchAccessibleHistoryRrf` 多查询 RRF 历史检索、`wiki_search` 双榜输出与 `wiki_patch` 工具（开放给常规回合与 `prepare`，`watch` 禁用）。
- `gateway/src/wiki/auto-sync.ts` & `gateway/src/wiki/api.ts`：30 分钟静默自动同步、`POST /api/wiki/sync` 手动强制多批排空、关闭信号优雅中断。
- `web/src/components/WikiDialog.tsx`：顶栏「从对话同步 / Sync from chats」按钮、并发刷新竞态保护与中英双语提示。
