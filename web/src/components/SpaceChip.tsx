import type { SpaceUpdatedPayload } from '../types'
import { useT, type MessageKey } from '../i18n'

export function SpaceChip({ payload }: { payload: SpaceUpdatedPayload }) {
  const t = useT()
  const labelKey = `spaceChip.kind.${payload.kind}` as MessageKey
  return (
    <div className={`goal-chip space-chip${payload.tainted ? ' tainted' : ''}`}>
      <div className="goal-chip-head">
        <span className="goal-chip-label">{t(labelKey)}</span>
        {payload.tainted ? <span className="feed-tainted-badge">{t('spaceChip.tainted')}</span> : null}
      </div>
      <div className="goal-chip-title">{payload.spaceTitle}</div>
      {payload.diff ? <pre className="memory-diff">{payload.diff}</pre> : <div className="goal-chip-summary">{payload.summary}</div>}
    </div>
  )
}
