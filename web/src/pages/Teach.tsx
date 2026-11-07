// P1 owns this page: teacher canvas (ink, circles with check/cross, image bank, slide nav, End Session).
import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import SlideRenderer from '../components/SlideRenderer'
import SpeakerNotes from '../components/SpeakerNotes'
import { useSessionStore } from '../store/session'

export default function Teach() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const currentSlideId = useSessionStore((s) => s.currentSlideId)
  const setSession = useSessionStore((s) => s.setSession)

  useEffect(() => {
    // TODO (P1): load the session + its lecture's slides, then set lectureId and currentSlideId.
    setSession(sessionId ?? null, null)
  }, [sessionId, setSession])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SlideRenderer slide={null} strokes={[]} placedImages={[]} annotations={[]} readOnly={false} />
      </div>
      {/* Slot for P3's speaker notes */}
      {sessionId && <SpeakerNotes sessionId={sessionId} slideId={currentSlideId} live />}
    </div>
  )
}
