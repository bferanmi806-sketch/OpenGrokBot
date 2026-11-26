import type { T } from './i18n'
import type { MessageKey } from './i18n/en'
import type { Conversation } from './types'

type StarterTarget = Pick<Conversation, 'id' | 'kind' | 'title' | 'subtitle' | 'members'>

export type StarterArchetype =
  | 'group'
  | 'chief'
  | 'inbox-keeper'
  | 'market-watch'
  | 'researcher'
  | 'engineering'
  | 'writing'
  | 'schedule'
  | 'inbox'
  | 'market'
  | 'research'
  | 'coordination'
  | 'custom-role'
  | 'generic'

const PRESET_KEYS: Record<'chief' | 'inbox-keeper' | 'market-watch' | 'researcher', readonly [MessageKey, MessageKey, MessageKey]> = {
  chief: ['thread.starter.chief.1', 'thread.starter.chief.2', 'thread.starter.chief.3'],
  'inbox-keeper': ['thread.starter.inboxKeeper.1', 'thread.starter.inboxKeeper.2', 'thread.starter.inboxKeeper.3'],
  'market-watch': ['thread.starter.marketWatch.1', 'thread.starter.marketWatch.2', 'thread.starter.marketWatch.3'],
  researcher: ['thread.starter.researcher.1', 'thread.starter.researcher.2', 'thread.starter.researcher.3'],
}

const DOMAIN_KEYS: Record<
  'engineering' | 'writing' | 'schedule' | 'inbox' | 'market' | 'research' | 'coordination',
  readonly [MessageKey, MessageKey, MessageKey]
> = {
  engineering: ['thread.starter.role.engineering.1', 'thread.starter.role.engineering.2', 'thread.starter.role.engineering.3'],
  writing: ['thread.starter.role.writing.1', 'thread.starter.role.writing.2', 'thread.starter.role.writing.3'],
  schedule: ['thread.starter.role.schedule.1', 'thread.starter.role.schedule.2', 'thread.starter.role.schedule.3'],
  inbox: ['thread.starter.role.inbox.1', 'thread.starter.role.inbox.2', 'thread.starter.role.inbox.3'],
  market: ['thread.starter.role.market.1', 'thread.starter.role.market.2', 'thread.starter.role.market.3'],
  research: ['thread.starter.role.research.1', 'thread.starter.role.research.2', 'thread.starter.role.research.3'],
  coordination: ['thread.starter.role.coordination.1', 'thread.starter.role.coordination.2', 'thread.starter.role.coordination.3'],
}

const DOMAIN_PATTERNS: readonly [keyof typeof DOMAIN_KEYS, RegExp][] = [
  ['engineering', /(?:代码|开发|研发|工程|编程|架构|测试|运维|监控|前端|后端|全栈|排查)|\b(?:code|coding|dev|developer|engineer|engineering|frontend|backend|fullstack|qa|ops|sre|devops|ci|cd|pr|bug|debug|github|repo|deploy)\b/i],
  ['writing', /(?:写作|文案|内容运营|内容创作|社媒|公众号|推文|博客|编辑|营销|品牌|选题|撰稿)|\b(?:content|writer|writing|editor|editorial|social|marketing|blog|copy|copywriter|newsletter|brand)\b/i],
  ['schedule', /(?:日程|日历|会议|排期|差旅|行程|行政|私人助理)|\b(?:calendar|schedule|scheduling|meeting|meetings|travel|admin|executive\s+assistant|ea|booking)\b/i],
  ['inbox', /(?:邮件|收件箱|信箱|客服|工单|销售|客户|线索|跟进)|\b(?:mail|email|inbox|triage|support|ticket|tickets|sales|crm|lead|leads|customer)\b/i],
  ['market', /(?:行情|市场|金融|财务|财报|股票|美股|港股|加密|币价|汇率|定价|数据分析|指标|竞品|盯盘)|\b(?:market|markets|finance|financial|stock|stocks|ticker|crypto|fx|pricing|analyst|analytics|kpi|metric|metrics|watchlist)\b/i],
  ['research', /(?:调研|研究|情报|文献|论文|学术|知识库|查资料)|\b(?:research|researcher|scout|intel|intelligence|paper|papers|knowledge|wiki)\b/i],
  ['coordination', /(?:统筹|协调|幕僚|项目管理|项目进度|产品经理|产品规划|路线图|分派|排班|看板|总控)|\b(?:chief|coord|coordinator|pm|project|product|roadmap|dispatch)\b/i],
]

function botIdOf(c: StarterTarget): string {
  const fromMember = c.members[0]?.trim()
  if (fromMember) return fromMember
  return c.id.startsWith('dm:') ? c.id.slice(3).trim() : c.id.trim()
}

function matchDomain(text: string): keyof typeof DOMAIN_KEYS | null {
  const cleaned = text.trim()
  if (!cleaned) return null
  for (const [domain, pattern] of DOMAIN_PATTERNS) {
    if (pattern.test(cleaned)) return domain
  }
  return null
}

function clipRole(role: string): string {
  const oneLine = role.replace(/\s+/g, ' ').trim()
  const hasCjk = /[\u4e00-\u9fff]/.test(oneLine)
  const limit = hasCjk ? 24 : 38
  if (oneLine.length <= limit) return oneLine
  return `${oneLine.slice(0, limit - 1).trimEnd()}…`
}

/** 根据对话类型与同事定位判断该给哪一组推荐起手式 */
export function starterArchetype(c: StarterTarget): StarterArchetype {
  if (c.kind === 'group') return 'group'
  const id = botIdOf(c)
  if (id in PRESET_KEYS) return id as keyof typeof PRESET_KEYS
  // 先看定位（subtitle / role），再看名字（title），避免名字撞词压过真实职责
  const domain = matchDomain(c.subtitle) ?? matchDomain(c.title)
  if (domain) return domain
  return c.subtitle.trim() ? 'custom-role' : 'generic'
}

/** 返回空对话时展示的快捷推荐 tips，每个预置同事及不同定位的自定义同事各不相同 */
export function conversationStarters(c: StarterTarget, t: T): string[] {
  const kind = starterArchetype(c)
  if (kind === 'group') {
    return [t('thread.starter.group1'), t('thread.starter.group2'), t('thread.starter.group3')]
  }
  if (kind in PRESET_KEYS) {
    return PRESET_KEYS[kind as keyof typeof PRESET_KEYS].map((k) => t(k))
  }
  if (kind in DOMAIN_KEYS) {
    return DOMAIN_KEYS[kind as keyof typeof DOMAIN_KEYS].map((k) => t(k))
  }
  if (kind === 'custom-role') {
    const role = clipRole(c.subtitle)
    return [
      t('thread.starter.customRole.1', { role }),
      t('thread.starter.customRole.2', { role }),
      t('thread.starter.customRole.3', { role }),
    ]
  }
  return [
    t('thread.starter.generic.1'),
    t('thread.starter.generic.2'),
    t('thread.starter.generic.3'),
  ]
}
