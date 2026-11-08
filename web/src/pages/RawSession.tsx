// P4 owns this page. The board exactly as it ended (read-only, popups work) plus the timestamped transcript.
import { useParams } from 'react-router-dom'
import Board from '../components/Board'
import SessionHeader from '../components/SessionHeader'
import { useSessionData } from '../hooks/useSessionData'
import { formatDate } from '../lib/lectures'
import { NO_EXPLANATION, rawAnnotationExplanation } from './notesModel'
import '../styles/p4.css'
import '../styles/study.css'

export default function RawSession() {
  const { sessionId = '' } = useParams()
  const data = useSessionData(sessionId)

  const title = data.session?.title || data.lecture?.title || 'Session'
  const header = (
    <SessionHeader
      sessionId={sessionId}
      title={title}
      view="transcript"
      when={data.session ? formatDate(data.session.started_at) : undefined}
    />
  )

  if (data.loading)
    return (
      <div className="p4">
        {header}
        <main className="sv-body">
          <p className="p4-empty">Loading…</p>
        </main>
      </div>
    )
  if (data.error || !data.session)
    return (
      <div className="p4">
        {header}
        <main className="sv-body">
          <div className="p4-notice warn" role="alert">
            <span>{data.error ?? 'Session not found'}</span>
          </div>
        </main>
      </div>
    )

  const segments = data.segmentList
  // Popovers show his linked words as recognized, not the cleaned bubble the notes use.
  const rawAnnotations = data.annotationList.map((annotation) => ({
    ...annotation,
    bubble_text: rawAnnotationExplanation(annotation.id, segments) ?? NO_EXPLANATION,
  }))

  return (
    <div className="p4">
      {header}
      <main className="sv-body">
        <div className="st-article">
          <section className="sv-section" aria-labelledby="board-heading">
            <div className="sv-section-head">
              <h2 id="board-heading" className="lp-label">
                Board
              </h2>
              <span className="lp-hint">As it was when the session ended</span>
            </div>
            <div className="p4-card st-board">
              <Board
                blocks={data.blockList}
                assets={data.assets}
                strokes={data.strokeList}
                annotations={rawAnnotations}
                segments={segments}
              />
            </div>
          </section>

          <section className="sv-section" aria-labelledby="transcript-heading">
            <div className="sv-section-head">
              <div className="sv-section-title">
                <h2 id="transcript-heading" className="lp-label">
                  Transcript
                </h2>
                <span className="lp-count" aria-label={`${segments.length} segments`}>
                  {segments.length}
                </span>
              </div>
              <span className="lp-hint">Exactly as recognized, before cleanup</span>
            </div>
            {segments.length === 0 ? (
              <p className="p4-empty">No speech was recorded in this session.</p>
            ) : (
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
            )}
          </section>
        </div>
      </main>
    </div>
  )
}
