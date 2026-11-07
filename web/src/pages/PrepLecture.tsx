// P4 owns this page: uploads (images to Storage at assets/{lectureId}/{uuid}.png, text into
// text_content), POST /assets/{id}/describe after each upload, slide template builder, Start session.
import { useParams } from 'react-router-dom'

export default function PrepLecture() {
  const { lectureId } = useParams<{ lectureId: string }>()
  return (
    <div className="page">
      <h1>Prepare lecture</h1>
      <p className="muted">Lecture {lectureId}</p>
      <p className="muted">TODO (P4): uploads, image bank, slide template, Start session.</p>
    </div>
  )
}
