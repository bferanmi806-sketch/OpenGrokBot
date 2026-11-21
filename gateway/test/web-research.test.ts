import { describe, expect, it } from 'vitest'
import {
  assertPublicUrl,
  extractHtmlReadable,
  isPublicIp,
  parseRssOrAtom,
  runWebFetch,
  runWebSearch,
  type FetchLike,
  type LookupLike,
} from '../src/web-research.js'

const publicLookup: LookupLike = async () => [{ address: '93.184.216.34', family: 4 }]

describe('web-research SSRF guards, parsers, and search/fetch tools', () => {
  it('blocks private, loopback, link-local, metadata, and IPv4-mapped IPv6 addresses', async () => {
    expect(isPublicIp('93.184.216.34')).toBe(true)
    expect(isPublicIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(true)

    for (const bad of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.0.1',
    ]) {
      expect(isPublicIp(bad), `expected ${bad} to be blocked`).toBe(false)
    }

    await expect(assertPublicUrl('file:///etc/passwd', publicLookup)).rejects.toThrow(/scheme/i)
    await expect(assertPublicUrl('javascript:alert(1)', publicLookup)).rejects.toThrow(/scheme/i)
    await expect(assertPublicUrl('http://localhost:3000/api', publicLookup)).rejects.toThrow(/private|local/i)
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/', publicLookup)).rejects.toThrow(/non-public/i)
    await expect(assertPublicUrl('https://user:pass@example.com/', publicLookup)).rejects.toThrow(/credentials/i)
    await expect(
      assertPublicUrl('https://evil.test/', async () => [{ address: '127.0.0.1', family: 4 }]),
    ).rejects.toThrow(/non-public/i)
  })

  it('parses Bing News RSS (unwrapping apiclick redirects) and Atom feeds cleanly', () => {
    const rss = `<?xml version="1.0" encoding="utf-8"?>
    <rss version="2.0" xmlns:News="http://www.bing.com/news">
      <channel>
        <item>
          <title><![CDATA[DeepSeek &amp; Gemini Launch Update]]></title>
          <link>https://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3A%2F%2Fexample.com%2Fai-launch</link>
          <description><![CDATA[<p>New reasoning benchmarks published today.</p>]]></description>
          <pubDate>Fri, 21 Nov 2026 08:00:00 GMT</pubDate>
          <News:Source>TechWire</News:Source>
        </item>
      </channel>
    </rss>`
    const hits = parseRssOrAtom(rss)
    expect(hits).toEqual([
      {
        title: 'DeepSeek & Gemini Launch Update',
        url: 'https://example.com/ai-launch',
        snippet: 'New reasoning benchmarks published today.',
        source: 'TechWire',
        publishedAt: '2026-11-21',
      },
    ])

    const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Open Agent Release</title>
        <link href="https://blog.example.org/open-agent" />
        <summary>Release notes for v2.</summary>
        <updated>2026-11-20T12:00:00Z</updated>
      </entry>
    </feed>`
    expect(parseRssOrAtom(atom)).toEqual([
      {
        title: 'Open Agent Release',
        url: 'https://blog.example.org/open-agent',
        snippet: 'Release notes for v2.',
        source: 'blog.example.org',
        publishedAt: '2026-11-20',
      },
    ])
  })

  it('runs multi-provider web_search with deduplication and clean formatting', async () => {
    const fakeFetch: FetchLike = async (url) => {
      if (url.includes('bing.com/news')) {
        return new Response(
          `<rss><channel>
            <item>
              <title>AI Agent SDK 2.0 Released</title>
              <link>https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fnews.example.com%2Fsdk-2</link>
              <description>Major update for autonomous agents.</description>
              <pubDate>2026-11-21T09:00:00Z</pubDate>
            </item>
          </channel></rss>`,
          { headers: { 'content-type': 'application/rss+xml' } },
        )
      }
      if (url.includes('news.google.com')) {
        return new Response(
          `<rss><channel>
            <item>
              <title>AI Agent SDK 2.0 Released</title>
              <link>https://news.example.com/sdk-2</link>
              <description>Duplicate URL should dedupe.</description>
            </item>
            <item>
              <title>Open Source LLM Efficiency Breakthrough</title>
              <link>https://research.example.com/llm-eff</link>
              <description>3x faster inference on consumer GPUs.</description>
            </item>
          </channel></rss>`,
          { headers: { 'content-type': 'application/rss+xml' } },
        )
      }
      if (url.includes('hn.algolia.com')) {
        return new Response(
          JSON.stringify({
            hits: [{ title: 'Show HN: Local AI Teammates', url: 'https://github.com/wolfqing/OpenSuperBot', created_at: '2026-11-21T07:00:00Z' }],
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('', { status: 404 })
    }

    const res = await runWebSearch({ query: 'AI Agent', limit: 5 }, { fetch: fakeFetch, lookup: publicLookup })
    expect(res.ok).toBe(true)
    expect(res.hits).toHaveLength(3)
    expect(res.hits.map((h) => h.url)).toEqual([
      'https://news.example.com/sdk-2',
      'https://research.example.com/llm-eff',
      'https://github.com/wolfqing/OpenSuperBot',
    ])
    expect(res.text).toContain('AI Agent SDK 2.0 Released')
    expect(res.text).toContain('untrusted external data')
  })

  it('extracts readable HTML and refuses redirects to private/loopback addresses in web_fetch', async () => {
    const parsed = extractHtmlReadable(
      `<html><head><title>Pricing Update</title><style>body{color:red}</style></head>
      <body><script>evil()</script><h1>New Tiers</h1><p>Starter is $10/mo.</p><a href="/docs/pricing">Full pricing guide</a></body></html>`,
      'https://acme.example.com/blog',
    )
    expect(parsed.title).toBe('Pricing Update')
    expect(parsed.text).toContain('Starter is $10/mo.')
    expect(parsed.text).not.toContain('evil()')
    expect(parsed.links).toEqual([{ title: 'Full pricing guide', url: 'https://acme.example.com/docs/pricing' }])

    const redirectToLocalhost: FetchLike = async () =>
      new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8080/secret' } })
    const blocked = await runWebFetch(
      { url: 'https://public.example.com/go' },
      { fetch: redirectToLocalhost, lookup: publicLookup },
    )
    expect(blocked.ok).toBe(false)
    expect(blocked.text).toMatch(/non-public/i)
  })
})
