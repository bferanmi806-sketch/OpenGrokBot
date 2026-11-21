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
| local model concurrency | 本地模型并发上限 | 仅对本机与局域网模型端点生效的并发限制，交互对话与审批会在步骤间优先插队；对应实时状态叫「本地队列」 |
| (model) connection | 连接 | 一家服务商 + 一个 key + 默认模型；没选过的同事用「默认连接」 |
| connector | 连接器 | Gmail、Outlook、Notion、Slack 这些外部应用的连接；总弹窗分「应用」和「MCP 服务」两栏 |
| MCP server | MCP 服务 | 通过 MCP 协议接入的工具服务（本机命令 stdio 或远程 HTTP）；不说「MCP 服务器」 |
| transport (MCP) | 连接方式 | 本机命令（stdio）或远程 HTTP；协议与配置名 `MCP`、`stdio`、`HTTP`、`JSON`、`readOnlyHint`、`0600` 原样不翻 |
| service / provider | 服务商 | DeepSeek、Claude 这些；不说「供应商」「提供方」 |
| API key | API key | 不翻 |
| subscription plan key | 订阅套餐的 key | 编程套餐之类；和按量付费的 API key 分开说 |
| vision | 看截图 | 「让它看截图」；不说「视觉」「多模态」 |
| file / attachment | 文件 | 你发给同事的图片、PDF、文本。按钮叫「添加文件」；不说「附件」「上传附件」。动作是「发」「移除」，不说「删除附件」 |
| desktop app | 桌面版 | 装在电脑上的 App；对面是「在浏览器里打开」。源码跑的叫「源码版」 |
| start at login | 开机自启 | 开关写成「登录电脑时自动打开 OpenSuperBot」；说明里可以简称开机自启 |
| check for updates | 检查新版本 | 开关写成「启动时检查有没有新版本」；不做自动安装，只带人去 GitHub 下载 |
| team wiki | 团队知识库 | 全体同事共用的事实笔记库（存放在本机 `<data>/wiki/`），按联系人、客户、项目、主题分类 |
| external source (wiki) | 外部来源 | 由网页、邮件或外部工具等非受控来源写入的知识库页面；在你核验保存前，同事读取它后外发动作仍需审批 |

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
| prepare | 备料 | 介于值守与执行之间的例行任务，可写入团队知识库与工作区，不能发外信或跑命令 |
| Quiet Hours | 免打扰时段 | 暂存非紧急定时巡检汇报、结束后合并发送的时段设置 |
| Morning digest | 晨报汇总 | 免打扰时段结束或手动投递后汇总发出的一张更新卡片 |
| rule proposal | 规矩提议 | 同事或多次驳回触发的、待你核对并存入 `MEMORY.md` 的常驻规矩建议 |
| background task | 后台任务 | 同事在后台通道独立执行的耗时任务，不阻塞前台继续对话 |
| steer / steering note | 发送纠偏 / 纠偏指令 | 向排队中或运行中的后台任务发出的中途方向调整说明 |
| using browser | 占用浏览器 | 后台任务持有该同事浏览器租约时的状态标识 |
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
| review & verify (wiki) | 核验并编辑 / 保存并设为已核验 | 你检查外部来源的知识库页面并保存，解除「外部来源」标记 |
| revert (wiki) | 回滚到此版 | 将知识库页面恢复为某个历史版本的内容，并生成新版本号 |

## 写法

- 中文标点（，。：「」…），引号用「」；中英文之间不强制加空格，但数字和单位之间加：「12 秒」「3 步」。
- 品牌名（OpenSuperBot、Chief、GitHub、DeepSeek……）和同事的名字原样。
- 按钮用动词短语，短：「批准」「停下」「我登录好了」。
- 同事说的话、模型生成的内容不在词典里。网关回来的原因带代码（`error.*`、`block.*`、`sandbox.*`、`notice.*`），
  在词典里翻；认不出的代码就显示网关的英文原话。
