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

  const today = new Date()
  const sessionsToday = sessions.filter((s) => isSameDay(new Date(s.started_at), today)).length

  /** "···" button with a small menu. Tap to open, tap outside to close (no long-press). */
  const moreMenu = (key: string, label: string, items: { label: string; danger?: boolean; onClick: () => void }[]) => (
    <div className="dash-menu-wrap">
      <button
        className="dash-btn icon-only"
        aria-label={`More actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={menu === key}
        onClick={() => setMenu(menu === key ? null : key)}
      >
        <IconDots />
      </button>
      {menu === key && (
        <>
          <div className="dash-menu-backdrop" onClick={() => setMenu(null)} />
          <div className="dash-menu" role="menu">
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                className={`dash-btn dash-menu-item${item.danger ? ' danger' : ''}`}
                disabled={busy}
                onClick={item.onClick}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )

  return (
    <div className="dash">
      <div className="dash-inner">
        <header className="dash-header">
          <div>
            <h1 className="dash-title">Lectures</h1>
            {supabaseConfigured && (
              <p className="dash-sub">
                {lectures.length} ready to present · {plural(sessionsToday, 'session')} today
              </p>
            )}
          </div>
          <button
            className="dash-btn solid"
            disabled={busy || !supabaseConfigured}
            onClick={() => run(async () => navigate(`/prep/${await createLecture()}`))}
          >
            <IconPlus /> New lecture
          </button>
        </header>

        {!supabaseConfigured && (
          <div className="dash-notice">
            Supabase isn't configured. Copy <code>web/.env.example</code> to <code>web/.env.local</code> and fill it in.
          </div>
        )}
        {error && (
          <div className="dash-notice warn" role="alert">
            {error}
          </div>
        )}

        <section className="dash-section" aria-labelledby="ready-heading">
          <div className="dash-section-head">
            <h2 id="ready-heading" className="dash-label">
              Ready to present
            </h2>
            {lectures.length > 1 && <span className="dash-hint">Sorted by last updated</span>}
          </div>
          {supabaseConfigured && lectures.length === 0 && (
            <p className="dash-empty">Create your first lecture to upload diagrams and notes before class.</p>
          )}
          <ul className="dash-list">
            {lectures.map((l) => {
              const images = (l.assets ?? []).filter((a) => a.kind === 'image').length
              const notes = (l.assets ?? []).length - images
              return (
                <li key={l.id} className="dash-row">
                  <div className="dash-avatar" aria-hidden="true">
                    {initials(l.title)}
                  </div>
                  <div className="dash-main">
                    <h3 className="dash-row-title">{l.title}</h3>
                    <div className="dash-meta">
                      <span>
                        <IconImage /> {plural(images, 'image')}
                      </span>
                      <span>
                        <IconFile /> {plural(notes, 'note')}
                      </span>
                      <span>Updated {relative(lastUpdated(l))}</span>
                    </div>
                  </div>
                  <div className="dash-actions">
                    <Link className="dash-btn" to={`/prep/${l.id}`}>
                      <IconEdit /> Edit
                    </Link>
                    {moreMenu(`l:${l.id}`, l.title, [
                      {
                        label: 'Archive',
                        onClick: () =>
                          run(async () => {
                            await setArchived(l.id, true)
                            await load()
                          }),
                      },
                    ])}
                    <button
                      className="dash-btn solid"
                      disabled={busy}
                      onClick={() => run(async () => navigate(`/teach/${await startSession(l.id, l.title)}`))}
                    >
                      <IconPlay /> Start
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="dash-section" aria-labelledby="past-heading">
          <div className="dash-section-head">
            <h2 id="past-heading" className="dash-label">
              Past sessions
            </h2>
            {sessions.length > 1 && <span className="dash-hint">Newest first</span>}
          </div>
          {supabaseConfigured && sessions.length === 0 && (
            <p className="dash-empty">Sessions appear here after you start a lecture.</p>
          )}
          <ul className="dash-list">
            {sessions.map((s) => {
              const title = s.title || s.lectures?.title || 'Lecture'
              const live = s.status === 'live'
              return (
                <li key={s.id} className={`dash-row${live ? '' : ' past'}`}>
                  <div className="dash-avatar dark" aria-hidden="true">
                    {initials(title)}
                  </div>
                  <div className="dash-main">
                    <h3 className="dash-row-title">{title}</h3>
                    <div className="dash-meta">
                      <span>
                        <IconClock /> {sessionWhen(s)}
                      </span>
                      {live ? (
                        <span className="dash-badge live">Live</span>
                      ) : (
                        hasNotes(s) && <span className="dash-badge">Notes ready</span>
                      )}
                    </div>
                  </div>
                  <div className="dash-actions">
                    <Link className="dash-btn quiet" to={`/sessions/${s.id}/raw`}>
                      Transcript
                    </Link>
                    {moreMenu(`s:${s.id}`, title, [{ label: 'Delete session', danger: true, onClick: () => { setMenu(null); setToDelete(s) } }])}
                    {live ? (
                      <Link className="dash-btn solid" to={`/teach/${s.id}`}>
                        <IconPlay /> Resume
                      </Link>
                    ) : (
                      <Link className="dash-btn" to={`/notes/${s.id}`}>
                        Open notes <IconArrowRight />
                      </Link>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>

        <p className="dash-footer">
          Archived lectures live in <Link to="/lectures">Archive</Link>.
        </p>

        <SystemCheck />
      </div>

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
