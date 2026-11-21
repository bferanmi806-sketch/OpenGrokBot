import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryChip } from './MemoryChip'

describe('MemoryChip', () => {
  it('announces the update and shows the rule and diff', () => {
    render(<MemoryChip payload={{ rule: 'quiet accounts wait for your read', diff: '+ - quiet accounts wait for your read', total: 3 }} />)
    expect(screen.getByText('Memory updated')).toBeInTheDocument()
    expect(screen.getByText('quiet accounts wait for your read')).toBeInTheDocument()
    expect(screen.getByText('+ - quiet accounts wait for your read')).toBeInTheDocument()
    expect(screen.getByText('3 rules on file')).toBeInTheDocument()
  })

  it('says "1 rule on file" in the singular', () => {
    render(<MemoryChip payload={{ rule: 'r', diff: '+ - r', total: 1 }} />)
    expect(screen.getByText('1 rule on file')).toBeInTheDocument()
  })

  it('shows removed-by-you note only for removals, not operator-accepted additions', () => {
    const { rerender } = render(
      <MemoryChip payload={{ rule: 'Never email bob', diff: '+ - Never email bob', total: 2, by: 'operator' }} />,
    )
    expect(screen.queryByText(/Removed by you/)).toBeNull()
    expect(screen.getByText('2 rules on file')).toBeInTheDocument()

    rerender(
      <MemoryChip payload={{ rule: 'Never email bob', diff: '- - Never email bob', total: 1, removed: true, by: 'operator' }} />,
    )
    expect(screen.getByText(/Removed by you from the computer panel/)).toBeInTheDocument()
  })
})
