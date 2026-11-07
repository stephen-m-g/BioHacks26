import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, API_URL } from '../lib/api'
import { supabase, supabaseConfigured } from '../lib/supabase'

type Status = 'checking' | 'ok' | 'error'

/** Landing page plus a wiring check: is the API reachable and is Supabase reachable? */
export default function Home() {
  const [apiStatus, setApiStatus] = useState<Status>('checking')
  const [dbStatus, setDbStatus] = useState<Status>('checking')
  const [dbError, setDbError] = useState<string>('')

  useEffect(() => {
    api
      .health()
      .then((r) => setApiStatus(r.ok ? 'ok' : 'error'))
      .catch(() => setApiStatus('error'))

    if (!supabaseConfigured) {
      setDbStatus('error')
      setDbError('env vars not set')
      return
    }
    supabase
      .from('lectures')
      .select('id', { count: 'exact', head: true })
      .then(({ error }) => {
        setDbStatus(error ? 'error' : 'ok')
        if (error) setDbError(error.message)
      })
  }, [])

  return (
    <div className="page">
      <h1>Board</h1>
      <div className="row">
        <Link className="btn primary" to="/prep">
          Teacher: prepare a lecture
        </Link>
        <Link className="btn" to="/join">
          Student: join a class
        </Link>
      </div>

      <h3 style={{ marginTop: 48 }}>System check</h3>
      <ul className="muted">
        <li>
          API ({API_URL}): <b>{apiStatus}</b>
        </li>
        <li>
          Supabase: <b>{dbStatus}</b> {dbError && `(${dbError})`}
        </li>
      </ul>
    </div>
  )
}
