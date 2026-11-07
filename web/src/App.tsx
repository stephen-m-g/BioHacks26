import { Navigate, Route, Routes } from 'react-router-dom'
import Home from './pages/Home'
import PrepList from './pages/PrepList'
import PrepLecture from './pages/PrepLecture'
import Teach from './pages/Teach'
import Join from './pages/Join'
import Student from './pages/Student'
import Notes from './pages/Notes'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      {/* P4 */}
      <Route path="/prep" element={<PrepList />} />
      <Route path="/prep/:lectureId" element={<PrepLecture />} />
      {/* P1 */}
      <Route path="/teach/:sessionId" element={<Teach />} />
      {/* P4 */}
      <Route path="/join" element={<Join />} />
      <Route path="/s/:sessionId" element={<Student />} />
      <Route path="/notes/:sessionId" element={<Notes />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
