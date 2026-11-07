// P4 owns this page. Chat-style prep: upload images / PDFs / .txt or type text. Each item gets an
// AI acknowledgement from /describe. Images go to the image bank; everything else is session context.
//
// Save / discard: "Save" applies the title and any removals and returns to the dashboard.
// "<- Dashboard" discards this visit's changes. Uploads must exist in the database for /describe to
// read them, so they are written immediately and tracked; discarding deletes them again (and deletes
// the lecture itself if it was created for this visit, i.e. opened with ?new=1).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import { api } from '../lib/api'
import { assetUrl, newId } from '../lib/assets'
import { deleteLecture } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { Asset, AssetKind, Lecture } from '../types'

type AiState = 'reading' | 'error' | 'done'

function kindOf(file: File): AssetKind | null {
  const name = file.name.toLowerCase()
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (file.type === 'text/plain' || name.endsWith('.txt') || name.endsWith('.md')) return 'text'
  return null
}

export default function Prep() {
  const { lectureId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const isNew = searchParams.get('new') === '1'
  const navigate = useNavigate()
  const [lecture, setLecture] = useState<Lecture | null>(null)
  const [title, setTitle] = useState('')
  const [items, setItems] = useState<Asset[]>([])
  const [ai, setAi] = useState<Record<string, AiState>>({})
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toRemove, setToRemove] = useState<Asset | null>(null)
  /** Assets uploaded during this visit (deleted again on discard). */
  const [added, setAdded] = useState<Asset[]>([])
  /** Previously saved assets the teacher removed (deleted on save). */
  const [removed, setRemoved] = useState<Asset[]>([])
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const feedEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from('lectures').select('*').eq('id', lectureId).maybeSingle(),
      supabase.from('assets').select('*').eq('lecture_id', lectureId).order('created_at'),
    ]).then(([l, a]) => {
      if (cancelled) return
      if (l.error || !l.data) setError(l.error?.message ?? 'Lecture not found')
      setLecture(l.data as Lecture | null)
      setTitle((l.data as Lecture | null)?.title ?? '')
      setItems((a.data as Asset[]) ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [lectureId])

  useEffect(() => {
    feedEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items.length])

  const describe = useCallback((id: string) => {
    setAi((s) => ({ ...s, [id]: 'reading' }))
    api
      .describeAsset(id)
      .then((r) => {
        setItems((list) => list.map((a) => (a.id === id ? { ...a, ...r } : a)))
        setAi((s) => ({ ...s, [id]: 'done' }))
      })
      .catch(() => setAi((s) => ({ ...s, [id]: 'error' })))
  }, [])

  const addAsset = async (row: Partial<Asset> & { id: string; kind: AssetKind }) => {
    const { data, error } = await supabase.from('assets').insert({ lecture_id: lectureId, ...row }).select().single()
    if (error) throw error
    setItems((list) => [...list, data as Asset])
    setAdded((list) => [...list, data as Asset])
    describe(row.id)
  }

  const deleteAssets = async (assets: Asset[]) => {
    if (assets.length === 0) return
    const paths = assets.map((a) => a.storage_path).filter((p): p is string => !!p)
    if (paths.length) await supabase.storage.from('assets').remove(paths)
    const { error } = await supabase.from('assets').delete().in('id', assets.map((a) => a.id))
    if (error) throw error
  }

  const savedTitle = lecture?.title ?? ''
  const titleChanged = (title.trim() || 'Untitled lecture') !== savedTitle
  /** Something would be lost by leaving without saving. */
  const hasUnsavedWork = added.length > 0 || removed.length > 0 || (!isNew && titleChanged)

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (!hasUnsavedWork && !isNew) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasUnsavedWork, isNew])

  const sendText = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    try {
      await addAsset({ id: newId(), kind: 'text', text_content: text })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDraft(text)
    }
  }

  const onFiles = async (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      const kind = kindOf(file)
      if (!kind) {
        setError(`${file.name}: only images, PDFs and .txt files are supported.`)
        continue
      }
      const id = newId()
      try {
        if (kind === 'text') {
          await addAsset({ id, kind, text_content: await file.text(), file_name: file.name })
        } else {
          const ext = file.name.split('.').pop()?.toLowerCase() || (kind === 'pdf' ? 'pdf' : 'png')
          const path = `${lectureId}/${id}.${ext}`
          const up = await supabase.storage.from('assets').upload(path, file, { contentType: file.type || undefined })
          if (up.error) throw up.error
          await addAsset({ id, kind, storage_path: path, file_name: file.name })
        }
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (fileInput.current) fileInput.current.value = ''
  }

  /** Hide an item now; an upload from this visit is deleted right away, a saved one on Save. */
  const removeItem = (asset: Asset) => {
    setToRemove(null)
    setItems((list) => list.filter((x) => x.id !== asset.id))
    if (added.some((x) => x.id === asset.id)) {
      setAdded((list) => list.filter((x) => x.id !== asset.id))
      deleteAssets([asset]).catch((e) => setError(e instanceof Error ? e.message : String(e)))
    } else {
      setRemoved((list) => [...list, asset])
    }
  }

  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e))
    setBusy(false)
  }

  /** Apply the title and removals, then go back to the dashboard. */
  const save = async () => {
    setBusy(true)
    try {
      if (titleChanged) {
        const { error } = await supabase
          .from('lectures')
          .update({ title: title.trim() || 'Untitled lecture' })
          .eq('id', lectureId)
        if (error) throw error
      }
      await deleteAssets(removed)
      navigate('/')
    } catch (e) {
      fail(e)
    }
  }

  /** Leave without saving: undo this visit's uploads (or the whole new lecture). */
  const discard = async () => {
    setConfirmDiscard(false)
    setBusy(true)
    try {
      if (isNew) await deleteLecture(lectureId)
      else await deleteAssets(added)
      navigate('/')
    } catch (e) {
      fail(e)
    }
  }

  const back = () => {
    if (hasUnsavedWork) setConfirmDiscard(true)
    else discard()
  }

  const imageCount = items.filter((a) => a.kind === 'image').length

  return (
    <div className="prep">
      <header className="prep-header">
        <button onClick={back} disabled={busy}>
          ← Dashboard
        </button>
        <input
          className="prep-title"
          value={title}
          placeholder="Lecture title"
          aria-label="Lecture title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <button className="primary" onClick={save} disabled={!lecture || busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </header>

      <div className="prep-feed">
        <div className="bubble ai">
          Add what you'll teach with: diagrams and photos (they go to your image bank for the board), PDFs, text files, or just type
          your lecture notes. Everything that isn't an image is used as context for cleaning up your speech and writing the notes.
        </div>
        {items.map((a) => (
          <div key={a.id} className="exchange">
            <div className="bubble user">
              {a.kind === 'image' && <img src={assetUrl(a)} alt={a.file_name ?? ''} className="bubble-image" />}
              {a.kind === 'pdf' && <div className="file-chip">📄 {a.file_name}</div>}
              {a.kind === 'text' && (
                <div className="bubble-text">
                  {a.file_name && <div className="file-chip">📝 {a.file_name}</div>}
                  {(a.text_content ?? '').slice(0, 600)}
                  {(a.text_content?.length ?? 0) > 600 && '…'}
                </div>
              )}
              <button className="bubble-remove" aria-label="Remove" onClick={() => setToRemove(a)}>
                ✕
              </button>
            </div>
            <div className="bubble ai">
              {ai[a.id] === 'reading' ? (
                <span className="muted">Reading…</span>
              ) : a.label ? (
                <>
                  <strong>{a.label}</strong>
                  {a.description && <p>{a.description}</p>}
                  {a.key_terms && a.key_terms.length > 0 && (
                    <div className="chips">
                      {a.key_terms.map((t) => (
                        <span key={t} className="chip">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <span>{ai[a.id] === 'error' ? "Saved. (I couldn't describe it right now.)" : 'Saved.'}</span>
              )}
              <div className="muted small">{a.kind === 'image' ? 'Added to the image bank.' : 'Added to session context.'}</div>
            </div>
          </div>
        ))}
        <div ref={feedEnd} />
      </div>

      {error && (
        <div className="notice warn prep-error" onClick={() => setError(null)}>
          {error} (tap to dismiss)
        </div>
      )}

      <footer className="prep-composer">
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/*,application/pdf,.pdf,.txt,text/plain"
          hidden
          onChange={(e) => onFiles(e.target.files)}
        />
        <button onClick={() => fileInput.current?.click()} aria-label="Attach files">
          📎 Attach
        </button>
        <textarea
          value={draft}
          placeholder="Type or paste lecture notes…"
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
        />
        <button className="primary" onClick={sendText} disabled={!draft.trim()}>
          Send
        </button>
        <span className="muted small prep-count">{imageCount} images</span>
      </footer>

      <ConfirmDialog
        open={toRemove !== null}
        title="Remove this item?"
        confirmLabel="Remove"
        danger
        onCancel={() => setToRemove(null)}
        onConfirm={() => toRemove && removeItem(toRemove)}
      >
        It's removed when you press Save.
        {toRemove?.kind === 'image' && ' Past sessions that placed this image on the board will then show a blank image.'}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard changes?"
        confirmLabel="Discard"
        danger
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={discard}
      >
        {isNew
          ? "This lecture hasn't been saved. It and everything you added will be deleted."
          : 'Changes since you last saved will be lost: new uploads are deleted, removed items come back and the title is restored.'}
      </ConfirmDialog>
    </div>
  )
}
