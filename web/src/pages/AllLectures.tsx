// P4 owns this page. Every lecture, archived or not: edit, archive/restore, delete.
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import { deleteLecture, formatDate, setArchived } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { Lecture } from '../types'

type Row = Lecture & { sessions: { count: number }[] }

export default function AllLectures() {
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<Row | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('lectures').select('*, sessions(count)').order('created_at', { ascending: false })
    setError(error?.message ?? null)
    setRows((data as Row[]) ?? [])
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

  const sessionCount = toDelete?.sessions?.[0]?.count ?? 0

  return (
    <div className="page">
      <header className="page-header">
        <Link className="btn" to="/">
          ← Dashboard
        </Link>
        <h1>All lectures</h1>
      </header>
      {error && <div className="notice warn">{error}</div>}
      {rows.length === 0 && <p className="muted">No lectures yet.</p>}
      <ul className="list">
        {rows.map((l) => (
          <li key={l.id} className={`list-item${l.archived_at ? ' archived' : ''}`}>
            <div className="list-main">
              <div className="list-title">
                {l.title} {l.archived_at && <span className="tag">Archived</span>}
              </div>
              <div className="muted">
                {l.sessions?.[0]?.count ?? 0} sessions · created {formatDate(l.created_at)}
              </div>
            </div>
            <div className="row">
              <Link className="btn" to={`/prep/${l.id}`}>
                Edit
              </Link>
              {l.archived_at ? (
                <button onClick={() => act(() => setArchived(l.id, false))}>Restore</button>
              ) : (
                <button onClick={() => act(() => setArchived(l.id, true))}>Archive</button>
              )}
              <button className="danger-outline" onClick={() => setToDelete(l)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

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
