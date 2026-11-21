import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { GoalsSnapshot, GoalView } from '../types'
import { GoalsView } from './GoalsView'

const ROSTER = {
  chief: { name: 'Chief', emoji: '🧠' },
  scout: { name: 'Scout', emoji: '🔎' },
}

const GOAL_ACTIVE: GoalView = {
  id: 'goal-11111111',
  title: 'Q2 Competitor Audit',
  description: 'Compare top 5 rivals on pricing.',
  successCriteria: 'Exec sheet signed off.',
  status: 'active',
  ownerBotId: 'chief',
  memberBotIds: ['scout'],
  targetDate: '2026-06-30',
  sourceIdeaId: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  milestones: [
    {
      id: 'ms-11111111',
      goalId: 'goal-11111111',
      title: 'Collect pricing pages',
      status: 'open',
      ownerBotId: 'scout',
      dueDate: '2026-05-20',
      sortOrder: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  ],
  doneMilestones: 0,
  totalMilestones: 1,
  recentUpdates: [
    {
      id: 1,
      goalId: 'goal-11111111',
      authorKind: 'bot',
      botId: 'scout',
      kind: 'note',
      summary: 'Checked 3 pricing pages.',
      diff: '+ Checked 3 pricing pages.',
      tainted: true,
      threadId: 'dm:scout',
      createdAt: 1_700_000_100_000,
    },
  ],
  routines: [],
  recentActions: [],
}

const SNAPSHOT: GoalsSnapshot = {
  goals: [GOAL_ACTIVE],
  activeCount: 1,
  unlinkedRoutines: [
    {
      id: 5,
      botId: 'scout',
      name: 'Pricing Watch',
      cron: '0 9 * * 1',
      human: 'every Monday at 09:00',
      mode: 'watch',
      surface: 'both',
      enabled: true,
      lastRunAt: null,
      goalId: null,
    },
  ],
}

describe('GoalsView', () => {
  it('creates a new goal with initial milestones from the form', async () => {
    const createSpy = vi.spyOn(api, 'createGoal').mockResolvedValue({
      goal: GOAL_ACTIVE,
      snapshot: SNAPSHOT,
    })
    const onChange = vi.fn()
    render(
      <GoalsView
        state={{ goals: [], activeCount: 0, unlinkedRoutines: [] }}
        roster={ROSTER}
        onChange={onChange}
        onRefresh={async () => {}}
        onOpenThread={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'New goal' }))
    await userEvent.type(screen.getByPlaceholderText(/Q2 Competitor Pricing Audit/), 'Launch v3')
    await userEvent.type(screen.getByPlaceholderText(/What does "done" look like/), 'Zero P0 bugs')
    await userEvent.type(screen.getByPlaceholderText(/Collect top 5 competitor/), 'Write docs\nRun beta')
    await userEvent.click(screen.getByRole('button', { name: 'Save goal' }))

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Launch v3',
      successCriteria: 'Zero P0 bugs',
      ownerBotId: 'chief',
      milestones: ['Write docs', 'Run beta'],
    }))
    expect(onChange).toHaveBeenCalledWith(SNAPSHOT)
    createSpy.mockRestore()
  })

  it('toggles milestones, posts progress notes, links an existing routine, and starts a check-in turn', async () => {
    const msSpy = vi.spyOn(api, 'updateGoalMilestone').mockResolvedValue({
      milestone: { ...GOAL_ACTIVE.milestones[0]!, status: 'done' },
      goal: { ...GOAL_ACTIVE, doneMilestones: 1 },
      snapshot: SNAPSHOT,
    })
    const noteSpy = vi.spyOn(api, 'addGoalUpdate').mockResolvedValue({
      update: GOAL_ACTIVE.recentUpdates[0]!,
      goal: GOAL_ACTIVE,
      snapshot: SNAPSHOT,
    })
    const linkSpy = vi.spyOn(api, 'setRoutineGoal').mockResolvedValue()
    const checkinSpy = vi.spyOn(api, 'checkinGoal').mockResolvedValue({
      botId: 'chief',
      threadId: 'dm:chief',
      snapshot: SNAPSHOT,
    })
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    const onOpenThread = vi.fn()

    render(
      <GoalsView
        state={SNAPSHOT}
        roster={ROSTER}
        onChange={() => {}}
        onRefresh={onRefresh}
        onOpenThread={onOpenThread}
      />,
    )

    expect(screen.getByText('Q2 Competitor Audit')).toBeInTheDocument()
    expect(screen.getByText('Exec sheet signed off.')).toBeInTheDocument()
    expect(screen.getByText('Based on outside data')).toBeInTheDocument()

    // Toggle milestone checkbox
    await userEvent.click(screen.getByRole('checkbox', { name: 'Collect pricing pages' }))
    expect(msSpy).toHaveBeenCalledWith('goal-11111111', 'ms-11111111', { status: 'done' })

    // Post manual progress note
    await userEvent.type(screen.getByPlaceholderText('Log a quick progress note…'), 'Focus on EU plans')
    await userEvent.click(screen.getByRole('button', { name: 'Post note' }))
    expect(noteSpy).toHaveBeenCalledWith('goal-11111111', 'Focus on EU plans')

    // Link existing routine
    await userEvent.selectOptions(screen.getByLabelText('Link an existing routine…'), '5')
    await userEvent.click(screen.getByRole('button', { name: 'Link' }))
    expect(linkSpy).toHaveBeenCalledWith(5, 'goal-11111111')
    expect(onRefresh).toHaveBeenCalledTimes(1)

    // Kick off check-in
    await userEvent.click(screen.getByRole('button', { name: 'Check in' }))
    await userEvent.type(screen.getByPlaceholderText('Optional direction for this check-in…'), 'Prioritize tier 1')
    await userEvent.click(screen.getByRole('button', { name: 'Start check-in' }))
    expect(checkinSpy).toHaveBeenCalledWith('goal-11111111', { botId: 'chief', note: 'Prioritize tier 1' })
    expect(onOpenThread).toHaveBeenCalledWith('dm:chief')

    msSpy.mockRestore()
    noteSpy.mockRestore()
    linkSpy.mockRestore()
    checkinSpy.mockRestore()
  })
})
