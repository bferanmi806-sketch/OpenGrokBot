import type { EditableMcp } from './approval-edit.js'
import { normalizeTarget } from './approvals.js'
import { redactSecrets } from './diagnostics.js'

export type GuardrailToolName = 'shell' | 'browser_click' | 'browser_type' | 'browser_press'

export const GUARDRAIL_TOOL_NAMES: ReadonlySet<GuardrailToolName> = new Set([
  'shell',
  'browser_click',
  'browser_type',
  'browser_press',
])

export function isGuardrailToolName(name: unknown): name is GuardrailToolName {
  return typeof name === 'string' && GUARDRAIL_TOOL_NAMES.has(name as GuardrailToolName)
}

export type GuardrailRiskCode =
  | 'shell_remote_exec'
  | 'shell_sensitive_read'
  | 'shell_network_exfil'
  | 'shell_destructive'
  | 'shell_force_git'
  | 'shell_system_mutation'
  | 'browser_purchase_action'
  | 'browser_destructive_action'
  | 'browser_external_submit'

export const GUARDRAIL_RISK_CODES: ReadonlySet<GuardrailRiskCode> = new Set([
  'shell_remote_exec',
  'shell_sensitive_read',
  'shell_network_exfil',
  'shell_destructive',
  'shell_force_git',
  'shell_system_mutation',
  'browser_purchase_action',
  'browser_destructive_action',
  'browser_external_submit',
])

export function isGuardrailRiskCode(code: unknown): code is GuardrailRiskCode {
  return typeof code === 'string' && GUARDRAIL_RISK_CODES.has(code as GuardrailRiskCode)
}

export type GuardrailHit = {
  blocked: true
  riskCode: GuardrailRiskCode
  approvalKind: 'purchase' | 'other'
  action: string
  detail: string
  target: string
}

export type GuardrailPass = { blocked: false }
export type GuardrailResult = GuardrailHit | GuardrailPass

export type FrozenComputerGuardrailExecution = {
  kind: 'computer_guardrail'
  tool: GuardrailToolName
  args: Record<string, unknown>
  riskCode: GuardrailRiskCode
  expectedOrigin?: string
}

const SECRET_FLAG_RE = /(--?(?:token|password|passwd|pass|secret|api[-_]?key|key|auth)(?:=|\s+))(\S+)/gi
const SECRET_HEADER_RE = /((?:authorization|x-api-key|x-shim-token|cookie)\s*:\s*)([^"'\\]+)/gi
const USER_PASS_RE = /(\s-u\s+[^\s:]+:)(\S+)/g
const URL_USERINFO_RE = /\b(https?:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi

export function redactGuardrailCommand(cmd: string): string {
  return redactSecrets(cmd, { redactHomePath: false })
    .replace(URL_USERINFO_RE, '$1<hidden>$3')
    .replace(SECRET_HEADER_RE, '$1…')
    .replace(SECRET_FLAG_RE, '$1…')
    .replace(USER_PASS_RE, '$1…')
}

const RISK_LABELS: Record<GuardrailRiskCode, string> = {
  shell_remote_exec: 'Remote script/code execution pipeline',
  shell_sensitive_read: 'Sensitive credential or secret file access',
  shell_network_exfil: 'Outbound data upload or network socket',
  shell_destructive: 'Destructive file or disk operation',
  shell_force_git: 'Destructive or force Git history operation',
  shell_system_mutation: 'Privilege escalation or system-level mutation',
  browser_purchase_action: 'Payment, checkout, or subscription submission',
  browser_destructive_action: 'Permanent deletion, revocation, or account closure',
  browser_external_submit: 'External message send, publish, merge, or transfer',
}

function originHostOf(urlOrOrigin?: string): { origin: string; host: string } | null {
  if (!urlOrOrigin) return null
  try {
    const u = new URL(urlOrOrigin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return { origin: u.origin, host: u.host }
  } catch {
    return null
  }
}

function singleLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, Math.max(1, maxChars - 1))}…`
}

function boundedMultiline(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…(truncated)`
}

export function formatGuardrailApprovalText(input: {
  tool: GuardrailToolName
  args: Record<string, unknown>
  riskCode: GuardrailRiskCode
  expectedOrigin?: string
  currentUrl?: string
}): { action: string; detail: string; target: string } {
  const parsedOrigin = originHostOf(input.expectedOrigin ?? input.currentUrl)
  const riskLabel = RISK_LABELS[input.riskCode]

  switch (input.tool) {
    case 'shell': {
      const rawCmd = String(input.args.cmd ?? '').trim()
      const firstLine = rawCmd.split(/\r?\n/)[0] ?? ''
      const redactedPreview = singleLine(redactGuardrailCommand(firstLine), 140)
      const action = `Run shell command: ${redactedPreview || '(empty)'}`
      const timeoutMs =
        typeof input.args.timeoutMs === 'number' && Number.isFinite(input.args.timeoutMs) && input.args.timeoutMs > 0
          ? Math.floor(input.args.timeoutMs)
          : undefined
      const detailLines = [
        `Safety guardrail: ${riskLabel} (${input.riskCode})`,
        'Command:',
        boundedMultiline(rawCmd, 4_000),
        ...(timeoutMs !== undefined ? [`Timeout: ${timeoutMs}ms`] : []),
      ]
      return {
        action,
        detail: detailLines.join('\n'),
        target: 'computer:shell',
      }
    }
    case 'browser_click': {
      const rawTarget = String(input.args.target ?? '').trim()
      const preview = singleLine(rawTarget, 100)
      const action = `Click "${preview}"${parsedOrigin ? ` on ${parsedOrigin.host}` : ''}`
      const detailLines = [
        `Safety guardrail: ${riskLabel} (${input.riskCode})`,
        `Target control: ${boundedMultiline(rawTarget, 1_000)}`,
        ...(parsedOrigin ? [`Page origin: ${parsedOrigin.origin}`] : []),
      ]
      return {
        action,
        detail: detailLines.join('\n'),
        target: parsedOrigin ? normalizeTarget(parsedOrigin.origin) : 'computer:browser_click',
      }
    }
    case 'browser_type': {
      const rawTarget = String(input.args.target ?? '').trim()
      const rawText = String(input.args.text ?? '')
      const submit = input.args.submit === true
      const preview = singleLine(rawTarget, 90)
      const action = `Type into "${preview}"${submit ? ' and submit' : ''}${parsedOrigin ? ` on ${parsedOrigin.host}` : ''}`
      const detailLines = [
        `Safety guardrail: ${riskLabel} (${input.riskCode})`,
        `Target input: ${boundedMultiline(rawTarget, 1_000)}`,
        `Text: ${boundedMultiline(rawText, 1_000)}`,
        `Press Enter (submit): ${submit ? 'yes' : 'no'}`,
        ...(parsedOrigin ? [`Page origin: ${parsedOrigin.origin}`] : []),
      ]
      return {
        action,
        detail: detailLines.join('\n'),
        target: parsedOrigin ? normalizeTarget(parsedOrigin.origin) : 'computer:browser_type',
      }
    }
    case 'browser_press': {
      const rawKey = String(input.args.key ?? '').trim()
      const preview = singleLine(rawKey, 60)
      const action = `Press "${preview}"${parsedOrigin ? ` on ${parsedOrigin.host}` : ''}`
      const detailLines = [
        `Safety guardrail: ${riskLabel} (${input.riskCode})`,
        `Key: ${preview}`,
        ...(parsedOrigin ? [`Page origin: ${parsedOrigin.origin}`] : []),
      ]
      return {
        action,
        detail: detailLines.join('\n'),
        target: parsedOrigin ? normalizeTarget(parsedOrigin.origin) : 'computer:browser_press',
      }
    }
  }
}

export function buildGuardrailInputSchema(tool: GuardrailToolName): Record<string, unknown> {
  switch (tool) {
    case 'shell':
      return {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The bash command line to run.' },
          timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds (1–600000).' },
        },
        required: ['cmd'],
      }
    case 'browser_click':
      return {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'CSS selector or visible text of the control to click.' },
        },
        required: ['target'],
      }
    case 'browser_type':
      return {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'CSS selector, label, or placeholder of the field.' },
          text: { type: 'string', description: 'Text to type into the field.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
        },
        required: ['target', 'text'],
      }
    case 'browser_press':
      return {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to press on the active page (e.g. "Enter").' },
        },
        required: ['key'],
      }
  }
}

export function buildGuardrailEditable(frozen: FrozenComputerGuardrailExecution): EditableMcp {
  const safeArgs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(frozen.args)) {
    if (Object.hasOwn(frozen.args, k)) safeArgs[k] = v
  }
  return {
    kind: 'mcp',
    serverName: 'computer',
    toolName: frozen.tool,
    args: safeArgs,
    inputSchema: buildGuardrailInputSchema(frozen.tool),
  }
}

// ---------------------------------------------------------------------------
// Shell command parsing & risk classification
// ---------------------------------------------------------------------------

const MAX_EXTRACT_DEPTH = 8

/** Split shell command into pipelines separated by newline, `;`, `&&`, `||`, or background `&` outside quotes/parens. */
function splitShellStatements(src: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: "'" | '"' | '`' | null = null
  let parenDepth = 0

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    const next = src[i + 1]

    if (quote === "'") {
      cur += ch
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      cur += ch
      if (ch === '\\' && next !== undefined) {
        cur += next
        i++
        continue
      }
      if (ch === '"') quote = null
      continue
    }
    if (quote === '`') {
      cur += ch
      if (ch === '\\' && next !== undefined) {
        cur += next
        i++
        continue
      }
      if (ch === '`') quote = null
      continue
    }

    if (ch === '\\' && next !== undefined) {
      if (next === '\n') {
        cur += ' '
        i++
        continue
      }
      cur += ch + next
      i++
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      cur += ch
      continue
    }

    if (ch === '(') {
      parenDepth++
      cur += ch
      continue
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--
      cur += ch
      continue
    }

    if (parenDepth === 0) {
      if (ch === '\n' || ch === '\r' || ch === ';') {
        if (cur.trim()) out.push(cur.trim())
        cur = ''
        continue
      }
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        if (cur.trim()) out.push(cur.trim())
        cur = ''
        i++
        continue
      }
      if (ch === '&' && next !== '>' && src[i - 1] !== '>' && src[i - 1] !== '<') {
        if (cur.trim()) out.push(cur.trim())
        cur = ''
        continue
      }
    }

    cur += ch
  }

  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Split a single statement into pipe stages separated by `|` or `|&` outside quotes/parens. */
function splitPipeStages(statement: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: "'" | '"' | '`' | null = null
  let parenDepth = 0

  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i]!
    const next = statement[i + 1]

    if (quote === "'") {
      cur += ch
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"' || quote === '`') {
      cur += ch
      if (ch === '\\' && next !== undefined) {
        cur += next
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '\\' && next !== undefined) {
      cur += ch + next
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '(') {
      parenDepth++
      cur += ch
      continue
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--
      cur += ch
      continue
    }

    if (parenDepth === 0 && ch === '|' && next !== '|') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      if (next === '&') i++
      continue
    }

    cur += ch
  }

  if (cur.trim()) out.push(cur.trim())
  return out
}

/**
 * Check if `s` is wrapped in balanced outer `(...)` or `{ ... }` (quote-aware).
 * Returns the inner command string when unwrapped so subshells like `(echo ok; rm -rf /tmp/x)`
 * are recursively split and evaluated rather than treated as arguments of the first verb.
 */
function unwrapBalancedOuterGroup(s: string): { unwrapped: boolean; inner: string } {
  const trimmed = s.trim()
  if (trimmed.length < 2) return { unwrapped: false, inner: trimmed }

  const open = trimmed[0]!
  const close = open === '(' ? ')' : open === '{' ? '}' : null
  if (!close || trimmed[trimmed.length - 1] !== close) {
    return { unwrapped: false, inner: trimmed }
  }

  let depth = 0
  let quote: "'" | '"' | '`' | null = null
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    const next = trimmed[i + 1]
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"' || quote === '`') {
      if (ch === '\\' && next !== undefined) {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '\\' && next !== undefined) {
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === open) depth++
    else if (ch === close) depth--
    if (depth === 0 && i < trimmed.length - 1) {
      return { unwrapped: false, inner: trimmed }
    }
  }

  if (depth !== 0) return { unwrapped: false, inner: trimmed }
  return { unwrapped: true, inner: trimmed.slice(1, -1).trim() }
}

/** Extract `$(...)` and backtick command substitutions outside single quotes. */
function extractCommandSubstitutions(src: string): string[] {
  const found: string[] = []
  let inSingle = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    const next = src[i + 1]

    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '\\' && next !== undefined) {
      i++
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }

    if (ch === '$' && next === '(' && src[i + 2] !== '(') {
      let depth = 1
      let j = i + 2
      let subSingle = false
      let subDouble = false
      for (; j < src.length && depth > 0; j++) {
        const c = src[j]!
        if (subSingle) {
          if (c === "'") subSingle = false
          continue
        }
        if (c === '\\' && src[j + 1] !== undefined) {
          j++
          continue
        }
        if (subDouble) {
          if (c === '"') subDouble = false
          continue
        }
        if (c === "'") {
          subSingle = true
          continue
        }
        if (c === '"') {
          subDouble = true
          continue
        }
        if (c === '(') depth++
        else if (c === ')') depth--
      }
      if (depth === 0) {
        const inner = src.slice(i + 2, j - 1).trim()
        if (inner) found.push(inner)
        i = j - 1
        continue
      }
    }

    if (ch === '`') {
      let j = i + 1
      let buf = ''
      for (; j < src.length; j++) {
        const c = src[j]!
        if (c === '\\' && src[j + 1] !== undefined) {
          if (src[j + 1] === '`' || src[j + 1] === '\\' || src[j + 1] === '$') {
            buf += src[j + 1]!
            j++
            continue
          }
        }
        if (c === '`') break
        buf += c
      }
      if (j < src.length && buf.trim()) {
        found.push(buf.trim())
        i = j
      }
    }
  }

  return found
}

/** Tokenize a single shell stage into unquoted words while preserving unquoted operator text. */
function tokenizeShellWords(stage: string): { words: string[]; unquotedText: string } {
  const words: string[] = []
  let unquotedText = ''
  let cur = ''
  let hasChars = false
  let quote: "'" | '"' | null = null

  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i]!
    const next = stage[i + 1]

    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        cur += ch
      }
      continue
    }
    if (quote === '"') {
      if (ch === '\\' && next !== undefined && (next === '"' || next === '\\' || next === '$' || next === '`')) {
        cur += next
        i++
        continue
      }
      if (ch === '"') {
        quote = null
      } else {
        cur += ch
      }
      continue
    }

    if (ch === '\\' && next !== undefined) {
      cur += next
      unquotedText += next
      hasChars = true
      i++
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      hasChars = true
      unquotedText += ' '
      continue
    }

    if (/\s/.test(ch)) {
      unquotedText += ch
      if (hasChars) {
        words.push(cur)
        cur = ''
        hasChars = false
      }
      continue
    }

    unquotedText += ch
    cur += ch
    hasChars = true
  }

  if (hasChars) words.push(cur)
  return { words, unquotedText }
}

const SHELL_GRAMMAR_KEYWORDS = new Set([
  'then',
  'else',
  'elif',
  'do',
  'if',
  'while',
  'until',
  '{',
  '}',
  '!',
  'coproc',
])

const XARGS_TWO_ARG_FLAGS = new Set([
  '-I',
  '-J',
  '-L',
  '-n',
  '-P',
  '-s',
  '-E',
  '-e',
  '-d',
  '-a',
  '--max-args',
  '--max-procs',
  '--max-lines',
  '--replace',
  '--delimiter',
  '--arg-file',
  '--eof',
  '--process-slot-var',
])

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

function normalizeCommandVerb(rawWord: string): string {
  const cleaned = rawWord.replace(/^\\+/, '')
  const slash = cleaned.lastIndexOf('/')
  return (slash >= 0 ? cleaned.slice(slash + 1) : cleaned).toLowerCase()
}

/**
 * Strip leading shell grammar keywords, env assignments, and command wrappers (`env`, `timeout`,
 * `exec`, `nice`, `nohup`, `command`, `caffeinate`, `arch`, `stdbuf`, `xargs`) to find the real verb + args.
 */
function unwrapStageWords(words: string[]): { verb: string; args: string[]; envSplitScripts: string[] } {
  const envSplitScripts: string[] = []
  let i = 0

  while (i < words.length) {
    const w = words[i]!
    if (ENV_ASSIGN_RE.test(w) || SHELL_GRAMMAR_KEYWORDS.has(w)) {
      i++
      continue
    }

    const v = normalizeCommandVerb(w)

    if (v === 'env') {
      i++
      while (i < words.length) {
        const tok = words[i]!
        if (ENV_ASSIGN_RE.test(tok)) {
          i++
          continue
        }
        if (tok === '--') {
          i++
          break
        }
        if (tok === '-u' || tok === '--unset' || tok === '-C' || tok === '--chdir') {
          i += 2
          continue
        }
        if (tok === '-S' || tok === '--split-string') {
          if (i + 1 < words.length && words[i + 1]!.trim()) envSplitScripts.push(words[i + 1]!)
          i += 2
          continue
        }
        if (tok.startsWith('-S') && tok.length > 2) {
          envSplitScripts.push(tok.slice(2))
          i++
          continue
        }
        if (tok.startsWith('--split-string=')) {
          envSplitScripts.push(tok.slice('--split-string='.length))
          i++
          continue
        }
        if (tok.startsWith('-')) {
          i++
          continue
        }
        break
      }
      continue
    }

    if (v === 'exec') {
      i++
      while (i < words.length && words[i]!.startsWith('-')) {
        if (words[i] === '--') {
          i++
          break
        }
        if (words[i] === '-a') {
          i += 2
          continue
        }
        i++
      }
      continue
    }

    if (v === 'timeout' || v === 'gtimeout') {
      i++
      while (i < words.length && words[i]!.startsWith('-')) {
        if (words[i] === '--') {
          i++
          break
        }
        if (words[i] === '-k' || words[i] === '--kill-after' || words[i] === '-s' || words[i] === '--signal') {
          i += 2
          continue
        }
        i++
      }
      // Skip duration positional argument
      if (i < words.length) i++
      continue
    }

    if (v === 'nice') {
      i++
      while (i < words.length && words[i]!.startsWith('-')) {
        if (words[i] === '--') {
          i++
          break
        }
        if (words[i] === '-n' || words[i] === '--adjustment') {
          i += 2
          continue
        }
        i++
      }
      continue
    }

    if (v === 'caffeinate') {
      i++
      while (i < words.length && words[i]!.startsWith('-')) {
        if (words[i] === '--') {
          i++
          break
        }
        if (words[i] === '-t' || words[i] === '-w') {
          i += 2
          continue
        }
        i++
      }
      continue
    }

    if (v === 'arch') {
      i++
      while (i < words.length && words[i]!.startsWith('-')) {
        if (words[i] === '--') {
          i++
          break
        }
        if (words[i] === '-arch') {
          i += 2
          continue
        }
        i++
      }
      continue
    }

    if (v === 'stdbuf' || v === 'gstdbuf') {
      i++
      while (i < words.length && words[i]!.startsWith('-')) {
        if (words[i] === '--') {
          i++
          break
        }
        if (words[i] === '-i' || words[i] === '-o' || words[i] === '-e') {
          i += 2
          continue
        }
        i++
      }
      continue
    }

    if (v === 'command') {
      const nextTok = words[i + 1] ?? ''
      if (nextTok === '-v' || nextTok === '-V' || /^-[a-zA-Z]*[vV]/.test(nextTok)) {
        return { verb: 'command', args: words.slice(i + 1), envSplitScripts }
      }
      i++
      while (i < words.length && words[i]!.startsWith('-')) {
        if (words[i] === '--') {
          i++
          break
        }
        i++
      }
      continue
    }

    if (v === 'builtin' || v === 'nohup' || v === 'time') {
      i++
      while (i < words.length && words[i]!.startsWith('-')) {
        if (words[i] === '--') {
          i++
          break
        }
        i++
      }
      continue
    }

    if (v === 'xargs' || v === 'gxargs') {
      i++
      while (i < words.length && words[i]!.startsWith('-')) {
        const tok = words[i]!
        if (tok === '--') {
          i++
          break
        }
        if (XARGS_TWO_ARG_FLAGS.has(tok)) {
          i += 2
          continue
        }
        i++
      }
      continue
    }

    return { verb: v, args: words.slice(i + 1), envSplitScripts }
  }

  return { verb: '', args: [], envSplitScripts }
}

const SHELL_INTERPRETER_VERBS = new Set([
  'sh',
  'bash',
  'zsh',
  'ash',
  'dash',
  'ksh',
  'fish',
  'node',
  'nodejs',
  'perl',
  'ruby',
  'php',
])

function isInterpreterVerb(verb: string): boolean {
  return SHELL_INTERPRETER_VERBS.has(verb) || /^python[0-9.]*$/.test(verb)
}

const SHELL_DASH_C_VERBS = new Set(['sh', 'bash', 'zsh', 'ash', 'dash', 'ksh', 'fish'])

function extractInlineShellArgs(verb: string, args: string[]): string[] {
  if (verb === 'eval') {
    const joined = args.join(' ').trim()
    return joined ? [joined] : []
  }
  if (!SHELL_DASH_C_VERBS.has(verb)) return []
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!
    if (tok === '--') break
    if (tok === '--command' && i + 1 < args.length) {
      return [args[i + 1]!]
    }
    if (tok.startsWith('--command=')) {
      return [tok.slice('--command='.length)]
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(tok) && i + 1 < args.length) {
      return [args[i + 1]!]
    }
  }
  return []
}

const REMOTE_SUBST_FETCH_RE = /(?:\$\([^)]*\b(?:curl|wget)\b|`[^`]*\b(?:curl|wget)\b)/i
const PROCESS_SUB_REMOTE_EXEC_RE = /\b(?:sh|bash|zsh|ash|dash|ksh|fish|source|\.)\s+<\(\s*(?:curl|wget)\b/i
const ETC_OVERWRITE_REDIRECT_RE = /(?:^|[^<])>{1,2}\s*\/(?:private\/)?etc(?:\/|$)/

const SENSITIVE_PATH_RE =
  /(?:^|[\s"'=:@(<>;])(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s"']+|\/home\/[^/\s"']+|\/root)\/\.(?:ssh|aws|gnupg|kube|npmrc|netrc|pypirc|git-credentials|docker|azure|config\/(?:gcloud|gh))(?:\/|\b|$)/
const SENSITIVE_ETC_READ_RE = /(?:^|[\s"'=:@(<>;])\/(?:private\/)?etc\/(?:shadow|sudoers|master\.passwd)(?:\/|\b|$)/
const MACOS_KEYCHAIN_RE = /\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain|export)\b/i
const GATEWAY_SECRETS_RE =
  /(?:^|[\s"'=/\\<>;:])(?:mcp-secrets\.json|vault-secrets(?:\.json)?|polery-oauth(?:\.json)?|auth-token(?:\.json|\.txt)?|llm-key(?:\.json|\.txt)?|opensuperbot\.db(?:-wal|-shm)?)(?:$|[\s"'])|\$\{?OPENSUPERBOT_(?:DATA|TOKEN)\}?/i

function checkSensitiveReadText(text: string): boolean {
  return (
    SENSITIVE_PATH_RE.test(text) ||
    SENSITIVE_ETC_READ_RE.test(text) ||
    MACOS_KEYCHAIN_RE.test(text) ||
    GATEWAY_SECRETS_RE.test(text)
  )
}

function extractInlineInterpreterCode(verb: string, args: string[]): string[] {
  const scripts: string[] = []
  if (/^python[0-9.]*$/.test(verb)) {
    for (let i = 0; i < args.length; i++) {
      const tok = args[i]!
      if (tok === '--') break
      if (/^-[a-zA-Z]*c$/.test(tok) && i + 1 < args.length) {
        scripts.push(args[i + 1]!)
        break
      }
      if (tok.startsWith('-c') && tok.length > 2) {
        scripts.push(tok.slice(2))
        break
      }
    }
  } else if (verb === 'node' || verb === 'nodejs') {
    for (let i = 0; i < args.length; i++) {
      const tok = args[i]!
      if (tok === '--') break
      if ((tok === '-e' || tok === '--eval' || tok === '-p' || tok === '--print') && i + 1 < args.length) {
        scripts.push(args[i + 1]!)
        i++
        continue
      }
      if (tok.startsWith('--eval=')) scripts.push(tok.slice('--eval='.length))
      else if (tok.startsWith('--print=')) scripts.push(tok.slice('--print='.length))
      else if (tok.startsWith('-e') && tok.length > 2) scripts.push(tok.slice(2))
    }
  } else if (verb === 'perl') {
    for (let i = 0; i < args.length; i++) {
      const tok = args[i]!
      if (tok === '--') break
      if (/^-[a-zA-Z]*[eE]$/.test(tok) && i + 1 < args.length) {
        scripts.push(args[i + 1]!)
        i++
      }
    }
  } else if (verb === 'ruby') {
    for (let i = 0; i < args.length; i++) {
      const tok = args[i]!
      if (tok === '--') break
      if (/^-[a-zA-Z]*e$/.test(tok) && i + 1 < args.length) {
        scripts.push(args[i + 1]!)
        i++
      }
    }
  } else if (verb === 'php') {
    for (let i = 0; i < args.length; i++) {
      const tok = args[i]!
      if (tok === '--') break
      if ((tok === '-r' || tok === '--run') && i + 1 < args.length) {
        scripts.push(args[i + 1]!)
        i++
      }
    }
  }
  return scripts
}

const INLINE_CODE_DESTRUCTIVE_RE =
  /\b(?:rmtree|rmSync|rmdirSync|unlinkSync|removedirs)\b|\bos\.(?:remove|unlink|rmdir)\s*\(|\bfs\.promises\.(?:rm|rmdir|unlink)\s*\(|\bFileUtils\.rm_rf\b|\bPath\([^)]*\)\.unlink\s*\(/
const INLINE_CODE_EXFIL_RE =
  /\b(?:urllib\.request|http\.client|requests\.(?:post|put|patch|delete)|httpx\.(?:post|put|patch|delete)|axios\.(?:post|put|patch|delete))\b|\bfetch\s*\([\s\S]*?\b(?:POST|PUT|PATCH|DELETE)\b|\bsocket\.socket\s*\(|\bnet\.connect\s*\(/i
const INLINE_CODE_SPAWN_RE =
  /\b(?:subprocess\b|os\.system\s*\(|os\.popen\s*\(|pty\.spawn\s*\(|child_process\b|execSync\s*\(|spawnSync\s*\(|execFileSync\s*\(|do\s+shell\s+script\b)/

function checkInlineInterpreterRisk(verb: string, args: string[]): GuardrailRiskCode | null {
  if (verb === 'osascript') {
    if (args.some((a) => a === '-e' || a.startsWith('-e'))) {
      return 'shell_system_mutation'
    }
  }

  const scripts = extractInlineInterpreterCode(verb, args)
  for (const code of scripts) {
    if (
      checkSensitiveReadText(code) ||
      /\.(?:ssh|aws|gnupg|kube|npmrc|netrc|pypirc|git-credentials|docker|azure)\b|\/etc\/(?:shadow|sudoers|master\.passwd)\b/.test(
        code,
      )
    ) {
      return 'shell_sensitive_read'
    }
    if (INLINE_CODE_DESTRUCTIVE_RE.test(code)) {
      return 'shell_destructive'
    }
    if (INLINE_CODE_EXFIL_RE.test(code)) {
      return 'shell_network_exfil'
    }
    if (INLINE_CODE_SPAWN_RE.test(code)) {
      return 'shell_system_mutation'
    }
  }

  return null
}

function extractFindExecCommands(args: string[]): string[][] {
  const cmds: string[][] = []
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!
    if (tok === '-exec' || tok === '-execdir' || tok === '-ok' || tok === '-okdir') {
      const sub: string[] = []
      let j = i + 1
      for (; j < args.length; j++) {
        const cur = args[j]!
        if (cur === ';' || cur === '+') break
        sub.push(cur)
      }
      if (sub.length > 0) cmds.push(sub)
      i = j
    }
  }
  return cmds
}

function checkCurlExfil(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!
    if (tok === '--') break
    // Combined or standalone short flags `-d`, `-F`, `-T` with or without attached payload (`-sd@file`, `-Ffile=@x`)
    if (/^-[a-zA-Z]*[dFT]/.test(tok)) {
      return true
    }
    if (
      /^--(?:data|data-raw|data-binary|data-urlencode|data-ascii|form|form-string|upload-file|json|url-query)(?:=|$)/.test(
        tok,
      )
    ) {
      return true
    }
    // `-X POST`, `-sX POST`, `-XPOST`, `-sXPOST`, `--request POST`, `--request=POST`
    const shortX = /^-[a-zA-Z]*X(.*)$/.exec(tok)
    if (shortX) {
      const method = (shortX[1] || args[i + 1] || '').toUpperCase()
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return true
    }
    if (tok === '--request') {
      const method = (args[i + 1] ?? '').toUpperCase()
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return true
    }
    const inlineReq = /^--request=(.+)$/i.exec(tok)
    if (inlineReq) {
      const method = inlineReq[1]!.toUpperCase()
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return true
    }
  }
  return false
}

function checkWgetExfil(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!
    if (tok === '--') break
    if (/^--(?:post-data|post-file|body-data|body-file)(?:=|$)/i.test(tok)) return true
    if (tok.toLowerCase() === '--method') {
      const m = (args[i + 1] ?? '').toUpperCase()
      if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') return true
    }
    const methodMatch = /^--method=(.+)$/i.exec(tok)
    if (methodMatch) {
      const m = methodMatch[1]!.toUpperCase()
      if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') return true
    }
  }
  return false
}

function checkRsyncRemote(args: string[]): boolean {
  for (const tok of args) {
    if (tok.startsWith('-')) continue
    if (/^rsync:\/\//i.test(tok)) return true
    if (/^(?:[^\s@/:]+@)?[A-Za-z0-9.-]+:/.test(tok)) return true
  }
  return false
}

function checkRmDestructive(args: string[]): boolean {
  let optsEnded = false
  const targets: string[] = []
  for (const tok of args) {
    if (!optsEnded && tok === '--') {
      optsEnded = true
      continue
    }
    if (!optsEnded && tok.startsWith('--')) {
      if (tok === '--recursive' || tok === '--force' || tok === '--no-preserve-root') return true
      continue
    }
    if (!optsEnded && tok.startsWith('-') && tok.length > 1) {
      if (/[rRf]/.test(tok.slice(1))) return true
      continue
    }
    targets.push(tok)
  }

  for (const rawTarget of targets) {
    const t = rawTarget.trim()
    if (!t) continue
    if (
      t === '.' ||
      t === './' ||
      t === '..' ||
      t.startsWith('../') ||
      t.includes('/..') ||
      t.startsWith('/') ||
      t === '~' ||
      t.startsWith('~/') ||
      t.startsWith('$HOME') ||
      t.startsWith('${HOME}') ||
      t.includes('*')
    ) {
      return true
    }
  }

  return false
}

const GIT_TWO_ARG_GLOBAL_OPTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
])

function resolveGitSubcommand(args: string[]): { sub: string; rest: string[] } {
  let i = 0
  while (i < args.length) {
    const tok = args[i]!
    if (!tok.startsWith('-')) break
    if (GIT_TWO_ARG_GLOBAL_OPTS.has(tok) && i + 1 < args.length) {
      i += 2
      continue
    }
    i++
  }
  return {
    sub: (args[i] ?? '').toLowerCase(),
    rest: args.slice(i + 1),
  }
}

/** Strip ONLY `-m <msg>` / `--message <msg>` / `--message=<msg>` literals on `git commit` while keeping `-F <file>` and file paths intact. */
function stripGitCommitMessageArgs(rest: string[]): string {
  const kept: string[] = ['git', 'commit']
  let optsEnded = false
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!
    if (!optsEnded && tok === '--') {
      optsEnded = true
      kept.push(tok)
      continue
    }
    if (!optsEnded) {
      if ((tok === '-m' || tok === '--message' || /^-[a-zA-Z]*m$/.test(tok)) && i + 1 < rest.length) {
        i++
        continue
      }
      if (tok.startsWith('--message=') || (tok.startsWith('-m') && tok.length > 2)) {
        continue
      }
    }
    kept.push(tok)
  }
  return kept.join(' ')
}

function checkGitForce(args: string[]): boolean {
  const { sub, rest } = resolveGitSubcommand(args)

  if (sub === 'push') {
    let optsEnded = false
    for (const tok of rest) {
      if (!optsEnded && tok === '--') {
        optsEnded = true
        continue
      }
      if (!optsEnded) {
        if (
          tok === '-f' ||
          tok === '--force' ||
          tok.startsWith('--force-with-lease') ||
          tok.startsWith('--force-if-includes') ||
          tok === '--mirror' ||
          (/^-[a-zA-Z]+$/.test(tok) && tok.includes('f'))
        ) {
          return true
        }
      }
      if (!tok.startsWith('-') && /^\+[A-Za-z0-9_./:-]+$/.test(tok)) {
        return true
      }
    }
  } else if (sub === 'reset') {
    if (rest.includes('--hard')) return true
  } else if (sub === 'clean') {
    for (const tok of rest) {
      if (tok === '--') break
      if (tok === '--force' || (/^-[a-zA-Z]+$/.test(tok) && tok.includes('f'))) return true
    }
  }

  return false
}

function checkSystemMutation(verb: string, args: string[]): boolean {
  if (
    verb === 'sudo' ||
    verb === 'su' ||
    verb === 'doas' ||
    verb === 'launchctl' ||
    verb === 'crontab' ||
    verb === 'systemctl' ||
    verb === 'visudo' ||
    verb === 'csrutil' ||
    verb === 'spctl'
  ) {
    return true
  }

  if (verb === 'chmod') {
    if (args.some((t) => t === '777' || t === '0777' || t === 'a+rwx')) return true
  }

  if (verb === 'chown') {
    if (args.some((t) => t === '--recursive' || (/^-[a-zA-Z]+$/.test(t) && (t.includes('R') || t.includes('r'))))) {
      return true
    }
  }

  if (verb === 'npm') {
    const hasInstall = args.some((t) => /^(?:i|install|add|un|uninstall|remove)$/.test(t))
    const hasGlobal = args.some((t) => t === '-g' || t === '--global' || t === '--location=global')
    if (hasInstall && hasGlobal) return true
  }

  if (verb === 'pnpm') {
    const hasAdd = args.some((t) => /^(?:add|i|install|rm|remove|un|uninstall)$/.test(t))
    const hasGlobal = args.some((t) => t === '-g' || t === '--global')
    if (hasAdd && hasGlobal) return true
  }

  if (verb === 'yarn') {
    if (args[0] === 'global' && /^(?:add|remove|upgrade)$/.test(args[1] ?? '')) return true
  }

  if (verb === 'brew') {
    const sub = (args.find((t) => !t.startsWith('-')) ?? '').toLowerCase()
    if (/^(?:install|uninstall|remove|reinstall|tap|untap|services)$/.test(sub)) return true
  }

  if (/^pip[0-9.]*$/.test(verb)) {
    if (args.includes('install') && args.includes('--break-system-packages')) return true
  }

  return false
}

function evaluateUnwrappedVerbAndArgs(
  verb: string,
  args: string[],
  depth: number,
  rawStageText = '',
  joinedWordsText = '',
  unquotedStageText = '',
): GuardrailRiskCode | null {
  // Here-string / here-doc fed directly into a shell interpreter (`bash <<< "rm -rf /tmp/x"`)
  if ((SHELL_DASH_C_VERBS.has(verb) || verb === 'eval') && /<</.test(unquotedStageText)) {
    return 'shell_remote_exec'
  }

  // `sh/bash/zsh/dash/ash/ksh/fish -c` or `eval` executing `$(curl ...)` / `` `wget ...` ``
  const inlineShellCmds = extractInlineShellArgs(verb, args)
  if (SHELL_DASH_C_VERBS.has(verb) || verb === 'eval') {
    if (REMOTE_SUBST_FETCH_RE.test(rawStageText)) {
      return 'shell_remote_exec'
    }
    for (const inlineCmd of inlineShellCmds) {
      if (REMOTE_SUBST_FETCH_RE.test(inlineCmd)) {
        return 'shell_remote_exec'
      }
    }
  }

  for (const inlineCmd of inlineShellCmds) {
    const inlineHit = evaluateShellScript(inlineCmd, depth + 1)
    if (inlineHit) return inlineHit
  }

  // Redirection overwriting /etc/* (unquoted redirection syntax)
  if (unquotedStageText && ETC_OVERWRITE_REDIRECT_RE.test(unquotedStageText)) {
    return 'shell_destructive'
  }

  // Sensitive host credentials & OpenSuperBot secret files (strip ONLY `-m` message literal on `git commit`)
  if (verb === 'git') {
    const { sub, rest } = resolveGitSubcommand(args)
    if (sub === 'commit') {
      const nonMsgGitText = stripGitCommitMessageArgs(rest)
      if (checkSensitiveReadText(nonMsgGitText)) {
        return 'shell_sensitive_read'
      }
    } else if (checkSensitiveReadText(rawStageText) || checkSensitiveReadText(joinedWordsText)) {
      return 'shell_sensitive_read'
    }
  } else if (checkSensitiveReadText(rawStageText) || checkSensitiveReadText(joinedWordsText)) {
    return 'shell_sensitive_read'
  }

  // Inline interpreter code (`python -c`, `node -e`/`--eval`, `perl -e`, `ruby -e`, `php -r`, `osascript -e`)
  const inlineCodeHit = checkInlineInterpreterRisk(verb, args)
  if (inlineCodeHit) return inlineCodeHit

  // Destructive commands & `find -exec`
  if (verb === 'rm' && checkRmDestructive(args)) {
    return 'shell_destructive'
  }
  if (verb === 'find') {
    if (args.includes('-delete')) return 'shell_destructive'
    for (const execWords of extractFindExecCommands(args)) {
      const subUnwrapped = unwrapStageWords(execWords)
      for (const envScript of subUnwrapped.envSplitScripts) {
        const envHit = evaluateShellScript(envScript, depth + 1)
        if (envHit) return envHit
      }
      if (subUnwrapped.verb === 'rm' || subUnwrapped.verb === 'rmdir' || subUnwrapped.verb === 'shred') {
        return 'shell_destructive'
      }
      const subJoined = execWords.join(' ')
      const subHit = evaluateUnwrappedVerbAndArgs(
        subUnwrapped.verb,
        subUnwrapped.args,
        depth + 1,
        subJoined,
        subJoined,
        '',
      )
      if (subHit) return subHit
    }
  }
  if (/^mkfs(?:\.[\w-]+)?$/.test(verb)) {
    return 'shell_destructive'
  }
  if (verb === 'dd' && args.some((a) => a.startsWith('if='))) {
    return 'shell_destructive'
  }
  if (verb === 'diskutil' && /^(?:erase\w*|partitiondisk)$/i.test(args[0] ?? '')) {
    return 'shell_destructive'
  }
  if (verb === 'diskutil' && (args[0] ?? '').toLowerCase() === 'apfs' && /^delete\w*$/i.test(args[1] ?? '')) {
    return 'shell_destructive'
  }
  if (verb === 'shred') {
    return 'shell_destructive'
  }

  // Network exfiltration / remote sockets
  if (verb === 'curl' && checkCurlExfil(args)) {
    return 'shell_network_exfil'
  }
  if (verb === 'wget' && checkWgetExfil(args)) {
    return 'shell_network_exfil'
  }
  if (verb === 'scp' || verb === 'sftp') {
    return 'shell_network_exfil'
  }
  if (verb === 'rsync' && checkRsyncRemote(args)) {
    return 'shell_network_exfil'
  }
  if (verb === 'nc' || verb === 'ncat' || verb === 'netcat' || verb === 'socat') {
    return 'shell_network_exfil'
  }

  // Force git
  if (verb === 'git' && checkGitForce(args)) {
    return 'shell_force_git'
  }

  // System mutation / privilege escalation
  if (checkSystemMutation(verb, args)) {
    return 'shell_system_mutation'
  }

  return null
}

function evaluateShellScript(src: string, depth: number): GuardrailRiskCode | null {
  if (depth > MAX_EXTRACT_DEPTH) return null
  const trimmed = src.trim()
  if (!trimmed) return null

  const outerGroup = unwrapBalancedOuterGroup(trimmed)
  if (outerGroup.unwrapped) {
    return evaluateShellScript(outerGroup.inner, depth + 1)
  }

  if (PROCESS_SUB_REMOTE_EXEC_RE.test(trimmed)) return 'shell_remote_exec'

  // Recursively inspect `$(...)` and backtick command substitutions
  for (const sub of extractCommandSubstitutions(trimmed)) {
    const subHit = evaluateShellScript(sub, depth + 1)
    if (subHit) return subHit
  }

  const statements = splitShellStatements(trimmed)
  for (const rawStmt of statements) {
    const stmtTrimmed = rawStmt.trim()
    if (!stmtTrimmed) continue

    const stmtGroup = unwrapBalancedOuterGroup(stmtTrimmed)
    if (stmtGroup.unwrapped) {
      const groupHit = evaluateShellScript(stmtGroup.inner, depth + 1)
      if (groupHit) return groupHit
      continue
    }

    const stages = splitPipeStages(stmtTrimmed)
    const parsedStages = stages.map((st) => {
      const stageTrimmed = st.trim()
      const stageGroup = unwrapBalancedOuterGroup(stageTrimmed)
      const { words, unquotedText } = tokenizeShellWords(stageTrimmed)
      const { verb, args, envSplitScripts } = unwrapStageWords(words)
      return {
        raw: stageTrimmed,
        stageGroup,
        words,
        joinedWords: words.join(' '),
        unquotedText,
        verb,
        args,
        envSplitScripts,
      }
    })

    // 1. Cross-pipe execution:
    //    - Piping ANY command into a shell interpreter (`sh`, `bash`, `zsh`, `ash`, `dash`, `ksh`, `fish`, `eval`)
    //    - Piping `curl`/`wget` or `base64 -d` into any script/code interpreter (`python*`, `node`, `perl`, `ruby`, `php`)
    for (let j = 1; j < parsedStages.length; j++) {
      const downstream = parsedStages[j]!
      if (SHELL_DASH_C_VERBS.has(downstream.verb) || downstream.verb === 'eval') {
        return 'shell_remote_exec'
      }
    }
    for (let i = 0; i < parsedStages.length; i++) {
      const stage = parsedStages[i]!
      const isFetcher = stage.verb === 'curl' || stage.verb === 'wget'
      const isBase64Decode =
        stage.verb === 'base64' &&
        stage.args.some((a) => a === '-d' || a === '-D' || a === '--decode' || /^-[a-zA-Z]*[dD]/.test(a))

      if (isFetcher || isBase64Decode) {
        for (let j = i + 1; j < parsedStages.length; j++) {
          const downstream = parsedStages[j]!
          if (isInterpreterVerb(downstream.verb) || downstream.verb === 'eval') {
            return 'shell_remote_exec'
          }
        }
      }
    }

    // 2. Per-stage subshells, `env -S`, and verb/argument checks
    for (const stage of parsedStages) {
      if (stage.stageGroup.unwrapped) {
        const subHit = evaluateShellScript(stage.stageGroup.inner, depth + 1)
        if (subHit) return subHit
        continue
      }

      // Direct command-position `$(curl ...)` / `` `wget ...` `` execution
      if (/^(?:\$\(|`)/.test(stage.raw) && REMOTE_SUBST_FETCH_RE.test(stage.raw)) {
        return 'shell_remote_exec'
      }

      for (const envScript of stage.envSplitScripts) {
        const envHit = evaluateShellScript(envScript, depth + 1)
        if (envHit) return envHit
      }

      const stageHit = evaluateUnwrappedVerbAndArgs(
        stage.verb,
        stage.args,
        depth,
        stage.raw,
        stage.joinedWords,
        stage.unquotedText,
      )
      if (stageHit) return stageHit
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Browser action classification
// ---------------------------------------------------------------------------

type SensitiveUrlKind = 'purchase' | 'destructive' | 'external' | null

const PURCHASE_URL_PATH_RE = /(?:^|\/)(?:checkout|pay|payment|payments|billing)(?:\/|$)/i
const DESTRUCTIVE_URL_PATH_RE =
  /(?:^|\/)(?:delete|accountdelete|account-delete|close-account|security|settings\/tokens|settings\/keys|settings\/security|settings\/delete)(?:\/|$)/i
const TRANSFER_URL_PATH_RE = /(?:^|\/)(?:transfer|wire-transfer|send-money)(?:\/|$)/i

function classifySensitiveBrowserUrl(currentUrl?: string): SensitiveUrlKind {
  if (!currentUrl) return null
  try {
    const u = new URL(currentUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const host = u.hostname.toLowerCase()
    const path = u.pathname
    if (host.startsWith('checkout.') || host.startsWith('pay.') || PURCHASE_URL_PATH_RE.test(path)) {
      return 'purchase'
    }
    if (DESTRUCTIVE_URL_PATH_RE.test(path)) {
      return 'destructive'
    }
    if (TRANSFER_URL_PATH_RE.test(path)) {
      return 'external'
    }
    return null
  } catch {
    return null
  }
}

const READONLY_NAV_CLICK_RE =
  /^(?:payment\s+history|order\s+history|billing\s+history|billing\s+faq|pricing|view\s+details|learn\s+more|read\s+more|账单明细|订单记录|查看详情|已删除|删除记录)(?:\s*[→›»>])?$/i

const PURCHASE_CLICK_EN_RE =
  /\b(?:pay|pay\s+now|purchase|buy\s+now|place\s+order|place\s+your\s+order|complete\s+order|submit\s+order|checkout|proceed\s+to\s+checkout|confirm\s+payment|authorize\s+payment|subscribe|subscribe\s+now)\b/i
const PURCHASE_CLICK_ZH_RE = /(?:立即支付|确认支付|确认付款|立即付款|提交订单|立即购买|确认下单|确认订阅|开通会员|去结算|去付款)/
const PURCHASE_CLICK_ZH_EXACT_RE = /^(?:支付|付款|下单|结算)$/

const DESTRUCTIVE_CLICK_EN_RE =
  /\b(?:delete|delete\s+account|delete\s+repository|delete\s+project|remove\s+permanently|permanently\s+delete|empty\s+trash|revoke|revoke\s+token|revoke\s+key|terminate|destroy|close\s+account|transfer\s+ownership)\b/i
const DESTRUCTIVE_CLICK_ZH_RE =
  /(?:永久删除|确认删除|删除账号|注销账号|删除仓库|删除项目|清空回收站|清空已删除|吊销|销毁)/
const DESTRUCTIVE_CLICK_ZH_EXACT_RE = /^删除$/

const EXTERNAL_SUBMIT_EN_RE =
  /\b(?:send|send\s+email|send\s+message|send\s+invite|publish|publish\s+now|post\s+comment|post\s+reply|merge\s+pull\s+request|wire\s+transfer|confirm\s+transfer|submit\s+application)\b/i
const EXTERNAL_SUBMIT_ZH_RE = /(?:发送邮件|确认发送|立即发布|公开发布|公开提交|确认转账|发起转账|合并请求)/
const EXTERNAL_SUBMIT_ZH_EXACT_RE = /^(?:发送|发布|转账)$/

const GENERIC_SUBMIT_RE = /^(?:submit|confirm|continue|提交|确认)$/i
const CSS_SUBMIT_SELECTOR_RE = /\[type\s*=\s*["']?submit["']?\]|(?:^|[\s>+~])button:submit\b/i
const ENTER_KEY_CHORD_RE = /^(?:Enter|Return|NumpadEnter|(?:Meta|Control|Ctrl|Command|CmdOrCtrl)\+(?:Enter|Return))$/i

function matchBrowserTargetRisk(
  rawTarget: string,
  urlSensitivity: SensitiveUrlKind,
): { riskCode: GuardrailRiskCode; approvalKind: 'purchase' | 'other' } | null {
  const target = rawTarget.trim()
  if (!target) return null

  if (READONLY_NAV_CLICK_RE.test(target)) return null

  if (
    PURCHASE_CLICK_EN_RE.test(target) ||
    PURCHASE_CLICK_ZH_RE.test(target) ||
    PURCHASE_CLICK_ZH_EXACT_RE.test(target)
  ) {
    return { riskCode: 'browser_purchase_action', approvalKind: 'purchase' }
  }

  if (
    DESTRUCTIVE_CLICK_EN_RE.test(target) ||
    DESTRUCTIVE_CLICK_ZH_RE.test(target) ||
    DESTRUCTIVE_CLICK_ZH_EXACT_RE.test(target)
  ) {
    return { riskCode: 'browser_destructive_action', approvalKind: 'other' }
  }

  if (
    EXTERNAL_SUBMIT_EN_RE.test(target) ||
    EXTERNAL_SUBMIT_ZH_RE.test(target) ||
    EXTERNAL_SUBMIT_ZH_EXACT_RE.test(target)
  ) {
    return { riskCode: 'browser_external_submit', approvalKind: 'other' }
  }

  if (urlSensitivity !== null && (GENERIC_SUBMIT_RE.test(target) || CSS_SUBMIT_SELECTOR_RE.test(target))) {
    return urlSensitivityToRisk(urlSensitivity)
  }

  return null
}

function urlSensitivityToRisk(urlSensitivity: Exclude<SensitiveUrlKind, null>): {
  riskCode: GuardrailRiskCode
  approvalKind: 'purchase' | 'other'
} {
  if (urlSensitivity === 'purchase') {
    return { riskCode: 'browser_purchase_action', approvalKind: 'purchase' }
  }
  if (urlSensitivity === 'destructive') {
    return { riskCode: 'browser_destructive_action', approvalKind: 'other' }
  }
  return { riskCode: 'browser_external_submit', approvalKind: 'other' }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function evaluateComputerGuardrail(input: {
  tool: string
  args: Record<string, unknown>
  currentUrl?: string
  currentTitle?: string
}): GuardrailResult {
  if (!isGuardrailToolName(input.tool)) {
    return { blocked: false }
  }

  if (input.tool === 'shell') {
    const cmd = typeof input.args.cmd === 'string' ? input.args.cmd : ''
    if (!cmd.trim()) return { blocked: false }
    const riskCode = evaluateShellScript(cmd, 0)
    if (!riskCode) return { blocked: false }
    const formatted = formatGuardrailApprovalText({
      tool: 'shell',
      args: input.args,
      riskCode,
    })
    return {
      blocked: true,
      riskCode,
      approvalKind: 'other',
      ...formatted,
    }
  }

  const urlSensitivity = classifySensitiveBrowserUrl(input.currentUrl)

  if (input.tool === 'browser_click') {
    const target = String(input.args.target ?? '').trim()
    const matched = matchBrowserTargetRisk(target, urlSensitivity)
    if (!matched) return { blocked: false }
    const formatted = formatGuardrailApprovalText({
      tool: 'browser_click',
      args: input.args,
      riskCode: matched.riskCode,
      currentUrl: input.currentUrl,
    })
    return {
      blocked: true,
      riskCode: matched.riskCode,
      approvalKind: matched.approvalKind,
      ...formatted,
    }
  }

  if (input.tool === 'browser_type') {
    if (input.args.submit !== true) return { blocked: false }
    const target = String(input.args.target ?? '').trim()
    const matched =
      matchBrowserTargetRisk(target, urlSensitivity) ??
      (urlSensitivity !== null ? urlSensitivityToRisk(urlSensitivity) : null)
    if (!matched) return { blocked: false }
    const formatted = formatGuardrailApprovalText({
      tool: 'browser_type',
      args: input.args,
      riskCode: matched.riskCode,
      currentUrl: input.currentUrl,
    })
    return {
      blocked: true,
      riskCode: matched.riskCode,
      approvalKind: matched.approvalKind,
      ...formatted,
    }
  }

  // browser_press
  const key = String(input.args.key ?? '').trim()
  if (!ENTER_KEY_CHORD_RE.test(key) || urlSensitivity === null) {
    return { blocked: false }
  }
  const matched = urlSensitivityToRisk(urlSensitivity)
  const formatted = formatGuardrailApprovalText({
    tool: 'browser_press',
    args: input.args,
    riskCode: matched.riskCode,
    currentUrl: input.currentUrl,
  })
  return {
    blocked: true,
    riskCode: matched.riskCode,
    approvalKind: matched.approvalKind,
    ...formatted,
  }
}
