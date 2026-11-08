// P4 owns this page. Bento dashboard: class filter on top, then Ready to present (list), Archive (link card)
// and Recorded sessions (list). The page fits one screen; each list scrolls inside its own card.
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ClassDot, ClassDotButton, ClassPickerDialog, ManageClassesDialog, type ClassEdits } from '../components/Classes'
import ConfirmDialog from '../components/ConfirmDialog'
import { IconArrowRight, IconClock, IconDots, IconEdit, IconFile, IconImage, IconPlay, IconPlus } from '../components/DashIcons'
import { createClass, deleteClass, listClasses, setLectureClasses, setSessionClasses, updateClass } from '../lib/classes'
import { createLecture, deleteLecture, deleteSession, formatDate, setArchived, startSession } from '../lib/lectures'
import { supabase, supabaseConfigured } from '../lib/supabase'
import type { ClassGroup, Lecture, Session } from '../types'
import '../styles/dashboard.css'

type ClassLink = { class_id: string }
type LectureRow = Lecture & {
  assets: { kind: string; created_at: string }[] | null
  lecture_classes?: ClassLink[] | null
  sessions?: { id: string }[] | null
}
/** lecture_notes is one-to-one with sessions; PostgREST may return it as an object or an array. */
type SessionRow = Session & {
  lectures: { title: string } | null
  lecture_notes: { session_id: string } | { session_id: string }[] | null
  session_classes?: ClassLink[] | null
}

/** Selected class ids; empty means "All". Remembered per device. */
type Filter = string[]
const FILTER_KEY = 'dash-class-filter'
function readFilter(): Filter {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw || raw === 'all') return []
    const parsed: unknown = raw.startsWith('[') ? JSON.parse(raw) : [raw] // older builds stored one id
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function writeFilter(f: Filter) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(f))
  } catch {
    // private mode / blocked storage: the filter just isn't remembered
  }
}

/** Where a ⋯ menu opens: it floats above the page so scrolling cards can't clip it. */
type MenuAnchor = { key: string; left: number; top?: number; bottom?: number }

type Picker = { kind: 'lecture' | 'session'; id: string; title: string; selected: string[] }

const EMPTY: string[] = []

// ---------- small display helpers ----------
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

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
  const [menu, setMenuState] = useState<MenuAnchor | null>(null)
  const setMenu = (m: MenuAnchor | null) => setMenuState(m)
  const [archivedCount, setArchivedCount] = useState<number | null>(null)
  const [toDelete, setToDelete] = useState<SessionRow | null>(null)
  const [toDeleteLecture, setToDeleteLecture] = useState<LectureRow | null>(null)
  const [classes, setClasses] = useState<ClassGroup[]>([])
  /** The classes tables don't exist yet (migration not run): everything else keeps working. */
  const [classesMissing, setClassesMissing] = useState(false)
  const [filter, setFilterState] = useState<Filter>(readFilter)
  const [picker, setPicker] = useState<Picker | null>(null)
  const [manageOpen, setManageOpen] = useState(false)

  const setFilter = (f: Filter) => {
    setFilterState(f)
    writeFilter(f)
  }

  /** Toggle one class. Selecting every class (or none) collapses back to "All". */
  const toggleFilter = (id: string) => {
    const next = filter.includes(id) ? filter.filter((x) => x !== id) : [...filter, id]
    setFilter(next.length === 0 || next.length === classes.length ? [] : next)
  }

  const load = useCallback(async () => {
    if (!supabaseConfigured) return
    const query = (withClasses: boolean) =>
      Promise.all([
        supabase
          .from('lectures')
          .select(`*, assets(kind, created_at), sessions(id)${withClasses ? ', lecture_classes(class_id)' : ''}`)
          .is('archived_at', null)
          .order('created_at', { ascending: false }),
        supabase
          .from('sessions')
          .select(`*, lectures(title), lecture_notes(session_id)${withClasses ? ', session_classes(class_id)' : ''}`)
          .order('started_at', { ascending: false }),
        withClasses ? listClasses().then((data) => ({ data, error: null })).catch((error) => ({ data: [], error })) : null,
      ])
    supabase
      .from('lectures')
      .select('id', { count: 'exact', head: true })
      .not('archived_at', 'is', null)
      .then(({ count }) => setArchivedCount(count ?? 0))
    let [l, s, c] = await query(true)
    const missing = !!(l.error || s.error || c?.error)
    if (missing) [l, s, c] = await query(false) // classes migration not run yet
    setClassesMissing(missing && !l.error && !s.error)
    setError(l.error?.message ?? s.error?.message ?? null)
    const rows = (l.data as unknown as LectureRow[]) ?? []
    rows.sort((a, b) => lastUpdated(b).localeCompare(lastUpdated(a)))
    setLectures(rows)
    setSessions((s.data as unknown as SessionRow[]) ?? [])
    const cls = (c?.data as ClassGroup[]) ?? []
    setClasses(cls)
    // Drop remembered classes that no longer exist; every class selected means "All".
    setFilterState((f) => {
      const kept = f.filter((id) => cls.some((x) => x.id === id))
      return kept.length === cls.length ? [] : kept
    })
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

  const byId = new Map(classes.map((c) => [c.id, c]))
  const classesOf = (links: ClassLink[] | null | undefined) =>
    (links ?? []).map((x) => byId.get(x.class_id)).filter((x): x is ClassGroup => !!x)
  /** A lecture or session shows if it's in any selected class. */
  const inFilter = (links: ClassLink[] | null | undefined) =>
    filter.length === 0 || (links ?? []).some((x) => filter.includes(x.class_id))
  const shownLectures = lectures.filter((l) => inFilter(l.lecture_classes))
  const shownSessions = sessions.filter((s) => inFilter(s.session_classes))
  const filterName =
    filter.length === 0 ? null : filter.length === 1 ? byId.get(filter[0])?.name : 'the selected classes'


  const savePicker = (ids: string[], fresh: { name: string; color: string }[]) =>
    run(async () => {
      if (!picker) return
      const created = await Promise.all(fresh.map((f) => createClass(f.name, f.color)))
      const all = [...ids, ...created.map((c) => c.id)]
      if (picker.kind === 'lecture') await setLectureClasses(picker.id, all)
      else await setSessionClasses(picker.id, all)
      setPicker(null)
      await load()
    })

  const saveClassEdits = (edits: ClassEdits) =>
    run(async () => {
      await Promise.all(edits.updates.map((u) => updateClass(u.id, { name: u.name, color: u.color })))
      await Promise.all(edits.deletes.map((id) => deleteClass(id)))
      await Promise.all(edits.creates.map((c) => createClass(c.name, c.color)))
      setManageOpen(false)
      await load()
    })

  /** "···" button with a small menu. Tap to open, tap outside to close (no long-press). The menu floats
   *  above the page (position: fixed) so a scrolling card can't clip it, and opens upward near the bottom. */
  const MENU_WIDTH = 168
  const moreMenu = (key: string, label: string, items: { label: string; danger?: boolean; onClick: () => void }[]) => (
    <div className="dash-menu-wrap">
      <button
        className="dash-btn icon-only"
        aria-label={`More actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={menu?.key === key}
        onClick={(e) => {
          if (menu?.key === key) return setMenu(null)
          const r = e.currentTarget.getBoundingClientRect()
          const height = items.length * 48 + 10
          const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
          const below = r.bottom + 8 + height <= window.innerHeight
          setMenu(below ? { key, left, top: r.bottom + 8 } : { key, left, bottom: window.innerHeight - r.top + 8 })
        }}
      >
        <span className="btn-pill round">
          <IconDots />
        </span>
      </button>
      {menu?.key === key && (
        <>
          <div className="dash-menu-backdrop" onClick={() => setMenu(null)} />
          <div className="dash-menu floating" role="menu" style={{ left: menu.left, top: menu.top, bottom: menu.bottom, width: MENU_WIDTH }}>
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
    <div className="dash bento-page">
      <div className="bento-inner">
        <header className="bento-header">
          <h1 className="dash-title dash-logo">
            <img src="/aside-logo.png" alt="aside" width={1065} height={321} />
          </h1>
          <button
            className="dash-btn solid new-lecture"
            disabled={busy || !supabaseConfigured}
            onClick={() => run(async () => navigate(`/prep/${await createLecture(undefined, filter)}?new=1`))}
          >
            <IconPlus /> New lecture
          </button>
        </header>

        {supabaseConfigured && !classesMissing && (
          <nav className="bento-filter" aria-label="Filter by class">
            <button className={`chip${filter.length === 0 ? ' on' : ''}`} aria-pressed={filter.length === 0} onClick={() => setFilter([])}>
              <span className="chip-pill">All</span>
            </button>
            {classes.map((c) => {
              const on = filter.includes(c.id)
              return (
                <button key={c.id} className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleFilter(c.id)}>
                  <span className="chip-pill">
                    <span className="chip-dot" style={{ background: c.color }} aria-hidden="true" />
                    {c.name}
                  </span>
                </button>
              )
            })}
            <button className="chip add" aria-label={classes.length ? 'Add or edit classes' : 'Add a class'} title="Add or edit classes" onClick={() => setManageOpen(true)}>
              <span className="chip-pill">
                <IconPlus />
              </span>
            </button>
          </nav>
        )}

        {(!supabaseConfigured || error || classesMissing) && (
          <div className="bento-notices">
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
            {classesMissing && (
              <div className="dash-notice">
                Classes need a one-time database update: run <code>supabase/migrations/2026-11-07_classes.sql</code> in the Supabase
                SQL editor.
              </div>
            )}
          </div>
        )}

        <div className="bento">
          {/* ---------- top left: Ready to present ---------- */}
          <section className="bento-cell cell-ready" aria-labelledby="ready-heading">
            <div className="cell-head">
              <div className="cell-title">
                <h2 id="ready-heading" className="dash-label">
                  Ready to present
                </h2>
                <span className="cell-count" aria-label={`${shownLectures.length} lectures`}>
                  {shownLectures.length}
                </span>
              </div>
              <Link className="cell-go" to="/lectures" aria-label="All active lectures" title="All active lectures">
                <span className="btn-pill round">
                  <IconArrowRight />
                </span>
              </Link>
            </div>
            <div className="cell-scroll" onScroll={() => menu && setMenu(null)}>
              {supabaseConfigured && lectures.length === 0 && (
                <p className="dash-empty">Create your first lecture to upload diagrams and notes before class.</p>
              )}
              {lectures.length > 0 && shownLectures.length === 0 && (
                <p className="dash-empty">No lectures in {filterName ?? 'this class'} yet.</p>
              )}
              <ul className="dash-list">
                {shownLectures.map((l) => {
                  const images = (l.assets ?? []).filter((a) => a.kind === 'image').length
                  const notes = (l.assets ?? []).length - images
                  return (
                    <li key={l.id} className="dash-row">
                      <div className="dash-avatar class-holder">
                        {classesMissing ? (
                          <ClassDot classes={[]} size={24} />
                        ) : (
                          <ClassDotButton
                            classes={classesOf(l.lecture_classes)}
                            size={24}
                            itemTitle={l.title}
                            onClick={() =>
                              setPicker({ kind: 'lecture', id: l.id, title: l.title, selected: (l.lecture_classes ?? []).map((x) => x.class_id) })
                            }
                          />
                        )}
                      </div>
                      <div className="dash-main">
                        <h3 className="dash-row-title">{l.title}</h3>
                        <div className="dash-meta">
                          <span>
                            <IconImage /> {images}
                          </span>
                          <span>
                            <IconFile /> {notes}
                          </span>
                          <span>{relative(lastUpdated(l))}</span>
                        </div>
                      </div>
                      <div className="dash-actions">
                        <button
                          className="dash-btn row-btn"
                          disabled={busy}
                          onClick={() => run(async () => navigate(`/teach/${await startSession(l.id, l.title)}`))}
                        >
                          <span className="btn-pill outline">
                            <IconPlay /> Start
                          </span>
                        </button>
                        <Link className="dash-btn icon-only" to={`/prep/${l.id}`} aria-label={`Edit ${l.title}`} title="Edit">
                          <span className="btn-pill round">
                            <IconEdit />
                          </span>
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
                          {
                            label: 'Delete',
                            danger: true,
                            onClick: () => {
                              setMenu(null)
                              setToDeleteLecture(l)
                            },
                          },
                        ])}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </section>

          {/* ---------- bottom left: Archive ---------- */}
          <Link className="bento-cell cell-archive" to="/archive" aria-label={`Archive, ${archivedCount ?? 0} lectures`}>
            <span className="cell-head">
              <span className="cell-title">
                <span className="dash-label">Archive</span>
                <span className="cell-count">{archivedCount ?? '–'}</span>
              </span>
              <span className="cell-go" aria-hidden="true">
                <span className="btn-pill round">
                  <IconArrowRight />
                </span>
              </span>
            </span>
          </Link>

          {/* ---------- right: Recorded sessions ---------- */}
          <section className="bento-cell cell-sessions" aria-labelledby="past-heading">
            <div className="cell-head">
              <div className="cell-title">
                <h2 id="past-heading" className="dash-label">
                  Recorded sessions
                </h2>
                <span className="cell-count" aria-label={`${shownSessions.length} sessions`}>
                  {shownSessions.length}
                </span>
              </div>
              <Link className="cell-go" to="/sessions" aria-label="All recorded sessions" title="All recorded sessions">
                <span className="btn-pill round">
                  <IconArrowRight />
                </span>
              </Link>
            </div>
            <div className="cell-scroll" onScroll={() => menu && setMenu(null)}>
              {supabaseConfigured && sessions.length === 0 && <p className="dash-empty">Sessions appear here after you start a lecture.</p>}
              {sessions.length > 0 && shownSessions.length === 0 && (
                <p className="dash-empty">No sessions in {filterName ?? 'this class'} yet.</p>
              )}
              <ul className="dash-list">
                {shownSessions.map((s) => {
                  const title = s.title || s.lectures?.title || 'Lecture'
                  const live = s.status === 'live'
                  return (
                    <li key={s.id} className={`dash-row${live ? '' : ' past'}`}>
                      <div className="dash-avatar class-holder">
                        {classesMissing ? (
                          <ClassDot classes={[]} size={24} />
                        ) : (
                          <ClassDotButton
                            classes={classesOf(s.session_classes)}
                            size={24}
                            itemTitle={title}
                            onClick={() =>
                              setPicker({ kind: 'session', id: s.id, title, selected: (s.session_classes ?? []).map((x) => x.class_id) })
                            }
                          />
                        )}
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
                        {live ? (
                          <Link className="dash-btn row-btn" to={`/teach/${s.id}`}>
                            <span className="btn-pill solid">
                              <IconPlay /> Resume
                            </span>
                          </Link>
                        ) : (
                          <Link className="dash-btn row-btn" to={`/notes/${s.id}`}>
                            <span className="btn-pill outline">
                              Notes <IconArrowRight />
                            </span>
                          </Link>
                        )}
                        {moreMenu(`s:${s.id}`, title, [
                          {
                            label: 'Transcript',
                            onClick: () => {
                              setMenu(null)
                              navigate(`/sessions/${s.id}/raw`)
                            },
                          },
                          {
                            label: 'Delete session',
                            danger: true,
                            onClick: () => {
                              setMenu(null)
                              setToDelete(s)
                            },
                          },
                        ])}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </section>
        </div>
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

      <ConfirmDialog
        open={toDeleteLecture !== null}
        title={`Delete "${toDeleteLecture?.title}"?`}
        confirmLabel="Delete permanently"
        danger
        onCancel={() => setToDeleteLecture(null)}
        onConfirm={() =>
          run(async () => {
            if (toDeleteLecture) await deleteLecture(toDeleteLecture.id)
            setToDeleteLecture(null)
            await load()
          })
        }
      >
        Its uploaded images and notes are deleted
        {(toDeleteLecture?.sessions?.length ?? 0) > 0 && (
          <>
            , <strong>along with its {plural(toDeleteLecture?.sessions?.length ?? 0, 'past session')}</strong> (boards and notes)
          </>
        )}
        . This can't be undone. To just hide it, use Archive instead.
      </ConfirmDialog>

      <ClassPickerDialog
        open={picker !== null}
        title={picker?.title ?? ''}
        classes={classes}
        selected={picker?.selected ?? EMPTY}
        onCancel={() => setPicker(null)}
        onSave={savePicker}
      />

      <ManageClassesDialog open={manageOpen} classes={classes} onCancel={() => setManageOpen(false)} onSave={saveClassEdits} />
    </div>
  )
}
