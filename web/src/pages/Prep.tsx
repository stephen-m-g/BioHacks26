// P4 owns this page. Chat-style prep: upload images / PDFs / .txt or type text. Each item gets an
// AI acknowledgement from /describe. Images go to the image bank; everything else is session context.
//
// Save / discard: "Save" applies the title and any removals and returns to the dashboard.
// "<- Dashboard" discards this visit's changes. Uploads must exist in the database for /describe to
// read them, so they are written immediately and tracked; discarding deletes them again (and deletes
// the lecture itself if it was created for this visit, i.e. opened with ?new=1).
// Class membership follows the same rule (applied on Save). A brand-new class is created right away,
// since classes are shared across lectures rather than part of this one.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import { IconArrowLeft, IconArrowUp, IconFile, IconImage, IconPaperclip, IconPlus, IconSparkle, IconX } from '../components/DashIcons'
import { api } from '../lib/api'
import { assetUrl, newId } from '../lib/assets'
import { createClass, listClasses, nextClassColor, setLectureClasses } from '../lib/classes'
import { deleteLecture } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { Asset, AssetKind, ClassGroup, Lecture } from '../types'
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
  /** All classes, this lecture's saved class ids, and the current (unsaved) selection. */
  const [classes, setClasses] = useState<ClassGroup[]>([])
  const [savedClassIds, setSavedClassIds] = useState<string[]>([])
  const [classIds, setClassIds] = useState<string[]>([])
  /** Classes tables missing (migration not run): hide the row instead of failing the page. */
  const [classesAvailable, setClassesAvailable] = useState(true)
  const [newClassName, setNewClassName] = useState<string | null>(null)
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
    Promise.all([listClasses(), supabase.from('lecture_classes').select('class_id').eq('lecture_id', lectureId)])
      .then(([all, links]) => {
        if (cancelled) return
        if (links.error) throw links.error
        const ids = (links.data ?? []).map((r) => r.class_id as string)
        setClasses(all)
        setSavedClassIds(ids)
        setClassIds(ids)
      })
      .catch(() => !cancelled && setClassesAvailable(false))
    return () => {
      cancelled = true
    }
  }, [lectureId])

  // Follow new items as they're added, but not on first load (that would scroll the title out of view).
  const initialCount = useRef<number | null>(null)
  useEffect(() => {
    if (!lecture) return
    if (initialCount.current === null) {
      initialCount.current = items.length
      return
    }
    if (items.length > initialCount.current) feedEnd.current?.scrollIntoView({ behavior: 'smooth' })
    initialCount.current = items.length
  }, [items.length, lecture])

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
  const classesChanged =
    classIds.length !== savedClassIds.length || classIds.some((id) => !savedClassIds.includes(id))
  /** Something would be lost by leaving without saving. */
  const hasUnsavedWork = added.length > 0 || removed.length > 0 || (!isNew && (titleChanged || classesChanged))

  const toggleClass = (id: string) =>
    setClassIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const addClass = async () => {
    const name = (newClassName ?? '').trim()
    if (!name) return
    try {
      const cls = await createClass(name, nextClassColor(classes))
      setClasses((list) => [...list, cls])
      setClassIds((ids) => [...ids, cls.id])
      setNewClassName(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

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
      if (classesAvailable && classesChanged) await setLectureClasses(lectureId, classIds)
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
  const noteCount = items.length - imageCount

  return (
    <div className="p4 pp">
      <header className="p4-top">
        <button className="p4-btn" onClick={back} disabled={busy}>
          <IconArrowLeft /> Lectures
        </button>
        <div className="p4-spacer" />
        <button className="p4-btn solid" onClick={save} disabled={!lecture || busy}>
          {busy ? 'Saving…' : 'Save'}
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

          {classesAvailable && (
            <section className="p4-section pp-classes" aria-labelledby="classes-heading">
              <h2 id="classes-heading" className="p4-label">
                Classes
              </h2>
              <div className="pp-class-chips" role="group" aria-label="Classes this lecture belongs to">
                {classes.map((c) => {
                  const on = classIds.includes(c.id)
                  return (
                    <button key={c.id} className={`pp-class-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleClass(c.id)}>
                      <span className="pp-class-dot" style={{ background: c.color }} aria-hidden="true" />
                      {c.name}
                    </button>
                  )
                })}
                {newClassName === null ? (
                  <button className="pp-class-chip add" onClick={() => setNewClassName('')}>
                    <IconPlus /> New class
                  </button>
                ) : (
                  <span className="pp-class-new">
                    <input
                      autoFocus
                      value={newClassName}
                      placeholder="e.g. Period 2"
                      aria-label="New class name"
                      onChange={(e) => setNewClassName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addClass()
                        if (e.key === 'Escape') setNewClassName(null)
                      }}
                    />
                    <button className="p4-btn solid" onClick={addClass} disabled={!newClassName.trim()}>
                      Add
                    </button>
                    <button className="p4-btn" onClick={() => setNewClassName(null)}>
                      Cancel
                    </button>
                  </span>
                )}
              </div>
            </section>
          )}

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
          : 'Changes since you last saved will be lost: new uploads are deleted, removed items come back, and the title and classes are restored.'}
      </ConfirmDialog>
    </div>
  )
}
