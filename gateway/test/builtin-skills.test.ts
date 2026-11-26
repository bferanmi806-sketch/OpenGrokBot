import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runTurn } from '../src/agent.js'
import { createRule } from '../src/approvals.js'
import { ensureDmThread, listMessages, openDb, upsertBot, type BotRow, type Db } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM, ToolDef } from '../src/llm.js'
import { createApp } from '../src/server.js'
import {
  defaultBuiltinSkillsDir,
  listMergedSkills,
  listSkills,
  readMergedSkill,
  readSkill,
  skillsDir,
} from '../src/skills.js'

const EXPECTED_BUILTINS: Record<string, string> = {
  'careful-browsing':
    'Navigate live websites methodically: inspect before acting, handle pagination and logins cleanly, and pause on irreversible submits.',
  'doc-drafting':
    'Draft clear, audience-tailored memos, specs, proposals, and emails with conclusions up front and explicit assumptions.',
  'meeting-minutes':
    'Turn raw meeting notes or transcripts into structured decisions, open questions, and owned action items.',
  'research-brief':
    'Synthesize multi-source web or internal findings into a cited, decision-ready brief separating facts from inference.',
  'slide-outline':
    'Design assertion-evidence slide decks with headline takeaways, visual layout cues, and concise speaker notes.',
  'spreadsheet-analysis':
    'Inspect CSV, TSV, or spreadsheet files deterministically with scripts before summarizing metrics, anomalies, and trends.',
}

const scout: BotRow = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const DM = 'dm:researcher'

const text = (content: string): AssistantTurn => ({ content, toolCalls: [], raw: { role: 'assistant', content } })
const tool = (name: string, args: unknown): AssistantTurn => ({
  content: null,
  toolCalls: [{ id: 't1', name, args }],
  raw: { role: 'assistant', content: null, tool_calls: [] },
})
const names = (tools: ToolDef[] | undefined) => (tools ?? []).map((t) => t.function.name)
const lastReply = (db: Db) =>
  listMessages(db, DM).filter((m) => m.sender !== 'user' && m.kind === 'text').at(-1)?.content

describe('built-in starter skills catalog', () => {
  it('ships all 6 starter playbooks with concise descriptions and clean bodies', async () => {
    const dir = defaultBuiltinSkillsDir()
    expect(existsSync(dir)).toBe(true)

    const listed = await listSkills(dir)
    expect(listed.map((s) => s.name)).toEqual(Object.keys(EXPECTED_BUILTINS).sort())

    for (const skill of listed) {
      expect(skill.description).toBe(EXPECTED_BUILTINS[skill.name])
      expect(skill.description.length).toBeGreaterThan(20)
      expect(skill.description.length).toBeLessThanOrEqual(150)

      const raw = readFileSync(join(dir, `${skill.name}.md`), 'utf8')
      const lineCount = raw.trimEnd().split('\n').length
      expect(lineCount).toBeGreaterThanOrEqual(40)
      expect(lineCount).toBeLessThanOrEqual(85)

      const body = await readSkill(dir, skill.name)
      expect(body).not.toBeNull()
      expect(body!.length).toBeGreaterThan(200)
      expect(body!.startsWith('---')).toBe(false)
      expect(body).not.toMatch(/^description:/m)
    }
  })

  it('verifies desktop staging and gateway package files include built-in skills', () => {
    const pkgJson = JSON.parse(readFileSync(join(defaultBuiltinSkillsDir(), '..', 'package.json'), 'utf8')) as {
      files?: string[]
    }
    expect(pkgJson.files).toEqual(expect.arrayContaining(['dist', 'skills']))

    const stageScript = readFileSync(
      join(defaultBuiltinSkillsDir(), '..', '..', 'desktop', 'scripts', 'stage.mjs'),
      'utf8',
    )
    for (const name of Object.keys(EXPECTED_BUILTINS)) {
      expect(stageScript).toContain(`gateway/skills/${name}.md`)
    }
  })
})

describe('merged skill loader (user overrides + built-in fallback)', () => {
  it('returns all 6 built-in skills marked builtin: true when userDir is missing or empty', async () => {
    const missingUserDir = join(tmpdir(), `osb-missing-${Date.now()}`, 'skills')
    const merged = await listMergedSkills({
      userDir: missingUserDir,
      builtinDir: defaultBuiltinSkillsDir(),
    })
    expect(merged).toHaveLength(6)
    expect(merged.map((s) => s.name)).toEqual(Object.keys(EXPECTED_BUILTINS).sort())
    for (const s of merged) {
      expect(s.builtin).toBe(true)
    }
  })

  it('lets a user skill override a same-named built-in skill and drops the builtin flag', async () => {
    const root = mkdtempSync(join(tmpdir(), 'osb-merge-override-'))
    const userDir = skillsDir(root)
    mkdirSync(userDir, { recursive: true })
    writeFileSync(
      join(userDir, 'meeting-minutes.md'),
      '---\ndescription: Custom board meeting template\n---\n# Custom Minutes\n\nUse the board format.\n',
    )
    writeFileSync(
      join(userDir, 'custom-triage.md'),
      '---\ndescription: Custom inbox triage playbook\n---\n# Custom Triage\n\nSort by SLA.\n',
    )

    const opts = { userDir, builtinDir: defaultBuiltinSkillsDir() }
    const merged = await listMergedSkills(opts)
    expect(merged).toHaveLength(7)

    const overridden = merged.find((s) => s.name === 'meeting-minutes')!
    expect(overridden).toEqual({
      name: 'meeting-minutes',
      description: 'Custom board meeting template',
    })
    expect('builtin' in overridden).toBe(false)

    const custom = merged.find((s) => s.name === 'custom-triage')!
    expect(custom).toEqual({
      name: 'custom-triage',
      description: 'Custom inbox triage playbook',
    })
    expect('builtin' in custom).toBe(false)

    const builtins = merged.filter((s) => s.name !== 'meeting-minutes' && s.name !== 'custom-triage')
    expect(builtins).toHaveLength(5)
    for (const b of builtins) {
      expect(b.builtin).toBe(true)
    }

    expect(await readMergedSkill(opts, 'meeting-minutes')).toBe('# Custom Minutes\n\nUse the board format.')
    expect(await readMergedSkill(opts, 'Meeting-Minutes')).toBe('# Custom Minutes\n\nUse the board format.')
    expect(await readMergedSkill(opts, 'Research-Brief.md')).toContain('#')
  })

  it('never evicts user skills when combined count exceeds MAX_SKILLS = 50, returns null for evicted built-ins, and skips oversized files without wasting quota', async () => {
    const root = mkdtempSync(join(tmpdir(), 'osb-merge-cap-'))
    const userDir = skillsDir(root)
    mkdirSync(userDir, { recursive: true })
    // Oversized file sorting early alphabetically should be ignored and NOT waste a MAX_SKILLS slot
    writeFileSync(join(userDir, 'a-huge.md'), `---\ndescription: Too large\n---\n${'x'.repeat(270 * 1024)}`)
    for (let i = 1; i <= 48; i++) {
      const slug = `z-user-skill-${String(i).padStart(2, '0')}`
      writeFileSync(join(userDir, `${slug}.md`), `---\ndescription: User skill ${i}\n---\nBody ${i}\n`)
    }

    const opts = { userDir, builtinDir: defaultBuiltinSkillsDir() }
    const merged = await listMergedSkills(opts)
    expect(merged).toHaveLength(50)
    const userItems = merged.filter((s) => !s.builtin)
    const builtinItems = merged.filter((s) => s.builtin)
    expect(userItems).toHaveLength(48)
    expect(builtinItems.map((s) => s.name)).toEqual(['careful-browsing', 'doc-drafting'])
    expect(merged.map((s) => s.name)).toEqual([...merged.map((s) => s.name)].sort())

    // Built-ins that fit in the 50-item catalog remain readable; evicted built-ins (>50) return null
    expect(await readMergedSkill(opts, 'careful-browsing')).toContain('# Careful Browsing Playbook')
    expect(await readMergedSkill(opts, 'slide-outline')).toBeNull()
    expect(await readMergedSkill(opts, 'spreadsheet-analysis')).toBeNull()
    expect(await readMergedSkill(opts, 'a-huge')).toBeNull()

    // A 51st user skill that overrides a built-in is never served from builtinDir either
    const root51 = mkdtempSync(join(tmpdir(), 'osb-merge-51-'))
    const userDir51 = skillsDir(root51)
    mkdirSync(userDir51, { recursive: true })
    for (let i = 1; i <= 50; i++) {
      writeFileSync(join(userDir51, `a-skill-${String(i).padStart(2, '0')}.md`), `---\ndescription: Skill ${i}\n---\nBody ${i}\n`)
    }
    writeFileSync(join(userDir51, 'slide-outline.md'), '---\ndescription: User 51st override\n---\nUser 51st body\n')
    const opts51 = { userDir: userDir51, builtinDir: defaultBuiltinSkillsDir() }
    expect(await listMergedSkills(opts51)).toHaveLength(50)
    expect(await readMergedSkill(opts51, 'slide-outline')).toBeNull()
  })

  it('ignores symlinked skill files and symlinked skills directories across list and read APIs (C1)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'osb-symlink-sec-'))
    const secretFile = join(root, 'auth-token')
    writeFileSync(secretFile, 'super-secret-gateway-token')

    const userDir = skillsDir(root)
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'legit.md'), '---\ndescription: Legit skill\n---\nSafe body.\n')
    symlinkSync(secretFile, join(userDir, 'evil.md'))
    symlinkSync(secretFile, join(userDir, 'meeting-minutes.md'))

    // Single-dir APIs reject symlinked files
    expect(await listSkills(userDir)).toEqual([{ name: 'legit', description: 'Legit skill' }])
    expect(await readSkill(userDir, 'evil')).toBeNull()
    expect(await readSkill(userDir, 'meeting-minutes')).toBeNull()

    // Merged APIs ignore symlinked files in userDir (never leak secret target)
    const opts = { userDir, builtinDir: defaultBuiltinSkillsDir() }
    const merged = await listMergedSkills(opts)
    expect(merged.find((s) => s.name === 'evil')).toBeUndefined()
    expect(await readMergedSkill(opts, 'evil')).toBeNull()
    // Because userDir/meeting-minutes.md is an ignored symlink, built-in meeting-minutes remains intact
    expect(merged.find((s) => s.name === 'meeting-minutes')?.builtin).toBe(true)
    expect(await readMergedSkill(opts, 'meeting-minutes')).toContain('# Meeting Minutes Playbook')

    // Symlinked skills directory itself is rejected
    const outsideDir = mkdtempSync(join(tmpdir(), 'osb-outside-dir-'))
    writeFileSync(join(outsideDir, 'leaked.md'), '---\ndescription: Leaked\n---\nLeaked body\n')
    const rootWithLinkedDir = mkdtempSync(join(tmpdir(), 'osb-linked-skills-dir-'))
    const linkedSkillsDir = join(rootWithLinkedDir, 'skills')
    symlinkSync(outsideDir, linkedSkillsDir)

    expect(await listSkills(linkedSkillsDir)).toEqual([])
    expect(await readSkill(linkedSkillsDir, 'leaked')).toBeNull()
    const mergedLinked = await listMergedSkills({ userDir: linkedSkillsDir, builtinDir: defaultBuiltinSkillsDir() })
    expect(mergedLinked.find((s) => s.name === 'leaked')).toBeUndefined()
    expect(await readMergedSkill({ userDir: linkedSkillsDir, builtinDir: defaultBuiltinSkillsDir() }, 'leaked')).toBeNull()
  })

  it('parses Windows CRLF multi-field frontmatter cleanly without trailing CR (M2)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'osb-crlf-'))
    const userDir = skillsDir(root)
    mkdirSync(userDir, { recursive: true })
    writeFileSync(
      join(userDir, 'win-playbook.md'),
      '---\r\ntitle: Windows Playbook\r\ndescription: "Clean CRLF description"\r\nauthor: ops\r\n---\r\n# Heading\r\n\r\nFirst body line.\r\n',
    )
    writeFileSync(
      join(userDir, 'win-fallback.md'),
      '# Title Only\r\n\r\nFallback CRLF description line.\r\n',
    )
    const listed = await listSkills(userDir)
    expect(listed).toEqual([
      { name: 'win-fallback', description: 'Fallback CRLF description line.' },
      { name: 'win-playbook', description: 'Clean CRLF description' },
    ])
    expect(await readSkill(userDir, 'win-playbook')).toBe('# Heading\r\n\r\nFirst body line.')
  })

  it('checks execReadSkill allowlist in agent.ts before invoking onReadSkill (I1 defense-in-depth)', async () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)
    const onReadSkill = vi.fn(async (name: string) => (name === 'meeting-minutes' ? 'Minutes body' : 'UNEXPECTED'))
    let turn = 0
    const seenToolOutputs: string[] = []
    const llm: LLM = {
      async chat(messages) {
        for (const m of messages) {
          if (m.role === 'tool') seenToolOutputs.push(String(m.content))
        }
        turn += 1
        if (turn === 1) return tool('read_skill', { name: 'unlisted-skill' })
        if (turn === 2) return tool('read_skill', { name: 'Meeting-Minutes.md' })
        return text('Done.')
      },
    }
    await runTurn(
      {
        db,
        llm,
        bot: scout,
        soul: '',
        threadId,
        origin: 'operator',
        skills: [{ name: 'meeting-minutes', description: 'Minutes', builtin: true }],
        onReadSkill,
      },
      'test skills',
      { onMessage: () => {}, onStatus: () => {} },
    )
    // First call ('unlisted-skill') was blocked before onReadSkill was ever called; second call normalized 'Meeting-Minutes.md' -> 'meeting-minutes'
    expect(onReadSkill).toHaveBeenCalledTimes(1)
    expect(onReadSkill).toHaveBeenCalledWith('meeting-minutes')
    expect(seenToolOutputs[0]).toBe('No skill called "unlisted-skill". The shared skills are: meeting-minutes.')
    expect(seenToolOutputs.at(-1)).toBe('Minutes body')
  })

  it('rejects path traversal and invalid names in readMergedSkill', async () => {
    const root = mkdtempSync(join(tmpdir(), 'osb-merge-sec-'))
    const userDir = skillsDir(root)
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(root, 'secret.md'), 'top secret')

    const opts = { userDir, builtinDir: defaultBuiltinSkillsDir() }
    for (const bad of ['../../package.json', '../src/skills', '../secret', '../../etc/passwd', '../package', '.hidden']) {
      expect(await readMergedSkill(opts, bad)).toBeNull()
    }
  })
})

describe('createApp with builtinSkills: true', () => {
  it('exposes built-in skills on a fresh empty dataDir without tainting operator turns', async () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    ensureDmThread(db, scout.id)
    createRule(db, { botId: 'researcher', kind: 'email', target: 'alice@acme.com', duration: 'always', now: Date.now() })

    const dataDir = mkdtempSync(join(tmpdir(), 'osb-empty-datadir-'))
    const seen: { messages: ChatMsg[]; tools: ToolDef[] | undefined }[] = []
    let step = 0
    const llm: LLM = {
      async chat(messages, tools) {
        seen.push({ messages: messages.map((m) => ({ ...m })), tools })
        step += 1
        if (step === 1) return tool('read_skill', { name: 'spreadsheet-analysis' })
        if (step === 2) {
          return tool('hold_for_approval', {
            action: 'send spreadsheet summary',
            kind: 'email',
            target: 'alice@acme.com',
          })
        }
        return text('Analyzed and sent.')
      },
    }

    const { app } = createApp({ db, llm, dataDir, chiefId: 'researcher', builtinSkills: true })

    // Computer panel lists all 6 built-in skills with builtin: true even when <data>/skills does not exist
    const panelRes = await app.request('/api/bots/researcher/computer')
    expect(panelRes.status).toBe(200)
    const panel = (await panelRes.json()) as { skills: Array<{ name: string; description: string; builtin?: boolean }> }
    expect(panel.skills).toHaveLength(7)
    expect(panel.skills.every((s) => s.builtin === true)).toBe(true)
    expect(panel.skills.some((s) => s.name === 'space-design')).toBe(true)

    // Turn prep injects all 6 skills into system prompt, provides read_skill, and keeps turn untainted (rule auto-approves!)
    await app.request(`/api/threads/${DM}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'check numbers.csv and email Alice' }),
    })
    await vi.waitFor(() => expect(lastReply(db)).toBe('Analyzed and sent.'))

    const sysPrompt = String(seen[0]!.messages[0]!.content)
    for (const [name, desc] of Object.entries(EXPECTED_BUILTINS)) {
      expect(sysPrompt).toContain(`- ${name} — ${desc}`)
    }
    expect(names(seen[0]!.tools)).toContain('read_skill')

    const skillResult = String(seen[1]!.messages.find((m) => m.role === 'tool')!.content)
    expect(skillResult).toContain('python3')
    expect(skillResult.startsWith('---')).toBe(false)

    // Verify reading a built-in skill did NOT taint the turn: the standing approval rule auto-approved hold_for_approval!
    const approvalChips = listMessages(db, DM).filter((m) => m.kind === 'approval_request')
    expect(approvalChips).toHaveLength(1)
    expect(approvalChips[0]!.payload).toMatchObject({
      status: 'approved',
      rule: expect.objectContaining({ kind: 'email', target: 'alice@acme.com' }),
    })
    expect(approvalChips[0]!.payload).not.toHaveProperty('ruleHeld')
  })

  it('works even when dataDir is omitted as long as builtinSkills is enabled', async () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    ensureDmThread(db, scout.id)
    const llm: LLM = { async chat() { return text('hi') } }
    const { app } = createApp({ db, llm, builtinSkills: true })
    const panel = (await (await app.request('/api/bots/researcher/computer')).json()) as {
      skills: Array<{ name: string; builtin?: boolean }>
    }
    expect(panel.skills).toHaveLength(7)
    expect(panel.skills.every((s) => s.builtin === true)).toBe(true)
  })
})
