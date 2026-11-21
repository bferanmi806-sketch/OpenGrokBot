# 中文用词表

界面中文（`zh-CN.ts`）按这张表用词。原则：说人话，不直译；同一个东西全界面只有一个叫法。
加新文案时先查这里；要新造一个词，先加进这张表。

## 人和东西

| 英文 | 中文 | 说明 |
|---|---|---|
| teammate | 同事 | 不说「机器人」「智能体」「bot」。量词「位」：一位同事 |
| chief | Chief | 名字，不翻 |
| hire | 雇 | 「雇一位同事」，不说「创建」「添加」 |
| demo mode | 演示模式 | 脚本写好的假模型（stub）。跟操作者说「回复是脚本写好的，不花钱，也不连任何 AI 服务」；离开它叫「接真模型」 |
| you / operator | 你 | 不说「用户」「操作员」 |
| computer | 电脑 | 同事干活用的那台，不说「环境」「实例」 |
| local computer | 本机电脑 | 跑在这台机器上的浏览器 + 文件夹 |
| sealed computer | 密封电脑 | Docker 容器；不说「容器电脑」「沙盒电脑」 |
| sandbox | 沙箱 | 只在命令行这件事上出现 |
| commands / shell | 命令行 / 跑命令 | 开关叫「允许跑命令」 |
| gateway | 网关 | |
| token (sign-in) | 令牌 | 登录用的那串 |
| token (model use) | token | 计费单位不翻：「12,345 个 token」 |
| group / room | 群聊 / 群 | |
| mention (@) | 点名 | 群里打 @ 叫某位同事；不说「提及」「艾特」 |
| thread | 对话 | 不说「线程」「会话」 |
| thread (Slack) | 话题串 | Slack 频道里的 thread；OpenSuperBot 自己的 thread 仍叫「对话」 |
| AI models | AI 模型 | 设置里管服务商和 key 的那一块 |
| (model) connection | 连接 | 一家服务商 + 一个 key + 默认模型；没选过的同事用「默认连接」 |
| connector | 连接器 | Gmail、Outlook、Notion、Slack 这些外部应用的连接；总弹窗分「应用」和「MCP 服务」两栏 |
| MCP server | MCP 服务 | 通过 MCP 协议接入的工具服务（本机命令 stdio 或远程 HTTP）；不说「MCP 服务器」 |
| vault | 凭证库 | 独立存放网站登录、API 密钥和个人常用资料的本地 0600 文件，网关按域名白名单零明文代填 |
| allowed domains | 允许域名 | 凭证库条目允许浏览器代填的 HTTPS 域名白名单 |
| TOTP / 2FA | 两步验证码 | 凭证库内置生成的 6 位 TOTP 一次性验证码 |
| Today | 今日 | 侧栏顶部唯一的一级工作台入口，顶栏收拢「动态」「灵感」「待办与目标」「空间」四个二级标签 |
| proposal | 提案 | 同事在只读或巡检中给出的建议卡片，绝不自动执行 |
| idea | 灵感 | 你随时记下的模糊想法或从提案收入的条目，收在「灵感箱」里 |
| incubate | 只读孵化 | 用只读值守权限让一位同事调研可行性与行动方案，绝不产生外部副作用 |
| goal | 目标 | 跨天、跨周的持久化项目目标，存在网关数据库里并由负责人和协作成员持续推进 |
| milestone | 里程碑 | 目标下的阶段性检查点，可指派同事和截止日期 |
| success criteria | 完成标准 | 判断一个目标算不算做完的清晰定义 |
| progress log | 进展记录 | 目标的变更与进度时间线（同事汇报与操作者备注） |
| check-in | 推进 | 向目标负责人或成员发起一次带目标上下文的推进对话 |
| promote to goal | 立项为目标 | 把灵感箱里的点子转为持久化目标 |
| space | 空间 | 收拢在「今日」顶栏第四个二级标签下的声明式活看板（零任意 JS，按同事零默认授权） |
| declarative block | 声明式区块 | 空间内由原生组件安全渲染的结构化块（指标、表格、看板、清单、时间线、图表、笔记、动作按钮栏） |
| viewer / editor (space) | 只读 / 可编辑 | 同事对某个空间的访问角色；未授权为「无权限」 |
| transport (MCP) | 连接方式 | 本机命令（stdio）或远程 HTTP；协议与配置名 `MCP`、`stdio`、`HTTP`、`JSON`、`readOnlyHint`、`0600` 原样不翻 |
| service / provider | 服务商 | DeepSeek、Claude 这些；不说「供应商」「提供方」 |
| API key | API key | 不翻 |
| subscription plan key | 订阅套餐的 key | 编程套餐之类；和按量付费的 API key 分开说 |
| vision | 看截图 | 「让它看截图」；不说「视觉」「多模态」 |
| file / attachment | 文件 | 你发给同事的图片、PDF、文本。按钮叫「添加文件」；不说「附件」「上传附件」。动作是「发」「移除」，不说「删除附件」 |
| desktop app | 桌面版 | 装在电脑上的 App；对面是「在浏览器里打开」。源码跑的叫「源码版」 |
| start at login | 开机自启 | 开关写成「登录电脑时自动打开 OpenSuperBot」；说明里可以简称开机自启 |
| check for updates | 检查新版本 | 开关写成「启动时检查有没有新版本」；不做自动安装，只带人去 GitHub 下载 |

## 事情和动作

| 英文 | 中文 | 说明 |
|---|---|---|
| approval | 审批 | 「等你审批」 |
| read-only / needs approval | 只读 / 需审批 | MCP 工具的调用权限（只读直接跑，需审批先问你） |
| approve / discard | 批准 / 驳回 | discard 不说「丢弃」 |
| approve edited | 按修改批准 | 在审批卡片里修改内容后按修改结果批准 |
| edited by you | 你已修改 | 操作者在审批卡片里修改后批准的标记（对话记录行内简写为「已修改」） |
| reset (edit form) | 还原 | 审批编辑表单里恢复成同事原始草稿的按钮；不说「重置」 |
| always allow | 一直放行 | 点了就存一条放行规矩 |
| revoke | 撤销 | |
| standing rule (memory) | 长期规矩 | 同事记在 MEMORY.md 里的；不说「规则」，免得和放行规矩混 |
| rule (allow rule) | 放行规矩 | 「不用问就放行」那一栏里的；英文审批卡片上的 standing rule 也是它，不是长期规矩 |
| memory | 记忆 | |
| routine | 例行任务 | 定时的、webhook 触发的都叫这个 |
| watch | 值守 | 只看不动、有事才出声的例行任务 |
| handoff | 转交 | 同事之间 |
| take over / sign in for it | 接管 / 登录 | 你在它的浏览器里亲手操作 |
| needs you | 等你 | 侧栏状态 |
| working / stuck / done | 在干活 / 卡住了 / 干完了 | |
| step | 步 | 「3 步」 |
| report | 报告 | 「已交报告」 |
| skill | 技能 | 「共享技能」 |
| webhook | webhook | 不翻；外部来的数据叫「外部数据」 |
| destination / target | 去处 | 放行规矩管的「发给谁、发到哪」 |
| wildcard | 通配 | |
| budget (tokens) | token 预算 | |
| limit (per turn) | 上限 | 「一个回合 30 步的上限」 |
| image (Docker) | 镜像 | |

## 写法

- 中文标点（，。：「」…），引号用「」；中英文之间不强制加空格，但数字和单位之间加：「12 秒」「3 步」。
- 品牌名（OpenSuperBot、Chief、GitHub、DeepSeek……）和同事的名字原样。
- 按钮用动词短语，短：「批准」「停下」「我登录好了」。
- 同事说的话、模型生成的内容不在词典里。网关回来的原因带代码（`error.*`、`block.*`、`sandbox.*`、`notice.*`），
  在词典里翻；认不出的代码就显示网关的英文原话。
