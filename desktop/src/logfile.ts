import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { redact } from './diagnostics.js'

/**
 * 网关的输出落到 logs/gateway.log。超过上限就把它挪成 gateway.log.1（只留一份旧的），日志不会无限长。
 * 每行带时间，落盘前先抹掉混进来的令牌和 API key。写失败（磁盘满、目录被删）不影响 App 运行。
 */
export function openLog(file: string, opts: { maxBytes?: number; now?: () => Date } = {}): { write(line: string): void } {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const now = opts.now ?? (() => new Date())
  let size = 0
  try {
    mkdirSync(dirname(file), { recursive: true })
    size = statSync(file).size
  } catch { /* 第一次，还没有文件 */ }
  const rotate = () => {
    try { renameSync(file, `${file}.1`) } catch { /* 没有可挪的 */ }
    size = 0
  }
  if (size > maxBytes) rotate()
  return {
    write(line) {
      const text = `${now().toISOString()} ${redact(line)}\n`
      const bytes = Buffer.byteLength(text)
      try {
        if (size + bytes > maxBytes) rotate()
        appendFileSync(file, text)
        size += bytes
      } catch { /* 写不进去就算了 */ }
    },
  }
}
