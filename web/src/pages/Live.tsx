// The student view of a session: the board, read-only, kept live by Supabase Realtime (useSessionData).
// Students get here from /join. Phone-first; no links to teacher pages.
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Board from '../components/Board'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { useSessionData } from '../hooks/useSessionData'
import '../styles/p4.css'
import '../styles/student.css'

/** Scrolled up more than this from the bottom: stop following new content. */
const FOLLOW_SLACK_PX = 120
/** Scrolled up more than this from the bottom: offer Jump to latest. */
const JUMP_AFTER_PX = 400

export default function Live() {
  const { sessionId = '' } = useParams()
  const data = useSessionData(sessionId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolledUp = useRef(false)
  const lastTop = useRef(0)
  const [showJump, setShowJump] = useState(false)
  const counts = [data.blockList.length, data.segmentList.length, data.annotationList.length]

  // useAutoScroll attaches its scroll listener on first mount, while the loading screen is up and the
  // scroll box doesn't exist yet, so track scrolling here once the board is on screen.
  useEffect(() => {
    const el = scrollRef.current
    if (data.loading || !el) return
    const onScroll = () => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const movingUp = el.scrollTop < lastTop.current
      lastTop.current = el.scrollTop
      // Moving up is always the student. Moving down may be the auto-follow, which must not count as scrolling up.
      scrolledUp.current = (movingUp || scrolledUp.current) && fromBottom > FOLLOW_SLACK_PX
      setShowJump(scrolledUp.current && fromBottom > JUMP_AFTER_PX)
    }
    lastTop.current = el.scrollTop
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [data.loading])

  // Follow new content, unless the student scrolled up or has a popover open (any scroll would close it).
  useAutoScroll(
    scrollRef,
    counts,
    () => scrolledUp.current || !!scrollRef.current?.querySelector('.annotation-popover'),
  )

  // New content while scrolled up can push the latest out of reach without a scroll event.
  useEffect(() => {
    const el = scrollRef.current
    if (el && scrolledUp.current) setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > JUMP_AFTER_PX)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, counts)

  const jumpToLatest = () => {
    const el = scrollRef.current
    if (!el) return
    scrolledUp.current = false
    setShowJump(false)
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' })
  }

  if (data.loading)
    return (
      <div className="p4 stu stu-join">
        <p className="stu-loading">Loading the lecture…</p>
      </div>
    )
  if (data.error || !data.session)
    return (
      <div className="p4 stu stu-join">
        <div className="stu-join-card">
          <span className="p4-badge">Live lecture</span>
          <h1>This lecture couldn’t be found</h1>
          <Link className="p4-btn solid stu-join-btn" to="/join">
            Enter a code
          </Link>
        </div>
      </div>
    )

  const live = data.session.status === 'live'
  const title = data.session.title || data.lecture?.title || 'Lecture'
  const hasCircles = data.annotationList.some((a) => a.status === 'confirmed')

  return (
    <div className="p4 stu stu-live">
      <header className="stu-head">
        <h1 className="stu-title">{title}</h1>
        {live ? <span className="stu-live-dot">Live</span> : <span className="stu-ended">Ended</span>}
      </header>

      {!live && (
        <div className="stu-banner" role="status">
          <span>This lecture has ended. The study notes appear as soon as they’re compiled.</span>
          <Link className="p4-btn solid" to={`/notes/${sessionId}?student=1`}>
            Open study notes
          </Link>
        </div>
      )}

      <div className="stu-board" ref={scrollRef}>
        <Board
          blocks={data.blockList}
          assets={data.assets}
          strokes={data.strokeList}
          annotations={data.annotationList}
          segments={data.segmentList}
          showPending={live}
          emptyText="Waiting for the lecture to start…"
        />
        {hasCircles && <p className="stu-hint">Tap a circled part of a diagram to see what he said about it.</p>}
      </div>

      {live && showJump && (
        <button type="button" className="p4-btn solid stu-jump" onClick={jumpToLatest}>
          Jump to latest <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  )
}
