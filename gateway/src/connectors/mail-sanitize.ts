const NO_REPLY_RE = /(^|[^a-z0-9])(no[-_.]?reply|do[-_.]?not[-_.]?reply)/i
const NOTIFY_LOCAL_RE = /(^|[^a-z0-9])(notifications?|notify|alerts?|bounces?|daemon)([^a-z0-9]|$)|^(mailer[-_.]?daemon|postmaster)$/i
const TRACKING_PARAM_RE = /^(utm_.+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|trk|igshid|yclid|ttclid|_ga|_gl|spm)$/i
const URL_RE = /https?:\/\/[^\s<>()"'\[\]\u3000-\u303f\uff00-\uffef]+/gi
const SECURITY_URL_RE = /\/(reset[-_]?password|password[-_]?reset|magic[-_]?link|verify[-_]?email|confirm[-_]?email|one[-_]?time|sso\/callback)|[?&#](reset_token|magic_token|access_token|id_token|oobcode|otp|login_token|verification_token|token|code)=/i
const AUTH_EN_RE = /\b(verification\s+code|security\s+code|login\s+code|sign[- ]?in\s+code|authentication\s+code|one[- ]time\s+(?:code|passcode|password)|passcode|2fa|two[- ]factor|otp)\b/i
const AUTH_ZH_RE = /(验证码|校验码|动态码|登录码|安全码|动态密码|一次性密码|两步验证|双重验证)/
const OTP_TOKEN_RE = /\b(\d{4,8})\b/g
const STANDALONE_OTP_LINE_RE = /^\s*[\[(【（]?\d{4,8}[\])】）]?\s*$/

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function extractEmail(from: string): string {
  const angle = from.match(/<([^>]+)>/)
  return (angle ? angle[1]! : from).trim().toLowerCase()
}

function hasAuthContext(text: string): boolean {
  return AUTH_EN_RE.test(text) || AUTH_ZH_RE.test(text)
}

function shouldKeepDigits(before: string, after: string): boolean {
  // Never mangle digits inside a normal (non-security) http(s) URL
  if (/https?:\/\/[^\s<>()"'\[\]\u3000-\u303f\uff00-\uffef]*$/i.test(before)) {
    return true
  }
  // Durations in English or Chinese (e.g. "1800 seconds", "1440 mins", "1800秒", "15 分钟")
  if (/^\s*(?:(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b|(?:秒钟?|分钟|小时|个?月|天|周))/i.test(after)) {
    return true
  }
  // Currency amounts and grouped/decimal numbers (e.g. "$2500.00", "¥5000", "12500 元", "$1,200")
  if (/(?:[$€£¥￥]|\b(?:USD|EUR|GBP|CNY|RMB|JPY|CAD|AUD|HKD|SGD)\s*)$/i.test(before)) {
    return true
  }
  if (/\d[.,]$/.test(before) || /^(?:,\d{3}\b|\.\d{1,2}\b)/.test(after)) {
    return true
  }
  if (/^\s*(?:(?:USD|EUR|GBP|CNY|RMB|JPY|dollars?|euros?|pounds?|yuan)\b|元|圆)/i.test(after)) {
    return true
  }
  // Hash-prefixed or explicit invoice / order / ticket numbers (e.g. "Invoice #482910", "订单号：88442211")
  if (/(?:#|\b(?:invoice|order|receipt|ticket|po)\s+#?|(?:发票|订单|账单|单据)(?:号|号码|编号)?\s*[:：#]?)\s*$/i.test(before)) {
    return true
  }
  // ISO dates (e.g. "2026-11-19") and standard phone numbers (e.g. "800-555-0199")
  if (/^-\d{1,2}-\d{1,2}\b/.test(after) || /\b\d{3}[-.]\d{3}[-.]$/.test(before)) {
    return true
  }
  return false
}

function decodeCodePoint(cp: number, fallback: string): string {
  if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return fallback
  }
  return String.fromCodePoint(cp)
}

export function isAutomatedMail(input: {
  from: string
  headers?: Record<string, string | undefined>
  labels?: string[]
}): boolean {
  const addr = extractEmail(input.from)
  const local = addr.split('@')[0] ?? ''
  if (NO_REPLY_RE.test(addr) || NOTIFY_LOCAL_RE.test(local)) return true

  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    const trimmed = (v ?? '').trim()
    if (trimmed) h[k.toLowerCase()] = trimmed
  }
  if (h['list-id'] || h['list-unsubscribe']) return true
  const autoSub = (h['auto-submitted'] ?? '').toLowerCase()
  if (autoSub && autoSub !== 'no' && !autoSub.startsWith('no;')) return true
  const prec = (h['precedence'] ?? '').toLowerCase()
  if (prec === 'bulk' || prec === 'list' || prec === 'junk') return true

  for (const label of input.labels ?? []) {
    const up = label.toUpperCase()
    if (up === 'CATEGORY_PROMOTIONS' || up === 'CATEGORY_UPDATES' || up === 'CATEGORY_FORUMS' || up === 'SPAM') {
      return true
    }
  }
  return false
}

export function stripTrackingLinks(text: string): string {
  return text.replace(URL_RE, (raw) => {
    const trailMatch = raw.match(/[.,;:!?]+$/)
    const trail = trailMatch ? trailMatch[0] : ''
    const clean = trail ? raw.slice(0, -trail.length) : raw
    const hashIdx = clean.indexOf('#')
    const withoutHash = hashIdx === -1 ? clean : clean.slice(0, hashIdx)
    const hashPart = hashIdx === -1 ? undefined : clean.slice(hashIdx + 1)
    const qIdx = withoutHash.indexOf('?')
    if (qIdx === -1) return raw
    const base = withoutHash.slice(0, qIdx)
    const queryPart = withoutHash.slice(qIdx + 1)
    const kept: string[] = []
    for (const seg of queryPart.split('&')) {
      if (!seg) continue
      const eq = seg.indexOf('=')
      const rawKey = eq === -1 ? seg : seg.slice(0, eq)
      const rawVal = eq === -1 ? '' : seg.slice(eq + 1)
      let key = rawKey
      let val = rawVal
      try { key = decodeURIComponent(rawKey) } catch { /* keep raw */ }
      try { val = decodeURIComponent(rawVal) } catch { /* keep raw */ }
      if (TRACKING_PARAM_RE.test(key) || [...val].length > 32) continue
      kept.push(seg)
    }
    const rebuilt = kept.length ? `${base}?${kept.join('&')}` : base
    return `${rebuilt}${hashPart !== undefined ? `#${hashPart}` : ''}${trail}`
  })
}

export function htmlToPlainText(html: string): string {
  const withoutScripts = html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
  const decoded = withoutScripts.replace(
    /&(?:(nbsp|amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-f]+));/gi,
    (full, named?: string, dec?: string, hex?: string) => {
      if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? full
      if (dec) return decodeCodePoint(Number(dec), full)
      if (hex) return decodeCodePoint(Number.parseInt(hex, 16), full)
      return full
    },
  )
  return decoded
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function redactAuthSecrets(text: string, subject = ''): string {
  const linkRedacted = text.replace(URL_RE, (raw) => {
    const trailMatch = raw.match(/[.,;:!?]+$/)
    const trail = trailMatch ? trailMatch[0] : ''
    const clean = trail ? raw.slice(0, -trail.length) : raw
    return SECURITY_URL_RE.test(clean) ? `[redacted-security-link]${trail}` : raw
  })
  const subjectIsAuth = hasAuthContext(subject)
  let prevNonEmptyWasAuth = false
  return linkRedacted
    .split('\n')
    .map((line) => {
      const lineIsAuth = hasAuthContext(line)
      const followUpStandaloneOtp = prevNonEmptyWasAuth && STANDALONE_OTP_LINE_RE.test(line)
      if (!subjectIsAuth && !lineIsAuth && !followUpStandaloneOtp) {
        if (line.trim()) prevNonEmptyWasAuth = false
        return line
      }
      let redactedOnLine = false
      const updated = line.replace(OTP_TOKEN_RE, (match, _digits: string, offset: number, full: string) => {
        const before = full.slice(0, offset)
        const after = full.slice(offset + match.length)
        if (shouldKeepDigits(before, after)) return match
        redactedOnLine = true
        return '[redacted-otp]'
      })
      if (line.trim()) {
        prevNonEmptyWasAuth = lineIsAuth && !redactedOnLine
      }
      return updated
    })
    .join('\n')
}

export function sanitizeMailBody(raw: {
  text?: string
  html?: string
  subject?: string
  maxChars?: number
}): string {
  const max = raw.maxChars ?? 12_000
  const base = raw.text?.trim()
    ? raw.text.replace(/\r\n?/g, '\n').trim()
    : raw.html
      ? htmlToPlainText(raw.html)
      : ''
  const cleaned = stripTrackingLinks(redactAuthSecrets(base, raw.subject ?? ''))
  return cleaned.length > max ? `${cleaned.slice(0, max)}\n…(truncated)` : cleaned
}
