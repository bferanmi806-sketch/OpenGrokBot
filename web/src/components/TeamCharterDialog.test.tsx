import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { MAX_TEAM_CHARTER_CHARS, TeamCharterDialog } from './TeamCharterDialog'

describe('TeamCharterDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads team.md, tracks character count, saves via PUT, and shows saved status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          threadId: 'group:offsite-crew',
          content: '- Scout researches first.',
          updatedAt: 1000,
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          threadId: 'group:offsite-crew',
          content: '- Scout researches first.\n- Keep replies under 3 bullets.',
          updatedAt: 2000,
        }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(
      <TeamCharterDialog
        threadId="group:offsite-crew"
        groupTitle="Offsite crew"
        onSignedOut={() => {}}
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('Loading team charter…')).toBeInTheDocument()

    const textarea = await screen.findByRole('textbox', { name: 'Team charter (team.md)' }) as HTMLTextAreaElement
    expect(textarea.value).toBe('- Scout researches first.')
    expect(fetchMock).toHaveBeenCalledWith('/api/threads/group%3Aoffsite-crew/team', undefined)

    const saveBtn = screen.getByRole('button', { name: 'Save charter' })
    expect(saveBtn).toBeDisabled()

    await user.type(textarea, '\n- Keep replies under 3 bullets.')
    expect(saveBtn).toBeEnabled()

    await user.click(saveBtn)

    expect(await screen.findByRole('status')).toHaveTextContent('Saved to team.md.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/threads/group%3Aoffsite-crew/team')
    const init = fetchMock.mock.calls[1]![1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({
      content: '- Scout researches first.\n- Keep replies under 3 bullets.',
    })
    expect(saveBtn).toBeDisabled()
  })

  it('validates content length > 16,384 characters and blocks save', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ threadId: 'group:crew', content: '', updatedAt: null }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <TeamCharterDialog
        threadId="group:crew"
        groupTitle="Crew"
        onSignedOut={() => {}}
        onClose={() => {}}
      />,
    )

    const textarea = await screen.findByRole('textbox', { name: 'Team charter (team.md)' })
    fireEvent.change(textarea, { target: { value: 'a'.repeat(MAX_TEAM_CHARTER_CHARS + 1) } })

    expect(screen.getByRole('alert')).toHaveTextContent(
      `Team charter must be ${MAX_TEAM_CHARTER_CHARS} characters or fewer.`,
    )
    expect(screen.getByRole('button', { name: 'Save charter' })).toBeDisabled()
    expect(screen.getByText('16,385 / 16,384')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes on refreshTick when clean, and preserves unsaved dirty edits on refreshTick', async () => {
    let serverContent = 'Initial charter'
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ threadId: 'group:crew', content: serverContent, updatedAt: 1000 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    const { rerender } = render(
      <TeamCharterDialog
        threadId="group:crew"
        groupTitle="Crew"
        refreshTick={0}
        onSignedOut={() => {}}
        onClose={() => {}}
      />,
    )

    const textarea = await screen.findByRole('textbox', { name: 'Team charter (team.md)' }) as HTMLTextAreaElement
    expect(textarea.value).toBe('Initial charter')

    // Clean state -> refreshTick updates draft with server content
    serverContent = 'Updated from another tab'
    rerender(
      <TeamCharterDialog
        threadId="group:crew"
        groupTitle="Crew"
        refreshTick={1}
        onSignedOut={() => {}}
        onClose={() => {}}
      />,
    )
    await waitFor(() => {
      expect(textarea.value).toBe('Updated from another tab')
    })

    // User makes unsaved local edits -> next refreshTick MUST NOT overwrite draft
    await user.type(textarea, '\nMy unsaved rule')
    expect(textarea.value).toBe('Updated from another tab\nMy unsaved rule')

    serverContent = 'Different remote update'
    rerender(
      <TeamCharterDialog
        threadId="group:crew"
        groupTitle="Crew"
        refreshTick={2}
        onSignedOut={() => {}}
        onClose={() => {}}
      />,
    )
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
    expect(textarea.value).toBe('Updated from another tab\nMy unsaved rule')
    expect(screen.getByRole('button', { name: 'Save charter' })).toBeEnabled()
  })

  it('invokes onSignedOut on 401 and surfaces save errors cleanly', async () => {
    const onSignedOut = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const { unmount } = render(
      <TeamCharterDialog
        threadId="group:crew"
        groupTitle="Crew"
        onSignedOut={onSignedOut}
        onClose={() => {}}
      />,
    )
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1))
    unmount()

    const fetchMock2 = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ threadId: 'group:crew', content: 'old', updatedAt: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'too long', code: 'invalid_content' }), { status: 400 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock2)

    const user = userEvent.setup()
    render(
      <TeamCharterDialog
        threadId="group:crew"
        groupTitle="Crew"
        onSignedOut={onSignedOut}
        onClose={() => {}}
      />,
    )
    const textarea = await screen.findByRole('textbox', { name: 'Team charter (team.md)' })
    await user.type(textarea, ' updated')
    await user.click(screen.getByRole('button', { name: 'Save charter' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Team charter content is not valid (16,384 characters max).')

    await user.click(screen.getByRole('button', { name: 'Save charter' }))
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(2))
  })

  it('closes on Escape and scrim click and renders cleanly in zh-CN', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ threadId: 'group:crew', content: '先查知识库再定价。', updatedAt: 1 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const onClose = vi.fn()
    const { container } = render(
      <I18nProvider lang="zh-CN">
        <TeamCharterDialog
          threadId="group:crew"
          groupTitle="核心小组"
          onSignedOut={() => {}}
          onClose={onClose}
        />
      </I18nProvider>,
    )

    expect(await screen.findByDisplayValue('先查知识库再定价。')).toBeInTheDocument()
    expect(screen.getByText('团队章程（team.md）')).toBeInTheDocument()
    expect(screen.getByText(/核心小组 的共享协作规范/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存章程' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    const scrim = container.querySelector('.modal-scrim')!
    fireEvent.mouseDown(scrim)
    fireEvent.click(scrim)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
