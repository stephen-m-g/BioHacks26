// P4 owns this component. One image or PDF page in a session view card (study notes, transcript): its page label,
// the image with ink and hoverable circles, and one compact card per confirmed circle.
import { assetUrl } from '../lib/assets'
import { pageInfo, pageLabel } from '../lib/pdfPages'
import type { AnnotationCard } from '../pages/notesModel'
import type { Annotation, Asset, Block, Stroke } from '../types'
import { annotationCardId } from './annotationPopoverModel'
import ImageBlock from './ImageBlock'

interface Props {
  block: Block
  assets: Record<string, Asset>
  /** Strokes on this image. */
  strokes: Stroke[]
  /** Confirmed circles on this image, in card order. */
  annotations: Annotation[]
  /** The circles' cards; their title and text are also what the popovers show. */
  cards: AnnotationCard[]
  /** Alt text for an ordinary image. */
  alt: string
  /** Screen-reader caption. */
  caption?: string
  selectedAnnotationId: string | null
  /** A circle was clicked: select it and bring its card into view. */
  onSelectAnnotation: (annotationId: string) => void
  /** A card was clicked. */
  onSelectCard: (annotationId: string) => void
}

export default function SessionFigure({
  block,
  assets,
  strokes,
  annotations,
  cards,
  alt,
  caption,
  selectedAnnotationId,
  onSelectAnnotation,
  onSelectCard,
}: Props) {
  const asset = block.asset_id ? assets[block.asset_id] : undefined
  const page = pageInfo(block, assets)
  const cardById = new Map(cards.map((card) => [card.id, card]))
  const popoverAnnotations = annotations.map((annotation) => ({
    ...annotation,
    label: cardById.get(annotation.id)?.title ?? annotation.label,
    bubble_text: cardById.get(annotation.id)?.text ?? null,
  }))
  return (
    <figure className={page ? 'st-pdf-page' : undefined}>
      {page && (
        <div className="pdf-page-label">
          <span className="pdf-page-name">{page.fileName}</span>
          <span aria-hidden="true">·</span>
          <span>{pageLabel(page)}</span>
        </div>
      )}
      <ImageBlock
        block={block}
        src={assetUrl(asset)}
        alt={page ? `${page.fileName}, ${pageLabel(page).toLowerCase()}` : alt}
        strokes={strokes}
        annotations={popoverAnnotations}
        selectedAnnotationId={selectedAnnotationId}
        onSelectAnnotation={onSelectAnnotation}
      />
      {caption && <figcaption className="st-visually-hidden">{caption}</figcaption>}
      {cards.length > 0 && (
        <div className="st-terms" aria-label="Image annotations">
          {cards.map((card) => (
            <button
              type="button"
              id={annotationCardId(card.id)}
              key={card.id}
              className={`st-term-card${selectedAnnotationId === card.id ? ' selected' : ''}`}
              aria-pressed={selectedAnnotationId === card.id}
              onClick={() => onSelectCard(card.id)}
            >
              <strong>{card.title}</strong>
              <span>{card.text}</span>
            </button>
          ))}
        </div>
      )}
    </figure>
  )
}

/** Scroll a circle's card into view and flash it. */
export function revealAnnotationCard(annotationId: string) {
  const card = document.getElementById(annotationCardId(annotationId))
  if (!card) return
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' })
  card.focus({ preventScroll: true })
  if (!reduceMotion) {
    card.animate(
      [{ boxShadow: '0 0 0 6px rgba(17, 17, 17, 0.14)' }, { boxShadow: '0 0 0 0 rgba(17, 17, 17, 0)' }],
      { duration: 1200, easing: 'ease-out' },
    )
  }
}
