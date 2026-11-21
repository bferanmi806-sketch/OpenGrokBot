import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { FeedSnapshot, GoalsSnapshot } from '../types'
import { FeedView } from './FeedView'

const ROSTER = {
  chief: { name: 'Chief', emoji: '🧠' },
  scout: { name: 'Scout', emoji: '🔎' },
}

const SNAPSHOT: FeedSnapshot = {
  needsYou: [
    {
      kind: 'approval',
      id: 'approval:7',
      approvalId: 7,
      botId: 'scout',
      botName: 'Scout',
      botEmoji: '🔎',
      threadId: 'dm:scout',
      threadTitle: 'Scout',
      createdAt: 1_700_000_000_000,
      payload: {
        approvalId: 7,
        action: 'Send price alert email',
        detail: 'To ops@acme.test',
        kind: 'email',
        target: 'ops@acme.test',
        status: 'pending',
        canRemember: false,
      },
    },
    {
      kind: 'question',
      id: 'question:9',
      messageId: 9,
      botId: 'chief',
      botName: 'Chief',
      botEmoji: '🧠',
      threadId: 'dm:chief',
      threadTitle: 'Chief',
      createdAt: 1_700_000_000_000,
      payload: {
        question: 'Prioritize cloud costs?',
        options: ['Yes', 'Later'],
        multi: false,
        status: 'open',
      },
    },
    {
      kind: 'login',
      id: 'login:12',
      messageId: 12,
      botId: 'scout',
      botName: 'Scout',
      botEmoji: '🔎',
      threadId: 'dm:scout',
      threadTitle: 'Scout',
      createdAt: 1_700_000_000_000,
      payload: { site: 'Zendesk', why: 'Session expired' },
    },
  ],
  items: [
    {
      id: 'feed-11111111',
      kind: 'proposal',
      botId: 'scout',
      botName: 'Scout',
      botEmoji: '🔎',
      threadId: 'dm:scout',
      sourceMessageId: null,
      topicId: null,
      title: 'GPU spot prices dropped 15%',
      summary: 'Observed lower A100 rates across two providers.',
      body: {
        suggestedAction: 'Spin up weekly watch routine',
        suggestedBotId: 'scout',
        sources: [{ title: 'Cloud Pricing Blog', url: 'https://cloud.example.com/gpu-drop' }],
      },
      tags: ['pricing'],
      tainted: true,
      sourceLabel: 'watch',
      status: 'unread',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  ],
  ideas: [
    {
      id: 'idea-22222222',
      title: 'Automate vendor comparisons',
      notes: 'Compare 3 cloud vendors',
      origin: 'operator',
      sourceFeedId: null,
      tainted: false,
      status: 'ready',
      assignedBotId: 'scout',
      incubationThreadId: 'dm:scout',
      incubationSummary: 'Feasible via public pricing APIs.',
      promotedGoalId: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  ],
  topics: [],
  unreadCount: 1,
}

describe('FeedView', () => {
  it('places Needs You chips and standalone tracking routines inside Tracking & Goals alongside Goals', async () => {
    const onDecide = vi.fn()
    const onAnswer = vi.fn()
    const onOpenComputer = vi.fn()
    const routineSpy = vi.spyOn(api, 'updateRoutine').mockResolvedValue()
    const onRefreshGoals = vi.fn(async () => {})
    const goalsSnap: GoalsSnapshot = {
      goals: [],
      activeCount: 0,
      unlinkedRoutines: [
        {
          id: 42,
          botId: 'scout',
          name: 'Hourly Price Watch',
          cron: '0 * * * *',
          human: 'every hour',
          mode: 'watch',
          surface: 'both',
          enabled: true,
          lastRunAt: null,
          goalId: null,
        },
      ],
    }

    render(
      <FeedView
        state={SNAPSHOT}
        roster={ROSTER}
        goals={goalsSnap}
        onGoalsChange={() => {}}
        onRefreshGoals={onRefreshGoals}
        onChange={() => {}}
        onOpenThread={() => {}}
        onOpenComputer={onOpenComputer}
        onDecide={onDecide}
        onAnswer={onAnswer}
      />,
    )

    // Needs You is NOT mixed into the Feed tab anymore
    expect(screen.queryByText('Send price alert email')).not.toBeInTheDocument()

    // Switch to Tracking & Goals tab
    await userEvent.click(screen.getByRole('tab', { name: /Tracking & Goals/ }))
    expect(screen.getByText('Send price alert email')).toBeInTheDocument()
    expect(screen.getByText('Prioritize cloud costs?')).toBeInTheDocument()
    expect(screen.getByText(/Zendesk/)).toBeInTheDocument()
    expect(screen.getByText('Hourly Price Watch')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'approve')

    await userEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onAnswer).toHaveBeenCalledWith(9, ['Yes'])

    await userEvent.click(screen.getByRole('button', { name: 'Open the computer panel' }))
    expect(onOpenComputer).toHaveBeenCalledWith('scout')

    await userEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(routineSpy).toHaveBeenCalledWith(42, 'run')
    expect(onRefreshGoals).toHaveBeenCalledTimes(1)
    routineSpy.mockRestore()
  })

  it('supports creating a continuous web-curated Feed prompt without cron schedules and renders source links', async () => {
    const newTopic = {
      id: 'topic-aaaaaaaa',
      title: 'AI Agent Radar',
      prompt: 'Track AI Agent releases continuously with links',
      botId: 'scout',
      botName: 'Scout',
      botEmoji: '🔎',
      cron: '',
      human: '',
      enabled: true,
      running: false,
      lastRunAt: null,
      lastError: '',
      createdAt: 1,
      updatedAt: 1,
    }
    const afterCreate: FeedSnapshot = {
      ...SNAPSHOT,
      topics: [newTopic],
      dailyCustomCount: 2,
      dailyCustomCap: 15,
    }
    const createTopicSpy = vi.spyOn(api, 'createFeedTopic').mockResolvedValue({
      topic: newTopic,
      running: true,
      snapshot: afterCreate,
    })
    const onChange = vi.fn()

    const { rerender } = render(
      <FeedView
        state={SNAPSHOT}
        roster={ROSTER}
        onChange={onChange}
        onOpenThread={() => {}}
        onOpenComputer={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )

    // No cron schedule selector in continuous Custom Feed mode
    expect(screen.queryByRole('combobox', { name: /Schedule/ })).not.toBeInTheDocument()

    // Source link renders on feed card
    const sourceLink = screen.getByRole('link', { name: 'Cloud Pricing Blog' })
    expect(sourceLink).toHaveAttribute('href', 'https://cloud.example.com/gpu-drop')
    expect(sourceLink).toHaveAttribute('target', '_blank')

    // Fill custom feed prompt & click Save & start
    await userEvent.type(screen.getByRole('textbox', { name: 'Custom Feed' }), 'Track AI Agent releases continuously with links')
    await userEvent.type(screen.getByPlaceholderText(/Topic name/), 'AI Agent Radar')
    await userEvent.click(screen.getByRole('button', { name: /Save & start/ }))

    expect(createTopicSpy).toHaveBeenCalledWith({
      title: 'AI Agent Radar',
      prompt: 'Track AI Agent releases continuously with links',
      cron: '',
      botId: 'scout',
      runNow: true,
    })
    expect(onChange).toHaveBeenCalledWith(afterCreate)

    // Active continuous topic shows Live pill and daily quota
    rerender(
      <FeedView
        state={afterCreate}
        roster={ROSTER}
        onChange={onChange}
        onOpenThread={() => {}}
        onOpenComputer={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.getByText('2 / 15 today')).toBeInTheDocument()
    createTopicSpy.mockRestore()
  })

  it('displays outside-data badge on tainted feed proposals and supports follow-up dispatch', async () => {
    const followSpy = vi.spyOn(api, 'followupFeedItem').mockResolvedValue({
      botId: 'scout',
      threadId: 'dm:scout',
      snapshot: { ...SNAPSHOT, unreadCount: 0 },
    })
    const onOpenThread = vi.fn()
    render(
      <FeedView
        state={SNAPSHOT}
        roster={ROSTER}
        onChange={() => {}}
        onOpenThread={onOpenThread}
        onOpenComputer={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )

    expect(screen.getByText('Based on outside data')).toBeInTheDocument()
    expect(screen.getByText('GPU spot prices dropped 15%')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Follow up' }))
    await userEvent.type(screen.getByPlaceholderText('Optional note before handing over…'), 'Check region us-west')
    await userEvent.click(screen.getByRole('button', { name: 'Send to teammate' }))

    expect(followSpy).toHaveBeenCalledWith('feed-11111111', { botId: 'scout', note: 'Check region us-west' })
    expect(onOpenThread).toHaveBeenCalledWith('dm:scout')
    followSpy.mockRestore()
  })

  it('switches to Ideas tab (auto-first from chats), syncs from chats, supports optional manual add, incubates, and dispatches', async () => {
    const distillSpy = vi.spyOn(api, 'distillFeedFromChats').mockResolvedValue({
      ideasAdded: 1,
      todosAdded: 0,
      todosCompleted: 0,
      goalsAdded: 0,
      goalsUpdated: 0,
      snapshot: SNAPSHOT,
    })
    const createSpy = vi.spyOn(api, 'createIdea').mockResolvedValue({
      idea: SNAPSHOT.ideas[0]!,
      snapshot: SNAPSHOT,
    })
    const incSpy = vi.spyOn(api, 'incubateIdea').mockResolvedValue({
      idea: { ...SNAPSHOT.ideas[0]!, status: 'incubating' },
      botId: 'scout',
      threadId: 'dm:scout',
      snapshot: SNAPSHOT,
    })
    const dispSpy = vi.spyOn(api, 'dispatchIdea').mockResolvedValue({
      idea: { ...SNAPSHOT.ideas[0]!, status: 'promoted' },
      botId: 'scout',
      threadId: 'dm:scout',
      snapshot: SNAPSHOT,
    })
    const onOpenThread = vi.fn()
    const chatIdeaSnapshot: FeedSnapshot = {
      ...SNAPSHOT,
      ideas: [
        {
          ...SNAPSHOT.ideas[0]!,
          origin: 'conversation',
          sourceThreadId: 'dm:chief',
        },
      ],
    }
    render(
      <FeedView
        state={chatIdeaSnapshot}
        roster={ROSTER}
        onChange={() => {}}
        onOpenThread={onOpenThread}
        onOpenComputer={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('tab', { name: /Ideas/ }))
    expect(screen.getByText('Automate vendor comparisons')).toBeInTheDocument()
    expect(screen.getByText('From chat')).toBeInTheDocument()
    expect(screen.getByText('Feasible via public pricing APIs.')).toBeInTheDocument()

    // Manual composer is hidden by default until operator opts in
    expect(screen.queryByPlaceholderText(/Drop a rough idea/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Sync from chats/ }))
    expect(distillSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: /Jot manually/ }))
    await userEvent.type(screen.getByPlaceholderText(/Drop a rough idea/), 'Monitor SSL expiries')
    await userEvent.click(screen.getByRole('button', { name: 'Add idea' }))
    expect(createSpy).toHaveBeenCalledWith({ title: 'Monitor SSL expiries' })

    await userEvent.click(screen.getByRole('button', { name: 'Incubate (read-only)' }))
    expect(incSpy).toHaveBeenCalledWith('idea-22222222', { botId: 'scout' })

    await userEvent.click(screen.getByRole('button', { name: 'Hand off to act' }))
    expect(dispSpy).toHaveBeenCalledWith('idea-22222222', { botId: 'scout' })
    expect(onOpenThread).toHaveBeenCalledWith('dm:scout')

    distillSpy.mockRestore()
    createSpy.mockRestore()
    incSpy.mockRestore()
    dispSpy.mockRestore()
  })

  it('renders auto-extracted to-dos in Tracking & Goals and supports toggling, syncing from chats, and dismissing', async () => {
    const todoSnap: FeedSnapshot = {
      ...SNAPSHOT,
      needsYou: [],
      todos: [
        {
          id: 'todo-11111111',
          title: 'Send Q2 pricing recap to Alex',
          detail: 'Include updated GPU tier numbers',
          status: 'open',
          ownerBotId: 'scout',
          sourceThreadId: 'dm:scout',
          origin: 'auto',
          tainted: false,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
      ],
    }
    const updateTodoSpy = vi.spyOn(api, 'updateTodo').mockResolvedValue({
      todo: { ...todoSnap.todos![0]!, status: 'done' },
      snapshot: { ...todoSnap, todos: [{ ...todoSnap.todos![0]!, status: 'done' }] },
    })
    const deleteTodoSpy = vi.spyOn(api, 'deleteTodo').mockResolvedValue({
      snapshot: { ...todoSnap, todos: [] },
    })
    const distillSpy = vi.spyOn(api, 'distillFeedFromChats').mockResolvedValue({
      ideasAdded: 0,
      todosAdded: 1,
      todosCompleted: 0,
      goalsAdded: 0,
      goalsUpdated: 0,
      snapshot: todoSnap,
    })
    const onOpenThread = vi.fn()
    const onRefreshGoals = vi.fn(async () => {})

    render(
      <FeedView
        state={todoSnap}
        roster={ROSTER}
        goals={{ goals: [], activeCount: 0, unlinkedRoutines: [] }}
        onGoalsChange={() => {}}
        onRefreshGoals={onRefreshGoals}
        onChange={() => {}}
        onOpenThread={onOpenThread}
        onOpenComputer={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('tab', { name: /Tracking & Goals/ }))
    expect(screen.getByText('Send Q2 pricing recap to Alex')).toBeInTheDocument()
    expect(screen.getByText('Include updated GPU tier numbers')).toBeInTheDocument()
    expect(screen.getByText('Auto')).toBeInTheDocument()
    expect(screen.getByText('@Scout')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox'))
    expect(updateTodoSpy).toHaveBeenCalledWith('todo-11111111', { status: 'done' })

    await userEvent.click(screen.getByRole('button', { name: 'Open thread' }))
    expect(onOpenThread).toHaveBeenCalledWith('dm:scout')

    await userEvent.click(screen.getByRole('button', { name: /Sync from chats/ }))
    expect(distillSpy).toHaveBeenCalledTimes(1)
    expect(onRefreshGoals).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss to-do' }))
    expect(deleteTodoSpy).toHaveBeenCalledWith('todo-11111111')

    updateTodoSpy.mockRestore()
    deleteTodoSpy.mockRestore()
    distillSpy.mockRestore()
  })

  it('promotes a tainted idea to a goal after surfacing an outside-data review warning', async () => {
    const taintedIdea = { ...SNAPSHOT.ideas[0]!, tainted: true }
    const goalSnap = { goals: [], activeCount: 1, unlinkedRoutines: [] }
    const createGoalSpy = vi.spyOn(api, 'createGoal').mockResolvedValue({
      goal: {
        id: 'goal-99999999',
        title: taintedIdea.title,
        description: '',
        successCriteria: 'Weekly sheet ready',
        status: 'active',
        ownerBotId: 'scout',
        memberBotIds: [],
        targetDate: null,
        sourceIdeaId: taintedIdea.id,
        createdAt: 1,
        updatedAt: 1,
        milestones: [],
        doneMilestones: 0,
        totalMilestones: 0,
        recentUpdates: [],
        routines: [],
        recentActions: [],
      },
      snapshot: goalSnap,
    })
    const fetchFeedSpy = vi.spyOn(api, 'fetchFeed').mockResolvedValue({
      ...SNAPSHOT,
      ideas: [{ ...taintedIdea, status: 'promoted', promotedGoalId: 'goal-99999999' }],
    })
    const onOpenGoals = vi.fn()
    const onGoalCreated = vi.fn()

    render(
      <FeedView
        state={{ ...SNAPSHOT, ideas: [taintedIdea] }}
        roster={ROSTER}
        onChange={() => {}}
        onOpenThread={() => {}}
        onOpenComputer={() => {}}
        onOpenGoals={onOpenGoals}
        onGoalCreated={onGoalCreated}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('tab', { name: /Ideas/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Promote to goal' }))
    expect(screen.getByText(/This idea came from outside data/)).toBeInTheDocument()

    await userEvent.type(screen.getByPlaceholderText('What does "done" look like?'), 'Weekly sheet ready')
    await userEvent.click(screen.getByRole('button', { name: 'Create goal' }))

    expect(createGoalSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Automate vendor comparisons',
      successCriteria: 'Weekly sheet ready',
      ownerBotId: 'scout',
      sourceIdeaId: 'idea-22222222',
    }))
    expect(onGoalCreated).toHaveBeenCalledWith(goalSnap)
    expect(onOpenGoals).toHaveBeenCalledTimes(1)

    createGoalSpy.mockRestore()
    fetchFeedSpy.mockRestore()
  })

  it('hosts Feed, Ideas, Tracking & Goals, and Spaces as icon-equipped secondary tabs in exact order', async () => {
    const goalSnap = {
      goals: [
        {
          id: 'goal-11111111',
          title: 'Q2 Pricing Audit',
          description: '',
          successCriteria: 'Comparison complete',
          status: 'active' as const,
          ownerBotId: 'chief',
          memberBotIds: [],
          targetDate: null,
          sourceIdeaId: null,
          createdAt: 1,
          updatedAt: 1,
          milestones: [],
          doneMilestones: 0,
          totalMilestones: 0,
          recentUpdates: [],
          routines: [],
          recentActions: [],
          spaces: [{ id: 'space-11111111', title: 'Vendor Board', icon: '📊' }],
        },
      ],
      activeCount: 1,
      unlinkedRoutines: [],
    }
    const spaceSnap = {
      spaces: [
        {
          id: 'space-11111111',
          slug: 'vendor_board',
          title: 'Vendor Board',
          description: 'Pricing tracker',
          icon: '📊',
          kind: 'declarative' as const,
          goalId: 'goal-11111111',
          goalTitle: 'Q2 Pricing Audit',
          schema: { blocks: [{ id: 'notes', type: 'markdown' as const, title: 'Notes', content: 'Hello board' }] },
          items: [],
          grants: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      templates: [{ id: 'tracker' as const, icon: '📊' }],
    }
    render(
      <FeedView
        state={SNAPSHOT}
        roster={ROSTER}
        goals={goalSnap}
        onGoalsChange={() => {}}
        onRefreshGoals={async () => {}}
        spaces={spaceSnap}
        onSpacesChange={() => {}}
        onChange={() => {}}
        onOpenThread={() => {}}
        onOpenComputer={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((el) => el.textContent?.replace(/\d+$/, '').trim())).toEqual([
      'Feed',
      'Ideas',
      'Tracking & Goals',
      'Spaces',
    ])
    expect(tabs.every((el) => el.querySelector('svg') !== null)).toBe(true)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')

    await userEvent.click(screen.getByRole('tab', { name: /Tracking & Goals/ }))
    expect(screen.getByText('Q2 Pricing Audit')).toBeInTheDocument()
    // Jumping from linked Space pill inside Goal switches cleanly to Spaces tab
    await userEvent.click(screen.getByRole('button', { name: /Vendor Board/ }))
    expect(screen.getByText('Hello board')).toBeInTheDocument()
  })
})
