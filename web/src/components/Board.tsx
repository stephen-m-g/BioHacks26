// P1 owns this component. The live board: a vertical document of text paragraphs and images,
// with unrefined speech in grey at the bottom. Used interactively on /teach and read-only on the raw view.
import { Fragment } from 'react'
import { assetUrl } from '../lib/assets'
import type { Annotation, Asset, Block, Stroke, TranscriptSegment } from '../types'
import ImageBlock, { type ImageBlockInteraction } from './ImageBlock'

export interface BoardTeacherProps extends ImageBlockInteraction {
  /** An image is selected or being dragged: show the drop slots. */
  placing: boolean
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
}

export default function Board({ blocks, assets, strokes, annotations, segments, interim, teacher, onJump }: Props) {
  const unrefined = segments.filter((s) => !s.text_block_id)
  const visibleAnnotations = annotations.filter((a) => a.status !== 'rejected' && (teacher || a.status === 'confirmed'))
  const empty = blocks.length === 0 && unrefined.length === 0 && !interim

  const slot = (index: number) =>
    teacher ? (
      <div
        data-slot={index}
        className={`slot${teacher.placing ? ' slot-active' : ''}`}
        onClick={() => teacher.placing && teacher.onSlot(index)}
      >
        {teacher.placing && 'Place image here'}
      </div>
    ) : null

  return (
    <div className="board">
      {slot(0)}
      {blocks.map((b, i) => (
        <Fragment key={b.id}>
          {b.kind === 'text' ? (
            <p className="board-text">{b.text}</p>
          ) : (
            <ImageBlock
              block={b}
              src={assetUrl(b.asset_id ? assets[b.asset_id] : null)}
              alt={(b.asset_id && assets[b.asset_id]?.label) || 'Lecture image'}
              strokes={strokes.filter((s) => s.block_id === b.id)}
              annotations={visibleAnnotations.filter((a) => a.block_id === b.id)}
              interactive={teacher}
              onJump={onJump}
            />
          )}
          {slot(i + 1)}
        </Fragment>
      ))}

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

      {empty && <p className="muted board-empty">{teacher ? 'Start talking, or place an image from the sidebar.' : 'Nothing on this board.'}</p>}
    </div>
  )
}
