// P4 owns this page. Two modes: /lectures lists active lectures (start, edit, archive, delete) and
// /archive lists archived ones (restore, edit, delete).
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ClassFilterBar, useClassFilter } from '../components/ClassFilter'
import { ClassDotButton, ClassPickerDialog, ManageClassesDialog, type ClassEdits } from '../components/Classes'
import ConfirmDialog from '../components/ConfirmDialog'
import { IconArrowLeft, IconClock, IconEdit, IconPlay, IconRefresh } from '../components/DashIcons'
import RowMenu, { SortMenu, sortRows, useSortOrder } from '../components/RowMenu'
import { createClass, deleteClass, listClasses, setLectureClasses, updateClass } from '../lib/classes'
import { deleteLecture, setArchived, startSession } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { ClassGroup, Lecture } from '../types'
import '../styles/p4.css'
import '../styles/lists.css'

type Row = Lecture & { sessions: { count: number }[]; lecture_classes?: { class_id: string }[] | null }

const EMPTY: string[] = []

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export default function AllLectures({ mode }: { mode: 'active' | 'archived' }) {
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<Row | null>(null)
  const [classes, setClasses] = useState<ClassGroup[]>([])
  const [picker, setPicker] = useState<{ id: string; title: string; selected: string[] } | null>(null)
  const [classesOk, setClassesOk] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)

  const load = useCallback(async () => {
    const query = (withClasses: boolean) =>
      supabase
        .from('lectures')
        .select(`*, sessions(count)${withClasses ? ', lecture_classes(class_id)' : ''}`)
        .order('created_at', { ascending: false })
    let res = await query(true)
    const withClasses = !res.error
    if (!withClasses) res = await query(false) // classes migration not run yet
    setClassesOk(withClasses)
    setError(res.error?.message ?? null)
    setRows((res.data as unknown as Row[]) ?? [])
    setClasses(await listClasses().catch(() => []))
    setLoaded(true)
  }, [])

  const byId = new Map(classes.map((c) => [c.id, c]))
  const { filter, setFilter, toggle, matches, filterName } = useClassFilter(classes, loaded)
  const { order, setOrder } = useSortOrder(mode === 'archived' ? 'archive' : 'lectures')

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

  const inMode = rows.filter((r) => (mode === 'archived' ? !!r.archived_at : !r.archived_at))
  const shown = sortRows(
    inMode.filter((r) => matches(r.lecture_classes)),
    order,
    (r) => r.title,
    (r) => r.created_at,
  )

  const saveClassEdits = (edits: ClassEdits) =>
    act(async () => {
      await Promise.all(edits.updates.map((u) => updateClass(u.id, { name: u.name, color: u.color })))
      await Promise.all(edits.deletes.map((id) => deleteClass(id)))
      await Promise.all(edits.creates.map((c) => createClass(c.name, c.color)))
      setManageOpen(false)
    })
  const sessionCount = toDelete?.sessions?.[0]?.count ?? 0

  const renderRow = (l: Row) => {
    const isArchived = !!l.archived_at
    const sessions = l.sessions?.[0]?.count ?? 0
    return (
      <li key={l.id} className={`lp-row${isArchived ? ' faded' : ''}`}>
        <div className="lp-dot">
          <ClassDotButton
            size={32}
            itemTitle={l.title}
            classes={(l.lecture_classes ?? []).map((x) => byId.get(x.class_id)).filter((x): x is ClassGroup => !!x)}
            onClick={() => setPicker({ id: l.id, title: l.title, selected: (l.lecture_classes ?? []).map((x) => x.class_id) })}
          />
        </div>
        <div className="lp-main">
          <h3 className="lp-row-title">{l.title}</h3>
          <div className="lp-meta">
            <span>
              <IconClock /> {plural(sessions, 'session')}
            </span>
            <span>Created {shortDate(l.created_at)}</span>
          </div>
        </div>
        <div className="lp-actions">
          {isArchived ? (
            <button type="button" className="lp-tap" onClick={() => act(() => setArchived(l.id, false))}>
              <span className="lp-pill outline">
                <IconRefresh /> Restore
              </span>
            </button>
          ) : (
            <button type="button" className="lp-tap" onClick={() => act(async () => navigate(`/teach/${await startSession(l.id, l.title)}`))}>
              <span className="lp-pill outline">
                <IconPlay /> Start
              </span>
            </button>
          )}
          <Link className="lp-tap icon" to={`/prep/${l.id}`} state={{ from: mode === 'archived' ? '/archive' : '/lectures' }} aria-label={`Edit ${l.title}`} title="Edit">
            <span className="lp-pill round">
              <IconEdit />
            </span>
          </Link>
          <RowMenu
            label={l.title}
            items={[
              ...(isArchived ? [] : [{ label: 'Archive', onClick: () => act(() => setArchived(l.id, true)) }]),
              { label: 'Delete permanently', danger: true, onClick: () => setToDelete(l) },
            ]}
          />
        </div>
      </li>
    )
  }

  const archivedMode = mode === 'archived'

  return (
    <div className="p4 lp">
      <header className="lp-header">
        <Link className="lp-back" to="/" aria-label="Back to the dashboard" title="Back to the dashboard">
          <span className="lp-back-circle">
            <IconArrowLeft />
          </span>
        </Link>
        <h1 className="lp-title">{archivedMode ? 'Archive' : 'Lectures'}</h1>
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
                {archivedMode ? 'Archived' : 'Ready to present'}
              </h2>
              <span className="lp-count" aria-label={plural(shown.length, 'lecture')}>
                {shown.length}
              </span>
            </div>
            <SortMenu order={order} onChange={setOrder} />
          </div>
          <div className="lp-scroll">
            {loaded && inMode.length > 0 && shown.length === 0 && (
              <p className="lp-empty">No {archivedMode ? 'archived lectures' : 'lectures'} in {filterName} yet.</p>
            )}
            {loaded && inMode.length === 0 && (
              <p className="lp-empty">
                {archivedMode
                  ? 'Nothing archived. Archive a lecture from its ⋯ menu to hide it from the dashboard.'
                  : 'No active lectures. Create one from the dashboard.'}
              </p>
            )}
            <ul className="lp-list">{shown.map(renderRow)}</ul>
          </div>
        </section>
      </main>

      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete "${toDelete?.title}"?`}
        confirmLabel="Delete permanently"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={() =>
          act(async () => {
            if (toDelete) await deleteLecture(toDelete.id)
            setToDelete(null)
          })
        }
      >
        This deletes its uploaded images and materials
        {sessionCount > 0 && (
          <>
            {' '}
            <strong>and its {sessionCount} past session{sessionCount === 1 ? '' : 's'}</strong> (boards and notes)
          </>
        )}
        . This can't be undone. To just hide it, archive it instead.
      </ConfirmDialog>

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
            await setLectureClasses(picker.id, [...ids, ...created.map((c) => c.id)])
            setPicker(null)
          })
        }
      />
      <ManageClassesDialog open={manageOpen} classes={classes} onCancel={() => setManageOpen(false)} onSave={saveClassEdits} />
    </div>
  )
}
