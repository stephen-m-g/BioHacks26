// P1 owns this component. One image on the board with its ink and lasso annotations.
// Interactive (teacher, live): draw ink or a lasso with pen/finger/mouse.
// Read-only (raw view, notes): hover for its popup; click navigates when the page provides a target.
import { useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { bboxOf, clamp01, lassoPath, strokePath, VB_W } from '../lib/ink'
import type { BoardMode } from '../store/session'
import type { Annotation, Block, Point, Stroke } from '../types'
import { popoverReducer } from './annotationPopoverModel'

export interface ImageBlockInteraction {
  mode: BoardMode
  inkColor: string
  inkWidth: number
  /** False once a pencil has been seen: then only the pencil draws and fingers scroll. */
  fingerDraws: boolean
  /** Called when an Apple Pencil touches the image (switches the board to pencil-only). */
  onPen?: () => void
  pendingId: string | null
  onStroke: (blockId: string, points: Point[]) => void
  onLasso: (blockId: string, points: Point[], drawnAt: string) => void
  onConfirm: (annotationId: string) => void
  onReject: (annotationId: string) => void
}

interface Props {
  block: Block
  src: string
  alt: string
  strokes: Stroke[]
  annotations: Annotation[]
  interactive?: ImageBlockInteraction
  /** Read-only: where clicking a circle navigates. */
  onJump?: (annotationId: string) => void
  selectedAnnotationId?: string | null
  onSelectAnnotation?: (annotationId: string) => void
}

/** Lassos smaller than this (fraction of image width/height) are treated as accidental. */
const MIN_LASSO = 0.03
/** Time to cross the gap from a circle into its popover before the popover closes. */
const HOVER_GRACE_MS = 150

export default function ImageBlock({
  block,
  src,
  alt,
  strokes,
  annotations,
  interactive,
  onJump,
  selectedAnnotationId,
  onSelectAnnotation,
}: Props) {
  const aspect = block.aspect || 4 / 3
  const vbH = VB_W / aspect
  const svgRef = useRef<SVGSVGElement>(null)
  const drawing = useRef<{ pointerId: number; points: Point[] } | null>(null)
  const [draft, setDraft] = useState<Point[] | null>(null)
  const [popover, dispatchPopover] = useReducer(popoverReducer, null)
  const leaveTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  // Apple Pencil: stop the page from scrolling under the pen once fingers are set to scroll.
  useEffect(() => {
    const el = svgRef.current
    if (!el || !interactive) return
    const stopStylusScroll = (e: TouchEvent) => {
      const touch = e.touches[0] as Touch & { touchType?: string }
      if (touch?.touchType === 'stylus') e.preventDefault()
    }
    el.addEventListener('touchstart', stopStylusScroll, { passive: false })
    el.addEventListener('touchmove', stopStylusScroll, { passive: false })
    return () => {
      el.removeEventListener('touchstart', stopStylusScroll)
      el.removeEventListener('touchmove', stopStylusScroll)
    }
  }, [interactive])

  const toPoint = (e: { clientX: number; clientY: number; pointerType: string; pressure: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return [
      clamp01((e.clientX - r.left) / r.width),
      clamp01((e.clientY - r.top) / r.height),
      e.pointerType === 'pen' ? e.pressure : 0.5,
    ]
  }

  const canDraw = (e: ReactPointerEvent) => {
    if (!interactive) return false
    if (e.pointerType === 'pen' && interactive.fingerDraws) interactive.onPen?.()
    if (drawing.current) return false // one pointer at a time rejects the palm
    if (e.pointerType === 'touch' && !interactive.fingerDraws) return false
    if (e.pointerType === 'mouse' && e.button !== 0) return false
    if (interactive.mode === 'smart' && interactive.pendingId) return false // finish the open lasso first
    return true
  }

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!canDraw(e)) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // synthetic or already-released pointer; drawing still works without capture
    }
    drawing.current = { pointerId: e.pointerId, points: [toPoint(e)] }
    setDraft(drawing.current.points.slice())
  }

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drawing.current
    if (!d || e.pointerId !== d.pointerId) return
    const events = e.nativeEvent.getCoalescedEvents?.() ?? []
    for (const ev of events.length ? events : [e.nativeEvent]) d.points.push(toPoint(ev))
    setDraft(d.points.slice())
  }

  const finish = (e: ReactPointerEvent<SVGSVGElement>, cancelled: boolean) => {
    const d = drawing.current
    if (!d || e.pointerId !== d.pointerId || !interactive) return
    drawing.current = null
    setDraft(null)
    if (cancelled) return
    if (interactive.mode === 'ink') {
      const pts = d.points.length === 1 ? [d.points[0], d.points[0]] : d.points
      interactive.onStroke(block.id, pts)
    } else {
      const bb = bboxOf(d.points)
      if (d.points.length >= 6 && bb.w >= MIN_LASSO && bb.h >= MIN_LASSO) {
        interactive.onLasso(block.id, d.points, new Date().toISOString())
      }
    }
  }

  const readOnly = !interactive
  const navigate = onSelectAnnotation ?? onJump
  const shown = popover ? annotations.find((a) => a.id === popover.id) : undefined
  const pending = interactive ? annotations.find((a) => a.id === interactive.pendingId) : undefined

  const cancelLeave = () => window.clearTimeout(leaveTimer.current)
  const leaveSoon = (id: string) => {
    cancelLeave()
    leaveTimer.current = window.setTimeout(() => dispatchPopover({ type: 'leave', id }), HOVER_GRACE_MS)
  }
  const activate = (id: string) => {
    cancelLeave()
    dispatchPopover({ type: 'activate', id, navigates: !!navigate })
    navigate?.(id)
  }

  return (
    <div className="image-block" style={{ aspectRatio: String(aspect) }}>
      <img src={src} alt={alt} draggable={false} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${vbH}`}
        className={interactive ? `drawable mode-${interactive.mode}` : undefined}
        style={{ touchAction: interactive?.fingerDraws ? 'none' : 'pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
      >
        {strokes.map((s) => (
          <path key={s.id} d={strokePath(s.points, s.width, VB_W, vbH)} fill={s.color} />
        ))}

        {annotations.map((a) => {
          const d = lassoPath(a.path, VB_W, vbH)
          if (a.status === 'pending') {
            return (
              <g key={a.id}>
                <path d={d} className="lasso-pending" />
                <path d={d} className="lasso-shimmer" pathLength={1000} />
              </g>
            )
          }
          if (!readOnly) return <path key={a.id} d={d} className="lasso-confirmed" />
          const isShown = shown?.id === a.id || selectedAnnotationId === a.id
          return (
            <path
              key={a.id}
              d={d}
              className={`lasso-confirmed hoverable${isShown ? ' is-shown' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={a.label ?? 'Annotation'}
              onPointerEnter={(e) => {
                if (e.pointerType === 'touch') return
                cancelLeave()
                dispatchPopover({ type: 'enter', id: a.id })
              }}
              onPointerLeave={() => leaveSoon(a.id)}
              onFocus={(e) => e.currentTarget.matches(':focus-visible') && dispatchPopover({ type: 'focus', id: a.id })}
              onBlur={() => dispatchPopover({ type: 'blur', id: a.id })}
              onClick={() => activate(a.id)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                activate(a.id)
              }}
            />
          )
        })}

        {draft &&
          (interactive?.mode === 'ink' ? (
            <path d={strokePath(draft, interactive.inkWidth, VB_W, vbH)} fill={interactive.inkColor} />
          ) : (
            <path d={lassoPath(draft, VB_W, vbH, false)} className="lasso-draft" />
          ))}
      </svg>

      {/* Teacher: big confirm / cancel next to the open lasso */}
      {pending && interactive && (
        <div className="lasso-actions" style={actionPosition(pending)}>
          <button className="lasso-btn ok" aria-label="Save annotation" onClick={() => interactive.onConfirm(pending.id)}>
            ✓
          </button>
          <button className="lasso-btn bad" aria-label="Cancel annotation" onClick={() => interactive.onReject(pending.id)}>
            ✗
          </button>
        </div>
      )}

      {/* Teacher: confirmed but Gemini hasn't linked the words yet */}
      {interactive &&
        annotations
          .filter((a) => a.status === 'confirmed' && a.label === null && a.bubble_text === null)
          .map((a) => (
            <div key={a.id} className="lasso-badge" style={badgePosition(a)}>
              Linking speech…
            </div>
          ))}

      {/* Read-only: popup with his words */}
      {readOnly && shown && (
        <div
          className="annotation-popover"
          role="tooltip"
          style={popoverPosition(shown)}
          onPointerEnter={cancelLeave}
          onPointerLeave={() => leaveSoon(shown.id)}
        >
          <strong>{shown.label ?? 'Annotation'}</strong>
          <p>{shown.bubble_text?.trim() || 'No explanation recorded.'}</p>
        </div>
      )}
    </div>
  )
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`
const centerX = (a: Annotation) => Math.min(0.85, Math.max(0.15, a.bbox.x + a.bbox.w / 2))

/** Above the lasso, or below it when it's near the top edge. Kept inside the image horizontally. */
function actionPosition(a: Annotation) {
  const above = a.bbox.y > 0.25
  return {
    left: pct(centerX(a)),
    top: above ? `calc(${pct(a.bbox.y)} - 88px)` : `calc(${pct(a.bbox.y + a.bbox.h)} + 12px)`,
  }
}

function badgePosition(a: Annotation) {
  return { left: pct(centerX(a)), top: `calc(${pct(a.bbox.y + a.bbox.h)} + 6px)` }
}

function popoverPosition(a: Annotation) {
  return { left: pct(centerX(a)), top: `calc(${pct(a.bbox.y + a.bbox.h)} + 10px)` }
}
