import { Navigate, Route, Routes } from 'react-router-dom'
import AllLectures from './pages/AllLectures'
import Dashboard from './pages/Dashboard'
import Join from './pages/Join'
import Live from './pages/Live'
import Notes from './pages/Notes'
import Prep from './pages/Prep'
import RawSession from './pages/RawSession'
import Sessions from './pages/Sessions'
import Teach from './pages/Teach'

// Teacher pages (the live board is projected in class) plus a read-only student side: students join with the
// code on the projected screen (/join) and follow the board live on their phones (/live/:sessionId). No auth yet.
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/lectures" element={<AllLectures mode="active" />} />
      <Route path="/archive" element={<AllLectures mode="archived" />} />
      <Route path="/sessions" element={<Sessions />} />
      <Route path="/prep/:lectureId" element={<Prep />} />
      <Route path="/teach/:sessionId" element={<Teach />} />
      <Route path="/notes/:sessionId" element={<Notes />} />
      <Route path="/sessions/:sessionId/raw" element={<RawSession />} />
      <Route path="/join" element={<Join />} />
      <Route path="/join/:code" element={<Join />} />
      <Route path="/live/:sessionId" element={<Live />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
