import { describe, expect, it } from 'vitest'
import {
  htmlToPlainText,
  isAutomatedMail,
  redactAuthSecrets,
  sanitizeMailBody,
  stripTrackingLinks,
} from '../src/connectors/mail-sanitize.js'

describe('mail-sanitize', () => {
  it('flags automated and bulk senders while admitting real human correspondence', () => {
    expect(isAutomatedMail({ from: 'GitHub <noreply@github.com>' })).toBe(true)
    expect(isAutomatedMail({ from: 'Support <do-not-reply@acme.com>' })).toBe(true)
    expect(isAutomatedMail({ from: 'Alerts <notifications@service.io>' })).toBe(true)
    expect(isAutomatedMail({ from: 'Mailer <MAILER-DAEMON@mx.acme.com>' })).toBe(true)
    expect(isAutomatedMail({ from: 'postmaster@acme.com' })).toBe(true)
    expect(isAutomatedMail({
      from: 'Newsletter <news@acme.com>',
      headers: { 'list-unsubscribe': '<mailto:u@acme.com>' },
    })).toBe(true)
    expect(isAutomatedMail({
      from: 'System <ops@acme.com>',
      headers: { 'auto-submitted': 'auto-generated' },
    })).toBe(true)
    expect(isAutomatedMail({
      from: 'Alice Chen <alice@acme.com>',
      headers: { 'auto-submitted': 'no' },
    })).toBe(false)
  })

  it('handles uppercase and mixed-case headers and provider category labels', () => {
    expect(isAutomatedMail({
      from: 'Digest <team@acme.com>',
      headers: { 'List-Unsubscribe': '<https://acme.com/unsub>' },
    })).toBe(true)
    expect(isAutomatedMail({
      from: 'Forum <eng@acme.com>',
      headers: { 'LIST-ID': '<eng.lists.acme.com>' },
    })).toBe(true)
    expect(isAutomatedMail({
      from: 'Bot <ops@acme.com>',
      headers: { 'Auto-Submitted': 'Auto-Replied' },
    })).toBe(true)
    expect(isAutomatedMail({
      from: 'Campaign <hello@acme.com>',
      headers: { Precedence: 'Bulk' },
    })).toBe(true)
    expect(isAutomatedMail({
      from: 'Alice <alice@acme.com>',
      headers: { 'Auto-Submitted': 'NO', 'List-Id': undefined },
    })).toBe(false)
    expect(isAutomatedMail({
      from: 'Store <hello@shop.com>',
      labels: ['INBOX', 'category_promotions'],
    })).toBe(true)
    expect(isAutomatedMail({
      from: 'Alerting Team <alerting@acme.com>',
      labels: ['INBOX', 'IMPORTANT'],
    })).toBe(false)
  })

  it('strips click-tracking query params and long opaque tokens while keeping meaningful params and trailing punctuation', () => {
    const dirty = 'See https://acme.com/docs?id=42&utm_source=mail&fbclid=IwAR123456&tok=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8#top.'
    expect(stripTrackingLinks(dirty)).toBe('See https://acme.com/docs?id=42#top.')

    expect(stripTrackingLinks(
      'Links: (https://acme.com/a?utm_medium=email&gclid=xyz123), https://acme.com/b?page=2&mc_eid=999!; 请看 https://acme.com/c?spm=a21bo.1000&id=7。',
    )).toBe(
      'Links: (https://acme.com/a), https://acme.com/b?page=2!; 请看 https://acme.com/c?id=7。',
    )

    // Fragment with '?' but no actual query string stays intact
    expect(stripTrackingLinks('App: https://acme.com/app#/route?tab=1.')).toBe('App: https://acme.com/app#/route?tab=1.')
  })

  it('converts HTML email bodies cleanly without script/style noise and decodes decimal and hex entities safely', () => {
    const html = '<style>.x{color:red}</style><p>Hello <b>Bob</b>,</p><br><div>Line 2 &amp; more</div><script>alert(1)</script>'
    expect(htmlToPlainText(html)).toBe('Hello Bob,\n\nLine 2 & more')

    const entitiesHtml = [
      '<head><title>Hidden Head Title</title></head>',
      '<!-- hidden comment -->',
      '<p>It&#x27;s &quot;great&quot; &#X2014; &#169; 2026 &apos;ok&apos; &#x1F4E7;</p>',
      '<ul><li>Escaped: &amp;lt;tag&amp;gt;</li><li>Bad: &#999999999; &#x110000;</li></ul>',
    ].join('')
    expect(htmlToPlainText(entitiesHtml)).toBe(
      'It\'s "great" — © 2026 \'ok\' 📧\n\n- Escaped: &lt;tag&gt;\n\n- Bad: &#999999999; &#x110000;',
    )
  })

  it('redacts OTP codes in English and Chinese verification emails and password-reset / magic links everywhere', () => {
    const resetBody = 'Click https://app.example.com/auth/reset-password?token=secret999 to reset, or https://app.example.com/pricing.'
    expect(redactAuthSecrets(resetBody, 'Account help')).toBe(
      'Click [redacted-security-link] to reset, or https://app.example.com/pricing.',
    )

    const otpBody = 'Your verification code is 482910. It expires in 10 minutes.'
    expect(redactAuthSecrets(otpBody, 'Your login verification code')).toBe(
      'Your verification code is [redacted-otp]. It expires in 10 minutes.',
    )

    // Chinese OTP contexts (both inline without spaces and subject-driven) + Chinese trailing punctuation on security URLs
    const zhBody = '【Acme】您的验证码是482910，请在1800秒内使用。或点击 https://acme.com/verify-email?code=abcd1234，勿泄露。'
    expect(redactAuthSecrets(zhBody, '安全通知')).toBe(
      '【Acme】您的验证码是[redacted-otp]，请在1800秒内使用。或点击 [redacted-security-link]，勿泄露。',
    )

    const zhSubjectDriven = '请使用以下数字完成登录：\n839201\n有效期 15 分钟。'
    expect(redactAuthSecrets(zhSubjectDriven, 'Acme 登录码')).toBe(
      '请使用以下数字完成登录：\n[redacted-otp]\n有效期 15 分钟。',
    )

    // Standalone OTP on line immediately following an auth prompt even with generic subject
    const multilineOtp = 'Use your one-time passcode below:\n\n604928\n\nExpires in 300 seconds.'
    expect(redactAuthSecrets(multilineOtp, 'Acme Notification')).toBe(
      'Use your one-time passcode below:\n\n[redacted-otp]\n\nExpires in 300 seconds.',
    )
  })

  it('does not false-positive on invoice numbers, currency amounts, dates, or durations even in auth emails', () => {
    // Normal invoice numbers in ordinary business mail stay intact
    const normal = 'Invoice #482910 for $1,200 is due Friday.'
    expect(redactAuthSecrets(normal, 'Q4 Invoice')).toBe(normal)

    const normalZh = '11月账单：订单号 48291012，应付金额 12500 元。'
    expect(redactAuthSecrets(normalZh, '11月对账单')).toBe(normalZh)

    // Auth email containing payment amounts, invoice ref, ISO date, normal help URL with numeric ID, phone number, and 4-digit duration in seconds
    const payment2fa = [
      'Date: 2026-11-19',
      'Use verification code 482910 to authorize $2500.00 ($1500 fee-free) for Invoice #918273.',
      'Code expires in 1800 seconds. Help: https://support.acme.com/articles/123456 or call 800-555-0199.',
    ].join('\n')
    expect(redactAuthSecrets(payment2fa, 'Your verification code')).toBe([
      'Date: 2026-11-19',
      'Use verification code [redacted-otp] to authorize $2500.00 ($1500 fee-free) for Invoice #918273.',
      'Code expires in 1800 seconds. Help: https://support.acme.com/articles/123456 or call 800-555-0199.',
    ].join('\n'))

    const payment2faZh = '您正在为订单号：88442211 支付 ¥5000（5000元），动态码 736291，1800秒内有效。'
    expect(redactAuthSecrets(payment2faZh, '支付校验码')).toBe(
      '您正在为订单号：88442211 支付 ¥5000（5000元），动态码 [redacted-otp]，1800秒内有效。',
    )
  })

  it('runs the full sanitizeMailBody pipeline, redacts long-token auth links, and bounds length', () => {
    const out = sanitizeMailBody({
      subject: 'Sign in link',
      html: '<p>Sign in: https://acme.com/magic-link?code=xyz&utm_medium=email</p>',
      maxChars: 200,
    })
    expect(out).toBe('Sign in: [redacted-security-link]')

    // Long (>32 char) ?token= on a generic path still redacts as a security link rather than stripping ?token=
    const longTokenOut = sanitizeMailBody({
      subject: 'Verify login',
      text: 'Open https://acme.com/session?token=0123456789abcdef0123456789abcdef01234567 and read https://acme.com/help?id=9&utm_campaign=welcome',
    })
    expect(longTokenOut).toBe('Open [redacted-security-link] and read https://acme.com/help?id=9')

    // Truncation and empty fallback
    expect(sanitizeMailBody({ text: '   ', html: '<p>abcdefghij</p>', maxChars: 5 })).toBe('abcde\n…(truncated)')
    expect(sanitizeMailBody({})).toBe('')
  })

  it('completes in <50ms without quadratic backtracking on adversarial whitespace and oversized payloads', () => {
    const adversarial = 'Verification code: invoice ' + ' '.repeat(50_000) + 'x 1234'
    const t0 = performance.now()
    const out = sanitizeMailBody({
      subject: 'Your verification code',
      text: adversarial,
      maxChars: 60_000,
    })
    const elapsed = performance.now() - t0

    expect(elapsed).toBeLessThan(50)
    expect(out.endsWith('x [redacted-otp]')).toBe(true)

    // Oversized raw HTML / text is bounded before regex and entity passes
    const hugeStart = performance.now()
    const hugeOut = sanitizeMailBody({
      subject: 'Security code',
      html: `<p>${'a'.repeat(500_000)} verification code 918273</p>`,
      maxChars: 1_000,
    })
    expect(performance.now() - hugeStart).toBeLessThan(50)
    expect(hugeOut.endsWith('\n…(truncated)')).toBe(true)
  })
})
