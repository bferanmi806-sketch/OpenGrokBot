import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { SCHEMA_VERSION, ensureDmThread, insertMessage, openDb, upsertBot } from '../src/db.js'
import { buildDiagnosticsBundle, redactSecrets, type DiagnosticsBundle } from '../src/diagnostics.js'
import type { AssistantTurn, LLM } from '../src/llm.js'
import { createApp } from '../src/server.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'osb-diag-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

const TOKEN = 'test-diag-token-0123456789abcdef'
const textTurn: AssistantTurn = { content: 'ok', toolCalls: [], raw: { role: 'assistant', content: 'ok' } }
const okLLM: LLM = { chat: async () => textTurn }

describe('redactSecrets', () => {
  it('redacts every supported secret family, PEM key, auth header, URL query, CLI flag, and JSON field', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB',
      'secretline1234567890==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')
    expect(redactSecrets(`Loaded key:\n${pem}\ndone`)).toBe('Loaded key:\n<hidden-private-key>\ndone')

    const samples: Array<[string, string]> = [
      ['Anthropic sk-ant-api03-secretAntKey123456', 'secretAntKey123456'],
      ['OpenAI proj sk-proj-secretProjKey123456', 'secretProjKey123456'],
      ['OpenAI svc sk-svcacct-secretSvcKey123456', 'secretSvcKey123456'],
      ['OpenAI classic sk-1234567890abcdefSECRET', '567890abcdefSECRET'],
      ['Gemini AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz123456', 'EfGhIjKlMnOpQrStUvWxYz123456'],
      ['Groq gsk_abcdefghijklmnopqrstuvwx9999', 'efghijklmnopqrstuvwx9999'],
      ['xAI short xai-12345678secret', '5678secret'],
      ['Composio cmp_secretComposio1234 and ak_secretComposioAk1234', 'secretComposio'],
      ['GitHub ghp_1234567890abcdef1234 gho_1234567890abcdef1234 ghs_1234567890abcdef1234 ghr_1234567890abcdef1234', '1234567890abcdef1234'],
      ['GitHub PAT github_pat_11ABCDEFG0123456789abcdef', '11ABCDEFG0123456789abcdef'],
      [`GitLab ${'glpat'}-secretGitlabToken12`, 'secretGitlabToken12'],
      [`Slack ${'xoxb'}-1234567890-abcdefghij and ${'xoxp'}-9876543210-zyxwvutsrq`, '1234567890-abcdefghij'],
      [`AWS ${'AKIA'}IOSFODNN7EXAMPLE and ${'ASIA'}IOSFODNN7EXAMPLE`, 'IOSFODNN7EXAMPLE'],
      [`HuggingFace ${'hf'}_abcdefghijklmnopqrstuvwx`, 'abcdefghijklmnopqrstuvwx'],
      [`Replicate ${'r8'}_abcdefghijklmnopqrstuvwx`, 'abcdefghijklmnopqrstuvwx'],
      [`Perplexity ${'pplx'}-abcdefghijklmnopqrstuvwx`, 'abcdefghijklmnopqrstuvwx'],
      [`Stripe ${'sk_live'}_abcdefghijklmnop and ${'rk_test'}_zyxwvutsrqponmlk`, 'abcdefghijklmnop'],
      ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.supersecret.sig', 'eyJhbGciOiJIUzI1NiJ9'],
      ['Proxy-Authorization: Basic dXNlcjpzdXBlcnNlY3JldA==', 'dXNlcjpzdXBlcnNlY3JldA=='],
      ['Standalone Bearer raw_bearer_secret_token_999', 'raw_bearer_secret_token_999'],
      ['X-API-Key: header_secret_value_123', 'header_secret_value_123'],
      ['X-Shim-Token: shim_secret_value_456', 'shim_secret_value_456'],
      ['Cookie: osb_session=cookie_secret_789; theme=dark', 'cookie_secret_789'],
      ['Set-Cookie: osb_session=set_cookie_secret_000; HttpOnly', 'set_cookie_secret_000'],
      [
        'https://example.com/cb?token=tok_val&api_key=ak_val&access_token=at_val&refresh_token=rt_val&client_secret=cs_val&secret=sec_val&password=pw_val&code=oauth_code&webhook_key=whk_val',
        'tok_val',
      ],
      ['cmd --token=cli_tok --api-key cli_ak -password cli_pw --webhook-key cli_whk', 'cli_tok'],
      [
        '{"apiKey":"json_ak","access_token":"json_at","refreshToken":"json_rt","client_secret":"json_cs","webhookKey":"json_whk","password":"json_pw","totpSecret":"JBSWY3DPEHPK3PXP","authorization":"Bearer json_auth"}',
        'JBSWY3DPEHPK3PXP',
      ],
    ]

    for (const [input, forbidden] of samples) {
      const out = redactSecrets(input)
      expect(out).not.toContain(forbidden)
      expect(out).toContain('<hidden>')
    }

    const urlOut = redactSecrets(
      'https://example.com/cb?token=tok_val&api_key=ak_val&access_token=at_val&refresh_token=rt_val&client_secret=cs_val&secret=sec_val&password=pw_val&code=oauth_code&webhook_key=whk_val',
    )
    for (const leaked of ['tok_val', 'ak_val', 'at_val', 'rt_val', 'cs_val', 'sec_val', 'pw_val', 'oauth_code', 'whk_val']) {
      expect(urlOut).not.toContain(leaked)
    }

    const cliOut = redactSecrets('cmd --token=cli_tok --api-key cli_ak -password cli_pw --webhook-key cli_whk')
    for (const leaked of ['cli_tok', 'cli_ak', 'cli_pw', 'cli_whk']) {
      expect(cliOut).not.toContain(leaked)
    }

    const jsonOut = redactSecrets(
      '{"apiKey":"json_ak","access_token":"json_at","refreshToken":"json_rt","client_secret":"json_cs","webhookKey":"json_whk","password":"json_pw","totpSecret":"JBSWY3DPEHPK3PXP","authorization":"Bearer json_auth"}',
    )
    for (const leaked of ['json_ak', 'json_at', 'json_rt', 'json_cs', 'json_whk', 'json_pw', 'JBSWY3DPEHPK3PXP', 'json_auth']) {
      expect(jsonOut).not.toContain(leaked)
    }
  })

  it('covers URL basic auth, broad Authorization headers, env/YAML/util.inspect keys, JWTs, Slack/Discord webhooks, dangling PEMs, and idempotency', () => {
    // 1. Basic Auth in URLs
    expect(redactSecrets('Connect to https://admin:urlBasicPass123!@db.example.com:5432/app and postgres://pguser:pgSecret99@localhost/db'))
      .toBe('Connect to https://admin:<hidden>@db.example.com:5432/app and postgres://pguser:<hidden>@localhost/db')

    // 2. Broad Authorization headers (Token, ApiKey, Digest, raw token without scheme, Bearer)
    expect(redactSecrets('Authorization: Token tok_header_secret_12345')).toBe('Authorization: Token <hidden>')
    expect(redactSecrets('Authorization: lin_api_rawHeaderSecret12345')).toBe('Authorization: <hidden>')
    expect(redactSecrets('Proxy-Authorization: Digest username="alice", response="digest_secret_hex"'))
      .toBe('Proxy-Authorization: Digest <hidden>')
    // Idempotency across multiple passes
    expect(redactSecrets(redactSecrets('Authorization: Bearer abcdefghijklmnop'))).toBe('Authorization: Bearer <hidden>')
    expect(redactSecrets(redactSecrets('Authorization: lin_api_rawHeaderSecret12345'))).toBe('Authorization: <hidden>')

    // 3. Env / .env / YAML / compound JSON & single-quoted util.inspect keys
    const envAndObj = [
      'OPENSUPERBOT_TOKEN=osb_env_token_secret_111',
      'OPENAI_API_KEY="sk_env_quoted_secret_222"',
      "WEBHOOK_KEY='whk_env_single_secret_333'",
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      '{"webhook_secret":"whsec_compound_444","auth_token":"atok_compound_555","private_key":"pkey_compound_666","signing_secret":"ssec_compound_777"}',
      "{ apiKey: 'inspect_ak_888', password: 'inspect_pw_999', clientSecret: 'inspect_cs_000' }",
      'webhook_secret: yaml_unquoted_secret_abc',
    ].join('\n')
    const redactedEnvObj = redactSecrets(redactSecrets(envAndObj))
    for (const leaked of [
      'osb_env_token_secret_111',
      'sk_env_quoted_secret_222',
      'whk_env_single_secret_333',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'whsec_compound_444',
      'atok_compound_555',
      'pkey_compound_666',
      'ssec_compound_777',
      'inspect_ak_888',
      'inspect_pw_999',
      'inspect_cs_000',
      'yaml_unquoted_secret_abc',
    ]) {
      expect(redactedEnvObj).not.toContain(leaked)
    }
    expect(redactedEnvObj).not.toContain('<hidden><hidden>')

    // 4. JWTs
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFsaWNlIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    expect(redactSecrets(`assertion=${jwt}`)).toBe('assertion=<hidden-jwt>')

    // 5. Slack & Discord Webhook URLs
    expect(redactSecrets('https://hooks.slack.com/services/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YZ'))
      .toBe('https://hooks.slack.com/services/T12345ABC/B67890DEF/<hidden>')
    expect(redactSecrets('https://discord.com/api/webhooks/123456789012345678/discordWebhookSecretToken_ABC-123'))
      .toBe('https://discord.com/api/webhooks/123456789012345678/<hidden>')
    expect(redactSecrets('https://ptb.discordapp.com/api/webhooks/987654321/ptbDiscordSecretToken'))
      .toBe('https://ptb.discordapp.com/api/webhooks/987654321/<hidden>')

    // Dangling PEM boundaries
    expect(redactSecrets('prefix\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU='))
      .toBe('prefix\n<hidden-private-key>')
    expect(redactSecrets('partialBase64Line12345==\n-----END RSA PRIVATE KEY-----\nsuffix'))
      .toBe('<hidden-private-key>\nsuffix')
  })

  it('redacts macOS, Linux, and Windows (backslash & forward-slash) home directory usernames only when redactHomePath is enabled', () => {
    const raw = 'Paths: /Users/alice/.opensuperbot/data and /home/ubuntu/logs/gateway.log and C:\\Users\\Bob\\AppData\\Local\\OpenSuperBot and C:/Users/Dana/AppData/Roaming/OpenSuperBot plus https://example.com/home/pricing'
    expect(redactSecrets(raw)).toBe(raw)

    const homeRedacted = redactSecrets(raw, { redactHomePath: true })
    expect(homeRedacted).toContain('~/.opensuperbot/data')
    expect(homeRedacted).toContain('~/logs/gateway.log')
    expect(homeRedacted).toContain('~\\AppData\\Local\\OpenSuperBot')
    expect(homeRedacted).toContain('~/AppData/Roaming/OpenSuperBot')
    expect(homeRedacted).not.toContain('alice')
    expect(homeRedacted).not.toContain('ubuntu')
    expect(homeRedacted).not.toContain('Bob')
    expect(homeRedacted).not.toContain('Dana')
    // Preserves normal web URLs that happen to have /home/ in their path
    expect(homeRedacted).toContain('https://example.com/home/pricing')
  })
})

describe('buildDiagnosticsBundle & GET /api/diagnostics', () => {
  it('handles a bare unmigrated SQLite database without throwing', () => {
    const bareDb = new Database(':memory:')
    const dataDir = '/Users/alice/.opensuperbot/data'
    const bundle = buildDiagnosticsBundle({
      db: bareDb,
      env: { OPENSUPERBOT_VERSION: '0.9.0' },
      startedWith: loadConfig({ OPENSUPERBOT_DATA: dataDir }),
    })
    expect(bundle.app.gatewayVersion).toBe('0.9.0')
    expect(bundle.app.dataDir).not.toContain('alice')
    expect(bundle.app.logFile).toBe('stdout')
    expect(bundle.subsystems.counts).toEqual({
      bots: 0,
      threads: 0,
      routines: 0,
      wikiPages: 0,
      pendingApprovals: 0,
      runningBackgroundTasks: 0,
    })
    expect(bundle.recentLogs).toEqual({ source: 'stdout', lineCount: 0, lines: [] })
    bareDb.close()
  })

  it('requires auth when gateway token is set, tails <= 200 lines from >128KB logs with redaction, and never leaks chat, wiki, or secret files', async () => {
    const dir = makeTempDir('osb-diag-e2e-')
    const logPath = join(dir, 'gateway.log')

    // Write secret files on disk that MUST NEVER be read into diagnostics
    writeFileSync(join(dir, 'llm-key'), 'sk-ant-api03-DISK_LLM_KEY_NEVER_READ\n')
    writeFileSync(join(dir, 'mcp-secrets.json'), JSON.stringify({ srv1: { env: { SECRET: 'DISK_MCP_SECRET_NEVER_READ' } } }))
    writeFileSync(join(dir, 'vault-secrets.json'), JSON.stringify({ v1: { password: 'DISK_VAULT_SECRET_NEVER_READ' } }))
    writeFileSync(join(dir, 'MEMORY.md'), '- TOP_SECRET_MEMORY_RULE_NEVER_EXPORT\n')

    // Create a > 128 KB log file (e.g. ~180 KB across 1600 lines), including a multi-line PEM private key near the end
    const logLines: string[] = []
    for (let i = 1; i <= 1600; i++) {
      const marker = i <= 200 ? 'EARLY_LOG_MARKER_SHOULD_NOT_APPEAR' : 'RECENT_LOG_ENTRY'
      if (i === 1590) {
        logLines.push(
          `2026-11-26T10:00:00.000Z [line-${i}] Key dump:`,
          '-----BEGIN RSA PRIVATE KEY-----',
          'MIIEowIBAAKCAQEA_PEM_LINE_ONE_SECRET_999999',
          'PEM_LINE_TWO_SECRET_BASE64_888888==',
          '-----END RSA PRIVATE KEY-----',
        )
        continue
      }
      const secret = i === 1595
        ? 'auth=sk-ant-api03-logSecretKey99887766 gh=ghp_logGithubToken1234567890 path=/Users/alice/Projects/app'
        : `padding=${'x'.repeat(85)}`
      logLines.push(`2026-11-26T10:00:00.000Z [line-${i}] ${marker} ${secret}`)
    }
    const rawLogContent = `${logLines.join('\n')}\n`
    expect(Buffer.byteLength(rawLogContent, 'utf8')).toBeGreaterThan(131072)
    writeFileSync(logPath, rawLogContent, 'utf8')

    const db = openDb(':memory:')
    upsertBot(db, { id: 'chief', name: 'Chief', role: 'lead', emoji: '🧭', soul_path: '' })
    const threadId = ensureDmThread(db, 'chief')

    // Seed sensitive chat message & wiki body
    insertMessage(db, {
      threadId,
      sender: 'user',
      kind: 'text',
      content: 'TOP_SECRET_CHAT_MESSAGE_NEVER_EXPORT my password is super-private-chat-text',
    })

    const now = Date.now()
    db.prepare(
      `INSERT INTO routines (bot_id, name, cron, instructions, enabled, webhook_key, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run('chief', 'Morning Check', '0 9 * * *', 'SECRET_ROUTINE_INSTRUCTIONS_DO_NOT_LEAK', 'whk_routine_secret_999', now)

    db.prepare(
      `INSERT INTO wiki_pages (id, kind, slug, title, summary, body, created_at, updated_at, archived_at)
       VALUES (?, 'project', 'alpha', 'Project Alpha', 'TOP_SECRET_WIKI_SUMMARY', 'TOP_SECRET_WIKI_BODY_NEVER_EXPORT', ?, ?, NULL)`,
    ).run('wiki-1', now, now)
    db.prepare(
      `INSERT INTO wiki_pages (id, kind, slug, title, summary, body, created_at, updated_at, archived_at)
       VALUES (?, 'project', 'old', 'Archived', 'old', 'TOP_SECRET_ARCHIVED_WIKI', ?, ?, ?)`,
    ).run('wiki-2', now, now, now)

    db.prepare(
      `INSERT INTO approvals (thread_id, bot_id, action, detail, status, created_at)
       VALUES (?, 'chief', 'Send private email', 'SECRET_APPROVAL_DETAIL_BODY', 'pending', ?)`,
    ).run(threadId, now)
    db.prepare(
      `INSERT INTO approvals (thread_id, bot_id, action, detail, status, created_at, resolved_at)
       VALUES (?, 'chief', 'Done item', 'resolved', 'approved', ?, ?)`,
    ).run(threadId, now - 1000, now)

    db.prepare(
      `INSERT INTO background_tasks (id, bot_id, thread_id, title, instructions, status, created_at)
       VALUES ('bg-1', 'chief', ?, 'Secret BG Title', 'SECRET_BG_INSTRUCTIONS', 'running', ?)`,
    ).run(threadId, now)
    db.prepare(
      `INSERT INTO background_tasks (id, bot_id, thread_id, title, instructions, status, created_at)
       VALUES ('bg-2', 'chief', ?, 'Done BG', 'done', 'completed', ?)`,
    ).run(threadId, now)

    db.prepare(
      `INSERT INTO mcp_servers (id, name, slug, transport, enabled, command, args_json, url, env_keys_json, header_keys_json, trust_read_only_hint, created_at, updated_at)
       VALUES ('mcp-1', 'GitHub MCP', 'github-mcp', 'http', 1, '/Users/alice/secret-cmd', '["--token=mcp_arg_secret_123"]', 'https://mcp.internal/sse?token=mcp_url_secret_456', '["GITHUB_TOKEN"]', '["Authorization"]', 0, ?, ?)`,
    ).run(now, now)

    db.prepare(
      `INSERT INTO connector_accounts (id, app, driver, remote_id, account_label, status, last_error, created_at, updated_at)
       VALUES ('conn-1', 'gmail', 'composio', 'ca_remote_secret_id_789', 'alice.personal@gmail.com', 'active', 'Bearer leaked_conn_err_token', ?, ?)`,
    ).run(now, now)

    // Seed actions: one recent shell failure (<24h), content-bearing tool failures (<24h), one older failure (>24h), and one recent success (ok=1)
    db.prepare(
      `INSERT INTO actions (bot_id, thread_id, trigger, tool, summary, ok, ms, created_at)
       VALUES ('chief', ?, 'user', 'shell', 'Failed with key sk-proj-actionSecret12345678 at /Users/alice/work', 0, 42, ?)`,
    ).run(threadId, now - 60_000)
    db.prepare(
      `INSERT INTO actions (bot_id, thread_id, trigger, tool, summary, ok, ms, created_at)
       VALUES ('chief', ?, 'user', 'message_user', 'SENSITIVE_MESSAGE_USER_SNIPPET_DO_NOT_LEAK', 0, 12, ?)`,
    ).run(threadId, now - 50_000)
    db.prepare(
      `INSERT INTO actions (bot_id, thread_id, trigger, tool, summary, ok, ms, created_at)
       VALUES ('chief', ?, 'user', 'wiki_patch', 'SENSITIVE_WIKI_PATCH_SNIPPET_DO_NOT_LEAK', 0, 15, ?)`,
    ).run(threadId, now - 40_000)
    db.prepare(
      `INSERT INTO actions (bot_id, thread_id, trigger, tool, summary, ok, ms, created_at)
       VALUES ('chief', ?, 'user', 'save_memory', 'SENSITIVE_SAVE_MEMORY_SNIPPET_DO_NOT_LEAK', 0, 11, ?)`,
    ).run(threadId, now - 35_000)
    db.prepare(
      `INSERT INTO actions (bot_id, thread_id, trigger, tool, summary, ok, ms, created_at)
       VALUES ('chief', ?, 'routine', 'shell', 'OLD_48H_ERROR_SHOULD_NOT_APPEAR', 0, 10, ?)`,
    ).run(threadId, now - 48 * 3600_000)
    db.prepare(
      `INSERT INTO actions (bot_id, thread_id, trigger, tool, summary, ok, ms, created_at)
       VALUES ('chief', ?, 'user', 'read_file', 'RECENT_OK_ACTION_SHOULD_NOT_APPEAR', 1, 5, ?)`,
    ).run(threadId, now - 30_000)

    const env = {
      OPENSUPERBOT_VERSION: '1.2.3',
      OPENSUPERBOT_LOG_FILE: logPath,
    }
    const startedWith = loadConfig({ OPENSUPERBOT_DATA: dir, OPENSUPERBOT_PORT: '4848' })
    const { app } = createApp({
      db,
      llm: okLLM,
      token: TOKEN,
      settings: { env, startedWith },
    })

    // Seed active background task after createApp startup orphan recovery
    db.prepare(
      `INSERT INTO background_tasks (id, bot_id, thread_id, title, instructions, status, created_at)
       VALUES ('bg-live', 'chief', ?, 'Secret Live BG Title', 'SECRET_BG_INSTRUCTIONS', 'running', ?)`,
    ).run(threadId, now)

    // 1. Unauthenticated request MUST be rejected with 401
    const unauthRes = await app.request('/api/diagnostics')
    expect(unauthRes.status).toBe(401)

    // 2. Authenticated request returns redacted DiagnosticsBundle
    const res = await app.request('/api/diagnostics', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    const bundle = (await res.json()) as DiagnosticsBundle

    expect(bundle.app.gatewayVersion).toBe('1.2.3')
    expect(bundle.app.schemaVersion).toBe(SCHEMA_VERSION)
    expect(bundle.app.port).toBe(4848)
    expect(bundle.app.runtime.node).toBe(process.versions.node)
    expect(bundle.app.runtime.release).toBeTruthy()

    expect(bundle.subsystems.counts).toEqual({
      bots: 1,
      threads: 1,
      routines: 1,
      wikiPages: 1,
      pendingApprovals: 1,
      runningBackgroundTasks: 1,
    })

    expect(bundle.subsystems.mcpServers).toEqual([
      { name: 'GitHub MCP', transport: 'http', policy: 'default-write', enabled: true },
    ])
    expect(bundle.subsystems.connectors).toEqual([
      { provider: 'gmail', status: 'active' },
    ])

    expect(bundle.subsystems.recentActionErrors24h).toHaveLength(4)
    const byTool = Object.fromEntries(bundle.subsystems.recentActionErrors24h.map((e) => [e.tool, e.summary]))
    expect(byTool.message_user).toBe('<redacted>')
    expect(byTool.wiki_patch).toBe('<redacted>')
    expect(byTool.save_memory).toBe('<redacted>')
    expect(byTool.shell).toContain('<hidden>')
    expect(byTool.shell).not.toContain('actionSecret12345678')
    expect(byTool.shell).not.toContain('alice')

    expect(bundle.recentLogs.lineCount).toBe(200)
    expect(bundle.recentLogs.lines).toHaveLength(200)
    expect(bundle.recentLogs.lines).toContain('<hidden-private-key>')
    expect(bundle.recentLogs.lines[199]).toContain('[line-1600]')

    expect(bundle.summaryText).toContain('OpenSuperBot')
    expect(bundle.summaryText).toContain('1.2.3')
    expect(bundle.summaryText).toContain('[line-1600]')

    const serialized = JSON.stringify(bundle)
    const forbiddenSubstrings = [
      'TOP_SECRET_CHAT_MESSAGE_NEVER_EXPORT',
      'super-private-chat-text',
      'TOP_SECRET_WIKI_SUMMARY',
      'TOP_SECRET_WIKI_BODY_NEVER_EXPORT',
      'TOP_SECRET_ARCHIVED_WIKI',
      'TOP_SECRET_MEMORY_RULE_NEVER_EXPORT',
      'DISK_LLM_KEY_NEVER_READ',
      'DISK_MCP_SECRET_NEVER_READ',
      'DISK_VAULT_SECRET_NEVER_READ',
      'SECRET_ROUTINE_INSTRUCTIONS_DO_NOT_LEAK',
      'whk_routine_secret_999',
      'SECRET_APPROVAL_DETAIL_BODY',
      'SECRET_BG_INSTRUCTIONS',
      'mcp_arg_secret_123',
      'mcp_url_secret_456',
      'ca_remote_secret_id_789',
      'alice.personal@gmail.com',
      'leaked_conn_err_token',
      'OLD_48H_ERROR_SHOULD_NOT_APPEAR',
      'RECENT_OK_ACTION_SHOULD_NOT_APPEAR',
      'EARLY_LOG_MARKER_SHOULD_NOT_APPEAR',
      'MIIEowIBAAKCAQEA_PEM_LINE_ONE_SECRET_999999',
      'PEM_LINE_TWO_SECRET_BASE64_888888',
      'SENSITIVE_MESSAGE_USER_SNIPPET_DO_NOT_LEAK',
      'SENSITIVE_WIKI_PATCH_SNIPPET_DO_NOT_LEAK',
      'SENSITIVE_SAVE_MEMORY_SNIPPET_DO_NOT_LEAK',
      'logSecretKey99887766',
      'logGithubToken1234567890',
      '/Users/alice',
    ]
    for (const secret of forbiddenSubstrings) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('sanitizes split UTF-8 replacement chars and lone low surrogates on >128KB single-line logs without newlines', () => {
    const dir = makeTempDir('osb-diag-singleline-')
    const logPath = join(dir, 'gateway.log')
    // Prefix 1 ASCII byte and suffix 1 ASCII byte around 40,000 4-byte emojis (160,002 bytes > 128 KB)
    // so BOTH the 128 KB byte-offset cut AND the -4000 UTF-16 code-unit slice split mid-character!
    const singleLine = `a${'🚀'.repeat(40_000)}b`
    expect(Buffer.byteLength(singleLine, 'utf8')).toBe(160_002)
    writeFileSync(logPath, singleLine, 'utf8')

    const db = openDb(':memory:')
    const bundle = buildDiagnosticsBundle({
      db,
      env: { OPENSUPERBOT_LOG_FILE: logPath },
      startedWith: loadConfig({ OPENSUPERBOT_DATA: dir }),
    })
    expect(bundle.recentLogs.lineCount).toBe(1)
    const line = bundle.recentLogs.lines[0]!
    expect(line.length).toBeGreaterThan(0)
    expect(line.length).toBeLessThanOrEqual(4000)
    expect(line.startsWith('\uFFFD')).toBe(false)
    const firstCode = line.charCodeAt(0)
    expect(firstCode < 0xDC00 || firstCode > 0xDFFF).toBe(true)
    db.close()
  })
})
