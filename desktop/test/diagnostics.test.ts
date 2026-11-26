import { describe, expect, it } from 'vitest'
import { diagnosticsText, redact } from '../src/diagnostics.js'

describe('desktop unified secret redactor', () => {
  it('preserves existing desktop redaction formatting while covering all token, header, URL, CLI, JSON, and PEM families', () => {
    // Backward-compatible assertions matching shell.test.ts
    expect(redact('sign in → http://localhost:4747/auth?token=QUjeMVcy57TpC5D4Zwl7gh')).toBe(
      'sign in → http://localhost:4747/auth?token=<hidden>',
    )
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer <hidden>')
    expect(redact('key sk-live-abcdef123456 rejected')).toBe('key sk-live…<hidden> rejected')
    expect(redact('key xai-abcdefghijklmnop')).toBe('key xai-abcd…<hidden>')
    expect(redact('https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz123456')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?key=<hidden>',
    )
    expect(redact('groq key gsk_abcdefghijklmnopqrstuvwx failed')).toBe('groq key gsk_abcd…<hidden> failed')

    // Expanded token families (prefixes joined at runtime so static git secret scanners never false-positive)
    const p = (head: string, sep: string, tail: string) => `${head}${sep}${tail}`
    const cases: Array<[string, string]> = [
      [p('sk-ant', '-', 'api03-secretAnt12345678'), 'secretAnt12345678'],
      [p('sk-proj', '-', 'secretProj12345678'), 'secretProj12345678'],
      [p('sk-svcacct', '-', 'secretSvc12345678'), 'secretSvc12345678'],
      [`${p('cmp', '_', 'composioSecret1234')} and ${p('ak', '_', 'composioAkSecret1234')}`, 'composioSecret1234'],
      [`${p('ghp', '_', '1234567890abcdef1234')} and ${p('github_pat', '_', '11ABCDEFG0123456789abcdef')}`, '1234567890abcdef1234'],
      [p('glpat', '-', 'gitlabSecretToken123'), 'gitlabSecretToken123'],
      [p('xoxb', '-', '1234567890-slackSecret'), '1234567890-slackSecret'],
      [p('AKIA', '', 'IOSFODNN7EXAMPLE'), 'IOSFODNN7EXAMPLE'],
      [`${p('hf', '_', 'huggingfaceSecret12345')} and ${p('r8', '_', 'replicateSecret12345')} and ${p('pplx', '-', 'perplexitySecret12345')}`, 'huggingfaceSecret12345'],
      [`${p('sk_live', '_', 'stripeSecret123456')} and ${p('rk_test', '_', 'stripeRestricted123456')}`, 'stripeSecret123456'],
      ['X-API-Key: raw_header_key_999', 'raw_header_key_999'],
      ['Cookie: osb_session=raw_cookie_secret', 'raw_cookie_secret'],
      ['https://api.example.com/hook?webhook_key=wh_secret_1&access_token=at_secret_2', 'wh_secret_1'],
      ['node server.js --api-key cli_secret_key --password cli_secret_pw', 'cli_secret_key'],
      ['{"apiKey":"json_secret_key","totpSecret":"JBSWY3DPEHPK3PXP"}', 'json_secret_key'],
      ['https://user:basicUrlPass99@internal.example.com/api', 'basicUrlPass99'],
      ['Authorization: Token custom_tok_secret_12345', 'custom_tok_secret_12345'],
      ['Authorization: lin_api_noSchemeSecret12345', 'lin_api_noSchemeSecret12345'],
      ['OPENSUPERBOT_TOKEN=osb_desktop_tok_123 OPENAI_API_KEY="sk_desktop_env_456" AWS_SECRET_ACCESS_KEY=awsSecretKeyValue789', 'osb_desktop_tok_123'],
      ['{"webhook_secret":"whsec_desk_1","auth_token":"atok_desk_2","private_key":"pkey_desk_3","signing_secret":"ssec_desk_4"}', 'whsec_desk_1'],
      ["{ apiKey: 'single_quote_ak_123', password: 'single_quote_pw_456' }", 'single_quote_ak_123'],
      [p('https://hooks.slack.com/services', '/', 'T111AAA/B222BBB/slackHookSecret999'), 'slackHookSecret999'],
      [p('https://discord.com/api/webhooks', '/', '1234567890/discordHookSecret888'), 'discordHookSecret888'],
    ]
    for (const [raw, forbidden] of cases) {
      const out = redact(raw)
      expect(out).not.toContain(forbidden)
      expect(out).toContain('<hidden>')
    }

    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    expect(redact(`jwt=${jwt}`)).toBe('jwt=<hidden-jwt>')

    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----'
    expect(redact(pem)).toBe('<hidden-private-key>')
  })

  it('redacts OS home usernames (including Windows forward-slash paths) in diagnosticsText and when redactHomePath is true', () => {
    expect(redact('/Users/alice/Library/Logs/gateway.log')).toBe('/Users/alice/Library/Logs/gateway.log')
    expect(redact('/Users/alice/Library/Logs/gateway.log', { redactHomePath: true })).toBe('~/Library/Logs/gateway.log')
    expect(redact('/home/bob/.local/share/OpenSuperBot', { redactHomePath: true })).toBe('~/.local/share/OpenSuperBot')
    expect(redact('C:\\Users\\Carol\\AppData\\Local\\OpenSuperBot', { redactHomePath: true })).toBe('~\\AppData\\Local\\OpenSuperBot')
    expect(redact('C:/Users/Eve/AppData/Local/OpenSuperBot', { redactHomePath: true })).toBe('~/AppData/Local/OpenSuperBot')

    const diag = diagnosticsText({
      appVersion: '0.8.0',
      electron: '44.9.3',
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '25.5.0',
      dataDir: '/Users/alice/Library/Application Support/OpenSuperBot/data',
      logFile: '/Users/alice/Library/Application Support/OpenSuperBot/logs/gateway.log',
      port: 4747,
      reason: 'crashed',
      detail: 'Bearer super_secret_token_999',
      tail: ['Error at /Users/alice/app.js with ghp_1234567890abcdef1234'],
    })
    expect(diag).not.toContain('alice')
    expect(diag).not.toContain('super_secret_token_999')
    expect(diag).not.toContain('1234567890abcdef1234')
    expect(diag).toContain('~/Library/Application Support/OpenSuperBot/data')
  })
})
