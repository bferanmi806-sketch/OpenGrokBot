import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_SKILLS } from './builtin-skills.js'

/**
 * 共享技能：操作者写在 <数据目录>/skills/*.md 里的做事手册，加上随网关发布的只读预置手册（builtin-skills.ts 与 gateway/skills/*.md），
 * 所有同事都能读，谁也不能改；用户同名技能自动覆盖内置版本。
 * 能力（技能、工具）全员共享，上下文（记忆、routine）各归各——和 Grok Bot 划的界一样。
 * 系统提示词里只列名字和一句话，正文用 read_skill 按需取，省得每个回合都背着全部手册。
 */
export type Skill = { name: string; description: string; builtin?: boolean }

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_SKILLS = 50
const MAX_DESCRIPTION = 160
const MAX_SKILL_FILE_BYTES = 256 * 1024

type LoadedSkill = { name: string; description: string; body: string; builtin?: boolean }

export type MergedSkillsOptions = {
  userDir?: string
  builtinDir?: string
  includeEmbeddedBuiltins?: boolean
}

export function skillsDir(dataDir: string): string {
  return join(dataDir, 'skills')
}

/** 随包发布的只读内置技能目录（兼容 src/skills.ts、dist/skills.js 与桌面端 stage/gateway/dist/skills.js） */
export function defaultBuiltinSkillsDir(): string {
  return fileURLToPath(new URL('../skills', import.meta.url))
}

/** 去掉开头的 --- frontmatter ---，顺便把里面的 description 拿出来（兼容 CRLF / LF） */
function splitFrontmatter(text: string): { description?: string; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { body: text }
  const description = match[1]!.split(/\r?\n/).map((l) => l.match(/^description:\s*(.+)$/)?.[1]).find(Boolean)
  return { description: description?.trim().replace(/^["']|["']$/g, ''), body: text.slice(match[0].length) }
}

function describe(text: string): string {
  const { description, body } = splitFrontmatter(text)
  const line = description ?? body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? ''
  return line.length > MAX_DESCRIPTION ? `${line.slice(0, MAX_DESCRIPTION - 1)}…` : line
}

/**
 * 文件名就是技能名（小写字母、数字、-、_）；
 * 目录本身与条目均须为真实目录/普通文件（拒绝符号链接、目录、FIFO、设备节点），不在此提前截断 MAX_SKILLS。
 */
async function skillFiles(dir: string): Promise<string[]> {
  const dirStat = await lstat(dir).catch(() => null)
  if (!dirStat?.isDirectory()) return []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md') && NAME.test(e.name.slice(0, -3)))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 安全读取普通技能文件：lstat + O_NOFOLLOW 打开后二次校验 fd.stat() 与 256 KB 体积上限，防软链逃逸与超大文件 OOM */
async function readRegularSkillFile(dir: string, file: string): Promise<string | null> {
  const full = join(dir, file)
  try {
    const st = await lstat(full)
    if (!st.isFile() || st.size > MAX_SKILL_FILE_BYTES) return null
    const fh = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const fst = await fh.stat()
      if (!fst.isFile() || fst.size > MAX_SKILL_FILE_BYTES) return null
      return await fh.readFile('utf8')
    } finally {
      await fh.close().catch(() => {})
    }
  } catch {
    return null
  }
}

async function scanValidSkills(dir: string, cap?: number): Promise<LoadedSkill[]> {
  const files = await skillFiles(dir)
  const out: LoadedSkill[] = []
  for (const file of files) {
    const raw = await readRegularSkillFile(dir, file)
    if (raw === null) continue
    const { body } = splitFrontmatter(raw)
    out.push({
      name: file.slice(0, -3),
      description: describe(raw),
      body: body.trim(),
    })
    if (cap !== undefined && out.length >= cap) break
  }
  return out
}

export async function listSkills(dir: string): Promise<Skill[]> {
  const valid = await scanValidSkills(dir, MAX_SKILLS)
  return valid.map((s) => ({ name: s.name, description: s.description }))
}

/** 只按列表里的名字取：名字不在有效前 50 项列表里（含任何路径花样或软链）就是没有 */
export async function readSkill(dir: string, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase().replace(/\.md$/, '')
  if (!NAME.test(wanted)) return null
  const valid = await scanValidSkills(dir, MAX_SKILLS)
  const hit = valid.find((s) => s.name === wanted)
  return hit ? hit.body : null
}

/**
 * 统一解析双层技能目录（供 listMergedSkills / listAllSkills 与 readMergedSkill / readAnySkill 共用，确保列举与读取 100% 一致）：
 * 1. 扫描全部合法可读的用户技能（记录全量名字集合，即便第 51+ 个用户文件同名覆盖内置技能也不会回退泄漏内置版）；
 * 2. 优先保留最多 MAX_SKILLS（50）条用户自定义技能（不带 builtin 字段）；
 * 3. 剩余槽位按字典序补入未被用户覆盖的预置技能（标记 builtin: true），合并后按技能名字典序排列。
 */
async function resolveMergedCatalog(opts: MergedSkillsOptions): Promise<LoadedSkill[]> {
  const allUser = opts.userDir ? await scanValidSkills(opts.userDir) : []
  const userNames = new Set(allUser.map((s) => s.name))
  const userKept = allUser.slice(0, MAX_SKILLS)
  const remaining = Math.max(0, MAX_SKILLS - userKept.length)
  const builtinKept: LoadedSkill[] = []
  if (remaining > 0 && (opts.builtinDir || opts.includeEmbeddedBuiltins)) {
    const byName = new Map<string, LoadedSkill>()
    if (opts.includeEmbeddedBuiltins) {
      for (const b of BUILTIN_SKILLS) {
        if (!NAME.test(b.name)) continue
        byName.set(b.name, {
          name: b.name,
          description: b.description.length > MAX_DESCRIPTION ? `${b.description.slice(0, MAX_DESCRIPTION - 1)}…` : b.description,
          body: b.body.trim(),
          builtin: true,
        })
      }
    }
    if (opts.builtinDir) {
      const diskBuiltins = await scanValidSkills(opts.builtinDir)
      for (const s of diskBuiltins) {
        byName.set(s.name, { ...s, builtin: true })
      }
    }
    const sortedBuiltins = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const s of sortedBuiltins) {
      if (userNames.has(s.name)) continue
      builtinKept.push(s)
      if (builtinKept.length >= remaining) break
    }
  }
  return [...userKept, ...builtinKept].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export async function listMergedSkills(opts: MergedSkillsOptions): Promise<Skill[]> {
  const catalog = await resolveMergedCatalog(opts)
  return catalog.map((s) =>
    s.builtin ? { name: s.name, description: s.description, builtin: true } : { name: s.name, description: s.description },
  )
}

export async function readMergedSkill(opts: MergedSkillsOptions, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase().replace(/\.md$/, '')
  if (!NAME.test(wanted)) return null
  const catalog = await resolveMergedCatalog(opts)
  const hit = catalog.find((s) => s.name === wanted)
  return hit ? hit.body : null
}

/** 合并用户自定义技能与内置技能（如 space-design）；同名时以操作者在 <dataDir>/skills/ 中写入的版本为准 */
export async function listAllSkills(dir?: string): Promise<Skill[]> {
  return listMergedSkills({
    ...(dir ? { userDir: dir } : {}),
    includeEmbeddedBuiltins: true,
  })
}

/** 按需读取技能正文：优先读操作者目录里的自定义版本，找不到再回落到内置技能 */
export async function readAnySkill(dir: string | undefined, name: string): Promise<string | null> {
  return readMergedSkill(
    {
      ...(dir ? { userDir: dir } : {}),
      includeEmbeddedBuiltins: true,
    },
    name,
  )
}
