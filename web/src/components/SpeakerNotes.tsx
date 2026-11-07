// P3 owns this component. Used on both the teacher and student views.
// TODO (P3): subscribe to transcript_segments (INSERT + UPDATE) for session+slide, show
// clean_text ?? raw_text (raw in grey italics), interim line when `live`, auto-scroll.
export interface SpeakerNotesProps {
  sessionId: string
  slideId: string | null
  live?: boolean
}

export default function SpeakerNotes({ live }: SpeakerNotesProps) {
  return (
    <div style={{ minHeight: 120, padding: 16, borderTop: '2px solid #ddd', fontSize: 18 }}>
      <span className="muted">Speaker notes {live ? '(live)' : ''}</span>
    </div>
  )
}
