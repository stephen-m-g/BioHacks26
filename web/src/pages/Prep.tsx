// P4 owns this page. Chat-style prep: upload images / PDFs / .txt or type text. Each item gets an
// AI acknowledgement from /describe. Images go to the image bank; everything else is session context.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import { api } from '../lib/api'
import { assetUrl, newId } from '../lib/assets'
import { startSession } from '../lib/lectures'
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
  const navigate = useNavigate()
  const [lecture, setLecture] = useState<Lecture | null>(null)
  const [title, setTitle] = useState('')
  const [items, setItems] = useState<Asset[]>([])
  const [ai, setAi] = useState<Record<string, AiState>>({})
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toRemove, setToRemove] = useState<Asset | null>(null)
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
    describe(row.id)
  }

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

  const removeItem = async (asset: Asset) => {
    setToRemove(null)
    setItems((list) => list.filter((a) => a.id !== asset.id))
    if (asset.storage_path) await supabase.storage.from('assets').remove([asset.storage_path])
    const { error } = await supabase.from('assets').delete().eq('id', asset.id)
    if (error) setError(error.message)
  }

  const saveTitle = async () => {
    const t = title.trim() || 'Untitled lecture'
    if (t === lecture?.title) return
    const { error } = await supabase.from('lectures').update({ title: t }).eq('id', lectureId)
    if (error) setError(error.message)
    else setLecture((l) => (l ? { ...l, title: t } : l))
  }

  const start = async () => {
    try {
      await saveTitle()
      navigate(`/teach/${await startSession(lectureId, title.trim() || 'Untitled lecture')}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const imageCount = items.filter((a) => a.kind === 'image').length

  return (
    <div className="prep">
      <header className="prep-header">
        <Link className="btn" to="/">
          ← Dashboard
        </Link>
        <input
          className="prep-title"
          value={title}
          placeholder="Lecture title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <button className="primary" onClick={start} disabled={!lecture}>
          Start session
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
        It's deleted from this lecture.
        {toRemove?.kind === 'image' && ' Past sessions that placed this image on the board will show a blank image.'}
      </ConfirmDialog>
    </div>
  )
}
