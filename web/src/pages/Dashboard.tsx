// P4 owns this page. Prepared lectures (ready to launch) and past sessions.
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import SystemCheck from '../components/SystemCheck'
import { IconArrowRight, IconClock, IconDots, IconEdit, IconFile, IconImage, IconPlay, IconPlus } from '../components/DashIcons'
import { createLecture, deleteSession, formatDate, setArchived, startSession } from '../lib/lectures'
import { supabase, supabaseConfigured } from '../lib/supabase'
import type { Lecture, Session } from '../types'
import '../styles/dashboard.css'

type LectureRow = Lecture & { assets: { kind: string; created_at: string }[] | null }
/** lecture_notes is one-to-one with sessions; PostgREST may return it as an object or an array. */
type SessionRow = Session & {
  lectures: { title: string } | null
  lecture_notes: { session_id: string } | { session_id: string }[] | null
}

// ---------- small display helpers ----------
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function initials(title: string | null | undefined) {
  const words = (title ?? '').trim().split(/\s+/).filter(Boolean)
  const letters = (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')
  return letters.toUpperCase() || '?'
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function relative(iso: string) {
  const then = new Date(iso)
  const mins = Math.round((Date.now() - then.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameDay(then, yesterday)) return 'yesterday'
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function sessionWhen(s: Session) {
  const start = new Date(s.started_at)
  const time = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  let day = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (isSameDay(start, new Date())) day = 'Today'
  else if (isSameDay(start, yesterday)) day = 'Yesterday'
  const mins = s.ended_at ? Math.max(1, Math.round((new Date(s.ended_at).getTime() - start.getTime()) / 60000)) : null
  return `${day}, ${time}${mins ? ` · ${mins} min` : ''}`
}

/** The schema has no updated_at, so "updated" = the newest upload, or creation if there are none. */
function lastUpdated(l: LectureRow) {
  return (l.assets ?? []).reduce((latest, a) => (a.created_at > latest ? a.created_at : latest), l.created_at)
}

function hasNotes(s: SessionRow) {
  const n = s.lecture_notes
  return Array.isArray(n) ? n.length > 0 : !!n
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [lectures, setLectures] = useState<LectureRow[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<SessionRow | null>(null)

  const load = useCallback(async () => {
    if (!supabaseConfigured) return
    const [l, s] = await Promise.all([
      supabase
        .from('lectures')
        .select('*, assets(kind, created_at)')
        .is('archived_at', null)
        .order('created_at', { ascending: false }),
      supabase.from('sessions').select('*, lectures(title), lecture_notes(session_id)').order('started_at', { ascending: false }),
    ])
    setError(l.error?.message ?? s.error?.message ?? null)
    const rows = (l.data as LectureRow[]) ?? []
    rows.sort((a, b) => lastUpdated(b).localeCompare(lastUpdated(a)))
    setLectures(rows)
    setSessions((s.data as SessionRow[]) ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMenu(null)
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
      </header>

      {!supabaseConfigured && (
        <div className="notice">
          Supabase isn't configured. Copy <code>web/.env.example</code> to <code>web/.env.local</code> and fill it in.
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
            <button className="primary" disabled={busy || !supabaseConfigured} onClick={() => run(async () => navigate(`/prep/${await createLecture()}?new=1`))}>
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
                <button className="primary" disabled={busy} onClick={() => run(async () => navigate(`/teach/${await startSession(l.id, l.title)}`))}>
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
                <div className="list-title">{s.title || s.lectures?.title || 'Lecture'}</div>
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
        {toDelete?.title || toDelete?.lectures?.title} from {formatDate(toDelete?.started_at)}. Its board, transcript and notes are deleted permanently. The
        prepared lecture is kept.
      </ConfirmDialog>
    </div>
  )
}
