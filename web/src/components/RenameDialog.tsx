// "Rename" for a recorded session (or anything with a title). Same look as the other dialogs:
// a labeled field (dialog-field) with Cancel / Save. Enter saves; an empty or unchanged name does nothing.
import { useEffect, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'

export default function RenameDialog({
  open,
  heading = 'Rename session',
  label = 'Session name',
  current,
  onCancel,
  onSave,
}: {
  open: boolean
  heading?: string
  label?: string
  current: string
  onCancel: () => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState(current)

  useEffect(() => {
    if (open) setName(current)
  }, [open, current])

  const submit = () => {
    const next = name.trim()
    if (!next || next === current) return onCancel()
    onSave(next)
  }

  return (
    <ConfirmDialog open={open} title={heading} confirmLabel="Save" onCancel={onCancel} onConfirm={submit}>
      <label className="dialog-field">
        <span className="dialog-field-label">{label}</span>
        <input
          value={name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
      </label>
    </ConfirmDialog>
  )
}
