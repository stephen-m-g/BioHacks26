import { Navigate, Route, Routes } from 'react-router-dom'
import AllLectures from './pages/AllLectures'
import Dashboard from './pages/Dashboard'
import Notes from './pages/Notes'
import Prep from './pages/Prep'
import RawSession from './pages/RawSession'
import Teach from './pages/Teach'

// Teacher-only for now (projected in class). Student views may return later with auth.
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/lectures" element={<AllLectures mode="active" />} />
      <Route path="/archive" element={<AllLectures mode="archived" />} />
      <Route path="/prep/:lectureId" element={<Prep />} />
      <Route path="/teach/:sessionId" element={<Teach />} />
      <Route path="/notes/:sessionId" element={<Notes />} />
      <Route path="/sessions/:sessionId/raw" element={<RawSession />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
