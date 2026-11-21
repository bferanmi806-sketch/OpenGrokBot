import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import type { ApprovalPayload } from '../types'
import { ApprovalChip } from './ApprovalChip'

const pending = { approvalId: 7, action: 'send the 4 queued drafts', detail: 'to the Globex thread', status: 'pending' as const }

describe('ApprovalChip', () => {
  it('shows the action, its detail and both buttons while pending', () => {
    render(<ApprovalChip payload={pending} onDecide={() => {}} />)
    expect(screen.getByText('send the 4 queued drafts')).toBeInTheDocument()
    expect(screen.getByText('to the Globex thread')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
  })

  it('reports the decision with the approval id', async () => {
    const onDecide = vi.fn()
    render(<ApprovalChip payload={pending} onDecide={onDecide} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'approve')
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'discard')
  })

  it('replaces the buttons with the outcome once decided', () => {
    const { rerender } = render(<ApprovalChip payload={{ ...pending, status: 'approved' }} onDecide={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByText('Approved')).toBeInTheDocument()
    rerender(<ApprovalChip payload={{ ...pending, status: 'discarded' }} onDecide={() => {}} />)
    expect(screen.getByText('Discarded')).toBeInTheDocument()
  })

  it('omits the detail line when there is none', () => {
    const { container } = render(<ApprovalChip payload={{ ...pending, detail: undefined }} onDecide={() => {}} />)
    expect(container.querySelector('.approval-detail')).toBeNull()
  })

  it('offers to keep allowing an email to one address, and says for how long', async () => {
    const onDecide = vi.fn()
    render(<ApprovalChip payload={{ ...pending, kind: 'email', target: 'bob@acme.com', canRemember: true }} onDecide={onDecide} />)
    expect(screen.getByText('email → bob@acme.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Always allow…' }))
    expect(screen.getByText(/stop asking about email → bob@acme.com/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '24 hours' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'approve', '24h')
  })

  it('lets you back out of remembering without deciding', async () => {
    const onDecide = vi.fn()
    render(<ApprovalChip payload={{ ...pending, kind: 'post', target: '#ops', canRemember: true }} onDecide={onDecide} />)
    await userEvent.click(screen.getByRole('button', { name: 'Always allow…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onDecide).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('never offers to remember a purchase', () => {
    render(<ApprovalChip payload={{ ...pending, kind: 'purchase', target: 'amazon.com', canRemember: false }} onDecide={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Always allow…' })).toBeNull()
  })

  it('shows a hold your rule let through, with no buttons', () => {
    render(<ApprovalChip
      payload={{ ...pending, status: 'approved', kind: 'email', target: 'bob@acme.com', rule: { id: 3, kind: 'email', target: 'bob@acme.com', expiresAt: null } }}
      onDecide={() => {}}
    />)
    expect(screen.getByText('Allowed by your rule')).toBeInTheDocument()
    expect(screen.getByText(/until you revoke it/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('notes the rule you saved when you approved', () => {
    render(<ApprovalChip
      payload={{ ...pending, status: 'approved', kind: 'email', target: 'bob@acme.com', remembered: { id: 3, expiresAt: null } }}
      onDecide={() => {}}
    />)
    expect(screen.getByText('Approved · email → bob@acme.com allowed until you revoke it')).toBeInTheDocument()
  })

  it('says why a standing rule did not apply this time', () => {
    render(<ApprovalChip payload={{ ...pending, kind: 'email', target: 'bob@acme.com', canRemember: true, ruleHeld: 'webhook' }} onDecide={() => {}} />)
    expect(screen.getByText(/Your standing rule covers email → bob@acme.com, but rules only apply to work you start yourself: this came in through a webhook\./))
      .toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('says why "Always allow" is not offered for a vague destination', () => {
    render(<ApprovalChip payload={{ ...pending, kind: 'email', target: '*', canRemember: false, rememberBlocked: '"*" is a wildcard, not one destination' }} onDecide={() => {}} />)
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
    expect(screen.getByText(/No "Always allow": "\*" is a wildcard, not one destination\./)).toBeInTheDocument()
  })

  it('drops both notes once the hold is decided', () => {
    render(<ApprovalChip payload={{ ...pending, status: 'approved', kind: 'email', target: '*', ruleHeld: 'routine', rememberBlocked: 'x' }} onDecide={() => {}} />)
    expect(screen.queryByText(/standing rule covers/)).toBeNull()
    expect(screen.queryByText(/No "Always allow"/)).toBeNull()
  })

  it('lets you untick items in a batch and approves only the rest', async () => {
    const onDecide = vi.fn()
    render(<ApprovalChip payload={{ ...pending, kind: 'email', items: ['Globex', 'Initech', 'Hooli'], canRemember: false }} onDecide={onDecide} />)
    expect(screen.getByText('Needs you · 3 items')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Always allow…' })).toBeNull()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Initech' }))
    await userEvent.click(screen.getByRole('button', { name: 'Approve 2 of 3' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'approve', undefined, [0, 2])
  })

  it('approves a whole batch without listing it, and will not approve an empty one', async () => {
    const onDecide = vi.fn()
    render(<ApprovalChip payload={{ ...pending, items: ['A', 'B'] }} onDecide={onDecide} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve all 2' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'approve')
    await userEvent.click(screen.getByRole('checkbox', { name: 'A' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'B' }))
    expect(screen.getByRole('button', { name: 'Approve 0 of 2' })).toBeDisabled()
  })

  it('folds a long batch and shows what went and what was left out once decided', async () => {
    const items = Array.from({ length: 9 }, (_, i) => `item ${i + 1}`)
    const { rerender } = render(<ApprovalChip payload={{ ...pending, items }} onDecide={() => {}} />)
    expect(screen.queryByText('item 9')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show all 9' }))
    expect(screen.getByText('item 9')).toBeInTheDocument()
    rerender(<ApprovalChip payload={{ ...pending, items: ['A', 'B'], status: 'approved', approvedItems: [1] }} onDecide={() => {}} />)
    expect(screen.getByText('Approved 1 of 2')).toBeInTheDocument()
    expect(screen.getByText('A').closest('li')).toHaveClass('left-out')
    expect(screen.getByText('✓ B')).toBeInTheDocument()
  })

  it('renders gateway execution status below the outcome on manual and rule-approved chips', () => {
    const { rerender } = render(
      <ApprovalChip
        payload={{ ...pending, status: 'approved', executionStatus: 'succeeded', executionDetail: 'sent email to bob@acme.com' }}
        onDecide={() => {}}
      />,
    )
    expect(screen.getByText('✓ Executed')).toBeInTheDocument()
    expect(screen.getByText(/sent email to bob@acme\.com/)).toBeInTheDocument()

    rerender(
      <ApprovalChip
        payload={{ ...pending, status: 'approved', executionStatus: 'failed', executionDetail: '429 rate limited' }}
        onDecide={() => {}}
      />,
    )
    expect(screen.getByText('✕ Failed: 429 rate limited')).toBeInTheDocument()

    rerender(
      <ApprovalChip
        payload={{ ...pending, status: 'approved', executionStatus: 'uncertain' }}
        onDecide={() => {}}
      />,
    )
    expect(screen.getByText('⚠️ Outcome unconfirmed — not retried')).toBeInTheDocument()

    rerender(
      <ApprovalChip
        payload={{
          ...pending,
          status: 'approved',
          kind: 'email',
          target: 'bob@acme.com',
          rule: { id: 3, kind: 'email', target: 'bob@acme.com', expiresAt: null },
          executionStatus: 'succeeded',
        }}
        onDecide={() => {}}
      />,
    )
    expect(screen.getByText('Allowed by your rule')).toBeInTheDocument()
    expect(screen.getByText('✓ Executed')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('omits Edit when payload.editable is absent and hides Always allow while editing', async () => {
    const { rerender } = render(<ApprovalChip payload={pending} onDecide={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()

    const editablePayload: ApprovalPayload = {
      ...pending,
      kind: 'email',
      target: 'bob@acme.com',
      canRemember: true,
      editable: {
        kind: 'connector',
        tool: 'mail_send',
        accountLabel: 'work@acme.com',
        to: ['bob@acme.com'],
        cc: [],
        bcc: [],
        subject: 'Status update',
        body: 'All good.',
      },
    }
    rerender(<ApprovalChip payload={editablePayload} onDecide={() => {}} />)
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Always allow…' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByRole('button', { name: 'Always allow…' })).toBeNull()
  })

  it('edits, resets, cancels, validates, and submits a mail_send approval', async () => {
    const onDecide = vi.fn()
    const payload: ApprovalPayload = {
      approvalId: 11,
      action: 'Send email via work@acme.com to bob@acme.com',
      detail: 'To: bob@acme.com\nSubject: Q1 Report\n\nInitial body',
      status: 'pending',
      editable: {
        kind: 'connector',
        tool: 'mail_send',
        accountLabel: 'work@acme.com',
        to: ['bob@acme.com'],
        cc: ['carol@acme.com'],
        bcc: [],
        subject: 'Q1 Report',
        body: 'Initial body',
      },
    }
    render(<ApprovalChip payload={payload} onDecide={onDecide} />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    const toInput = screen.getByLabelText('To')
    const ccInput = screen.getByLabelText('Cc')
    const subjectInput = screen.getByLabelText('Subject')
    const bodyInput = screen.getByLabelText('Body')

    await userEvent.clear(toInput)
    expect(screen.getByRole('alert')).toHaveTextContent('To is required.')
    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeDisabled()

    await userEvent.type(toInput, 'alice@acme.com; dave@acme.com\neve@acme.com')
    await userEvent.clear(ccInput)
    await userEvent.clear(subjectInput)
    await userEvent.type(subjectInput, 'Q1 Final Report')
    await userEvent.clear(bodyInput)
    await userEvent.type(bodyInput, 'Updated body text')

    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled()

    // Reset restores original values
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(toInput).toHaveValue('bob@acme.com')
    expect(ccInput).toHaveValue('carol@acme.com')
    expect(subjectInput).toHaveValue('Q1 Report')
    expect(bodyInput).toHaveValue('Initial body')
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    // Cancel closes without calling onDecide
    await userEvent.type(subjectInput, ' draft')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onDecide).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()

    // Re-open, edit, and submit
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.clear(screen.getByLabelText('To'))
    await userEvent.type(screen.getByLabelText('To'), 'alice@acme.com, dave@acme.com')
    await userEvent.clear(screen.getByLabelText('Cc'))
    await userEvent.clear(screen.getByLabelText('Subject'))
    await userEvent.type(screen.getByLabelText('Subject'), 'Q1 Final')
    await userEvent.clear(screen.getByLabelText('Body'))
    await userEvent.type(screen.getByLabelText('Body'), 'Ship it.')

    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))
    expect(onDecide).toHaveBeenCalledWith(11, 'approve', undefined, undefined, {
      kind: 'connector',
      tool: 'mail_send',
      to: ['alice@acme.com', 'dave@acme.com'],
      cc: [],
      bcc: [],
      subject: 'Q1 Final',
      body: 'Ship it.',
    })
  })

  it('toggles replyAll on mail_reply, previews Cc dynamically, and submits edit', async () => {
    const onDecide = vi.fn()
    const payload: ApprovalPayload = {
      approvalId: 12,
      action: 'Reply via work@acme.com to alice@acme.com',
      detail: 'To: alice@acme.com\nSubject: Re: Sync\n\nSounds good.',
      status: 'pending',
      editable: {
        kind: 'connector',
        tool: 'mail_reply',
        accountLabel: 'work@acme.com',
        to: ['alice@acme.com'],
        replyAllCc: ['bob@acme.com', 'carol@acme.com'],
        subject: 'Re: Sync',
        body: 'Sounds good.',
        replyAll: false,
      },
    }
    const { container } = render(<ApprovalChip payload={payload} onDecide={onDecide} />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const header = container.querySelector('.approval-edit-header') as HTMLElement
    expect(within(header).getByText(/alice@acme\.com/)).toBeInTheDocument()
    expect(within(header).getByText(/Re: Sync/)).toBeInTheDocument()
    expect(within(header).queryByText(/bob@acme\.com/)).toBeNull()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Reply all' }))
    expect(within(header).getByText(/bob@acme\.com, carol@acme\.com/)).toBeInTheDocument()

    const body = screen.getByLabelText('Body')
    await userEvent.clear(body)
    await userEvent.type(body, 'Looping everyone in.')

    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))
    expect(onDecide).toHaveBeenCalledWith(12, 'approve', undefined, undefined, {
      kind: 'connector',
      tool: 'mail_reply',
      body: 'Looping everyone in.',
      replyAll: true,
    })
  })

  it('edits slack_send_message, notion_create_page, notion_append, and calendar_create_event', async () => {
    const onDecide = vi.fn()
    const { rerender } = render(
      <ApprovalChip
        payload={{
          approvalId: 13,
          action: 'Post Slack message to #ops',
          status: 'pending',
          editable: {
            kind: 'connector',
            tool: 'slack_send_message',
            accountLabel: 'Acme Slack',
            channelId: '#ops',
            threadTs: '1700000000.000100',
            text: 'Deploy starting',
          },
        }}
        onDecide={onDecide}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByText(/1700000000\.000100/)).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('Channel'))
    await userEvent.type(screen.getByLabelText('Channel'), '#releases')
    await userEvent.clear(screen.getByLabelText('Message'))
    await userEvent.type(screen.getByLabelText('Message'), 'Deploy done')
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))
    expect(onDecide).toHaveBeenLastCalledWith(13, 'approve', undefined, undefined, {
      kind: 'connector',
      tool: 'slack_send_message',
      channelId: '#releases',
      text: 'Deploy done',
    })

    rerender(
      <ApprovalChip
        payload={{
          approvalId: 14,
          action: 'Create Notion page',
          status: 'pending',
          editable: {
            kind: 'connector',
            tool: 'notion_create_page',
            accountLabel: 'Team Notion',
            parentPageId: 'pg-1',
            title: 'Weekly Notes',
            markdown: '# Draft',
          },
        }}
        onDecide={onDecide}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.clear(screen.getByLabelText('Title'))
    await userEvent.type(screen.getByLabelText('Title'), 'Final Notes')
    await userEvent.clear(screen.getByLabelText('Markdown'))
    await userEvent.type(screen.getByLabelText('Markdown'), '# Final')
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))
    expect(onDecide).toHaveBeenLastCalledWith(14, 'approve', undefined, undefined, {
      kind: 'connector',
      tool: 'notion_create_page',
      title: 'Final Notes',
      markdown: '# Final',
    })

    rerender(
      <ApprovalChip
        payload={{
          approvalId: 15,
          action: 'Append to Notion page',
          status: 'pending',
          editable: {
            kind: 'connector',
            tool: 'notion_append',
            accountLabel: 'Team Notion',
            pageId: 'pg-2',
            markdown: '- item 1',
          },
        }}
        onDecide={onDecide}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.type(screen.getByLabelText('Markdown'), '\n- item 2')
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))
    expect(onDecide).toHaveBeenLastCalledWith(15, 'approve', undefined, undefined, {
      kind: 'connector',
      tool: 'notion_append',
      markdown: '- item 1\n- item 2',
    })

    rerender(
      <ApprovalChip
        payload={{
          approvalId: 16,
          action: 'Create calendar event',
          status: 'pending',
          editable: {
            kind: 'connector',
            tool: 'calendar_create_event',
            accountLabel: 'Work Calendar',
            title: 'Design Review',
            start: '2026-11-22T10:00:00Z',
            end: '2026-11-22T11:00:00Z',
            location: 'Zoom',
            attendees: ['alice@acme.com'],
            description: 'Review mocks',
          },
        }}
        onDecide={onDecide}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.clear(screen.getByLabelText('Location'))
    await userEvent.type(screen.getByLabelText('Location'), 'Room 3B')
    await userEvent.clear(screen.getByLabelText('Attendees'))
    await userEvent.type(screen.getByLabelText('Attendees'), 'alice@acme.com, bob@acme.com')
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))
    expect(onDecide).toHaveBeenLastCalledWith(16, 'approve', undefined, undefined, {
      kind: 'connector',
      tool: 'calendar_create_event',
      title: 'Design Review',
      start: '2026-11-22T10:00:00Z',
      end: '2026-11-22T11:00:00Z',
      location: 'Room 3B',
      attendees: ['alice@acme.com', 'bob@acme.com'],
      description: 'Review mocks',
    })
  })

  it('omits untouched optional fields on calendar_update_event and blocks empty patches', async () => {
    const onDecide = vi.fn()
    const payload: ApprovalPayload = {
      approvalId: 17,
      action: 'Update calendar event evt-9',
      status: 'pending',
      editable: {
        kind: 'connector',
        tool: 'calendar_update_event',
        accountLabel: 'Work Calendar',
        eventId: 'evt-9',
        title: 'Standup',
      },
    }
    render(<ApprovalChip payload={payload} onDecide={onDecide} />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const titleInput = screen.getByLabelText('Title')

    // Clearing the only populated field shows validation error and disables submit
    await userEvent.clear(titleInput)
    expect(screen.getByRole('alert')).toHaveTextContent('Provide at least one field to update.')
    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeDisabled()

    await userEvent.type(titleInput, 'Daily Standup')
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))

    // Location, attendees, description, start, end were untouched and undefined -> must NOT be sent as ''
    const submitted = onDecide.mock.calls[0]?.[4]
    expect(submitted).toEqual({
      kind: 'connector',
      tool: 'calendar_update_event',
      title: 'Daily Standup',
    })
    expect('location' in submitted).toBe(false)
    expect('attendees' in submitted).toBe(false)
    expect('description' in submitted).toBe(false)
  })

  it('includes an explicit empty location on calendar_update_event when clearing an initially defined location', async () => {
    const onDecide = vi.fn()
    render(
      <ApprovalChip
        payload={{
          approvalId: 21,
          action: 'Update calendar event evt-10',
          status: 'pending',
          editable: {
            kind: 'connector',
            tool: 'calendar_update_event',
            accountLabel: 'Work Calendar',
            eventId: 'evt-10',
            title: 'Standup',
            location: 'Room A',
          },
        }}
        onDecide={onDecide}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.clear(screen.getByLabelText('Location'))
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))
    expect(onDecide).toHaveBeenCalledWith(21, 'approve', undefined, undefined, {
      kind: 'connector',
      tool: 'calendar_update_event',
      title: 'Standup',
      location: '',
    })
  })

  it('renders primitive MCP form mode, validates numbers, toggles to Raw JSON, and validates JSON objects', async () => {
    const onDecide = vi.fn()
    const payload: ApprovalPayload = {
      approvalId: 18,
      action: 'Linear · create_issue',
      status: 'pending',
      editable: {
        kind: 'mcp',
        serverName: 'Linear',
        toolName: 'create_issue',
        args: { title: 'Fix login', priority: 2, urgent: false },
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short summary' },
            priority: { type: 'integer' },
            urgent: { type: 'boolean' },
          },
          required: ['title'],
        },
      },
    }
    render(<ApprovalChip payload={payload} onDecide={onDecide} />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Form' })).toHaveAttribute('aria-pressed', 'true')

    const titleInput = screen.getByLabelText('title')
    const priorityInput = screen.getByLabelText('priority')
    const urgentBox = screen.getByRole('checkbox', { name: 'urgent' })

    // Invalid integer blocks submit
    await userEvent.clear(priorityInput)
    await userEvent.type(priorityInput, '2.5')
    expect(screen.getByRole('alert')).toHaveTextContent('priority must be a valid number.')
    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeDisabled()

    // Valid primitive edits
    await userEvent.clear(priorityInput)
    await userEvent.type(priorityInput, '1')
    await userEvent.clear(titleInput)
    await userEvent.type(titleInput, 'Fix OAuth')
    await userEvent.click(urgentBox)

    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))
    expect(onDecide).toHaveBeenLastCalledWith(18, 'approve', undefined, undefined, {
      kind: 'mcp',
      args: { title: 'Fix OAuth', priority: 1, urgent: true },
    })

    // Toggle to Raw JSON carrying form values forward
    await userEvent.click(screen.getByRole('button', { name: 'Raw JSON' }))
    const jsonArea = screen.getByLabelText('Arguments (JSON)')
    expect(JSON.parse((jsonArea as HTMLTextAreaElement).value)).toEqual({
      title: 'Fix OAuth',
      priority: 1,
      urgent: true,
    })

    // Invalid JSON blocks submit
    fireEvent.change(jsonArea, { target: { value: '{bad json' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Arguments must be valid JSON.')
    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeDisabled()

    // Non-object JSON ([]) blocks submit
    fireEvent.change(jsonArea, { target: { value: '["not", "an", "object"]' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Arguments must be a JSON object.')
    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeDisabled()

    // Valid edited JSON submits
    fireEvent.change(jsonArea, { target: { value: '{"title":"From JSON","priority":3,"urgent":false}' } })
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))
    expect(onDecide).toHaveBeenLastCalledWith(18, 'approve', undefined, undefined, {
      kind: 'mcp',
      args: { title: 'From JSON', priority: 3, urgent: false },
    })

    // Toggling back to Form hydrates values from valid primitive JSON
    await userEvent.click(screen.getByRole('button', { name: 'Form' }))
    expect(screen.getByLabelText('title')).toHaveValue('From JSON')
    expect(screen.getByLabelText('priority')).toHaveValue('3')
    expect(screen.getByRole('checkbox', { name: 'urgent' })).not.toBeChecked()
  })

  it('defaults schemaless or nested MCP approvals directly to Raw JSON mode', async () => {
    const onDecide = vi.fn()
    render(
      <ApprovalChip
        payload={{
          approvalId: 22,
          action: 'GitHub · create_pr',
          status: 'pending',
          editable: {
            kind: 'mcp',
            serverName: 'GitHub',
            toolName: 'create_pr',
            args: { title: 'Feat', labels: ['ui'] },
          },
        }}
        onDecide={onDecide}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByRole('button', { name: 'Form' })).toBeNull()
    const jsonArea = screen.getByLabelText('Arguments (JSON)')
    fireEvent.change(jsonArea, { target: { value: '{"title":"Feat 2","labels":["ui","web"]}' } })
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))
    expect(onDecide).toHaveBeenCalledWith(22, 'approve', undefined, undefined, {
      kind: 'mcp',
      args: { title: 'Feat 2', labels: ['ui', 'web'] },
    })
  })

  it('edits prompt approvals and submits action and detail', async () => {
    const onDecide = vi.fn()
    const payload: ApprovalPayload = {
      approvalId: 19,
      action: 'Post release note',
      detail: 'v0.7.0 is live',
      status: 'pending',
      editable: {
        kind: 'prompt',
        action: 'Post release note',
        detail: 'v0.7.0 is live',
      },
    }
    render(<ApprovalChip payload={payload} onDecide={onDecide} />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.clear(screen.getByLabelText('Action'))
    await userEvent.type(screen.getByLabelText('Action'), 'Publish release note')
    await userEvent.clear(screen.getByLabelText('Details'))
    await userEvent.type(screen.getByLabelText('Details'), 'v0.8.0 is live with editable approvals')
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))

    expect(onDecide).toHaveBeenCalledWith(19, 'approve', undefined, undefined, {
      kind: 'prompt',
      action: 'Publish release note',
      detail: 'v0.8.0 is live with editable approvals',
    })
  })

  it('keeps edits open and displays inline server ApiError on rejection, then closes and shows Edited by you once approved', async () => {
    const onDecide = vi.fn().mockRejectedValueOnce(new ApiError('invalid email header', 400, 'invalid_edit'))
    const payload: ApprovalPayload = {
      approvalId: 20,
      action: 'Send email',
      status: 'pending',
      editable: {
        kind: 'connector',
        tool: 'mail_send',
        accountLabel: 'work@acme.com',
        to: ['bob@acme.com'],
        cc: [],
        bcc: [],
        subject: 'Hello',
        body: 'Original body',
      },
    }
    const { rerender } = render(<ApprovalChip payload={payload} onDecide={onDecide} />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const bodyInput = screen.getByLabelText('Body')
    await userEvent.clear(bodyInput)
    await userEvent.type(bodyInput, 'Keep this draft intact')
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid email header')
    // Editor stays open and preserves typed draft
    expect(screen.getByLabelText('Body')).toHaveValue('Keep this draft intact')

    // When WS transitions the chip to approved + edited, editor exits and badge renders
    rerender(<ApprovalChip payload={{ ...payload, status: 'approved', edited: true }} onDecide={onDecide} />)
    expect(screen.queryByLabelText('Body')).toBeNull()
    expect(screen.getByText('Approved · Edited by you')).toBeInTheDocument()
  })

  it('reverts initially-undefined calendar_update_event optional fields to omitted when cleared back to empty', async () => {
    const onDecide = vi.fn()
    render(
      <ApprovalChip
        payload={{
          approvalId: 23,
          action: 'Update calendar event evt-11',
          status: 'pending',
          editable: {
            kind: 'connector',
            tool: 'calendar_update_event',
            accountLabel: 'Work Calendar',
            eventId: 'evt-11',
            title: 'Standup',
          },
        }}
        onDecide={onDecide}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    const locationInput = screen.getByLabelText('Location')
    const attendeesInput = screen.getByLabelText('Attendees')
    const descriptionInput = screen.getByLabelText('Description')
    const titleInput = screen.getByLabelText('Title')

    await userEvent.type(locationInput, 'Room 1')
    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeEnabled()
    await userEvent.clear(locationInput)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    await userEvent.type(attendeesInput, 'alice@corp.com')
    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeEnabled()
    await userEvent.clear(attendeesInput)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    await userEvent.type(descriptionInput, 'Agenda notes')
    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeEnabled()
    await userEvent.clear(descriptionInput)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    // Clearing Title must still trigger atLeastOneField because none of the reverted fields count
    await userEvent.clear(titleInput)
    expect(screen.getByRole('alert')).toHaveTextContent('Provide at least one field to update.')
    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeDisabled()

    await userEvent.type(titleInput, 'Weekly Standup')
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))

    const submitted = onDecide.mock.calls[0]?.[4]
    expect(submitted).toEqual({
      kind: 'connector',
      tool: 'calendar_update_event',
      title: 'Weekly Standup',
    })
    expect('location' in submitted).toBe(false)
    expect('attendees' in submitted).toBe(false)
    expect('description' in submitted).toBe(false)
  })

  it('preserves quoted display names with commas in mail_send and splits delimiters outside quotes', async () => {
    const onDecide = vi.fn()
    render(
      <ApprovalChip
        payload={{
          approvalId: 24,
          action: 'Send email',
          status: 'pending',
          editable: {
            kind: 'connector',
            tool: 'mail_send',
            accountLabel: 'work@corp.com',
            to: ['"Smith, Alice" <alice@corp.com>'],
            cc: [],
            bcc: [],
            subject: 'Q2 Plan',
            body: 'Initial body',
          },
        }}
        onDecide={onDecide}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('To')).toHaveValue('"Smith, Alice" <alice@corp.com>')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    const bodyInput = screen.getByLabelText('Body')
    await userEvent.clear(bodyInput)
    await userEvent.type(bodyInput, 'Updated body only')
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))

    expect(onDecide).toHaveBeenLastCalledWith(24, 'approve', undefined, undefined, {
      kind: 'connector',
      tool: 'mail_send',
      to: ['"Smith, Alice" <alice@corp.com>'],
      cc: [],
      bcc: [],
      subject: 'Q2 Plan',
      body: 'Updated body only',
    })

    // Comma and semicolon outside quotes split properly while keeping quoted display names intact
    await userEvent.type(screen.getByLabelText('To'), ', bob@corp.com')
    await userEvent.type(screen.getByLabelText('Cc'), '"Doe; Jane" <jane@corp.com>; carol@corp.com')
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))

    expect(onDecide).toHaveBeenLastCalledWith(24, 'approve', undefined, undefined, {
      kind: 'connector',
      tool: 'mail_send',
      to: ['"Smith, Alice" <alice@corp.com>', 'bob@corp.com'],
      cc: ['"Doe; Jane" <jane@corp.com>', 'carol@corp.com'],
      bcc: [],
      subject: 'Q2 Plan',
      body: 'Updated body only',
    })
  })

  it('reverts initially-omitted optional MCP string fields when cleared while preserving cleared present keys', async () => {
    const onDecide = vi.fn()
    render(
      <ApprovalChip
        payload={{
          approvalId: 25,
          action: 'Linear · create_issue',
          status: 'pending',
          editable: {
            kind: 'mcp',
            serverName: 'Linear',
            toolName: 'create_issue',
            args: { title: 'Fix login', subtitle: 'Auth flow' },
            inputSchema: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                subtitle: { type: 'string' },
                note: { type: 'string' },
              },
              required: ['title'],
            },
          },
        }}
        onDecide={onDecide}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    const noteInput = screen.getByLabelText('note')
    await userEvent.type(noteInput, 'temporary')
    expect(screen.getByRole('button', { name: 'Approve edited' })).toBeEnabled()
    await userEvent.clear(noteInput)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    // Clearing a string key originally present in editable.args sends "" while omitted note stays absent
    await userEvent.clear(screen.getByLabelText('subtitle'))
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited' }))

    const submitted = onDecide.mock.calls[0]?.[4]
    expect(submitted).toEqual({
      kind: 'mcp',
      args: { title: 'Fix login', subtitle: '' },
    })
    expect('note' in submitted.args).toBe(false)
  })

  it('calls onDecide without an edit argument when clicking Approve inside an open unmodified editor', async () => {
    const onDecide = vi.fn()
    render(
      <ApprovalChip
        payload={{
          approvalId: 26,
          action: 'Post release note',
          detail: 'v0.8.0 is live',
          status: 'pending',
          editable: {
            kind: 'prompt',
            action: 'Post release note',
            detail: 'v0.8.0 is live',
          },
        }}
        onDecide={onDecide}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(onDecide).toHaveBeenCalledTimes(1)
    expect(onDecide.mock.calls[0]).toEqual([26, 'approve'])
    expect(onDecide.mock.calls[0]).toHaveLength(2)
  })
})
