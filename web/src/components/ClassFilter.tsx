// Class filter for the Dashboard and the P4 list pages (/lectures, /archive, /sessions). Same behavior as the
// dashboard's filter: "All", pick one or several classes (every class picked = All), "+" edits classes.
// It shares the dashboard's remembered selection, so a filter picked on one screen carries over.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ClassGroup } from '../types'
import { IconPlus } from './DashIcons'
import '../styles/class-filter.css'

const FILTER_KEY = 'dash-class-filter' // same key as the dashboard

function readFilter(): string[] {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw || raw === 'all') return []
    const parsed: unknown = raw.startsWith('[') ? JSON.parse(raw) : [raw]
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeFilter(f: string[]) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(f))
  } catch {
    // private mode / blocked storage: the filter just isn't remembered
  }
}

type ClassLink = { class_id: string }

/** `loaded` = classes have been fetched, so remembered ids for deleted classes can be dropped. */
export function useClassFilter(classes: ClassGroup[], loaded: boolean) {
  const [filter, setFilterState] = useState<string[]>(readFilter)

  const setFilter = useCallback((f: string[]) => {
    setFilterState(f)
    writeFilter(f)
  }, [])

  useEffect(() => {
    if (!loaded) return
    setFilterState((f) => {
      const kept = f.filter((id) => classes.some((c) => c.id === id))
      return kept.length === classes.length ? [] : kept
    })
  }, [classes, loaded])

  const toggle = (id: string) => {
    const next = filter.includes(id) ? filter.filter((x) => x !== id) : [...filter, id]
    setFilter(next.length === 0 || next.length === classes.length ? [] : next)
  }

  const matches = (links: ClassLink[] | null | undefined) =>
    filter.length === 0 || (links ?? []).some((x) => filter.includes(x.class_id))

  const filterName =
    filter.length === 0 ? null : filter.length === 1 ? (classes.find((c) => c.id === filter[0])?.name ?? 'this class') : 'the selected classes'

  return { filter, setFilter, toggle, matches, filterName }
}

/** Center-fill time (ms); keep in sync with --cf-fill-ms in class-filter.css. */
const FILL_MS = 320
/** Speed of the handover: one fill "front" travels right to left at this many px per ms. */
const SWEEP_PX_PER_MS = 1.1
const MIN_SEGMENT_MS = 90

/** When the front reaches an element (t) and how long it takes to cross it (d), in ms. */
type Timing = { t: number; d: number }

/** Handover to "All": chips in `ids` give their fill, right to left, to the All chip.
 *  fill = the last class is still filling (selecting it completed the set); hold = all handing-over
 *  chips drawn full; slide = the fills retract and All fills. */
type Sweep = { phase: 'fill' | 'hold' | 'slide'; ids: string[]; timing?: Record<string, Timing> }

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function ClassFilterBar({
  classes,
  filter,
  onAll,
  onToggle,
  onManage,
  size = 'large',
  className = '',
}: {
  classes: ClassGroup[]
  filter: string[]
  onAll: () => void
  onToggle: (id: string) => void
  onManage: () => void
  /** compact = dashboard (36px pills, 48px taps); large = list pages (44px, 64px) */
  size?: 'compact' | 'large'
  className?: string
}) {
  const [pop, setPop] = useState<string | null>(null) // class id, or 'all'
  const [shrink, setShrink] = useState<string | null>(null) // class id being manually deselected
  const [sweep, setSweep] = useState<Sweep | null>(null)
  const timers = useRef<number[]>([])
  const frame = useRef<number | null>(null)
  const pills = useRef(new Map<string, HTMLElement>()) // class id or 'all' -> its visible pill
  const pillRef = (key: string) => (el: HTMLElement | null) => {
    if (el) pills.current.set(key, el)
    else pills.current.delete(key)
  }

  /** One front moving right to left from the rightmost handing-over chip, through the chips, into All. */
  const measure = (ids: string[]): { timing: Record<string, Timing>; total: number } | null => {
    const rects = ids.map((id) => pills.current.get(id)?.getBoundingClientRect())
    const all = pills.current.get('all')?.getBoundingClientRect()
    if (!all || rects.some((r) => !r)) return null
    const start = Math.max(...rects.map((r) => r!.right))
    const at = (r: DOMRect): Timing => ({
      t: Math.max(0, (start - r.right) / SWEEP_PX_PER_MS),
      d: Math.max(MIN_SEGMENT_MS, r.width / SWEEP_PX_PER_MS),
    })
    const timing: Record<string, Timing> = {}
    ids.forEach((id, k) => (timing[id] = at(rects[k]!)))
    timing.all = at(all)
    return { timing, total: timing.all.t + timing.all.d }
  }

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }
  useEffect(() => clearTimers, [])

  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms))
  }

  /** Run the handover from `ids` (in on-screen order) to All. `fillFirst` waits for a chip's own fill. */
  const startSweep = (ids: string[], fillFirst: boolean) => {
    clearTimers()
    if (ids.length === 0 || reducedMotion()) {
      setSweep(null)
      return
    }
    const toSlide = () => {
      setSweep({ phase: 'hold', ids })
      // two frames so the browser paints the full fills before they start sliding
      frame.current = requestAnimationFrame(() => {
        frame.current = requestAnimationFrame(() => {
          frame.current = null
          const m = measure(ids)
          if (!m) {
            setSweep(null)
            setPop('all')
            return
          }
          setSweep({ phase: 'slide', ids, timing: m.timing })
          later(m.total + 40, () => {
            setSweep(null)
            setPop('all')
          })
        })
      })
    }
    if (fillFirst) {
      setSweep({ phase: 'fill', ids })
      later(FILL_MS, toSlide)
    } else toSlide()
  }

  const clickClass = (id: string) => {
    clearTimers()
    setSweep(null)
    const turningOn = !filter.includes(id)
    const completesAll = turningOn && classes.length > 0 && filter.length === classes.length - 1
    if (turningOn) setPop(id)
    else setShrink(id)
    if (completesAll) startSweep(classes.map((c) => c.id), true)
    onToggle(id)
  }

  const clickAll = () => {
    if (filter.length === 0 && !sweep) return // already All
    const filled = classes.map((c) => c.id).filter((id) => filter.includes(id))
    setPop(null)
    startSweep(filled, false)
    if (filled.length === 0 || reducedMotion()) setPop('all')
    onAll()
  }

  // What each chip shows: the sweep (while running) overrides the real filter.
  const handing = new Set(sweep?.ids ?? [])
  const timingStyle = (key: string): CSSProperties | undefined => {
    const tm = sweep?.phase === 'slide' ? sweep.timing?.[key] : undefined
    return tm ? ({ '--t': `${Math.round(tm.t)}ms`, '--d': `${Math.round(tm.d)}ms` } as CSSProperties) : undefined
  }
  const chipState = (id: string) => {
    if (!sweep) return filter.includes(id) ? ' on' : ''
    if (!handing.has(id)) return ''
    if (sweep.phase === 'fill') return ' on'
    if (sweep.phase === 'hold') return ' cf-hold'
    return ' cf-out'
  }
  const allState = !sweep ? (filter.length === 0 ? ' on' : '') : sweep.phase === 'slide' ? ' cf-in' : ' cf-from'
  const allOn = filter.length === 0

  return (
    <nav className={`cf ${size} ${className}`} aria-label="Filter by class">
      <button
        type="button"
        className={`cf-chip${allState}${pop === 'all' ? ' pop' : ''}`}
        style={timingStyle('all')}
        aria-pressed={allOn}
        onClick={clickAll}
      >
        <span className="cf-pill" ref={pillRef('all')} onAnimationEnd={() => setPop(null)}>
          All
        </span>
      </button>
      {classes.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`cf-chip${chipState(c.id)}${pop === c.id ? ' pop' : ''}${shrink === c.id ? ' shrink' : ''}`}
          style={handing.has(c.id) ? timingStyle(c.id) : undefined}
          aria-pressed={filter.includes(c.id)}
          onClick={() => clickClass(c.id)}
        >
          <span
            className="cf-pill"
            ref={pillRef(c.id)}
            onAnimationEnd={() => {
              setPop(null)
              setShrink(null)
            }}
          >
            <span className="cf-dot" style={{ background: c.color }} aria-hidden="true" />
            {c.name}
          </span>
        </button>
      ))}
      <button
        type="button"
        className="cf-chip add"
        aria-label={classes.length ? 'Add or edit classes' : 'Add a class'}
        title="Add or edit classes"
        onClick={onManage}
      >
        <span className="cf-pill">
          <IconPlus />
        </span>
      </button>
    </nav>
  )
}
