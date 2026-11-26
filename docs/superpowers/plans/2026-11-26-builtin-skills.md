# Phase 13 实施计划：开箱内置共享技能包（Built-in Starter Skills）

**日期：** 2026-11-26  
**规格文档：** `docs/superpowers/specs/2026-11-26-builtin-skills-design.md`  
**分支：** `feat/builtin-skills`

---

## 任务 1：编写六大内置共享技能手册与打包配置（`gateway/skills/*.md`、`gateway/package.json`、`desktop/scripts/stage.mjs`）

**涉及文件：**
- 新建 `gateway/skills/meeting-minutes.md`
- 新建 `gateway/skills/research-brief.md`
- 新建 `gateway/skills/spreadsheet-analysis.md`
- 新建 `gateway/skills/doc-drafting.md`
- 新建 `gateway/skills/slide-outline.md`
- 新建 `gateway/skills/careful-browsing.md`
- 修改 `gateway/package.json`：`"files": ["dist", "skills"]`
- 修改 `desktop/scripts/stage.mjs`：在打包完整性校验列表中加入 `'gateway/skills/meeting-minutes.md'`

---

## 任务 2：双层技能合并加载与网关挂载（`gateway/src/skills.ts`、`server.ts`、`main.ts`、`gateway/test/builtin-skills.test.ts`）

**涉及文件：**
- 修改 `gateway/src/skills.ts`：
  - 扩展 `Skill` 类型增加可选 `builtin?: boolean`。
  - 实现 `defaultBuiltinSkillsDir()`、`listMergedSkills({ userDir, builtinDir })`、`readMergedSkill({ userDir, builtinDir }, name)`（用户同名优先覆盖、白名单路径校验、50 条总上限、字典序排列）。
- 修改 `gateway/src/server.ts` 与 `gateway/src/main.ts`：
  - `AppDeps` 新增 `builtinSkills?: boolean | string`（`main.ts` 传 `builtinSkills: true`）。
  - 回合构建与 `/api/bots/:botId/computer` 切换为 `listMergedSkills` / `readMergedSkill`。
- 新建 `gateway/test/builtin-skills.test.ts`：覆盖 6 份预置技能质量校验、双层合并与同名覆盖、路径穿越拦截及 `createApp` 端到端 `read_skill` 调用。

---

## 任务 3：电脑面板来源标识、双语词条与安全文档（`web` + `docs/security.md`）

**涉及文件：**
- 修改 `web/src/types.ts`：`Skill` 增加 `builtin?: boolean`。
- 修改 `web/src/i18n/en.ts` 与 `web/src/i18n/zh-CN.ts`：新增 `'panel.skillBuiltin'` 与 `'panel.skillCustom'`。
- 修改 `web/src/components/ComputerPanel.tsx`：复用 `.panel-mode-badge` 渲染内置/自定义来源徽章（零 `index.css` 改动）。
- 修改 `web/src/components/ComputerPanel.test.tsx`、`web/src/i18n/i18n.test.tsx` 与 `docs/security.md`：补充双语渲染单测与内置技能安全说明。
