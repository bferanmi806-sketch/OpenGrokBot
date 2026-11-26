import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { ComputerInfo } from '../types'
import { ComputerPanel } from './ComputerPanel'
import { WorkflowSection } from './WorkflowSection'

const SCREEN = 'http://127.0.0.1:53314/vnc.html?autoconnect=1&resize=scale&reconnect=1&password=pw12345x'
const running: ComputerInfo = {
  botId: 'researcher',
  running: true,
  vncUrl: SCREEN,
  routines: [{ id: 1, name: 'Morning digest', cron: '0 9 * * *', human: 'every day at 09:00', last_run_at: null, enabled: 1 }],
  usage: { today: { prompt: 12000, completion: 345, cached: 8000, total: 12345 }, budget: 200000 },
}

describe('browser workflows', () => {
  const draft = {
    id: 'draft-1',
    trace: {
      format: 'opensuperbot.workflow' as const,
      version: 1 as const,
      title: 'Submit a form',
      steps: [
        { type: 'fill' as const, target: { candidates: [{ label: 'Email' }] }, value: { kind: 'literal' as const, text: 'customer@example.test' } },
        { type: 'click' as const, target: { candidates: [{ label: 'Submit' }] } },
      ],
    },
  }

  it('restores a pending draft, converts values to inputs, adds approval, and saves edits', async () => {
    const onUpdateDraft = vi.fn().mockResolvedValue(undefined)
    const onSaveDraft = vi.fn().mockResolvedValue(undefined)
    render(<WorkflowSection
      info={{ ...running, kind: 'docker', workflowDraft: draft, savedWorkflows: [] }}
      onStartRecording={() => {}}
      onUpdateDraft={onUpdateDraft}
      onSaveDraft={onSaveDraft}
    />)

    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveValue('Submit a form')
    await userEvent.click(screen.getByRole('button', { name: 'Use an input instead' }))
    expect(screen.getByRole('textbox', { name: 'Input name' })).toHaveValue('input1')
    const approvalChecks = screen.getAllByRole('checkbox', { name: 'Ask for approval before this step' })
    await userEvent.click(approvalChecks[1]!)
    await userEvent.type(screen.getByRole('textbox', { name: 'Recipient or destination' }), 'customer@example.test')

    await userEvent.click(screen.getByRole('button', { name: 'Save draft edits' }))
    const updated = onUpdateDraft.mock.calls[0]?.[1]
    expect(updated.steps[0]).toMatchObject({ value: { kind: 'placeholder', key: 'input1' } })
    expect(updated.steps[1]).toMatchObject({ approval: { kind: 'other', target: 'customer@example.test' } })
    expect(updated.steps[1].approval).not.toHaveProperty('action')

    await userEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
    expect(onSaveDraft).toHaveBeenCalledWith('draft-1', updated)
  })

  it('drops a step and restores active run controls from the computer snapshot', async () => {
    const onUpdateDraft = vi.fn().mockResolvedValue(undefined)
    const onStopRun = vi.fn().mockResolvedValue(undefined)
    render(<WorkflowSection
      info={{
        ...running,
        kind: 'docker',
        workflowDraft: draft,
        workflowRun: { runId: 'run-1', workflowId: 'workflow-1' },
        savedWorkflows: [{ id: 'workflow-1', trace: { ...draft.trace, title: 'Saved workflow' } }],
      }}
      onStartRecording={() => {}}
      onUpdateDraft={onUpdateDraft}
      onStopRun={onStopRun}
    />)
    await userEvent.click(screen.getByRole('button', { name: 'Drop step 1' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save draft edits' }))
    expect(onUpdateDraft.mock.calls[0]?.[1].steps).toHaveLength(1)
    expect(screen.getByText('Workflow Saved workflow is running.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run workflow' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Stop workflow' }))
    expect(onStopRun).toHaveBeenCalledWith('run-1')
  })

  it('collects placeholder bindings only when running a saved workflow', async () => {
    const onRun = vi.fn().mockResolvedValue(undefined)
    const trace = {
      format: 'opensuperbot.workflow' as const,
      version: 1 as const,
      title: 'Sign in',
      steps: [{ type: 'fill' as const, target: { candidates: [{ label: 'Password' }] }, value: { kind: 'placeholder' as const, key: 'password' } }],
    }
    render(<WorkflowSection
      info={{ ...running, kind: 'docker', workflowRecording: false, workflowDraft: null, savedWorkflows: [{ id: 'workflow-2', trace }] }}
      onStartRecording={() => {}}
      onRun={onRun}
    />)
    const password = screen.getByLabelText('password')
    expect(password).toHaveAttribute('type', 'password')
    await userEvent.type(password, 's3cret-value')
    await userEvent.click(screen.getByRole('button', { name: 'Run workflow' }))
    expect(onRun).toHaveBeenCalledWith('workflow-2', { password: 's3cret-value' })
    expect(password).toHaveValue('')
  })

  it('keeps run inputs when the gateway rejects a workflow run', async () => {
    const onRun = vi.fn().mockRejectedValue(new Error('the teammate is busy'))
    const trace = {
      format: 'opensuperbot.workflow' as const,
      version: 1 as const,
      title: 'Sign in',
      steps: [{ type: 'fill' as const, target: { candidates: [{ label: 'Password' }] }, value: { kind: 'placeholder' as const, key: 'password' } }],
    }
    render(<WorkflowSection
      info={{ ...running, kind: 'docker', workflowRecording: false, workflowDraft: null, savedWorkflows: [{ id: 'workflow-2', trace }] }}
      onStartRecording={() => {}}
      onRun={onRun}
    />)
    const password = screen.getByLabelText('password')
    await userEvent.type(password, 's3cret-value')
    await userEvent.click(screen.getByRole('button', { name: 'Run workflow' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('the teammate is busy')
    expect(password).toHaveValue('s3cret-value')
  })

  it('clears recording details after a successful start', async () => {
    const onStartRecording = vi.fn().mockResolvedValue(undefined)
    render(<WorkflowSection info={{ ...running, kind: 'docker', workflowRecording: false, workflowDraft: null, savedWorkflows: [] }} onStartRecording={onStartRecording} />)
    const title = screen.getByRole('textbox', { name: 'Workflow name' })
    const intent = screen.getByRole('textbox', { name: 'Goal (optional)' })
    await userEvent.type(title, 'Daily report')
    await userEvent.type(intent, 'Collect the latest updates')
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    expect(onStartRecording).toHaveBeenCalledWith('Daily report', 'Collect the latest updates')
    expect(title).toHaveValue('')
    expect(intent).toHaveValue('')
  })

  it('uses the normalized draft returned by the gateway', async () => {
    const normalized = { ...draft.trace, title: 'Normalized title' }
    const onUpdateDraft = vi.fn().mockResolvedValue({ id: draft.id, trace: normalized })
    render(<WorkflowSection info={{ ...running, kind: 'docker', workflowDraft: draft, savedWorkflows: [] }} onStartRecording={() => {}} onUpdateDraft={onUpdateDraft} />)
    await userEvent.click(screen.getByRole('button', { name: 'Save draft edits' }))
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveValue('Normalized title')
  })

  it('deletes a selected saved workflow and disables deletion while it is running', async () => {
    const onDeleteWorkflow = vi.fn().mockResolvedValue(undefined)
    const trace = {
      format: 'opensuperbot.workflow' as const,
      version: 1 as const,
      title: 'Saved workflow',
      steps: [],
    }
    const info = { ...running, kind: 'docker' as const, workflowDraft: null, savedWorkflows: [{ id: 'workflow-2', trace }] }
    const { rerender } = render(<WorkflowSection info={info} onStartRecording={() => {}} onDeleteWorkflow={onDeleteWorkflow} />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete workflow' }))
    expect(onDeleteWorkflow).toHaveBeenCalledWith('workflow-2')
    rerender(<WorkflowSection info={{ ...info, workflowRun: { runId: 'run-1', workflowId: 'workflow-2' } }} onStartRecording={() => {}} onDeleteWorkflow={onDeleteWorkflow} />)
    expect(screen.getByRole('button', { name: 'Delete workflow' })).toBeDisabled()
  })
})

describe('ComputerPanel', () => {
  it('embeds the live screen and lists what is scheduled', () => {
    const { container } = render(<ComputerPanel info={running} botName="Scout" onClose={() => {}} />)
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe(SCREEN) // 网关给的地址已带好连接参数
    expect(screen.getByText("Scout's computer")).toBeInTheDocument()
    expect(screen.getByText('Morning digest')).toBeInTheDocument()
    expect(screen.getByText('every day at 09:00')).toBeInTheDocument()
  })

  it('explains why there is no screen instead of showing a blank frame', () => {
    const { container } = render(
      <ComputerPanel
        info={{ ...running, running: false, vncUrl: null, error: 'docker daemon not running' }}
        botName="Scout"
        onClose={() => {}}
      />,
    )
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText(/docker daemon not running/)).toBeInTheDocument()
  })

  it('says so when nothing is scheduled', () => {
    render(<ComputerPanel info={{ ...running, routines: [] }} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText('No routines yet.')).toBeInTheDocument()
  })

  it('reminds the operator that passwords never go through chat', () => {
    render(<ComputerPanel info={running} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText(/never hand it a password in chat/i)).toBeInTheDocument()
  })

  it('closes', async () => {
    const onClose = vi.fn()
    render(<ComputerPanel info={running} botName="Scout" onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('runs, pauses, resumes and deletes routines', async () => {
    const onRoutine = vi.fn()
    const paused = { ...running.routines[0]!, id: 2, name: 'Old sweep', enabled: 0 }
    render(<ComputerPanel info={{ ...running, routines: [running.routines[0]!, paused] }} botName="Scout" onClose={() => {}} onRoutine={onRoutine} />)
    await userEvent.click(screen.getByRole('button', { name: 'Run Morning digest now' }))
    await userEvent.click(screen.getByRole('button', { name: 'Pause Morning digest' }))
    await userEvent.click(screen.getByRole('button', { name: 'Resume Old sweep' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete Old sweep' }))
    expect(onRoutine.mock.calls).toEqual([[1, 'run'], [1, 'pause'], [2, 'resume'], [2, 'delete']])
    expect(screen.getByText('paused')).toBeInTheDocument()
  })

  it('opens straight away while the computer is still waking, and shows how long it has waited', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<ComputerPanel info={null} botName="Scout" onClose={() => {}} />)
      expect(screen.getByRole('status')).toHaveTextContent("Starting Scout's computer…")
      expect(container.querySelector('iframe')).toBeNull()
      expect(screen.queryByText('Routines')).toBeNull()
      expect(screen.queryByText(/\ds$/)).toBeNull() // 头两秒不跳数字
      act(() => { vi.advanceTimersByTime(4_000) })
      expect(screen.getByText('4s')).toBeInTheDocument()
      expect(screen.getByText(/never hand it a password in chat/i)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows today\'s token use against the budget', () => {
    render(<ComputerPanel info={running} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText(/12,345/)).toBeInTheDocument()
    expect(screen.getByText(/200,000/)).toBeInTheDocument()
  })

  it('lists what goes out without asking, and revokes it', async () => {
    const onRevokeRule = vi.fn()
    render(<ComputerPanel
      info={{ ...running, rules: [{ id: 4, kind: 'email', target: 'bob@acme.com', expiresAt: null, createdAt: 1 }] }}
      botName="Scout"
      onClose={() => {}}
      onRevokeRule={onRevokeRule}
    />)
    expect(screen.getByText('email → bob@acme.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Stop allowing email to bob@acme.com' }))
    expect(onRevokeRule).toHaveBeenCalledWith(4)
  })

  it('says nothing goes out unasked when there are no rules', () => {
    render(<ComputerPanel info={running} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText('Nothing goes out without your approval.')).toBeInTheDocument()
  })

  it('lists standing rules and forgets one by its exact text', async () => {
    const onForgetRule = vi.fn()
    render(<ComputerPanel info={{ ...running, memory: ['Never email Globex on Fridays.'] }} botName="Scout" onClose={() => {}} onForgetRule={onForgetRule} />)
    await userEvent.click(screen.getByRole('button', { name: 'Forget: Never email Globex on Fridays.' }))
    expect(onForgetRule).toHaveBeenCalledWith('Never email Globex on Fridays.')
  })

  it('copies the full webhook address only for routines that have one', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const hooked = { id: 2, name: 'Triage', cron: '', human: 'when its webhook is called', last_run_at: null, enabled: 1, webhook_path: '/hooks/routines/2?key=k3y' }
    render(<ComputerPanel info={{ ...running, routines: [...running.routines, hooked] }} botName="Scout" onClose={() => {}} />)
    expect(screen.getAllByRole('button', { name: /Copy the webhook address/ })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Copy the webhook address of Triage' }))
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/hooks/routines/2?key=k3y`)
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })

  it('copies GitHub settings with the key as the secret and no key in the address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const hooked = {
      id: 2, name: 'Triage', cron: '', human: 'when its webhook is called', last_run_at: null, enabled: 1,
      webhook_path: '/hooks/routines/2?key=k3y', webhook_secret: 'k3y',
    }
    render(<ComputerPanel info={{ ...running, routines: [hooked] }} botName="Scout" onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy the GitHub webhook settings of Triage' }))
    expect(writeText).toHaveBeenCalledWith(
      `Payload URL: ${location.origin}/hooks/routines/2\nContent type: application/json\nSecret: k3y`,
    )
  })

  it('marks a rule that no longer applies instead of showing it as live', () => {
    const { container } = render(
      <ComputerPanel
        info={{ ...running, rules: [{ id: 5, kind: 'email', target: '*', expiresAt: null, createdAt: 1, applies: false, whyNot: '"*" is a wildcard, not one destination' }] }}
        botName="Scout"
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('No longer applies: "*" is a wildcard, not one destination')).toBeInTheDocument()
    expect(container.querySelector('.panel-rule.inert')).not.toBeNull()
  })

  it('marks watch routines, lists shared skills and the recent actions', () => {
    const watch = { ...running.routines[0]!, id: 3, name: 'Status watch', human: 'every 30 minutes', mode: 'watch' as const }
    const prepare = { ...running.routines[0]!, id: 4, name: 'Nightly prep', human: 'every day at 06:00', mode: 'prepare' as const }
    render(<ComputerPanel
      info={{
        ...running,
        routines: [watch, prepare],
        skills: [{ name: 'weekly-report', description: 'How the Friday report is laid out' }],
        actions: [
          { id: 3, thread_id: 'dm:researcher', trigger: 'prepare', tool: 'wiki_upsert', summary: 'client/acme', ok: true, ms: 120, created_at: Date.now() },
          { id: 2, thread_id: 'dm:researcher', trigger: 'webhook', tool: 'browser_goto', summary: 'status.example.com', ok: false, ms: 900, created_at: Date.now() },
          { id: 1, thread_id: 'dm:researcher', trigger: 'you', tool: 'approval', summary: 'approved by you: send it', ok: null, ms: null, created_at: Date.now() },
        ],
      }}
      botName="Scout"
      onClose={() => {}}
    />)
    expect(screen.getByText('watch')).toBeInTheDocument()
    expect(screen.getByText('prepare')).toBeInTheDocument()
    expect(screen.getByText(/· prepare$/)).toBeInTheDocument()
    expect(screen.getByText('weekly-report')).toBeInTheDocument()
    expect(screen.getByText('Custom')).toBeInTheDocument()
    expect(screen.getByText('How the Friday report is laid out')).toBeInTheDocument()
    expect(screen.getByText('status.example.com').closest('li')).toHaveClass('failed')
    expect(screen.getByText(/· webhook$/)).toBeInTheDocument()
    expect(screen.getByText('approved by you: send it')).toBeInTheDocument()
  })

  it('distinguishes built-in and custom shared skills in English and Simplified Chinese', () => {
    const skills = [
      { name: 'meeting-minutes', description: 'Turn raw meeting notes into decisions.', builtin: true },
      { name: 'weekly-report', description: 'How the Friday report is laid out' },
    ]
    const { unmount } = render(<ComputerPanel info={{ ...running, skills }} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText('meeting-minutes')).toBeInTheDocument()
    expect(screen.getByText('Built-in')).toBeInTheDocument()
    expect(screen.getByText('weekly-report')).toBeInTheDocument()
    expect(screen.getByText('Custom')).toBeInTheDocument()

    unmount()
    render(
      <I18nProvider lang="zh-CN">
        <ComputerPanel info={{ ...running, skills }} botName="Scout" onClose={() => {}} />
      </I18nProvider>,
    )
    expect(screen.getByText('共享技能')).toBeInTheDocument()
    expect(screen.getByText('meeting-minutes')).toBeInTheDocument()
    expect(screen.getByText('内置')).toBeInTheDocument()
    expect(screen.getByText('weekly-report')).toBeInTheDocument()
    expect(screen.getByText('自定义')).toBeInTheDocument()
  })

  it('says the log is empty instead of hiding it', () => {
    render(<ComputerPanel info={{ ...running, actions: [] }} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText('Nothing yet. Every step it takes is logged here.')).toBeInTheDocument()
  })
})

describe('a local computer', () => {
  const local: ComputerInfo = {
    ...running, kind: 'local', vncUrl: null, screen: { kind: 'cdp', url: '/screen/researcher/ws' },
  }

  it('shows the screencast view and says what kind of computer it is', () => {
    const sockets: string[] = []
    vi.stubGlobal('WebSocket', class { constructor(url: string) { sockets.push(url) } close() {} })
    const { container } = render(<ComputerPanel info={local} botName="Scout" onClose={() => {}} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('.panel-screen-cdp')).not.toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Connecting…')
    expect(sockets[0]).toMatch(/\/screen\/researcher\/ws$/)
    expect(screen.getByText(/Local computer/)).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('tells the operator the browser window is open for signing in, and reports when they are done', async () => {
    vi.stubGlobal('WebSocket', class { close() {} })
    const done = vi.fn()
    render(<ComputerPanel info={{ ...local, window: true }} botName="Scout" onClose={() => {}} onWindowDone={done} />)
    expect(screen.getByText(/open as a window on your desktop/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: "I\u2019m done signing in" }))
    expect(done).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('tells the operator to perform recorded steps in the open window', () => {
    vi.stubGlobal('WebSocket', class { close() {} })
    render(<ComputerPanel info={{ ...local, window: true, workflowRecording: true }} botName="Scout" onClose={() => {}} onWindowDone={() => {}} onWorkflowStartRecording={() => {}} />)
    expect(screen.getByText(/perform the recorded steps there/)).toBeInTheDocument()
    expect(screen.queryByText(/sign in there/)).toBeNull()
    expect(screen.getByText('The screen is watch-only.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: "I’m done signing in" })).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('the commands switch', () => {
  const local: ComputerInfo = { ...running, kind: 'local', vncUrl: null, screen: null }

  it('turns commands on and off for a local computer', async () => {
    const onShell = vi.fn()
    render(<ComputerPanel info={{ ...local, shell: { enabled: false, available: true } }} botName="Scout" onClose={() => {}} onShell={onShell} />)
    const box = screen.getByRole('checkbox', { name: 'Allow commands' })
    expect(box).not.toBeChecked()
    await userEvent.click(box)
    expect(onShell).toHaveBeenCalledWith(true)
  })

  it('explains when no sandbox is available, and keeps the switch off', () => {
    render(<ComputerPanel info={{ ...local, shell: { enabled: false, available: false, why: 'Install bubblewrap.' } }} botName="Scout" onClose={() => {}} onShell={() => {}} />)
    expect(screen.getByRole('checkbox', { name: 'Allow commands' })).toBeDisabled()
    expect(screen.getByText(/Install bubblewrap/)).toBeInTheDocument()
  })

  it('is not offered for a sealed computer', () => {
    render(<ComputerPanel info={{ ...running, kind: 'docker', shell: { enabled: true, available: true } }} botName="Scout" onClose={() => {}} onShell={() => {}} />)
    expect(screen.queryByRole('checkbox', { name: 'Allow commands' })).toBeNull()
  })
})

describe('waiting on the gateway', () => {
  const local: ComputerInfo = { ...running, kind: 'local', vncUrl: null, screen: null, shell: { enabled: false, available: true } }

  it('locks the commands switch while the sandbox is checked, and shows why when the gateway refuses', async () => {
    let reject!: (err: Error) => void
    const onShell = vi.fn(() => new Promise<void>((_, r) => { reject = r }))
    render(<ComputerPanel info={local} botName="Scout" onClose={() => {}} onShell={onShell} />)
    const box = screen.getByRole('checkbox', { name: 'Allow commands' })
    await userEvent.click(box)
    expect(onShell).toHaveBeenCalledWith(true)
    expect(box).toBeDisabled()
    expect(screen.getByText(/Checking the sandbox/)).toBeInTheDocument()
    await act(async () => { reject(new Error('the sandbox failed its self-check: it let a command write outside')) })
    expect(screen.getByRole('alert')).toHaveTextContent(/write outside/)
    expect(box).not.toBeDisabled()
  })

  it('disables the done button while the window is being put away', async () => {
    let resolve!: () => void
    const onWindowDone = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    render(<ComputerPanel info={{ ...local, window: true }} botName="Scout" onClose={() => {}} onWindowDone={onWindowDone} />)
    await userEvent.click(screen.getByRole('button', { name: "I\u2019m done signing in" }))
    expect(screen.getByRole('button', { name: 'Closing…' })).toBeDisabled()
    await act(async () => { resolve() })
    expect(screen.getByRole('button', { name: "I\u2019m done signing in" })).not.toBeDisabled()
  })
})

describe('connector access toggles', () => {
  it('omits the Connectors section when no accounts are connected', () => {
    render(<ComputerPanel info={{ ...running, connectors: [] }} botName="Scout" onClose={() => {}} />)
    expect(screen.queryByText('Connectors')).toBeNull()
  })

  it('lists connected accounts with status notes and toggles access per teammate', async () => {
    const onToggleConnector = vi.fn()
    render(
      <ComputerPanel
        info={{
          ...running,
          connectors: [
            { id: 'ca-11112222', app: 'gmail', name: 'Gmail', accountLabel: 'alice@gmail.com', status: 'active', granted: true },
            { id: 'ca-33334444', app: 'slack', name: 'Slack', accountLabel: '', status: 'expired', granted: false },
          ],
        }}
        botName="Scout"
        onClose={() => {}}
        onToggleConnector={onToggleConnector}
      />,
    )
    expect(screen.getByText('Connectors')).toBeInTheDocument()
    const gmailBox = screen.getByRole('checkbox', { name: 'alice@gmail.com' })
    const slackBox = screen.getByRole('checkbox', { name: 'Slack' })
    expect(gmailBox).toBeChecked()
    expect(slackBox).not.toBeChecked()
    expect(screen.getByText('Needs reconnect')).toBeInTheDocument()

    await userEvent.click(slackBox)
    expect(onToggleConnector).toHaveBeenCalledWith('ca-33334444', true)
    await userEvent.click(gmailBox)
    expect(onToggleConnector).toHaveBeenCalledWith('ca-11112222', false)
  })
})

describe('MCP server access toggles', () => {
  it('omits the MCP servers section when no MCP servers are configured', () => {
    render(<ComputerPanel info={{ ...running, mcpServers: [] }} botName="Scout" onClose={() => {}} />)
    expect(screen.queryByText('MCP servers')).toBeNull()
  })

  it('lists configured MCP servers with transport, tool count, and status notes and toggles access per teammate', async () => {
    const onToggleMcpServer = vi.fn()
    const { unmount } = render(
      <ComputerPanel
        info={{
          ...running,
          mcpServers: [
            {
              id: 'mcp-linear',
              name: 'Linear',
              slug: 'linear',
              transport: 'http',
              enabled: true,
              status: 'connected',
              toolCount: 4,
              granted: true,
            },
            {
              id: 'mcp-fs',
              name: 'Filesystem',
              slug: 'filesystem',
              transport: 'stdio',
              enabled: true,
              status: 'error',
              toolCount: 2,
              granted: false,
            },
          ],
        }}
        botName="Scout"
        onClose={() => {}}
        onToggleMcpServer={onToggleMcpServer}
      />,
    )

    expect(screen.getByText('MCP servers')).toBeInTheDocument()
    expect(screen.getByText(/Checked MCP servers can be used by this teammate/)).toBeInTheDocument()
    expect(screen.getByText('4 tools')).toBeInTheDocument()
    expect(screen.getByText('Error')).toBeInTheDocument()

    const linearBox = screen.getByRole('checkbox', { name: 'Linear' })
    const fsBox = screen.getByRole('checkbox', { name: 'Filesystem' })
    expect(linearBox).toBeChecked()
    expect(fsBox).not.toBeChecked()

    await userEvent.click(fsBox)
    expect(onToggleMcpServer).toHaveBeenCalledWith('mcp-fs', true)
    await userEvent.click(linearBox)
    expect(onToggleMcpServer).toHaveBeenCalledWith('mcp-linear', false)

    unmount()
    render(
      <I18nProvider lang="zh-CN">
        <ComputerPanel
          info={{
            ...running,
            mcpServers: [
              {
                id: 'mcp-linear',
                name: 'Linear',
                slug: 'linear',
                transport: 'http',
                enabled: false,
                status: 'disconnected',
                toolCount: 3,
                granted: false,
              },
            ],
          }}
          botName="Scout"
          onClose={() => {}}
          onToggleMcpServer={() => {}}
        />
      </I18nProvider>,
    )
    expect(screen.getByText('MCP 服务')).toBeInTheDocument()
    expect(screen.getByText('3 个工具')).toBeInTheDocument()
  })

  it('lists vault credentials and toggles per-teammate grants', async () => {
    const onToggleVaultItem = vi.fn()
    render(
      <ComputerPanel
        info={{
          ...running,
          vaultItems: [
            {
              id: 'vault-a1b2c3d4',
              slug: 'zendesk',
              name: 'Zendesk Support',
              kind: 'login',
              allowedDomains: ['app.zendesk.com'],
              fieldKeys: ['username', 'password'],
              approvalMode: 'on_taint',
              granted: false,
            },
          ],
        }}
        botName="Scout"
        onClose={() => {}}
        onToggleVaultItem={onToggleVaultItem}
      />,
    )
    expect(screen.getByText('Vault credentials')).toBeInTheDocument()
    expect(screen.getByText('app.zendesk.com')).toBeInTheDocument()
    const checkbox = screen.getByRole('checkbox', { name: 'Zendesk Support' })
    expect(checkbox).not.toBeChecked()
    await userEvent.click(checkbox)
    expect(onToggleVaultItem).toHaveBeenCalledWith('vault-a1b2c3d4', true)
  })

  it('lists spaces and changes per-teammate space role', async () => {
    const onSetSpaceRole = vi.fn()
    render(
      <ComputerPanel
        info={{
          ...running,
          spaces: [
            { id: 'space-11111111', slug: 'pricing', title: 'Pricing Board', icon: '📊', role: null },
          ],
        }}
        botName="Scout"
        onClose={() => {}}
        onSetSpaceRole={onSetSpaceRole}
      />,
    )
    expect(screen.getByText('Space access')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Pricing Board'), 'editor')
    expect(onSetSpaceRole).toHaveBeenCalledWith('space-11111111', 'editor')
  })
})

describe('background tasks section', () => {
  it('omits Background tasks when info.backgroundTasks is undefined and shows empty state when empty', () => {
    const { rerender } = render(<ComputerPanel info={running} botName="Scout" onClose={() => {}} />)
    expect(screen.queryByText('Background tasks')).toBeNull()

    rerender(<ComputerPanel info={{ ...running, backgroundTasks: [] }} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText('Background tasks')).toBeInTheDocument()
    expect(screen.getByText('No background tasks yet')).toBeInTheDocument()
  })

  it('lists live and finished background tasks, forwards steer and cancel, and renders background action trigger', async () => {
    const onSteer = vi.fn().mockResolvedValue(undefined)
    const onCancel = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    const { unmount } = render(
      <ComputerPanel
        info={{
          ...running,
          backgroundTasks: [
            {
              id: 'bg-11112222',
              botId: 'researcher',
              threadId: 'dm:researcher',
              title: 'Scrape competitor docs',
              instructions: 'Collect feature comparison table',
              status: 'running',
              stepCount: 3,
              lastStep: 'browser_extract: feature matrix',
              steps: [],
              summary: '',
              error: '',
              usesBrowser: true,
              messageId: 40,
              createdAt: 1000,
              startedAt: 1050,
              finishedAt: null,
            },
            {
              id: 'bg-33334444',
              botId: 'researcher',
              threadId: 'dm:researcher',
              title: 'Summarize Q2 notes',
              instructions: 'Summarize notes',
              status: 'completed',
              stepCount: 2,
              lastStep: 'write_file: summary.md',
              steps: [],
              summary: 'Summary saved to workspace.',
              error: '',
              usesBrowser: false,
              messageId: 39,
              createdAt: 900,
              startedAt: 910,
              finishedAt: 990,
            },
            {
              id: 'bg-55556666',
              botId: 'researcher',
              threadId: 'dm:researcher',
              title: 'Broken export',
              instructions: 'Export CSV',
              status: 'failed',
              stepCount: 1,
              lastStep: 'shell: export.sh',
              steps: [],
              summary: '',
              error: 'Permission denied',
              usesBrowser: true,
              messageId: 38,
              createdAt: 800,
              startedAt: 810,
              finishedAt: 820,
            },
          ],
          actions: [
            { id: 10, thread_id: 'dm:researcher', trigger: 'background', tool: 'background_task', summary: 'completed: Summarize Q2 notes', ok: true, ms: 80, created_at: Date.now() },
            { id: 12, thread_id: 'group:offsite-crew', trigger: 'pipeline', tool: 'wiki_upsert', summary: 'project/q3-launch', ok: true, ms: 90, created_at: Date.now() },
          ],
        }}
        botName="Scout"
        onClose={() => {}}
        onSteerBackgroundTask={onSteer}
        onCancelBackgroundTask={onCancel}
      />,
    )

    expect(screen.getByText('Background tasks')).toBeInTheDocument()
    expect(screen.getByText('Scrape competitor docs')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Using browser')).toBeInTheDocument()
    expect(screen.getByText('3 steps')).toBeInTheDocument()
    expect(screen.getByText('browser_extract: feature matrix')).toBeInTheDocument()

    expect(screen.getByText('Summarize Q2 notes')).toBeInTheDocument()
    expect(screen.getByText('Summary saved to workspace.')).toBeInTheDocument()
    expect(screen.getByText('Broken export')).toBeInTheDocument()
    expect(screen.getByText('Permission denied')).toBeInTheDocument()
    expect(screen.getByText(/· Background$/)).toBeInTheDocument()
    expect(screen.getByText(/· Pipeline$/)).toBeInTheDocument()

    // Inline steer validates and forwards
    const steerInput = screen.getByPlaceholderText('Send a steering note…') as HTMLInputElement
    await user.click(screen.getByRole('button', { name: 'Steer' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a steering note first.')
    expect(onSteer).not.toHaveBeenCalled()

    await user.type(steerInput, 'Include enterprise pricing')
    await user.click(screen.getByRole('button', { name: 'Steer' }))
    expect(onSteer).toHaveBeenCalledWith('bg-11112222', 'Include enterprise pricing')
    expect(steerInput.value).toBe('')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledWith('bg-11112222')

    unmount()
    render(
      <I18nProvider lang="zh-CN">
        <ComputerPanel
          info={{
            ...running,
            backgroundTasks: [],
            actions: [
              { id: 11, thread_id: 'dm:researcher', trigger: 'background', tool: 'background_task', summary: 'completed: 整理调研报告', ok: true, ms: 80, created_at: Date.now() },
              { id: 13, thread_id: 'group:offsite-crew', trigger: 'pipeline', tool: 'wiki_upsert', summary: 'project/q3', ok: true, ms: 90, created_at: Date.now() },
            ],
          }}
          botName="Scout"
          onClose={() => {}}
        />
      </I18nProvider>,
    )
    expect(screen.getByText('暂无后台任务')).toBeInTheDocument()
    expect(screen.getByText(/· 后台任务$/)).toBeInTheDocument()
    expect(screen.getByText(/· 流水线$/)).toBeInTheDocument()
  })
})
