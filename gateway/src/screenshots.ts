import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Shot } from './computer.js'

const SAFE_ID = /^[a-zA-Z0-9._-]+$/
const SCREENSHOT_FILE = /^\d+\.png$/

/** 挂进 bot 容器的 /workspace：bot 在里面能读能写。 */
export function workspaceDir(dataDir: string, botId: string): string {
  return join(dataDir, 'workspaces', botId)
}

/** 网关自己的、每个 bot 一份的目录：不挂进容器，记忆和截图证据放这里，bot 改不了。 */
export function botDataDir(dataDir: string, botId: string): string {
  return join(dataDir, 'bots', botId)
}

export async function saveScreenshot(
  dataDir: string,
  botId: string,
  shot: Shot,
  now: number,
): Promise<{ url: string; width: number; height: number }> {
  const dir = join(botDataDir(dataDir, botId), 'screenshots')
  await mkdir(dir, { recursive: true })
  const file = `${now}.png`
  await writeFile(join(dir, file), shot.buffer)
  return { url: `/api/screenshots/${botId}/${file}`, width: shot.width, height: shot.height }
}

/** 新位置在前；老版本存在 workspace 里的截图照样能看。 */
export function screenshotFilePath(dataDir: string, botId: string, file: string): string[] | null {
  if (!SAFE_ID.test(botId) || botId === '..') return null
  if (!SCREENSHOT_FILE.test(file)) return null
  return [
    join(botDataDir(dataDir, botId), 'screenshots', file),
    join(workspaceDir(dataDir, botId), 'screenshots', file),
  ]
}

/** 动作日志留 90 天，截图证据也按同样的截止时间收掉老文件，免得定时巡检把磁盘慢慢塞满 */
export async function pruneScreenshots(dataDir: string, beforeMs: number): Promise<number> {
  const botsRoot = join(dataDir, 'bots')
  const botDirs = await readdir(botsRoot, { withFileTypes: true }).catch(() => [])
  let removed = 0
  for (const entry of botDirs) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name) || entry.name === '..') continue
    const shotDir = join(botsRoot, entry.name, 'screenshots')
    const files = await readdir(shotDir).catch(() => [] as string[])
    for (const file of files) {
      if (!SCREENSHOT_FILE.test(file)) continue
      const ts = Number(file.slice(0, -4))
      if (Number.isFinite(ts) && ts > 0 && ts < beforeMs) {
        await rm(join(shotDir, file), { force: true })
        removed++
      }
    }
  }
  return removed
}
