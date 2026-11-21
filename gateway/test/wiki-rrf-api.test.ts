import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { createHub } from '../src/hub.js'
import { createApp } from '../src/server.js'
import { wikiPageFilePath } from '../src/wiki/mirror.js'
import {
  DEFAULT_WIKI_SEARCH_LIMIT,
  extractWikiSnippet,
  MAX_RRF_QUERIES,
  MAX_WIKI_SEARCH_LIMIT,
  RRF_K,
  searchWikiRrf,
  WIKI_SNIPPET_MAX_CHARS,
} from '../src/wiki/rrf.js'
import { archiveWikiPage, upsertWikiPage } from '../src/wiki/store.js'
import { MAX_WIKI_TITLE_CHARS, type WikiSearchHit } from '../src/wiki/types.js'

const okLlm = {
  chat: async () => ({ content: 'ok', toolCalls: [], raw: { role: 'assistant' as const, content: 'ok' } }),
}

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osb-wiki-api-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('multi-query RRF wiki search (rrf.ts)', () => {
  it('boosts bilingual pages matching multiple queries above single-query hits and deduplicates queries', () => {
    const db = openDb(':memory:')
    const now = Date.UTC(2026, 10, 20, 12, 0, 0)

    upsertWikiPage(
      db,
      {
        kind: 'project',
        slug: 'aurora-only',
        title: 'Aurora Telemetry',
        summary: 'Aurora dashboard notes',
        tags: ['Aurora'],
        body: 'Aurora metrics and telemetry pipeline.',
        editedBy: 'operator',
      },
      { now },
    )
    upsertWikiPage(
      db,
      {
        kind: 'project',
        slug: 'jiguang-only',
        title: '极光监控',
        summary: '极光监控与告警说明',
        tags: ['极光'],
        body: '极光日常运维监控手册。',
        editedBy: 'operator',
      },
      { now },
    )
    upsertWikiPage(
      db,
      {
        kind: 'project',
        slug: 'aurora-bilingual',
        title: '极光项目 (Project Aurora)',
        summary: '极光 / Aurora 双语客户门户计划',
        tags: ['极光', 'Aurora'],
        body: 'Project Aurora (极光项目) unifies bilingual client reporting.',
        editedBy: 'operator',
      },
      { now },
    )

    const hits = searchWikiRrf(db, { queries: ['极光', 'Aurora'], now })
    expect(hits).toHaveLength(3)
    expect(hits[0]!.id).toBe('project/aurora-bilingual')
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
    expect(hits[0]!.score).toBeGreaterThan(hits[2]!.score)

    // Case-insensitive query deduplication prevents double-counting
    const single = searchWikiRrf(db, { queries: ['Aurora'], now })
    const duped = searchWikiRrf(db, { queries: ['Aurora', 'aurora', '  AURORA  ', '   ', '***'], now })
    expect(duped.map((h) => [h.id, h.score])).toEqual(single.map((h) => [h.id, h.score]))

    // Reordered identical token sets ("aurora client" vs "client aurora") also deduplicate
    const ordered = searchWikiRrf(db, { queries: ['aurora client'], now })
    const reordered = searchWikiRrf(db, { queries: ['aurora client', 'client aurora', 'Client Aurora'], now })
    expect(ordered).toHaveLength(1)
    expect(reordered.map((h) => [h.id, h.score])).toEqual(ordered.map((h) => [h.id, h.score]))

    // Blank / punctuation-only queries return []
    expect(searchWikiRrf(db, { queries: ['', '   ', '*** ---'], now })).toEqual([])
    expect(searchWikiRrf(db, { queries: [], now })).toEqual([])

    // Respects MAX_RRF_QUERIES = 6 cap (7th distinct query is ignored)
    upsertWikiPage(
      db,
      {
        kind: 'topic',
        slug: 'seventh-only',
        title: 'Seventh Query Marker',
        body: 'uniqueseventhtoken',
        editedBy: 'operator',
      },
      { now },
    )
    const capped = searchWikiRrf(db, {
      queries: ['q1alpha', 'q2beta', 'q3gamma', 'q4delta', 'q5epsilon', 'q6zeta', 'uniqueseventhtoken'],
      now,
    })
    expect(MAX_RRF_QUERIES).toBe(6)
    expect(capped).toEqual([])

    db.close()
  })

  it('falls back to OR at 0.5x weight for >=3-token queries with 0 AND hits and ranks exact AND above OR', () => {
    const db = openDb(':memory:')
    const now = Date.UTC(2026, 10, 20, 12, 0, 0)

    upsertWikiPage(
      db,
      {
        kind: 'topic',
        slug: 'exact-target',
        title: 'Billing Cadence',
        body: 'ExactMatchToken billing cadence documentation.',
        editedBy: 'operator',
      },
      { now },
    )
    upsertWikiPage(
      db,
      {
        kind: 'topic',
        slug: 'partial-target',
        title: 'Onboarding Checklist',
        body: 'PartialToken onboarding steps for new teammates.',
        editedBy: 'operator',
      },
      { now },
    )

    // 2-token query with 0 AND hits does NOT trigger OR fallback
    expect(searchWikiRrf(db, { queries: ['PartialToken nonexistent'], now })).toEqual([])

    // 3-token query with 0 AND hits triggers OR fallback at 0.5x weight
    const orOnly = searchWikiRrf(db, { queries: ['PartialToken missingtwo missingthree'], now })
    expect(orOnly.map((h) => h.id)).toEqual(['topic/partial-target'])
    expect(orOnly[0]!.score).toBeCloseTo(0.5 / (RRF_K + 1), 10)

    // Exact AND match (weight 1.0) outranks OR fallback match (weight 0.5) by 2x at equal rank & age
    const combined = searchWikiRrf(db, {
      queries: ['ExactMatchToken', 'PartialToken missingtwo missingthree'],
      now,
    })
    expect(combined.map((h) => h.id)).toEqual(['topic/exact-target', 'topic/partial-target'])
    expect(combined[0]!.score / combined[1]!.score).toBeCloseTo(2.0, 10)

    db.close()
  })

  it('applies gentle recency decay so recent identical pages outrank 180-day-old pages', () => {
    const db = openDb(':memory:')
    const now = Date.UTC(2026, 10, 20, 12, 0, 0)
    const oldTs = now - 180 * 86_400_000

    upsertWikiPage(
      db,
      {
        kind: 'client',
        slug: 'old-client',
        title: 'Quarterly Review Profile',
        body: 'Identical quarterly review notes for comparison.',
        editedBy: 'operator',
      },
      { now: oldTs },
    )
    upsertWikiPage(
      db,
      {
        kind: 'client',
        slug: 'new-client',
        title: 'Quarterly Review Profile',
        body: 'Identical quarterly review notes for comparison.',
        editedBy: 'operator',
      },
      { now },
    )

    const hits = searchWikiRrf(db, { queries: ['quarterly'], now })
    expect(hits.map((h) => h.id)).toEqual(['client/new-client', 'client/old-client'])

    const expectedRecentDecay = 1.0
    const expectedOldDecay = 0.85 + 0.15 * Math.exp(-180 / 90)
    expect(hits[0]!.score).toBeCloseTo((1 / (RRF_K + 1)) * expectedRecentDecay, 10)
    expect(hits[1]!.score).toBeCloseTo((1 / (RRF_K + 2)) * expectedOldDecay, 10)
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)

    // Future updatedAt clamps ageDays to 0 (decay stays 1.0, never > 1.0)
    const futureHits = searchWikiRrf(db, { queries: ['quarterly'], now: oldTs - 10_000 })
    expect(futureHits[0]!.score).toBeCloseTo(1 / (RRF_K + 1), 10)

    db.close()
  })

  it('handles FTS5 operators safely, enforces kind/archived filters, and clamps limit', () => {
    const db = openDb(':memory:')
    const now = Date.UTC(2026, 10, 20, 12, 0, 0)

    upsertWikiPage(
      db,
      {
        kind: 'topic',
        slug: 'operator-safety',
        title: 'Special Tokens',
        body: 'Contains foo bar baz or test inside plain prose.',
        editedBy: 'operator',
      },
      { now },
    )

    const nastyQueries = [
      'foo:bar -baz OR * (test)',
      '"unclosed quote AND NOT NEAR/3 (foo*)',
      'title:secret ^boost +must -exclude',
    ]
    for (const q of nastyQueries) {
      expect(() => searchWikiRrf(db, { queries: [q], now })).not.toThrow()
    }
    const safeMatch = searchWikiRrf(db, { queries: ['foo:bar -baz OR * (test)'], now })
    expect(safeMatch.map((h) => h.id)).toEqual(['topic/operator-safety'])

    // Kind filter & archive exclusion
    expect(searchWikiRrf(db, { queries: ['foo'], kind: 'client', now })).toEqual([])
    expect(searchWikiRrf(db, { queries: ['foo'], kind: 'topic', now })).toHaveLength(1)
    archiveWikiPage(db, 'topic', 'operator-safety', { now: now + 1000 })
    expect(searchWikiRrf(db, { queries: ['foo'], now: now + 1000 })).toEqual([])

    // Default limit (8) and max limit clamp (20)
    for (let i = 1; i <= 25; i++) {
      upsertWikiPage(
        db,
        {
          kind: 'contact',
          slug: `person-${String(i).padStart(2, '0')}`,
          title: `Contact ${i}`,
          body: 'sharedkeyword across many contacts',
          editedBy: 'operator',
        },
        { now: now + i },
      )
    }
    expect(searchWikiRrf(db, { queries: ['sharedkeyword'], now: now + 100 })).toHaveLength(DEFAULT_WIKI_SEARCH_LIMIT)
    expect(searchWikiRrf(db, { queries: ['sharedkeyword'], limit: 99, now: now + 100 })).toHaveLength(
      MAX_WIKI_SEARCH_LIMIT,
    )
    expect(searchWikiRrf(db, { queries: ['sharedkeyword'], limit: 0, now: now + 100 })).toHaveLength(1)

    db.close()
  })

  it('extracts centered whitespace-collapsed snippets for English, CJK, diacritics, and summary/title fallbacks', () => {
    const enPrefix = 'Intro background text repeated. '.repeat(12)
    const enSuffix = ' Trailing operational details repeated.'.repeat(12)
    const enSnippet = extractWikiSnippet(
      {
        title: 'English Doc',
        summary: 'Short summary',
        body: `${enPrefix}\n\n\tCritical   Aurora   Milestone\t\n\n${enSuffix}`,
      },
      ['aurora'],
    )
    expect(enSnippet.length).toBeLessThanOrEqual(WIKI_SNIPPET_MAX_CHARS)
    expect(enSnippet).not.toMatch(/\s{2,}/)
    expect(enSnippet.startsWith('…')).toBe(true)
    expect(enSnippet.endsWith('…')).toBe(true)
    expect(enSnippet).toContain('Critical Aurora Milestone')

    const cjkPrefix = '前情提要与历史沟通记录汇总说明。'.repeat(18)
    const cjkSuffix = '后续跟进计划与团队分工安排说明。'.repeat(18)
    const cjkSnippet = extractWikiSnippet(
      {
        title: '中文文档',
        summary: '',
        body: `${cjkPrefix}联系人张伟负责极光项目商务报价确认${cjkSuffix}`,
      },
      ['极光', '光项', '项目'],
    )
    expect(cjkSnippet.length).toBeLessThanOrEqual(WIKI_SNIPPET_MAX_CHARS)
    expect(cjkSnippet.startsWith('…')).toBe(true)
    expect(cjkSnippet.endsWith('…')).toBe(true)
    expect(cjkSnippet).toContain('极光项目')

    // Diacritic fallback matches "Café" when queried with "cafe"
    const cafeSnippet = extractWikiSnippet(
      {
        title: 'Europe',
        summary: '',
        body: `${'Background sentence here. '.repeat(15)}Regional Café headquarters in Zurich.${' More context here.'.repeat(15)}`,
      },
      ['cafe'],
    )
    expect(cafeSnippet).toContain('Café')
    expect(cafeSnippet.length).toBeLessThanOrEqual(WIKI_SNIPPET_MAX_CHARS)

    // Summary and title fallbacks when body is empty
    expect(extractWikiSnippet({ title: 'Only Title', summary: 'Summary   line', body: '   ' }, ['summary'])).toBe(
      'Summary line',
    )
    expect(extractWikiSnippet({ title: 'Fallback   Title', summary: '', body: '' }, ['title'])).toBe('Fallback Title')
    expect(extractWikiSnippet({ title: '', summary: '', body: '' }, ['anything'])).toBe('')

    // Mixed-case & accented direct tokens match case-insensitively
    expect(
      extractWikiSnippet(
        {
          title: 'Mixed Case',
          summary: '',
          body: `${enPrefix}Target aurora milestone${enSuffix}`,
        },
        ['AuRoRa'],
      ),
    ).toContain('Target aurora milestone')
    expect(
      extractWikiSnippet(
        {
          title: 'ASCII Body',
          summary: '',
          body: `${enPrefix}Regional cafe hub${enSuffix}`,
        },
        ['CAFÉ'],
      ),
    ).toContain('Regional cafe hub')
    expect(
      extractWikiSnippet(
        {
          title: 'Accented Body',
          summary: '',
          body: `${enPrefix}Regional Café hub${enSuffix}`,
        },
        ['CAFE'],
      ),
    ).toContain('Regional Café hub')

    // Emoji / UTF-16 surrogate pairs at slice boundaries and maxChars = 1 never emit lone surrogates
    const hasLoneSurrogate = (s: string): boolean => {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = s.charCodeAt(i + 1)
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true
          i += 1
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          return true
        }
      }
      return false
    }
    const emojiBody = `${'🚀'.repeat(120)}Aurora${'🎉'.repeat(120)}`
    const emojiCentered = extractWikiSnippet({ title: '', summary: '', body: emojiBody }, ['aurora'])
    expect(emojiCentered.length).toBeLessThanOrEqual(WIKI_SNIPPET_MAX_CHARS)
    expect(emojiCentered).toContain('Aurora')
    expect(hasLoneSurrogate(emojiCentered)).toBe(false)

    const emojiNoMatch = extractWikiSnippet({ title: '', summary: '', body: '🚀'.repeat(150) }, ['nomatch'])
    expect(emojiNoMatch.length).toBeLessThanOrEqual(WIKI_SNIPPET_MAX_CHARS)
    expect(hasLoneSurrogate(emojiNoMatch)).toBe(false)

    const emojiTiny = extractWikiSnippet({ title: '', summary: '', body: '🚀abc' }, ['nomatch'], 1)
    expect(emojiTiny).toBe('')
    expect(hasLoneSurrogate(emojiTiny)).toBe(false)

    // >220-char spaceless token in body and as direct match token stays strictly bounded
    const longSpaceless = `${'x'.repeat(140)}TARGET${'y'.repeat(140)}`
    const spacelessCentered = extractWikiSnippet({ title: '', summary: '', body: longSpaceless }, ['target'])
    expect(spacelessCentered.length).toBeLessThanOrEqual(WIKI_SNIPPET_MAX_CHARS)
    expect(spacelessCentered).toContain('TARGET')

    const hugeToken = 'z'.repeat(250)
    const hugeTokenSnippet = extractWikiSnippet(
      { title: '', summary: '', body: `prefix_${hugeToken}_suffix` },
      [hugeToken],
    )
    expect(hugeTokenSnippet.length).toBeLessThanOrEqual(WIKI_SNIPPET_MAX_CHARS)
    expect(hugeTokenSnippet).toContain('z'.repeat(100))
  })
})

describe('/api/wiki REST API integration', () => {
  it('supports POST, GET (list/filter/search), GET detail, PUT (taint clearing), revert, DELETE, mirror, and WS events', async () => {
    const db = openDb(':memory:')
    const dataDir = makeTempDir()
    const hub = createHub()
    const events: Array<{ type: string }> = []
    hub.add({ send: (raw) => events.push(JSON.parse(raw) as { type: string }) })

    let clockMs = Date.UTC(2026, 10, 20, 10, 0, 0)
    const { app } = createApp({
      db,
      llm: okLlm,
      dataDir,
      hub,
      now: () => new Date(clockMs),
    })

    // 1. POST /api/wiki with Chinese title and blank slug auto-allocates deterministic slug
    const postRes = await app.request('/api/wiki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'project',
        slug: '   ',
        title: '极光项目',
        summary: 'Project Aurora 双语门户升级',
        tags: ['极光', 'Aurora'],
        body: '联系人张伟负责极光项目 (Project Aurora) 商务报价与上线里程碑。',
        note: 'Initial creation via UI',
      }),
    })
    expect(postRes.status).toBe(201)
    const postJson = (await postRes.json()) as {
      page: { id: string; kind: string; slug: string; updatedBy: string; sourceTainted: boolean; version: number }
      revisions: Array<{ version: number; note: string; editedBy: string }>
    }
    expect(postJson.page.kind).toBe('project')
    expect(postJson.page.slug).toMatch(/^p-[0-9a-f]{8}$/)
    expect(postJson.page.id).toBe(`project/${postJson.page.slug}`)
    expect(postJson.page.updatedBy).toBe('operator')
    expect(postJson.page.sourceTainted).toBe(false)
    expect(postJson.page.version).toBe(1)
    expect(postJson.revisions).toHaveLength(1)
    expect(postJson.revisions[0]!.note).toBe('Initial creation via UI')
    expect(existsSync(wikiPageFilePath(dataDir, 'project', postJson.page.slug))).toBe(true)
    expect(events).toEqual([{ type: 'wiki_changed' }])

    // POST validation errors -> 400 and no wiki_changed broadcast
    const badKindPost = await app.request('/api/wiki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'secret', title: 'Bad', body: 'x' }),
    })
    expect(badKindPost.status).toBe(400)
    expect(((await badKindPost.json()) as { code: string }).code).toBe('invalid_kind')

    for (const badSlug of ['../evil', 'Acme Corp', 'UPPER', 'bad_slug', 123]) {
      const badSlugPost = await app.request('/api/wiki', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'client', slug: badSlug, title: 'Evil', body: 'x' }),
      })
      expect(badSlugPost.status).toBe(400)
      expect(((await badSlugPost.json()) as { code: string }).code).toBe('invalid_slug')
    }

    const badTagsPost = await app.request('/api/wiki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'client', title: 'Bad Tags', tags: 'not-array', body: 'x' }),
    })
    expect(badTagsPost.status).toBe(400)
    expect(((await badTagsPost.json()) as { code: string }).code).toBe('invalid_wiki')
    expect(events).toHaveLength(1)

    // 2. Seed a bot-written tainted page directly in store, then inspect via GET
    clockMs += 10_000
    upsertWikiPage(
      db,
      {
        kind: 'contact',
        slug: 'zhang-wei',
        title: '张伟',
        summary: 'Acme 商务负责人',
        tags: ['Acme'],
        body: 'Extracted from external email: prefers weekly Aurora status updates.',
        editedBy: 'scout',
        sourceTainted: true,
      },
      { dataDir, now: clockMs },
    )

    const getDetail = await app.request('/api/wiki/contact/zhang-wei')
    expect(getDetail.status).toBe(200)
    const detailJson = (await getDetail.json()) as {
      page: { id: string; sourceTainted: boolean; updatedBy: string; version: number }
      revisions: Array<{ version: number; sourceTainted: boolean }>
    }
    expect(detailJson.page.id).toBe('contact/zhang-wei')
    expect(detailJson.page.sourceTainted).toBe(true)
    expect(detailJson.page.updatedBy).toBe('scout')
    expect(detailJson.revisions).toHaveLength(1)

    // GET detail validation & 404
    expect((await app.request('/api/wiki/bogus/zhang-wei')).status).toBe(400)
    expect((await app.request('/api/wiki/contact/UPPER_BAD')).status).toBe(400)
    expect((await app.request('/api/wiki/contact/non-existent')).status).toBe(404)

    // 3. GET /api/wiki listing, kind filter, invalid kind 400, and multi-query search q
    const listAll = await app.request('/api/wiki')
    expect(listAll.status).toBe(200)
    const listAllJson = (await listAll.json()) as { pages: Array<{ id: string }>; total: number }
    expect(listAllJson.total).toBe(2)
    expect(listAllJson.pages.map((p) => p.id)).toEqual(['contact/zhang-wei', postJson.page.id])

    const listProjects = await app.request('/api/wiki?kind=project')
    expect(listProjects.status).toBe(200)
    const listProjectsJson = (await listProjects.json()) as { pages: Array<{ id: string }>; total: number }
    expect(listProjectsJson.total).toBe(1)
    expect(listProjectsJson.pages[0]!.id).toBe(postJson.page.id)

    const listInvalidKind = await app.request('/api/wiki?kind=invalid')
    expect(listInvalidKind.status).toBe(400)
    expect(((await listInvalidKind.json()) as { code: string }).code).toBe('invalid_kind')

    const searchRes = await app.request(`/api/wiki?q=${encodeURIComponent('极光|Aurora')}`)
    expect(searchRes.status).toBe(200)
    const searchJson = (await searchRes.json()) as { pages: WikiSearchHit[]; total: number }
    expect(searchJson.total).toBe(2)
    expect(searchJson.pages[0]!.id).toBe(postJson.page.id)
    expect(searchJson.pages[0]!.score).toBeGreaterThan(searchJson.pages[1]!.score)
    expect(searchJson.pages[0]!.snippet).toContain('极光')

    // 4. PUT /api/wiki/:kind/:slug updates bot-tainted page and clears sourceTainted -> false
    clockMs += 10_000
    const putVerify = await app.request('/api/wiki/contact/zhang-wei', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '张伟 (Verified)',
        summary: 'Acme 商务负责人 — 已核实',
        tags: ['Acme', 'Verified'],
        body: 'Operator verified: prefers concise Friday updates on Aurora.',
        note: 'Verified details with client',
      }),
    })
    expect(putVerify.status).toBe(200)
    const verifiedJson = (await putVerify.json()) as {
      page: { version: number; sourceTainted: boolean; updatedBy: string; title: string }
      revisions: Array<{ version: number; sourceTainted: boolean; editedBy: string }>
    }
    expect(verifiedJson.page.version).toBe(2)
    expect(verifiedJson.page.sourceTainted).toBe(false)
    expect(verifiedJson.page.updatedBy).toBe('operator')
    expect(verifiedJson.revisions).toHaveLength(2)
    expect(readFileSync(wikiPageFilePath(dataDir, 'contact', 'zhang-wei'), 'utf8')).toContain('source_tainted: false')
    expect(events).toHaveLength(2)

    // PUT on a new slug returns 201
    clockMs += 10_000
    const putCreate = await app.request('/api/wiki/client/acme-corp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Acme Corp',
        body: 'Enterprise retail account.',
      }),
    })
    expect(putCreate.status).toBe(201)
    expect(events).toHaveLength(3)

    // PUT validation error -> 400
    const putTooLong = await app.request('/api/wiki/client/acme-corp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'x'.repeat(MAX_WIKI_TITLE_CHARS + 1),
        body: 'Body',
      }),
    })
    expect(putTooLong.status).toBe(400)
    expect(((await putTooLong.json()) as { code: string }).code).toBe('invalid_wiki')

    // 5. Re-taint contact/zhang-wei via bot write (v3), then POST /revert back to v2
    clockMs += 10_000
    upsertWikiPage(
      db,
      {
        kind: 'contact',
        slug: 'zhang-wei',
        title: '张伟 (Tainted v3)',
        body: 'Untrusted webhook overwrite.',
        editedBy: 'scout',
        sourceTainted: true,
      },
      { dataDir, now: clockMs },
    )

    // Revert validation errors -> 400 & 404
    for (const badVersion of [0, -1, 1.5, '2', null]) {
      const badRev = await app.request('/api/wiki/contact/zhang-wei/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: badVersion }),
      })
      expect(badRev.status).toBe(400)
      expect(((await badRev.json()) as { code: string }).code).toBe('invalid_version')
    }
    const missingRev = await app.request('/api/wiki/contact/zhang-wei/revert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 999 }),
    })
    expect(missingRev.status).toBe(404)

    clockMs += 10_000
    const revertRes = await app.request('/api/wiki/contact/zhang-wei/revert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 2, note: '   ' }),
    })
    expect(revertRes.status).toBe(200)
    const revertJson = (await revertRes.json()) as {
      page: { version: number; title: string; body: string; sourceTainted: boolean; updatedBy: string }
      revisions: Array<{ version: number; note: string; sourceTainted: boolean }>
    }
    expect(revertJson.page.version).toBe(4)
    expect(revertJson.page.title).toBe('张伟 (Verified)')
    expect(revertJson.page.body).toContain('Operator verified')
    expect(revertJson.page.sourceTainted).toBe(false)
    expect(revertJson.page.updatedBy).toBe('operator')
    expect(revertJson.revisions[0]!.note).toBe('Reverted to v2')
    expect(events).toHaveLength(4)

    // 6. DELETE /api/wiki/:kind/:slug archives page, removes mirror, hides from list & search
    const mirrorBeforeDelete = wikiPageFilePath(dataDir, 'contact', 'zhang-wei')
    expect(existsSync(mirrorBeforeDelete)).toBe(true)

    const delRes = await app.request('/api/wiki/contact/zhang-wei', { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    expect(await delRes.json()).toEqual({ ok: true })
    expect(existsSync(mirrorBeforeDelete)).toBe(false)
    expect(events).toHaveLength(5)

    // Second delete returns 404 and does not broadcast
    const delAgain = await app.request('/api/wiki/contact/zhang-wei', { method: 'DELETE' })
    expect(delAgain.status).toBe(404)
    expect(events).toHaveLength(5)

    // Deleted page is hidden from detail, list, and search
    expect((await app.request('/api/wiki/contact/zhang-wei')).status).toBe(404)
    const searchAfterDelete = (await (await app.request('/api/wiki?q=Verified')).json()) as {
      pages: WikiSearchHit[]
      total: number
    }
    expect(searchAfterDelete.pages.find((p) => p.id === 'contact/zhang-wei')).toBeUndefined()

    const listAfterDelete = (await (await app.request('/api/wiki')).json()) as {
      pages: Array<{ id: string }>
      total: number
    }
    expect(listAfterDelete.pages.map((p) => p.id)).not.toContain('contact/zhang-wei')

    db.close()
  })

  it('enforces create-only 409 already_exists on POST /api/wiki, allows re-creating archived slugs, and supports search limit > 20', async () => {
    const db = openDb(':memory:')
    const dataDir = makeTempDir()
    const hub = createHub()
    const events: Array<{ type: string }> = []
    hub.add({ send: (raw) => events.push(JSON.parse(raw) as { type: string }) })

    let clockMs = Date.UTC(2026, 10, 20, 12, 0, 0)
    const { app } = createApp({ db, llm: okLlm, dataDir, hub, now: () => new Date(clockMs) })

    // Create explicit slug -> 201
    const first = await app.request('/api/wiki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'client', slug: 'acme-corp', title: 'Acme Corp', body: 'Initial' }),
    })
    expect(first.status).toBe(201)
    expect(events).toHaveLength(1)

    // Duplicate explicit slug on active page -> 409 already_exists (and no broadcast)
    const dupSlug = await app.request('/api/wiki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'client', slug: 'acme-corp', title: 'Different Title', body: 'Overwrite?' }),
    })
    expect(dupSlug.status).toBe(409)
    expect(((await dupSlug.json()) as { code: string }).code).toBe('already_exists')
    expect(events).toHaveLength(1)

    // Create without slug -> 201; repeating same title without slug -> 409 already_exists
    const cnFirst = await app.request('/api/wiki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'project', title: '极光项目', body: 'Aurora' }),
    })
    expect(cnFirst.status).toBe(201)
    const cnSlug = ((await cnFirst.json()) as { page: { slug: string } }).page.slug

    const cnDup = await app.request('/api/wiki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'project', title: '  极光项目  ', body: 'Duplicate?' }),
    })
    expect(cnDup.status).toBe(409)
    expect(((await cnDup.json()) as { code: string }).code).toBe('already_exists')

    // Archiving allows POST /api/wiki to re-create both explicit slug and omitted-slug title
    expect((await app.request('/api/wiki/client/acme-corp', { method: 'DELETE' })).status).toBe(200)
    expect((await app.request(`/api/wiki/project/${cnSlug}`, { method: 'DELETE' })).status).toBe(200)

    clockMs += 5_000
    const recreateExplicit = await app.request('/api/wiki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'client', slug: 'acme-corp', title: 'Acme Reborn', body: 'Fresh' }),
    })
    expect(recreateExplicit.status).toBe(201)
    const recreateExplicitJson = (await recreateExplicit.json()) as { page: { version: number; title: string } }
    expect(recreateExplicitJson.page.version).toBe(2)
    expect(recreateExplicitJson.page.title).toBe('Acme Reborn')

    const recreateCn = await app.request('/api/wiki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'project', title: '极光项目', body: 'Aurora Reborn' }),
    })
    expect(recreateCn.status).toBe(201)
    expect(((await recreateCn.json()) as { page: { slug: string } }).page.slug).toBe(cnSlug)

    // GET /api/wiki?q=...&limit=25 returns > 20 hits (up to MAX_LIST_LIMIT = 200)
    for (let i = 1; i <= 30; i++) {
      upsertWikiPage(
        db,
        {
          kind: 'topic',
          slug: `bulk-${String(i).padStart(2, '0')}`,
          title: `Bulk Entry ${i}`,
          body: 'sharedbulkterm across thirty pages',
          editedBy: 'operator',
        },
        { now: clockMs + i },
      )
    }
    const wideSearch = await app.request('/api/wiki?q=sharedbulkterm&limit=25')
    expect(wideSearch.status).toBe(200)
    const wideJson = (await wideSearch.json()) as { pages: WikiSearchHit[]; total: number }
    expect(wideJson.pages).toHaveLength(25)
    expect(wideJson.total).toBe(25)

    db.close()
  })

  it('inherits gateway bearer auth and CSRF (Origin + Content-Type) protection on /api/wiki routes when token is configured', async () => {
    const db = openDb(':memory:')
    const { app } = createApp({ db, llm: okLlm, token: 'wiki-secret-token' })

    const unauth = await app.request('/api/wiki')
    expect(unauth.status).toBe(401)

    const authed = await app.request('/api/wiki', {
      headers: { Authorization: 'Bearer wiki-secret-token' },
    })
    expect(authed.status).toBe(200)
    expect(await authed.json()).toEqual({ pages: [], total: 0 })

    // Cross-origin mutation refused -> 403
    const badOriginPost = await app.request('http://127.0.0.1:3000/api/wiki', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wiki-secret-token',
        Origin: 'http://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind: 'client', slug: 'acme', title: 'Acme', body: 'x' }),
    })
    expect(badOriginPost.status).toBe(403)

    const badOriginPut = await app.request('http://127.0.0.1:3000/api/wiki/client/acme', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer wiki-secret-token',
        Origin: 'http://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Acme', body: 'x' }),
    })
    expect(badOriginPut.status).toBe(403)

    const badOriginDelete = await app.request('http://127.0.0.1:3000/api/wiki/client/acme', {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer wiki-secret-token',
        Origin: 'http://evil.example',
      },
    })
    expect(badOriginDelete.status).toBe(403)

    // Non-JSON Content-Type on POST/PUT refused -> 415
    const badContentTypePost = await app.request('http://127.0.0.1:3000/api/wiki', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wiki-secret-token',
        Origin: 'http://127.0.0.1:3000',
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({ kind: 'client', slug: 'acme', title: 'Acme', body: 'x' }),
    })
    expect(badContentTypePost.status).toBe(415)

    const badContentTypePut = await app.request('http://127.0.0.1:3000/api/wiki/client/acme', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer wiki-secret-token',
        Origin: 'http://127.0.0.1:3000',
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({ title: 'Acme', body: 'x' }),
    })
    expect(badContentTypePut.status).toBe(415)

    // Same-origin JSON with valid token succeeds -> 201
    const okPost = await app.request('http://127.0.0.1:3000/api/wiki', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wiki-secret-token',
        Origin: 'http://127.0.0.1:3000',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind: 'client', slug: 'acme', title: 'Acme', body: 'x' }),
    })
    expect(okPost.status).toBe(201)

    db.close()
  })
})
