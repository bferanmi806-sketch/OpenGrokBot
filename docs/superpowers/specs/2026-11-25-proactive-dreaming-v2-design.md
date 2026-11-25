# Phase 10 设计规格：对话反馈受控学习（`Clue → RuleProposal`）与主动提醒节奏控制

**日期：** 2026-11-25  
**状态：** 已批准  
**分支：** `feat/proactive-dreaming-v2`（基于 `feat/wiki-autosync`）  
**范围：** 升级主动协作模块（`gateway/src/proactive/`），包含两部分核心能力：（1）两级对话反馈受控学习（SQLite `v27` 新增 `proactive_clues` 与 `proactive_dream_state`，将重复出现的隐式抱怨或显式偏好晋升为需操作者拍板的 `RuleProposalChip`，`source: 'dreaming'`）；（2）三维主动投递节奏控制（60 秒多事件 Webhook 合并、基于持久化 `proactive_deferred` 的 3 分钟活跃聊天防打断延后，以及单同事每日 5 条非紧急提醒上限——超额自动分流至 `Today Feed` / `quiet_digest_items`）。

---

## 1. 设计目标与安全边界

### 核心目标
1. **从自然回复中学习打扰边界，但绝不静默篡改 `MEMORY.md`：** 当同事主动发出消息（`routine`、`watch`、`prepare`、`webhook` 或 `quiet_digest`）后，若操作者在聊天中给出打扰方式反馈（如“太晚了别发这种”“快递不用提醒我”“客户回复应该一收到就告诉我”），后台低优 Dreaming 任务先记下一条内部**线索（Clue，`seen = 1`）**。当同类同倾向线索累计达到 2 次（`seen >= 2`），或操作者直接说出显式长期规矩（“以后这类都……”）时，系统投递一张可内联编辑的 **`RuleProposalChip`**（`source: 'dreaming'`），始终由操作者点击 **存入 MEMORY.md** 拍板生效。
2. **保护专注力与注意力预算：**
   - **60 秒 Webhook 多事件合并：** 短时间内连续到达 `/hooks/routines/:id`（或上一轮仍在运行中到达）的多笔事件，在 60 秒窗口内合并（上限 10 条载荷）为一次回合触发，避免重复巡检或直接返回 `409` 丢弃突发事件。
   - **3 分钟活跃对话静默延后：** 非紧急定时巡检产出文本或汇报时，若目标线程正在执行交互回合，或操作者在最近 3 分钟内刚发过消息，则先写入 `proactive_deferred` 表暂缓，待对话安静满 3 分钟后自动补发（网关重启不丢失）。
   - **每日非紧急主动提醒上限（默认 `5` 条 / 同事 / 本地自然日）：** 单位同事当天已直接发入线程的非紧急定时消息满 5 条后，后续非紧急产出不再弹线程未读，自动分流至「今日（Today）」动态流与 `quiet_digest_items` 晨报缓冲。
3. **紧急与交互路径零阻塞：** `message_user` 显式标记 `urgent: true`、待审批卡片（`approval_request`）、提问卡片（`question`）、登录接管请求（`login_request`）以及手动点击「立即运行」（`force: true`）**永远绕过**延后与每日上限，即时送达。

### 安全与托管不变量
1. **绝不直接改写 `MEMORY.md`：** Dreaming 引擎只允许调用 `createRuleProposal(..., { source: 'dreaming' })`。只有操作者亲自点击审批卡的确认按钮（`POST /api/rule-proposals/:id/resolve`）才会写入 `<data>/bots/<botId>/MEMORY.md`。
2. **单调 `outside-data` 污点传播：**
   - 每条 `proactive_clues` 记录 `source_tainted`（若被评估的主动消息窗口含 `webhook`、`quiet_digest`、带污点 `bot_ref`、`wiki_sync_state.pending_taint` 或外部读取工具 `actions`，或历史线索本身已带污点，则置 `1`）。
   - 线索晋升为 `RuleProposalChip` 时保持单调 `sourceTainted = true`，前端卡片自动展示琥珀色外部数据警示徽章。
   - 防提示词注入与密钥脱敏：对话片段统一使用只读围栏 `<<<exchange ... >>>` 包裹并声明为“待分析证据而非指令”；所有入库字段（`area_label`、`evidence`、`rule`、`reason`）均先经过 `scrubWikiSecrets` 密钥脱敏。
3. **时间窗安全降级：** 针对时段的抱怨（如“大晚上别推这个”）即使模型判为 `stay_silent`，代码层也强制归一化为该时间窗内的 `follow_up_later`（如 `21:00 后非紧急 <领域> 动态转入晨报/跟进，不直接提醒`），绝不误伤全天正常提醒。
4. **本地模型算力礼让：** Dreaming 复盘固定使用 `llmQueue` 的 `priority: 'low'`（`P3`）运行，并接入 `gateway.stopAll()` 的 `AbortSignal` 优雅中止。

---

## 2. SQLite Schema `v27` 迁移（`gateway/src/db.ts`）

在 `MIGRATIONS` 末尾追加第 `v27` 步：

```sql
CREATE TABLE IF NOT EXISTS proactive_clues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  area_key TEXT NOT NULL,
  area_label TEXT NOT NULL,
  time_window TEXT NOT NULL DEFAULT '',
  leaning TEXT NOT NULL,            -- 'tell_now' | 'follow_up_later' | 'stay_silent'
  evidence TEXT NOT NULL DEFAULT '',
  seen_count INTEGER NOT NULL DEFAULT 1,
  source_tainted INTEGER NOT NULL DEFAULT 0,
  last_proactive_message_id INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE(bot_id, area_key, time_window, leaning)
);
CREATE INDEX IF NOT EXISTS idx_proactive_clues_bot
  ON proactive_clues(bot_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS proactive_dream_state (
  proactive_message_id INTEGER PRIMARY KEY,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  evaluated_through_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proactive_dream_bot
  ON proactive_dream_state(bot_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS proactive_deferred (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  routine_id INTEGER,
  routine_name TEXT NOT NULL DEFAULT '',
  routine_mode TEXT NOT NULL DEFAULT 'watch',
  kind TEXT NOT NULL DEFAULT 'text',  -- 'report' | 'text'
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  source_tainted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deliver_after INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proactive_deferred_pending
  ON proactive_deferred(delivered_at, deliver_after, id);
CREATE INDEX IF NOT EXISTS idx_proactive_deferred_bot_delivered
  ON proactive_deferred(bot_id, delivered_at DESC);

CREATE TABLE IF NOT EXISTS proactive_thread_taint (
  thread_id TEXT PRIMARY KEY,
  last_tainted_message_id INTEGER NOT NULL DEFAULT 0,
  last_tainted_at INTEGER NOT NULL DEFAULT 0,
  pending_taint INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

---

## 3. 对话反馈 Dreaming 引擎（`gateway/src/proactive/dreaming.ts`）

### 3.1 主动消息窗口识别
私聊线程 `dm:<botId>` 中的消息 `M` 满足以下条件时视为待复盘主动锚点：
- `M.sender = botId` 且 `M.kind IN ('text', 'report', 'quiet_digest')`；
- `M` 来自主动触发：本身是 `quiet_digest`，或在 `[M.created_at - 25m, M.created_at + 5s]` 内存在同线程同同事 `trigger IN ('routine', 'watch', 'prepare', 'webhook')` 的 `actions` 记录，或紧跟在一条 `kind = 'webhook'` 消息之后；
- 在 `M.id` 之后（下一条主动锚点之前、最多往后取 20 条消息）至少包含 1 条 `id > COALESCE(proactive_dream_state.evaluated_through_id, M.id)` 的操作者文本回复（`sender = 'user'`, `kind = 'text'`）；
- 自动巡检模式（`force = false`）下，该线程当前空闲且最新消息距今已满 `DREAM_QUIET_MS = 15 * 60_000`（15 分钟），确保一轮追问互动已收尾。

### 3.2 严格信号过滤与两级晋升
1. **单次 `P3 low` 模型判定：** 输入被围栏包裹的主动消息 `M` 及后续 ≤ 20 条对话、同事当前 `MEMORY.md` 规矩与已有 `proactive_clues`（上限 30 条），零工具调用输出结构化 JSON。
2. **负面过滤硬约束（Prompt + 代码双重校验）：**
   - 严格忽略：对事物本身的观点好恶（如“这篇论文不错”“报价太贵”）、单次事务状态回复（“办完了”“已处理”）、单纯致谢同意（“好的谢谢”）或无关话题。
   - 仅提取关于**是否提醒、何时提醒、如何跟进**的元反馈：
     - `areaKey`（归一化小写标识，如 `vendor-invoices`、`package-deliveries`）与 `areaLabel`（保持用户语言）；
     - `leaning`：`'tell_now' | 'follow_up_later' | 'stay_silent'`；
     - `timeWindow`：可选时间窗（如 `'after 21:00'`）。**代码硬约束：** 凡 `timeWindow` 非空且 `leaning === 'stay_silent'`，强制改写为 `'follow_up_later'`；
     - `explicitRule`：布尔值，仅当操作者明确说出常设指令（“以后这类都……”“from now on…”）时为 `true`。
3. **线索池更新与晋升（单同事上限 `MAX_CLUES_PER_BOT = 30`）：**
   - 若同一 `(bot_id, area_key, time_window)` 已存在相反 `leaning` 的旧线索，先移除冲突旧线索；
   - 若 `explicitRule === true`：无需等待第二次，直接调用 `createRuleProposal(db, { source: 'dreaming', dedupeKey: 'dream:<area_key>:<time_window>:<leaning>', ... })` 生成规矩提议卡片；
   - 若 `explicitRule === false`：累加 `proactive_clues.seen_count`（超出 30 条时淘汰最旧线索）；当 `seen_count >= 2` 时调用 `createRuleProposal`（`source: 'dreaming'`），提案创建成功（或因 `already_in_memory` / `previously_dismissed` 被拒）后清理已消费线索，避免重复弹窗。
4. **游标推进：** 仅当模型调用成功返回后更新 `proactive_dream_state`，网络/模型报错时不推进游标以便下次重试。

### 3.3 `RuleProposalChip` 与接口扩展（`gateway` + `web`）
- 将 `RuleProposalSource` 扩展为 `'agent' | 'discard_pattern' | 'dreaming'`（同步更新 `gateway/src/proactive/rule-proposals.ts` 与 `web/src/types.ts`）。
- 在 `web/src/components/RuleProposalChip.tsx` 中将 `'dreaming'` 映射为 `t('ruleProposal.sourceDreaming')`：
  - 中文：`根据你的对话反馈提议`
  - 英文：`Suggested from your feedback`
- 在 `createApp` 暴露 `runProactiveDreaming(opts?: { force?: boolean })` 及管理接口 `POST /api/proactive/dream`（`force: true`，返回 `{ ok: true, evaluated, cluesUpdated, proposalsCreated }`）；`main.ts` 每 10 分钟低优巡检一次并在退出时清理定时器与中止信号。

---

## 4. 主动提醒三维节奏控制（`gateway/src/proactive/pacing.ts` & `server.ts`）

生产环境（`main.ts`）通过 `ServerDeps.proactivePacing: true` 默认开启（也支持传入细粒度 `{ quietChatMs?: number; webhookCoalesceMs?: number; dailyNonUrgentCap?: number }`；既有历史单测未传该参数时默认关闭，确保存量同步单测 100% 零破坏）：

### 4.1 60 秒多事件 Webhook 合并（`webhookCoalesceMs = 60_000`）
- `POST /hooks/routines/:id` 完成签名/密钥校验、体积限制、`ping` 响应、重放去重与 `routine.enabled` 检查后：
  - 当开启 `webhookCoalesceMs > 0` 时：将格式化载荷推入该 `routine.id` 的内存聚合桶（单桶最多合并 `10` 条事件、总长上限 `256 KB`），立即返回 `202 { ok: true, coalesced: true }`（即使上一轮该 routine 正在运行也不再报 `409`，而是安全排入下一批聚合桶）。
  - 自桶内首条事件起计时 `60` 秒；到期后（若该 routine 仍在运行则待其刚结束时）将桶内多条事件按序拼接（`Event 1/N … Event N/N`）后合并触发一次 `runRoutine`。
  - `gateway.stopAll()` 时清理所有待触发定时器。

### 4.2 3 分钟活跃对话静默延后（`quietChatMs = 3 * 60_000`）
- 非手动（`!opts.force`）、非免打扰窗口的定时巡检回合产生非紧急 `'text'` 或 `'report'` 产出时（`urgent !== true`）：
  - 若目标线程当前忙于交互回合，或操作者在该线程最后一条 `sender = 'user'` 消息距今不足 `3` 分钟，则写入 `proactive_deferred`（`deliver_after = Math.max(now, lastUserAt + quietChatMs)`）暂不投递。
- 后台每 30 秒调用 `flushDeferredProactiveIfDue()`（同时暴露在 `createApp` 与 `POST /api/proactive/flush-deferred`）：
  - 当 `now >= deliver_after`、线程空闲且距操作者最后发言已满 3 分钟时按序投递（若期间进入免打扰时段，则平滑转入 `quiet_digest_items` 晨报队列；若 `source_tainted = 1` 则同步调用 `markWikiSyncThreadTainted`）。

### 4.3 每日非紧急主动提醒上限（`dailyNonUrgentCap = 5`）
- 在向线程实际投递非手动、非紧急定时产出（含实时产出与 `proactive_deferred` 到期补发）前，统计该同事自本地当天零点（`startOfLocalDay(now, timeZone)`）以来已直接投递入线程的非紧急主动消息条数：
  - 若已满 `5` 条：不再往聊天线程发新气泡，自动将该条摘要写入今日 `Feed`（若该轮尚未写 Feed）并存入 `quiet_digest_items` 归入下一份汇总摘要。
  - `urgent: true` 告警、审批卡片、提问卡片、登录请求与手动 `force: true` 运行**不计入上限且永不被拦截**。

---

## 5. 测试验证方案

1. **Dreaming 单测与存储测试（`gateway/test/proactive-dreaming.test.ts`）：**
   - 验证 Schema `v27` 迁移建表完整性。
   - 验证首次隐式反馈仅写入 `proactive_clues`（`seen_count = 1`，不发卡片）；第二次同领域同倾向反馈晋升为 `RuleProposalChip`（`source: 'dreaming'`）并清理线索。
   - 验证显式偏好（“以后客户回复都立刻告诉我”）单次直达 `RuleProposalChip`。
   - 验证内容评价（“好文章”）、办结回复（“弄完了”）与无回复场景零误学。
   - 验证夜间时段抱怨强制保持时间窗且将 `stay_silent` 降级为 `follow_up_later`。
   - 验证相反倾向覆盖旧线索、外部污点单调传递至 `RuleProposalChip`，以及 `priority: 'low'` 队列调用。
2. **三维节奏控制集成测试（`gateway/test/proactive-pacing.test.ts`）：**
   - 验证 60 秒内连续 3 次 Webhook 请求合并为 1 次 `runRoutine` 调用，以及运行中到达的突发 Webhook 入桶续跑而非 `409`。
   - 验证操作者刚发消息 1 分钟内的非紧急巡检产出进入 `proactive_deferred`，满 3 分钟静默后自动投递（含模拟网关重启恢复）。
   - 验证单日满 5 条非紧急提醒后第 6 条自动分流至 `quiet_digest_items` / `Feed`，而第 7 条 `urgent: true` 立即穿透直达线程。
3. **前端与双语测试（`web/src/components/Thread.test.tsx` & `i18n.test.tsx`）：**
   - 验证 `RuleProposalChip` 对 `source: 'dreaming'` 正确渲染中英文来源标签，且 `en.ts` / `zh-CN.ts` 键值 100% 对齐。
