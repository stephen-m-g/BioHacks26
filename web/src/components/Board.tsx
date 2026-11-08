// P1 owns this component. The live board: a vertical document of text paragraphs and images,
// with unrefined speech in grey at the bottom. Used interactively on /teach and read-only on the student view.
import { Fragment } from 'react'
import { assetUrl } from '../lib/assets'
import { pageInfo, pageLabel, pageOwners } from '../lib/pdfPages'
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
  /** Teacher: the PDF page new speech belongs to (its label is marked, and the interim text shows under it). */
  activePageBlockId?: string | null
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
  activePageBlockId,
  onJump,
  showPending,
  emptyText,
}: Props) {
  const unrefined = segments.filter((s) => !s.text_block_id)
  // Speech about a PDF page shows (grey until refined) right under that page's paragraphs; the rest at the end.
  const owners = pageOwners(blocks, assets)
  const sectionEnd = new Map<string, number>()
  blocks.forEach((b, i) => {
    const owner = owners.get(b.id)
    if (owner) sectionEnd.set(owner, i)
  })
  const onBoard = (page: string | null | undefined): page is string => !!page && sectionEnd.has(page)
  const liveByPage = new Map<string, TranscriptSegment[]>()
  const liveAtEnd: TranscriptSegment[] = []
  for (const s of unrefined) {
    if (onBoard(s.page_block_id)) liveByPage.set(s.page_block_id, [...(liveByPage.get(s.page_block_id) ?? []), s])
    else liveAtEnd.push(s)
  }
  const interimPage = interim && onBoard(activePageBlockId) ? activePageBlockId : null
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

  const live = (items: TranscriptSegment[], withInterim: boolean, owner: string | null) =>
    items.length > 0 || withInterim ? (
      <p className="board-live" data-board-item="" data-page-owner={owner ?? undefined}>
        {items.map((s) => (
          <span key={s.id} className={s.annotation_id ? 'linked' : undefined}>
            {s.raw_text}{' '}
          </span>
        ))}
        {withInterim && <span className="interim">{interim}</span>}
      </p>
    ) : null

  return (
    <div className="board">
      {slot(0)}
      {blocks.map((b, i) => {
        const page = pageInfo(b, assets)
        const owner = owners.get(b.id) ?? null
        const endsSection = owner !== null && sectionEnd.get(owner) === i
        const active = page !== null && b.id === activePageBlockId
        return (
          <Fragment key={b.id}>
            {b.kind === 'text' ? (
              <p className="board-text" data-board-item="" data-page-owner={owner ?? undefined}>
                {b.text}
              </p>
            ) : page ? (
              <div className="pdf-page" data-pdf-page={b.id} data-board-item="" data-page-owner={b.id}>
                <div className={`pdf-page-label${active ? ' active' : ''}`} aria-current={active ? 'true' : undefined}>
                  {active && <span className="pdf-page-dot" aria-hidden="true" />}
                  <span className="pdf-page-name">{page.fileName}</span>
                  <span aria-hidden="true">·</span>
                  <span>{pageLabel(page)}</span>
                </div>
                {image(b, `${page.fileName}, ${pageLabel(page).toLowerCase()}`)}
              </div>
            ) : (
              <div data-board-item="">{image(b, (b.asset_id && assets[b.asset_id]?.label) || 'Lecture image')}</div>
            )}
            {endsSection && live(liveByPage.get(owner) ?? [], interimPage === owner, owner)}
            {slot(i + 1)}
          </Fragment>
        )
      })}

      {live(liveAtEnd, !!interim && !interimPage, null)}

      {empty && (
        <p className="muted board-empty">
          {emptyText ?? (teacher ? 'Start talking, or place an image from the sidebar.' : 'Nothing on this board.')}
        </p>
      )}
    </div>
  )
}
