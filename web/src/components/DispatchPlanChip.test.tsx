import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import { I18nProvider } from '../i18n'
import type { DispatchPlanPayload, DispatchStepView } from '../types'
import { DispatchPlanChip } from './DispatchPlanChip'

const roster = {
  researcher: { name: 'Scout', emoji: '🔎' },
  'market-watch': { name: 'Ticker', emoji: '📈' },
  'inbox-keeper': { name: 'Post', emoji: '📬' },
}

const makeStep = (over: Partial<DispatchStepView> = {}): DispatchStepView => ({
  id: 's1',
  seq: 0,
  wave: 0,
  botId: 'researcher',
  title: 'Gather competitor benchmarks',
  instructions: 'Write summary into team wiki.',
  dependsOn: [],
  status: 'pending',
  output: '',
  error: '',
  outputTainted: false,
  waitingApprovalId: null,
  waitingQuestionId: null,
  startedAt: null,
  finishedAt: null,
  ...over,
})

const makePayload = (over: Partial<DispatchPlanPayload> = {}): DispatchPlanPayload => ({
  planId: 'dp-a1b2c3d4',
  threadId: 'group:offsite-crew',
  createdBy: 'chief',
  title: 'Q3 pricing & outreach pipeline',
  status: 'draft',
  sourceTainted: false,
  error: '',
  steps: [
    makeStep({ id: 's2', seq: 1, wave: 1, botId: 'market-watch', title: 'Model pricing tiers', dependsOn: ['s1'] }),
    makeStep({ id: 's1', seq: 0, wave: 0, botId: 'researcher', title: 'Gather competitor benchmarks', dependsOn: [] }),
    makeStep({ id: 's3', seq: 2, wave: 2, botId: 'unknown-bot', title: 'Draft launch memo', dependsOn: ['s1', 's2'] }),
  ],
  createdAt: 1000,
  startedAt: null,
  finishedAt: null,
  ...over,
})

describe('DispatchPlanChip', () => {
  it('renders draft plan ordered by seq with wave, roster assignee, fallback @id, deps, tainted badge, and draft actions', () => {
    const { container } = render(
      <DispatchPlanChip
        payload={makePayload({ sourceTainted: true })}
        roster={roster}
        onStart={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByText('Dispatch pipeline')).toBeInTheDocument()
    expect(screen.getByText('Draft · ready to start')).toBeInTheDocument()
    expect(screen.getByText('External source — review before starting')).toBeInTheDocument()
    expect(screen.getByText('Q3 pricing & outreach pipeline')).toBeInTheDocument()

    // Ordered by seq (s1 -> s2 -> s3)
    const stepTitles = [...container.querySelectorAll('.dispatch-step-title')].map((el) => el.textContent)
    expect(stepTitles).toEqual([
      'Gather competitor benchmarks',
      'Model pricing tiers',
      'Draft launch memo',
    ])

    expect(screen.getByText('Stage 1')).toBeInTheDocument()
    expect(screen.getByText('Stage 2')).toBeInTheDocument()
    expect(screen.getByText('Stage 3')).toBeInTheDocument()
    expect(screen.getByText('🔎 Scout')).toBeInTheDocument()
    expect(screen.getByText('📈 Ticker')).toBeInTheDocument()
    expect(screen.getByText('@unknown-bot')).toBeInTheDocument()
    expect(screen.getByText('After s1')).toBeInTheDocument()
    expect(screen.getByText('After s1, s2')).toBeInTheDocument()
    expect(screen.getByText(/Review the steps above/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start pipeline' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel pipeline' })).toBeEnabled()
  })

  it('guards synchronous double-click on Start and Cancel via inFlightRef', async () => {
    let resolveStart!: () => void
    const onStart = vi.fn(() => new Promise<void>((r) => { resolveStart = r }))
    let resolveCancel!: () => void
    const onCancel = vi.fn(() => new Promise<void>((r) => { resolveCancel = r }))

    const { rerender } = render(
      <DispatchPlanChip payload={makePayload()} roster={roster} onStart={onStart} onCancel={onCancel} />,
    )

    const startBtn = screen.getByRole('button', { name: 'Start pipeline' })
    fireEvent.click(startBtn)
    fireEvent.click(startBtn)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith('dp-a1b2c3d4')
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel pipeline' })).toBeDisabled()

    resolveStart()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start pipeline' })).toBeEnabled()
    })

    rerender(
      <DispatchPlanChip
        payload={makePayload({ status: 'running' })}
        roster={roster}
        onStart={onStart}
        onCancel={onCancel}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Start pipeline' })).toBeNull()

    const cancelBtn = screen.getByRole('button', { name: 'Cancel pipeline' })
    fireEvent.click(cancelBtn)
    fireEvent.click(cancelBtn)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledWith('dp-a1b2c3d4')
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()

    resolveCancel()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel pipeline' })).toBeEnabled()
    })
  })

  it('toggles step markdown output and renders paused, completed, failed, and cancelled states cleanly', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <DispatchPlanChip
        payload={makePayload({
          status: 'paused',
          steps: [
            makeStep({ id: 's1', seq: 0, wave: 0, status: 'completed', output: 'Saved **3 benchmarks** to `wiki/q3.md`.' }),
            makeStep({ id: 's2', seq: 1, wave: 1, botId: 'market-watch', status: 'waiting_approval', dependsOn: ['s1'] }),
          ],
        })}
        roster={roster}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByText('Waiting on approval')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('Waiting on you')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel pipeline' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Start pipeline' })).toBeNull()

    // Output starts collapsed
    expect(screen.queryByText('3 benchmarks')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'View output' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(screen.getByText('3 benchmarks').tagName).toBe('STRONG')
    expect(screen.getByText('wiki/q3.md').tagName).toBe('CODE')
    expect(screen.getByRole('button', { name: 'Hide output' })).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'Hide output' }))
    expect(screen.queryByText('3 benchmarks')).toBeNull()

    // Failed plan with step error and skipped downstream step
    rerender(
      <DispatchPlanChip
        payload={makePayload({
          status: 'failed',
          error: 'One or more steps failed.',
          steps: [
            makeStep({ id: 's1', seq: 0, wave: 0, status: 'failed', error: 'Approval discarded by operator.' }),
            makeStep({ id: 's2', seq: 1, wave: 1, botId: 'market-watch', status: 'skipped', dependsOn: ['s1'] }),
          ],
        })}
        roster={roster}
      />,
    )
    expect(screen.getAllByText('Failed')).toHaveLength(2)
    expect(screen.getByText('Skipped')).toBeInTheDocument()
    expect(screen.getByText('Approval discarded by operator.')).toBeInTheDocument()
    expect(screen.getByText('One or more steps failed.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel pipeline' })).toBeNull()

    // Completed plan hides footer
    rerender(
      <DispatchPlanChip
        payload={makePayload({
          status: 'completed',
          steps: [makeStep({ id: 's1', seq: 0, wave: 0, status: 'completed' })],
        })}
        roster={roster}
      />,
    )
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel pipeline' })).toBeNull()

    // Cancelled plan hides footer and shows cancelled steps
    rerender(
      <DispatchPlanChip
        payload={makePayload({
          status: 'cancelled',
          error: 'Gateway restarted before this pipeline finished.',
          steps: [makeStep({ id: 's1', seq: 0, wave: 0, status: 'cancelled' })],
        })}
        roster={roster}
      />,
    )
    expect(screen.getAllByText('Cancelled')).toHaveLength(2)
    expect(screen.getByText('Gateway restarted before this pipeline finished.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel pipeline' })).toBeNull()
  })

  it('recovers and shows localized errors on Start/Cancel failure including 409 alreadySettled, and disables when callbacks omitted', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<DispatchPlanChip payload={makePayload()} roster={roster} />)
    expect(screen.getByRole('button', { name: 'Start pipeline' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel pipeline' })).toBeDisabled()

    const onStart = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new ApiError('Plan already running', 409, 'invalid_state'))
    const onCancel = vi.fn()
      .mockRejectedValueOnce(new ApiError('Already completed', 409, 'settled'))
      .mockRejectedValueOnce(new Error('timeout'))

    rerender(<DispatchPlanChip payload={makePayload()} roster={roster} onStart={onStart} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: 'Start pipeline' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start this pipeline.')

    await user.click(screen.getByRole('button', { name: 'Start pipeline' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This pipeline was already updated.')

    await user.click(screen.getByRole('button', { name: 'Cancel pipeline' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This pipeline was already updated.')

    await user.click(screen.getByRole('button', { name: 'Cancel pipeline' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not cancel this pipeline.')
  })

  it('renders cleanly in zh-CN and survives malformed steps and dependsOn arrays', () => {
    const malformed = makePayload({
      sourceTainted: true,
      steps: null as unknown as DispatchStepView[],
    })
    const { rerender } = render(
      <I18nProvider lang="zh-CN">
        <DispatchPlanChip payload={malformed} roster={roster} onStart={() => {}} onCancel={() => {}} />
      </I18nProvider>,
    )
    expect(screen.getByText('协作流水线')).toBeInTheDocument()
    expect(screen.getByText('草稿 · 待启动')).toBeInTheDocument()
    expect(screen.getByText('含外部内容，启动前请核对')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '启动执行' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消流水线' })).toBeInTheDocument()

    const withBadDeps = makePayload({
      steps: [
        makeStep({ id: 's1', dependsOn: null as unknown as string[] }),
      ],
    })
    rerender(
      <I18nProvider lang="zh-CN">
        <DispatchPlanChip payload={withBadDeps} roster={roster} onStart={() => {}} onCancel={() => {}} />
      </I18nProvider>,
    )
    expect(screen.getByText('阶段 1')).toBeInTheDocument()
    expect(screen.getByText('等待中')).toBeInTheDocument()

    // Prototype-key status falls back cleanly instead of indexing Object.prototype
    const protoStatus = makePayload({
      status: 'toString' as unknown as DispatchPlanPayload['status'],
      steps: [makeStep({ id: 's1', status: 'constructor' as unknown as DispatchStepView['status'] })],
    })
    rerender(<DispatchPlanChip payload={protoStatus} roster={roster} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })
})
