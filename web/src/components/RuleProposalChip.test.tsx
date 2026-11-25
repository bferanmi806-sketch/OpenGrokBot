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

  it('renders dreaming source label and tainted badge in EN and zh-CN across pending and resolved states', () => {
    const { rerender } = render(
      <RuleProposalChip
        payload={pending({
          source: 'dreaming',
          sourceTainted: false,
          reason: 'You asked twice not to push package delivery updates.',
        })}
        onResolve={() => {}}
      />,
    )
    expect(screen.getByText('Suggested from your feedback')).toBeInTheDocument()
    expect(screen.queryByRole('note')).toBeNull()

    rerender(
      <RuleProposalChip
        payload={pending({
          source: 'dreaming',
          sourceTainted: true,
        })}
        onResolve={() => {}}
      />,
    )
    expect(screen.getByText('Suggested from your feedback')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('External source — review carefully')

    rerender(
      <RuleProposalChip
        payload={pending({
          source: 'dreaming',
          sourceTainted: true,
          status: 'accepted',
          edited: false,
        })}
      />,
    )
    expect(screen.getByText('Saved to MEMORY.md')).toBeInTheDocument()
    expect(screen.getByText('Suggested from your feedback')).toBeInTheDocument()
    expect(screen.getByText('External source — review carefully')).toBeInTheDocument()

    rerender(
      <I18nProvider lang="zh-CN">
        <RuleProposalChip
          payload={pending({
            source: 'dreaming',
            sourceTainted: true,
            status: 'pending',
          })}
          onResolve={() => {}}
        />
      </I18nProvider>,
    )
    expect(screen.getByText('根据你的对话反馈提议')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('来自外部内容，请仔细核对')

    rerender(
      <I18nProvider lang="zh-CN">
        <RuleProposalChip
          payload={pending({
            source: 'dreaming',
            sourceTainted: true,
            status: 'dismissed',
          })}
        />
      </I18nProvider>,
    )
    expect(screen.getByText('已忽略此规矩提议')).toBeInTheDocument()
    expect(screen.getByText('根据你的对话反馈提议')).toBeInTheDocument()
    expect(screen.getByText('来自外部内容，请仔细核对')).toBeInTheDocument()
  })

  it('resets draft when proposalId changes', () => {
    const { rerender } = render(<RuleProposalChip payload={pending({ proposalId: 1, rule: 'First rule' })} onResolve={() => {}} />)
    const textarea = screen.getByLabelText('Standing rule (editable)') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Edited first' } })
    expect(textarea.value).toBe('Edited first')

    rerender(<RuleProposalChip payload={pending({ proposalId: 2, rule: 'Second rule' })} onResolve={() => {}} />)
    expect((screen.getByLabelText('Standing rule (editable)') as HTMLTextAreaElement).value).toBe('Second rule')
  })

  it('rejects bullet-only drafts (---, -   , - -) client-side without calling onResolve', async () => {
    const onResolve = vi.fn()
    const user = userEvent.setup()
    render(<RuleProposalChip payload={pending()} onResolve={onResolve} />)

    const textarea = screen.getByLabelText('Standing rule (editable)')
    const saveBtn = screen.getByRole('button', { name: 'Save to MEMORY.md' })

    for (const draft of ['---', '-   ', '- -', '-\u0007  ']) {
      fireEvent.change(textarea, { target: { value: draft } })
      expect(screen.getByText(`0 / ${MAX_RULE_CHARS}`)).toBeInTheDocument()
      await user.click(saveBtn)
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a standing rule before saving.')
    }
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('strips leading bullet prefix and control chars so "- <300 chars>" normalizes to 300 chars and succeeds', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuleProposalChip payload={pending()} onResolve={onResolve} />)

    const body = 'x'.repeat(MAX_RULE_CHARS)
    const textarea = screen.getByLabelText('Standing rule (editable)')
    fireEvent.change(textarea, { target: { value: `- \u0000${body}` } })
    expect(screen.getByText(`${MAX_RULE_CHARS} / ${MAX_RULE_CHARS}`)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save to MEMORY.md' }))
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith(12, 'accept', body)
    })
  })

  it('guards synchronous double-click so onResolve is called only once', async () => {
    let resolvePending!: () => void
    const onResolve = vi.fn(() => new Promise<void>((r) => { resolvePending = r }))
    render(<RuleProposalChip payload={pending()} onResolve={onResolve} />)

    const saveBtn = screen.getByRole('button', { name: 'Save to MEMORY.md' })
    fireEvent.click(saveBtn)
    fireEvent.click(saveBtn)
    expect(onResolve).toHaveBeenCalledTimes(1)

    resolvePending()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    })
  })

  it('disables both action buttons when onResolve is omitted', () => {
    render(<RuleProposalChip payload={pending()} />)
    expect(screen.getByRole('button', { name: 'Save to MEMORY.md' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled()
  })

  it('keeps buttons locked after a resolved promise until payload.status flips', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    const { rerender } = render(<RuleProposalChip payload={pending()} onResolve={onResolve} />)

    await user.click(screen.getByRole('button', { name: 'Save to MEMORY.md' }))
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledTimes(1)
    })

    // Promise has resolved, but payload.status is still 'pending': controls must stay locked.
    const savingBtn = screen.getByRole('button', { name: 'Saving…' })
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' })
    expect(savingBtn).toBeDisabled()
    expect(dismissBtn).toBeDisabled()
    expect(screen.getByLabelText('Standing rule (editable)')).toBeDisabled()

    fireEvent.click(savingBtn)
    fireEvent.click(dismissBtn)
    expect(onResolve).toHaveBeenCalledTimes(1)

    // Once payload.status flips, the card transitions to resolved view.
    rerender(<RuleProposalChip payload={pending({ status: 'accepted' })} onResolve={onResolve} />)
    expect(screen.getByText('Saved to MEMORY.md')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('displays localized API error messages for rule proposal error codes', async () => {
    const onResolve = vi.fn()
      .mockRejectedValueOnce(new ApiError('rule proposal already resolved', 409, 'settled'))
      .mockRejectedValueOnce(new ApiError('invalid rule', 400, 'invalid_rule'))
    const user = userEvent.setup()
    render(
      <I18nProvider lang="zh-CN">
        <RuleProposalChip payload={pending()} onResolve={onResolve} />
      </I18nProvider>,
    )

    const saveBtn = screen.getByRole('button', { name: '存入 MEMORY.md' })
    await user.click(saveBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent('这条规矩提议已经处理过了。')

    await user.click(saveBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写一条单行长期规矩（1–300 个字符）。')
  })
})
