// P1 owns this component. Live-session sidebar: mode, ink presets, image bank, settings, End session.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { assetUrl } from '../lib/assets'
import { INK_COLORS, INK_WIDTHS, useSessionStore } from '../store/session'
import { useSettings } from '../store/settings'
import type { Asset } from '../types'

interface Props {
  title: string
  images: Asset[]
  mic: { on: boolean; listening: boolean; supported: boolean; error: string | null; toggle: () => void }
  onUndo: () => void
  /** Drop an image on a slot (drag) — slot index comes from the element under the pointer. */
  onDrop: (assetId: string, aspect: number, slot: number) => void
  onEnd: () => void
  /** Remember each image's aspect ratio once its thumbnail loads. */
  onImageAspect: (assetId: string, aspect: number) => void
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

export default function Sidebar({ title, images, mic, onUndo, onDrop, onEnd, onImageAspect }: Props) {
  const s = useSessionStore()
  const settings = useSettings()
  const locked = s.pendingAnnotationId !== null
  const [ghost, setGhost] = useState<{ src: string; x: number; y: number } | null>(null)
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
      // Tap: select, then tap a slot on the board.
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
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-title">{title}</div>
        <button className={mic.on ? 'primary' : ''} onClick={mic.toggle} disabled={!mic.supported}>
          {!mic.supported ? 'Mic not supported here' : mic.on ? (mic.listening ? '● Listening' : 'Starting mic…') : 'Turn mic on'}
        </button>
        {mic.error && <div className="hint warn">Mic: {mic.error}</div>}
      </div>

      <div className="sidebar-section">
        <div className="segmented">
          <button className={s.mode === 'ink' ? 'selected' : ''} onClick={() => s.setMode('ink')}>
            ✎ Ink
          </button>
          <button className={s.mode === 'smart' ? 'selected' : ''} onClick={() => s.setMode('smart')}>
            ◌ Smart
          </button>
        </div>
        {s.mode === 'ink' ? (
          <>
            <div className="swatches">
              {INK_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch${s.inkColor === c ? ' selected' : ''}`}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                  onClick={() => s.setInkColor(c)}
                />
              ))}
            </div>
            <div className="widths">
              {INK_WIDTHS.map((w) => (
                <button key={w.value} className={s.inkWidth === w.value ? 'selected' : ''} onClick={() => s.setInkWidth(w.value)}>
                  <span className="width-dot" style={{ width: w.value * 1200, height: w.value * 1200 }} />
                  {w.label}
                </button>
              ))}
            </div>
            <button onClick={onUndo}>↶ Undo</button>
          </>
        ) : (
          <div className="hint">
            {locked ? 'Talk about what you circled, then press ✓ to save or ✗ to cancel.' : 'Draw a loop around part of an image, then talk about it.'}
          </div>
        )}
      </div>

      <div className="sidebar-section sidebar-images">
        <div className="sidebar-label">Images</div>
        {locked && <div className="hint warn">Press ✓ or ✗ on the open annotation before adding an image.</div>}
        {!locked && s.selectedAssetId && <div className="hint">Now tap a spot on the board.</div>}
        {images.length === 0 && <div className="hint">No images were uploaded for this lecture.</div>}
        {images.map((a) => (
          <button
            key={a.id}
            className={`thumb${s.selectedAssetId === a.id ? ' selected' : ''}`}
            disabled={locked}
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
            <span>{a.label || a.file_name || 'Image'}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-section">
        <div className="sidebar-label">Settings</div>
        <button onClick={() => settings.setSidebarSide(settings.sidebarSide === 'left' ? 'right' : 'left')}>
          Move sidebar {settings.sidebarSide === 'left' ? 'right →' : '← left'}
        </button>
        <button onClick={() => settings.setFingerDraws(!settings.fingerDraws)}>
          Finger draws: {settings.fingerDraws ? 'On' : 'Off (pencil only)'}
        </button>
      </div>

      <div className="sidebar-section sidebar-end">
        <button className="danger" onClick={onEnd}>
          End session
        </button>
      </div>

      {ghost && (
        <img className="drag-ghost" src={ghost.src} alt="" style={{ left: ghost.x, top: ghost.y }} draggable={false} />
      )}
    </aside>
  )
}
