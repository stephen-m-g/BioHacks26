// P4 owns this page. Prepared lectures (ready to launch) and past sessions.
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import SystemCheck from '../components/SystemCheck'
import { createLecture, deleteSession, formatDate, setArchived, startSession } from '../lib/lectures'
import { supabase, supabaseConfigured } from '../lib/supabase'
import type { Lecture, Session } from '../types'

type LectureRow = Lecture & { assets: { count: number }[] }
type SessionRow = Session & { lectures: { title: string } | null }

export default function Dashboard() {
  const navigate = useNavigate()
  const [lectures, setLectures] = useState<LectureRow[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toDelete, setToDelete] = useState<SessionRow | null>(null)

  const load = useCallback(async () => {
    if (!supabaseConfigured) return
    const [l, s] = await Promise.all([
      supabase.from('lectures').select('*, assets(count)').is('archived_at', null).order('created_at', { ascending: false }),
      supabase.from('sessions').select('*, lectures(title)').order('started_at', { ascending: false }),
    ])
    setError(l.error?.message ?? s.error?.message ?? null)
    setLectures((l.data as LectureRow[]) ?? [])
    setSessions((s.data as SessionRow[]) ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Lectures</h1>
        <Link className="btn" to="/teach/demo">
          Try the board (demo)
        </Link>
      </header>

      {!supabaseConfigured && (
        <div className="notice">
          Supabase isn't configured. Copy <code>web/.env.example</code> to <code>web/.env.local</code> and fill it in. The demo board
          works without it.
        </div>
      )}
      {error && <div className="notice warn">{error}</div>}

      <section>
        <div className="section-header">
          <h2>Ready to teach</h2>
          <div className="row">
            <Link className="btn" to="/lectures">
              All lectures & archive
            </Link>
            <button className="primary" disabled={busy || !supabaseConfigured} onClick={() => run(async () => navigate(`/prep/${await createLecture()}`))}>
              + New lecture
            </button>
          </div>
        </div>
        {lectures.length === 0 && <p className="muted">No prepared lectures yet.</p>}
        <ul className="list">
          {lectures.map((l) => (
            <li key={l.id} className="list-item">
              <div className="list-main">
                <div className="list-title">{l.title}</div>
                <div className="muted">
                  {l.assets?.[0]?.count ?? 0} items · created {formatDate(l.created_at)}
                </div>
              </div>
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => run(async () => navigate(`/teach/${await startSession(l.id)}`))}>
                  Start
                </button>
                <Link className="btn" to={`/prep/${l.id}`}>
                  Edit
                </Link>
                <button disabled={busy} onClick={() => run(async () => { await setArchived(l.id, true); await load() })}>
                  Archive
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Past sessions</h2>
        {sessions.length === 0 && <p className="muted">No sessions yet.</p>}
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id} className="list-item">
              <div className="list-main">
                <div className="list-title">{s.lectures?.title ?? 'Lecture'}</div>
                <div className="muted">
                  {formatDate(s.started_at)}
                  {s.status === 'live' && ' · still live'}
                </div>
              </div>
              <div className="row">
                {s.status === 'live' ? (
                  <Link className="btn primary" to={`/teach/${s.id}`}>
                    Resume
                  </Link>
                ) : (
                  <Link className="btn primary" to={`/notes/${s.id}`}>
                    Notes
                  </Link>
                )}
                <Link className="btn" to={`/sessions/${s.id}/raw`}>
                  Raw
                </Link>
                <button className="danger-outline" onClick={() => setToDelete(s)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <SystemCheck />

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this session?"
        confirmLabel="Delete"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={() =>
          run(async () => {
            if (toDelete) await deleteSession(toDelete.id)
            setToDelete(null)
            await load()
          })
        }
      >
        {toDelete?.lectures?.title} from {formatDate(toDelete?.started_at)}. Its board, transcript and notes are deleted permanently. The
        prepared lecture is kept.
      </ConfirmDialog>
    </div>
  )
}
