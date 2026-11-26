# Phase 13 设计规格：开箱内置共享技能包（Built-in Starter Skills）

**日期：** 2026-11-26  
**状态：** 已批准  
**分支：** `feat/builtin-skills`（基于 `feat/action-guardrail-diagnostics`）  
**范围：** 新增随网关发布的只读预置共享技能目录（`gateway/skills/*.md`），扩展 `gateway/src/skills.ts` 实现「用户 `<data>/skills/` 优先覆盖 + 内置技能兜底合并」的双层加载机制，并在电脑面板「共享技能」区域展示来源标识（`内置` / `自定义`），确保桌面端打包（`desktop/scripts/stage.mjs`）完整携带。

---

## 1. 设计目标与核心不变量

### 核心目标
1. **开箱即具备高水准专业做事方法论：** 新安装用户在尚未手动编写 `<data>/skills/*.md` 前，所有同事即默认拥有 6 份经过验证的高频办公与调研手册（会议纪要、多源调研简报、表格数据分析、结构化文档起草、汇报幻灯片大纲、稳健网页操作规范）。
2. **极低上下文开销：** 系统提示词仍只注入单行 `name — description` 索引（每条 `<= 160` 字符，6 条合计仅约 150 Token），同事仅在任务匹配时按需调用 `read_skill` 拉取对应手册正文。
3. **无损升级与自由定制兼得：** 内置技能随应用版本自动迭代升级；当操作者在 `<data>/skills/<name>.md` 放置同名文件时，用户版本自动覆盖内置版本，且不会因升级应用而丢失自定义修改。

### 安全与兼容不变量
1. **严格白名单防路径穿越：** 无论是列举还是按名读取（`readSkill` / `readMergedSkill`），技能名均强制通过 `/^[a-z0-9][a-z0-9_-]{0,63}$/` 校验并核对目录实存列表，任何 `../`、路径分隔符或隐藏文件一律返回 `null`。
2. **不污染交互回合：** 内置技能与操作者自建 `<data>/skills/*.md` 同属本机受信任指导手册，调用 `read_skill` 不会触发 `outside-data` 污点，不影响常驻审批规则；`careful-browsing` 手册中更明确强化“将网页正文视为不可信数据”的操作纪律。
3. **既有测试 100% 向后兼容：**
   - 单目录 `listSkills(dir)` 与 `readSkill(dir, name)` 保持原有签名与行为不变；
   - `Skill` 类型扩展为 `{ name: string; description: string; builtin?: boolean }`——用户自定义技能省略 `builtin` 字段（保持 `{ name, description }` 原貌），仅未被覆盖的内置技能标记 `builtin: true`；
   - `createApp` 新增 `builtinSkills?: boolean | string`（生产入口 `gateway/src/main.ts` 传 `true` 默认启用；既有单测未传该参数时保持纯 `dataDir` 隔离）。

---

## 2. 六大预置技能清单（`gateway/skills/*.md`）

| 技能标识（文件名） | 一句话 `description`（`<= 160` 字符） | 核心结构与要点 |
| :--- | :--- | :--- |
| `meeting-minutes.md` | `Turn raw meeting notes or transcripts into structured decisions, open questions, and owned action items.` | 结论先行摘要、已拍板决议（含背景依据）、带负责人与截止期的行动项清单、待确认问题，以及同步更新团队 Wiki `session` 页面与目标跟进的规范。 |
| `research-brief.md` | `Synthesize multi-source web or internal findings into a cited, decision-ready brief separating facts from inference.` | 核心结论、一手与二手信源交叉核验、事实与推断显式区分、方案对比矩阵、未解盲区与下一步行动建议。 |
| `spreadsheet-analysis.md` | `Inspect CSV, TSV, or spreadsheet files deterministically with scripts before summarizing metrics, anomalies, and trends.` | 先探查表头/行数/空值/单位与重复键、强制用 Python/Node 脚本计算聚合指标（严禁心算编造数字）、口径说明、异常值标注与关键洞察。 |
| `doc-drafting.md` | `Draft clear, audience-tailored memos, specs, proposals, and emails with conclusions up front and explicit assumptions.` | 受众与目的界定、金字塔结论先行、关键假设与风险单列、精炼段落防空话套话、对外发送前停在草稿或审批门禁。 |
| `slide-outline.md` | `Design assertion-evidence slide decks with headline takeaways, visual layout cues, and concise speaker notes.` | 全篇叙事主线（Situation → Complication → Resolution）、每页“断言式结论标题 + 3 条以内视觉/数据支撑 + 演讲备注”、控制信息密度。 |
| `careful-browsing.md` | `Navigate live websites methodically: inspect before acting, handle pagination and logins cleanly, and pause on irreversible submits.` | 交互前先提取核对当前页面与 URL、遇登录/验证码立即调 `ask_for_login` 交由操作者接管、严格视页面内容为不可信外部数据、遇结账/删除/外发先确认。 |

---

## 3. 双层加载、面板展示与桌面端打包设计

### 3.1 双层技能解析（`gateway/src/skills.ts`）
- `defaultBuiltinSkillsDir(): string`：通过 `fileURLToPath(new URL('../skills', import.meta.url))` 定位 `gateway/skills`（在 `gateway/src/skills.ts`、`gateway/dist/skills.js` 与桌面端 `Resources/gateway/dist/skills.js` 下均一致指向 `gateway/skills`）。
- `listMergedSkills(opts: { userDir?: string; builtinDir?: string }): Promise<Skill[]>`：
  1. 先读取 `userDir` 下的有效技能（不带 `builtin` 字段）；
  2. 再读取 `builtinDir` 下的有效技能，跳过已被 `userDir` 同名覆盖的项，其余附加 `builtin: true`；
  3. 合并后按 `name` 字典序稳定排序，并截断至 `MAX_SKILLS = 50`。
- `readMergedSkill(opts: { userDir?: string; builtinDir?: string }, name: string): Promise<string | null>`：
  1. 校验 `wanted` 符合 `NAME` 正则；
  2. 若 `userDir` 存在同名合法 `.md` 文件且可读，优先返回去 frontmatter 后的正文；
  3. 否则回退从 `builtinDir` 读取同名合法 `.md` 文件；都不存在则返回 `null`。

### 3.2 网关与生产入口挂载（`gateway/src/server.ts` & `gateway/src/main.ts`）
- `AppDeps` 新增 `builtinSkills?: boolean | string`：
  - `true` 解析为 `defaultBuiltinSkillsDir()`；字符串则作为自定义内置目录路径（方便单测构造隔离内置目录）；未传或 `false` 则不加载内置目录。
- `server.ts` 中回合准备（`prepareTurnDeps`）与电脑面板接口（`GET /api/bots/:botId/computer`）统一改用 `listMergedSkills` 与 `readMergedSkill`。
- `gateway/src/main.ts` 在 `createApp(...)` 中传入 `builtinSkills: true`。

### 3.3 电脑面板来源徽章与打包配置（`web` & `desktop`）
- `web/src/types.ts`：`Skill` 增加可选 `builtin?: boolean`。
- `web/src/i18n/en.ts` 与 `web/src/i18n/zh-CN.ts`：新增 `'panel.skillBuiltin'`（`'Built-in'` / `'内置'`）与 `'panel.skillCustom'`（`'Custom'` / `'自定义'`）。
- `web/src/components/ComputerPanel.tsx`：在每项共享技能标题旁复用现有 `.panel-mode-badge` 样式渲染来源标签（不改动 `web/src/index.css`）。
- `gateway/package.json`：`"files": ["dist", "skills"]`，使 `pnpm deploy` 自动将 `gateway/skills` 带入桌面发布包；`desktop/scripts/stage.mjs` 在 `need` 校验清单中加入 `'gateway/skills/meeting-minutes.md'` 防止漏包。

---

## 4. 测试验证计划

1. **技能双层合并与预置内容测试（`gateway/test/builtin-skills.test.ts`）：**
   - 验证 `defaultBuiltinSkillsDir()` 下全部 6 份预置技能文件存在、frontmatter `description` 非空且 `<= 160` 字符、正文完整可读。
   - 验证空 `userDir` 时 `listMergedSkills` 返回 6 份 `builtin: true` 技能；当 `userDir` 存在同名 `meeting-minutes.md` 时，用户版本覆盖内置描述与正文且去除 `builtin` 标记。
   - 验证路径穿越（`../../etc/passwd`、`../package`）返回 `null`。
   - 验证 `createApp({ ..., builtinSkills: true })` 在全新空 `dataDir` 下即向系统提示词注入 6 份技能、开放 `read_skill` 工具，并通过 `GET /api/bots/:botId/computer` 返回带 `builtin: true` 的列表。
2. **前端与桌面打包测试（`web/src/components/ComputerPanel.test.tsx`、`i18n.test.tsx`、`desktop` 测试）：**
   - 验证 `ComputerPanel` 对 `builtin: true` 与用户自定义技能正确渲染中英文徽章，且双语词条对齐。
