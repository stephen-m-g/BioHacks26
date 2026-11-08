// P4 owns this component. The transcript view's board: the session's pages and images in board order, each in
// its own card with the speech given about it exactly as recognized, styled like the study notes. Read-only:
// circles show their raw words in a popover; the annotation cards are the study notes' alone.
import { Fragment } from 'react'
import { pageInfo, pageLabel, pageOwners } from '../lib/pdfPages'
import {
  annotationsForImage,
  rawAnnotationCardsForImage,
  rawParagraphParts,
  rawSpeechParts,
  transcriptSections,
  type TranscriptParagraphPart,
} from '../pages/notesModel'
import type { Annotation, Asset, Block, Stroke, TranscriptSegment } from '../types'
import SessionFigure from './SessionFigure'

interface Props {
  /** In board order. */
  blocks: Block[]
  assets: Record<string, Asset>
  strokes: Stroke[]
  annotations: Annotation[]
  segments: TranscriptSegment[]
}

export default function TranscriptBoard({ blocks, assets, strokes, annotations, segments }: Props) {
  const sections = transcriptSections(blocks, pageOwners(blocks, assets), segments)

  if (sections.length === 0) return <p className="p4-empty">Nothing on this board.</p>

  const renderParts = (parts: TranscriptParagraphPart[]) =>
    parts.map((part, index) => (
      <Fragment key={part.segmentId}>
        {index > 0 && ' '}
        <span data-segment-id={part.segmentId ?? undefined}>{part.text}</span>
      </Fragment>
    ))

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
                showCards={false}
                alt={title ?? 'Lecture image'}
              />
            )}
            {section.paragraphs.map((block) => {
              const parts = rawParagraphParts(block.id, segments)
              if (parts) return parts.length > 0 ? <p key={block.id}>{renderParts(parts)}</p> : null
              return (
                <Fragment key={block.id}>
                  <p>{block.text}</p>
                  <p className="st-raw-note">Cleaned text: the original wording wasn’t saved for this paragraph.</p>
                </Fragment>
              )
            })}
            {section.unrefined.length > 0 && <p>{renderParts(rawSpeechParts(section.unrefined))}</p>}
          </section>
        )
      })}
    </div>
  )
}
