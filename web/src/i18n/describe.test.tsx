import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  deleteConnector,
  fetchConnectors,
  reconnectConnector,
  refreshConnector,
  saveConnectorsKey,
  setBotConnectors,
  setComputerShell,
  startConnectorOAuth,
  testConnectorsKey,
} from '../api'
import { ComputerPanel } from '../components/ComputerPanel'
import { Sidebar } from '../components/Sidebar'
import { Thread } from '../components/Thread'
import type { ComputerInfo, Conversation, Message, NoticePayload } from '../types'
import { blockReasonText, describeSchedule, errorText, isNotice, noticeText } from './describe'
import { I18nProvider, makeT } from './index'

const en = makeT('en')
const zh = makeT('zh-CN')

describe('notices', () => {
  it('say in English exactly what the gateway stored, and in Chinese in Chinese', () => {
    expect(noticeText(en, { notice: 'stopped' })).toBe('⏹ Stopped. Tell me when to pick it back up.')
    expect(noticeText(en, { notice: 'paused', params: { limit: 'steps', count: 2 } }))
      .toBe('⏸ Paused at the 2-step limit for one turn. Say "continue" to pick it up.')
    expect(noticeText(en, { notice: 'budget', params: { name: 'Scout', used: 200500, budget: 200000 } }))
      .toBe("⚠️ Scout hit today's token budget (200,500 of 200,000 tokens). It picks up again tomorrow — or raise OPENSUPERBOT_DAILY_TOKENS.")
    expect(noticeText(zh, { notice: 'error', params: { name: 'Scout', detail: 'upstream 502' } })).toBe('⚠️ Scout 出错了：upstream 502')
    expect(noticeText(zh, { notice: 'paused', params: { limit: 'minutes', count: 15 } })).toMatch(/15 分钟的上限.*说「继续」/)
  })

  it('recognizes and translates connector_expired and connector_execution notices', () => {
    const expired: NoticePayload = { notice: 'connector_expired', params: { app: 'Gmail', account: 'alice@gmail.com' } }
    const failed: NoticePayload = {
      notice: 'connector_execution',
      params: { status: 'failed', action: 'Send email to bob@acme.com', detail: '403 Forbidden' },
    }
    const uncertain: NoticePayload = {
      notice: 'connector_execution',
      params: { status: 'uncertain', action: 'Post to #general', detail: 'request timed out' },
    }

    expect(isNotice(expired)).toBe(true)
    expect(isNotice(failed)).toBe(true)
    expect(isNotice(uncertain)).toBe(true)
    expect(isNotice({ notice: 'unknown_notice' })).toBe(false)

    expect(noticeText(en, expired)).toBe('⚠️ Gmail (alice@gmail.com) needs reconnection. Open Connectors to sign in again.')
    expect(noticeText(en, failed)).toBe('⚠️ Could not execute "Send email to bob@acme.com": 403 Forbidden')
    expect(noticeText(en, uncertain)).toBe(
      '⚠️ Outcome unconfirmed for "Post to #general": request timed out. The request was NOT retried automatically to prevent sending duplicates — please check the target app.',
    )

    expect(noticeText(zh, expired)).toMatch(/Gmail.*alice@gmail\.com.*重新授权.*连接器/)
    expect(noticeText(zh, failed)).toMatch(/Send email to bob@acme\.com.*403 Forbidden/)
    expect(noticeText(zh, uncertain)).toMatch(/Post to #general.*request timed out.*没有自动重试/)
  })
})

describe('connector API client', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('returns null on 404 from fetchConnectors for older gateways and parses snapshot on 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        key: { set: false, masked: '', source: 'none', locked: false },
        catalog: [],
        accounts: [],
        botGrants: {},
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchConnectors()).toBeNull()
    expect(await fetchConnectors()).toEqual({
      key: { set: false, masked: '', source: 'none', locked: false },
      catalog: [],
      accounts: [],
      botGrants: {},
    })
  })

  it('calls connector management endpoints with expected methods, paths, and strict error handling', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'locked' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectorId: 'ca-1', redirectUrl: 'https://composio.example/auth', callbackUrl: 'http://localhost/oauth/connector/n1',
        state: { key: { set: true, masked: 'cmp…1', source: 'file', locked: false }, catalog: [], accounts: [], botGrants: {} },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectorId: 'ca-1', redirectUrl: 'https://composio.example/reauth', callbackUrl: 'http://localhost/oauth/connector/n2',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        key: { set: true, masked: 'cmp…1', source: 'file', locked: false }, catalog: [], accounts: [], botGrants: {},
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        key: { set: true, masked: 'cmp…1', source: 'file', locked: false }, catalog: [], accounts: [], botGrants: {},
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ botId: 'inbox keeper', connectorIds: ['ca-1'] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(saveConnectorsKey('cmp_123')).rejects.toMatchObject({ status: 409, message: 'locked' })
    expect(await testConnectorsKey()).toEqual({ ok: true })
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual({})
    await startConnectorOAuth('gmail', ['inbox-keeper'])
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/connectors/connect')
    await reconnectConnector('ca-1')
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/connectors/ca-1/reconnect')
    await refreshConnector('ca-1')
    expect(fetchMock.mock.calls[4]![0]).toBe('/api/connectors/ca-1/refresh')
    await deleteConnector('ca-1')
    expect(fetchMock.mock.calls[5]![0]).toBe('/api/connectors/ca-1')
    expect((fetchMock.mock.calls[5]![1] as RequestInit).method).toBe('DELETE')
    await setBotConnectors('inbox keeper', ['ca-1'])
    expect(fetchMock.mock.calls[6]![0]).toBe('/api/bots/inbox%20keeper/connectors')
  })
})

describe('errors', () => {
  it('translate a known code with its values, and fall back to the gateway words otherwise', () => {
    expect(errorText(zh, { message: 'x', code: 'name_taken', params: { name: 'Scout' } })).toBe('已经有一位叫 Scout 的同事了。')
    expect(errorText(zh, { message: 'Docker is not running.', code: 'docker_down' })).toMatch(/^Docker 没在运行/)
    expect(errorText(zh, { message: 'from a newer gateway', code: 'something_new' })).toBe('from a newer gateway')
    expect(errorText(zh, { message: 'plain' })).toBe('plain')
  })

  it('spell out why there is no sandbox, or say nothing more when the gateway gave no reason', () => {
    expect(errorText(zh, { message: 'x', code: 'no_sandbox', params: { why: 'install_bwrap' } })).toMatch(/没有能跑命令的沙箱。装上 bubblewrap/)
    expect(errorText(zh, { message: 'x', code: 'no_sandbox', params: { why: 'userns_blocked' } })).toMatch(/AppArmor.*\.deb/)
    expect(errorText(zh, { message: 'x', code: 'browser_sandbox_blocked' })).toMatch(/AppArmor.*\.deb/)
    expect(errorText(en, { message: 'x', code: 'no_sandbox' })).toBe('No sandbox for commands on this machine.')
  })

  it('a refused switch now reaches the panel instead of vanishing as a 409', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no sandbox', code: 'no_sandbox', params: { why: 'install_bwrap' } }), { status: 409 })))
    const err = await setComputerShell('researcher', true).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'no_sandbox', params: { why: 'install_bwrap' } })
  })
  afterEach(() => { vi.unstubAllGlobals() })
})

describe('reasons a release cannot become a rule', () => {
  it('fill in the destination, and fall back to the English when there is no code', () => {
    expect(blockReasonText(zh, { code: 'wildcard', target: '*' }, 'x')).toBe('「*」是通配，不是一个确定的去处')
    expect(blockReasonText(zh, { code: 'too_long', max: 200 }, 'x')).toBe('去处超过了 200 个字符')
    expect(blockReasonText(zh, undefined, 'old chip text')).toBe('old chip text')
  })
})

describe('schedules', () => {
  it('match the gateway in English', () => {
    expect(describeSchedule(en, '0 9 * * *', false)).toBe('every day at 09:00')
    expect(describeSchedule(en, '30 8 * * 1', false)).toBe('every Monday at 08:30')
    expect(describeSchedule(en, '*/15 * * * *', false)).toBe('every 15 minutes')
    expect(describeSchedule(en, '0 9 1 * *', true)).toBe('day 1 of each month at 09:00, and when its webhook is called')
    expect(describeSchedule(en, '', false)).toBe('never (no schedule and no webhook)')
    expect(describeSchedule(en, '5 4 * 2 *', false)).toBe('5 4 * 2 *')
  })

  it('read naturally in Chinese', () => {
    expect(describeSchedule(zh, '0 9 * * *', false)).toBe('每天 09:00')
    expect(describeSchedule(zh, '30 8 * * 1', false)).toBe('每星期一 08:30')
    expect(describeSchedule(zh, '', true)).toBe('它的 webhook 被调用时')
  })
})

describe('in Chinese, on screen', () => {
  const dm: Conversation = { id: 'dm:researcher', kind: 'dm', title: 'Scout', emoji: '🔎', subtitle: '', members: ['researcher'], last_message: null, pending: 0 }
  const paused: Message = {
    id: 1, thread_id: dm.id, sender: 'researcher', kind: 'text', created_at: Date.now(),
    content: 'Two pages done.\n\n⏸ Paused at the 2-step limit for one turn. Say "continue" to pick it up.',
    payload: { notice: 'paused', params: { limit: 'steps', count: 2 }, lead: 'Two pages done.' },
  }

  it('a pause keeps the teammate’s own words and says the rest in Chinese', () => {
    render(<I18nProvider lang="zh-CN">
      <Thread conversation={dm} roster={{}} messages={[paused]} thinking={false} onSend={() => {}} onDecide={() => {}} />
    </I18nProvider>)
    expect(screen.getByText('Two pages done.')).toBeInTheDocument()
    expect(screen.getByText(/到了一个回合 2 步的上限/)).toBeInTheDocument()
    expect(screen.queryByText(/Paused at/)).toBeNull()
  })

  it('the sidebar previews a notice in Chinese', () => {
    const stopped: Message = { ...paused, content: '⏹ Stopped. Tell me when to pick it back up.', payload: { notice: 'stopped' } }
    render(<I18nProvider lang="zh-CN">
      <Sidebar conversations={[{ ...dm, last_message: stopped }]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />
    </I18nProvider>)
    expect(screen.getByText('⏹ 停下了。要接着做就告诉我。')).toBeInTheDocument()
  })

  it('the thread and sidebar render connector_expired and connector_execution notices in Chinese', () => {
    const expiredMsg: Message = {
      ...paused,
      id: 10,
      content: '⚠️ Gmail (alice@gmail.com) needs reconnection. Open Connectors to sign in again.',
      payload: { notice: 'connector_expired', params: { app: 'Gmail', account: 'alice@gmail.com' } },
    }
    const uncertainMsg: Message = {
      ...paused,
      id: 11,
      content: '⚠️ Outcome unconfirmed for "Send reply": timeout. The request was NOT retried automatically to prevent sending duplicates — please check the target app.',
      payload: { notice: 'connector_execution', params: { status: 'uncertain', action: 'Send reply', detail: 'timeout' } },
    }
    render(<I18nProvider lang="zh-CN">
      <Sidebar conversations={[{ ...dm, last_message: expiredMsg }]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />
      <Thread conversation={dm} roster={{}} messages={[expiredMsg, uncertainMsg]} thinking={false} onSend={() => {}} onDecide={() => {}} />
    </I18nProvider>)
    expect(screen.getAllByText(/Gmail（alice@gmail\.com）需要重新授权/)).toHaveLength(2)
    expect(screen.getByText(/「Send reply」结果未确认：timeout/)).toBeInTheDocument()
    expect(screen.queryByText(/needs reconnection/)).toBeNull()
  })

  it('the computer panel says why there is no screen, no sandbox, and when routines run', () => {
    const info: ComputerInfo = {
      botId: 'researcher', running: false, vncUrl: null, kind: 'local',
      error: 'Docker is not running. Start Docker Desktop (or the docker service), then open this again.', errorCode: 'docker_down',
      shell: { enabled: false, available: false, why: 'Install bubblewrap…', whyCode: 'install_bwrap' },
      routines: [{ id: 1, name: 'Morning digest', cron: '0 9 * * *', human: 'every day at 09:00', last_run_at: null, enabled: 1 }],
      rules: [{ id: 3, kind: 'message', target: '*', expiresAt: null, createdAt: 1, applies: false, whyNot: '"*" is a wildcard', whyNotReason: { code: 'wildcard', target: '*' } }],
    }
    render(<I18nProvider lang="zh-CN"><ComputerPanel info={info} botName="Scout" onClose={() => {}} /></I18nProvider>)
    expect(screen.getByText(/^Docker 没在运行/)).toBeInTheDocument()
    expect(screen.getByText(/这里用不了：装上 bubblewrap/)).toBeInTheDocument()
    expect(screen.getByText('每天 09:00')).toBeInTheDocument()
    expect(screen.getByText('已不再生效：「*」是通配，不是一个确定的去处')).toBeInTheDocument()
  })
})
