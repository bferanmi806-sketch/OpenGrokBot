import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { VaultSnapshot } from '../types'
import { VaultDialog } from './VaultDialog'

const ROSTER = {
  chief: { name: 'Chief', emoji: '🧠' },
  ops: { name: 'Ops', emoji: '🛠' },
}

const SAMPLE_SNAPSHOT: VaultSnapshot = {
  items: [
    {
      id: 'vault-a1b2c3d4',
      slug: 'zendesk',
      name: 'Zendesk Support',
      kind: 'login',
      allowedDomains: ['app.zendesk.com'],
      fields: [
        { key: 'username', kind: 'text', set: true, preview: 'bot@acme.test' },
        { key: 'password', kind: 'secret', set: true, preview: '••••7890' },
        { key: 'totp', kind: 'totp', set: true, preview: '•••••• (TOTP)' },
      ],
      approvalMode: 'on_taint',
      notes: '',
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  botGrants: { ops: ['vault-a1b2c3d4'] },
}

describe('VaultDialog', () => {
  it('lists vault items with masked previews, grants, and MCP ref hint', () => {
    render(
      <VaultDialog
        state={SAMPLE_SNAPSHOT}
        roster={ROSTER}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Zendesk Support')).toBeInTheDocument()
    expect(screen.getByText('app.zendesk.com')).toBeInTheDocument()
    expect(screen.getByText(/password: ••••7890/)).toBeInTheDocument()
    expect(screen.getByText(/Shared with: Ops/)).toBeInTheDocument()
    expect(screen.getByText(/\$\{vault:zendesk\.<field>\}/)).toBeInTheDocument()
  })

  it('creates a new vault item with zero default teammate grants unless checked', async () => {
    const createSpy = vi.spyOn(api, 'createVaultItem').mockResolvedValue({
      item: SAMPLE_SNAPSHOT.items[0]!,
      snapshot: SAMPLE_SNAPSHOT,
    })
    const onChange = vi.fn()
    render(
      <VaultDialog
        state={{ items: [], botGrants: {} }}
        roster={ROSTER}
        onChange={onChange}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Add credential' }))
    await userEvent.type(screen.getByPlaceholderText('e.g. Zendesk Support'), 'Acme Login')
    await userEvent.type(screen.getByPlaceholderText('app.zendesk.com, *.internal.acme.com'), 'app.acme.test')
    await userEvent.type(screen.getByLabelText('password Value'), 'Secret!123')
    await userEvent.click(screen.getByRole('checkbox', { name: /Ops/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Acme Login',
      kind: 'login',
      allowedDomains: ['app.acme.test'],
      approvalMode: 'on_taint',
      values: { password: 'Secret!123' },
      botIds: ['ops'],
    }))
    expect(onChange).toHaveBeenCalledWith(SAMPLE_SNAPSHOT)
    createSpy.mockRestore()
  })

  it('edits an existing item keeping untouched secrets and clearing explicitly cleared fields', async () => {
    const updateSpy = vi.spyOn(api, 'updateVaultItem').mockResolvedValue({
      item: SAMPLE_SNAPSHOT.items[0]!,
      snapshot: SAMPLE_SNAPSHOT,
    })
    const onChange = vi.fn()
    render(
      <VaultDialog
        state={SAMPLE_SNAPSHOT}
        roster={ROSTER}
        onChange={onChange}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const clearButtons = screen.getAllByRole('button', { name: 'Clear' })
    // Clear the third field (totp), leave password blank so it stays untouched
    await userEvent.click(clearButtons[2]!)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(updateSpy).toHaveBeenCalledWith('vault-a1b2c3d4', expect.objectContaining({
      values: { totp: null },
      botIds: ['ops'],
    }))
    updateSpy.mockRestore()
  })

  it('confirms before deleting a vault item', async () => {
    const delSpy = vi.spyOn(api, 'deleteVaultItem').mockResolvedValue({
      ok: true,
      snapshot: { items: [], botGrants: {} },
    })
    const onChange = vi.fn()
    render(
      <VaultDialog
        state={SAMPLE_SNAPSHOT}
        roster={ROSTER}
        onChange={onChange}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText(/Delete "Zendesk Support"/)).toBeInTheDocument()
    const deleteBtns = screen.getAllByRole('button', { name: 'Delete' })
    await userEvent.click(deleteBtns[deleteBtns.length - 1]!)

    expect(delSpy).toHaveBeenCalledWith('vault-a1b2c3d4')
    expect(onChange).toHaveBeenCalledWith({ items: [], botGrants: {} })
    delSpy.mockRestore()
  })
})
