// P4 owns this component. The transcript view's board: the session's pages and images in board order, each in
// its own card with the speech given about it, styled like the study notes. Read-only.
import { useState } from 'react'
import { pageInfo, pageLabel, pageOwners } from '../lib/pdfPages'
import { annotationsForImage, rawAnnotationCardsForImage, transcriptSections } from '../pages/notesModel'
import type { Annotation, Asset, Block, Stroke, TranscriptSegment } from '../types'
import SessionFigure, { revealAnnotationCard } from './SessionFigure'

interface Props {
  /** In board order. */
  blocks: Block[]
  assets: Record<string, Asset>
  strokes: Stroke[]
  annotations: Annotation[]
  segments: TranscriptSegment[]
}

export default function TranscriptBoard({ blocks, assets, strokes, annotations, segments }: Props) {
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const sections = transcriptSections(blocks, pageOwners(blocks, assets), segments)

  if (sections.length === 0) return <p className="p4-empty">Nothing on this board.</p>

  const selectAnnotation = (annotationId: string) => {
    setSelectedAnnotationId(annotationId)
    revealAnnotationCard(annotationId)
  }

  return (
    <div className="st-sections">
      {sections.map((section) => {
        const media = section.media
        const page = media ? pageInfo(media, assets) : null
        const asset = media?.asset_id ? assets[media.asset_id] : undefined
        const title = page ? null : asset?.label || asset?.file_name || null
        return (
          <section
            key={section.id}
            className="p4-card st-section"
            aria-label={page ? `${page.fileName}, ${pageLabel(page).toLowerCase()}` : (title ?? 'Speech')}
          >
            {title && <h2>{title}</h2>}
            {media && (
              <SessionFigure
                block={media}
                assets={assets}
                strokes={strokes.filter((stroke) => stroke.block_id === media.id)}
                annotations={annotationsForImage(annotations, media.id)}
                cards={rawAnnotationCardsForImage(annotations, media.id, segments)}
                alt={title ?? 'Lecture image'}
                selectedAnnotationId={selectedAnnotationId}
                onSelectAnnotation={selectAnnotation}
                onSelectCard={setSelectedAnnotationId}
              />
            )}
            {section.paragraphs.map((block) => (
              <p key={block.id}>{block.text}</p>
            ))}
            {section.unrefined.length > 0 && (
              <p>{section.unrefined.map((segment) => segment.raw_text.trim()).join(' ')}</p>
            )}
          </section>
        )
      })}
    </div>
  )
}
