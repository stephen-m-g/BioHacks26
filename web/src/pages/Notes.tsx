// P4 owns this page. The interactive study document compiled from a session.
// Figures are the board's images with their annotations: hover for his words, click to jump to the section.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ImageBlock from '../components/ImageBlock'
import RichText from '../components/RichText'
import { useSessionData } from '../hooks/useSessionData'
import { api } from '../lib/api'
import { assetUrl } from '../lib/assets'
import { formatDate } from '../lib/lectures'
import { supabase } from '../lib/supabase'
import type { LectureNotes, NotesContent } from '../types'

export default function Notes() {
  const { sessionId = '' } = useParams()
  const data = useSessionData(sessionId)
  const [notes, setNotes] = useState<LectureNotes | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [compiling, setCompiling] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const jumpTo = (annotationId: string) => {
    const section = content?.sections.find((s) => s.annotation_ids?.includes(annotationId))
    const el = section && document.getElementById(`section-${section.id}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el?.classList.add('flash')
    setTimeout(() => el?.classList.remove('flash'), 1200)
  }

  return (
    <div className="page notes">
      <header className="page-header no-print">
        <Link className="btn" to="/">
          ← Dashboard
        </Link>
        <Link className="btn" to={`/sessions/${sessionId}/raw`}>
          Raw board
        </Link>
        <button onClick={compile} disabled={compiling}>
          {compiling ? 'Compiling…' : hasContent ? 'Recompile' : 'Compile notes'}
        </button>
        {hasContent && <button onClick={() => window.print()}>Print / PDF</button>}
      </header>

      {error && <div className="notice warn">{error}</div>}
      {loaded && !hasContent && (
        <div className="notice">
          {notes ? 'The compiled notes are empty (the compile endpoint may not be implemented yet).' : 'Notes are compiling… they will appear here automatically.'}
        </div>
      )}

      {content && hasContent && (
        <article>
          <h1>{content.title || data.lecture?.title}</h1>
          <div className="muted">{formatDate(data.session?.started_at)}</div>
          {content.overview && (
            <p className="overview">
              <RichText text={content.overview} />
            </p>
          )}

          {content.sections.length > 1 && (
            <nav className="toc no-print">
              {content.sections.map((s) => (
                <a key={s.id} href={`#section-${s.id}`}>
                  {s.heading}
                </a>
              ))}
            </nav>
          )}

          {content.sections.map((s) => (
            <section key={s.id} id={`section-${s.id}`} className="notes-section">
              <h2>{s.heading}</h2>
              {s.paragraphs.map((p, i) => (
                <p key={i}>
                  <RichText text={p} />
                </p>
              ))}
              {s.figures.map((f) => {
                const block = data.blocks[f.image_block_id]
                if (!block) return null
                const asset = block.asset_id ? data.assets[block.asset_id] : undefined
                return (
                  <figure key={f.image_block_id}>
                    <ImageBlock
                      block={block}
                      src={assetUrl(asset)}
                      alt={asset?.label ?? f.caption}
                      strokes={data.strokeList.filter((st) => st.block_id === block.id)}
                      annotations={data.annotationList.filter((a) => a.block_id === block.id && a.status === 'confirmed')}
                      onJump={jumpTo}
                    />
                    <figcaption>{f.caption}</figcaption>
                  </figure>
                )
              })}
              {s.key_terms.length > 0 && (
                <dl className="key-terms">
                  {s.key_terms.map((k) => (
                    <div key={k.term}>
                      <dt>{k.term}</dt>
                      <dd>{k.definition}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          ))}

          {content.review_questions.length > 0 && (
            <section className="notes-section">
              <h2>Review questions</h2>
              <ol>
                {content.review_questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            </section>
          )}
        </article>
      )}
    </div>
  )
}
