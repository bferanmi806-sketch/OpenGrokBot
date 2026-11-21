import { describe, expect, it } from 'vitest'
import { matchAllowedDomain, normalizeDomainList, normalizeDomainPattern } from '../src/vault/domains.js'

describe('vault domain allowlist', () => {
  it('normalizes exact hosts, wildcards, and loopback ports', () => {
    expect(normalizeDomainPattern('App.Zendesk.COM.')).toBe('app.zendesk.com')
    expect(normalizeDomainPattern('*.Zendesk.com')).toBe('*.zendesk.com')
    expect(normalizeDomainPattern('localhost:3000')).toBe('localhost:3000')
    expect(normalizeDomainPattern('127.0.0.1:8080')).toBe('127.0.0.1:8080')
    expect(normalizeDomainPattern('localhost')).toBe('localhost')
  })

  it('rejects overly broad wildcards, schemes, paths, and malformed inputs', () => {
    for (const bad of [
      '',
      '*',
      '*.com',
      '*.org',
      '*.co.uk',
      '*.com.cn',
      '*.*.example.com',
      'a*.example.com',
      'https://example.com',
      'example.com/login',
      'user@example.com',
      '*.127.0.0.1',
      '*.localhost',
      '*.example.com:443',
      'example',
      '999.0.0.1',
      'example.com:99999',
    ]) {
      expect(normalizeDomainPattern(bad), `expected reject for "${bad}"`).toBeNull()
    }
  })

  it('deduplicates and separates invalid patterns in list normalization', () => {
    const res = normalizeDomainList(['APP.Example.com', 'app.example.com', '*.com', '*.acme.io'])
    expect(res.domains).toEqual(['app.example.com', '*.acme.io'])
    expect(res.invalid).toEqual(['*.com'])
  })

  it('matches exact HTTPS origins and strict subdomains without sibling bypass', () => {
    expect(matchAllowedDomain('https://app.zendesk.com/login', ['app.zendesk.com'])).toMatchObject({
      ok: true,
      origin: 'https://app.zendesk.com',
    })
    expect(matchAllowedDomain('https://acme.zendesk.com/agent', ['*.zendesk.com'])).toMatchObject({
      ok: true,
      origin: 'https://acme.zendesk.com',
    })
    expect(matchAllowedDomain('https://a.b.zendesk.com/', ['*.zendesk.com'])).toMatchObject({ ok: true })
    // *.zendesk.com does not match bare zendesk.com or evilzendesk.com
    expect(matchAllowedDomain('https://zendesk.com/', ['*.zendesk.com']).ok).toBe(false)
    expect(matchAllowedDomain('https://evilzendesk.com/', ['*.zendesk.com']).ok).toBe(false)
    expect(matchAllowedDomain('https://zendesk.com.evil.io/', ['*.zendesk.com']).ok).toBe(false)
  })

  it('enforces HTTPS for non-loopback hosts and permits HTTP only for listed loopback hosts', () => {
    expect(matchAllowedDomain('http://app.zendesk.com/login', ['app.zendesk.com']).ok).toBe(false)
    expect(matchAllowedDomain('file:///etc/passwd', ['localhost']).ok).toBe(false)
    expect(matchAllowedDomain('http://localhost:3000/login', ['localhost:3000'])).toMatchObject({
      ok: true,
      origin: 'http://localhost:3000',
    })
    expect(matchAllowedDomain('http://localhost:4000/login', ['localhost:3000']).ok).toBe(false)
    expect(matchAllowedDomain('http://127.0.0.1:9999/signin', ['127.0.0.1'])).toMatchObject({
      ok: true,
      origin: 'http://127.0.0.1:9999',
    })
    // non-default port requires explicit port in pattern for non-loopback
    expect(matchAllowedDomain('https://app.zendesk.com:8443/login', ['app.zendesk.com']).ok).toBe(false)
    expect(matchAllowedDomain('https://app.zendesk.com:8443/login', ['app.zendesk.com:8443']).ok).toBe(true)
  })
})
