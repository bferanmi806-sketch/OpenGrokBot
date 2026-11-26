import { describe, expect, it } from 'vitest'
import { makeT } from './i18n'
import { conversationStarters, starterArchetype } from './starters'

const dm = (id: string, title: string, subtitle: string) => ({
  id: `dm:${id}`,
  kind: 'dm' as const,
  title,
  subtitle,
  members: [id],
})

describe('conversationStarters', () => {
  it('gives each built-in teammate distinct role-specific tips in both English and Chinese', () => {
    const presets = [
      dm('chief', 'Chief', 'Keeps the board: who owns what, by when, and what needs you today'),
      dm('inbox-keeper', 'Sorter', 'Triages what you forward, drafts replies — drafts only, never sends'),
      dm('market-watch', 'Ticker', 'Watches your list, digests and threshold alerts — read-only, never trades'),
      dm('researcher', 'Scout', 'Turns a one-line question into a decision-ready brief with sources'),
    ]

    for (const lang of ['en', 'zh-CN'] as const) {
      const t = makeT(lang)
      const all = new Set<string>()
      for (const c of presets) {
        const tips = conversationStarters(c, t)
        expect(tips).toHaveLength(3)
        for (const tip of tips) {
          expect(all.has(tip), `duplicate tip in ${lang}: ${tip}`).toBe(false)
          all.add(tip)
        }
      }
      expect(all.size).toBe(12)
    }
  })

  it('classifies custom teammates by role (before title) across domains in Chinese and English', () => {
    expect(starterArchetype(dm('fe-bot', 'Lin', '排查前端 bug、审查 PR 和 CI 构建'))).toBe('engineering')
    expect(starterArchetype(dm('editor', 'Maya', 'Drafts newsletter and social posts'))).toBe('writing')
    expect(starterArchetype(dm('ea', 'Nora', '管理日历、会议和差旅排期'))).toBe('schedule')
    expect(starterArchetype(dm('sales-1', 'Alex', 'Follow up on CRM leads and customer tickets'))).toBe('inbox')
    expect(starterArchetype(dm('price-bot', 'Pulse', '盯竞品定价和关键 KPI 指标'))).toBe('market')
    expect(starterArchetype(dm('paper-bot', 'Ada', 'Deep-read papers and build research briefs'))).toBe('research')
    expect(starterArchetype(dm('pm-1', 'Sam', 'Product roadmap & project tracking'))).toBe('coordination')

    // subtitle 优先于 title，避免名字撞词盖过真实定位
    expect(starterArchetype(dm('custom-1', 'Scout 2', '管客户邮件与工单跟进'))).toBe('inbox')
    // subtitle 为空时才看名字
    expect(starterArchetype(dm('custom-2', '前端开发助手', ''))).toBe('engineering')
    // product 不会误触发 engineering 的 \bpr\b
    expect(starterArchetype(dm('custom-3', 'Helper', 'Own product planning'))).toBe('coordination')
  })

  it('interpolates custom roles cleanly (truncating long roles) and falls back to generic tips when role is empty', () => {
    const zh = makeT('zh-CN')
    const en = makeT('en')

    const customZh = conversationStarters(dm('chef', '小厨', '每周家庭菜谱与买菜清单规划'), zh)
    expect(customZh).toHaveLength(3)
    expect(customZh[0]).toContain('每周家庭菜谱与买菜清单规划')

    const longRole = '帮我整理家里所有水电账单、保修卡、体检报告和年度重要日期提醒事项清单'
    const clipped = conversationStarters(dm('home', '管家', longRole), zh)
    expect(clipped[0]).toContain('…')
    expect(clipped[0]!.length).toBeLessThan(longRole.length + 25)

    const customEn = conversationStarters(dm('legal', 'Lex', 'Contract clause review'), en)
    expect(customEn[0]).toContain('Contract clause review')

    expect(starterArchetype(dm('blank', 'Buddy', ''))).toBe('generic')
    const genericTips = conversationStarters(dm('blank', 'Buddy', ''), zh)
    expect(genericTips).toHaveLength(3)
    expect(genericTips.every((s) => !s.includes('Hacker News'))).toBe(true)
  })

  it('returns group starters for group conversations', () => {
    const group = { id: 'group:team', kind: 'group' as const, title: 'Team', subtitle: 'Chief, Scout', members: ['chief', 'researcher'] }
    expect(starterArchetype(group)).toBe('group')
    expect(conversationStarters(group, makeT('zh-CN'))).toHaveLength(3)
    expect(conversationStarters(group, makeT('en'))).toHaveLength(3)
  })
})
