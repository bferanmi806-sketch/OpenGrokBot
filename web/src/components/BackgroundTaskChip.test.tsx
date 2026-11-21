import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import { I18nProvider } from '../i18n'
import type { BackgroundTaskPayload, BackgroundTaskStep } from '../types'
import { BackgroundTaskChip, MAX_BG_STEER_CHARS } from './BackgroundTaskChip'

const makePayload = (over: Partial<BackgroundTaskPayload> = {}): BackgroundTaskPayload => ({
  taskId: 'bg-a1b2c3d4',
  title: 'Compile Q3 competitor pricing matrix',
  status: 'running',
  stepCount: 2,
  lastStep: 'browser_extract: pricing table',
  steps: [
    { tool: 'browser_goto', summary: 'https://competitor.example/pricing', ok: true, ms: 420, at: 1000 },
    { tool: 'browser_extract', summary: 'pricing table', ok: true, ms: 1350, at: 2000 },
  ],
  usesBrowser: true,
  createdAt: 1000,
  startedAt: 1100,
  finishedAt: null,
  ...over,
})

describe('BackgroundTaskChip', () => {
  it('renders status variants, browser badge only while active, and step count or lastStep fallback', () => {
    const { rerender } = render(<BackgroundTaskChip payload={makePayload({ status: 'queued', stepCount: 0, steps: [], lastStep: '' })} />)
    expect(screen.getByText('Background task')).toBeInTheDocument()
    expect(screen.getByText('Queued')).toBeInTheDocument()
    expect(screen.getByText('Using browser')).toBeInTheDocument()
    expect(screen.getByText('Compile Q3 competitor pricing matrix')).toBeInTheDocument()

    rerender(<BackgroundTaskChip payload={makePayload({ status: 'running', stepCount: 1, steps: [], lastStep: 'wiki_search: pricing' })} />)
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('1 step')).toBeInTheDocument()
    expect(screen.getByText('wiki_search: pricing')).toBeInTheDocument()
    expect(screen.getByText('Using browser')).toBeInTheDocument()

    rerender(<BackgroundTaskChip payload={makePayload({ status: 'running', usesBrowser: false })} />)
    expect(screen.queryByText('Using browser')).toBeNull()
    expect(screen.getByText('2 steps')).toBeInTheDocument()

    rerender(<BackgroundTaskChip payload={makePayload({ status: 'completed', usesBrowser: true, summary: 'Saved **3 tiers** to `/workspace/pricing.md`.' })} />)
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByText('Using browser')).toBeNull()
    expect(screen.getByText('3 tiers').tagName).toBe('STRONG')
    expect(screen.getByText('/workspace/pricing.md').tagName).toBe('CODE')
    expect(screen.queryByPlaceholderText('Send a steering note…')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()

    rerender(<BackgroundTaskChip payload={makePayload({ status: 'failed', usesBrowser: true, error: 'Upstream timeout after 30s.' })} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText('Using browser')).toBeNull()
    expect(screen.getByText('Upstream timeout after 30s.')).toBeInTheDocument()

    rerender(<BackgroundTaskChip payload={makePayload({ status: 'cancelled', usesBrowser: true, error: 'Gateway restarted before this background task finished.' })} />)
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.queryByText('Using browser')).toBeNull()
    expect(screen.getByText('Gateway restarted before this background task finished.')).toBeInTheDocument()
  })

  it('shows last 3 steps by default, expands and collapses when >3 steps, and highlights steer and failed steps', async () => {
    const steps: BackgroundTaskStep[] = [
      { tool: 'wiki_search', summary: 'step one', ok: true, ms: 50, at: 1 },
      { tool: 'read_file', summary: 'step two', ok: false, ms: 80, at: 2 },
      { tool: 'steer', summary: 'Focus on enterprise tier only', ok: true, at: 3 },
      { tool: 'browser_goto', summary: 'step four', ok: true, ms: 1200, at: 4 },
      { tool: 'write_file', summary: 'step five', ok: true, ms: 40, at: 5 },
    ]
    const user = userEvent.setup()
    const { container } = render(
      <BackgroundTaskChip payload={makePayload({ stepCount: 5, steps })} />,
    )

    // Only last 3 visible initially
    expect(screen.queryByText('step one')).toBeNull()
    expect(screen.queryByText('step two')).toBeNull()
    expect(screen.getByText('Focus on enterprise tier only')).toBeInTheDocument()
    expect(screen.getByText('step four')).toBeInTheDocument()
    expect(screen.getByText('step five')).toBeInTheDocument()
    expect(container.querySelector('.bg-task-steps li.steer')).not.toBeNull()

    // Expand all 5 steps
    const toggle = screen.getByRole('button', { name: 'Show all 5 steps' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)

    expect(screen.getByText('step one')).toBeInTheDocument()
    expect(screen.getByText('step two')).toBeInTheDocument()
    expect(container.querySelector('.bg-task-steps li.failed')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Hide earlier steps' })).toHaveAttribute('aria-expanded', 'true')

    // Collapse back
    await user.click(screen.getByRole('button', { name: 'Hide earlier steps' }))
    expect(screen.queryByText('step one')).toBeNull()
    expect(screen.getByText('step five')).toBeInTheDocument()
  })

  it('validates empty and >1000 char steering notes inline without calling onSteer', async () => {
    const onSteer = vi.fn()
    const user = userEvent.setup()
    render(<BackgroundTaskChip payload={makePayload()} onSteer={onSteer} />)

    const input = screen.getByPlaceholderText('Send a steering note…')
    const steerBtn = screen.getByRole('button', { name: 'Steer' })

    // Empty / whitespace only
    await user.type(input, '   ')
    await user.click(steerBtn)
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a steering note first.')
    expect(onSteer).not.toHaveBeenCalled()

    // Exceeds MAX_BG_STEER_CHARS
    fireEvent.change(input, { target: { value: 'x'.repeat(MAX_BG_STEER_CHARS + 1) } })
    await user.click(steerBtn)
    expect(screen.getByRole('alert')).toHaveTextContent(`Steering note must be ${MAX_BG_STEER_CHARS} characters or fewer.`)
    expect(onSteer).not.toHaveBeenCalled()
  })

  it('submits trimmed steering note, clears input on success, and supports subsequent notes', async () => {
    const onSteer = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<BackgroundTaskChip payload={makePayload()} onSteer={onSteer} />)

    const input = screen.getByPlaceholderText('Send a steering note…') as HTMLInputElement
    await user.type(input, '  Skip annual plans  ')
    await user.click(screen.getByRole('button', { name: 'Steer' }))

    await waitFor(() => {
      expect(onSteer).toHaveBeenCalledWith('bg-a1b2c3d4', 'Skip annual plans')
    })
    expect(input.value).toBe('')
    expect(input).not.toBeDisabled()
  })

  it('recovers and shows localized inline errors when steer fails', async () => {
    const onSteer = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new ApiError('task already completed', 409, 'settled'))
      .mockRejectedValueOnce(new ApiError('invalid note', 400, 'invalid_note'))
    const user = userEvent.setup()
    render(<BackgroundTaskChip payload={makePayload()} onSteer={onSteer} />)

    const input = screen.getByPlaceholderText('Send a steering note…') as HTMLInputElement
    const steerBtn = screen.getByRole('button', { name: 'Steer' })

    await user.type(input, 'Try this')
    await user.click(steerBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not steer this task.')
    expect(input.value).toBe('Try this')
    expect(steerBtn).not.toBeDisabled()

    await user.click(steerBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent('This background task has already finished.')
    expect(steerBtn).not.toBeDisabled()

    await user.click(steerBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a steering note (1–1,000 characters).')
  })

  it('guards synchronous double-click on steer and cancel via inFlightRef', async () => {
    let resolveSteer!: () => void
    const onSteer = vi.fn(() => new Promise<void>((r) => { resolveSteer = r }))
    let resolveCancel!: () => void
    const onCancel = vi.fn(() => new Promise<void>((r) => { resolveCancel = r }))

    const { rerender } = render(<BackgroundTaskChip payload={makePayload()} onSteer={onSteer} onCancel={onCancel} />)

    const input = screen.getByPlaceholderText('Send a steering note…')
    fireEvent.change(input, { target: { value: 'Check EU pricing' } })
    const steerBtn = screen.getByRole('button', { name: 'Steer' })
    fireEvent.click(steerBtn)
    fireEvent.click(steerBtn)
    expect(onSteer).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()

    resolveSteer()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Steer' })).not.toBeDisabled()
    })

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
    fireEvent.click(cancelBtn)
    fireEvent.click(cancelBtn)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()

    resolveCancel()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()
    })

    // Once payload status settles, controls disappear
    rerender(<BackgroundTaskChip payload={makePayload({ status: 'cancelled' })} onSteer={onSteer} onCancel={onCancel} />)
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
  })

  it('disables steer and cancel when callbacks are omitted and recovers on cancel failure', async () => {
    const { rerender } = render(<BackgroundTaskChip payload={makePayload()} />)
    expect(screen.getByPlaceholderText('Send a steering note…')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Steer' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    const onCancel = vi.fn().mockRejectedValueOnce(new Error('failed'))
    rerender(<BackgroundTaskChip payload={makePayload()} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not cancel this task.')
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled()
  })

  it('renders cleanly in zh-CN and survives malformed steps', async () => {
    const onSteer = vi.fn().mockRejectedValueOnce(new ApiError('already done', 409, 'settled'))
    const malformed = makePayload({
      steps: null as unknown as BackgroundTaskStep[],
      lastStep: 'shell: python analyze.py',
    })
    render(
      <I18nProvider lang="zh-CN">
        <BackgroundTaskChip payload={malformed} onSteer={onSteer} onCancel={() => {}} />
      </I18nProvider>,
    )
    expect(screen.getByText('后台任务')).toBeInTheDocument()
    expect(screen.getByText('运行中')).toBeInTheDocument()
    expect(screen.getByText('占用浏览器')).toBeInTheDocument()
    expect(screen.getByText('2 步')).toBeInTheDocument()
    expect(screen.getByText('shell: python analyze.py')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消任务' })).toBeInTheDocument()

    const input = screen.getByPlaceholderText('发送纠偏指令…')
    await userEvent.type(input, '优先处理重点客户')
    await userEvent.click(screen.getByRole('button', { name: '发送纠偏' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('这项后台任务已经结束了。')
  })

  it('resets local draft and error when taskId changes', async () => {
    const onSteer = vi.fn()
    const { rerender } = render(<BackgroundTaskChip payload={makePayload({ taskId: 'bg-11111111' })} onSteer={onSteer} />)
    const input = screen.getByPlaceholderText('Send a steering note…') as HTMLInputElement
    await userEvent.click(screen.getByRole('button', { name: 'Steer' }))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await userEvent.type(input, 'Draft note')
    expect(input.value).toBe('Draft note')

    rerender(<BackgroundTaskChip payload={makePayload({ taskId: 'bg-22222222' })} onSteer={onSteer} />)
    expect((screen.getByPlaceholderText('Send a steering note…') as HTMLInputElement).value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
