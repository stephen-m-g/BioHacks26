// P4 owns this page. Every recorded session, newest first: open notes (or resume a live one),
// open the transcript, set classes, delete. Opened from the arrow on the dashboard's
// Recorded sessions card. Same layout as the Lectures and Archive pages.
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClassDotButton, ClassPickerDialog } from '../components/Classes'
import ConfirmDialog from '../components/ConfirmDialog'
import { IconArrowLeft, IconArrowRight, IconClock, IconDots, IconPlay, IconText } from '../components/DashIcons'
import { createClass, listClasses, setSessionClasses } from '../lib/classes'
import { deleteSession, formatDate } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { ClassGroup, Session } from '../types'
import '../styles/p4.css'

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

const hasNotes = (s: Row) => (Array.isArray(s.lecture_notes) ? s.lecture_notes.length > 0 : !!s.lecture_notes)
const titleOf = (s: Row) => s.title || s.lectures?.title || 'Lecture'

export default function Sessions() {
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<Row | null>(null)
  const [classes, setClasses] = useState<ClassGroup[]>([])
  const [picker, setPicker] = useState<{ id: string; title: string; selected: string[] } | null>(null)

  const load = useCallback(async () => {
    const query = (withClasses: boolean) =>
      supabase
        .from('sessions')
        .select(`*, lectures(title), lecture_notes(session_id)${withClasses ? ', session_classes(class_id)' : ''}`)
        .order('started_at', { ascending: false })
    let res = await query(true)
    if (res.error) res = await query(false) // classes migration not run yet
    setError(res.error?.message ?? null)
    setRows((res.data as unknown as Row[]) ?? [])
    setClasses(await listClasses().catch(() => []))
  }, [])

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

  const byId = new Map(classes.map((c) => [c.id, c]))
  const live = rows.filter((r) => r.status === 'live').length

  const renderRow = (s: Row) => {
    const title = titleOf(s)
    const isLive = s.status === 'live'
    return (
      <li key={s.id} className={`p4-row${isLive ? '' : ' faded'}`}>
        <div className="p4-avatar class-holder">
          <ClassDotButton
            size={28}
            itemTitle={title}
            classes={(s.session_classes ?? []).map((x) => byId.get(x.class_id)).filter((x): x is ClassGroup => !!x)}
            onClick={() => setPicker({ id: s.id, title, selected: (s.session_classes ?? []).map((x) => x.class_id) })}
          />
        </div>
        <div className="p4-main">
          <h3 className="p4-row-title">{title}</h3>
          <div className="p4-meta">
            <span>
              <IconClock /> {sessionWhen(s)}
            </span>
            {isLive ? (
              <span className="p4-badge live">Live</span>
            ) : (
              hasNotes(s) && <span className="p4-badge">Notes ready</span>
            )}
          </div>
        </div>
        <div className="p4-actions">
          {isLive ? (
            <Link className="p4-btn solid" to={`/teach/${s.id}`}>
              <IconPlay /> Resume
            </Link>
          ) : (
            <Link className="p4-btn outline-strong" to={`/notes/${s.id}`}>
              Notes <IconArrowRight />
            </Link>
          )}
          <Link className="p4-btn" to={`/sessions/${s.id}/raw`}>
            <IconText /> Transcript
          </Link>
          <div className="p4-menu-wrap">
            <button
              className="p4-btn icon-only"
              aria-label={`More actions for ${title}`}
              aria-haspopup="menu"
              aria-expanded={menu === s.id}
              onClick={() => setMenu(menu === s.id ? null : s.id)}
            >
              <IconDots />
            </button>
            {menu === s.id && (
              <>
                <div className="p4-menu-backdrop" onClick={() => setMenu(null)} />
                <div className="p4-menu" role="menu">
                  <button
                    role="menuitem"
                    className="p4-btn p4-menu-item"
                    onClick={() => {
                      setMenu(null)
                      setPicker({ id: s.id, title, selected: (s.session_classes ?? []).map((x) => x.class_id) })
                    }}
                  >
                    Classes…
                  </button>
                  <button
                    role="menuitem"
                    className="p4-btn p4-menu-item danger"
                    onClick={() => {
                      setMenu(null)
                      setToDelete(s)
                    }}
                  >
                    Delete session
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
          <IconArrowLeft /> Dashboard
        </Link>
        <div className="p4-spacer" />
        <Link className="p4-btn quiet" to="/lectures">
          Lectures
        </Link>
      </header>
      <div className="p4-inner">
        <h1 className="p4-title">Recorded sessions</h1>
        <p className="p4-sub">
          {plural(rows.length, 'session')}
          {live > 0 ? ` · ${live} live` : ''} · newest first
        </p>

        {error && (
          <div className="p4-notice warn" role="alert">
            <span>{error}</span>
            <button className="p4-btn" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <section className="p4-section" aria-label="Recorded sessions">
          {rows.length === 0 && <p className="p4-empty">No sessions yet. Start a lecture from the dashboard to record one.</p>}
          <ul className="p4-list">{rows.map(renderRow)}</ul>
        </section>
      </div>

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
    </div>
  )
}
