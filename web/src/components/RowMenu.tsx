// Floating menus for the P4 list pages: the "⋯" button on each row and the sort button in the list
// header share one implementation. The menu is rendered at the page root with fixed positioning so a
// scrolling list can't clip it, and opens upward when there's no room below.
// Tap to open, tap outside / scroll / Escape to close (no long-press).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconDots, IconSort } from './DashIcons'

export interface RowMenuItem {
  label: string
  danger?: boolean
  /** Set for choice menus (sort): shows a check on the chosen item. */
  checked?: boolean
  onClick: () => void
}

const WIDTH = 210
const ITEM_HEIGHT = 60
const PADDING = 6
const GAP = 4
const EDGE = 8

/** A button (the visible pill is `children`) that opens a floating menu of `items`. */
export function MenuButton({
  ariaLabel,
  pillClassName,
  items,
  disabled,
  children,
}: {
  ariaLabel: string
  pillClassName: string
  items: RowMenuItem[]
  disabled?: boolean
  children: ReactNode
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const isChoice = items.some((i) => i.checked !== undefined)

  const open = () => {
    const r = button.current?.getBoundingClientRect()
    if (!r) return
    const height = items.length * ITEM_HEIGHT + PADDING * 2 + 2
    const fitsBelow = r.bottom + GAP + height <= window.innerHeight - EDGE
    const top = fitsBelow ? r.bottom + GAP : Math.max(EDGE, r.top - GAP - height)
    const left = Math.min(Math.max(EDGE, r.right - WIDTH), window.innerWidth - WIDTH - EDGE)
    setPos({ left, top })
  }

  useEffect(() => {
    if (!pos) return
    const close = () => setPos(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [pos])

  return (
    <>
      <button
        ref={button}
        type="button"
        className="lp-tap"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={pos !== null}
        disabled={disabled}
        onClick={() => (pos ? setPos(null) : open())}
      >
        <span className={pillClassName}>{children}</span>
      </button>
      {pos &&
        createPortal(
          <>
            <div className="lp-menu-backdrop" onClick={() => setPos(null)} />
            <div className="lp-menu" role="menu" style={{ left: pos.left, top: pos.top, width: WIDTH }}>
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role={isChoice ? 'menuitemradio' : 'menuitem'}
                  aria-checked={isChoice ? !!item.checked : undefined}
                  className={`lp-menu-item${item.danger ? ' danger' : ''}`}
                  onClick={() => {
                    setPos(null)
                    item.onClick()
                  }}
                >
                  {item.label}
                  {item.checked && <IconCheck className="lp-menu-check" />}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  )
}

/** "⋯" for a list row. */
export default function RowMenu({ label, items, disabled }: { label: string; items: RowMenuItem[]; disabled?: boolean }) {
  return (
    <MenuButton ariaLabel={`More actions for ${label}`} pillClassName="lp-pill round" items={items} disabled={disabled}>
      <IconDots />
    </MenuButton>
  )
}

// ---------- sorting ----------

export type SortOrder = 'alpha' | 'newest'

const SORT_LABELS: Record<SortOrder, string> = { alpha: 'Alphabetical', newest: 'Newest first' }
const SORT_OPTIONS: SortOrder[] = ['alpha', 'newest']

/** The list's sort order, remembered per page on this device. Defaults to newest first. */
export function useSortOrder(page: string) {
  const key = `list-sort:${page}`
  const read = (): SortOrder => {
    try {
      const v = localStorage.getItem(key)
      return v === 'alpha' || v === 'newest' ? v : 'newest'
    } catch {
      return 'newest'
    }
  }
  const [order, setOrderState] = useState<SortOrder>(read)
  // The same component serves /lectures and /archive, so re-read when the page changes.
  useEffect(() => {
    setOrderState(read())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const setOrder = useCallback(
    (o: SortOrder) => {
      setOrderState(o)
      try {
        localStorage.setItem(key, o)
      } catch {
        // private mode / blocked storage: the choice just isn't remembered
      }
    },
    [key],
  )
  return { order, setOrder }
}

/** Sorts a copy: alphabetical (case-insensitive, "Unit 2" before "Unit 10") or newest first by date. */
export function sortRows<T>(rows: T[], order: SortOrder, title: (r: T) => string, date: (r: T) => string): T[] {
  const copy = [...rows]
  if (order === 'alpha') copy.sort((a, b) => title(a).localeCompare(title(b), undefined, { sensitivity: 'base', numeric: true }))
  else copy.sort((a, b) => date(b).localeCompare(date(a)))
  return copy
}

/** Sort button for a list header: same look and menu as "⋯", showing the current order. */
export function SortMenu({ order, onChange }: { order: SortOrder; onChange: (o: SortOrder) => void }) {
  return (
    <MenuButton
      ariaLabel={`Sort: ${SORT_LABELS[order]}. Change sort order`}
      pillClassName="lp-pill sort"
      items={SORT_OPTIONS.map((o) => ({ label: SORT_LABELS[o], checked: o === order, onClick: () => onChange(o) }))}
    >
      <IconSort /> {SORT_LABELS[order]}
    </MenuButton>
  )
}
