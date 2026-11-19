import { describe, expect, it } from 'vitest'
import { createComposioDriver } from '../src/connectors/composio-driver.js'
import { ConnectorDriverError, type ConnectorAccountRow } from '../src/connectors/types.js'

const makeAccount = (
  app: ConnectorAccountRow['app'],
  overrides: Partial<ConnectorAccountRow> = {},
): ConnectorAccountRow => ({
  id: 'ca-11112222',
  app,
  driver: 'composio',
  remote_id: `ca_${app}_1`,
  auth_config_id: `ac_${app}`,
  account_label: `${app}@acme.com`,
  status: 'active',
  last_error: '',
  notified_expired: 0,
  created_at: 1,
  updated_at: 1,
  ...overrides,
})

const gmailAcc = makeAccount('gmail', { account_label: 'alice@gmail.com' })
const outlookAcc = makeAccount('outlook', { id: 'ca-22223333', account_label: 'alice@outlook.com' })
const gcalAcc = makeAccount('google_calendar', { id: 'ca-33334444', account_label: 'alice@gmail.com' })
const ocalAcc = makeAccount('outlook_calendar', { id: 'ca-44445555', account_label: 'alice@outlook.com' })
const notionAcc = makeAccount('notion', { id: 'ca-55556666', account_label: 'Acme Workspace' })
const slackAcc = makeAccount('slack', { id: 'ca-66667777', account_label: 'Acme (alice)' })

describe('composio-driver', () => {
  it('checks configured/testKey state, creates or reuses managed auth config, creates OAuth link, and revokes accounts', async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = []
    let hasExistingAuthConfig = false

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, headers, body })

      if (headers['x-api-key'] === 'bad_key') {
        return new Response('unauthorized', { status: 401 })
      }
      if (url.includes('/api/v3.1/auth_configs?limit=1')) {
        return Response.json({ items: [] })
      }
      if (url.includes('/api/v3.1/auth_configs?')) {
        return Response.json({
          items: hasExistingAuthConfig
            ? [{ id: 'ac_reused_9', name: 'opensuperbot-gmail', auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED' }]
            : [],
          next_cursor: '',
        })
      }
      if (url.endsWith('/api/v3.1/auth_configs') && method === 'POST') {
        return Response.json({
          toolkit: { slug: 'gmail' },
          auth_config: { id: 'ac_new_1', name: 'opensuperbot-gmail', auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED' },
        })
      }
      if (url.endsWith('/api/v3.1/connected_accounts/link') && method === 'POST') {
        return Response.json({
          connected_account_id: 'ca_gmail_1',
          redirect_url: 'https://backend.composio.dev/authorize/xyz',
          expires_at: '2026-11-19T08:00:00Z',
        })
      }
      if (url.endsWith('/api/v3.1/connected_accounts/ca_gmail_1') && method === 'GET') {
        return Response.json({ status: 'ACTIVE', is_disabled: false, toolkit: { slug: 'gmail' } })
      }
      if (url.endsWith('/api/v3.1/connected_accounts/ca_gmail_1') && method === 'DELETE') {
        return Response.json({ deleted: true })
      }
      if (url.endsWith('/api/v3.1/tools/execute/proxy')) {
        return Response.json({ status: 200, data: { emailAddress: 'Alice@Gmail.com', historyId: '99' }, headers: {} })
      }
      return new Response('not found', { status: 404 })
    }

    let apiKey = ''
    const driver = createComposioDriver({
      getApiKey: () => apiKey,
      getBaseUrl: () => 'https://backend.composio.dev///',
      fetchImpl: fakeFetch,
    })

    expect(driver.id).toBe('composio')
    expect(driver.configured()).toBe(false)
    expect(await driver.testKey()).toMatchObject({ ok: false, code: 'unconfigured' })
    expect(await driver.testKey('bad_key')).toMatchObject({ ok: false, code: 'unauthorized' })

    apiKey = 'cmp_test_key'
    expect(driver.configured()).toBe(true)
    expect(await driver.testKey()).toEqual({ ok: true })

    // First startOAuth creates managed auth config
    const link1 = await driver.startOAuth({
      app: 'gmail',
      callbackUrl: 'http://127.0.0.1:4747/oauth/connector/n1',
      userKey: 'opensuperbot',
    })
    expect(link1).toEqual({
      authConfigId: 'ac_new_1',
      remoteId: 'ca_gmail_1',
      redirectUrl: 'https://backend.composio.dev/authorize/xyz',
    })
    expect(calls.every((c) => c.headers['content-type'] === 'application/json')).toBe(true)

    // Second startOAuth reuses existing managed auth config without POSTing /auth_configs
    hasExistingAuthConfig = true
    const postAuthBefore = calls.filter((c) => c.url.endsWith('/api/v3.1/auth_configs') && c.method === 'POST').length
    const link2 = await driver.startOAuth({
      app: 'gmail',
      callbackUrl: 'http://127.0.0.1:4747/oauth/connector/n2',
      userKey: 'opensuperbot',
    })
    const postAuthAfter = calls.filter((c) => c.url.endsWith('/api/v3.1/auth_configs') && c.method === 'POST').length
    expect(link2.authConfigId).toBe('ac_reused_9')
    expect(postAuthAfter).toBe(postAuthBefore)

    const inspected = await driver.inspectAccount({ app: 'gmail', remoteId: 'ca_gmail_1' })
    expect(inspected).toEqual({ status: 'active', accountLabel: 'alice@gmail.com' })

    await driver.revokeAccount({ remoteId: 'ca_gmail_1' })
    expect(calls.some((c) => c.url.endsWith('/api/v3.1/connected_accounts/ca_gmail_1') && c.method === 'DELETE')).toBe(true)
  })

  it('resolves identity labels across all 6 apps and falls back cleanly when narrow OAuth scopes fail identity lookup', async () => {
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/api/v3.1/connected_accounts/')) {
        if (url.endsWith('/ca_exp_1')) return Response.json({ status: 'EXPIRED', is_disabled: false })
        if (url.endsWith('/ca_pend_1')) return Response.json({ status: 'INITIATED', is_disabled: false })
        return Response.json({ status: 'ACTIVE', is_disabled: false })
      }
      if (url.endsWith('/api/v3.1/tools/execute/proxy')) {
        const req = JSON.parse(String(init?.body ?? '{}'))
        if (req.connected_account_id === 'ca_narrow_1234567890') {
          return Response.json({ status: 403, data: { error: 'insufficientPermissions' }, headers: {} })
        }
        if (req.connected_account_id === 'ca_empty_label_9999') {
          return Response.json({ status: 200, data: {}, headers: {} })
        }
        if (req.endpoint === '/v1.0/me') {
          return Response.json({ status: 200, data: { userPrincipalName: 'Alice.Work@Contoso.com' }, headers: {} })
        }
        if (req.endpoint === '/users/me/calendarList/primary') {
          return Response.json({ status: 200, data: { summary: 'Team Calendar', id: 'team@acme.com' }, headers: {} })
        }
        if (req.endpoint === '/v1/users/me') {
          return Response.json({ status: 200, data: { bot: { workspace_name: 'Acme HQ' } }, headers: {} })
        }
        if (req.endpoint === '/api/auth.test') {
          return Response.json({ status: 200, data: { ok: true, team: 'Acme Slack', user: 'alice' }, headers: {} })
        }
      }
      return new Response('not found', { status: 404 })
    }

    const driver = createComposioDriver({ getApiKey: () => 'cmp_test', fetchImpl: fakeFetch })
    expect(await driver.inspectAccount({ app: 'outlook', remoteId: 'ca_out_1' })).toEqual({
      status: 'active',
      accountLabel: 'alice.work@contoso.com',
    })
    expect(await driver.inspectAccount({ app: 'outlook_calendar', remoteId: 'ca_ocal_1' })).toEqual({
      status: 'active',
      accountLabel: 'alice.work@contoso.com',
    })
    expect(await driver.inspectAccount({ app: 'google_calendar', remoteId: 'ca_gcal_1' })).toEqual({
      status: 'active',
      accountLabel: 'Team Calendar',
    })
    expect(await driver.inspectAccount({ app: 'notion', remoteId: 'ca_not_1' })).toEqual({
      status: 'active',
      accountLabel: 'Acme HQ',
    })
    expect(await driver.inspectAccount({ app: 'slack', remoteId: 'ca_slk_1' })).toEqual({
      status: 'active',
      accountLabel: 'Acme Slack (alice)',
    })

    // Narrow OAuth scopes returning 403 or omitting label still succeed with deterministic fallback
    expect(await driver.inspectAccount({ app: 'gmail', remoteId: 'ca_narrow_1234567890' })).toEqual({
      status: 'active',
      accountLabel: 'Gmail (ca_narro)',
    })
    expect(await driver.inspectAccount({ app: 'notion', remoteId: 'ca_empty_label_9999' })).toEqual({
      status: 'active',
      accountLabel: 'Notion (ca_empty)',
    })

    // Non-active upstream states
    expect((await driver.inspectAccount({ app: 'gmail', remoteId: 'ca_exp_1' })).status).toBe('expired')
    expect((await driver.inspectAccount({ app: 'gmail', remoteId: 'ca_pend_1' })).status).toBe('pending')
  })

  it('lists, reads, drafts, sends, replies, and archives Gmail messages with MIME + sanitization', async () => {
    const proxyRequests: any[] = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      proxyRequests.push(body)

      if (body.endpoint === '/gmail/v1/users/me/messages' && body.method === 'GET') {
        return Response.json({
          status: 200,
          data: { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'tok_2' },
          headers: {},
        })
      }
      if (body.endpoint === '/gmail/v1/users/me/messages/m1' && body.method === 'GET') {
        const htmlB64 = Buffer.from(
          '<p>Code: 482910. Visit https://acme.com/quote?id=7&utm_source=email</p>',
          'utf8',
        ).toString('base64url')
        return Response.json({
          status: 200,
          data: {
            id: 'm1',
            threadId: 't1',
            labelIds: ['INBOX', 'UNREAD'],
            snippet: 'Need quote',
            payload: {
              headers: [
                { name: 'From', value: 'Bob <bob@client.com>' },
                { name: 'Reply-To', value: 'Billing <billing@client.com>' },
                { name: 'To', value: 'alice@gmail.com' },
                { name: 'Cc', value: 'carol@client.com' },
                { name: 'Subject', value: 'Your verification code & Revised quote' },
                { name: 'Date', value: 'Thu, 19 Nov 2026 10:00:00 +0000' },
                { name: 'Message-ID', value: '<msg-1@client.com>' },
              ],
              parts: [
                { mimeType: 'text/html', body: { data: htmlB64 } },
                { mimeType: 'application/pdf', filename: 'quote.pdf', body: { attachmentId: 'att_1', size: 2048 } },
              ],
            },
          },
          headers: {},
        })
      }
      if (body.endpoint === '/gmail/v1/users/me/messages/m2' && body.method === 'GET') {
        return Response.json({
          status: 200,
          data: {
            id: 'm2',
            threadId: 't2',
            labelIds: ['INBOX'],
            snippet: 'Automated build',
            payload: { headers: [{ name: 'From', value: 'noreply@github.com' }, { name: 'Subject', value: 'CI' }] },
          },
          headers: {},
        })
      }
      if (body.endpoint === '/gmail/v1/users/me/threads/t1' && body.method === 'GET') {
        return Response.json({
          status: 200,
          data: {
            id: 't1',
            messages: [{
              id: 'm1',
              threadId: 't1',
              labelIds: ['INBOX'],
              payload: {
                headers: [{ name: 'From', value: 'bob@client.com' }, { name: 'Subject', value: 'Thread msg' }],
                body: { data: Buffer.from('Plain hello', 'utf8').toString('base64url') },
              },
            }],
          },
          headers: {},
        })
      }
      if (body.endpoint === '/gmail/v1/users/me/drafts/d1' && body.method === 'GET') {
        return Response.json({
          status: 200,
          data: {
            id: 'd1',
            message: {
              id: 'md1',
              payload: {
                headers: [
                  { name: 'To', value: 'bob@client.com' },
                  { name: 'Bcc', value: 'audit@acme.com' },
                  { name: 'Subject', value: 'Draft Subj' },
                ],
                body: { data: Buffer.from('Draft body', 'utf8').toString('base64url') },
              },
            },
          },
          headers: {},
        })
      }
      if (body.endpoint === '/gmail/v1/users/me/drafts' && body.method === 'POST') {
        return Response.json({ status: 200, data: { id: 'draft_created_1' }, headers: {} })
      }
      if (body.endpoint === '/gmail/v1/users/me/drafts/draft_created_1' && body.method === 'PUT') {
        return Response.json({ status: 200, data: { id: 'draft_created_1' }, headers: {} })
      }
      if (body.endpoint === '/gmail/v1/users/me/messages/send' && body.method === 'POST') {
        return Response.json({ status: 200, data: { id: 'sent_1', threadId: 't1' }, headers: {} })
      }
      if (body.endpoint === '/gmail/v1/users/me/drafts/send' && body.method === 'POST') {
        return Response.json({ status: 200, data: { id: 'sent_from_draft_1' }, headers: {} })
      }
      if (body.endpoint === '/gmail/v1/users/me/messages/m1/modify' && body.method === 'POST') {
        return Response.json({ status: 200, data: { id: 'm1', labelIds: [] }, headers: {} })
      }
      return Response.json({ status: 404, data: {}, headers: {} })
    }

    const driver = createComposioDriver({ getApiKey: () => 'cmp_test', fetchImpl: fakeFetch })

    // List filters automated by default, includes when requested
    const listed = await driver.listMail(gmailAcc, { folder: 'inbox', unread: true, query: 'quote' })
    expect(listed.nextCursor).toBe('tok_2')
    expect(listed.messages).toHaveLength(1)
    expect(listed.messages[0]).toMatchObject({
      id: 'm1',
      subject: 'Your verification code & Revised quote',
      unread: true,
      automated: false,
    })
    const listedAll = await driver.listMail(gmailAcc, { folder: 'inbox', includeAutomated: true })
    expect(listedAll.messages).toHaveLength(2)

    // Read message (sanitizes HTML, strips utm_source, redacts OTP, extracts attachment & Reply-To)
    const detail = await driver.readMail(gmailAcc, { messageId: 'm1' })
    expect(detail.messages[0]).toMatchObject({
      id: 'm1',
      replyTo: ['Billing <billing@client.com>'],
      body: 'Code: [redacted-otp]. Visit https://acme.com/quote?id=7',
      attachments: [{ id: 'att_1', name: 'quote.pdf', size: 2048 }],
    })

    // Read thread and draft
    expect((await driver.readMail(gmailAcc, { threadId: 't1' })).messages[0]!.body).toBe('Plain hello')
    const draftRead = await driver.readMail(gmailAcc, { draftId: 'd1' })
    expect(draftRead.draftId).toBe('d1')
    expect(draftRead.messages[0]!.bcc).toEqual(['audit@acme.com'])

    // Create & update draft with UTF-8 RFC 2047 subject
    const createdDraft = await driver.createOrUpdateDraft(gmailAcc, {
      to: ['bob@client.com'],
      subject: '报价单 2026',
      body: '请查收报价。',
    })
    expect(createdDraft.draftId).toBe('draft_created_1')
    const rawDraftReq = proxyRequests.find((r) => r.endpoint === '/gmail/v1/users/me/drafts')
    const decodedMime = Buffer.from(rawDraftReq.body.message.raw, 'base64url').toString('utf8')
    expect(decodedMime).toContain('Subject: =?UTF-8?B?')
    expect(decodedMime).toContain('请查收报价。')

    await driver.createOrUpdateDraft(gmailAcc, {
      draftId: 'draft_created_1',
      to: ['bob@client.com'],
      subject: 'Updated Quote',
      body: 'Updated text',
    })

    // Send direct, send draft, replyAll (setting threadId + In-Reply-To), and archive
    const sentDirect = await driver.executeWrite({
      version: 1, connectorId: gmailAcc.id, remoteId: gmailAcc.remote_id, app: 'gmail',
      accountLabel: gmailAcc.account_label, tool: 'mail_send',
      args: { to: ['bob@client.com'], subject: 'Hi', body: 'Hello' }, operationId: 'op-1',
    })
    expect(sentDirect.status).toBe('succeeded')

    const sentDraft = await driver.executeWrite({
      version: 1, connectorId: gmailAcc.id, remoteId: gmailAcc.remote_id, app: 'gmail',
      accountLabel: gmailAcc.account_label, tool: 'mail_send',
      args: { draftId: 'd1' }, operationId: 'op-2',
    })
    expect(sentDraft.status).toBe('succeeded')

    const replied = await driver.executeWrite({
      version: 1, connectorId: gmailAcc.id, remoteId: gmailAcc.remote_id, app: 'gmail',
      accountLabel: gmailAcc.account_label, tool: 'mail_reply',
      args: { messageId: 'm1', body: 'Approved!', replyAll: true }, operationId: 'op-3',
    })
    expect(replied.status).toBe('succeeded')
    const replySendReq = proxyRequests.filter((r) => r.endpoint === '/gmail/v1/users/me/messages/send').at(-1)
    expect(replySendReq.body.threadId).toBe('t1')
    const replyMime = Buffer.from(replySendReq.body.raw, 'base64url').toString('utf8')
    expect(replyMime).toContain('In-Reply-To: <msg-1@client.com>')
    expect(replyMime).toContain('carol@client.com')

    const archived = await driver.executeWrite({
      version: 1, connectorId: gmailAcc.id, remoteId: gmailAcc.remote_id, app: 'gmail',
      accountLabel: gmailAcc.account_label, tool: 'mail_archive',
      args: { messageId: 'm1' }, operationId: 'op-4',
    })
    expect(archived.status).toBe('succeeded')
  })

  it('lists, reads, drafts, sends, replies, and archives Outlook messages via Microsoft Graph', async () => {
    const proxyRequests: any[] = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      proxyRequests.push(body)

      if (body.endpoint === '/v1.0/me/mailFolders/inbox/messages' && body.method === 'GET') {
        return Response.json({
          status: 200,
          data: {
            value: [
              {
                id: 'om1',
                conversationId: 'oc1',
                subject: 'Contract review',
                bodyPreview: 'Please review',
                isRead: false,
                receivedDateTime: '2026-11-19T10:00:00Z',
                from: { emailAddress: { name: 'Dana', address: 'dana@partner.com' } },
                toRecipients: [{ emailAddress: { address: 'alice@outlook.com' } }],
                internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'no' }],
              },
              {
                id: 'om2',
                subject: 'Newsletter',
                bodyPreview: 'Unsubscribe',
                isRead: true,
                from: { emailAddress: { address: 'no-reply@news.com' } },
                toRecipients: [],
              },
            ],
          },
          headers: {},
        })
      }
      if (body.endpoint === '/v1.0/me/messages/om1' && body.method === 'GET') {
        return Response.json({
          status: 200,
          data: {
            id: 'om1',
            conversationId: 'oc1',
            subject: 'Contract review',
            receivedDateTime: '2026-11-19T10:00:00Z',
            from: { emailAddress: { name: 'Dana', address: 'dana@partner.com' } },
            replyTo: [{ emailAddress: { name: 'Legal Desk', address: 'legal@partner.com' } }],
            toRecipients: [{ emailAddress: { address: 'alice@outlook.com' } }],
            ccRecipients: [],
            body: { contentType: 'html', content: '<p>See https://partner.com/doc?fbclid=123</p>' },
            attachments: [{ id: 'oa1', name: 'contract.docx', size: 1024 }],
          },
          headers: {},
        })
      }
      if (body.endpoint === '/v1.0/me/messages' && body.method === 'POST') {
        return Response.json({ status: 201, data: { id: 'odraft_1' }, headers: {} })
      }
      if (body.endpoint === '/v1.0/me/messages/odraft_1' && body.method === 'PATCH') {
        return Response.json({ status: 200, data: { id: 'odraft_1' }, headers: {} })
      }
      if (body.endpoint === '/v1.0/me/sendMail' && body.method === 'POST') {
        return Response.json({ status: 202, data: {}, headers: {} })
      }
      if (body.endpoint === '/v1.0/me/messages/odraft_1/send' && body.method === 'POST') {
        return Response.json({ status: 202, data: {}, headers: {} })
      }
      if (body.endpoint === '/v1.0/me/messages/om1/replyAll' && body.method === 'POST') {
        return Response.json({ status: 202, data: {}, headers: {} })
      }
      if (body.endpoint === '/v1.0/me/messages/om1/move' && body.method === 'POST') {
        return Response.json({ status: 201, data: { id: 'om1_archived' }, headers: {} })
      }
      return Response.json({ status: 404, data: {}, headers: {} })
    }

    const driver = createComposioDriver({ getApiKey: () => 'cmp_test', fetchImpl: fakeFetch })

    const listed = await driver.listMail(outlookAcc, { folder: 'inbox' })
    expect(listed.messages).toHaveLength(1)
    expect(listed.messages[0]).toMatchObject({ id: 'om1', from: 'Dana <dana@partner.com>', unread: true })

    const read = await driver.readMail(outlookAcc, { messageId: 'om1' })
    expect(read.messages[0]!.replyTo).toEqual(['Legal Desk <legal@partner.com>'])
    expect(read.messages[0]!.body).toBe('See https://partner.com/doc')
    expect(read.messages[0]!.attachments).toEqual([{ id: 'oa1', name: 'contract.docx', size: 1024 }])

    const draft = await driver.createOrUpdateDraft(outlookAcc, {
      to: ['Dana <dana@partner.com>'],
      subject: 'Draft',
      body: 'Hello Dana',
    })
    expect(draft.draftId).toBe('odraft_1')
    await driver.createOrUpdateDraft(outlookAcc, {
      draftId: 'odraft_1',
      to: ['dana@partner.com'],
      subject: 'Draft v2',
      body: 'Updated',
    })

    expect((await driver.executeWrite({
      version: 1, connectorId: outlookAcc.id, remoteId: outlookAcc.remote_id, app: 'outlook',
      accountLabel: outlookAcc.account_label, tool: 'mail_send',
      args: { to: ['dana@partner.com'], subject: 'Hi', body: 'Direct' }, operationId: 'op-o1',
    })).status).toBe('succeeded')

    expect((await driver.executeWrite({
      version: 1, connectorId: outlookAcc.id, remoteId: outlookAcc.remote_id, app: 'outlook',
      accountLabel: outlookAcc.account_label, tool: 'mail_send',
      args: { draftId: 'odraft_1' }, operationId: 'op-o2',
    })).status).toBe('succeeded')

    expect((await driver.executeWrite({
      version: 1, connectorId: outlookAcc.id, remoteId: outlookAcc.remote_id, app: 'outlook',
      accountLabel: outlookAcc.account_label, tool: 'mail_reply',
      args: { messageId: 'om1', body: 'Looks good', replyAll: true }, operationId: 'op-o3',
    })).status).toBe('succeeded')

    expect((await driver.executeWrite({
      version: 1, connectorId: outlookAcc.id, remoteId: outlookAcc.remote_id, app: 'outlook',
      accountLabel: outlookAcc.account_label, tool: 'mail_archive',
      args: { messageId: 'om1' }, operationId: 'op-o4',
    })).status).toBe('succeeded')
    expect(proxyRequests.find((r) => r.endpoint === '/v1.0/me/messages/om1/move').body).toEqual({
      destinationId: 'archive',
    })
  })

  it('lists, creates, and updates events on both Google Calendar and Outlook Calendar', async () => {
    const proxyRequests: any[] = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      proxyRequests.push(body)

      if (body.endpoint === '/calendars/primary/events' && body.method === 'GET') {
        return Response.json({
          status: 200,
          data: {
            items: [{
              id: 'ge1',
              summary: 'Design Sync',
              start: { dateTime: '2026-11-20T17:00:00Z' },
              end: { dateTime: '2026-11-20T17:30:00Z' },
              location: 'Meet',
              attendees: [{ email: 'bob@acme.com' }],
              status: 'confirmed',
            }],
          },
          headers: {},
        })
      }
      if (body.endpoint === '/calendars/primary/events' && body.method === 'POST') {
        return Response.json({ status: 200, data: { id: 'ge_new' }, headers: {} })
      }
      if (body.endpoint === '/calendars/primary/events/ge1' && body.method === 'PATCH') {
        return Response.json({ status: 200, data: { id: 'ge1' }, headers: {} })
      }
      if (body.endpoint === '/v1.0/me/calendarView' && body.method === 'GET') {
        return Response.json({
          status: 200,
          data: {
            value: [{
              id: 'oe1',
              subject: 'Board Prep',
              start: { dateTime: '2026-11-21T09:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2026-11-21T10:00:00.0000000', timeZone: 'UTC' },
              location: { displayName: 'Room 4B' },
              attendees: [{ emailAddress: { address: 'exec@acme.com' } }],
              showAs: 'busy',
            }],
          },
          headers: {},
        })
      }
      if (body.endpoint === '/v1.0/me/events' && body.method === 'POST') {
        return Response.json({ status: 201, data: { id: 'oe_new' }, headers: {} })
      }
      if (body.endpoint === '/v1.0/me/events/oe1' && body.method === 'PATCH') {
        return Response.json({ status: 200, data: { id: 'oe1' }, headers: {} })
      }
      return Response.json({ status: 404, data: {}, headers: {} })
    }

    const driver = createComposioDriver({ getApiKey: () => 'cmp_test', fetchImpl: fakeFetch })

    const gEvents = await driver.listCalendarEvents(gcalAcc, {
      start: '2026-11-20T00:00:00Z',
      end: '2026-11-21T00:00:00Z',
    })
    expect(gEvents.events).toEqual([{
      id: 'ge1',
      title: 'Design Sync',
      start: '2026-11-20T17:00:00Z',
      end: '2026-11-20T17:30:00Z',
      location: 'Meet',
      attendees: ['bob@acme.com'],
      status: 'confirmed',
    }])

    expect((await driver.executeWrite({
      version: 1, connectorId: gcalAcc.id, remoteId: gcalAcc.remote_id, app: 'google_calendar',
      accountLabel: gcalAcc.account_label, tool: 'calendar_create_event',
      args: { title: '1:1', start: '2026-11-20T18:00:00Z', end: '2026-11-20T18:30:00Z', attendees: ['bob@acme.com'] },
      operationId: 'op-gc1',
    })).status).toBe('succeeded')

    expect((await driver.executeWrite({
      version: 1, connectorId: gcalAcc.id, remoteId: gcalAcc.remote_id, app: 'google_calendar',
      accountLabel: gcalAcc.account_label, tool: 'calendar_update_event',
      args: { eventId: 'ge1', title: 'Design Sync (Updated)' },
      operationId: 'op-gc2',
    })).status).toBe('succeeded')

    const oEvents = await driver.listCalendarEvents(ocalAcc, {
      start: '2026-11-21T00:00:00Z',
      end: '2026-11-22T00:00:00Z',
    })
    expect(oEvents.events[0]).toMatchObject({
      id: 'oe1',
      title: 'Board Prep',
      location: 'Room 4B',
      attendees: ['exec@acme.com'],
    })

    expect((await driver.executeWrite({
      version: 1, connectorId: ocalAcc.id, remoteId: ocalAcc.remote_id, app: 'outlook_calendar',
      accountLabel: ocalAcc.account_label, tool: 'calendar_create_event',
      args: { title: 'Review', start: '2026-11-21T11:00:00Z', end: '2026-11-21T11:30:00Z', location: 'Zoom' },
      operationId: 'op-oc1',
    })).status).toBe('succeeded')

    expect((await driver.executeWrite({
      version: 1, connectorId: ocalAcc.id, remoteId: ocalAcc.remote_id, app: 'outlook_calendar',
      accountLabel: ocalAcc.account_label, tool: 'calendar_update_event',
      args: { eventId: 'oe1', location: 'Room 5A' },
      operationId: 'op-oc2',
    })).status).toBe('succeeded')
  })

  it('searches, reads, creates, and appends Notion pages with Markdown <-> block conversion', async () => {
    const proxyRequests: any[] = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      proxyRequests.push(body)

      if (body.endpoint === '/v1/search' && body.method === 'POST') {
        return Response.json({
          status: 200,
          data: {
            results: [{
              id: 'np_1',
              url: 'https://notion.so/np_1',
              last_edited_time: '2026-11-19T09:00:00Z',
              properties: {
                Name: { type: 'title', title: [{ plain_text: 'Roadmap Q4' }] },
              },
            }],
          },
          headers: {},
        })
      }
      if (body.endpoint === '/v1/pages/np_1' && body.method === 'GET') {
        return Response.json({
          status: 200,
          data: {
            id: 'np_1',
            properties: { Name: { type: 'title', title: [{ plain_text: 'Roadmap Q4' }] } },
          },
          headers: {},
        })
      }
      if (body.endpoint === '/v1/blocks/np_1/children' && body.method === 'GET') {
        return Response.json({
          status: 200,
          data: {
            results: [
              { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Goals' }] } },
              { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Ship connectors.' }] } },
              { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Gmail' }] } },
              { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Slack' }] } },
            ],
          },
          headers: {},
        })
      }
      if (body.endpoint === '/v1/pages' && body.method === 'POST') {
        return Response.json({ status: 200, data: { id: 'np_new' }, headers: {} })
      }
      if (body.endpoint === '/v1/blocks/np_1/children' && body.method === 'PATCH') {
        return Response.json({ status: 200, data: { results: [] }, headers: {} })
      }
      return Response.json({ status: 404, data: {}, headers: {} })
    }

    const driver = createComposioDriver({ getApiKey: () => 'cmp_test', fetchImpl: fakeFetch })

    const found = await driver.searchNotion(notionAcc, { query: 'Roadmap' })
    expect(found.pages).toEqual([{
      id: 'np_1',
      title: 'Roadmap Q4',
      url: 'https://notion.so/np_1',
      updatedAt: '2026-11-19T09:00:00Z',
    }])

    const page = await driver.readNotionPage(notionAcc, 'np_1')
    expect(page.title).toBe('Roadmap Q4')
    expect(page.content).toContain('# Goals')
    expect(page.content).toContain('Ship connectors.')
    expect(page.content).toContain('- Gmail')

    expect((await driver.executeWrite({
      version: 1, connectorId: notionAcc.id, remoteId: notionAcc.remote_id, app: 'notion',
      accountLabel: notionAcc.account_label, tool: 'notion_create_page',
      args: { parentPageId: 'np_1', title: 'Meeting Notes', markdown: '# Summary\n\n- Action item 1\n\nFollow up Friday.' },
      operationId: 'op-n1',
    })).status).toBe('succeeded')

    const createReq = proxyRequests.find((r) => r.endpoint === '/v1/pages')
    expect(createReq.body.children.map((b: any) => b.type)).toEqual(['heading_1', 'bulleted_list_item', 'paragraph'])

    expect((await driver.executeWrite({
      version: 1, connectorId: notionAcc.id, remoteId: notionAcc.remote_id, app: 'notion',
      accountLabel: notionAcc.account_label, tool: 'notion_append',
      args: { pageId: 'np_1', markdown: '## Next Steps\n- [x] Ship v1\n```ts\nconst ok = true\n```' },
      operationId: 'op-n2',
    })).status).toBe('succeeded')
    const appendReq = proxyRequests.find((r) => r.endpoint === '/v1/blocks/np_1/children' && r.method === 'PATCH')
    expect(appendReq.body.children.map((b: any) => b.type)).toEqual(['heading_2', 'to_do', 'code'])
    expect(appendReq.body.children[2].code.language).toBe('typescript')
  })

  it('lists Slack channels, reads channel/thread messages, posts messages, and handles Slack { ok: false } errors', async () => {
    let postOk = true
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.endpoint === '/api/conversations.list') {
        return Response.json({
          status: 200,
          data: {
            ok: true,
            channels: [{ id: 'C01', name: 'ops', is_private: false }],
            response_metadata: { next_cursor: 'cur_2' },
          },
          headers: {},
        })
      }
      if (body.endpoint === '/api/conversations.history') {
        return Response.json({
          status: 200,
          data: { ok: true, messages: [{ ts: '1700.01', user: 'U1', text: 'Deploy green' }] },
          headers: {},
        })
      }
      if (body.endpoint === '/api/conversations.replies') {
        return Response.json({
          status: 200,
          data: { ok: true, messages: [{ ts: '1700.02', user: 'U2', text: 'Thread reply', thread_ts: '1700.01' }] },
          headers: {},
        })
      }
      if (body.endpoint === '/api/chat.postMessage') {
        return Response.json({
          status: 200,
          data: postOk ? { ok: true, ts: '1700.99' } : { ok: false, error: 'not_in_channel' },
          headers: {},
        })
      }
      return Response.json({ status: 404, data: {}, headers: {} })
    }

    const driver = createComposioDriver({ getApiKey: () => 'cmp_test', fetchImpl: fakeFetch })

    const ch = await driver.listSlackChannels(slackAcc, { limit: 10 })
    expect(ch).toEqual({
      channels: [{ id: 'C01', name: 'ops', isPrivate: false }],
      nextCursor: 'cur_2',
    })

    const hist = await driver.readSlackMessages(slackAcc, { channelId: 'C01' })
    expect(hist.messages).toEqual([{ ts: '1700.01', user: 'U1', text: 'Deploy green' }])

    const replies = await driver.readSlackMessages(slackAcc, { channelId: 'C01', threadTs: '1700.01' })
    expect(replies.messages[0]).toMatchObject({ ts: '1700.02', threadTs: '1700.01' })

    const sent = await driver.executeWrite({
      version: 1, connectorId: slackAcc.id, remoteId: slackAcc.remote_id, app: 'slack',
      accountLabel: slackAcc.account_label, tool: 'slack_send_message',
      args: { channelId: 'C01', text: 'Hello team', threadTs: '1700.01' },
      operationId: 'op-s1',
    })
    expect(sent.status).toBe('succeeded')

    postOk = false
    const failedSlack = await driver.executeWrite({
      version: 1, connectorId: slackAcc.id, remoteId: slackAcc.remote_id, app: 'slack',
      accountLabel: slackAcc.account_label, tool: 'slack_send_message',
      args: { channelId: 'C01', text: 'Hello again' },
      operationId: 'op-s2',
    })
    expect(failedSlack).toEqual({ status: 'failed', error: 'Slack API error: not_in_channel' })
  })

  it('retries read proxy calls once on HTTP 429 honoring Retry-After capped at 5000ms, and maps 401 to auth_expired', async () => {
    const slept: number[] = []
    let attempts = 0
    const fakeFetch: typeof fetch = async () => {
      attempts++
      if (attempts === 1) {
        return Response.json(
          { status: 429, data: { error: 'rate limited' }, headers: { 'Retry-After': '12' } },
        )
      }
      if (attempts === 2) {
        return Response.json({ status: 200, data: { messages: [] }, headers: {} })
      }
      return Response.json({ status: 401, data: { error: 'invalid_grant' }, headers: {} })
    }

    const driver = createComposioDriver({
      getApiKey: () => 'cmp_test',
      fetchImpl: fakeFetch,
      sleepImpl: async (ms) => { slept.push(ms) },
    })

    const okAfterRetry = await driver.listMail(gmailAcc, {})
    expect(okAfterRetry.messages).toEqual([])
    expect(attempts).toBe(2)
    // Retry-After: 12s must be capped at 5000ms
    expect(slept).toEqual([5000])

    // Subsequent 401 throws ConnectorDriverError with code 'auth_expired'
    await expect(driver.listMail(gmailAcc, {})).rejects.toSatisfy(
      (err: unknown) => err instanceof ConnectorDriverError && err.code === 'auth_expired',
    )
  })

  it('never retries write calls on 504/timeout (uncertain) and maps 401/400/429 write errors deterministically', async () => {
    let mode: '504' | 'timeout' | '401' | '429' = '504'
    let attempts = 0
    const fakeFetch: typeof fetch = async () => {
      attempts++
      if (mode === '504') return new Response('gateway timeout', { status: 504 })
      if (mode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      if (mode === '401') return new Response('unauthorized', { status: 401 })
      return new Response('too many requests', { status: 429 })
    }

    const driver = createComposioDriver({ getApiKey: () => 'cmp_test', fetchImpl: fakeFetch })
    const baseFrozen = {
      version: 1 as const,
      connectorId: 'ca-11112222',
      remoteId: 'ca_gmail_1',
      app: 'gmail' as const,
      accountLabel: 'alice@gmail.com',
      tool: 'mail_send' as const,
      args: { to: ['bob@acme.com'], subject: 'Hi', body: 'Hello' },
      operationId: 'op-timeout-1',
    }

    const res504 = await driver.executeWrite(baseFrozen)
    expect(attempts).toBe(1)
    expect(res504.status).toBe('uncertain')

    mode = 'timeout'
    attempts = 0
    const resTimeout = await driver.executeWrite({ ...baseFrozen, operationId: 'op-timeout-2' })
    expect(attempts).toBe(1)
    expect(resTimeout.status).toBe('uncertain')

    mode = '401'
    attempts = 0
    const res401 = await driver.executeWrite({ ...baseFrozen, operationId: 'op-401' })
    expect(attempts).toBe(1)
    expect(res401).toEqual({ status: 'failed', error: 'authorization expired', authExpired: true })

    mode = '429'
    attempts = 0
    const res429 = await driver.executeWrite({ ...baseFrozen, operationId: 'op-429' })
    expect(attempts).toBe(1)
    expect(res429.status).toBe('failed')
    if (res429.status === 'failed') expect(res429.authExpired).toBeUndefined()
  })

  it('throws rate_limited after exhausting 1 retry on persistent 429 and maps Slack token_revoked to auth_expired', async () => {
    let read429Calls = 0
    const driver429 = createComposioDriver({
      getApiKey: () => 'cmp_test',
      fetchImpl: async () => {
        read429Calls++
        return new Response('rate limit', { status: 429, headers: { 'retry-after': '1' } })
      },
      sleepImpl: async () => {},
    })
    await expect(driver429.listMail(gmailAcc, {})).rejects.toSatisfy(
      (err: unknown) => err instanceof ConnectorDriverError && err.code === 'rate_limited',
    )
    expect(read429Calls).toBe(2)

    const driverSlackRevoked = createComposioDriver({
      getApiKey: () => 'cmp_test',
      fetchImpl: async () => Response.json({ status: 200, data: { ok: false, error: 'token_revoked' }, headers: {} }),
    })
    await expect(driverSlackRevoked.listSlackChannels(slackAcc, {})).rejects.toSatisfy(
      (err: unknown) => err instanceof ConnectorDriverError && err.code === 'auth_expired',
    )
    const slackWriteRevoked = await driverSlackRevoked.executeWrite({
      version: 1, connectorId: slackAcc.id, remoteId: slackAcc.remote_id, app: 'slack',
      accountLabel: slackAcc.account_label, tool: 'slack_send_message',
      args: { channelId: 'C01', text: 'Hi' }, operationId: 'op-s-revoked',
    })
    expect(slackWriteRevoked).toEqual({ status: 'failed', error: 'authorization expired', authExpired: true })
  })

  it('handles mid-stream response body timeouts/resets safely across write, read, and control requests', async () => {
    const brokenBodyResponse = (status = 200, err: unknown = new DOMException('Body stream timed out', 'TimeoutError')) => {
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          return Promise.reject(err)
        },
      })
      return new Response(stream, { status })
    }

    let writeAttempts = 0
    let writeStatus = 200
    const writeDriver = createComposioDriver({
      getApiKey: () => 'cmp_test',
      fetchImpl: async () => {
        writeAttempts++
        return brokenBodyResponse(writeStatus)
      },
    })

    // Outer 200 with mid-stream body timeout MUST return uncertain (never false succeeded) without retrying
    const resMidStream200 = await writeDriver.executeWrite({
      version: 1, connectorId: slackAcc.id, remoteId: slackAcc.remote_id, app: 'slack',
      accountLabel: slackAcc.account_label, tool: 'slack_send_message',
      args: { channelId: 'C01', text: 'Critical update' }, operationId: 'op-body-timeout-1',
    })
    expect(writeAttempts).toBe(1)
    expect(resMidStream200.status).toBe('uncertain')

    // Outer 401 with mid-stream body error still classifies as 401 authExpired failure
    writeStatus = 401
    writeAttempts = 0
    const resMidStream401 = await writeDriver.executeWrite({
      version: 1, connectorId: gmailAcc.id, remoteId: gmailAcc.remote_id, app: 'gmail',
      accountLabel: gmailAcc.account_label, tool: 'mail_send',
      args: { to: ['bob@acme.com'], subject: 'Hi', body: 'Hello' }, operationId: 'op-body-timeout-401',
    })
    expect(writeAttempts).toBe(1)
    expect(resMidStream401).toEqual({ status: 'failed', error: 'authorization expired', authExpired: true })

    // Outer 400 with mid-stream body error classifies as non-auth failed
    writeStatus = 400
    writeAttempts = 0
    const resMidStream400 = await writeDriver.executeWrite({
      version: 1, connectorId: gmailAcc.id, remoteId: gmailAcc.remote_id, app: 'gmail',
      accountLabel: gmailAcc.account_label, tool: 'mail_send',
      args: { to: ['bob@acme.com'], subject: 'Hi', body: 'Hello' }, operationId: 'op-body-timeout-400',
    })
    expect(writeAttempts).toBe(1)
    expect(resMidStream400).toEqual({ status: 'failed', error: 'Upstream rejected write (400)' })

    // proxyRead and controlRequest wrap mid-stream body TimeoutError / socket reset into ConnectorDriverError
    const readTimeoutDriver = createComposioDriver({
      getApiKey: () => 'cmp_test',
      fetchImpl: async () => brokenBodyResponse(200),
    })
    await expect(readTimeoutDriver.listMail(gmailAcc, {})).rejects.toSatisfy(
      (err: unknown) => err instanceof ConnectorDriverError && err.code === 'timeout',
    )
    await expect(readTimeoutDriver.startOAuth({
      app: 'gmail', callbackUrl: 'http://127.0.0.1:4747/oauth/connector/n1', userKey: 'opensuperbot',
    })).rejects.toSatisfy(
      (err: unknown) => err instanceof ConnectorDriverError && err.code === 'timeout',
    )

    const readResetDriver = createComposioDriver({
      getApiKey: () => 'cmp_test',
      fetchImpl: async () => brokenBodyResponse(200, new TypeError('terminated')),
    })
    await expect(readResetDriver.listMail(gmailAcc, {})).rejects.toSatisfy(
      (err: unknown) => err instanceof ConnectorDriverError && err.code === 'upstream',
    )
  })

  it('formats Microsoft Graph Outlook listMail queries to avoid InefficientFilter and SearchWithFilter 400 errors', async () => {
    const seenParams: { endpoint: string; params: Record<string, string> }[] = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const map: Record<string, string> = {}
      for (const p of body.parameters ?? []) {
        if (p.in === 'query') map[p.name] = p.value
      }
      seenParams.push({ endpoint: body.endpoint, params: map })
      return Response.json({
        status: 200,
        data: {
          value: [
            {
              id: 'om_u1',
              subject: 'Quote request',
              bodyPreview: 'Need quote',
              isRead: false,
              receivedDateTime: '2026-11-19T12:00:00Z',
              from: { emailAddress: { address: 'bob@client.com' } },
              toRecipients: [{ emailAddress: { address: 'alice@outlook.com' } }],
            },
            {
              id: 'om_r2',
              subject: 'Old quote',
              bodyPreview: 'Read quote',
              isRead: true,
              receivedDateTime: '2026-11-18T12:00:00Z',
              from: { emailAddress: { address: 'bob@client.com' } },
              toRecipients: [{ emailAddress: { address: 'alice@outlook.com' } }],
            },
          ],
        },
        headers: {},
      })
    }

    const driver = createComposioDriver({ getApiKey: () => 'cmp_test', fetchImpl: fakeFetch })

    // 1. unread without query: prefixes $orderby date property in $filter so Graph never throws 400 InefficientFilter
    const unreadOnly = await driver.listMail(outlookAcc, { folder: 'inbox', unread: true })
    expect(unreadOnly.messages.map((m) => m.id)).toEqual(['om_u1'])
    expect(seenParams[0]!.params['$orderby']).toBe('receivedDateTime desc')
    expect(seenParams[0]!.params['$filter']).toBe('receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false')
    expect(seenParams[0]!.params['$search']).toBeUndefined()

    // Sent folder with unread: false prefixes sentDateTime to match sentDateTime desc
    await driver.listMail(outlookAcc, { folder: 'sent', unread: false })
    expect(seenParams[1]!.params['$orderby']).toBe('sentDateTime desc')
    expect(seenParams[1]!.params['$filter']).toBe('sentDateTime ge 1900-01-01T00:00:00Z and isRead eq true')

    // 2. unread + query together: folds isread:<bool> into $search, omits $filter and $orderby, and filters unread client-side
    const searchUnread = await driver.listMail(outlookAcc, { folder: 'inbox', unread: true, query: 'quote' })
    expect(searchUnread.messages.map((m) => m.id)).toEqual(['om_u1'])
    expect(seenParams[2]!.params['$search']).toBe('"quote isread:false"')
    expect(seenParams[2]!.params['$filter']).toBeUndefined()
    expect(seenParams[2]!.params['$orderby']).toBeUndefined()
  })
})
