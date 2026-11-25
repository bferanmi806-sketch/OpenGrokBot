# Phase 10 实施计划：对话反馈受控学习（`Clue → RuleProposal`）与主动提醒节奏控制

**日期：** 2026-11-25  
**规格文档：** `docs/superpowers/specs/2026-11-25-proactive-dreaming-v2-design.md`  
**分支：** `feat/proactive-dreaming-v2`

---

## 任务 1：Schema `v27` 与 `RuleProposalSource` 扩展（`gateway`）

**涉及文件：**
- 修改 `gateway/src/db.ts`：追加第 `v27` 步迁移，创建三张表及索引：
  - `proactive_clues`（线索池，唯一键 `(bot_id, area_key, time_window, leaning)`）
  - `proactive_dream_state`（已评估主动消息游标表）
  - `proactive_deferred`（3 分钟活跃聊天暂缓投递队列表）
- 修改 `gateway/src/proactive/rule-proposals.ts`：将 `RuleProposalSource` 扩展为 `'agent' | 'discard_pattern' | 'dreaming'`，更新 `formatProposalView` 映射。
- 修改 `gateway/test/db.test.ts`：补充 `v26 → v27` 迁移断言。

---

## 任务 2：对话反馈受控学习引擎（`gateway/src/proactive/dreaming.ts`）

**涉及文件：**
- 新建 `gateway/src/proactive/dreaming.ts`：
  - 线索池存取：`listProactiveClues`、`upsertProactiveClue`（反向倾向自动替换、单同事 30 条上限裁剪、单调 `source_tainted` 保留）、`deleteProactiveClue`。
  - 主动窗口扫描：定位 `dm:<botId>` 中由 `routine` / `watch` / `prepare` / `webhook` / `quiet_digest` 产生的主动消息 `M` 及后续 ≤ 20 条消息（含新增操作者回复，自动模式下要求线程空闲且静默满 15 分钟）。
  - 低优模型复盘（`priority: 'low'` + `AbortSignal`）：严格排除内容好恶、办结状态和致谢回复；对带 `timeWindow` 的 `stay_silent` 强制降级为 `follow_up_later`；所有文本经 `scrubWikiSecrets` 脱敏。
  - 两级晋升：`explicitRule === true` 或 `seen_count >= 2` 时调用 `createRuleProposal(..., { source: 'dreaming' })` 投递可编辑规矩提议卡片并消费对应线索；LLM 成功后推进 `proactive_dream_state` 游标；内置单实例互斥锁并支持 `force: true` 排队续跑。
- 新建 `gateway/test/proactive-dreaming.test.ts`：完整覆盖线索累积、二次晋升、显式直达、内容评价忽略、夜间时间窗保护、反向倾向替换、污点传播与 `P3` 队列优先级。

---

## 任务 3：三维主动投递节奏控制与网关挂载（`gateway/src/proactive/pacing.ts` & `server.ts` & `main.ts`）

**涉及文件：**
- 新建 `gateway/src/proactive/pacing.ts`：
  - `createWebhookCoalescer`：同一 `routine.id` 60 秒窗口合并最多 10 条 Webhook 事件（总长 ≤ 256 KB），支持在运行中安全入桶待空闲后触发，支持 `stopAll()` 清空定时器。
  - `enqueueDeferredProactive` / `flushDeferredProactive`：当线程忙于交互或操作者 3 分钟内刚发言时，将非紧急产出持久化至 `proactive_deferred`；静默满 3 分钟后补发（若期间进入免打扰或超日上限则平滑转入 `quiet_digest_items` / `Feed`）。
  - 每日非紧急提醒计数与上限分流（默认 `5` 条/同事/本地自然日）：超额自动写入 `quiet_digest_items`（及 `Feed`），`urgent: true`、审批、提问、登录与手动 `force: true` 永不拦截。
- 修改 `gateway/src/agent.ts`、`gateway/src/server.ts`、`gateway/src/main.ts`：
  - `agent.ts` 新增 `interceptProactiveOutput` 钩子拦截非紧急主动 `'text'` / `'report'` 输出。
  - `server.ts` 新增 `proactivePacing` 配置（`main.ts` 默认开启 `true`；历史单测未传时默认关闭以保持同步确定性），暴露 `runProactiveDreaming`、`flushDeferredProactiveIfDue` 及管理端点 `POST /api/proactive/dream`、`POST /api/proactive/flush-deferred`，并在 `stopAll()` 中中止与清理。
  - `main.ts` 注册 30 秒延后补发定时器与 10 分钟 Dreaming 低优巡检定时器，退出时有序清理。
- 新建 `gateway/test/proactive-pacing.test.ts`：覆盖 60 秒 Webhook 合并、运行中突发入桶、3 分钟活跃聊天暂缓与重启恢复、每日 5 条上限分流及 `urgent: true` 立即穿透。

---

## 任务 4：`RuleProposalChip` 双语标签、前端测试与安全文档（`web` + `docs`）

**涉及文件：**
- 修改 `web/src/types.ts`：同步扩展 `RuleProposalSource = 'agent' | 'discard_pattern' | 'dreaming'`。
- 修改 `web/src/i18n/en.ts` 与 `web/src/i18n/zh-CN.ts`：新增 `'ruleProposal.sourceDreaming'`（`'Suggested from your feedback'` / `'根据你的对话反馈提议'`）。
- 修改 `web/src/components/RuleProposalChip.tsx`：支持 `'dreaming'` 来源标签展示。
- 修改前端测试（`web/src/components/` 与 `web/src/i18n/i18n.test.tsx`）及 `docs/security.md`：验证双语渲染与键值对齐，记录对话反馈受控学习及主动节奏门禁边界。
