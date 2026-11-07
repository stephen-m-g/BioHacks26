// Class UI: the colored dot (one color per class, equal slices for several), the "Classes…" picker
// for a lecture or session, and the "Edit classes" dialog (rename, recolor, add, delete).
import { useEffect, useState } from 'react'
import { CLASS_COLORS, COLOR_NAMES, nextClassColor } from '../lib/classes'
import type { ClassGroup } from '../types'
import ConfirmDialog from './ConfirmDialog'

/** Point on a circle, angle in degrees with 0 = 12 o'clock, clockwise. */
function polar(c: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180
  return [c + r * Math.cos(rad), c + r * Math.sin(rad)]
}

/**
 * Colored circle for a lecture/session's classes. One class: a solid circle. Several: equal slices.
 * None: a dashed outline. Always labelled with the class names (color alone isn't accessible).
 */
export function ClassDot({ classes, size = 44 }: { classes: ClassGroup[]; size?: number }) {
  const c = size / 2
  const r = c - 1
  const label = classes.length ? `Class${classes.length > 1 ? 'es' : ''}: ${classes.map((x) => x.name).join(', ')}` : 'No class'
  return (
    <svg className="class-dot" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <title>{label}</title>
      {classes.length === 0 && (
        <circle cx={c} cy={c} r={r - 1} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="4 4" opacity={0.45} />
      )}
      {classes.length === 1 && <circle cx={c} cy={c} r={r} fill={classes[0].color} />}
      {classes.length > 1 &&
        classes.map((cls, i) => {
          const step = 360 / classes.length
          const [x1, y1] = polar(c, r, i * step)
          const [x2, y2] = polar(c, r, (i + 1) * step)
          const large = step > 180 ? 1 : 0
          return (
            <path
              key={cls.id}
              d={`M ${c} ${c} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`}
              fill={cls.color}
              stroke="var(--d-card, #fff)"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          )
        })}
    </svg>
  )
}

/** "Classes…" for one lecture or session: tick the classes it belongs to, or add a new one. */
export function ClassPickerDialog({
  open,
  title,
  classes,
  selected,
  onSave,
  onCancel,
}: {
  open: boolean
  title: string
  classes: ClassGroup[]
  selected: string[]
  /** Called with the chosen class ids and any brand-new classes (name + color) to create first. */
  onSave: (classIds: string[], newClasses: { name: string; color: string }[]) => void
  onCancel: () => void
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set(selected))
  const [drafts, setDrafts] = useState<{ key: string; name: string; color: string }[]>([])
  const [newName, setNewName] = useState('')

  useEffect(() => {
    if (open) {
      setPicked(new Set(selected))
      setDrafts([])
      setNewName('')
    }
  }, [open, selected])

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const addDraft = () => {
    const name = newName.trim()
    if (!name) return
    const taken = [...classes, ...drafts.map((d) => ({ color: d.color }) as ClassGroup)]
    setDrafts((d) => [...d, { key: `new-${d.length}`, name, color: nextClassColor(taken) }])
    setNewName('')
  }

  return (
    <ConfirmDialog
      open={open}
      title={`Classes for "${title}"`}
      confirmLabel="Save"
      onCancel={onCancel}
      onConfirm={() => onSave([...picked], drafts.map(({ name, color }) => ({ name, color })))}
    >
      <div className="class-options" role="group" aria-label="Classes">
        {classes.length === 0 && drafts.length === 0 && <p className="class-empty">No classes yet. Add one below.</p>}
        {classes.map((cls) => (
          <label key={cls.id} className="class-option">
            <input type="checkbox" checked={picked.has(cls.id)} onChange={() => toggle(cls.id)} />
            <ClassDot classes={[cls]} size={22} />
            <span>{cls.name}</span>
          </label>
        ))}
        {drafts.map((d) => (
          <label key={d.key} className="class-option">
            <input type="checkbox" checked readOnly aria-label={`${d.name} (new, will be added)`} />
            <ClassDot classes={[{ id: d.key, name: d.name, color: d.color, created_at: '' }]} size={22} />
            <span>
              {d.name} <em className="class-new-tag">new</em>
            </span>
          </label>
        ))}
      </div>
      <div className="class-add-row">
        <input
          value={newName}
          placeholder="New class, e.g. Period 2"
          aria-label="New class name"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addDraft()
            }
          }}
        />
        <button type="button" onClick={addDraft} disabled={!newName.trim()}>
          Add
        </button>
      </div>
    </ConfirmDialog>
  )
}

type Row = { id: string | null; key: string; name: string; color: string; deleted: boolean }

export interface ClassEdits {
  updates: { id: string; name: string; color: string }[]
  creates: { name: string; color: string }[]
  deletes: string[]
}

/** "Edit classes": rename, recolor, add and delete classes. Changes apply on Save. */
export function ManageClassesDialog({
  open,
  classes,
  onSave,
  onCancel,
}: {
  open: boolean
  classes: ClassGroup[]
  onSave: (edits: ClassEdits) => void
  onCancel: () => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [paletteFor, setPaletteFor] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setRows(classes.map((c) => ({ id: c.id, key: c.id, name: c.name, color: c.color, deleted: false })))
      setPaletteFor(null)
    }
  }, [open, classes])

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  const addRow = () => {
    const live = rows.filter((r) => !r.deleted).map((r) => ({ color: r.color }) as ClassGroup)
    const key = `new-${rows.length}-${Date.now()}`
    setRows((rs) => [...rs, { id: null, key, name: '', color: nextClassColor(live), deleted: false }])
  }

  const save = () => {
    const edits: ClassEdits = { updates: [], creates: [], deletes: [] }
    for (const r of rows) {
      const name = r.name.trim()
      if (r.id === null) {
        if (!r.deleted && name) edits.creates.push({ name, color: r.color })
      } else if (r.deleted) {
        edits.deletes.push(r.id)
      } else {
        const orig = classes.find((c) => c.id === r.id)
        if (orig && (orig.name !== (name || orig.name) || orig.color !== r.color)) {
          edits.updates.push({ id: r.id, name: name || orig.name, color: r.color })
        }
      }
    }
    onSave(edits)
  }

  return (
    <ConfirmDialog open={open} title="Edit classes" confirmLabel="Save" onCancel={onCancel} onConfirm={save}>
      <div className="class-manage">
        {rows.length === 0 && <p className="class-empty">No classes yet.</p>}
        {rows.map((r) => (
          <div key={r.key} className={`class-manage-row${r.deleted ? ' deleted' : ''}`}>
            <div className="class-manage-main">
              <button
                type="button"
                className="class-color-btn"
                aria-label={`Color: ${COLOR_NAMES[r.color] ?? r.color}. Change color`}
                aria-expanded={paletteFor === r.key}
                disabled={r.deleted}
                onClick={() => setPaletteFor(paletteFor === r.key ? null : r.key)}
              >
                <span className="class-swatch" style={{ background: r.color }} />
              </button>
              <input
                value={r.name}
                placeholder="Class name"
                aria-label="Class name"
                disabled={r.deleted}
                onChange={(e) => patch(r.key, { name: e.target.value })}
              />
              <button type="button" className="class-delete-btn" onClick={() => patch(r.key, { deleted: !r.deleted })}>
                {r.deleted ? 'Undo' : 'Delete'}
              </button>
            </div>
            {paletteFor === r.key && !r.deleted && (
              <div className="class-palette" role="radiogroup" aria-label="Class color">
                {CLASS_COLORS.map((col) => (
                  <button
                    key={col}
                    type="button"
                    role="radio"
                    aria-checked={r.color === col}
                    aria-label={COLOR_NAMES[col]}
                    className={`class-palette-btn${r.color === col ? ' on' : ''}`}
                    onClick={() => {
                      patch(r.key, { color: col })
                      setPaletteFor(null)
                    }}
                  >
                    <span className="class-swatch" style={{ background: col }} />
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        <button type="button" className="class-add-btn" onClick={addRow}>
          + Add class
        </button>
        <p className="class-note">Deleting a class only removes the grouping. Its lectures and sessions stay.</p>
      </div>
    </ConfirmDialog>
  )
}
