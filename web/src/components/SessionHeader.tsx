// Header for a session's two views (study notes and transcript; one page, so it stays put when switching), matching the list pages and the lecture
// editor: ← back + the session's title, then a row with the Study notes / Transcript switch, the date and
// (notes only) Print. Students (?student=1 on the notes) get no transcript switch and go back to the board.
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { IconArrowLeft, IconClock, IconPrinter } from './DashIcons'
import '../styles/p4.css'
import '../styles/lists.css'
import '../styles/class-filter.css'
import '../styles/study.css'

/** Pages a session view can return to, with how the back arrow names them. */
const RETURN_LABELS: Record<string, string> = { '/': 'the dashboard', '/sessions': 'recorded sessions' }

/** Where ← goes: the page that opened this session view (router state), else the dashboard. */
export function useSessionReturn() {
  const location = useLocation()
  const from = (location.state as { from?: unknown } | null)?.from
  const to = typeof from === 'string' && Object.prototype.hasOwnProperty.call(RETURN_LABELS, from) ? from : '/'
  return { to, label: RETURN_LABELS[to], state: to === '/' ? undefined : { from: to } }
}

/** The session's name, edited in place: Enter or leaving the field saves, Escape puts it back. Empty keeps the old name. */
function TitleField({ title, onRename }: { title: string; onRename: (name: string) => Promise<unknown> }) {
  const [value, setValue] = useState(title)
  const [failed, setFailed] = useState(false)
  useEffect(() => setValue(title), [title])

  const commit = () => {
    const next = value.trim()
    if (!next || next === title) return setValue(title)
    setFailed(false)
    onRename(next).catch(() => {
      setFailed(true)
      setValue(title)
    })
  }

  return (
    <input
      className="lp-title lp-title-input"
      aria-label="Session name"
      title={failed ? 'Couldn’t rename this session. Try again.' : 'Rename this session'}
      value={value}
      placeholder="Session name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setValue(title)
          // Blur after the reset renders, so commit sees the old name and does nothing.
          const el = e.currentTarget
          requestAnimationFrame(() => el.blur())
        }
      }}
    />
  )
}

export default function SessionHeader({
  sessionId,
  title,
  view,
  when,
  student = false,
  onPrint,
  onRename,
}: {
  /** Makes the title an editable field (like the lecture editor's); saves on Enter or when it loses focus. */
  onRename?: (name: string) => Promise<unknown>
  sessionId: string
  title: string
  view: 'notes' | 'transcript'
  /** Date line on the right, e.g. "Nov 7, 2026, 9:02 AM". */
  when?: string
  student?: boolean
  /** Shows the Print button (notes with content). */
  onPrint?: () => void
}) {
  const ret = useSessionReturn()
  const backTo = student ? `/live/${sessionId}` : ret.to
  const backLabel = student ? 'the live board' : ret.label

  return (
    <>
      <header className="lp-header no-print">
        <Link className="lp-back" to={backTo} aria-label={`Back to ${backLabel}`} title={`Back to ${backLabel}`}>
          <span className="lp-back-circle">
            <IconArrowLeft />
          </span>
        </Link>
        {onRename && !student ? (
          <TitleField title={title} onRename={onRename} />
        ) : (
          <h1 className="lp-title">{title}</h1>
        )}
        <span aria-hidden="true" />
      </header>

      <div className="sv-bar no-print">
        {!student && (
          <nav className="cf large sv-tabs" aria-label="Session views">
            <Link
              className={`cf-chip${view === 'notes' ? ' on' : ''}`}
              to={`/notes/${sessionId}`}
              state={ret.state}
              aria-current={view === 'notes' ? 'page' : undefined}
            >
              <span className="cf-pill">Study notes</span>
            </Link>
            <Link
              className={`cf-chip${view === 'transcript' ? ' on' : ''}`}
              to={`/sessions/${sessionId}/raw`}
              state={ret.state}
              aria-current={view === 'transcript' ? 'page' : undefined}
            >
              <span className="cf-pill">Transcript</span>
            </Link>
          </nav>
        )}
        <div className="sv-spacer" />
        {when && (
          <span className="sv-when">
            <IconClock /> {when}
          </span>
        )}
        {onPrint && (
          <button type="button" className="lp-tap icon" onClick={onPrint} aria-label="Print or save as PDF" title="Print or save as PDF">
            <span className="lp-pill round outline-soft">
              <IconPrinter />
            </span>
          </button>
        )}
      </div>
    </>
  )
}
