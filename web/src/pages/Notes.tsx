// P4 owns this page: render the compiled notes JSON; teacher sees the draft with a Publish button,
// students see it once published (realtime). Needs a print stylesheet for "Save as PDF".
import { useParams } from 'react-router-dom'

export default function Notes() {
  const { sessionId } = useParams<{ sessionId: string }>()
  return (
    <div className="page">
      <h1>Lecture notes</h1>
      <p className="muted">Session {sessionId}</p>
      <p className="muted">TODO (P4): render notes and the Publish button.</p>
    </div>
  )
}
