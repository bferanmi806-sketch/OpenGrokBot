/**
 * 「复制诊断信息」复制的那段文字：发 issue 时贴上就够人看懂出了什么事。
 * 令牌、key 一类的东西就算混进了日志也抹掉——这段文字是要贴到网上的。
 */
export type DiagnosticsInput = {
  appVersion: string
  electron: string
  platform: string
  arch: string
  osVersion: string
  dataDir: string
  logFile: string
  port: number
  reason: string
  detail?: string | undefined
  tail: string[]
}

const SENSITIVE_KEY_BODY = '(?:[\\w.-]*?(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|webhook[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|[_-]token|Token|secret|password|passwd|passphrase)|token)'

const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '<hidden-private-key>'],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, '<hidden-private-key>'],
  [/^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '<hidden-private-key>'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'<>]+:)(?!<hidden>)[^/\s@"'<>]+(@)/gi, '$1<hidden>$2'],
  [/(https:\/\/hooks\.slack\.com\/services\/T[\w]+\/B[\w]+\/)(?!<hidden>)[\w-]+/gi, '$1<hidden>'],
  [/(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)(?!<hidden>)[\w-]+/gi, '$1<hidden>'],
  [/((?:Authorization|Proxy-Authorization)\s*:\s*Digest\s+)(?!\s*<hidden)[^\r\n]+/gi, '$1<hidden>'],
  [/((?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|Token|ApiKey)\s+)(?!\s*<hidden)[^\r\n"',;]+/gi, '$1<hidden>'],
  [/((?:Authorization|Proxy-Authorization)\s*:\s*)(?!\s*(?:Bearer|Basic|Token|Digest|ApiKey)\s)(?!\s*<hidden)[^\r\n"',;]+/gi, '$1<hidden>'],
  [/\b(Bearer\s+)(?!\s*<hidden)[\w.~+/-]{8,}=*/gi, '$1<hidden>'],
  [/((?:X-API-Key|X-Shim-Token|Cookie|Set-Cookie)\s*:\s*)(?!\s*<hidden)[^\r\n"']+/gi, '$1<hidden>'],
  [/([?&](?:token|key|api_key|apikey|access_token|refresh_token|client_secret|secret|password|code|signature|webhook_key|webhook_secret|auth_token)=)(?!<hidden)[^&\s"']+/gi, '$1<hidden>'],
  [/(--?(?:token|api-key|apikey|password|passwd|secret|client-secret|webhook-key|webhook-secret|auth-token)(?:=|\s+))(?!\s*<hidden)[^\s"']+/gi, '$1<hidden>'],
  [new RegExp(`(\\b(?:${SENSITIVE_KEY_BODY})=")(?!<hidden)([^"]+)(")`, 'gi'), '$1<hidden>$3'],
  [new RegExp(`(\\b(?:${SENSITIVE_KEY_BODY})=')(?!<hidden)([^']+)(')`, 'gi'), '$1<hidden>$3'],
  [new RegExp(`(\\b(?:${SENSITIVE_KEY_BODY})=)(?!<hidden)(?!['"])([^\\s&"',;]+)`, 'gi'), '$1<hidden>'],
  [new RegExp(`("(?:${SENSITIVE_KEY_BODY}|authorization|cookie|set-cookie)"\\s*:\\s*")(?!<hidden)([^"]+)(")`, 'gi'), '$1<hidden>$3'],
  [new RegExp(`((?:['"])?\\b(?:${SENSITIVE_KEY_BODY}|authorization|cookie|set-cookie)(?:['"])?\\s*:\\s*')(?!<hidden)([^']+)(')`, 'gi'), '$1<hidden>$3'],
  [new RegExp(`(\\b(?:${SENSITIVE_KEY_BODY})\\s*:\\s*")(?!<hidden)([^"]+)(")`, 'gi'), '$1<hidden>$3'],
  [new RegExp(`(^[ \\t-]*(?:${SENSITIVE_KEY_BODY})\\s*:\\s*)(?!\\s*<hidden)(?!\\s*(?:true|false|null|~|\\d+|\\[|\\{)\\s*$)([^\\r\\n#"']+?)(?=\\s*(?:#.*)?$)`, 'gim'), '$1<hidden>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<hidden-jwt>'],
  [/\b(sk-ant-)(?!…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(sk-proj-)(?!…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(sk-svcacct-)(?!…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(sk-[\w-]{4})(?!…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(AIza[\w-]{4})(?!…<hidden>)[\w-]{12,}/g, '$1…<hidden>'],
  [/\b(gsk_[\w-]{4})(?!…<hidden>)[\w-]{12,}/g, '$1…<hidden>'],
  [/\b(xai-[\w-]{4})(?!…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(xai-)(?!…<hidden>|[\w-]{4}…<hidden>)[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(cmp_)(?!<hidden>)[\w-]{10,}/g, '$1<hidden>'],
  [/\b(ak_)(?!<hidden>)[\w-]{12,}/g, '$1<hidden>'],
  [/\b(gh[pousr]_)(?!<hidden>)[\w]{16,}/g, '$1<hidden>'],
  [/\b(github_pat_)(?!<hidden>)[\w]{16,}/g, '$1<hidden>'],
  [/\b(glpat-)(?!<hidden>)[\w-]{12,}/g, '$1<hidden>'],
  [/\b(xox[baprs]-)(?!<hidden>)[\w-]{10,}/g, '$1<hidden>'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '$1<hidden>'],
  [/\b(hf_)(?!<hidden>)[A-Za-z0-9]{16,}/g, '$1<hidden>'],
  [/\b(r8_)(?!<hidden>)[A-Za-z0-9]{16,}/g, '$1<hidden>'],
  [/\b(pplx-)(?!<hidden>)[A-Za-z0-9]{16,}/g, '$1<hidden>'],
  [/\b((?:sk|rk)_(?:live|test)_)(?!<hidden>)[A-Za-z0-9]{12,}/g, '$1<hidden>'],
]

const HOME_PATHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"']+(?=\\|\/|$)/g, '~'],
  [/(?<![A-Za-z0-9._-])\/Users\/[^/\s"']+(?=\/|$)/g, '~'],
  [/(?<![A-Za-z0-9._-])\/home\/[^/\s"']+(?=\/|$)/g, '~'],
]

export function redact(text: string, opts?: { redactHomePath?: boolean }): string {
  let out = SECRETS.reduce((s, [re, to]) => s.replace(re, to), text)
  if (opts?.redactHomePath) {
    out = HOME_PATHS.reduce((s, [re, to]) => s.replace(re, to), out)
  }
  return out
}

export function diagnosticsText(d: DiagnosticsInput): string {
  return redact([
    `OpenSuperBot ${d.appVersion} (Electron ${d.electron}, ${d.platform} ${d.arch}, ${d.osVersion})`,
    `What happened: ${d.reason}${d.detail ? ` — ${d.detail}` : ''}`,
    `Port: ${d.port}`,
    `Data folder: ${d.dataDir}`,
    `Log file: ${d.logFile}`,
    '',
    `Last ${d.tail.length} log lines:`,
    ...d.tail,
  ].join('\n'), { redactHomePath: true })
}
