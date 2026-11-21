import { useT } from '../i18n'
import type { QuietDigestEntry, QuietDigestPayload } from '../types'
import { Markdown } from './Markdown'

function formatDigestTime(ts: number | undefined, locale: string | undefined): string | null {
  if (!ts || ts < 86_400_000) return null
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

function DigestEntryBody({ entry }: { entry: QuietDigestEntry }) {
  if (entry.kind === 'report' && entry.report?.lines?.length) {
    return (
      <div className="quiet-digest-report">
        {entry.report.lines.map((line, idx) => (
          <div className="report-line" key={idx}>
            <span className="report-check">✓</span>
            <span className="report-system">{line.system}</span>
            <span className="report-arrow">→</span>
            <span className="report-result">
              {line.result}
              {line.count ? <span className="report-count"> · {line.count}</span> : null}
            </span>
          </div>
        ))}
        {entry.report.closing ? <div className="report-closing">{entry.report.closing}</div> : null}
      </div>
    )
  }
  const text = (entry.text || entry.summary || '').trim()
  if (!text) return null
  return (
    <div className="quiet-digest-text markdown">
      <Markdown text={text} />
    </div>
  )
}

export function QuietDigestChip({ payload }: { payload: QuietDigestPayload }) {
  const t = useT()
  const count = payload.itemCount || payload.items.length
  const title = count === 1
    ? t('quietDigest.titleOne')
    : t('quietDigest.titleMany', { count })

  return (
    <div className="quiet-digest-chip">
      <div className="quiet-digest-head">
        <div className="quiet-digest-title-row">
          <div className="quiet-digest-title">{title}</div>
          {payload.flushedManually ? (
            <span className="quiet-digest-early">{t('quietDigest.deliveredEarly')}</span>
          ) : null}
        </div>
        <div className="quiet-digest-window">
          {t('quietDigest.window', { start: payload.windowStart, end: payload.windowEnd })}
        </div>
      </div>

      <div className="quiet-digest-items">
        {payload.items.map((entry) => {
          const time = formatDigestTime(entry.createdAt, t.locale)
          const modeLabel = entry.routineMode === 'watch'
            ? t('panel.watchTag')
            : entry.routineMode === 'prepare'
              ? t('panel.prepareTag')
              : null
          return (
            <div className="quiet-digest-item" key={entry.id}>
              <div className="quiet-digest-item-meta">
                <span className="quiet-digest-item-name">
                  {entry.routineName || t('quietDigest.routineFallback')}
                </span>
                {modeLabel ? (
                  <span className={`quiet-digest-mode ${entry.routineMode}`}>{modeLabel}</span>
                ) : null}
                {time ? (
                  <time className="quiet-digest-time" dateTime={new Date(entry.createdAt).toISOString()}>
                    {time}
                  </time>
                ) : null}
              </div>
              <div className="quiet-digest-item-body">
                <DigestEntryBody entry={entry} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
