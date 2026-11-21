import { describe, expect, it } from 'vitest'
import { generateTotp, parseTotpInput } from '../src/vault/totp.js'

// RFC 6238 Appendix B test secret for SHA1: ASCII "12345678901234567890" -> Base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
const RFC_SHA1_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('vault TOTP generator', () => {
  it('matches RFC 6238 SHA1 vectors (8-digit URI & 6-digit default)', () => {
    const uri = `otpauth://totp/Acme:alice?secret=${RFC_SHA1_B32}&digits=8&period=30&algorithm=SHA1`
    expect(generateTotp(uri, 59_000).code).toBe('94287082')
    expect(generateTotp(uri, 1_111_111_109_000).code).toBe('07081804')
    expect(generateTotp(uri, 1_234_567_890_000).code).toBe('89005924')

    // Raw Base32 defaults to 6 digits (last 6 digits of the RFC 8-digit value)
    expect(generateTotp('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq', 59_000)).toEqual({
      code: '287082',
      remainingSec: 1,
      period: 30,
    })
  })

  it('parses otpauth URI with SHA256 and custom period', () => {
    const parsed = parseTotpInput(`otpauth://totp/Test?secret=${RFC_SHA1_B32}&algorithm=SHA256&digits=6&period=60`)
    expect(parsed).toEqual({
      secret: RFC_SHA1_B32,
      digits: 6,
      period: 60,
      algorithm: 'sha256',
    })
  })

  it('rejects invalid Base32 secrets and non-TOTP URIs', () => {
    expect(() => parseTotpInput('')).toThrow()
    expect(() => parseTotpInput('SHORT')).toThrow()
    expect(() => parseTotpInput('NOT!VALID@BASE32')).toThrow()
    expect(() => parseTotpInput(`otpauth://hotp/Test?secret=${RFC_SHA1_B32}`)).toThrow()
    expect(() => parseTotpInput(`otpauth://totp/Test?secret=${RFC_SHA1_B32}&digits=4`)).toThrow()
  })
})
