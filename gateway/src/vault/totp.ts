import { createHmac } from 'node:crypto'

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512'

export type ParsedTotpConfig = {
  secret: string
  digits: number
  period: number
  algorithm: TotpAlgorithm
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const BASE32_MAP = new Map<string, number>([...BASE32_ALPHABET].map((ch, idx) => [ch, idx]))

export function decodeBase32(raw: string): Buffer {
  const cleaned = raw.replace(/[\s-]+/g, '').replace(/=+$/g, '').toUpperCase()
  if (!cleaned || cleaned.length < 8) {
    throw new TypeError('TOTP secret must be a valid Base32 string (at least 8 characters).')
  }
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of cleaned) {
    const idx = BASE32_MAP.get(ch)
    if (idx === undefined) {
      throw new TypeError(`Invalid Base32 character "${ch}" in TOTP secret.`)
    }
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }
  if (bytes.length === 0) {
    throw new TypeError('TOTP secret decoded to empty bytes.')
  }
  return Buffer.from(bytes)
}

function normalizeAlgorithm(raw: string | null): TotpAlgorithm {
  if (!raw) return 'sha1'
  const lower = raw.trim().toLowerCase()
  if (lower === 'sha1' || lower === 'sha-1') return 'sha1'
  if (lower === 'sha256' || lower === 'sha-256') return 'sha256'
  if (lower === 'sha512' || lower === 'sha-512') return 'sha512'
  throw new TypeError(`Unsupported TOTP algorithm "${raw}".`)
}

/**
 * 解析纯 Base32 密钥或标准 otpauth://totp/... URI。
 */
export function parseTotpInput(raw: string): ParsedTotpConfig {
  const trimmed = raw.trim()
  if (!trimmed) throw new TypeError('TOTP secret cannot be empty.')

  if (/^otpauth:\/\//i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new TypeError('Invalid otpauth:// URI.')
    }
    if (parsed.hostname.toLowerCase() !== 'totp') {
      throw new TypeError('Only otpauth://totp/ URIs are supported.')
    }
    const secret = (parsed.searchParams.get('secret') ?? '').trim()
    decodeBase32(secret)

    const digitsRaw = parsed.searchParams.get('digits')
    const digits = digitsRaw ? Number(digitsRaw) : 6
    if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
      throw new TypeError('TOTP digits must be 6, 7, or 8.')
    }

    const periodRaw = parsed.searchParams.get('period')
    const period = periodRaw ? Number(periodRaw) : 30
    if (!Number.isInteger(period) || period < 15 || period > 120) {
      throw new TypeError('TOTP period must be between 15 and 120 seconds.')
    }

    const algorithm = normalizeAlgorithm(parsed.searchParams.get('algorithm'))
    return { secret, digits, period, algorithm }
  }

  decodeBase32(trimmed)
  return { secret: trimmed, digits: 6, period: 30, algorithm: 'sha1' }
}

/**
 * 按 RFC 6238 / RFC 4226 实时生成一次性 TOTP 验证码。
 */
export function generateTotp(
  secretOrUri: string,
  nowMs = Date.now(),
): { code: string; remainingSec: number; period: number } {
  const cfg = parseTotpInput(secretOrUri)
  const key = decodeBase32(cfg.secret)
  const epochSec = Math.floor(nowMs / 1000)
  const counter = Math.floor(epochSec / cfg.period)
  const remainingSec = cfg.period - (epochSec % cfg.period)

  const counterBuf = Buffer.alloc(8)
  counterBuf.writeBigUInt64BE(BigInt(counter), 0)

  const digest = createHmac(cfg.algorithm, key).update(counterBuf).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  const mod = 10 ** cfg.digits
  const code = String(binary % mod).padStart(cfg.digits, '0')
  return { code, remainingSec, period: cfg.period }
}
