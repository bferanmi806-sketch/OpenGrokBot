import type { GoalUpdatedPayload } from '../types'
import { useT, type MessageKey } from '../i18n'

export function GoalChip({ payload }: { payload: GoalUpdatedPayload }) {
  const t = useT()
  const labelKey = `goalChip.kind.${payload.kind}` as MessageKey
  return (
    <div className={`goal-chip${payload.tainted ? ' tainted' : ''}`}>
      <div className="goal-chip-head">
        <span className="goal-chip-label">{t(labelKey)}</span>
        {payload.tainted ? <span className="feed-tainted-badge">{t('goalChip.tainted')}</span> : null}
      </div>
      <div className="goal-chip-title">{payload.goalTitle}</div>
      {payload.diff ? <pre className="memory-diff">{payload.diff}</pre> : <div className="goal-chip-summary">{payload.summary}</div>}
    </div>
  )
}
