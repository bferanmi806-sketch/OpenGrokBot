import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const MAX_TEAM_CHARTER_CHARS = 16_384

const MAX_DIR_PREFIX_CHARS = 40
const WINDOWS_RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export type TeamCharterSnapshot = {
  content: string
  updatedAt: number | null
}

export type WriteTeamCharterResult =
  | { ok: true; content: string; updatedAt: number | null }
  | { ok: false; code: 'invalid_content'; error: string }

/**
 * Convert an arbitrary group thread ID (e.g. `group:offsite-crew`) into a traversal-safe,
 * cross-platform directory name (macOS/Linux/Windows) with a deterministic SHA-256 suffix
 * so distinct thread IDs never collide.
 */
export function safeThreadDirName(threadId: string): string {
  const raw = typeof threadId === 'string' ? threadId : String(threadId ?? '')
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8)

  let prefix = raw
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')

  if (prefix.length > MAX_DIR_PREFIX_CHARS) {
    prefix = prefix.slice(0, MAX_DIR_PREFIX_CHARS).replace(/[._-]+$/g, '')
  }

  if (!prefix) {
    prefix = 'group'
  }

  if (WINDOWS_RESERVED_DEVICE_RE.test(prefix)) {
    prefix = `group_${prefix}`.slice(0, MAX_DIR_PREFIX_CHARS).replace(/[._-]+$/g, '')
  }

  return `${prefix}-${hash}`
}

export function teamCharterPath(dataDir: string, threadId: string): string {
  return join(dataDir, 'groups', safeThreadDirName(threadId), 'team.md')
}

export async function readTeamCharter(dataDir: string, threadId: string): Promise<TeamCharterSnapshot> {
  const filePath = teamCharterPath(dataDir, threadId)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, 'r')
    const [raw, st] = await Promise.all([handle.readFile('utf8'), handle.stat()])
    const content = raw.replace(/\r\n?/g, '\n')
    const updatedAt = Number.isFinite(st.mtimeMs) ? Math.trunc(st.mtimeMs) : null
    return { content, updatedAt }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { content: '', updatedAt: null }
    }
    throw err
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function writeTeamCharter(
  dataDir: string,
  threadId: string,
  content: string,
): Promise<WriteTeamCharterResult> {
  if (typeof content !== 'string') {
    return {
      ok: false,
      code: 'invalid_content',
      error: 'Team charter content must be a string.',
    }
  }

  const normalized = content.replace(/\r\n?/g, '\n')
  if (normalized.length > MAX_TEAM_CHARTER_CHARS) {
    return {
      ok: false,
      code: 'invalid_content',
      error: `Team charter must be at most ${MAX_TEAM_CHARTER_CHARS} characters.`,
    }
  }

  const filePath = teamCharterPath(dataDir, threadId)
  if (!normalized.trim()) {
    await rm(filePath, { force: true })
    return { ok: true, content: '', updatedAt: null }
  }

  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmpPath = join(dir, `.team.md.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tmpPath, normalized, 'utf8')
    await rename(tmpPath, filePath)
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }

  let updatedAt = Date.now()
  try {
    const st = await stat(filePath)
    if (Number.isFinite(st.mtimeMs)) {
      updatedAt = Math.trunc(st.mtimeMs)
    }
  } catch {
    // Fall back to Date.now() if stat fails right after rename.
  }

  return { ok: true, content: normalized, updatedAt }
}
