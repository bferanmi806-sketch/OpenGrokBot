import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { wikiPageFilePath } from '../src/wiki/mirror.js'
import {
  applyWikiSectionPatch,
  MAX_CHANGELOG_LINES,
  MAX_LIST_ITEMS,
  MAX_OVERVIEW_CHARS,
  parseWikiSections,
  scrubWikiSecrets,
} from '../src/wiki/sections.js'
import {
  allocateWikiSlug,
  archiveWikiPage,
  getWikiPage,
  listWikiRevisions,
  patchWikiPage,
  upsertWikiPage,
} from '../src/wiki/store.js'
import { searchWikiRrf } from '../src/wiki/rrf.js'
import { WikiValidationError } from '../src/wiki/types.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osb-wiki-sections-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('scrubWikiSecrets', () => {
  it('redacts common API keys, bearer tokens, and URL secret query params while preserving normal prose', () => {
    const raw = [
      'Anthropic: sk-ant-api03-abcdef1234567890',
      'OpenAI: sk-proj-9876543210abcdef',
      'Legacy sk: sk-1234567890abcdef',
      'xAI: xai-1234567890abcdef',
      'Google: AIzaSyDaGmWKa4JsXZ_123456789',
      'Groq: gsk_abcdef1234567890',
      'Composio: cmp_abcdef1234567890',
      'GitHub classic: ghp_1234567890abcdef123456',
      'GitHub fine-grained: github_pat_11ABCDEF0_1234567890abcdef',
      'Slack bot: xoxb-123456789-987654321-abcdef',
      'Header: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'Bracketed Bearer: [Bearer secret_tok_bracket_999] ([#msg:10])',
      'Webhook: https://hooks.example.com/trigger?token=sec_tok_999&mode=live&key=my_api_key_888',
      'Prose: Adopted OAuth2 Bearer token and Bearer credentials authentication for 200 seats.',
    ].join('\n')

    const scrubbed = scrubWikiSecrets(raw)
    expect(scrubbed).not.toContain('sk-ant-')
    expect(scrubbed).not.toContain('sk-proj-')
    expect(scrubbed).not.toContain('sk-1234567890abcdef')
    expect(scrubbed).not.toContain('xai-1234567890abcdef')
    expect(scrubbed).not.toContain('AIzaSyDaGmWKa4JsXZ')
    expect(scrubbed).not.toContain('gsk_abcdef1234567890')
    expect(scrubbed).not.toContain('cmp_abcdef1234567890')
    expect(scrubbed).not.toContain('ghp_1234567890abcdef')
    expect(scrubbed).not.toContain('github_pat_')
    expect(scrubbed).not.toContain('xoxb-123456789')
    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(scrubbed).not.toContain('secret_tok_bracket_999')
    expect(scrubbed).not.toContain('sec_tok_999')
    expect(scrubbed).not.toContain('my_api_key_888')
    expect(scrubbed).toContain('Bearer [REDACTED]')
    expect(scrubbed).toContain('[Bearer [REDACTED]] ([#msg:10])')
    expect(scrubbed).toContain('?token=[REDACTED]&mode=live&key=[REDACTED]')
    // Preserves normal prose mentioning "Bearer token" and "Bearer credentials"
    expect(scrubbed).toContain('Adopted OAuth2 Bearer token and Bearer credentials authentication for 200 seats.')
    // Idempotent on second pass
    expect(scrubWikiSecrets(scrubbed)).toBe(scrubbed)
  })
})

describe('parseWikiSections & applyWikiSectionPatch', () => {
  const fixedNow = Date.UTC(2026, 10, 25, 15, 30, 0) // 2026-11-25 15:30Z

  it('ignores ## inside fenced code blocks and preserves preamble + custom headings/tables verbatim', () => {
    const existing = [
      'Lead contact profile for **Acme Corp**.',
      '',
      '## Overview',
      'Initial overview ([#msg:101]).',
      '',
      '## Custom Pricing Matrix',
      '| Tier | Seats | Annual |',
      '| --- | --- | --- |',
      '| Enterprise | 200 | $48,000 |',
      '',
      '```markdown',
      '## Fake Heading Inside Code Fence',
      '- [f99] Not a real managed list item',
      '```',
      '',
      '## key facts',
      '- Legacy unkeyed fact one',
      '- [f4] Existing keyed fact four ([#msg:88])',
      '- Legacy unkeyed fact two',
    ].join('\n')

    const parsed = parseWikiSections(existing)
    expect(parsed.preamble).toContain('Lead contact profile for **Acme Corp**.')
    expect(parsed.sections.map((s) => s.heading)).toEqual([
      'Overview',
      'Custom Pricing Matrix',
      'key facts',
    ])

    const patched = applyWikiSectionPatch(
      existing,
      {
        overview: { mode: 'keep' },
        keyFacts: {
          add: [{ text: 'Signed renewal for FY27 ([#msg:202])' }],
        },
        decisions: {
          add: [{ text: 'Approved net-30 billing terms ([#msg:205])' }],
        },
      },
      { actor: 'researcher', at: fixedNow },
    )

    expect(patched.changed).toBe(true)
    // Preamble and custom table + fenced code block preserved verbatim
    expect(patched.body).toContain('Lead contact profile for **Acme Corp**.')
    expect(patched.body).toContain(
      [
        '## Custom Pricing Matrix',
        '| Tier | Seats | Annual |',
        '| --- | --- | --- |',
        '| Enterprise | 200 | $48,000 |',
        '',
        '```markdown',
        '## Fake Heading Inside Code Fence',
        '- [f99] Not a real managed list item',
        '```',
      ].join('\n'),
    )
    // Canonical heading normalized to "## Key Facts" with deterministic legacy IDs avoiding collision with [f4]
    expect(patched.body).toContain('## Key Facts')
    expect(patched.body).toContain('- [f1] Legacy unkeyed fact one')
    expect(patched.body).toContain('- [f4] Existing keyed fact four ([#msg:88])')
    expect(patched.body).toContain('- [f2] Legacy unkeyed fact two')
    expect(patched.body).toContain('- [f5] Signed renewal for FY27 ([#msg:202])')
    expect(patched.body).toContain('## Decisions\n- [d1] Approved net-30 billing terms ([#msg:205])')
    expect(patched.body).toContain('## Change Log\n- 2026-11-25 15:30Z · researcher · ')
  })

  it('enforces overview rewrite length, reason, and #msg citation retention unless justified in droppedCitations', () => {
    const existing = [
      '## Overview',
      'Acme is migrating 200 seats ([#msg:101]) with Monterey hold ([#msg:105]).',
    ].join('\n')

    // Rejects empty content, oversized content, empty reason, oversized reason
    expect(() =>
      applyWikiSectionPatch(
        existing,
        { overview: { mode: 'rewrite', content: '   ', reason: 'cleanup' } },
        { actor: 'researcher', at: fixedNow },
      ),
    ).toThrow(WikiValidationError)

    expect(() =>
      applyWikiSectionPatch(
        existing,
        {
          overview: {
            mode: 'rewrite',
            content: 'x'.repeat(MAX_OVERVIEW_CHARS + 1),
            reason: 'too long',
          },
        },
        { actor: 'researcher', at: fixedNow },
      ),
    ).toThrow(WikiValidationError)

    expect(() =>
      applyWikiSectionPatch(
        existing,
        {
          overview: {
            mode: 'rewrite',
            content: 'Acme is migrating 200 seats ([#msg:101]) ([#msg:105]).',
            reason: '   ',
          },
        },
        { actor: 'researcher', at: fixedNow },
      ),
    ).toThrow(WikiValidationError)

    expect(() =>
      applyWikiSectionPatch(
        existing,
        {
          overview: {
            mode: 'rewrite',
            content: 'Acme is migrating 200 seats ([#msg:101]) ([#msg:105]).',
            reason: 'r'.repeat(201),
          },
        },
        { actor: 'researcher', at: fixedNow },
      ),
    ).toThrow(WikiValidationError)

    // Rejects silent drop of #msg:105 naming the missing citation
    expect(() =>
      applyWikiSectionPatch(
        existing,
        {
          overview: {
            mode: 'rewrite',
            content: 'Acme is migrating 250 seats ([#msg:101]) ([#msg:300]).',
            reason: 'Updated seat count',
          },
        },
        { actor: 'researcher', at: fixedNow },
      ),
    ).toThrow(/#msg:105/)

    // Rejects droppedCitations with blank reason
    expect(() =>
      applyWikiSectionPatch(
        existing,
        {
          overview: {
            mode: 'rewrite',
            content: 'Acme is migrating 250 seats ([#msg:101]).',
            reason: 'Updated seat count',
            droppedCitations: [{ msgId: 105, reason: '   ' }],
          },
        },
        { actor: 'researcher', at: fixedNow },
      ),
    ).toThrow(WikiValidationError)

    // Accepts drop when justified in droppedCitations
    const ok = applyWikiSectionPatch(
      existing,
      {
        overview: {
          mode: 'rewrite',
          content: 'Acme is migrating 250 seats ([#msg:101]) after venue switch ([#msg:300]).',
          reason: 'Monterey hold superseded by Carmel contract',
          droppedCitations: [{ msgId: 105, reason: 'Monterey hold cancelled in #msg:300' }],
        },
      },
      { actor: 'researcher', at: fixedNow },
    )
    expect(ok.body).toContain('Acme is migrating 250 seats ([#msg:101]) after venue switch ([#msg:300]).')
    expect(ok.body).toContain('Monterey hold superseded by Carmel contract')
  })

  it('preserves untouched list entries byte-for-byte during add/update/remove and validates IDs and reasons', () => {
    const untouchedLine = '- [o2] Verify SOC2 Type II report with security@acme.com   ([#msg:77])'
    const existing = [
      '## Open Items',
      '- [o1] Draft SOW v1 ([#msg:70])',
      untouchedLine,
      '- [o3] Temporary placeholder ([#msg:79])',
    ].join('\n')

    // Unknown id on update or remove throws
    expect(() =>
      applyWikiSectionPatch(
        existing,
        { openItems: { update: [{ id: 'o99', text: 'Nope' }] } },
        { actor: 'chief', at: fixedNow },
      ),
    ).toThrow(WikiValidationError)

    expect(() =>
      applyWikiSectionPatch(
        existing,
        { openItems: { remove: [{ id: 'o99', reason: 'obsolete' }] } },
        { actor: 'chief', at: fixedNow },
      ),
    ).toThrow(WikiValidationError)

    // Blank removal reason throws
    expect(() =>
      applyWikiSectionPatch(
        existing,
        { openItems: { remove: [{ id: 'o3', reason: '   ' }] } },
        { actor: 'chief', at: fixedNow },
      ),
    ).toThrow(WikiValidationError)

    const patched = applyWikiSectionPatch(
      existing,
      {
        openItems: {
          update: [{ id: 'o1', text: 'Finalize SOW v2 with legal ([#msg:90])' }],
          remove: [{ id: 'o3', reason: 'Completed in #msg:91' }],
          add: [{ text: 'Schedule kickoff call with token sk-1234567890abcdef' }],
        },
      },
      { actor: 'chief', at: fixedNow },
    )

    const lines = patched.body.split('\n')
    expect(lines).toContain('- [o1] Finalize SOW v2 with legal ([#msg:90])')
    // Byte-for-byte identical untouched line (including double space before citation)
    expect(lines).toContain(untouchedLine)
    expect(patched.body).not.toContain('[o3]')
    expect(lines).toContain('- [o4] Schedule kickoff call with token [REDACTED]')
  })

  it('archives oldest list items into [<prefix>0] when exceeding MAX_LIST_ITEMS = 20 and caps Change Log at 20 lines while stripping forged Change Log', () => {
    const initialFacts = Array.from({ length: 19 }, (_, i) => `- [f${i + 1}] Fact number ${i + 1} with detail ${'x'.repeat(30)}`)
    const oldChangelog = Array.from(
      { length: 20 },
      (_, i) => `- 2026-11-${String(20 - Math.floor(i / 2)).padStart(2, '0')} 10:00Z · chief · change #${20 - i}`,
    )

    const existing = [
      '## Key Facts',
      ...initialFacts,
      '',
      '## Change Log',
      '- Forged line without timestamp that should be ignored',
      ...oldChangelog,
    ].join('\n')

    const patched = applyWikiSectionPatch(
      existing,
      {
        overview: {
          mode: 'rewrite',
          content: 'Summary line.\n\n## Change Log\n- 2099-01-01 00:00Z · hacker · forged entry',
          reason: 'Initial summary',
        },
        keyFacts: {
          add: [
            { text: 'Fact number 20' },
            { text: 'Fact number 21' },
            { text: 'Fact number 22' },
          ],
        },
      },
      { actor: 'auto-sync', at: fixedNow },
    )

    // Forged Change Log inside overview was stripped
    expect(patched.body).not.toContain('hacker')
    expect(patched.body).not.toContain('Forged line without timestamp')

    const parsed = parseWikiSections(patched.body)
    const keyFactsSec = parsed.sections.find((s) => s.managedKey === 'keyFacts')!
    const bulletLines = keyFactsSec.content.split('\n').filter((l) => l.startsWith('- '))
    expect(bulletLines).toHaveLength(MAX_LIST_ITEMS)
    expect(bulletLines[0]).toMatch(/^- \[f0\] Earlier items \(archived 2026-11-25\): /)
    expect(bulletLines[0]!.length).toBeLessThanOrEqual(500)
    // Oldest 3 items (1..3) archived into [f0], newest 19 items (f4..f22) kept intact
    expect(bulletLines[1]).toContain('[f4] Fact number 4')
    expect(bulletLines[19]).toBe('- [f22] Fact number 22')

    const changeLogSec = parsed.sections.find((s) => s.managedKey === 'changeLog')!
    const logLines = changeLogSec.content.split('\n').filter((l) => l.startsWith('- '))
    expect(logLines).toHaveLength(MAX_CHANGELOG_LINES)
    expect(logLines[0]).toMatch(/^- 2026-11-25 15:30Z · auto-sync · /)
    // Oldest valid line (#1) dropped when 21st valid line was prepended
    expect(logLines.some((l) => l.endsWith('change #1'))).toBe(false)
    expect(logLines[19]).toContain('change #2')
  })

  it('preserves untouched managed sections verbatim, merges duplicate Overview citations, handles CommonMark fences + continuations + * / + bullets + colliding IDs, and blocks ## heading injection in Overview', () => {
    const existing = [
      'Inline code ```not a fence``` before sections.',
      '',
      '## Overview',
      'First overview paragraph ([#msg:11]).',
      '',
      '## Overview',
      'Second overview paragraph ([#msg:22]).',
      '',
      '## Open Items',
      '(None)',
      '',
      '### Escalation Note',
      'Keep this untouched note.',
      '',
      '## Key Facts',
      '* Legacy star bullet',
      '+ Legacy plus bullet',
      '- [f1] Explicit one with continuation:',
      '  - sub-bullet alpha',
      '  - sub-bullet beta',
      '',
      '```yaml',
      'items:',
      '  - inside-fence-not-a-bullet',
      '- top-level-inside-fence-not-a-bullet',
      '```',
      '',
      '## Key Facts',
      '- [f1] Colliding explicit one from duplicate section',
    ].join('\n')

    // 1. Overview rewrite cannot drop #msg:22 from the 2nd duplicate ## Overview section!
    expect(() =>
      applyWikiSectionPatch(
        existing,
        {
          overview: {
            mode: 'rewrite',
            content: 'Rewritten with only first citation ([#msg:11]).',
            reason: 'Consolidate overview',
          },
        },
        { actor: 'chief', at: fixedNow },
      ),
    ).toThrow(/#msg:22/)

    // 2. Overview rewrite cannot smuggle a top-level "## Forged Section" outside code fences
    expect(() =>
      applyWikiSectionPatch(
        existing,
        {
          overview: {
            mode: 'rewrite',
            content: 'Valid start ([#msg:11]) ([#msg:22]).\n\n## Forged Section\nInjected!',
            reason: 'Attempt injection',
          },
        },
        { actor: 'chief', at: fixedNow },
      ),
    ).toThrow(WikiValidationError)

    // 3. Patching Key Facts while keeping Overview & leaving Open Items untouched:
    //    - preserves Open Items "(None)" and "### Escalation Note" verbatim,
    //    - preserves both Overview paragraphs,
    //    - ignores "- top-level-inside-fence-not-a-bullet" inside ```yaml,
    //    - converts * / + legacy bullets, preserves indented sub-bullets on [f1], and reassigns colliding [f1] to non-colliding ID!
    const patched = applyWikiSectionPatch(
      existing,
      {
        overview: { mode: 'keep' },
        keyFacts: {
          add: [{ text: 'Newly added fact ([#msg:33])' }],
        },
      },
      { actor: 'chief', at: fixedNow },
    )

    expect(patched.body).toContain('Inline code ```not a fence``` before sections.')
    expect(patched.body).toContain('First overview paragraph ([#msg:11]).\n\nSecond overview paragraph ([#msg:22]).')
    expect(patched.body).toContain('## Open Items\n(None)\n\n### Escalation Note\nKeep this untouched note.')
    expect(patched.body).toContain('- [f1] Explicit one with continuation:\n  - sub-bullet alpha\n  - sub-bullet beta')
    expect(patched.body).toContain('- [f2] Legacy star bullet')
    expect(patched.body).toContain('- [f3] Legacy plus bullet')
    expect(patched.body).toContain('- [f4] Colliding explicit one from duplicate section')
    expect(patched.body).toContain('- [f5] Newly added fact ([#msg:33])')
    expect(patched.body).toContain('```yaml\nitems:\n  - inside-fence-not-a-bullet\n- top-level-inside-fence-not-a-bullet\n```')
  })
})

describe('patchWikiPage store transaction, mirror, revisions, FTS, and taint monotonicity', () => {
  it('creates and patches pages transactionally, mirrors to disk, syncs FTS, scrubs secrets, and enforces monotonic taint', () => {
    const dataDir = makeTempDir()
    const db = openDb(':memory:')
    const t1 = Date.UTC(2026, 10, 25, 12, 0, 0)
    const t2 = Date.UTC(2026, 10, 25, 13, 0, 0)
    const t3 = Date.UTC(2026, 10, 25, 14, 0, 0)

    // 1. Create a new page via patchWikiPage
    const created = patchWikiPage(
      db,
      {
        kind: 'client',
        title: 'Globex Corp',
        summary: 'Enterprise account (key sk-proj-secret12345678)',
        tags: ['enterprise', 'q4'],
        overview: {
          mode: 'rewrite',
          content: 'Globex Corp signed pilot in Q4 ([#msg:12]).',
          reason: 'Initial client page',
        },
        keyFacts: {
          add: [{ text: 'Primary contact is Maya Lin ([#msg:12])' }],
        },
        editedBy: 'researcher',
        sourceTainted: false,
      },
      { dataDir, now: t1 },
    )

    expect(created.created).toBe(true)
    expect(created.page.id).toBe('client/globex-corp')
    expect(created.page.version).toBe(1)
    expect(created.page.sourceTainted).toBe(false)
    expect(created.page.summary).toBe('Enterprise account (key [REDACTED])')
    expect(created.page.body).toContain('## Overview')
    expect(created.page.body).toContain('## Key Facts\n- [f1] Primary contact is Maya Lin ([#msg:12])')
    expect(created.page.body).toContain('## Change Log\n- 2026-11-25 12:00Z · researcher · ')

    // Mirror written & searchable via FTS
    const mirrorPath = wikiPageFilePath(dataDir, 'client', 'globex-corp')
    expect(readFileSync(mirrorPath, 'utf8')).toContain('Maya Lin')
    expect(searchWikiRrf(db, { queries: ['Maya Lin'], now: t1 })).toHaveLength(1)

    // 2. Tainted patch flips sourceTainted to true; subsequent clean bot patch cannot wash taint
    const taintedPatch = patchWikiPage(
      db,
      {
        kind: 'client',
        slug: 'globex-corp',
        openItems: {
          add: [{ text: 'Confirm webhook endpoint ([#msg:20])' }],
        },
        editedBy: 'auto-sync',
        sourceTainted: true,
      },
      { dataDir, now: t2 },
    )
    expect(taintedPatch.created).toBe(false)
    expect(taintedPatch.page.version).toBe(2)
    expect(taintedPatch.page.sourceTainted).toBe(true)

    const cleanBotPatch = patchWikiPage(
      db,
      {
        kind: 'client',
        slug: 'globex-corp',
        decisions: {
          add: [{ text: 'Use dedicated staging tenant ([#msg:25])' }],
        },
        editedBy: 'chief',
        sourceTainted: false,
      },
      { dataDir, now: t3 },
    )
    expect(cleanBotPatch.page.version).toBe(3)
    expect(cleanBotPatch.page.sourceTainted).toBe(true)

    // Revisions recorded with generated change summaries
    const revs = listWikiRevisions(db, 'client/globex-corp')
    expect(revs).toHaveLength(3)
    expect(revs[0]!.version).toBe(3)
    expect(revs[0]!.note).toBeTruthy()

    // Empty / no-op patch on existing page throws WikiValidationError without bumping version
    expect(() =>
      patchWikiPage(
        db,
        {
          kind: 'client',
          slug: 'globex-corp',
          overview: { mode: 'keep' },
          editedBy: 'chief',
        },
        { dataDir, now: t3 + 1000 },
      ),
    ).toThrow(WikiValidationError)
    expect(getWikiPage(db, 'client', 'globex-corp')?.version).toBe(3)

    // Non-operator upsertWikiPage also scrubs raw secrets and strips forged Change Log
    const upserted = upsertWikiPage(
      db,
      {
        kind: 'topic',
        title: 'API Key Leak Test',
        body: 'Token xai-secret9876543210\n\n## Change Log\n- fake log',
        editedBy: 'researcher',
      },
      { dataDir, now: t3 },
    )
    expect(upserted.page.body).toContain('Token [REDACTED]')
    expect(upserted.page.body).not.toContain('xai-secret')
    expect(upserted.page.body).not.toContain('fake log')

    // Rejects secret tokens inside requestedSlug
    expect(() => allocateWikiSlug(db, 'client', 'sk-proj-1234567890abcdef', 'Clean Title')).toThrow(
      WikiValidationError,
    )
    archiveWikiPage(db, 'topic', upserted.page.slug, { dataDir, now: t3 })

    db.close()
  })
})
