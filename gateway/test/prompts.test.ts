import { describe, expect, it } from 'vitest'
import {
  MAX_MANUAL_CHARS,
  MAX_MEMORY_CHARS,
  MAX_SKILL_DESC_CHARS,
  MAX_SOUL_CHARS,
  buildSystemPrompt,
  timeNote,
  withStableTimeNotes,
  withTimeNote,
} from '../src/prompts.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research briefs', emoji: '🔎', soul_path: '' }

describe('buildSystemPrompt', () => {
  it('includes name, role, soul and report grammar', () => {
    const p = buildSystemPrompt(bot, '# Scout\nYou are Scout.')
    expect(p).toContain('Scout')
    expect(p).toContain('research briefs')
    expect(p).toContain('You are Scout.')
    expect(p).toContain('message_user') // 汇报语法规范
    expect(p).toContain('"report"')
  })

  it('omits role line when empty', () => {
    const p = buildSystemPrompt({ ...bot, role: '' }, 'soul')
    expect(p).not.toContain('Your job:')
  })

  it('tells a teammate with a computer where the files its operator sends end up', () => {
    for (const kind of ['docker', 'local'] as const) {
      const p = buildSystemPrompt(bot, 'soul', { hasComputer: true, computer: { kind, shell: false } })
      expect(p).toContain('uploads/')
      expect(p).toMatch(/attaches? .*thread/i)
    }
    expect(buildSystemPrompt(bot, 'soul')).not.toContain('uploads/')
  })

  it('swaps the no-computer note for the computer briefing when one is attached', () => {
    expect(buildSystemPrompt(bot, 'soul')).toContain('no shell, browser, or file tools')
    const withComputer = buildSystemPrompt(bot, 'soul', { hasComputer: true })
    expect(withComputer).toContain('your own computer')
    expect(withComputer).toContain('browser_screenshot')
    expect(withComputer).not.toContain('no shell, browser, or file tools')
  })

  it('carries the approval discipline and standing rules', () => {
    const p = buildSystemPrompt(bot, 'soul', { memory: '- quiet accounts wait for your read' })
    expect(p).toContain('hold_for_approval')
    expect(p).toContain('Standing rules')
    expect(p).toContain('quiet accounts wait for your read')
  })

  it('omits the standing-rules block when memory is empty', () => {
    expect(buildSystemPrompt(bot, 'soul', { memory: '   ' })).not.toContain('Standing rules')
  })
})

describe('persona files', () => {
  it('strips SOUL.md frontmatter so metadata never reaches the model', () => {
    const p = buildSystemPrompt(bot, '---\nrole: research briefs\nemoji: 🔎\n---\n# Scout\nYou are Scout.')
    expect(p).toContain('You are Scout.')
    expect(p).not.toContain('emoji:')
  })

  it('includes the operating manual (AGENTS.md) with its hard boundaries', () => {
    const p = buildSystemPrompt(bot, 'soul', { manual: '## Hard boundaries\n- Draft only. Never send.' })
    expect(p).toContain('## Operating manual')
    expect(p).toContain('Draft only. Never send.')
  })

  it('keeps the shared rules ahead of anything bot-specific so the prefix stays cacheable', () => {
    const p = buildSystemPrompt(bot, 'SOUL-TEXT', { memory: '- MEMORY-RULE', hasComputer: true })
    expect(p.indexOf('## How you report work')).toBeLessThan(p.indexOf('SOUL-TEXT'))
    expect(p.indexOf('## Your computer')).toBeLessThan(p.indexOf('SOUL-TEXT'))
    expect(p.indexOf('SOUL-TEXT')).toBeLessThan(p.indexOf('MEMORY-RULE'))
  })

  it('enforces independent character budgets per instruction chain so a huge manual never crowds out memory', () => {
    const hugeSoul = 'S'.repeat(MAX_SOUL_CHARS + 500)
    const hugeManual = 'M'.repeat(MAX_MANUAL_CHARS + 1_000)
    const hugeMemory = 'R'.repeat(MAX_MEMORY_CHARS + 500)
    const longDesc = 'D'.repeat(MAX_SKILL_DESC_CHARS + 200)
    const p = buildSystemPrompt(bot, hugeSoul, {
      manual: hugeManual,
      memory: hugeMemory,
      skills: [{ name: 'triage', description: longDesc }],
    })
    expect(p).toContain('SOUL.md truncated')
    expect(p).toContain('AGENTS.md truncated')
    expect(p).toContain('MEMORY.md truncated')
    expect(p).toContain('## Standing rules your operator gave you')
    expect(p).toContain(`- triage — ${'D'.repeat(MAX_SKILL_DESC_CHARS)}…`)
  })

  it('produces byte-identical system prompts regardless of routine/connector/mcp/skill input ordering', () => {
    const p1 = buildSystemPrompt(bot, 'soul', {
      routines: [
        { id: 5, name: 'B', human: 'daily', enabled: false },
        { id: 2, name: 'A', human: 'hourly', enabled: true },
      ],
      connectors: [
        { id: 'c2', app: 'slack', label: 'Team', status: 'active' },
        { id: 'c1', app: 'gmail', label: 'Work', status: 'active' },
      ],
      mcpServers: [
        { id: 'm2', name: 'Notion', slug: 'notion', enabled: true, status: 'connected', toolCount: 2 },
        { id: 'm1', name: 'GitHub', slug: 'github', enabled: true, status: 'connected', toolCount: 3 },
      ],
      skills: [
        { name: 'z-skill', description: 'Z' },
        { name: 'a-skill', description: 'A' },
      ],
    })
    const p2 = buildSystemPrompt(bot, 'soul', {
      routines: [
        { id: 2, name: 'A', human: 'hourly', enabled: true },
        { id: 5, name: 'B', human: 'daily', enabled: false },
      ],
      connectors: [
        { id: 'c1', app: 'gmail', label: 'Work', status: 'active' },
        { id: 'c2', app: 'slack', label: 'Team', status: 'active' },
      ],
      mcpServers: [
        { id: 'm1', name: 'GitHub', slug: 'github', enabled: true, status: 'connected', toolCount: 3 },
        { id: 'm2', name: 'Notion', slug: 'notion', enabled: true, status: 'connected', toolCount: 2 },
      ],
      skills: [
        { name: 'a-skill', description: 'A' },
        { name: 'z-skill', description: 'Z' },
      ],
    })
    expect(p1).toBe(p2)
  })
})

describe('routines in the prompt', () => {
  it('lists the bot\'s own routines with ids so it can stop one', () => {
    const p = buildSystemPrompt(bot, 'soul', {
      routines: [
        { id: 3, name: 'Morning digest', human: 'every day at 09:00', enabled: true },
        { id: 5, name: 'Old sweep', human: 'every Monday at 08:00', enabled: false },
      ],
    })
    expect(p).toContain('#3 Morning digest — every day at 09:00')
    expect(p).toContain('#5 Old sweep — every Monday at 08:00 (paused)')
    expect(p).toContain('stop_routine')
  })

  it('says nothing about routines when there are none', () => {
    expect(buildSystemPrompt(bot, 'soul', { routines: [] })).not.toContain('## Your routines')
  })
})

describe('time awareness', () => {
  it('formats the local time with weekday and timezone', () => {
    const note = timeNote(new Date('2026-09-27T14:40:00Z'), 'Asia/Shanghai')
    expect(note).toContain('Sunday 2026-09-27 22:40')
    expect(note).toContain('Asia/Shanghai')
  })

  it('appends the note to the last user message only, without mutating history', () => {
    const history = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'earlier' },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: 'latest' },
    ]
    const out = withTimeNote(history, '(Current time: X)')
    expect(out[3]!.content).toBe('latest\n\n(Current time: X)')
    expect(out[1]!.content).toBe('earlier')
    expect(history[3]!.content).toBe('latest')
  })

  it('keeps prior user messages byte-identical across turns and throttles notes within 10 minutes', () => {
    const t1 = Date.parse('2026-09-27T14:40:00Z')
    const t2 = Date.parse('2026-09-27T14:45:00Z') // +5 min: throttled
    const t3 = Date.parse('2026-09-27T14:55:00Z') // +15 min from t1: new stamp

    const turn1 = withStableTimeNotes([
      { msg: { role: 'system' as const, content: 'sys' } },
      { msg: { role: 'user' as const, content: 'first' }, at: t1 },
    ], 'Asia/Shanghai')

    const turn2 = withStableTimeNotes([
      { msg: { role: 'system' as const, content: 'sys' } },
      { msg: { role: 'user' as const, content: 'first' }, at: t1 },
      { msg: { role: 'assistant' as const, content: 'ok' } },
      { msg: { role: 'user' as const, content: 'second' }, at: t2 },
    ], 'Asia/Shanghai')

    const turn3 = withStableTimeNotes([
      { msg: { role: 'system' as const, content: 'sys' } },
      { msg: { role: 'user' as const, content: 'first' }, at: t1 },
      { msg: { role: 'assistant' as const, content: 'ok' } },
      { msg: { role: 'user' as const, content: 'second' }, at: t2 },
      { msg: { role: 'assistant' as const, content: 'done' } },
      { msg: { role: 'user' as const, content: 'third' }, at: t3 },
    ], 'Asia/Shanghai')

    // Prefix stays byte-identical across turns
    expect(turn1[1]!.content).toContain('Sunday 2026-09-27 22:40')
    expect(turn2[1]!.content).toBe(turn1[1]!.content)
    expect(turn2[3]!.content).toBe('second')
    expect(turn3[1]!.content).toBe(turn1[1]!.content)
    expect(turn3[3]!.content).toBe('second')
    expect(turn3[5]!.content).toContain('Sunday 2026-09-27 22:55')
  })
})
