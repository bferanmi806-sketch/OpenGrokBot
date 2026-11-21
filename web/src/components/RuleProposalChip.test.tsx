import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import { I18nProvider } from '../i18n'
import type { RuleProposalPayload } from '../types'
import { MAX_RULE_CHARS, RuleProposalChip } from './RuleProposalChip'

const pending = (over: Partial<RuleProposalPayload> = {}): RuleProposalPayload => ({
  proposalId: 12,
  rule: 'Do not email bob@acme.com without asking first',
  reason: 'You discarded 2 similar email requests for bob@acme.com in the past 14 days.',
  source: 'discard_pattern',
  sourceTainted: false,
  status: 'pending',
  ...over,
})

describe('RuleProposalChip', () => {
  it('renders pending proposal with source label, reason, prefilled editable textarea, and counter', () => {
    render(<RuleProposalChip payload={pending()} onResolve={() => {}} />)
    expect(screen.getByText('Rule proposal')).toBeInTheDocument()
    expect(screen.getByText('Suggested from repeated discards')).toBeInTheDocument()
    expect(screen.getByText(/You discarded 2 similar email requests/)).toBeInTheDocument()
    const textarea = screen.getByLabelText('Standing rule (editable)') as HTMLTextAreaElement
    expect(textarea.value).toBe('Do not email bob@acme.com without asking first')
    expect(screen.getByText(`${textarea.value.length} / ${MAX_RULE_CHARS}`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save to MEMORY.md' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('shows the amber external-source warning only when sourceTainted is true', () => {
    const { rerender } = render(<RuleProposalChip payload={pending({ source: 'agent', sourceTainted: false })} onResolve={() => {}} />)
    expect(screen.getByText('Suggested by teammate')).toBeInTheDocument()
    expect(screen.queryByText('External source — review carefully')).toBeNull()

    rerender(<RuleProposalChip payload={pending({ source: 'agent', sourceTainted: true })} onResolve={() => {}} />)
    expect(screen.getByRole('note')).toHaveTextContent('External source — review carefully')
  })

  it('collapses whitespace/newlines and calls onResolve with edited rule on Save', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuleProposalChip payload={pending()} onResolve={onResolve} />)

    const textarea = screen.getByLabelText('Standing rule (editable)')
    await user.clear(textarea)
    fireEvent.change(textarea, { target: { value: '  Never email   bob@acme.com\non Fridays  ' } })
    await user.click(screen.getByRole('button', { name: 'Save to MEMORY.md' }))

    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith(12, 'accept', 'Never email bob@acme.com on Fridays')
    })
  })

  it('validates empty and >300 char rules inline without calling onResolve', async () => {
    const onResolve = vi.fn()
    const user = userEvent.setup()
    render(<RuleProposalChip payload={pending()} onResolve={onResolve} />)

    const textarea = screen.getByLabelText('Standing rule (editable)')
    await user.clear(textarea)
    await user.type(textarea, '   ')
    await user.click(screen.getByRole('button', { name: 'Save to MEMORY.md' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a standing rule before saving.')
    expect(onResolve).not.toHaveBeenCalled()

    const tooLong = 'a'.repeat(MAX_RULE_CHARS + 1)
    fireEvent.change(textarea, { target: { value: tooLong } })
    expect(screen.getByText(`${MAX_RULE_CHARS + 1} / ${MAX_RULE_CHARS}`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save to MEMORY.md' }))
    expect(screen.getByRole('alert')).toHaveTextContent(`Rule must be ${MAX_RULE_CHARS} characters or fewer.`)
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('calls onResolve with dismiss when clicking Dismiss', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuleProposalChip payload={pending()} onResolve={onResolve} />)

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith(12, 'dismiss')
    })
  })

  it('recovers and shows inline error when onResolve rejects', async () => {
    const onResolve = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new ApiError('Rule already settled', 409))
    const user = userEvent.setup()
    render(<RuleProposalChip payload={pending()} onResolve={onResolve} />)

    const saveBtn = screen.getByRole('button', { name: 'Save to MEMORY.md' })
    await user.click(saveBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update this rule proposal. Try again.')
    expect(saveBtn).not.toBeDisabled()

    await user.click(saveBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent('Rule already settled')
    expect(saveBtn).not.toBeDisabled()
  })

  it('renders resolved accepted, accepted+edited, and dismissed states', () => {
    const { rerender } = render(
      <RuleProposalChip payload={pending({ status: 'accepted', edited: false })} />,
    )
    expect(screen.getByText('Saved to MEMORY.md')).toBeInTheDocument()
    expect(screen.getByText('Do not email bob@acme.com without asking first')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()

    rerender(
      <RuleProposalChip payload={pending({ status: 'accepted', edited: true, sourceTainted: true })} />,
    )
    expect(screen.getByText('Saved to MEMORY.md · edited')).toBeInTheDocument()
    expect(screen.getByText('External source — review carefully')).toBeInTheDocument()

    rerender(
      <I18nProvider lang="zh-CN">
        <RuleProposalChip payload={pending({ status: 'dismissed' })} />
      </I18nProvider>,
    )
    expect(screen.getByText('已忽略此规矩提议')).toBeInTheDocument()
    expect(screen.getByText('根据多次驳回自动提议')).toBeInTheDocument()
  })

  it('resets draft when proposalId changes', () => {
    const { rerender } = render(<RuleProposalChip payload={pending({ proposalId: 1, rule: 'First rule' })} onResolve={() => {}} />)
    const textarea = screen.getByLabelText('Standing rule (editable)') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Edited first' } })
    expect(textarea.value).toBe('Edited first')

    rerender(<RuleProposalChip payload={pending({ proposalId: 2, rule: 'Second rule' })} onResolve={() => {}} />)
    expect((screen.getByLabelText('Standing rule (editable)') as HTMLTextAreaElement).value).toBe('Second rule')
  })
})
