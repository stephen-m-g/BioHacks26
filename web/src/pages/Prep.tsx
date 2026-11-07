// P4 owns this page. Chat-style prep: upload images / PDFs / .txt or type text. Each item gets an
// AI acknowledgement from /describe. Images go to the image bank; everything else is session context.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import { IconArrowLeft, IconArrowUp, IconFile, IconImage, IconPaperclip, IconPlay, IconSparkle, IconX } from '../components/DashIcons'
import { api } from '../lib/api'
import { assetUrl, newId } from '../lib/assets'
import { startSession } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { Asset, AssetKind, Lecture } from '../types'
import '../styles/p4.css'
import '../styles/prep.css'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

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
  const noteCount = items.length - imageCount

  return (
    <div className="p4 pp">
      <header className="p4-top">
        <Link className="p4-btn" to="/">
          <IconArrowLeft /> Lectures
        </Link>
        <div className="p4-spacer" />
        <button className="p4-btn solid" onClick={start} disabled={!lecture}>
          <IconPlay /> Start session
        </button>
      </header>

      <div className="pp-scroll">
        <div className="pp-inner">
          <input
            className="pp-title"
            aria-label="Lecture title"
            value={title}
            placeholder="Lecture title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <p className="p4-sub">
            <span>
              <IconImage /> {plural(imageCount, 'image')}
            </span>
            <span>
              <IconFile /> {plural(noteCount, 'note')}
            </span>
          </p>

          <section className="p4-section" aria-labelledby="materials-heading">
            <h2 id="materials-heading" className="p4-label">
              Materials
            </h2>
            <div className="pp-feed">
              <div className="pp-ai">
                <div className="pp-ai-avatar" aria-hidden="true">
                  <IconSparkle />
                </div>
                <div className="pp-ai-body">
                  <p className="pp-ai-title">Add what you'll teach with</p>
                  <p className="pp-ai-desc">
                    Diagrams and photos go to your image bank for the board. PDFs, text files and typed notes become context for
                    cleaning up your speech and writing the study notes.
                  </p>
                </div>
              </div>

              {items.map((a) => (
                <div key={a.id} className="pp-exchange">
                  <div className={`pp-user${a.kind === 'image' ? ' has-image' : ''}`}>
                    {a.kind === 'image' && <img src={assetUrl(a)} alt={a.label ?? a.file_name ?? 'Uploaded image'} />}
                    {a.kind === 'pdf' && (
                      <div className="pp-file">
                        <IconFile /> {a.file_name}
                      </div>
                    )}
                    {a.kind === 'text' && (
                      <>
                        {a.file_name && (
                          <div className="pp-file">
                            <IconFile /> {a.file_name}
                          </div>
                        )}
                        <div className="pp-text">
                          {(a.text_content ?? '').slice(0, 600)}
                          {(a.text_content?.length ?? 0) > 600 && '…'}
                        </div>
                      </>
                    )}
                    <button
                      className="p4-btn icon-only pp-remove"
                      aria-label={`Remove ${a.file_name ?? a.label ?? 'this item'}`}
                      onClick={() => setToRemove(a)}
                    >
                      <IconX />
                    </button>
                  </div>
                  <div className="pp-ai">
                    <div className="pp-ai-avatar" aria-hidden="true">
                      <IconSparkle />
                    </div>
                    <div className="pp-ai-body">
                      {ai[a.id] === 'reading' ? (
                        <p className="pp-ai-desc reading">Reading…</p>
                      ) : a.label ? (
                        <>
                          <p className="pp-ai-title">{a.label}</p>
                          {a.description && <p className="pp-ai-desc">{a.description}</p>}
                          {a.key_terms && a.key_terms.length > 0 && (
                            <div className="p4-chips">
                              {a.key_terms.map((t) => (
                                <span key={t} className="p4-chip">
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="pp-ai-desc">{ai[a.id] === 'error' ? 'Saved. A description isn’t available right now.' : 'Saved.'}</p>
                      )}
                      <p className="pp-ai-foot">{a.kind === 'image' ? 'Added to image bank' : 'Added to context'}</p>
                    </div>
                  </div>
                </div>
              ))}
              <div ref={feedEnd} />
            </div>
          </section>
        </div>
      </div>

      <footer className="pp-composer-wrap">
        {error && (
          <div className="p4-notice warn" role="alert">
            <span>{error}</span>
            <button className="p4-btn" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        <div className="pp-composer">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/*,application/pdf,.pdf,.txt,text/plain"
            hidden
            onChange={(e) => onFiles(e.target.files)}
          />
          <button className="p4-btn icon-only" onClick={() => fileInput.current?.click()} aria-label="Attach images, PDFs or text files">
            <IconPaperclip />
          </button>
          <textarea
            className="pp-textarea"
            aria-label="Lecture notes"
            value={draft}
            placeholder="Type or paste lecture notes…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                sendText()
              }
            }}
            rows={1}
          />
          <button className="p4-btn solid" onClick={sendText} disabled={!draft.trim()}>
            <IconArrowUp /> Send
          </button>
        </div>
        <p className="pp-hint">Images go to the image bank. Everything else becomes context.</p>
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
