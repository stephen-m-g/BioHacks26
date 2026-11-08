// P4 owns this. The transcript view of a session (rendered inside the Notes page, which keeps the header
// and data so switching views doesn't reload): the board as it ended, one card per page or image
// (read-only, popups work), plus the timestamped transcript.
import TranscriptBoard from '../components/TranscriptBoard'
import type { useSessionData } from '../hooks/useSessionData'

export function TranscriptBody({ data }: { data: ReturnType<typeof useSessionData> }) {
  if (data.loading) return <p className="p4-empty">Loading…</p>
  if (data.error || !data.session)
    return (
      <div className="p4-notice warn" role="alert">
        <span>{data.error ?? 'Session not found'}</span>
      </div>
    )

  const segments = data.segmentList

  return (
    <>
      <section className="sv-section" aria-labelledby="board-heading">
        <div className="sv-section-head">
          <h2 id="board-heading" className="lp-label">
            Board
          </h2>
          <span className="lp-hint">Original speech, as recognized</span>
        </div>
        <TranscriptBoard
          blocks={data.blockList}
          assets={data.assets}
          strokes={data.strokeList}
          annotations={data.annotationList}
          segments={segments}
        />
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
    </>
  )
}
