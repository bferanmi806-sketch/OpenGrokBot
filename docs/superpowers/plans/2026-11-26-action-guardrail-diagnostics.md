# Phase 12 实施计划：高危 Shell / 浏览器确定性护栏与统一脱敏一键诊断包

**日期：** 2026-11-26  
**规格文档：** `docs/superpowers/specs/2026-11-26-action-guardrail-diagnostics-design.md`  
**分支：** `feat/action-guardrail-diagnostics`

---

## 任务 1：高危 Shell / 浏览器确定性护栏引擎（`gateway/src/action-guardrail.ts`）

**涉及文件：**
- 新建 `gateway/src/action-guardrail.ts`：
  - 实现纯函数 `evaluateComputerGuardrail(input)`：
    - `shell`：展开换行、`;`、`&&`、`||`、`|`、`$()`、反引号及 `sh/bash/zsh -c` / `eval` 内嵌命令后逐段识别 6 类高危模式（`shell_remote_exec`、`shell_sensitive_read`、`shell_network_exfil`、`shell_destructive`、`shell_force_git`、`shell_system_mutation`），确保常规工作区读写/构建/Git 操作零误伤。
    - `browser_click` / `browser_type(submit: true)` / `browser_press('Enter' | 'Meta+Enter' | 'Control+Enter')`：识别支付下单（`browser_purchase_action` -> `kind: 'purchase'`）、破坏性删除/注销（`browser_destructive_action` -> `kind: 'other'`）与对外发送/发布/转账（`browser_external_submit` -> `kind: 'other'`），并在结账/支付/安全/删除确认 URL 下拦截回车提交。
  - 定义 `FrozenComputerGuardrailExecution` 与对应的动态 `inputSchema` 生成器（供审批卡片内联编辑参数）。

---

## 任务 2：冻结审批挂起、内联改参与网关单次直执（`agent.ts`、`approval-edit.ts`、`server.ts`）

**涉及文件：**
- 修改 `gateway/src/agent.ts`：
  - 在 `execToolCall` 的计算机工具分支（`watch`/`prepare` 只读门禁之后、实际调用 `execComputerTool` 之前），对 `shell`、`browser_click`、`browser_type`、`browser_press` 调用 `deps.onGuardrailCheck` / 护栏钩子，维护当前已知浏览器页面 URL 供来源绑定。
  - 命中高危规则时创建 `approval_request` 卡片（`canRemember: false`，附 `editable: { kind: 'mcp', serverName: 'computer', toolName, args, inputSchema }`），调用 `markBypassedPacing` 确保解释文本不被主动节奏延迟，并中止该工具执行。
- 修改 `gateway/src/approval-edit.ts`：
  - 在 `applyApprovalEdit` 中支持 `parsed.kind === 'computer_guardrail'`（接收 `edit.kind === 'mcp'` 参数更新），严格校验各工具参数结构（非空 `cmd` / `target` / `key`，合法 `timeoutMs` / `submit`），同步更新 `action`、`detail` 与冻结 `executionJson`，禁止篡改 `tool` 或清除 `expectedOrigin`。
- 修改 `gateway/src/server.ts`：
  - 在 `prepareTurnDeps` 注入护栏挂起回调（含 DAG 管线挂起步骤关联）。
  - 在 `POST /api/approvals/:id/resolve`（`decision === 'approve'`）新增 `kind === 'computer_guardrail'` 执行分支：校验浏览器租约与当前页面 `origin === expectedOrigin`，单次直执冻结工具（含 `shell` 输出 Vault 脱敏与截断），记录 `recordApprovalExecution` 与 `actions` 审计，随后以 `tainted: true` 唤醒同事收尾回合（或恢复 DAG 管线步骤）。
- 新建 `gateway/test/action-guardrail.test.ts`：覆盖全部高危模式与绕过变体、常规命令零误伤、内联编辑后放行直执、浏览器跨源漂移阻断及管线恢复。

---

## 任务 3：统一密钥脱敏器与网关诊断快照（`gateway/src/diagnostics.ts`、`desktop/src/diagnostics.ts`、`server.ts` / `settings-api.ts`）

**涉及文件：**
- 新建 `gateway/src/diagnostics.ts` 并同步升级 `desktop/src/diagnostics.ts`：
  - 实现全谱系 `redactSecrets(text, opts?)`：覆盖 OpenAI / Anthropic（`sk-ant-`）/ Gemini / Groq / xAI / Composio（`cmp_`）/ GitHub（`ghp_`、`github_pat_`）/ GitLab（`glpat-`）/ Slack（`xox*-`）/ AWS（`AKIA`）/ HuggingFace / Stripe、PEM 私钥块、HTTP 认证头（`Authorization`、`X-API-Key`、`Cookie`）、URL 与 CLI 敏感参数、JSON 敏感字段以及家目录用户名（`~/`）。
  - 实现 `buildDiagnosticsBundle`：汇总网关版本、Schema 版本、端口、脱敏路径、Node/OS 信息、计算机模式、浏览器状态、本地 LLM 队列快照、MCP / 连接器状态摘要、核心表计数、近 24 小时脱敏错误动作摘要以及日志文件末尾最多 128 KB / 200 行脱敏日志，绝不读取聊天消息正文、Wiki 内容或任何明文凭证。
- 挂载 `GET /api/diagnostics`（受网关鉴权保护）。
- 新建 `gateway/test/diagnostics.test.ts` 并补充 `desktop/test/diagnostics.test.ts`：覆盖全谱系密钥脱敏、401 鉴权、日志尾部截断脱敏与零聊天正文泄露断言。

---

## 任务 4：设置页双通道导出、双语词条与安全文档（`web` + `docs/security.md`）

**涉及文件：**
- 修改 `web/src/types.ts` 与 `web/src/api.ts`：新增 `DiagnosticsBundle` 类型与 `fetchDiagnostics()`。
- 修改 `web/src/i18n/en.ts` 与 `web/src/i18n/zh-CN.ts`：新增设置页诊断复制/下载按钮、成功/失败提示及隐私说明词条。
- 修改 `web/src/components/SettingsDialog.tsx`：在「关于」区块底部新增「复制诊断摘要」与「下载诊断包 (.json)」按钮（桌面端自动拼入 Electron 版本信息）及隐私提示。
- 修改前端测试（`web/src/components/SettingsDialog.test.tsx` / `i18n.test.tsx`）与 `docs/security.md`：验证按钮交互、双语对齐，并更新中文安全边界文档。
