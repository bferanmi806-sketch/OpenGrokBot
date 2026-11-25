# Phase 11 实施计划：「突然想起（Flashback）」联想式历史召回

**日期：** 2026-11-25  
**规格文档：** `docs/superpowers/specs/2026-11-25-flashback-design.md`  
**分支：** `feat/flashback`

---

## 任务 1：Schema `v28` 迁移（`gateway/src/db.ts` & `gateway/test/db.test.ts`）

**涉及文件：**
- 修改 `gateway/src/db.ts`：在 `MIGRATIONS` 末尾追加第 `v28` 步，创建 `flashback_state` 表（主键 `(thread_id, bot_id)`，包含 `last_recalled_at`、`last_user_message_id`、`recalled_items_json`、`updated_at`）。
- 修改 `gateway/test/db.test.ts`：断言 `SCHEMA_VERSION === 28`，并补充 `v27 → v28` 迁移建表测试。

---

## 任务 2：联想召回核心引擎（`gateway/src/flashback.ts` & `gateway/test/flashback.test.ts`）

**涉及文件：**
- 新建 `gateway/src/flashback.ts`：
  - `extractFlashbackQueries(userText)`：剥离三反引号代码块与 URL，过滤中英文高频寒暄/虚词停用词，抽取高区分度中文实义词组与拉丁/数字专有词（上限 4 组查询串）；短句与纯寒暄直接返回空数组。
  - 双层冷却管理（`isFlashbackThreadReady` / `recordFlashbackState`）：线程级满足 15 分钟（`15 * 60_000`）或至少新增 4 条用户文本消息后放行；条目级过滤 24 小时（`24 * 60 * 60_000`）内已召回的 `wiki:<pageId>` 与 `msg:<messageId>`，并在写入时裁剪过期与超量键（上限 60 个）。
  - 可信双源 RRF 检索：
    1. 未污染团队 Wiki（`archived_at IS NULL AND source_tainted = 0`）：多查询 RRF × 时间衰减，校验实义词命中与最低分数阈值（`>= 0.012`），上限 2 条。
    2. 窗口外干净历史消息（`accessibleThreadIds(db, botId)`）：排除当前上下文窗口内消息 `excludeMessageIds`，仅限 `kind IN ('text', 'report', 'memory_updated')` 且长度 `>= 16`，严格排除落入外部工具 `actions`、前序 40 条含 `webhook` / 受污染 `bot_ref`、`proactive_deferred.source_tainted = 1` 或 `proactive_thread_taint` / `thread_checkpoints.had_webhook` 污染窗口内的助手输出，要求至少命中 2 个不同实义词元或 `>= 4` 字符专有词/`>= 3` 汉字专名，上限 2 条（与 Wiki 合计上限 3 条）。
  - 随机 Nonce 只读围栏格式化：经 `scrubWikiSecrets` 脱敏并转义 `< /? historical_context` 闭合伪造，生成 `<historical_context_${nonce} source="flashback" trust="internal-untainted" mode="read-only-reference">` 块（总长 `<= 1_200` 字符）；全程 `try/catch` 静默降级。
- 新建 `gateway/test/flashback.test.ts`：完整覆盖实义词抽取/寒暄跳过、Wiki 与窗口外群聊/私聊召回、窗口内去重、跨同事隔离、污染页面与污染消息 100% 剔除、双层冷却（15 分钟 / 4 轮 / 24 小时单条目）、密钥脱敏与闭合标签防逃逸。

---

## 任务 3：主对话回合尾部挂载与安全文档（`gateway/src/agent.ts` & `docs/security.md`）

**涉及文件：**
- 修改 `gateway/src/agent.ts`：
  - `AgentDeps` 增加可选 `flashback?: boolean`（默认在 `origin === 'operator'`、`effectiveMode === 'act'`、`!isBackgroundTask`、`!isPipelineStep` 时启用）。
  - 在 `rows` 压缩/截断并构建 `messages = buildTimed(rows, checkpoint)` 之后、进入 `step` 循环之前，以当前窗口消息 ID 集（含刚插入的本轮用户消息）调用 `recallFlashbackContext`；命中时追加至内存 `messages` 末尾（不写 `messages` 表，不污染 `ctx.turnTainted` / `ctx.ruleBlock`，100% 保留 KV 热缓存前缀）。
- 修改 `gateway/test/flashback.test.ts`：增加通过 `runAgentTurn` 的端到端集成测试，验证尾部注入位置、下一回合历史前缀零残留、以及命中联想后常驻审批规则依然正常放行（`ruleBlock === null`）。
- 修改 `docs/security.md`：补充中文安全说明，记录 Flashback 的未污染源硬过滤、跨同事会话隔离与随机 Nonce 只读围栏边界。
