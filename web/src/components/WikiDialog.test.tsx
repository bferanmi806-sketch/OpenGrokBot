import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { Bot, WikiPageDetail, WikiPageSummary, WikiRevision } from '../types'
import { WikiDialog } from './WikiDialog'

const rosterArray: Bot[] = [
  { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', thread_id: 'dm:researcher', last_message: null },
  { id: 'chief', name: 'Chief', role: 'ops', emoji: '🧭', thread_id: 'dm:chief', last_message: null },
]

const acmeSummary: WikiPageSummary = {
  id: 'client/acme-corp',
  kind: 'client',
  slug: 'acme-corp',
  title: 'Acme Corp',
  summary: 'Enterprise buyer preferring annual billing',
  tags: ['enterprise', 'q3'],
  sourceTainted: true,
  updatedBy: 'researcher',
  version: 2,
  createdAt: 100,
  updatedAt: 200,
}

const linSummary: WikiPageSummary = {
  id: 'contact/lin-chen',
  kind: 'contact',
  slug: 'lin-chen',
  title: 'Lin Chen',
  summary: 'VP Engineering at Acme',
  tags: ['exec'],
  sourceTainted: false,
  updatedBy: 'operator',
  version: 1,
  createdAt: 150,
  updatedAt: 150,
}

const acmeDetailTainted: WikiPageDetail = {
  ...acmeSummary,
  body: '## Account Notes\n\n- Prefers **annual** invoicing\n- Renewal in Q4',
}

const acmeRevisions: WikiRevision[] = [
  {
    id: 2,
    pageId: 'client/acme-corp',
    version: 2,
    title: 'Acme Corp',
    summary: 'Enterprise buyer preferring annual billing',
    tags: ['enterprise', 'q3'],
    body: acmeDetailTainted.body,
    editedBy: 'researcher',
    note: 'Captured from website pricing page',
    sourceTainted: true,
    createdAt: 200,
  },
  {
    id: 1,
    pageId: 'client/acme-corp',
    version: 1,
    title: 'Acme Corp',
    summary: 'Initial profile',
    tags: ['enterprise'],
    body: 'Initial verified notes.',
    editedBy: 'operator',
    note: 'Created profile',
    sourceTainted: false,
    createdAt: 100,
  },
]

const linDetail: WikiPageDetail = {
  ...linSummary,
  body: 'Direct contact for technical escalations.',
}

const linRevisions: WikiRevision[] = [
  {
    id: 10,
    pageId: 'contact/lin-chen',
    version: 1,
    title: 'Lin Chen',
    summary: 'VP Engineering at Acme',
    tags: ['exec'],
    body: linDetail.body,
    editedBy: 'operator',
    note: '',
    sourceTainted: false,
    createdAt: 150,
  },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WikiDialog', () => {
  it('loads list, filters by kind, searches with query + kind, and ignores stale slower search responses', async () => {
    let resolveSlow!: (res: Response) => void
    const calls: string[] = []

    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === '/api/wiki') {
        return Promise.resolve(jsonResponse({ pages: [acmeSummary, linSummary], total: 2 }))
      }
      if (url === '/api/wiki?kind=client') {
        return Promise.resolve(jsonResponse({ pages: [acmeSummary], total: 1 }))
      }
      if (url === '/api/wiki?q=slow&kind=client') {
        return new Promise<Response>((resolve) => {
          resolveSlow = resolve
        })
      }
      if (url === '/api/wiki?q=fast&kind=client') {
        return Promise.resolve(jsonResponse({
          pages: [{ ...acmeSummary, title: 'Fast Client Match', snippet: 'Matched fast query' }],
          total: 1,
        }))
      }
      return Promise.resolve(jsonResponse({ pages: [], total: 0 }))
    }))

    render(<WikiDialog roster={rosterArray} onClose={() => {}} />)

    expect(await screen.findByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('Lin Chen')).toBeInTheDocument()
    expect(screen.getByText('2 pages')).toBeInTheDocument()
    expect(screen.getByText('Select a page to read or edit, or create a new one.')).toBeInTheDocument()

    // Filter by Clients
    await userEvent.click(screen.getByRole('button', { name: 'Clients' }))
    await waitFor(() => expect(calls).toContain('/api/wiki?kind=client'))
    expect(screen.getByText('1 page')).toBeInTheDocument()
    expect(screen.queryByText('Lin Chen')).toBeNull()

    // Submit slow search first, then submit fast search before slow settles
    const searchInput = screen.getByPlaceholderText('Search wiki…')
    await userEvent.type(searchInput, 'slow{Enter}')
    await waitFor(() => expect(resolveSlow).toBeTypeOf('function'))

    await userEvent.clear(searchInput)
    await userEvent.type(searchInput, 'fast{Enter}')
    expect(await screen.findByText('Fast Client Match')).toBeInTheDocument()
    expect(screen.getByText('Matched fast query')).toBeInTheDocument()

    // Slow earlier response finally arrives — must NOT overwrite newer fast results
    await act(async () => {
      resolveSlow(jsonResponse({
        pages: [{ ...acmeSummary, title: 'Stale Slow Result' }],
        total: 1,
      }))
    })
    expect(screen.getByText('Fast Client Match')).toBeInTheDocument()
    expect(screen.queryByText('Stale Slow Result')).toBeNull()
  })

  it('selects pages, renders Markdown, resolves bot and operator names, and verifies tainted pages via Review & verify', async () => {
    const calls: { method: string; url: string; body: unknown }[] = []
    let currentAcme = acmeDetailTainted
    let currentAcmeRevs = acmeRevisions

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })

      if (method === 'GET' && url === '/api/wiki') {
        return jsonResponse({
          pages: [
            { ...acmeSummary, sourceTainted: currentAcme.sourceTainted, version: currentAcme.version },
            linSummary,
          ],
          total: 2,
        })
      }
      if (method === 'GET' && url === '/api/wiki/client/acme-corp') {
        return jsonResponse({ page: currentAcme, revisions: currentAcmeRevs })
      }
      if (method === 'GET' && url === '/api/wiki/contact/lin-chen') {
        return jsonResponse({ page: linDetail, revisions: linRevisions })
      }
      if (method === 'PUT' && url === '/api/wiki/client/acme-corp') {
        const sent = body as { title: string; summary: string; tags: string[]; body: string; note?: string }
        currentAcme = {
          ...currentAcme,
          title: sent.title,
          summary: sent.summary,
          tags: sent.tags,
          body: sent.body,
          sourceTainted: false,
          updatedBy: 'operator',
          version: 3,
          updatedAt: 300,
        }
        currentAcmeRevs = [
          {
            id: 3,
            pageId: 'client/acme-corp',
            version: 3,
            title: sent.title,
            summary: sent.summary,
            tags: sent.tags,
            body: sent.body,
            editedBy: 'operator',
            note: sent.note ?? '',
            sourceTainted: false,
            createdAt: 300,
          },
          ...currentAcmeRevs,
        ]
        return jsonResponse({ page: currentAcme, revisions: currentAcmeRevs })
      }
      return jsonResponse({ error: 'not found' }, 404)
    }))

    render(<WikiDialog roster={rosterArray} onClose={() => {}} />)

    // Select operator-authored page -> resolves 'operator' to 'you'
    await userEvent.click(await screen.findByRole('button', { name: /Lin Chen/ }))
    expect(await screen.findByText('v1 · Updated by you')).toBeInTheDocument()
    expect(screen.getByText('Direct contact for technical escalations.')).toBeInTheDocument()

    // Select bot-authored tainted page -> resolves 'researcher' to 'Scout' and renders Markdown + taint banner
    await userEvent.click(screen.getByRole('button', { name: /Acme Corp/ }))
    expect(await screen.findByText('v2 · Updated by Scout')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Account Notes' })).toBeInTheDocument()
    expect(screen.getByText('annual')).toBeInTheDocument()
    expect(screen.getByText('enterprise')).toBeInTheDocument()
    expect(screen.getByText('q3')).toBeInTheDocument()
    expect(screen.getByText(/Written or updated using external web, email, or tool output/)).toBeInTheDocument()

    // Click Review & verify -> opens Edit mode with "Save & verify" button
    await userEvent.click(screen.getByRole('button', { name: 'Review & verify' }))
    expect(screen.getByRole('button', { name: 'Save & verify' })).toBeInTheDocument()

    const tagsInput = screen.getByLabelText('Tags')
    await userEvent.clear(tagsInput)
    await userEvent.type(tagsInput, 'enterprise, verified, Enterprise')
    await userEvent.type(screen.getByLabelText('Change note (optional)'), 'Reviewed against contract')
    await userEvent.click(screen.getByRole('button', { name: 'Save & verify' }))

    await waitFor(() => expect(calls).toContainEqual({
      method: 'PUT',
      url: '/api/wiki/client/acme-corp',
      body: {
        title: 'Acme Corp',
        summary: 'Enterprise buyer preferring annual billing',
        tags: ['enterprise', 'verified'],
        body: acmeDetailTainted.body,
        note: 'Reviewed against contract',
      },
    }))

    // Taint banner is gone and metadata updated to v3 · Updated by you
    expect(await screen.findByText('v3 · Updated by you')).toBeInTheDocument()
    expect(screen.queryByText(/Written or updated using external web, email, or tool output/)).toBeNull()
  })

  it('creates a new page and preserves form input on 409 already_exists error', async () => {
    const calls: { method: string; url: string; body: unknown }[] = []
    let createdPage: WikiPageDetail | null = null

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })

      if (method === 'GET' && url === '/api/wiki') {
        return jsonResponse({ pages: createdPage ? [createdPage] : [], total: createdPage ? 1 : 0 })
      }
      if (method === 'POST' && url === '/api/wiki') {
        const sent = body as { kind: 'project'; slug?: string; title: string; summary?: string; tags?: string[]; body: string; note?: string }
        if (sent.slug === 'apollo') {
          return jsonResponse({ error: 'Wiki page already exists: project/apollo', code: 'already_exists' }, 409)
        }
        createdPage = {
          id: `${sent.kind}/${sent.slug ?? 'apollo-2'}`,
          kind: sent.kind,
          slug: sent.slug ?? 'apollo-2',
          title: sent.title,
          summary: sent.summary ?? '',
          tags: sent.tags ?? [],
          body: sent.body,
          sourceTainted: false,
          updatedBy: 'operator',
          version: 1,
          createdAt: 500,
          updatedAt: 500,
        }
        return jsonResponse({
          page: createdPage,
          revisions: [{
            id: 1,
            pageId: createdPage.id,
            version: 1,
            title: createdPage.title,
            summary: createdPage.summary,
            tags: createdPage.tags,
            body: createdPage.body,
            editedBy: 'operator',
            note: sent.note ?? '',
            sourceTainted: false,
            createdAt: 500,
          }],
        }, 201)
      }
      return jsonResponse({ error: 'not found' }, 404)
    }))

    render(<WikiDialog roster={{}} onClose={() => {}} />)
    expect(await screen.findByText(/No wiki pages yet/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'New page' }))
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'project')
    await userEvent.type(screen.getByLabelText('Title'), 'Project Apollo')
    await userEvent.type(screen.getByLabelText('Slug (optional)'), 'apollo')
    await userEvent.type(screen.getByLabelText('Summary'), 'Q4 launch plan')
    await userEvent.type(screen.getByLabelText('Tags'), 'launch, q4')
    await userEvent.type(screen.getByLabelText('Markdown content'), 'Milestone 1 ready.')
    await userEvent.click(screen.getByRole('button', { name: 'Create page' }))

    // Shows localized 409 error without clearing user input
    expect(await screen.findByRole('alert')).toHaveTextContent('A wiki page with this title or slug already exists.')
    expect(screen.getByLabelText('Title')).toHaveValue('Project Apollo')
    expect(screen.getByLabelText('Markdown content')).toHaveValue('Milestone 1 ready.')

    // Fix slug and resubmit
    const slugInput = screen.getByLabelText('Slug (optional)')
    await userEvent.clear(slugInput)
    await userEvent.type(slugInput, 'apollo-v2')
    await userEvent.click(screen.getByRole('button', { name: 'Create page' }))

    expect(await screen.findByText('Milestone 1 ready.')).toBeInTheDocument()
    expect(screen.getByText('project/apollo-v2')).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
  })

  it('expands History, reverts to an older revision via ConfirmDialog, and deletes a page via ConfirmDialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const calls: { method: string; url: string; body: unknown }[] = []
    let deleted = false
    let page = acmeDetailTainted
    let revs = acmeRevisions

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })

      if (method === 'GET' && url === '/api/wiki') {
        return jsonResponse({ pages: deleted ? [] : [page], total: deleted ? 0 : 1 })
      }
      if (method === 'GET' && url === '/api/wiki/client/acme-corp') {
        return jsonResponse({ page, revisions: revs })
      }
      if (method === 'POST' && url === '/api/wiki/client/acme-corp/revert') {
        page = {
          ...page,
          summary: 'Initial profile',
          tags: ['enterprise'],
          body: 'Initial verified notes.',
          sourceTainted: false,
          updatedBy: 'operator',
          version: 3,
          updatedAt: 400,
        }
        revs = [
          {
            id: 3,
            pageId: 'client/acme-corp',
            version: 3,
            title: page.title,
            summary: page.summary,
            tags: page.tags,
            body: page.body,
            editedBy: 'operator',
            note: 'Reverted to v1',
            sourceTainted: false,
            createdAt: 400,
          },
          ...revs,
        ]
        return jsonResponse({ page, revisions: revs })
      }
      if (method === 'DELETE' && url === '/api/wiki/client/acme-corp') {
        deleted = true
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ error: 'not found' }, 404)
    }))

    render(<WikiDialog roster={rosterArray} onClose={() => {}} />)

    await userEvent.click(await screen.findByRole('button', { name: /Acme Corp/ }))
    expect(await screen.findByText('v2 · Updated by Scout')).toBeInTheDocument()

    // Expand History (2)
    await userEvent.click(screen.getByRole('button', { name: 'History (2)' }))
    expect(screen.getByText('Current')).toBeInTheDocument()
    expect(screen.getByText('Captured from website pricing page')).toBeInTheDocument()
    expect(screen.getByText('Created profile')).toBeInTheDocument()

    // Revert to v1 via ConfirmDialog
    await userEvent.click(screen.getByRole('button', { name: 'Revert' }))
    const revertDialog = screen.getByRole('alertdialog')
    expect(revertDialog).toHaveTextContent('Revert “Acme Corp” to version 1?')
    await userEvent.click(within(revertDialog).getByRole('button', { name: 'Revert' }))

    await waitFor(() => expect(calls).toContainEqual({
      method: 'POST',
      url: '/api/wiki/client/acme-corp/revert',
      body: { version: 1 },
    }))
    expect(await screen.findByText('Initial verified notes.')).toBeInTheDocument()
    expect(screen.getByText('v3 · Updated by you')).toBeInTheDocument()

    // Delete page via ConfirmDialog
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const deleteDialog = screen.getByRole('alertdialog')
    expect(deleteDialog).toHaveTextContent('Delete “Acme Corp” from the team wiki?')
    await userEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(calls).toContainEqual({
      method: 'DELETE',
      url: '/api/wiki/client/acme-corp',
      body: undefined,
    }))
    expect(await screen.findByText('Select a page to read or edit, or create a new one.')).toBeInTheDocument()
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('refreshes list and viewed page on refreshTick without clobbering active unsaved edits', async () => {
    let remoteBody = 'Server body v1'
    let remoteVersion = 1
    let detailFetchCount = 0

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url === '/api/wiki') {
        return jsonResponse({
          pages: [{ ...linSummary, version: remoteVersion, title: remoteVersion === 1 ? 'Lin Chen' : 'Lin Chen (Updated)' }],
          total: 1,
        })
      }
      if (url === '/api/wiki/contact/lin-chen') {
        detailFetchCount += 1
        return jsonResponse({
          page: { ...linDetail, body: remoteBody, version: remoteVersion },
          revisions: linRevisions,
        })
      }
      return jsonResponse({ error: 'not found' }, 404)
    }))

    const { rerender } = render(<WikiDialog roster={{}} refreshTick={0} onClose={() => {}} />)

    await userEvent.click(await screen.findByRole('button', { name: /Lin Chen/ }))
    expect(await screen.findByText('Server body v1')).toBeInTheDocument()

    // Live refresh in View mode updates both list and detail
    remoteVersion = 2
    remoteBody = 'Server body v2'
    rerender(<WikiDialog roster={{}} refreshTick={1} onClose={() => {}} />)
    expect(await screen.findByText('Server body v2')).toBeInTheDocument()
    expect(await screen.findByText('Lin Chen (Updated)')).toBeInTheDocument()

    // Enter Edit mode and type unsaved text
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const bodyInput = screen.getByLabelText('Markdown content')
    await userEvent.clear(bodyInput)
    await userEvent.type(bodyInput, 'My unsaved local draft')

    const fetchesBeforeTick = detailFetchCount
    remoteVersion = 3
    remoteBody = 'Server body v3'
    rerender(<WikiDialog roster={{}} refreshTick={2} onClose={() => {}} />)

    // Wait for list refresh tick to settle
    await waitFor(() => expect(screen.getByText('v3')).toBeInTheDocument())
    // Active Edit mode and unsaved textarea content must NOT be clobbered!
    expect(screen.getByLabelText('Markdown content')).toHaveValue('My unsaved local draft')
    expect(detailFetchCount).toBe(fetchesBeforeTick)
  })

  it('renders Chinese copy, closes form before modal on Escape, and reports SignedOut on 401', async () => {
    const onClose = vi.fn()
    const onSignedOut = vi.fn()
    let failAuth = false

    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failAuth) return jsonResponse({ error: 'sign in' }, 401)
      return jsonResponse({ pages: [], total: 0 })
    }))

    const { rerender } = render(
      <I18nProvider lang="zh-CN">
        <WikiDialog roster={{}} refreshTick={0} onClose={onClose} onSignedOut={onSignedOut} />
      </I18nProvider>,
    )

    expect(await screen.findByRole('dialog', { name: '团队知识库' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '新建页面' }))
    expect(screen.getByRole('button', { name: '创建页面' })).toBeInTheDocument()

    // First Escape cancels form without closing the dialog
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '创建页面' })).toBeNull()

    // Second Escape closes the dialog
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    // 401 calls onSignedOut
    failAuth = true
    rerender(
      <I18nProvider lang="zh-CN">
        <WikiDialog roster={{}} refreshTick={1} onClose={onClose} onSignedOut={onSignedOut} />
      </I18nProvider>,
    )
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1))
  })
})
