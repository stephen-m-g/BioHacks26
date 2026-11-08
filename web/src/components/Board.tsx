// P1 owns this component. The live board: a vertical document of text paragraphs and images,
// with unrefined speech in grey at the bottom. Used interactively on /teach and read-only on the raw and student views.
import { Fragment } from 'react'
import { assetUrl } from '../lib/assets'
import { pageInfo, pageLabel } from '../lib/pdfPages'
import type { Annotation, Asset, Block, Stroke, TranscriptSegment } from '../types'
import ImageBlock, { type ImageBlockInteraction } from './ImageBlock'

export interface BoardTeacherProps extends ImageBlockInteraction {
  /** An image or PDF is selected or being dragged: show the drop slots. */
  placing: boolean
  /** Text in an active drop slot. */
  placeLabel?: string
  onSlot: (slot: number) => void
}

interface Props {
  blocks: Block[]
  assets: Record<string, Asset>
  strokes: Stroke[]
  annotations: Annotation[]
  segments: TranscriptSegment[]
  interim?: string
  teacher?: BoardTeacherProps
  onJump?: (annotationId: string) => void
  /** Read-only: also show pending lassos (as the shimmer), e.g. on the student view of a live session. */
  showPending?: boolean
  /** Shown while the board has nothing on it. */
  emptyText?: string
}

export default function Board({
  blocks,
  assets,
  strokes,
  annotations,
  segments,
  interim,
  teacher,
  onJump,
  showPending,
  emptyText,
}: Props) {
  const unrefined = segments.filter((s) => !s.text_block_id)
  const visibleAnnotations = annotations.filter(
    (a) => a.status !== 'rejected' && (teacher || showPending || a.status === 'confirmed'),
  )
  const empty = blocks.length === 0 && unrefined.length === 0 && !interim

  const slot = (index: number) =>
    teacher ? (
      <div
        data-slot={index}
        className={`slot${teacher.placing ? ' slot-active' : ''}`}
        onClick={() => teacher.placing && teacher.onSlot(index)}
      >
        {teacher.placing && (teacher.placeLabel ?? 'Place image here')}
      </div>
    ) : null

  const image = (b: Block, alt: string) => (
    <ImageBlock
      block={b}
      src={assetUrl(b.asset_id ? assets[b.asset_id] : null)}
      alt={alt}
      strokes={strokes.filter((s) => s.block_id === b.id)}
      annotations={visibleAnnotations.filter((a) => a.block_id === b.id)}
      interactive={teacher}
      onJump={onJump}
    />
  )

  return (
    <div className="board">
      {slot(0)}
      {blocks.map((b, i) => {
        const page = pageInfo(b, assets)
        return (
          <Fragment key={b.id}>
            {b.kind === 'text' ? (
              <p className="board-text">{b.text}</p>
            ) : page ? (
              <div className="pdf-page" data-pdf-page={b.id}>
                <div className="pdf-page-label">
                  <span className="pdf-page-name">{page.fileName}</span>
                  <span aria-hidden="true">·</span>
                  <span>{pageLabel(page)}</span>
                </div>
                {image(b, `${page.fileName}, ${pageLabel(page).toLowerCase()}`)}
              </div>
            ) : (
              image(b, (b.asset_id && assets[b.asset_id]?.label) || 'Lecture image')
            )}
            {slot(i + 1)}
          </Fragment>
        )
      })}

      {(unrefined.length > 0 || interim) && (
        <p className="board-live">
          {unrefined.map((s) => (
            <span key={s.id} className={s.annotation_id ? 'linked' : undefined}>
              {s.raw_text}{' '}
            </span>
          ))}
          {interim && <span className="interim">{interim}</span>}
        </p>
      )}

      {empty && (
        <p className="muted board-empty">
          {emptyText ?? (teacher ? 'Start talking, or place an image from the sidebar.' : 'Nothing on this board.')}
        </p>
      )}
    </div>
  )
}
