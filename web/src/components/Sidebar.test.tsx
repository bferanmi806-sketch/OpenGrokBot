import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../types'
import { Sidebar } from './Sidebar'

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'dm:researcher', kind: 'dm', title: 'Scout', emoji: '🔎', subtitle: 'research',
  members: ['researcher'], last_message: null, pending: 0, ...over,
})

describe('Sidebar', () => {
  it('badges a conversation that has approvals waiting, whatever its last message says', () => {
    render(<Sidebar conversations={[conversation({ pending: 2 })]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByLabelText('2 waiting on you')).toHaveTextContent('2')
  })

  it('shows no badge when nothing is waiting', () => {
    render(<Sidebar conversations={[conversation()]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.queryByLabelText(/waiting on you/)).toBeNull()
  })

  it('previews a bot that is working on its computer', () => {
    const working = conversation({
      last_message: {
        id: 3, thread_id: 'dm:researcher', sender: 'researcher', kind: 'activity', content: '', created_at: 3,
        payload: { done: false, steps: [{ tool: 'browser_goto', summary: 'https://example.com' }] },
      },
    })
    render(<Sidebar conversations={[working]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByText('⚙ browser_goto https://example.com')).toBeInTheDocument()
  })

  it('says which teammates are stuck or finished while you were away', () => {
    render(<Sidebar
      conversations={[conversation(), conversation({ id: 'dm:market-watch', title: 'Ticker', members: ['market-watch'] })]}
      selectedId={null}
      statuses={{ researcher: 'blocked', 'market-watch': 'done' }}
      onSelect={() => {}}
      onNewBot={() => {}}
    />)
    expect(screen.getByText('stuck')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
  })

  it('lets the badge speak for a wait it already counts, and labels one it does not', () => {
    const { rerender } = render(<Sidebar conversations={[conversation({ pending: 1 })]} selectedId={null} statuses={{ researcher: 'waiting' }} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.queryByText('needs you')).toBeNull()
    rerender(<Sidebar conversations={[conversation()]} selectedId={null} statuses={{ researcher: 'waiting' }} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByText('needs you')).toBeInTheDocument()
  })

  it('only says a group is busy; who is stuck or waiting shows on their own row', () => {
    const group = conversation({ id: 'group:crew', kind: 'group', title: 'Crew', members: ['researcher', 'chief'] })
    const { container, rerender } = render(<Sidebar conversations={[group]} selectedId={null} statuses={{ researcher: 'thinking', chief: 'blocked' }} onSelect={() => {}} onNewBot={() => {}} />)
    expect(container.querySelector('.avatar')).toHaveAttribute('data-state', 'thinking')
    rerender(<Sidebar conversations={[group]} selectedId={null} statuses={{ researcher: 'waiting', chief: 'blocked' }} onSelect={() => {}} onNewBot={() => {}} />)
    expect(container.querySelector('.avatar')).toHaveAttribute('data-state', 'idle')
    expect(screen.queryByText('stuck')).toBeNull()
  })

  it('previews an open question', () => {
    render(<Sidebar
      conversations={[conversation({
        last_message: {
          id: 4, thread_id: 'dm:researcher', sender: 'researcher', kind: 'question', content: '', created_at: 4,
          payload: { question: 'Which reply first?', options: ['A', 'B'], multi: false, status: 'open' },
        },
      })]}
      selectedId={null}
      statuses={{}}
      onSelect={() => {}}
      onNewBot={() => {}}
    />)
    expect(screen.getByText('❓ Which reply first?')).toBeInTheDocument()
  })

  it('previews a file you sent by its name', () => {
    const sent = conversation({
      last_message: {
        id: 9, thread_id: 'dm:researcher', sender: 'user', kind: 'attachment', content: '', created_at: 9,
        payload: { id: 'a'.repeat(32), url: '/api/uploads/a', name: 'plan.pdf', mime: 'application/pdf', size: 10 },
      },
    })
    render(<Sidebar conversations={[sent]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByText('📎 plan.pdf')).toBeInTheDocument()
  })

  it('previews a webhook call as such', () => {
    const called = conversation({
      last_message: {
        id: 9, thread_id: 'dm:researcher', sender: 'webhook', kind: 'webhook', content: '', created_at: 9,
        payload: { routineId: 2, name: 'Triage', body: '{}' },
      },
    })
    render(<Sidebar conversations={[called]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByText('⇣ Webhook: Triage')).toBeInTheDocument()
  })

  it('renders Connectors beside AI models in the footer and shows an attention dot when needed', async () => {
    const onModels = vi.fn()
    const onConnectors = vi.fn()
    const { container, rerender } = render(
      <Sidebar
        conversations={[conversation()]}
        selectedId={null}
        statuses={{}}
        onSelect={() => {}}
        onNewBot={() => {}}
        onModels={onModels}
        onConnectors={onConnectors}
      />,
    )
    expect(screen.getByRole('button', { name: 'AI models' })).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: 'Connectors' })
    expect(btn).toBeInTheDocument()
    expect(container.querySelector('.sidebar-foot-dot')).toBeNull()
    await userEvent.click(btn)
    expect(onConnectors).toHaveBeenCalledTimes(1)

    rerender(
      <Sidebar
        conversations={[conversation()]}
        selectedId={null}
        statuses={{}}
        onSelect={() => {}}
        onNewBot={() => {}}
        onModels={onModels}
        onConnectors={onConnectors}
        connectorsAttention
      />,
    )
    expect(screen.getByRole('button', { name: 'Connectors (needs attention)' })).toBeInTheDocument()
    expect(container.querySelector('.sidebar-foot-dot')).not.toBeNull()
  })

  it('offers a quick theme toggle in the header when provided', async () => {
    const onToggleTheme = vi.fn()
    const { rerender } = render(
      <Sidebar
        conversations={[conversation()]}
        selectedId={null}
        statuses={{}}
        onSelect={() => {}}
        onNewBot={() => {}}
        resolvedTheme="dark"
        onToggleTheme={onToggleTheme}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(onToggleTheme).toHaveBeenCalledTimes(1)

    rerender(
      <Sidebar
        conversations={[conversation()]}
        selectedId={null}
        statuses={{}}
        onSelect={() => {}}
        onNewBot={() => {}}
        resolvedTheme="light"
        onToggleTheme={onToggleTheme}
      />,
    )
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
  })

  it('renders a Vault footer button when onVault is provided', async () => {
    const onVault = vi.fn()
    render(
      <Sidebar
        conversations={[conversation()]}
        selectedId={null}
        statuses={{}}
        onSelect={() => {}}
        onNewBot={() => {}}
        onVault={onVault}
      />,
    )
    const btn = screen.getByRole('button', { name: 'Vault' })
    expect(btn).toBeInTheDocument()
    await userEvent.click(btn)
    expect(onVault).toHaveBeenCalledTimes(1)
  })

  it('renders the top Today (Feed) nav item with pending/unread badge when onFeed is provided', async () => {
    const onFeed = vi.fn()
    const { rerender } = render(
      <Sidebar
        conversations={[conversation()]}
        selectedId={null}
        statuses={{}}
        onSelect={() => {}}
        onNewBot={() => {}}
        onFeed={onFeed}
        feedPending={3}
        feedUnread={5}
      />,
    )
    const btn = screen.getByRole('button', { name: /Today/ })
    expect(btn).toBeInTheDocument()
    expect(screen.getByLabelText('3 waiting on you')).toHaveTextContent('3')
    await userEvent.click(btn)
    expect(onFeed).toHaveBeenCalledTimes(1)

    rerender(
      <Sidebar
        conversations={[conversation()]}
        selectedId={null}
        statuses={{}}
        onSelect={() => {}}
        onNewBot={() => {}}
        onFeed={onFeed}
        feedPending={0}
        feedUnread={4}
      />,
    )
    expect(screen.getByLabelText('4 unread updates')).toHaveTextContent('4')
  })

  it('previews goal_updated messages in DM rows while keeping Today as the single top nav entry', () => {
    const withGoal = conversation({
      last_message: {
        id: 10, thread_id: 'dm:researcher', sender: 'researcher', kind: 'goal_updated', content: '', created_at: 10,
        payload: { goalId: 'goal-12345678', goalTitle: 'Ship v3', kind: 'milestone', summary: 'Done', diff: '✓ [x] Docs' },
      },
    })
    render(
      <Sidebar
        conversations={[withGoal]}
        selectedId={null}
        statuses={{}}
        onSelect={() => {}}
        onNewBot={() => {}}
        onFeed={() => {}}
      />,
    )
    expect(screen.getByText('🎯 Ship v3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Today/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Goals$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Spaces$/ })).not.toBeInTheDocument()
  })

  it('renders OpenSuperBot brand label without a leading dot mark', () => {
    const { container } = render(
      <Sidebar conversations={[conversation()]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />,
    )
    expect(screen.getByText('OpenSuperBot')).toBeInTheDocument()
    expect(container.querySelector('.sidebar-brand-mark')).toBeNull()
  })

  it('previews space_updated messages in DM rows', () => {
    const withSpace = conversation({
      last_message: {
        id: 11, thread_id: 'dm:researcher', sender: 'researcher', kind: 'space_updated', content: '', created_at: 11,
        payload: { spaceId: 'space-12345678', spaceTitle: 'Pricing Board', kind: 'item', summary: 'Added row', diff: '+ Acme' },
      },
    })
    render(<Sidebar conversations={[withSpace]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByText('📊 Pricing Board')).toBeInTheDocument()
  })
})
