import type { RoutinePayload } from '../types'
import { describeSchedule } from '../i18n/describe'
import { useT } from '../i18n'
import { BookOpenIcon, ClockIcon, EyeIcon, LinkIcon } from './Icons'

export function RoutineChip({ payload }: { payload: RoutinePayload }) {
  const t = useT()
  const watch = payload.mode === 'watch'
  const prepare = payload.mode === 'prepare'
  const icon = watch
    ? <EyeIcon />
    : prepare
      ? <BookOpenIcon size={14} />
      : payload.webhook && !payload.cron
        ? <LinkIcon />
        : <ClockIcon />
  const labelKey = watch
    ? 'routine.createdWatch'
    : prepare
      ? 'routine.createdPrepare'
      : 'routine.createdRoutine'
  return (
    <div className="routine-chip">
      <div className="routine-label">{t(labelKey)}</div>
      <div className="routine-name">
        <span className="routine-icon">{icon}</span>
        <span>{payload.name}</span>
      </div>
      <div className="routine-when">{t.lang === 'en' ? payload.human : describeSchedule(t, payload.cron, Boolean(payload.webhook))}</div>
      {watch ? (
        <div className="routine-hint">{t('routine.watchHint')}</div>
      ) : prepare ? (
        <div className="routine-hint">{t('routine.prepareHint')}</div>
      ) : null}
      {payload.webhook ? (
        <div className="routine-hint">{t('routine.webhookHint')}</div>
      ) : null}
    </div>
  )
}
