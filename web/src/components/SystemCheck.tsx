import { useEffect, useState } from 'react'
import { api, API_URL } from '../lib/api'
import { supabase, supabaseConfigured } from '../lib/supabase'

type Status = 'checking' | 'ok' | 'error'

/** Small footer showing whether the API and Supabase are reachable. */
export default function SystemCheck() {
  const [apiStatus, setApiStatus] = useState<Status>('checking')
  const [dbStatus, setDbStatus] = useState<Status>('checking')
  const [dbError, setDbError] = useState('')

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
    <footer className="system-check muted">
      API ({API_URL}): <b>{apiStatus}</b> · Supabase: <b>{dbStatus}</b> {dbError && `(${dbError})`}
    </footer>
  )
}
