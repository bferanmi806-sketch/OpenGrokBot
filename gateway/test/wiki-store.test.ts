import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, SCHEMA_VERSION, schemaVersion } from '../src/db.js'
import { createHub } from '../src/hub.js'
import {
  removeWikiMirror,
  renderWikiMarkdown,
  wikiPageFilePath,
  wikiRootDir,
  writeWikiMirror,
} from '../src/wiki/mirror.js'
import {
  allocateWikiSlug,
  archiveWikiPage,
  getWikiPage,
  getWikiPageById,
  listWikiPages,
  listWikiRevisions,
  normalizeWikiSlug,
  revertWikiPage,
  upsertWikiPage,
} from '../src/wiki/store.js'
import { buildFtsQuery, buildSearchText, extractQueryTokens } from '../src/wiki/tokenize.js'
import {
  isWikiKind,
  MAX_WIKI_BODY_CHARS,
  MAX_WIKI_NOTE_CHARS,
  MAX_WIKI_REVISIONS,
  MAX_WIKI_SEARCH_TEXT_CHARS,
  MAX_WIKI_SUMMARY_CHARS,
  MAX_WIKI_TAG_CHARS,
  MAX_WIKI_TAGS,
  MAX_WIKI_TITLE_CHARS,
  parseWikiPageId,
  WIKI_KINDS,
  WIKI_SLUG_RE,
  WikiValidationError,
} from '../src/wiki/types.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osb-wiki-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('wiki schema v14 & hub event', () => {
  it('migrates cleanly to v14 with wiki tables, indexes, FTS5, and wiki_changed hub event', () => {
    const db = openDb(':memory:')
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(14)
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(tables).toEqual(expect.arrayContaining(['wiki_pages', 'wiki_revisions', 'wiki_fts']))

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining(['idx_wiki_pages_active', 'idx_wiki_revisions_page']))

    const hub = createHub()
    const frames: string[] = []
    hub.add({ send: (d) => frames.push(d) })
    hub.broadcast({ type: 'wiki_changed' })
    expect(frames).toEqual([JSON.stringify({ type: 'wiki_changed' })])

    expect(WIKI_KINDS).toEqual(['contact', 'client', 'project', 'topic'])
    expect(isWikiKind('client')).toBe(true)
    expect(isWikiKind('secret')).toBe(false)
    expect(parseWikiPageId('client/acme-corp')).toEqual({ kind: 'client', slug: 'acme-corp' })
    expect(parseWikiPageId('invalid/acme-corp')).toBeNull()
    expect(parseWikiPageId('client/../evil')).toBeNull()
    expect(parseWikiPageId(123 as unknown as string)).toBeNull()
    expect(parseWikiPageId(null as unknown as string)).toBeNull()
    db.close()
  })
})

describe('wiki tokenizer (CJK + English + safe FTS5 queries)', () => {
  it('emits Latin sub-tokens, CJK bigrams + short-run unigrams, deduplicates adjacent tokens, and caps length', () => {
    const eng = buildSearchText(['Acme-Corp', 'acme-corp', 'Café', 'Q3_Roadmap', 'v2.1'])
    expect(eng.split(' ')).toEqual([
      'acme',
      'corp',
      'acme',
      'corp',
      'cafe',
      'q3',
      'roadmap',
      'v2',
      '1',
    ])

    // Adjacent duplicates collapse cleanly
    expect(buildSearchText(['foo foo FOO bar'])).toBe('foo bar')

    // 4-char CJK run emits bigrams AND individual chars (length <= 4)
    expect(buildSearchText(['极光项目'])).toBe('极光 光项 项目 极 光 项 目')

    // Single-char CJK run emits unigram
    expect(buildSearchText(['张'])).toBe('张')

    // Long CJK run (> 4 chars) emits bigrams only (no unigram spam)
    expect(buildSearchText(['人工智能模型'])).toBe('人工 工智 智能 能模 模型')

    // Bounded to MAX_WIKI_SEARCH_TEXT_CHARS
    const huge = Array.from({ length: 40_000 }, (_, i) => `tok${i}`).join(' ')
    const bounded = buildSearchText([huge])
    expect(bounded.length).toBeLessThanOrEqual(MAX_WIKI_SEARCH_TEXT_CHARS)
  })

  it('extracts query tokens and builds safe FTS5 queries that never throw on operators or punctuation', () => {
    expect(extractQueryTokens('极光项目')).toEqual(['极光', '光项', '项目'])
    expect(extractQueryTokens('张伟')).toEqual(['张伟'])
    expect(extractQueryTokens('张')).toEqual(['张'])
    expect(extractQueryTokens('极光项目Q3报价')).toEqual(['极光', '光项', '项目', 'q3', '报价'])
    expect(extractQueryTokens('Acme-Corp acme')).toEqual(['acme', 'corp'])
    expect(extractQueryTokens('   *** ::: --- () ""   ')).toEqual([])

    // Cap at 24 unique tokens
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    expect(extractQueryTokens(many)).toHaveLength(24)

    expect(buildFtsQuery('   ***   ')).toBeNull()

    const nasty = buildFtsQuery('foo:bar -baz OR * (test)')
    expect(nasty).toEqual({
      match: '"foo" AND "bar" AND "baz" AND "or" AND "test"',
      tokens: ['foo', 'bar', 'baz', 'or', 'test'],
    })

    const orQuery = buildFtsQuery('极光 Aurora', 'or')
    expect(orQuery).toEqual({
      match: '"极光" OR "aurora"',
      tokens: ['极光', 'aurora'],
    })

    // Verify SQLite FTS5 executes nasty operator strings with zero syntax errors
    const db = openDb(':memory:')
    const inputs = [
      'foo:bar -baz OR * (test)',
      '"unclosed quote AND NOT NEAR/3 (foo*)',
      'title:secret ^boost +must -exclude',
      '极光项目 -报价 OR *',
    ]
    for (const raw of inputs) {
      const q = buildFtsQuery(raw)
      expect(q).not.toBeNull()
      expect(() =>
        db.prepare('SELECT page_id FROM wiki_fts WHERE wiki_fts MATCH ?').all(q!.match),
      ).not.toThrow()
    }
    db.close()
  })
})

describe('wiki slug normalization & allocation', () => {
  it('normalizes English, accented, long, and pure Chinese titles deterministically', () => {
    expect(normalizeWikiSlug('Acme Corp!')).toBe('acme-corp')
    expect(normalizeWikiSlug('  ---Café & Zürich---  ')).toBe('cafe-zurich')
    expect(normalizeWikiSlug('a'.repeat(80))).toBe('a'.repeat(64))
    expect(normalizeWikiSlug(`${'a'.repeat(63)}-z`)).toBe('a'.repeat(63))

    const cnSlug = normalizeWikiSlug('极光项目')
    expect(cnSlug).toMatch(/^p-[0-9a-f]{8}$/)
    expect(WIKI_SLUG_RE.test(cnSlug)).toBe(true)
    expect(normalizeWikiSlug('  极光项目  ')).toBe(cnSlug)
    expect(normalizeWikiSlug('张伟')).not.toBe(cnSlug)

    expect(normalizeWikiSlug('   ')).toBe('')
    expect(normalizeWikiSlug('!!!')).toBe('')
  })

  it('allocates idempotent slugs for same title, suffixes collisions, and rejects unsafe requested slugs', () => {
    const db = openDb(':memory:')

    expect(allocateWikiSlug(db, 'client', 'Acme Corp', 'Acme')).toBe('acme-corp')
    expect(() => allocateWikiSlug(db, 'client', '../etc/passwd', 'Acme')).toThrow(WikiValidationError)
    expect(() => allocateWikiSlug(db, 'client', 'a/b', 'Acme')).toThrow(WikiValidationError)
    expect(() => allocateWikiSlug(db, 'client', '   ', 'Acme')).toThrow(WikiValidationError)
    expect(() => allocateWikiSlug(db, 'client', '!!!', 'Acme')).toThrow(WikiValidationError)

    // Omitted slug: idempotent on matching title, suffixed on distinct colliding title
    const first = upsertWikiPage(db, {
      kind: 'project',
      title: '极光项目 Q3',
      body: 'Aurora Q3',
      editedBy: 'scout',
    })
    expect(first.page.slug).toBe('q3')

    // Same title without slug updates existing page idempotently
    const sameAgain = upsertWikiPage(db, {
      kind: 'project',
      title: '  极光项目 Q3  ',
      body: 'Aurora Q3 updated',
      editedBy: 'scout',
    })
    expect(sameAgain.created).toBe(false)
    expect(sameAgain.page.slug).toBe('q3')
    expect(sameAgain.page.version).toBe(2)

    // Different title sharing ASCII token gets -2
    const colliding = upsertWikiPage(db, {
      kind: 'project',
      title: '北极星项目 Q3',
      body: 'Polaris Q3',
      editedBy: 'scout',
    })
    expect(colliding.created).toBe(true)
    expect(colliding.page.slug).toBe('q3-2')

    // Repeated upsert of second title updates q3-2 idempotently
    const collidingAgain = upsertWikiPage(db, {
      kind: 'project',
      title: '北极星项目 Q3',
      body: 'Polaris Q3 v2',
      editedBy: 'scout',
    })
    expect(collidingAgain.created).toBe(false)
    expect(collidingAgain.page.slug).toBe('q3-2')
    expect(collidingAgain.page.version).toBe(2)

    // 64-char collision stays within WIKI_SLUG_RE length cap
    const longA = 'a'.repeat(64)
    const p1 = upsertWikiPage(db, { kind: 'topic', title: longA, body: 'one', editedBy: 'operator' })
    const p2 = upsertWikiPage(db, { kind: 'topic', title: `${longA} extra`, body: 'two', editedBy: 'operator' })
    expect(p1.page.slug).toBe(longA)
    expect(p2.page.slug).toBe(`${'a'.repeat(62)}-2`)
    expect(WIKI_SLUG_RE.test(p2.page.slug)).toBe(true)
    db.close()
  })
})

describe('wiki store CRUD, FTS5 matching, taint rules, revisions, revert, archive & mirror', () => {
  it('supports create, update, FTS5 search in Chinese & English, listing, and input validation', () => {
    const db = openDb(':memory:')

    const acme = upsertWikiPage(
      db,
      {
        kind: 'client',
        title: 'Acme Corp',
        summary: 'Enterprise retail client — Café division',
        tags: ['Enterprise', 'enterprise', 'Q3', '  '],
        body: 'Primary account contact prefers concise weekly summaries.',
        note: 'Initial client profile',
        editedBy: 'operator',
      },
      { now: 1000 },
    )
    expect(acme.created).toBe(true)
    expect(acme.page.id).toBe('client/acme-corp')
    expect(acme.page.tags).toEqual(['Enterprise', 'Q3'])
    expect(acme.page.version).toBe(1)
    expect(acme.page.sourceTainted).toBe(false)

    const aurora = upsertWikiPage(
      db,
      {
        kind: 'project',
        title: '极光项目',
        summary: '下一代客户门户升级计划',
        tags: ['重点项目', 'Q3'],
        body: '联系人张伟负责商务报价与交付里程碑确认。',
        editedBy: 'scout',
      },
      { now: 2000 },
    )
    expect(aurora.created).toBe(true)
    expect(aurora.page.slug).toMatch(/^p-[0-9a-f]{8}$/)

    // Direct FTS5 queries match Chinese terms, single chars, English, compound slugs, and folded diacritics
    const searchIds = (raw: string) => {
      const q = buildFtsQuery(raw)!
      return (
        db.prepare('SELECT page_id FROM wiki_fts WHERE wiki_fts MATCH ?').all(q.match) as { page_id: string }[]
      ).map((r) => r.page_id)
    }

    expect(searchIds('极光')).toEqual([aurora.page.id])
    expect(searchIds('张伟')).toEqual([aurora.page.id])
    expect(searchIds('报价')).toEqual([aurora.page.id])
    expect(searchIds('极')).toEqual([aurora.page.id])
    expect(searchIds('Acme')).toEqual(['client/acme-corp'])
    expect(searchIds('acme-corp')).toEqual(['client/acme-corp'])
    expect(searchIds('cafe')).toEqual(['client/acme-corp'])

    // Getters & listing
    expect(getWikiPage(db, 'client', 'acme-corp')?.title).toBe('Acme Corp')
    expect(getWikiPageById(db, aurora.page.id)?.title).toBe('极光项目')
    expect(getWikiPageById(db, 'bogus/id')).toBeNull()

    const listedAll = listWikiPages(db)
    expect(listedAll.total).toBe(2)
    expect(listedAll.pages.map((p) => p.id)).toEqual([aurora.page.id, 'client/acme-corp'])

    const listedClients = listWikiPages(db, { kind: 'client', limit: 10 })
    expect(listedClients.total).toBe(1)
    expect(listedClients.pages.map((p) => p.id)).toEqual(['client/acme-corp'])

    // Validation bounds
    expect(() =>
      upsertWikiPage(db, { kind: 'client', title: '   ', body: 'x', editedBy: 'operator' }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        title: 't'.repeat(MAX_WIKI_TITLE_CHARS + 1),
        body: 'x',
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        title: 'ok',
        summary: 's'.repeat(MAX_WIKI_SUMMARY_CHARS + 1),
        body: 'x',
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        title: 'ok',
        body: 'b'.repeat(MAX_WIKI_BODY_CHARS + 1),
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        title: 'ok',
        body: 'x',
        note: 'n'.repeat(MAX_WIKI_NOTE_CHARS + 1),
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        title: 'ok',
        tags: ['t'.repeat(MAX_WIKI_TAG_CHARS + 1)],
        body: 'x',
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        title: 'ok',
        tags: Array.from({ length: MAX_WIKI_TAGS + 1 }, (_, i) => `tag-${i}`),
        body: 'x',
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        slug: 123 as unknown as string,
        title: 'ok',
        body: 'x',
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        title: 'ok',
        summary: 123 as unknown as string,
        body: 'x',
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        title: 'ok',
        note: {} as unknown as string,
        body: 'x',
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        title: 'ok',
        tags: 'not-an-array' as unknown as string[],
        body: 'x',
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    expect(() =>
      upsertWikiPage(db, {
        kind: 'client',
        title: 'ok',
        tags: ['valid', 42 as unknown as string],
        body: 'x',
        editedBy: 'operator',
      }),
    ).toThrow(WikiValidationError)
    db.close()
  })

  it('enforces monotonic bot taint preservation and clears taint on operator verification', () => {
    const db = openDb(':memory:')

    // Tainted bot write marks page and revision tainted
    const v1 = upsertWikiPage(
      db,
      {
        kind: 'contact',
        slug: 'zhang-wei',
        title: '张伟',
        body: 'Extracted from external email.',
        editedBy: 'scout',
        sourceTainted: true,
      },
      { now: 100 },
    )
    expect(v1.page.sourceTainted).toBe(true)

    // Untainted bot CANNOT clear source_tainted on an active tainted page
    const v2 = upsertWikiPage(
      db,
      {
        kind: 'contact',
        slug: 'zhang-wei',
        title: '张伟',
        body: 'Reformatted by another teammate.',
        editedBy: 'chief',
        sourceTainted: false,
      },
      { now: 200 },
    )
    expect(v2.page.version).toBe(2)
    expect(v2.page.sourceTainted).toBe(true)

    // Operator save clears source_tainted to false (operator-verified)
    const v3 = upsertWikiPage(
      db,
      {
        kind: 'contact',
        slug: 'zhang-wei',
        title: '张伟',
        body: 'Verified by operator.',
        editedBy: 'operator',
        sourceTainted: true, // ignored for operator
      },
      { now: 300 },
    )
    expect(v3.page.version).toBe(3)
    expect(v3.page.sourceTainted).toBe(false)

    // Subsequent tainted bot edit re-taints the page
    const v4 = upsertWikiPage(
      db,
      {
        kind: 'contact',
        slug: 'zhang-wei',
        title: '张伟',
        body: 'Updated from webhook.',
        editedBy: 'scout',
        sourceTainted: true,
      },
      { now: 400 },
    )
    expect(v4.page.sourceTainted).toBe(true)

    const revs = listWikiRevisions(db, 'contact/zhang-wei')
    expect(revs.map((r) => [r.version, r.sourceTainted])).toEqual([
      [4, true],
      [3, false],
      [2, true],
      [1, true],
    ])

    // Archiving then re-activating from an untainted bot starts fresh with sourceTainted = false
    expect(archiveWikiPage(db, 'contact', 'zhang-wei', { now: 500 })).toBe(true)
    const v5 = upsertWikiPage(
      db,
      {
        kind: 'contact',
        slug: 'zhang-wei',
        title: '张伟',
        body: 'Freshly authored from direct operator chat.',
        editedBy: 'chief',
        sourceTainted: false,
      },
      { now: 600 },
    )
    expect(v5.created).toBe(true)
    expect(v5.page.version).toBe(5)
    expect(v5.page.archivedAt).toBeNull()
    expect(v5.page.sourceTainted).toBe(false)
    db.close()
  })

  it('prunes revisions beyond 20 and supports revert with FTS sync & taint rules', () => {
    const db = openDb(':memory:')
    const dataDir = makeTempDir()

    for (let i = 1; i <= 25; i++) {
      upsertWikiPage(
        db,
        {
          kind: 'topic',
          slug: 'pricing-policy',
          title: `Pricing Policy v${i}`,
          summary: `Summary ${i}`,
          tags: [`v${i}`],
          body: `Body iteration number ${i}`,
          note: `Edit ${i}`,
          editedBy: i === 25 ? 'scout' : 'operator',
          sourceTainted: i === 25,
        },
        { dataDir, now: i * 1000 },
      )
    }

    const revs = listWikiRevisions(db, 'topic/pricing-policy')
    expect(revs).toHaveLength(MAX_WIKI_REVISIONS)
    expect(revs[0]!.version).toBe(25)
    expect(revs[revs.length - 1]!.version).toBe(6)

    // Pruned version 1 cannot be reverted to
    expect(revertWikiPage(db, 'topic', 'pricing-policy', 1, { editedBy: 'operator', dataDir })).toBeNull()

    // Bot reverting a currently-tainted page to clean v10 still preserves taint
    // Whitespace-only note falls back to default "Reverted to v10"
    const botReverted = revertWikiPage(db, 'topic', 'pricing-policy', 10, {
      editedBy: 'chief',
      note: '   ',
      dataDir,
      now: 26_000,
    })
    expect(botReverted).not.toBeNull()
    expect(botReverted!.version).toBe(26)
    expect(botReverted!.title).toBe('Pricing Policy v10')
    expect(botReverted!.body).toBe('Body iteration number 10')
    expect(botReverted!.sourceTainted).toBe(true)

    // Operator reverting to v10 clears taint and syncs FTS + disk mirror
    const opReverted = revertWikiPage(db, 'topic', 'pricing-policy', 10, {
      editedBy: 'operator',
      note: 'Verified clean v10',
      dataDir,
      now: 27_000,
    })
    expect(opReverted).not.toBeNull()
    expect(opReverted!.version).toBe(27)
    expect(opReverted!.sourceTainted).toBe(false)

    const afterRevs = listWikiRevisions(db, 'topic/pricing-policy')
    expect(afterRevs).toHaveLength(MAX_WIKI_REVISIONS)
    expect(afterRevs[0]!.version).toBe(27)
    expect(afterRevs[0]!.note).toBe('Verified clean v10')
    expect(afterRevs[1]!.note).toBe('Reverted to v10')

    // FTS reflects reverted content (v10 matches, stale v25 does not)
    const matchV10 = db
      .prepare('SELECT page_id FROM wiki_fts WHERE wiki_fts MATCH ?')
      .all(buildFtsQuery('v10')!.match) as { page_id: string }[]
    expect(matchV10.map((r) => r.page_id)).toEqual(['topic/pricing-policy'])

    const matchV25 = db
      .prepare('SELECT page_id FROM wiki_fts WHERE wiki_fts MATCH ?')
      .all(buildFtsQuery('v25')!.match) as { page_id: string }[]
    expect(matchV25).toEqual([])

    // Disk mirror updated to v27
    const mirrorPath = wikiPageFilePath(dataDir, 'topic', 'pricing-policy')
    const diskText = readFileSync(mirrorPath, 'utf8')
    expect(diskText).toContain('version: 27')
    expect(diskText).toContain('source_tainted: false')
    expect(diskText).toContain('Body iteration number 10')

    // Bot reverting clean v27 back to tainted v25 re-taints the page
    const reTainted = revertWikiPage(db, 'topic', 'pricing-policy', 25, {
      editedBy: 'chief',
      dataDir,
      now: 28_000,
    })
    expect(reTainted).not.toBeNull()
    expect(reTainted!.version).toBe(28)
    expect(reTainted!.sourceTainted).toBe(true)
    db.close()
  })

  it('writes atomic YAML frontmatter mirrors, blocks path traversal, and removes FTS + mirror on archive', () => {
    const db = openDb(':memory:')
    const dataDir = makeTempDir()

    // Mirror path safety checks
    expect(wikiRootDir(dataDir)).toBe(join(dataDir, 'wiki'))
    expect(() => wikiPageFilePath(dataDir, 'client', '../escape')).toThrow()
    expect(() => wikiPageFilePath(dataDir, 'client', 'a/b')).toThrow()
    expect(() => wikiPageFilePath(dataDir, 'client', 'UPPER')).toThrow()
    expect(() => wikiPageFilePath(dataDir, 'unknown' as never, 'valid')).toThrow()

    const { page } = upsertWikiPage(
      db,
      {
        kind: 'client',
        slug: 'acme-corp',
        title: 'Acme: "Global" Corp',
        summary: 'Line 1: priority\n---',
        tags: ['tier:1', '极光'],
        body: '# Notes\n\nPrefers invoices in USD.',
        editedBy: 'scout',
        sourceTainted: true,
      },
      { dataDir, now: Date.UTC(2026, 10, 20, 12, 0, 0) },
    )

    const filePath = wikiPageFilePath(dataDir, 'client', 'acme-corp')
    expect(existsSync(filePath)).toBe(true)

    // No stray .tmp files left behind
    const filesInDir = readdirSync(join(dataDir, 'wiki', 'client'))
    expect(filesInDir).toEqual(['acme-corp.md'])

    const content = readFileSync(filePath, 'utf8')
    expect(content).toBe(renderWikiMarkdown(page))
    expect(content).toBe(
      [
        '---',
        'id: "client/acme-corp"',
        'kind: "client"',
        'slug: "acme-corp"',
        'title: "Acme: \\"Global\\" Corp"',
        'summary: "Line 1: priority\\n---"',
        'tags: ["tier:1", "极光"]',
        'version: 1',
        'updated_by: "scout"',
        'source_tainted: true',
        'updated_at: "2026-11-20T12:00:00.000Z"',
        '---',
        '',
        '# Notes',
        '',
        'Prefers invoices in USD.',
        '',
      ].join('\n'),
    )

    // Empty dataDir is a safe no-op for mirror helpers
    expect(() => writeWikiMirror('', page)).not.toThrow()
    expect(() => removeWikiMirror('', 'client', 'acme-corp')).not.toThrow()
    expect(existsSync(filePath)).toBe(true)

    // Archive removes FTS row and disk mirror, hides from default getters/listing, keeps audit row
    expect(archiveWikiPage(db, 'client', 'acme-corp', { dataDir, now: 9999 })).toBe(true)
    expect(archiveWikiPage(db, 'client', 'acme-corp', { dataDir, now: 10000 })).toBe(false)
    expect(existsSync(filePath)).toBe(false)
    expect(getWikiPage(db, 'client', 'acme-corp')).toBeNull()
    expect(getWikiPage(db, 'client', 'acme-corp', { includeArchived: true })?.archivedAt).toBe(9999)
    expect(listWikiPages(db).total).toBe(0)

    const ftsAfterArchive = db
      .prepare('SELECT page_id FROM wiki_fts WHERE wiki_fts MATCH ?')
      .all(buildFtsQuery('Acme')!.match)
    expect(ftsAfterArchive).toEqual([])

    // Revert on archived page returns null
    expect(revertWikiPage(db, 'client', 'acme-corp', 1, { editedBy: 'operator', dataDir })).toBeNull()
    db.close()
  })

  it('guards Windows reserved device stems in mirror filenames while keeping logical id/slug unchanged', () => {
    const db = openDb(':memory:')
    const dataDir = makeTempDir()

    expect(wikiPageFilePath(dataDir, 'topic', 'con')).toBe(join(dataDir, 'wiki', 'topic', '_con.md'))
    expect(wikiPageFilePath(dataDir, 'topic', 'nul')).toBe(join(dataDir, 'wiki', 'topic', '_nul.md'))
    expect(wikiPageFilePath(dataDir, 'topic', 'prn')).toBe(join(dataDir, 'wiki', 'topic', '_prn.md'))
    expect(wikiPageFilePath(dataDir, 'topic', 'aux')).toBe(join(dataDir, 'wiki', 'topic', '_aux.md'))
    expect(wikiPageFilePath(dataDir, 'topic', 'com1')).toBe(join(dataDir, 'wiki', 'topic', '_com1.md'))
    expect(wikiPageFilePath(dataDir, 'topic', 'lpt9')).toBe(join(dataDir, 'wiki', 'topic', '_lpt9.md'))
    expect(wikiPageFilePath(dataDir, 'topic', 'console')).toBe(join(dataDir, 'wiki', 'topic', 'console.md'))
    expect(wikiPageFilePath(dataDir, 'topic', 'con-notes')).toBe(join(dataDir, 'wiki', 'topic', 'con-notes.md'))

    const conPage = upsertWikiPage(
      db,
      {
        kind: 'topic',
        slug: 'con',
        title: 'Con',
        body: 'Safe mirror for con.',
        editedBy: 'operator',
      },
      { dataDir, now: 1000 },
    )
    const nulPage = upsertWikiPage(
      db,
      {
        kind: 'topic',
        slug: 'nul',
        title: 'Nul',
        body: 'Safe mirror for nul.',
        editedBy: 'operator',
      },
      { dataDir, now: 2000 },
    )

    expect(conPage.page.id).toBe('topic/con')
    expect(conPage.page.slug).toBe('con')
    expect(nulPage.page.id).toBe('topic/nul')
    expect(nulPage.page.slug).toBe('nul')

    const files = readdirSync(join(dataDir, 'wiki', 'topic')).sort()
    expect(files).toEqual(['_con.md', '_nul.md'])

    const conDisk = readFileSync(join(dataDir, 'wiki', 'topic', '_con.md'), 'utf8')
    expect(conDisk).toContain('id: "topic/con"')
    expect(conDisk).toContain('slug: "con"')
    expect(conDisk).toContain('Safe mirror for con.')

    // Archiving removes the guarded _con.md file cleanly
    expect(archiveWikiPage(db, 'topic', 'con', { dataDir, now: 3000 })).toBe(true)
    expect(readdirSync(join(dataDir, 'wiki', 'topic'))).toEqual(['_nul.md'])
    db.close()
  })
})
