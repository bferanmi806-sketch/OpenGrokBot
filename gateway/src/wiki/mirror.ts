import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isWikiKind, isWikiSlug, type WikiKind, type WikiPageDetail } from './types.js'

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function wikiRootDir(dataDir: string): string {
  return join(dataDir, 'wiki')
}

export function wikiPageFilePath(dataDir: string, kind: WikiKind, slug: string): string {
  if (!isWikiKind(kind)) {
    throw new Error(`Invalid wiki kind: ${String(kind)}`)
  }
  if (!isWikiSlug(slug)) {
    throw new Error(`Invalid wiki slug: ${String(slug)}`)
  }
  const fileName = WINDOWS_RESERVED_RE.test(slug) ? `_${slug}.md` : `${slug}.md`
  return join(wikiRootDir(dataDir), kind, fileName)
}

export function renderWikiMarkdown(page: WikiPageDetail): string {
  const tagsYaml = `[${page.tags.map((tag) => JSON.stringify(tag)).join(', ')}]`
  const updatedAtIso = new Date(page.updatedAt).toISOString()
  const frontmatter = [
    '---',
    `id: ${JSON.stringify(page.id)}`,
    `kind: ${JSON.stringify(page.kind)}`,
    `slug: ${JSON.stringify(page.slug)}`,
    `title: ${JSON.stringify(page.title)}`,
    `summary: ${JSON.stringify(page.summary)}`,
    `tags: ${tagsYaml}`,
    `version: ${page.version}`,
    `updated_by: ${JSON.stringify(page.updatedBy)}`,
    `source_tainted: ${page.sourceTainted ? 'true' : 'false'}`,
    `updated_at: ${JSON.stringify(updatedAtIso)}`,
    '---',
  ].join('\n')

  const body = page.body.trimEnd()
  return body ? `${frontmatter}\n\n${body}\n` : `${frontmatter}\n`
}

export function writeWikiMirror(dataDir: string | undefined, page: WikiPageDetail): void {
  if (!dataDir || !dataDir.trim()) return
  const filePath = wikiPageFilePath(dataDir, page.kind, page.slug)
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmpPath, renderWikiMarkdown(page), 'utf8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // Ignore temp cleanup failures so the original error surfaces
    }
    throw err
  }
}

export function removeWikiMirror(dataDir: string | undefined, kind: WikiKind, slug: string): void {
  if (!dataDir || !dataDir.trim()) return
  const filePath = wikiPageFilePath(dataDir, kind, slug)
  rmSync(filePath, { force: true })
}
