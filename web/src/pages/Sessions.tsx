// P4 owns this page. Every recorded session, newest first: open notes (or resume a live one),
// rename, set classes, delete (the notes screen switches to the transcript). Opened from the arrow on the dashboard's
// Recorded sessions card. Same layout as the Lectures and Archive pages.
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ClassFilterBar, useClassFilter } from '../components/ClassFilter'
import { ClassDotButton, ClassPickerDialog, ManageClassesDialog, type ClassEdits } from '../components/Classes'
import ConfirmDialog from '../components/ConfirmDialog'
import RenameDialog from '../components/RenameDialog'
import { IconArrowLeft, IconArrowRight, IconClock, IconPlay } from '../components/DashIcons'
import RowMenu, { SortMenu, sortRows, useSortOrder } from '../components/RowMenu'
import { createClass, deleteClass, listClasses, setSessionClasses, updateClass } from '../lib/classes'
import { deleteSession, formatDate, renameSession } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { ClassGroup, Session } from '../types'
import '../styles/p4.css'
import '../styles/lists.css'

type Row = Session & {
  lectures: { title: string } | null
  /** One-to-one with sessions; PostgREST may return it as an object or an array. */
  lecture_notes: { session_id: string } | { session_id: string }[] | null
  session_classes?: { class_id: string }[] | null
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const EMPTY: string[] = []

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "Today, 8:55 PM · 12 min", "Yesterday, …" or "Nov 5, 2026, …". */
function sessionWhen(s: Session) {
  const start = new Date(s.started_at)
  const time = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  let day = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  if (isSameDay(start, new Date())) day = 'Today'
  else if (isSameDay(start, yesterday)) day = 'Yesterday'
  const mins = s.ended_at ? Math.max(1, Math.round((new Date(s.ended_at).getTime() - start.getTime()) / 60000)) : null
  return `${day}, ${time}${mins ? ` · ${mins} min` : ''}`
}

const titleOf = (s: Row) => s.title || s.lectures?.title || 'Lecture'

export default function Sessions() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<Row | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [classes, setClasses] = useState<ClassGroup[]>([])
  const [picker, setPicker] = useState<{ id: string; title: string; selected: string[] } | null>(null)
  const [classesOk, setClassesOk] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)

  const load = useCallback(async () => {
    const query = (withClasses: boolean) =>
      supabase
        .from('sessions')
        .select(`*, lectures(title), lecture_notes(session_id)${withClasses ? ', session_classes(class_id)' : ''}`)
        .order('started_at', { ascending: false })
    let res = await query(true)
    const withClasses = !res.error
    if (!withClasses) res = await query(false) // classes migration not run yet
    setClassesOk(withClasses)
    setError(res.error?.message ?? null)
    setRows((res.data as unknown as Row[]) ?? [])
    setClasses(await listClasses().catch(() => []))
    setLoaded(true)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const byId = new Map(classes.map((c) => [c.id, c]))
  const { filter, setFilter, toggle, matches, filterName } = useClassFilter(classes, loaded)
  const { order, setOrder } = useSortOrder('sessions')
  const shown = sortRows(
    rows.filter((r) => matches(r.session_classes)),
    order,
    titleOf,
    (r) => r.started_at,
  )
  const live = shown.filter((r) => r.status === 'live').length

  const saveClassEdits = (edits: ClassEdits) =>
    act(async () => {
      await Promise.all(edits.updates.map((u) => updateClass(u.id, { name: u.name, color: u.color })))
      await Promise.all(edits.deletes.map((id) => deleteClass(id)))
      await Promise.all(edits.creates.map((c) => createClass(c.name, c.color)))
      setManageOpen(false)
    })

  const renderRow = (s: Row) => {
    const title = titleOf(s)
    const isLive = s.status === 'live'
    return (
      <li key={s.id} className={`lp-row${isLive ? '' : ' faded'}`}>
        <div className="lp-dot">
          <ClassDotButton
            size={32}
            itemTitle={title}
            classes={(s.session_classes ?? []).map((x) => byId.get(x.class_id)).filter((x): x is ClassGroup => !!x)}
            onClick={() => setPicker({ id: s.id, title, selected: (s.session_classes ?? []).map((x) => x.class_id) })}
          />
        </div>
        <div className="lp-main">
          <h3 className="lp-row-title">{title}</h3>
          <div className="lp-meta">
            <span>
              <IconClock /> {sessionWhen(s)}
            </span>
          </div>
        </div>
        <div className="lp-actions">
          {isLive ? (
            <Link className="lp-tap" to={`/teach/${s.id}`}>
              <span className="lp-pill solid same-width">
                <IconPlay /> Resume
              </span>
            </Link>
          ) : (
            <Link className="lp-tap" to={`/notes/${s.id}`} state={{ from: '/sessions' }}>
              <span className="lp-pill outline same-width">
                Notes <IconArrowRight />
              </span>
            </Link>
          )}
          <RowMenu
            label={title}
            items={[
              { label: 'Rename…', onClick: () => setRenaming({ id: s.id, title }) },
              { label: 'Delete session', danger: true, onClick: () => setToDelete(s) },
            ]}
          />
        </div>
      </li>
    )
  }

  return (
    <div className="p4 lp">
      <header className="lp-header">
        <Link className="lp-back" to="/" aria-label="Back to the dashboard" title="Back to the dashboard">
          <span className="lp-back-circle">
            <IconArrowLeft />
          </span>
        </Link>
        <h1 className="lp-title">Recorded sessions</h1>
        <span aria-hidden="true" />
      </header>

      <main className="lp-body">
        {error && (
          <div className="p4-notice warn" role="alert">
            <span>{error}</span>
            <button className="p4-btn" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {classesOk && (
          <ClassFilterBar
            size="large"
            className="lp-filter"
            classes={classes}
            filter={filter}
            onAll={() => setFilter([])}
            onToggle={toggle}
            onManage={() => setManageOpen(true)}
          />
        )}

        <section className="lp-card" aria-labelledby="list-heading">
          <div className="lp-card-head">
            <div className="lp-card-title">
              <h2 id="list-heading" className="lp-label">
                All sessions
              </h2>
              <span className="lp-count" aria-label={plural(shown.length, 'session')}>
                {shown.length}
              </span>
              {live > 0 && <span className="lp-badge live">{live} live</span>}
            </div>
            <SortMenu order={order} onChange={setOrder} />
          </div>
          <div className="lp-scroll">
            {loaded && rows.length === 0 && <p className="lp-empty">No sessions yet. Start a lecture from the dashboard to record one.</p>}
            {loaded && rows.length > 0 && shown.length === 0 && <p className="lp-empty">No sessions in {filterName} yet.</p>}
            <ul className="lp-list">{shown.map(renderRow)}</ul>
          </div>
        </section>
      </main>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this session?"
        confirmLabel="Delete"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={() =>
          act(async () => {
            if (toDelete) await deleteSession(toDelete.id)
            setToDelete(null)
          })
        }
      >
        {toDelete && titleOf(toDelete)} from {formatDate(toDelete?.started_at)}. Its board, transcript and notes are deleted permanently.
        The prepared lecture is kept.
      </ConfirmDialog>

      <RenameDialog
        open={renaming !== null}
        current={renaming?.title ?? ''}
        onCancel={() => setRenaming(null)}
        onSave={(name) =>
          act(async () => {
            if (renaming) await renameSession(renaming.id, name)
            setRenaming(null)
          })
        }
      />

      <ClassPickerDialog
        open={picker !== null}
        title={picker?.title ?? ''}
        classes={classes}
        selected={picker?.selected ?? EMPTY}
        onCancel={() => setPicker(null)}
        onSave={(ids, fresh) =>
          act(async () => {
            if (!picker) return
            const created = await Promise.all(fresh.map((f) => createClass(f.name, f.color)))
            await setSessionClasses(picker.id, [...ids, ...created.map((c) => c.id)])
            setPicker(null)
          })
        }
      />
      <ManageClassesDialog open={manageOpen} classes={classes} onCancel={() => setManageOpen(false)} onSave={saveClassEdits} />
    </div>
  )
}
