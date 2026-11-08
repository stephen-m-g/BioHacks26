// P4 owns this page. The interactive study document compiled from a session.
// Figures are the board's images with their annotations: hover for his words, click to jump to the section.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { IconArrowLeft, IconClock, IconPrinter, IconRefresh, IconText } from '../components/DashIcons'
import { annotationCardId } from '../components/annotationPopoverModel'
import ImageBlock from '../components/ImageBlock'
import RichText from '../components/RichText'
import { useSessionData } from '../hooks/useSessionData'
import { api } from '../lib/api'
import { assetUrl } from '../lib/assets'
import { formatDate } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { LectureNotes, NotesContent } from '../types'
import {
  annotationCardsForImage,
  annotationsForImage,
  isTranscriptPartHighlighted,
  studyKeyTerms,
  transcriptParagraphParts,
} from './notesModel'
import '../styles/p4.css'
import '../styles/study.css'

export default function Notes() {
  const { sessionId = '' } = useParams()
  const data = useSessionData(sessionId)
  const [notes, setNotes] = useState<LectureNotes | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [compiling, setCompiling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)

  useEffect(() => {
    supabase
      .from('lecture_notes')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) setError(error.message)
        setNotes(data as LectureNotes | null)
        setLoaded(true)
      })
    // Compiling runs in the background after End session; show the result when it lands.
    const channel = supabase
      .channel(`notes:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lecture_notes', filter: `session_id=eq.${sessionId}` }, (p) => {
        if (p.eventType !== 'DELETE') setNotes(p.new as LectureNotes)
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [sessionId])

  const compile = async () => {
    setCompiling(true)
    setError(null)
    try {
      const content = await api.compileSession(sessionId)
      setNotes((n) => ({ session_id: sessionId, created_at: n?.created_at ?? new Date().toISOString(), content }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCompiling(false)
    }
  }

  const content: NotesContent | null = notes?.content ?? null
  const hasContent = !!content && (content.sections.length > 0 || !!content.overview)
  const annotationTitles = data.annotationList
    .filter((annotation) => annotation.status === 'confirmed' && annotation.label)
    .map((annotation) => annotation.label!)

  const selectAnnotation = (annotationId: string) => {
    setSelectedAnnotationId(annotationId)
    const card = document.getElementById(annotationCardId(annotationId))
    if (!card) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' })
    card.focus({ preventScroll: true })
    if (!reduceMotion) {
      card.animate(
        [{ boxShadow: '0 0 0 6px rgba(202, 138, 4, 0.45)' }, { boxShadow: '0 0 0 0 rgba(202, 138, 4, 0)' }],
        { duration: 1200, easing: 'ease-out' },
      )
    }
  }

  return (
    <div className="p4">
      <header className="p4-top no-print">
        <Link className="p4-btn" to="/">
          <IconArrowLeft /> Lectures
        </Link>
        <button onClick={compile} disabled={compiling}>
          {compiling ? 'Compiling…' : hasContent ? 'Recompile' : 'Compile notes'}
        </button>
        {hasContent && (
          <button className="p4-btn solid" onClick={() => window.print()}>
            <IconPrinter /> Print or PDF
          </button>
        )}
      </header>

      <div className="p4-inner">
        <div className="st-article">
          {error && (
            <div className="p4-notice warn no-print" role="alert">
              <span>{error}</span>
              <button className="p4-btn" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}
          {loaded && !hasContent && (
            <div className="p4-notice" role="status">
              <span>
                {notes
                  ? 'The compiled notes came back empty. Try Recompile.'
                  : 'Your notes are compiling. They’ll appear here automatically.'}
              </span>
            </div>
          )}

          {content && hasContent && (
            <article>
              <span className="p4-badge dark st-eyebrow">Study notes</span>
              <h1 className="p4-title" style={{ marginTop: 16 }}>
                {content.title || data.session?.title || data.lecture?.title}
              </h1>
              <p className="p4-sub">
                <span>
                  <IconClock /> {formatDate(data.session?.started_at)}
                </span>
                <span>{content.sections.length} sections</span>
              </p>
              {content.overview && (
                <p className="st-overview">
                  <RichText text={content.overview} />
                </p>
              )}

              {content.sections.length > 1 && (
                <nav className="p4-section no-print" aria-labelledby="toc-heading">
                  <h2 id="toc-heading" className="p4-label">
                    Sections
                  </h2>
                  <div className="st-toc">
                    {content.sections.map((s) => (
                      <a key={s.id} href={`#section-${s.id}`}>
                        {s.heading}
                      </a>
                    ))}
                  </div>
                </nav>
              )}

              <div className="st-sections">
                {content.sections.map((s) => {
                  const figures = s.figures.flatMap((f) => {
                    const block = data.blocks[f.image_block_id]
                    if (!block) return []
                    return [{ figure: f, block, cards: annotationCardsForImage(data.annotationList, block.id, data.segmentList) }]
                  })
                  const keyTerms = studyKeyTerms(
                    s.key_terms,
                    figures.some(({ cards }) => cards.length > 0),
                    annotationTitles,
                  )
                  return (
                    <section key={s.id} id={`section-${s.id}`} className="p4-card st-section">
                      <h2>{s.heading}</h2>
                      {s.paragraphs.map((p, i) => {
                        const parts = transcriptParagraphParts(p, s.paragraph_block_ids?.[i], data.segmentList)
                        return (
                          <p key={i}>
                            {parts.map((part, partIndex) => (
                              <span
                                key={`${part.segmentId ?? 'gap'}-${partIndex}`}
                                data-segment-id={part.segmentId ?? undefined}
                                className={
                                  isTranscriptPartHighlighted(part, selectedAnnotationId)
                                    ? 'st-transcript-highlight'
                                    : undefined
                                }
                              >
                                <RichText text={part.text} />
                              </span>
                            ))}
                          </p>
                        )
                      })}
                      {figures.map(({ figure: f, block, cards }) => {
                        const asset = block.asset_id ? data.assets[block.asset_id] : undefined
                        const cardById = new Map(cards.map((card) => [card.id, card]))
                        const popoverAnnotations = annotationsForImage(data.annotationList, block.id).map((annotation) => ({
                          ...annotation,
                          label: cardById.get(annotation.id)?.title ?? annotation.label,
                          bubble_text: cardById.get(annotation.id)?.text ?? null,
                        }))
                        return (
                          <figure key={f.image_block_id}>
                            <ImageBlock
                              block={block}
                              src={assetUrl(asset)}
                              alt={asset?.label ?? f.caption}
                              strokes={data.strokeList.filter((st) => st.block_id === block.id)}
                              annotations={popoverAnnotations}
                              selectedAnnotationId={selectedAnnotationId}
                              onSelectAnnotation={selectAnnotation}
                            />
                            <figcaption>{f.caption}</figcaption>
                            {cards.length > 0 && (
                              <div className="st-terms" aria-label="Image annotations">
                                {cards.map((card) => (
                                  <button
                                    type="button"
                                    id={annotationCardId(card.id)}
                                    key={card.id}
                                    className={`st-term-card${selectedAnnotationId === card.id ? ' selected' : ''}`}
                                    aria-pressed={selectedAnnotationId === card.id}
                                    onClick={() => setSelectedAnnotationId(card.id)}
                                  >
                                    <strong>{card.title}</strong>
                                    <span>{card.text}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </figure>
                        )
                      })}
                      {keyTerms.length > 0 && (
                        <dl className="st-terms">
                          {keyTerms.map((k) => (
                            <div key={k.term}>
                              <dt>{k.term}</dt>
                              <dd>{k.definition}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </section>
                  )
                })}

                {content.review_questions.length > 0 && (
                  <section className="p4-card st-section">
                    <h2>Review questions</h2>
                    <ol className="st-questions">
                      {content.review_questions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ol>
                  </section>
                )}
              </div>
            </article>
          )}
        </div>
      </div>
    </div>
  )
}
