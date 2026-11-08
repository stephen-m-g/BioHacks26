// P1 owns this component. Live-session sidebar. Scrolls only if the screen is too short.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { assetUrl } from '../lib/assets'
import type { SpeechMetrics } from '../hooks/transcriptionModel'
import { INK_COLORS, INK_WIDTHS, useSessionStore } from '../store/session'
import { useSettings } from '../store/settings'
import type { Asset } from '../types'
import { ChevronDownIcon, PenIcon, SwapIcon, UndoIcon, WandIcon } from './icons'
import '../styles/session-status.css'

export interface Recording {
  /** Recording wanted (not paused) and the session is live. */
  on: boolean
  /** The session is live, so the mic can be turned on. */
  live: boolean
  /** The recognizer is actually running right now. */
  listening: boolean
  supported: boolean
  error: string | null
  /** Rolling / baseline WPM and average confidence from the transcription hook (P3). */
  metrics: SpeechMetrics
  /** False when the provider reports no confidence (ElevenLabs), so Clarity reads "unavailable". */
  confidenceSupported: boolean
  startedAt: string
  toggle: () => void
}

/** A PDF in the sidebar: one item for the whole document, however many pages it has. */
export interface SidebarDocument {
  asset: Asset
  /** Page 1's image, once rendered (thumbnail and drag ghost). */
  firstPage: Asset | null
  pageCount: number | null
  status: 'ready' | 'preparing' | 'error'
  error?: string
  /** Its pages are already on this board (it is placed once; tapping shows it). */
  onBoard: boolean
}

interface Props {
  title: string
  recording: Recording
  /** Save a new session name. */
  onRename: (title: string) => void
  images: Asset[]
  documents: SidebarDocument[]
  onUndo: () => void
  /** Drop an image on a slot (drag). */
  onDrop: (assetId: string, aspect: number, slot: number) => void
  /** Drop a PDF on a slot (drag): all of its pages go there, in order. */
  onDropDocument: (pdfId: string, slot: number) => void
  /** Scroll to a PDF that is already on the board. */
  onShowDocument: (pdfId: string) => void
  /** Try rendering a PDF's pages again after an error. */
  onRetryDocument: (pdfId: string) => void
  onEnd: () => void
  /** Remember each image's aspect ratio once its thumbnail loads. */
  onImageAspect: (assetId: string, aspect: number) => void
}

type Placeable = { id: string; kind: 'image' | 'pdf'; src: string }

const COLOR_NAMES: Record<string, string> = {
  '#111111': 'Black',
  '#2563eb': 'Blue',
  '#dc2626': 'Red',
  '#16a34a': 'Green',
}

/** Drag starts once the pointer moves this far; shorter is a tap. */
const DRAG_THRESHOLD = 12

/** Snap a drop anywhere over the board to the vertically nearest slot, so imprecise drops still land. */
function nearestSlot(x: number, y: number): HTMLElement | null {
  const board = document.querySelector('.board-scroll')?.getBoundingClientRect()
  if (!board || x < board.left || x > board.right || y < board.top || y > board.bottom) return null
  let best: HTMLElement | null = null
  let bestDist = Infinity
  document.querySelectorAll<HTMLElement>('[data-slot]').forEach((el) => {
    const r = el.getBoundingClientRect()
    const dist = Math.abs(r.top + r.height / 2 - y)
    if (dist < bestDist) {
      bestDist = dist
      best = el
    }
  })
  return best
}

function highlightSlot(el: HTMLElement | null) {
  document.querySelectorAll('.slot-target').forEach((s) => s.classList.remove('slot-target'))
  el?.classList.add('slot-target')
}

/** Recording status under the session title: dot + label on the left, session time on the right.
 *  Red pulse while recording, grey when paused or connecting, a red ring on a mic error. */
function SessionClock({ recording }: { recording: Recording }) {
  // Counts recorded time only: it freezes while recording is paused and continues on resume.
  // On first load it starts from the session's start time (pauses before a reload aren't known).
  const [secs, setSecs] = useState(() =>
    Math.max(0, Math.floor((Date.now() - new Date(recording.startedAt).getTime()) / 1000)),
  )
  const secsRef = useRef(secs)
  secsRef.current = secs
  useEffect(() => {
    if (!recording.on) return
    const base = secsRef.current
    const t0 = Date.now()
    const t = setInterval(() => setSecs(base + Math.floor((Date.now() - t0) / 1000)), 250)
    return () => clearInterval(t)
  }, [recording.on])
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`
  const state = !recording.supported
    ? 'unsupported'
    : recording.on && recording.error
      ? 'error'
      : recording.on && recording.listening
        ? 'recording'
        : recording.on
          ? 'starting'
          : 'paused'
  const label = { unsupported: 'No mic', error: 'Mic error', recording: 'Recording', starting: 'Starting…', paused: 'Paused' }[state]
  return (
    <div
      className={`session-status ${state}`}
      role="status"
      aria-live="polite"
      title={recording.error ? `Mic: ${recording.error}` : undefined}
    >
      <span className="session-status-left">
        <span className="session-status-dot" aria-hidden="true" />
        <span className="session-status-label">{label}</span>
      </span>
      <span className="session-status-time" aria-label={`Session time ${time}`}>
        {time}
      </span>
    </div>
  )
}

export default function Sidebar({
  title,
  recording,
  onRename,
  images,
  documents,
  onUndo,
  onDrop,
  onDropDocument,
  onShowDocument,
  onRetryDocument,
  onEnd,
  onImageAspect,
}: Props) {
  const s = useSessionStore()
  const settings = useSettings()
  const locked = s.pendingAnnotationId !== null
  const [ghost, setGhost] = useState<{ src: string; x: number; y: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(title)

  const editingRef = useRef(false)

  const startRename = () => {
    setMenuOpen(false)
    setDraftTitle(title)
    editingRef.current = true
    setEditing(true)
  }

  const finishRename = (save: boolean) => {
    if (!editingRef.current) return // Enter/Escape already finished; ignore the blur that follows
    editingRef.current = false
    setEditing(false)
    const next = draftTitle.trim()
    if (save && next && next !== title) onRename(next)
  }
  const press = useRef<{ assetId: string; x: number; y: number; dragging: boolean; aspect: number } | null>(null)

  const onThumbDown = (e: ReactPointerEvent<HTMLButtonElement>, item: Placeable) => {
    if (locked) return
    const img = e.currentTarget.querySelector('img')
    const aspect = img && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 4 / 3
    press.current = { assetId: item.id, x: e.clientX, y: e.clientY, dragging: false, aspect }
  }

  const onThumbMove = (e: ReactPointerEvent<HTMLButtonElement>, item: Placeable) => {
    const p = press.current
    if (!p || p.assetId !== item.id) return
    if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD) {
      p.dragging = true
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // synthetic or already-released pointer
      }
      s.setDraggingAsset(item.id)
      s.setSelectedAsset(null)
    }
    if (p.dragging) {
      setGhost({ src: item.src, x: e.clientX, y: e.clientY })
      highlightSlot(nearestSlot(e.clientX, e.clientY))
    }
  }

  const onThumbUp = (e: ReactPointerEvent<HTMLButtonElement>, item: Placeable) => {
    const p = press.current
    press.current = null
    if (!p || p.assetId !== item.id) return
    if (p.dragging) {
      const target = nearestSlot(e.clientX, e.clientY)
      highlightSlot(null)
      setGhost(null)
      s.setDraggingAsset(null)
      if (!target) return
      const slot = Number(target.dataset.slot)
      if (item.kind === 'pdf') onDropDocument(item.id, slot)
      else onDrop(item.id, p.aspect, slot)
    } else {
      // Tap: select, then tap a spot on the board.
      s.setSelectedAsset(s.selectedAssetId === item.id ? null : item.id)
    }
  }

  const imageItem = (a: Asset): Placeable => ({ id: a.id, kind: 'image', src: assetUrl(a) })
  const documentItem = (d: SidebarDocument): Placeable => ({ id: d.asset.id, kind: 'pdf', src: assetUrl(d.firstPage) })
  const documentStatus = (d: SidebarDocument) =>
    d.status === 'preparing'
      ? 'Preparing pages…'
      : d.status === 'error'
        ? 'Couldn’t prepare pages. Tap to retry.'
        : `${d.pageCount === 1 ? '1 page' : `${d.pageCount} pages`}${d.onBoard ? ' · on the board' : ''}`

  const onThumbCancel = () => {
    press.current = null
    highlightSlot(null)
    setGhost(null)
    s.setDraggingAsset(null)
  }

  return (
    <aside className="sidebar" aria-label="Board tools">
      <div className="title-menu">
        {editing ? (
          <input
            className="title-input"
            aria-label="Session name"
            value={draftTitle}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={() => finishRename(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') finishRename(true)
              if (e.key === 'Escape') finishRename(false)
            }}
          />
        ) : (
          <button
            className="title-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={`${title} (double-click to rename)`}
            onClick={() => setMenuOpen((o) => !o)}
            onDoubleClick={startRename}
          >
            <span className="title-text">{title}</span>
            <ChevronDownIcon />
          </button>
        )}
        {menuOpen && !editing && (
          <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="menu" role="menu">
              {recording.on && (
                <div className="speech-metrics" aria-label="Speech metrics">
                  <span>Pace {recording.metrics.rollingWpm ?? '—'} wpm</span>
                  <span>Baseline {recording.metrics.baselineWpm ?? '—'} wpm</span>
                  <span>
                    Clarity{' '}
                    {!recording.confidenceSupported
                      ? 'unavailable'
                      : recording.metrics.averageConfidence === null
                        ? '—'
                        : `${Math.round(recording.metrics.averageConfidence * 100)}%`}
                  </span>
                </div>
              )}
              {recording.on && recording.error && <p className="hint speech-error">{recording.error}</p>}
              <button
                role="menuitem"
                className="menu-item"
                disabled={!recording.supported}
                onClick={() => {
                  setMenuOpen(false)
                  recording.toggle()
                }}
              >
                {recording.on ? 'Pause recording' : 'Start recording'}
              </button>
              <button
                role="menuitem"
                className="menu-item danger-item"
                onClick={() => {
                  setMenuOpen(false)
                  onEnd()
                }}
              >
                End session
              </button>
            </div>
          </>
        )}
      </div>

      <SessionClock recording={recording} />

      <hr className="sidebar-divider" />

      <div className="mode-row" role="radiogroup" aria-label="Drawing mode">
        <button
          role="radio"
          aria-checked={s.mode === 'ink'}
          aria-label="Ink"
          title="Ink"
          className={`icon-btn${s.mode === 'ink' ? ' on' : ''}`}
          onClick={() => s.setMode('ink')}
        >
          <span className="ic">
            <PenIcon />
          </span>
        </button>
        <button
          role="radio"
          aria-checked={s.mode === 'smart'}
          aria-label="Smart annotation"
          title="Smart annotation"
          className={`icon-btn${s.mode === 'smart' ? ' on' : ''}`}
          onClick={() => s.setMode('smart')}
        >
          <span className="ic">
            <WandIcon />
          </span>
        </button>
      </div>

      <div className="sidebar-label mode-label" aria-live="polite">
        {s.mode === 'ink' ? 'Pen' : 'Smart annotate'}
      </div>

      {s.mode === 'ink' ? (
        <div className="tool-panel">
          <p className="hint mode-hint">Directly annotate diagrams.</p>
          <div className="swatches" role="radiogroup" aria-label="Ink color">
            {INK_COLORS.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={s.inkColor === c}
                aria-label={COLOR_NAMES[c] ?? c}
                className={`swatch${s.inkColor === c ? ' on' : ''}`}
                onClick={() => s.setInkColor(c)}
              >
                <span className="swatch-dot" style={{ background: c }} />
              </button>
            ))}
          </div>
          <div className="widths" role="radiogroup" aria-label="Ink width">
            {INK_WIDTHS.map((w) => (
              <button
                key={w.value}
                role="radio"
                aria-checked={s.inkWidth === w.value}
                aria-label={w.label}
                title={w.label}
                className={`width-btn${s.inkWidth === w.value ? ' on' : ''}`}
                onClick={() => s.setInkWidth(w.value)}
              >
                <span className="width-chip">
                  <span className="width-dot" style={{ width: 3 + w.value * 700, height: 3 + w.value * 700 }} />
                </span>
              </button>
            ))}
            <button className="width-btn" aria-label="Undo last stroke" title="Undo" onClick={onUndo}>
              <span className="width-chip undo">
                <UndoIcon />
              </span>
            </button>
          </div>
        </div>
      ) : (
        <p className="hint mode-hint">
          {locked ? 'Talk about what you circled, then press ✓ to save or ✗ to cancel.' : 'Draw a loop around part of an image to link it to your words.'}
        </p>
      )}

      <hr className="sidebar-divider" />

      <div className="sidebar-images">
        <div className="sidebar-label">Images</div>
        <p className="hint images-hint" aria-live="polite">
          {locked
            ? 'Finish the open annotation (✓ or ✗) first.'
            : s.selectedAssetId
              ? 'Now tap a spot on the board.'
              : images.length === 0 && documents.length === 0
                ? 'No images uploaded for this lecture.'
                : 'Drag onto the board or tap and place.'}
        </p>
        <div className="thumb-grid">
          {images.map((a) => (
            <button
              key={a.id}
              className={`thumb${s.selectedAssetId === a.id ? ' on' : ''}`}
              disabled={locked}
              aria-label={a.label || a.file_name || 'Image'}
              aria-pressed={s.selectedAssetId === a.id}
              title={a.label || a.file_name || 'Image'}
              onPointerDown={(e) => onThumbDown(e, imageItem(a))}
              onPointerMove={(e) => onThumbMove(e, imageItem(a))}
              onPointerUp={(e) => onThumbUp(e, imageItem(a))}
              onPointerCancel={onThumbCancel}
            >
              <img
                src={assetUrl(a)}
                alt=""
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget
                  if (img.naturalHeight) onImageAspect(a.id, img.naturalWidth / img.naturalHeight)
                }}
              />
            </button>
          ))}
        </div>
        {documents.length > 0 && (
          <>
            <div className="sidebar-label docs-label">Documents</div>
            <div className="doc-list">
              {documents.map((d) => {
                const name = d.asset.file_name || d.asset.label || 'PDF'
                const status = documentStatus(d)
                if (d.status !== 'ready' || d.onBoard) {
                  return (
                    <button
                      key={d.asset.id}
                      className={`doc-item ${d.status}${d.onBoard ? ' placed' : ''}`}
                      disabled={d.status === 'preparing' || locked}
                      aria-label={`${name}: ${status}`}
                      title={d.status === 'error' ? d.error : name}
                      onClick={() => (d.status === 'error' ? onRetryDocument(d.asset.id) : onShowDocument(d.asset.id))}
                    >
                      <span className="doc-thumb" aria-hidden="true">
                        {d.firstPage && <img src={assetUrl(d.firstPage)} alt="" draggable={false} />}
                      </span>
                      <span className="doc-text">
                        <span className="doc-name">{name}</span>
                        <span className="doc-meta">{status}</span>
                      </span>
                    </button>
                  )
                }
                const item = documentItem(d)
                return (
                  <button
                    key={d.asset.id}
                    className={`doc-item ready${s.selectedAssetId === d.asset.id ? ' on' : ''}`}
                    disabled={locked}
                    aria-label={`${name}, ${status}`}
                    aria-pressed={s.selectedAssetId === d.asset.id}
                    title={`${name}: drag onto the board to place every page`}
                    onPointerDown={(e) => onThumbDown(e, item)}
                    onPointerMove={(e) => onThumbMove(e, item)}
                    onPointerUp={(e) => onThumbUp(e, item)}
                    onPointerCancel={onThumbCancel}
                  >
                    <span className="doc-thumb" aria-hidden="true">
                      {d.firstPage && <img src={item.src} alt="" draggable={false} />}
                    </span>
                    <span className="doc-text">
                      <span className="doc-name">{name}</span>
                      <span className="doc-meta">{status}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          className="icon-btn small"
          onClick={() => settings.setSidebarSide(settings.sidebarSide === 'left' ? 'right' : 'left')}
          aria-label={`Move sidebar to the ${settings.sidebarSide === 'left' ? 'right' : 'left'}`}
          title="Move sidebar to the other side"
        >
          <span className="ic">
            <SwapIcon />
          </span>
        </button>
      </div>

      {ghost && <img className="drag-ghost" src={ghost.src} alt="" style={{ left: ghost.x, top: ghost.y }} draggable={false} />}
    </aside>
  )
}
