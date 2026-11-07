// P1 owns this component. Live-session sidebar: fits the screen without scrolling (only the image
// grid scrolls internally if there are many images).
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link } from 'react-router-dom'
import { assetUrl } from '../lib/assets'
import { INK_COLORS, INK_WIDTHS, useSessionStore } from '../store/session'
import { useSettings } from '../store/settings'
import type { Asset } from '../types'
import { ChevronDownIcon, HandIcon, PenIcon, SwapIcon, UndoIcon, WandIcon } from './icons'

interface Props {
  title: string
  images: Asset[]
  onUndo: () => void
  /** Drop an image on a slot (drag). */
  onDrop: (assetId: string, aspect: number, slot: number) => void
  onEnd: () => void
  /** Remember each image's aspect ratio once its thumbnail loads. */
  onImageAspect: (assetId: string, aspect: number) => void
}

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

export default function Sidebar({ title, images, onUndo, onDrop, onEnd, onImageAspect }: Props) {
  const s = useSessionStore()
  const settings = useSettings()
  const locked = s.pendingAnnotationId !== null
  const [ghost, setGhost] = useState<{ src: string; x: number; y: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const press = useRef<{ assetId: string; x: number; y: number; dragging: boolean; aspect: number } | null>(null)

  const onThumbDown = (e: ReactPointerEvent<HTMLButtonElement>, asset: Asset) => {
    if (locked) return
    const img = e.currentTarget.querySelector('img')
    const aspect = img && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 4 / 3
    press.current = { assetId: asset.id, x: e.clientX, y: e.clientY, dragging: false, aspect }
  }

  const onThumbMove = (e: ReactPointerEvent<HTMLButtonElement>, asset: Asset) => {
    const p = press.current
    if (!p || p.assetId !== asset.id) return
    if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD) {
      p.dragging = true
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // synthetic or already-released pointer
      }
      s.setDraggingAsset(asset.id)
      s.setSelectedAsset(null)
    }
    if (p.dragging) {
      setGhost({ src: assetUrl(asset), x: e.clientX, y: e.clientY })
      highlightSlot(nearestSlot(e.clientX, e.clientY))
    }
  }

  const onThumbUp = (e: ReactPointerEvent<HTMLButtonElement>, asset: Asset) => {
    const p = press.current
    press.current = null
    if (!p || p.assetId !== asset.id) return
    if (p.dragging) {
      const target = nearestSlot(e.clientX, e.clientY)
      highlightSlot(null)
      setGhost(null)
      s.setDraggingAsset(null)
      if (target) onDrop(asset.id, p.aspect, Number(target.dataset.slot))
    } else {
      // Tap: select, then tap a spot on the board.
      s.setSelectedAsset(s.selectedAssetId === asset.id ? null : asset.id)
    }
  }

  const onThumbCancel = () => {
    press.current = null
    highlightSlot(null)
    setGhost(null)
    s.setDraggingAsset(null)
  }

  return (
    <aside className="sidebar" aria-label="Board tools">
      <div className="title-menu">
        <button
          className="title-btn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={title}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="title-text">{title}</span>
          <ChevronDownIcon />
        </button>
        {menuOpen && (
          <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="menu" role="menu">
              <Link role="menuitem" className="menu-item" to="/">
                Back to lectures
              </Link>
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

      {s.mode === 'ink' ? (
        <div className="tool-panel">
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
              <span className="width-chip">
                <UndoIcon />
              </span>
            </button>
          </div>
        </div>
      ) : (
        <p className="hint">
          {locked ? 'Talk about what you circled, then press ✓ to save or ✗ to cancel.' : 'Draw a loop around part of an image, then talk about it.'}
        </p>
      )}

      <div className="sidebar-images">
        <div className="sidebar-label">Images</div>
        <p className="hint" aria-live="polite">
          {locked
            ? 'Finish the open annotation (✓ or ✗) first.'
            : s.selectedAssetId
              ? 'Now tap a spot on the board.'
              : images.length === 0
                ? 'No images uploaded for this lecture.'
                : 'Drag onto the board, or tap then tap a spot.'}
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
              onPointerDown={(e) => onThumbDown(e, a)}
              onPointerMove={(e) => onThumbMove(e, a)}
              onPointerUp={(e) => onThumbUp(e, a)}
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
        <button
          className={`icon-btn small${settings.fingerDraws ? ' on' : ''}`}
          aria-pressed={settings.fingerDraws}
          onClick={() => settings.setFingerDraws(!settings.fingerDraws)}
          aria-label={settings.fingerDraws ? 'Finger drawing on (tap for pencil only)' : 'Pencil only (tap to let fingers draw)'}
          title={settings.fingerDraws ? 'Finger drawing on' : 'Pencil only'}
        >
          <span className="ic">
            <HandIcon />
          </span>
        </button>
      </div>

      {ghost && <img className="drag-ghost" src={ghost.src} alt="" style={{ left: ghost.x, top: ghost.y }} draggable={false} />}
    </aside>
  )
}
