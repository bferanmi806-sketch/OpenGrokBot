import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILTIN_SKILLS, findBuiltinSkill } from './builtin-skills.js'

/**
 * 共享技能：操作者写在 <数据目录>/skills/*.md 里的做事手册，加上随网关内置的共享技能，所有同事都能读，谁也不能改。
 * 能力（技能、工具）全员共享，上下文（记忆、routine）各归各——和 Grok Bot 划的界一样。
 * 系统提示词里只列名字和一句话，正文用 read_skill 按需取，省得每个回合都背着全部手册。
 */
export type Skill = { name: string; description: string; builtin?: boolean }

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_SKILLS = 50
const MAX_DESCRIPTION = 160

export function skillsDir(dataDir: string): string {
  return join(dataDir, 'skills')
}

/** 去掉开头的 --- frontmatter ---，顺便把里面的 description 拿出来 */
function splitFrontmatter(text: string): { description?: string; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { body: text }
  const description = match[1]!.split('\n').map((l) => l.match(/^description:\s*(.+)$/)?.[1]).find(Boolean)
  return { description: description?.trim().replace(/^["']|["']$/g, ''), body: text.slice(match[0].length) }
}

function describe(text: string): string {
  const { description, body } = splitFrontmatter(text)
  const line = description ?? body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? ''
  return line.length > MAX_DESCRIPTION ? `${line.slice(0, MAX_DESCRIPTION - 1)}…` : line
}

/** 文件名就是技能名（小写字母、数字、-、_）；不合规矩的文件不认，目录不存在就是没有技能 */
async function skillFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir)
    return names
      .filter((f) => f.endsWith('.md') && NAME.test(f.slice(0, -3)))
      .sort()
      .slice(0, MAX_SKILLS)
  } catch {
    return []
  }
}

export async function listSkills(dir: string): Promise<Skill[]> {
  const files = await skillFiles(dir)
  const out: Skill[] = []
  for (const file of files) {
    try {
      out.push({ name: file.slice(0, -3), description: describe(await readFile(join(dir, file), 'utf8')) })
    } catch { /* 读不了的文件跳过 */ }
  }
  return out
}

/** 只按列表里的名字取：名字不在列表里（含任何路径花样）就是没有 */
export async function readSkill(dir: string, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase().replace(/\.md$/, '')
  if (!NAME.test(wanted)) return null
  const files = await skillFiles(dir)
  if (!files.includes(`${wanted}.md`)) return null
  try {
    return splitFrontmatter(await readFile(join(dir, `${wanted}.md`), 'utf8')).body.trim()
  } catch {
    return null
  }
}

/** 合并用户自定义技能与内置技能；同名时以操作者在 <dataDir>/skills/ 中写入的版本为准 */
export async function listAllSkills(dir?: string): Promise<Skill[]> {
  const userSkills = dir ? await listSkills(dir) : []
  const byName = new Map<string, Skill>()
  for (const b of BUILTIN_SKILLS) {
    byName.set(b.name, { name: b.name, description: b.description, builtin: true })
  }
  for (const u of userSkills) {
    byName.set(u.name, u)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 按需读取技能正文：优先读操作者目录里的自定义版本，找不到再回落到内置技能 */
export async function readAnySkill(dir: string | undefined, name: string): Promise<string | null> {
  if (dir) {
    const custom = await readSkill(dir, name)
    if (custom !== null) return custom
  }
  return findBuiltinSkill(name)?.body ?? null
}
