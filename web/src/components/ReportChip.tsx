import type { ReportPayload } from '../types'

export function ReportChip({ payload }: { payload: ReportPayload }) {
  return (
    <div className="report-chip">
      {payload.lines.length > 0 ? (
        <ul className="report-lines" role="list">
          {payload.lines.map((line, i) => (
            <li className="report-line" key={i}>
              <span className="report-check" aria-hidden="true">✓</span>
              <div className="report-line-text">
                <span className="report-system">{line.system}</span>
                <span className="report-result">{line.result}</span>
              </div>
              {line.count ? <span className="report-count">{line.count}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {payload.closing ? <div className="report-closing">{payload.closing}</div> : null}
    </div>
  )
}
