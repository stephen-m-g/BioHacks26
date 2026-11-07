// P4 owns this page. The board exactly as it ended (read-only, popups work) plus the timestamped transcript.
import { Link, useParams } from 'react-router-dom'
import Board from '../components/Board'
import { useSessionData } from '../hooks/useSessionData'
import { formatDate } from '../lib/lectures'

export default function RawSession() {
  const { sessionId = '' } = useParams()
  const data = useSessionData(sessionId)

  if (data.loading) return <div className="page muted">Loading…</div>
  if (data.error || !data.session) return <div className="page notice warn">{data.error ?? 'Session not found'}</div>

  return (
    <div className="page">
      <header className="page-header">
        <Link className="btn" to="/">
          ← Dashboard
        </Link>
        <div>
          <h1>{data.lecture?.title ?? 'Session'}</h1>
          <div className="muted">Raw board · {formatDate(data.session.started_at)}</div>
        </div>
        <Link className="btn primary" to={`/notes/${sessionId}`}>
          View notes
        </Link>
      </header>

      <Board
        blocks={data.blockList}
        assets={data.assets}
        strokes={data.strokeList}
        annotations={data.annotationList}
        segments={data.segmentList}
      />

      <details className="transcript">
        <summary>Full transcript ({data.segmentList.length} segments)</summary>
        <ol>
          {data.segmentList.map((s) => (
            <li key={s.id}>
              <span className="muted small">{s.t_start ? new Date(s.t_start).toLocaleTimeString() : ''}</span> {s.raw_text}
              {s.confidence !== null && <span className="muted small"> ({Math.round(s.confidence * 100)}%)</span>}
            </li>
          ))}
        </ol>
      </details>
    </div>
  )
}
