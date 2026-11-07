// P4 owns this page: read-only student board. Follows sessions.current_slide_id live and renders
// P1's <SlideRenderer readOnly> with confirmed annotations only, plus P3's <SpeakerNotes/>.
import { useParams } from 'react-router-dom'
import SlideRenderer from '../components/SlideRenderer'
import SpeakerNotes from '../components/SpeakerNotes'

export default function Student() {
  const { sessionId } = useParams<{ sessionId: string }>()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SlideRenderer slide={null} strokes={[]} placedImages={[]} annotations={[]} readOnly />
      </div>
      {sessionId && <SpeakerNotes sessionId={sessionId} slideId={null} />}
    </div>
  )
}
