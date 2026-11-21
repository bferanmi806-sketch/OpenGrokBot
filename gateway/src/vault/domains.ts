const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** 常见的二级公共后缀，防止把 *.co.uk / *.com.cn 当成单一组织域名通配 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'com.tw', 'com.sg', 'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'co.nz', 'co.in', 'com.br', 'com.mx',
])

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/
const PORT_RE = /^\d{1,5}$/

export const MAX_ALLOWED_DOMAINS = 20

function isValidPort(raw: string): boolean {
  if (!PORT_RE.test(raw)) return false
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

function isValidIpv4(host: string): boolean {
  if (!IPV4_RE.test(host)) return false
  return host.split('.').every((part) => {
    const n = Number(part)
    return n >= 0 && n <= 255
  })
}

function normalizeHostnameViaUrl(host: string): string | null {
  try {
    const u = new URL(`https://${host}/`)
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null
    return u.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

/**
 * 规范化并校验单条域名白名单规则。
 * 允许：
 * - 精确主机名：`app.zendesk.com`、`example.com`、`localhost`、`127.0.0.1`
 * - 带端口主机：`localhost:3000`、`127.0.0.1:8080`、`internal.example.com:8443`
 * - 子域通配：`*.zendesk.com`（至少两个后缀段且不能是常见二级公共后缀）
 * 拒绝：协议/路径/用户信息、`*`、`*.com`、`*.co.uk`、`*.*.example.com`、通配 IP。
 */
export function normalizeDomainPattern(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || trimmed.length > 253) return null
  if (/[\s/?#@\\]/.test(trimmed) || trimmed.includes('://')) return null

  let wildcard = false
  let rest = trimmed
  if (rest.startsWith('*.')) {
    wildcard = true
    rest = rest.slice(2)
  }
  if (!rest || rest.includes('*')) return null

  // 拆分可选端口（兼容 [::1]:3000）
  let hostPart = rest
  let portPart = ''
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end === -1) return null
    hostPart = rest.slice(0, end + 1)
    const after = rest.slice(end + 1)
    if (after) {
      if (!after.startsWith(':')) return null
      portPart = after.slice(1)
      if (!isValidPort(portPart)) return null
    }
  } else {
    const colon = rest.indexOf(':')
    if (colon !== -1) {
      if (rest.indexOf(':', colon + 1) !== -1) return null
      hostPart = rest.slice(0, colon)
      portPart = rest.slice(colon + 1)
      if (!isValidPort(portPart)) return null
    }
  }

  hostPart = hostPart.replace(/\.$/, '')
  if (!hostPart) return null

  if (wildcard) {
    if (portPart) return null
    if (isLoopbackHost(hostPart) || isValidIpv4(hostPart) || hostPart.startsWith('[')) return null
    const asciiHost = normalizeHostnameViaUrl(hostPart)
    if (!asciiHost) return null
    const labels = asciiHost.split('.')
    if (labels.length < 2) return null
    if (labels.some((l) => !LABEL_RE.test(l))) return null
    if (labels.length === 2 && MULTI_LABEL_PUBLIC_SUFFIXES.has(asciiHost)) return null
    return `*.${asciiHost}`
  }

  if (isLoopbackHost(hostPart)) {
    return portPart ? `${hostPart}:${portPart}` : hostPart
  }

  if (IPV4_RE.test(hostPart)) {
    if (!isValidIpv4(hostPart)) return null
    return portPart ? `${hostPart}:${portPart}` : hostPart
  }

  const asciiHost = normalizeHostnameViaUrl(hostPart)
  if (!asciiHost) return null
  const labels = asciiHost.split('.')
  if (labels.length < 2) return null
  if (labels.some((l) => !LABEL_RE.test(l))) return null
  return portPart ? `${asciiHost}:${portPart}` : asciiHost
}

export function normalizeDomainList(raw: readonly string[]): { domains: string[]; invalid: string[] } {
  const seen = new Set<string>()
  const domains: string[] = []
  const invalid: string[] = []
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const normalized = normalizeDomainPattern(trimmed)
    if (!normalized) {
      invalid.push(trimmed)
      continue
    }
    if (!seen.has(normalized)) {
      seen.add(normalized)
      domains.push(normalized)
    }
  }
  return { domains, invalid }
}

function splitPatternHostPort(pattern: string): { wildcard: boolean; host: string; port: string } {
  if (pattern.startsWith('*.')) {
    return { wildcard: true, host: pattern.slice(2), port: '' }
  }
  if (pattern.startsWith('[')) {
    const end = pattern.indexOf(']')
    const host = pattern.slice(0, end + 1)
    const rest = pattern.slice(end + 1)
    return { wildcard: false, host, port: rest.startsWith(':') ? rest.slice(1) : '' }
  }
  const colon = pattern.indexOf(':')
  if (colon === -1) return { wildcard: false, host: pattern, port: '' }
  return { wildcard: false, host: pattern.slice(0, colon), port: pattern.slice(colon + 1) }
}

export type DomainMatchResult =
  | { ok: true; origin: string; host: string; matchedPattern: string }
  | { ok: false; reason: string }

/**
 * 校验当前浏览器页面 URL 是否命中允许注入的域名白名单。
 * 强制 HTTPS（仅允许对显式列出的 loopback 地址使用 HTTP）。
 */
export function matchAllowedDomain(pageUrl: string, allowedDomains: readonly string[]): DomainMatchResult {
  if (!allowedDomains.length) {
    return { ok: false, reason: 'This vault item has no allowed domains configured.' }
  }
  let parsed: URL
  try {
    parsed = new URL(pageUrl)
  } catch {
    return { ok: false, reason: 'Current page does not have a valid web URL.' }
  }

  const proto = parsed.protocol.toLowerCase()
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const loopback = isLoopbackHost(hostname)

  if (proto !== 'https:' && !(proto === 'http:' && loopback)) {
    return {
      ok: false,
      reason: `Refused to fill secret on "${proto}" page — HTTPS is required (HTTP is only allowed for localhost/127.0.0.1).`,
    }
  }

  const actualPort = parsed.port // 标准端口(https 443 / http 80)在 URL 中为空字符串
  const normalizedOrigin = `${proto}//${hostname}${actualPort ? `:${actualPort}` : ''}`

  for (const rawPattern of allowedDomains) {
    const pattern = normalizeDomainPattern(rawPattern)
    if (!pattern) continue
    const { wildcard, host, port } = splitPatternHostPort(pattern)

    if (wildcard) {
      if (actualPort) continue
      if (hostname.endsWith(`.${host}`) && hostname.length > host.length + 1) {
        return { ok: true, origin: normalizedOrigin, host: hostname, matchedPattern: pattern }
      }
      continue
    }

    if (hostname !== host) continue
    if (port) {
      const effectivePort = actualPort || (proto === 'https:' ? '443' : '80')
      if (effectivePort === port) {
        return { ok: true, origin: normalizedOrigin, host: `${hostname}:${effectivePort}`, matchedPattern: pattern }
      }
      continue
    }
    // 未指定端口：非 loopback 仅允许默认端口；loopback 放行任意端口以便本地测试服务使用
    if (!actualPort || loopback) {
      return { ok: true, origin: normalizedOrigin, host: parsed.host.toLowerCase(), matchedPattern: pattern }
    }
  }

  return {
    ok: false,
    reason: `Page origin "${normalizedOrigin}" is not in allowed domains (${allowedDomains.join(', ')}).`,
  }
}
