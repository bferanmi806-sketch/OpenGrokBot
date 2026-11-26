# Phase 12 设计规格：高危 Shell / 浏览器确定性护栏与统一脱敏一键诊断包

**日期：** 2026-11-26  
**状态：** 待审阅  
**分支：** `feat/action-guardrail-diagnostics`（基于 `feat/flashback`）  
**范围：** 包含两个正交的安全与可观测性加固模块：（1）**高危动作确定性护栏**（`gateway/src/action-guardrail.ts`），在 `shell`、`browser_click`、`browser_type(submit: true)` 与 `browser_press` 触达底层沙箱/浏览器前执行确定性高危规则拦截，通过 `approvals.execution_json`（`kind: 'computer_guardrail'`）挂起为不可记常驻规则的冻结审批卡（支持操作者内联审阅与修改参数，浏览器动作绑定 `expectedOrigin` 防 TOCTOU 漂移），批准时由网关单次直执并唤醒后续回合；（2）**统一密钥脱敏器与一键诊断包**（升级 `desktop/src/diagnostics.ts`、新增 `gateway/src/diagnostics.ts` + `GET /api/diagnostics` 及设置页一键复制摘要 / 下载 `.json` 诊断包）。

---

## 1. 设计目标与安全不变量

### 核心目标
1. **补齐本地命令与浏览器的确定性安全门禁：** 此前连接器写操作、MCP 写工具与 Vault 填充均由网关代码确定性挂起并冻结参数，唯独 `shell` 与浏览器交互依赖模型自觉调用 `hold_for_approval`。引入 `action-guardrail.ts` 后，即便模型受外部网页或 Webhook 提示词注入驱使，破坏性删除、敏感目录读取/外传、系统提权或结账/删除/发送类页面提交也会在网关层被 100% 确定性拦下。
2. **冻结参数单次直执，杜绝放行后偷换指令：** 审批放行时不再交给模型重新生成工具调用，而是由网关读取 `approvals.execution_json` 中经操作者确认（或内联编辑）的精确命令/目标直接执行一次，并将结果作为外部数据喂回后续回合收尾。
3. **零隐私泄露的一键故障自检与反馈：** 当操作者在桌面端或 Web 端遇到异常（如模型连接报错、沙箱降级、MCP 断连、队列积压）时，无需手工翻找日志目录和打码密钥，可在「设置 → 关于」一键复制纯文本摘要或下载结构化 `.json` 诊断包直接贴入 Issue。

### 安全不变量
1. **高危护栏永不自动放行（`canRemember = false`）：** 所有由确定性护栏生成的审批统一使用 `'purchase'`（涉及支付/下单）或 `'other'`（破坏性/外传/系统/提交类）类别，按 `RULEABLE_KINDS` 天然禁止记为 `1h / 24h / always` 常驻规则，坚持**一件一问**。
2. **浏览器 `expectedOrigin` 防跨站漂移：** 挂起浏览器高危动作时同步记录当前页面 `origin`（如 `https://checkout.stripe.com`）。操作者点击批准时，网关先核对同事浏览器当前页面 `origin` 是否与 `expectedOrigin` 完全一致；若不一致（如页面重定向或被后台切走），立即拒绝执行并标记 `executionStatus = 'failed'`。
3. **内联编辑二次安全校验：** 操作者在审批卡中修改冻结参数（例如将 `rm -rf /tmp/build/*` 缩小为 `rm -rf ./dist`）时，走复用 `editable: { kind: 'mcp', serverName: 'computer', toolName, args, inputSchema }` 表单/JSON 通道更新 `execution_json`、`action` 与 `detail`，且绝不允许通过编辑篡改 `toolName` 或跨工具提权。
4. **诊断包零聊天正文与零明文凭证：** `GET /api/diagnostics` 只采集运行环境元数据、表行数统计、子系统健康快照与经全谱系 `redactSecrets` 脱敏后的近期网关日志尾部，**严禁**读取 `messages.content`、`wiki_pages.body`、`MEMORY.md`、`vault*`、`mcp-secrets.json` 或模型 API Key 原文。

---

## 2. 模块一：高危 Shell / 浏览器确定性护栏

### 2.1 判定引擎（`gateway/src/action-guardrail.ts`）

提供纯函数 `evaluateComputerGuardrail(input)`，不依赖 LLM、毫秒级同步判定：

```ts
export type GuardrailToolName = 'shell' | 'browser_click' | 'browser_type' | 'browser_press'

export type GuardrailHit = {
  blocked: true
  riskCode:
    | 'shell_destructive'
    | 'shell_sensitive_read'
    | 'shell_network_exfil'
    | 'shell_remote_exec'
    | 'shell_system_mutation'
    | 'shell_force_git'
    | 'browser_purchase_action'
    | 'browser_destructive_action'
    | 'browser_external_submit'
  approvalKind: 'purchase' | 'other'
  action: string
  detail: string
  target: string
}
```

#### （A）`shell` 高危规则集
先对 `cmd` 做规范化解析（保留原始命令用于冻结执行，同时展开换行、`;`、`&&`、`||`、`|`、`$()`、反引号及 `sh -c` / `bash -c` / `zsh -c` / `eval` 内嵌字符串逐段扫描）：
1. **远程代码直跑（`shell_remote_exec`）：** `curl` / `wget` 管道喂给 `sh` / `bash` / `zsh` / `python` / `node` / `perl` / `ruby`，或 `base64 -d | sh`。
2. **敏感宿主凭证读取（`shell_sensitive_read`）：** 命令引用 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.npmrc`、`~/.netrc`、`~/.pypirc`、`/etc/shadow`、macOS Keychain（`security find-generic-password` / `find-internet-password` / `dump-keychain`），或网关敏感存储文件名（`mcp-secrets.json`、`vault-secrets`、`polery-oauth`、`auth-token`）。
3. **网络外传与上传（`shell_network_exfil`）：** `curl`（含 `-d` / `--data*` / `-F` / `--form` / `-T` / `--upload-file` / `-X POST|PUT|PATCH|DELETE`）、`wget --post-*`、`scp`、`sftp`、`rsync`（含远端 `:`）、`nc` / `ncat` / `socat` 外连。
4. **破坏性删除与磁盘操作（`shell_destructive`）：**
   - `rm` 针对根路径 `/`、家目录 `~` / `$HOME`、父级逃逸 `..`、裸通配 `*`，或带 `-r` / `-rf` / `--recursive` 删除非安全临时编译目录（仅允许工作区相对子路径下的常规构建缓存名如 `dist` / `build` / `.cache`？为稳妥起见：凡 `rm` 含 `-r` / `-f` 操作绝对路径、`~`、`..`、`.`、`*` 或一次删除多路径，以及 `find ... -delete`、`mkfs*`、`dd if=`、`diskutil erase*`、`shred` 均拦截；工作区内单文件 `rm foo.txt` 不拦截）。
5. **强制历史改写与越权系统变更（`shell_force_git` / `shell_system_mutation`）：**
   - `git push` 含 `--force` / `-f` / `--force-with-lease`、`git reset --hard`、`git clean -f*`；
   - `sudo`、`su `、`doas`、`launchctl`、`crontab`、`systemctl`、`chmod -R 777`、`chown -R`、系统级全局安装（`npm i -g` / `npm install --global` / `pnpm add -g` / `brew install|uninstall`）。
6. **常规命令零误伤保证：** 工作区内的 `ls`、`pwd`、`cat ./README.md`、`grep`、`rg`、`head`、`tail`、`wc`、`jq`、`python3 script.py`、`node index.js`、`pnpm build`、`git status`、`git diff`、`git log`、`git commit`、只读 `curl -I https://example.com` 均返回 `{ blocked: false }`。

#### （B）浏览器高危提交规则集（`browser_click` / `browser_type` / `browser_press`）
结合工具参数与当前页面快照 `{ currentUrl, currentTitle }`（若计算机支持查询当前页面信息，否则基于最近一次 `browser_goto` / `click` 已知 URL 或纯目标词匹配）：
1. **`browser_click`：**
   - **支付与购买（`browser_purchase_action` -> `approvalKind: 'purchase'`）：** 目标文案匹配结账/付款/下单/订阅扣费关键词（如 `pay`, `pay now`, `purchase`, `buy now`, `place order`, `complete order`, `checkout`, `subscribe`, `confirm payment`, `支付`, `立即付款`, `确认付款`, `提交订单`, `立即购买`, `下单`, `开通会员`），且排除明显的只读导航词（如 `payment history`, `billing faq`, `账单明细`）。
   - **破坏性删除与注销（`browser_destructive_action` -> `approvalKind: 'other'`）：** 目标文案匹配永久删除/清空/撤销密钥/注销账号（如 `delete`, `delete account`, `delete repository`, `remove permanently`, `empty trash`, `revoke`, `terminate`, `transfer ownership`, `删除`, `永久删除`, `清空回收站`, `注销账号`, `吊销`, `销毁`）。
   - **对外发送与公开发布（`browser_external_submit` -> `approvalKind: 'other'`）：** 目标文案匹配发送邮件/私信、公开发帖、合并生产变更、发起转账（如 `send`, `send email`, `send message`, `publish`, `post`, `submit application`, `merge pull request`, `wire transfer`, `发送`, `发送邮件`, `发布`, `公开提交`, `确认转账`）。
2. **`browser_type`（仅当 `args.submit === true`）与 `browser_press`（仅当 `key` 为 `Enter` / `Return` 且不含安全修饰或含 `Meta+Enter` / `Control+Enter` 提交快捷键）：**
   - 当 `currentUrl` 路径/主机处于高敏感结账、支付、转账、账号安全或删除确认页（如 `/checkout`、`/payment`、`/billing`、`/transfer`、`/settings/delete`、`/security`），或 `browser_type` 的 `target` 本身命中上述高危词时，同样触发拦截并冻结动作，封堵绕过 `browser_click` 用回车键提交表单的路径。

### 2.2 冻结审批与直执闭环（`agent.ts`、`server.ts`、`approval-edit.ts`）

1. **冻结载荷结构（`FrozenComputerGuardrailExecution`）：**
   ```ts
   export type FrozenComputerGuardrailExecution = {
     kind: 'computer_guardrail'
     tool: GuardrailToolName
     args: Record<string, unknown>
     riskCode: GuardrailHit['riskCode']
     expectedOrigin?: string
   }
   ```
2. **拦截挂起流程（`agent.ts` + `server.ts`）：**
   - 在 `execToolCall` 执行 `COMPUTER_TOOL_NAMES` 前（且在 `watch` 只读模式校验之后），对 `shell`、`browser_click`、`browser_type`、`browser_press` 调用 `deps.onComputerGuardrail`（或在 `agent.ts` 调用 `evaluateComputerGuardrail`）：
   - 若命中高危规则：
     - 当配置了 `deps.onGuardrailApproval`（`server.ts` 全量接入）时：创建 `approvals` 记录（`kind: hit.approvalKind`, `status: 'pending'`, `executionJson: JSON.stringify(frozen)`），并向线程发送 `approval_request` 卡片（带 `editable` schema 以便操作者在 UI 中直接查看与修改 `cmd` 或 `target`，`canRemember: false`），向模型返回 `"Held by deterministic safety guardrail for your operator's approval. Stop here — do not retry or work around this action."`（同时标记 `markBypassedPacing` 确保伴随解释文本即时送达）。
     - 当未注入审批回调（如裸 `runTurn` 无服务层场景且未关闭护栏）时：拒绝执行并返回明确的高危拦截提示。
3. **内联编辑支持（`gateway/src/approval-edit.ts` & `ApprovalChip.tsx`）：**
   - 生成审批卡时附带 `editable: { kind: 'mcp', serverName: 'computer', toolName: frozen.tool, args: frozen.args, inputSchema }`（复用 `ApprovalChip.tsx` 现成且经过充分测试的动态 Schema 表单/多行文本框与 JSON 编辑器）；
   - 在 `approval-edit.ts` 的 `applyApprovalEdit` 中新增对 `parsed.kind === 'computer_guardrail'`（对应前端传回的 `edit.kind === 'mcp'`）的处理：严格校验修改后的 `args` 类型（如 `shell` 要求非空字符串 `cmd` 及合法可选 `timeoutMs`；`browser_click` 要求非空 `target`），同步刷新审批卡展示的 `action` / `detail` 与持久化的 `executionJson`，严禁修改 `tool` 名称或清空 `expectedOrigin`。
4. **批准后单次确定性直执（`gateway/src/server.ts`）：**
   - 在 `POST /api/approvals/:id/resolve`（`decision === 'approve'`）中新增 `parsedExec.kind === 'computer_guardrail'` 分支：
     - 获取对应同事的 `computer = await pool.get(approval.bot_id)`（若浏览器动作则先校验租约空闲及当前页面 URL 的 `origin === frozen.expectedOrigin`；不匹配则报错阻断）；
     - 直接按冻结的 `tool` 与 `args` 执行一次底层动作（`shell` 结果同样经 Vault 脱敏与输出截断），调用 `recordApprovalExecution(db, approval.id, 'succeeded' | 'failed', summary)` 更新审批卡状态，并写入 `actions` 审计表（`trigger: 'approval'`）；
     - 执行成功后唤醒同事收尾回合（携带输出摘要并声明为外部数据 `tainted: true`，若属于 DAG 管线挂起步骤则通过 `pipelineWaitTurnHooks` 恢复管线）。

---

## 3. 模块二：统一密钥脱敏器与一键脱敏诊断包

### 3.1 统一密钥脱敏器（`gateway/src/diagnostics.ts` & `desktop/src/diagnostics.ts`）

构建零外部依赖的高覆盖率纯函数 `redactSecrets(text: string): string`（桌面端 `desktop/src/diagnostics.ts` 的 `redact` 同步对齐同一套规则）：
1. **主流 AI 与云厂商密钥前缀：**
   - OpenAI / Anthropic / DeepSeek 等：`sk-ant-[\w-]{8,}`、`sk-proj-[\w-]{8,}`、`sk-[\w-]{12,}`
   - Google Gemini：`AIza[\w-]{16,}`
   - Groq：`gsk_[\w-]{16,}`
   - xAI：`xai-[\w-]{12,}`
   - Composio：`cmp_[\w-]{12,}`、`ak_[\w-]{12,}`
   - GitHub：`ghp_[\w]{16,}`、`gho_[\w]{16,}`、`ghs_[\w]{16,}`、`ghr_[\w]{16,}`、`github_pat_[\w]{20,}`
   - GitLab：`glpat-[\w-]{12,}`
   - Slack：`xox[baprs]-[\w-]{12,}`
   - AWS Access Key：`AKIA[0-9A-Z]{16}`、`ASIA[0-9A-Z]{16}`
   - HuggingFace / Replicate / Perplexity / Stripe：`hf_[A-Za-z0-9]{16,}`、`r8_[A-Za-z0-9]{16,}`、`pplx-[A-Za-z0-9]{16,}`、`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}`
2. **协议头、URL 参数、JSON 字段与私钥块：**
   - PEM 私钥块：`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----` → `<hidden-private-key>`
   - HTTP 认证头：`Authorization: Bearer ...`、`Authorization: Basic ...`、`X-API-Key: ...`、`Cookie: ...`、`Set-Cookie: ...`
   - URL 查询与命令行参数：`([?&](?:token|key|api_key|apikey|access_token|refresh_token|client_secret|secret|password|code|signature)=)[^&\s"']+` 及 `--token=...` / `--api-key ...`
   - JSON / 键值对中的敏感键：`"(?:apiKey|api_key|token|accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|webhookKey|webhook_key|password|secret|totpSecret)"\s*:\s*"[^"]+"`
   - 本机家目录用户名脱敏（可选参数 `redactHomePath = true`，诊断导出默认开启）：将 `/Users/<username>/`、`/home/<username>/`、`C:\Users\<username>\` 归一化为 `~/`，避免 Issue 截图/文本暴露本机真实系统账号名。

### 3.2 网关诊断接口（`GET /api/diagnostics`）

挂载于网关鉴权中间件之后（需有效登录会话/Bearer 令牌），返回结构化 `DiagnosticsBundle`：
```ts
export type DiagnosticsBundle = {
  generatedAt: string
  summaryText: string          // 可直接复制贴入 GitHub Issue 的 Markdown/纯文本摘要
  app: {
    gatewayVersion: string | null
    schemaVersion: number
    port: number | null
    dataDir: string            // 经家目录脱敏为 ~/...
    logFile: string            // 'stdout' 或 ~/.../gateway.log
    runtime: { node: string; platform: string; arch: string; release: string }
  }
  subsystems: {
    computersMode: string
    browserStatus: string
    localLlmQueue: { maxConcurrency: number; active: number; queued: number } | null
    mcpServers: Array<{ name: string; transport: string; policy: string; enabled: boolean }>
    connectors: Array<{ provider: string; status: string }>
    counts: {
      bots: number
      threads: number
      routines: number
      wikiPages: number
      pendingApprovals: number
      runningBackgroundTasks: number
    }
    recentActionErrors24h: Array<{ at: string; tool: string; trigger: string; summary: string }>
  }
  recentLogs: {
    source: string
    lineCount: number
    lines: string[]            // 最多最后 200 行，逐行 + 整体经 redactSecrets 清洗
  }
}
```
- 日志读取安全上限：当 `logFile` 指向磁盘日志文件且可读时，仅从文件末尾读取最多最后 `128 KB` 并截取最后 `200` 行（不把大体积历史日志全量读入内存）；若为 `stdout` 或文件不存在，安全返回空数组并注明来源。
- `recentActionErrors24h`：仅取最近 24 小时 `ok = 0` 的最多 15 条 `actions` 摘要，且 `summary` 再次经 `redactSecrets` 脱敏。

### 3.3 设置页交互（`web/src/components/SettingsDialog.tsx` + `api.ts` + `i18n`）

- 在 `web/src/api.ts` 新增 `fetchDiagnostics(): Promise<DiagnosticsBundle>`。
- 在 `SettingsDialog.tsx` 的「关于（About）」区块底部新增诊断操作栏：
  - **「复制诊断摘要」（`Copy diagnostics`）**：拉取 `fetchDiagnostics()`（若桌面版 `desktop` 信息存在则合并 Electron 版本行），写入 `navigator.clipboard.writeText(...)`，展示短暂成功反馈「已复制脱敏诊断摘要」；
  - **「下载诊断包」（`Download bundle (.json)`）**：生成带时间戳文件名 `opensuperbot-diagnostics-YYYYMMDD-HHmmss.json` 的 `Blob` 触发浏览器本地下载；
  - 附一行清晰的隐私说明：「已自动隐去 API 密钥、令牌与本机用户名，不包含任何聊天或文档内容。」
- `en.ts` 与 `zh-CN.ts` 键值 100% 双语对齐。

---

## 4. 测试与文档验证计划

1. **高危动作护栏单测与集成测试（`gateway/test/action-guardrail.test.ts`）：**
   - 覆盖全部 6 类高危 `shell` 模式（`rm -rf ~`、`~/.ssh/id_rsa`、`curl -d @file`、`curl | sh`、`git push --force`、`sudo`、以及 `sh -c "..."` / `$()` / 管道绕过变体）全部精准拦截，常规开发/读取命令零误拦。
   - 覆盖 `browser_click`（支付/删除/外发中英文按钮）、`browser_type(submit: true)` 与 `browser_press('Enter')`（结账/安全页）拦截，普通浏览点击（`Next page`、`View details`、`Billing FAQ`）零误拦。
   - 端到端闭环（`createApp`）：验证触发护栏生成 `canRemember: false` 的冻结审批卡 → 操作者内联修改 `shell` 命令参数并批准 → 网关单次直执新命令并唤醒后续回合；以及浏览器审批期间页面跨站漂移（`expectedOrigin` 不匹配）时安全阻断。
2. **统一脱敏与诊断接口测试（`gateway/test/diagnostics.test.ts`、`desktop/test/diagnostics.test.ts`、`web/src/components/SettingsDialog.test.tsx`）：**
   - 验证 `redactSecrets` 对 `sk-ant-`、`cmp_`、`ghp_`、`github_pat_`、`xoxb-`、`glpat-`、`AKIA`、PEM 私钥、`Bearer`、URL `token=/key=/secret=`、JSON `apiKey` 及家目录用户名的脱敏完整性。
   - 验证 `GET /api/diagnostics` 鉴权保护（未登录返回 `401`）、结构完整性、日志文件尾部 200 行脱敏读取，以及绝对不含聊天消息正文。
   - 验证 `SettingsDialog` 双按钮渲染、复制与下载交互及 `i18n.test.tsx` 双语对齐。
3. **安全文档（`docs/security.md`）：**
   - 更新中文安全文档，移除或修订原先“命令行与浏览器完全依赖提示词自觉”的旧表述，明确记录确定性高危护栏的覆盖范围、边界（深度沙箱仍由 OS/Docker 兜底）与脱敏诊断导出机制。
