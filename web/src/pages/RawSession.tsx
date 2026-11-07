// P4 owns this page. The board exactly as it ended (read-only, popups work) plus the timestamped transcript.
import { Link, useParams } from 'react-router-dom'
import Board from '../components/Board'
import { IconArrowLeft, IconArrowRight, IconClock, IconText } from '../components/DashIcons'
import { useSessionData } from '../hooks/useSessionData'
import { formatDate } from '../lib/lectures'
import '../styles/p4.css'
import '../styles/study.css'

export default function RawSession() {
  const { sessionId = '' } = useParams()
  const data = useSessionData(sessionId)

  const top = (
    <header className="p4-top">
      <Link className="p4-btn" to="/">
        <IconArrowLeft /> Lectures
      </Link>
      <div className="p4-spacer" />
      {data.session && (
        <Link className="p4-btn solid" to={`/notes/${sessionId}`}>
          Open notes <IconArrowRight />
        </Link>
      )}
    </header>
  )

  if (data.loading)
    return (
      <div className="p4">
        {top}
        <div className="p4-inner">
          <p className="p4-empty">Loading…</p>
        </div>
      </div>
    )
  if (data.error || !data.session)
    return (
      <div className="p4">
        {top}
        <div className="p4-inner">
          <div className="p4-notice warn" role="alert">
            <span>{data.error ?? 'Session not found'}</span>
          </div>
        </div>
      </div>
    )

  const segments = data.segmentList

  return (
    <div className="p4">
      {top}
      <div className="p4-inner">
        <span className="p4-badge dark">Raw board</span>
        <h1 className="p4-title" style={{ marginTop: 16 }}>
          {data.session.title || data.lecture?.title || 'Session'}
        </h1>
        <p className="p4-sub">
          <span>
            <IconClock /> {formatDate(data.session.started_at)}
          </span>
          <span>
            <IconText /> {segments.length} transcript {segments.length === 1 ? 'segment' : 'segments'}
          </span>
        </p>

        <div className="p4-card st-board">
          <Board
            blocks={data.blockList}
            assets={data.assets}
            strokes={data.strokeList}
            annotations={data.annotationList}
            segments={segments}
          />
        </div>

        <section className="p4-section" aria-labelledby="transcript-heading">
          <div className="p4-section-head">
            <h2 id="transcript-heading" className="p4-label">
              Transcript
            </h2>
            <span className="p4-hint">Exactly as recognized, before cleanup</span>
          </div>
          {segments.length === 0 ? (
            <p className="p4-empty">No speech was recorded in this session.</p>
          ) : (
            <div className="p4-card">
              <ol className="st-transcript">
                {segments.map((s) => (
                  <li key={s.id}>
                    <span className="st-time">{s.t_start ? new Date(s.t_start).toLocaleTimeString() : ''}</span>
                    <span>
                      {s.raw_text}
                      {s.confidence !== null && <span className="st-conf">{Math.round(s.confidence * 100)}% sure</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
