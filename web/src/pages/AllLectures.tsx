// P4 owns this page. Every lecture, archived or not: edit, archive/restore, delete.
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClassDot } from '../components/Classes'
import ConfirmDialog from '../components/ConfirmDialog'
import { IconArrowLeft, IconClock, IconDots, IconEdit } from '../components/DashIcons'
import { listClasses } from '../lib/classes'
import { deleteLecture, setArchived } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { ClassGroup, Lecture } from '../types'
import '../styles/p4.css'

type Row = Lecture & { sessions: { count: number }[]; lecture_classes?: { class_id: string }[] | null }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export default function AllLectures() {
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<Row | null>(null)
  const [classes, setClasses] = useState<ClassGroup[]>([])

  const load = useCallback(async () => {
    const query = (withClasses: boolean) =>
      supabase
        .from('lectures')
        .select(`*, sessions(count)${withClasses ? ', lecture_classes(class_id)' : ''}`)
        .order('created_at', { ascending: false })
    let res = await query(true)
    if (res.error) res = await query(false) // classes migration not run yet
    setError(res.error?.message ?? null)
    setRows((res.data as unknown as Row[]) ?? [])
    setClasses(await listClasses().catch(() => []))
  }, [])

  const byId = new Map(classes.map((c) => [c.id, c]))

  useEffect(() => {
    load()
  }, [load])

  const act = async (fn: () => Promise<void>) => {
    setMenu(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const active = rows.filter((r) => !r.archived_at)
  const archived = rows.filter((r) => r.archived_at)
  const sessionCount = toDelete?.sessions?.[0]?.count ?? 0

  const renderRow = (l: Row) => {
    const isArchived = !!l.archived_at
    const sessions = l.sessions?.[0]?.count ?? 0
    return (
      <li key={l.id} className={`p4-row${isArchived ? ' faded' : ''}`}>
        <div className="p4-avatar class-holder">
          <ClassDot
            size={28}
            classes={(l.lecture_classes ?? []).map((x) => byId.get(x.class_id)).filter((x): x is ClassGroup => !!x)}
          />
        </div>
        <div className="p4-main">
          <h3 className="p4-row-title">{l.title}</h3>
          <div className="p4-meta">
            <span>
              <IconClock /> {plural(sessions, 'session')}
            </span>
            <span>Created {shortDate(l.created_at)}</span>
            {isArchived && <span className="p4-badge">Archived</span>}
          </div>
        </div>
        <div className="p4-actions">
          <Link className="p4-btn" to={`/prep/${l.id}`}>
            <IconEdit /> Edit
          </Link>
          <div className="p4-menu-wrap">
            <button
              className="p4-btn icon-only"
              aria-label={`More actions for ${l.title}`}
              aria-haspopup="menu"
              aria-expanded={menu === l.id}
              onClick={() => setMenu(menu === l.id ? null : l.id)}
            >
              <IconDots />
            </button>
            {menu === l.id && (
              <>
                <div className="p4-menu-backdrop" onClick={() => setMenu(null)} />
                <div className="p4-menu" role="menu">
                  <button role="menuitem" className="p4-btn p4-menu-item" onClick={() => act(() => setArchived(l.id, !isArchived))}>
                    {isArchived ? 'Restore' : 'Archive'}
                  </button>
                  <button
                    role="menuitem"
                    className="p4-btn p4-menu-item danger"
                    onClick={() => {
                      setMenu(null)
                      setToDelete(l)
                    }}
                  >
                    Delete permanently
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </li>
    )
  }

  return (
    <div className="p4">
      <header className="p4-top">
        <Link className="p4-btn" to="/">
          <IconArrowLeft /> Lectures
        </Link>
      </header>
      <div className="p4-inner">
        <h1 className="p4-title">All lectures</h1>
        <p className="p4-sub">
          {plural(active.length, 'active lecture')} · {archived.length} archived
        </p>

        {error && (
          <div className="p4-notice warn" role="alert">
            <span>{error}</span>
            <button className="p4-btn" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <section className="p4-section" aria-labelledby="active-heading">
          <div className="p4-section-head">
            <h2 id="active-heading" className="p4-label">
              Active
            </h2>
            {active.length > 1 && <span className="p4-hint">Newest first</span>}
          </div>
          {active.length === 0 && <p className="p4-empty">No active lectures. Create one from the dashboard.</p>}
          <ul className="p4-list">{active.map(renderRow)}</ul>
        </section>

        <section className="p4-section" aria-labelledby="archived-heading">
          <div className="p4-section-head">
            <h2 id="archived-heading" className="p4-label">
              Archived
            </h2>
            <span className="p4-hint">Hidden from the dashboard</span>
          </div>
          {archived.length === 0 && <p className="p4-empty">Archived lectures show up here. Their sessions and notes are kept.</p>}
          <ul className="p4-list">{archived.map(renderRow)}</ul>
        </section>
      </div>

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
    </div>
  )
}
