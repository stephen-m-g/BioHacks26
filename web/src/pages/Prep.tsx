// P4 owns this page. Chat-style prep: upload images / PDFs / .txt or type text. Each item gets an
// AI acknowledgement from /describe. Images go to the image bank; everything else is session context.
//
// Save / discard: "Save lecture" (header, or Save in the back arrow's dialog) applies the title and any
// removals and returns to the dashboard. A new lecture can't be saved until it has a material.
// "Don't save" discards this visit's changes. Uploads must exist in the database for /describe to
// read them, so they are written immediately and tracked; discarding deletes them again (and deletes
// the lecture itself if it was created for this visit, i.e. opened with ?new=1).
// Class membership follows the same rule (applied on Save). A brand-new class is created right away,
// since classes are shared across lectures rather than part of this one.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import { IconArrowLeft, IconArrowUp, IconFile, IconImage, IconPaperclip, IconPlus, IconSparkle, IconX } from '../components/DashIcons'
import { api, apiErrorMessage } from '../lib/api'
import { assetUrl, newId } from '../lib/assets'
import { createClass, listClasses, nextClassColor, setLectureClasses } from '../lib/classes'
import { deleteLecture } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { Asset, AssetKind, ClassGroup, Lecture } from '../types'
import { backAction, canSaveLecture, saveLecture } from './prepModel'
import '../styles/p4.css'
import '../styles/prep.css'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

type AiState = 'reading' | 'error' | 'done'
type PdfPagesState = { state: 'preparing' } | { state: 'ready'; count: number } | { state: 'error'; error: string }

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
  /** Board pages per PDF: rendered once here so a live session can place them straight away. */
  const [pdfPages, setPdfPages] = useState<Record<string, PdfPagesState>>({})
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toRemove, setToRemove] = useState<Asset | null>(null)
  /** Assets uploaded during this visit (deleted again on discard). */
  const [added, setAdded] = useState<Asset[]>([])
  /** Previously saved assets the teacher removed (deleted on save). */
  const [removed, setRemoved] = useState<Asset[]>([])
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  /** Uploads and typed notes still being written; they don't count as materials yet. */
  const [pending, setPending] = useState(0)
  /** All classes, this lecture's saved class ids, and the current (unsaved) selection. */
  const [classes, setClasses] = useState<ClassGroup[]>([])
  const [savedClassIds, setSavedClassIds] = useState<string[]>([])
  const [classIds, setClassIds] = useState<string[]>([])
  /** Classes tables missing (migration not run): hide the row instead of failing the page. */
  const [classesAvailable, setClassesAvailable] = useState(true)
  const [newClassName, setNewClassName] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const feedEnd = useRef<HTMLDivElement>(null)
  const noteField = useRef<HTMLTextAreaElement>(null)
  /** Grow the notes field with its text (up to about six lines, then it scrolls). */
  const fitNoteField = () => {
    const el = noteField.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 176)}px`
  }
  useEffect(fitNoteField, [draft])

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
      // Rendered PDF pages belong to their PDF; they aren't materials of their own.
      const materials = ((a.data as Asset[]) ?? []).filter((x) => x.kind !== 'pdf_page')
      setItems(materials)
      for (const pdf of materials.filter((x) => x.kind === 'pdf')) {
        if (pdf.page_count) setPdfPages((s) => ({ ...s, [pdf.id]: { state: 'ready', count: pdf.page_count! } }))
        else preparePages(pdf.id) // uploaded before PDF pages existed, or rendering failed last time
      }
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

  const preparePages = useCallback((id: string) => {
    setPdfPages((s) => ({ ...s, [id]: { state: 'preparing' } }))
    api
      .renderPdfPages(id)
      .then((r) => setPdfPages((s) => ({ ...s, [id]: { state: 'ready', count: r.page_count } })))
      .catch((e) =>
        setPdfPages((s) => ({ ...s, [id]: { state: 'error', error: apiErrorMessage(e, 'Couldn’t prepare its pages for the board.') } })),
      )
  }, [])

  const addAsset = async (row: Partial<Asset> & { id: string; kind: AssetKind }) => {
    const { data, error } = await supabase.from('assets').insert({ lecture_id: lectureId, ...row }).select().single()
    if (error) throw error
    setItems((list) => [...list, data as Asset])
    setAdded((list) => [...list, data as Asset])
    describe(row.id)
    if (row.kind === 'pdf') preparePages(row.id)
  }

  /** Deletes the rows and their files; a PDF's rendered page rows go with it (cascade), their files here. */
  const deleteAssets = async (assets: Asset[]) => {
    if (assets.length === 0) return
    const paths = assets.map((a) => a.storage_path).filter((p): p is string => !!p)
    const pdfIds = assets.filter((a) => a.kind === 'pdf').map((a) => a.id)
    if (pdfIds.length) {
      // Errors here only mean the PDF-pages migration hasn't run, so there are no pages to remove.
      const pages = await supabase.from('assets').select('storage_path').in('source_asset_id', pdfIds)
      for (const page of pages.data ?? []) if (page.storage_path) paths.push(page.storage_path as string)
    }
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
    setPending((n) => n + 1)
    try {
      await addAsset({ id: newId(), kind: 'text', text_content: text })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDraft(text)
    } finally {
      setPending((n) => n - 1)
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
      setPending((n) => n + 1)
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
      } finally {
        setPending((n) => n - 1)
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
    setSaving(false)
  }

  /** Apply the title, classes and removals, then go back to the dashboard. */
  const save = async () => {
    setConfirmDiscard(false)
    setBusy(true)
    setSaving(true)
    try {
      await saveLecture({
        updateTitle: titleChanged
          ? async () => {
              const { error } = await supabase
                .from('lectures')
                .update({ title: title.trim() || 'Untitled lecture' })
                .eq('id', lectureId)
              if (error) throw error
            }
          : undefined,
        deleteRemoved: () => deleteAssets(removed),
        updateClasses: classesAvailable && classesChanged ? () => setLectureClasses(lectureId, classIds) : undefined,
        navigate,
      })
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

  /** The back arrow: ask Save / Don't save / Cancel when something would be lost. A brand-new lecture
   *  always asks (leaving without saving deletes it); an unchanged one just goes back. */
  const back = () => {
    if (backAction(hasUnsavedWork, isNew) === 'confirm') setConfirmDiscard(true)
    else navigate('/')
  }

  const imageCount = items.filter((a) => a.kind === 'image').length
  const noteCount = items.length - imageCount
  const canSave = canSaveLecture({ isNew, loaded: !!lecture, busy, materialCount: items.length, pending })

  return (
    <div className="p4 pp pp-fit">
      <header className="p4-top pp-header">
        <button
          className="pp-icon-btn back"
          onClick={back}
          disabled={busy}
          aria-label="Back to the dashboard"
          title="Back to the dashboard"
        >
          <span className="pp-icon-circle">
            <IconArrowLeft />
          </span>
        </button>
        <input
          className="pp-title pp-header-title"
          aria-label="Lecture title"
          value={title}
          placeholder="Lecture title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <button
          className="p4-btn solid pp-save"
          onClick={save}
          disabled={!canSave}
          aria-busy={saving}
          title={isNew && items.length === 0 ? 'Add a material or a note first' : undefined}
        >
          {saving ? 'Saving…' : 'Save lecture'}
        </button>
      </header>

      <main className="pp-body">
        <div className="pp-top">
          {classesAvailable && (
            <div className="pp-classes-row" role="group" aria-label="Classes this lecture belongs to">
              <div className="pp-chips">
                {classes.map((c) => {
                  const on = classIds.includes(c.id)
                  return (
                    <button key={c.id} className={`pp-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleClass(c.id)}>
                      <span className="pp-chip-pill">
                        <span className="pp-chip-dot" style={{ background: c.color }} aria-hidden="true" />
                        {c.name}
                      </span>
                    </button>
                  )
                })}
                {newClassName === null ? (
                  <button className="pp-chip add" aria-label="New class" title="New class" onClick={() => setNewClassName('')}>
                    <span className="pp-chip-pill">
                      <IconPlus />
                    </span>
                  </button>
                ) : (
                  <span className="pp-class-new">
                    <input
                      autoFocus
                      value={newClassName}
                      placeholder="New class, e.g. Period 2"
                      aria-label="New class name"
                      onChange={(e) => setNewClassName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addClass()
                        if (e.key === 'Escape') setNewClassName(null)
                      }}
                    />
                    <button className="pp-chip" onClick={addClass} disabled={!newClassName.trim()}>
                      <span className="pp-chip-pill dark">Add</span>
                    </button>
                    <button className="pp-chip" onClick={() => setNewClassName(null)}>
                      <span className="pp-chip-pill">Cancel</span>
                    </button>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

          <section className="pp-materials" aria-labelledby="materials-heading">
            <div className="pp-card-head">
              <div className="pp-card-title">
                <h2 id="materials-heading" className="p4-label">
                  Materials
                </h2>
                <span className="pp-count">{items.length}</span>
              </div>
              <span className="pp-card-meta">
                <span>
                  <IconImage /> {plural(imageCount, 'image')}
                </span>
                <span>
                  <IconFile /> {plural(noteCount, 'note')}
                </span>
              </span>
            </div>
            <div className="pp-feed-scroll">
            <div className="pp-feed">
              <div className="pp-ai">
                <div className="pp-ai-avatar" aria-hidden="true">
                  <IconSparkle />
                </div>
                <div className="pp-ai-body">
                  <p className="pp-ai-title">Add what you'll teach with</p>
                  <p className="pp-ai-desc">
                    Diagrams and photos go to your image bank for the board. PDFs, text files and typed notes become context for
                    cleaning up your speech and writing the study notes, and a PDF's pages can also go on the board.
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
                      className="pp-remove"
                      aria-label={`Remove ${a.file_name ?? a.label ?? 'this item'}`}
                      title="Remove"
                      onClick={() => setToRemove(a)}
                    >
                      <span className="pp-remove-circle">
                        <IconX />
                      </span>
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
                      {a.kind === 'pdf' && pdfPages[a.id] && (
                        <p className={`pp-ai-foot${pdfPages[a.id].state === 'error' ? ' pp-pages-error' : ''}`} role="status">
                          {(() => {
                            const p = pdfPages[a.id]
                            if (p.state === 'preparing') return 'Preparing its pages for the board…'
                            if (p.state === 'ready') return `${plural(p.count, 'page')} ready for the board`
                            return (
                              <>
                                {p.error}{' '}
                                <button className="pp-retry" onClick={() => preparePages(a.id)}>
                                  Try again
                                </button>
                              </>
                            )
                          })()}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={feedEnd} />
            </div>
            </div>
          </section>
      </main>

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
          <button className="pp-icon-btn" onClick={() => fileInput.current?.click()} aria-label="Attach images, PDFs or text files" title="Attach">
            <span className="pp-icon-circle">
              <IconPaperclip />
            </span>
          </button>
          <textarea
            ref={noteField}
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
          <button
            className={`pp-icon-btn send${draft.trim() ? ' ready' : ''}`}
            onClick={sendText}
            disabled={!draft.trim()}
            aria-label="Send"
            title="Send (Ctrl+Enter)"
          >
            <span className="pp-icon-circle">
              <IconArrowUp />
            </span>
          </button>
        </div>
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
        {toRemove?.kind === 'pdf' && ' Past sessions that placed its pages on the board will then show blank pages.'}
      </ConfirmDialog>

      {confirmDiscard && (
        <div className="dialog-backdrop" onClick={() => setConfirmDiscard(false)}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="leave-title">{isNew && !hasUnsavedWork ? 'Keep this lecture?' : 'Save changes?'}</h2>
            <div className="dialog-body">
              {isNew
                ? "This lecture hasn't been saved yet. If you don't save, it and everything you added are deleted."
                : "If you don't save, new uploads are deleted, removed items come back, and the title and classes are restored."}
            </div>
            <div className="row dialog-actions pp-leave-actions">
              <button onClick={() => setConfirmDiscard(false)}>Cancel</button>
              <span className="pp-spacer" />
              <button className="danger-outline" onClick={discard} disabled={busy}>
                Don't save
              </button>
              <button className="primary" onClick={save} disabled={!lecture || busy} autoFocus>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
