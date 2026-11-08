import type { TranscriptSegment } from '../types'
import type { TranscriptionContext } from './transcriptionModel'

interface BuildTranscriptSegmentInput {
  id: string
  defaultSessionId: string
  defaultAnnotationId?: string | null
  defaultPageBlockId?: string | null
  context: TranscriptionContext | null
  rawText: string
  confidence: number | null
  tStart: string
  tEnd: string
  createdAt: string
}

/** Serializes periodic refinement and allows end-session to drain once after an active run. */
export class RefineCoordinator {
  private active: Promise<void> | null = null

  run(task: () => Promise<void>): Promise<void> {
    if (this.active) return this.active
    const current = Promise.resolve().then(task)
    this.active = current
    void current.then(
      () => {
        if (this.active === current) this.active = null
      },
      () => {
        if (this.active === current) this.active = null
      },
    )
    return current
  }

  async drain(task: () => Promise<void>): Promise<void> {
    const active = this.active
    if (active) await active
    await this.run(task)
  }
}

/** Run annotation linking only after transcript inserts already in flight have settled. */
export async function waitForPendingWrites<T>(pending: Set<Promise<void>>, task: () => Promise<T>): Promise<T> {
  if (pending.size > 0) await Promise.allSettled([...pending])
  return task()
}

/** Close the audio boundary first so delayed timestamp callbacks can register their DB writes before /close. */
export async function flushSpeechAndWaitForPendingWrites<T>(
  pending: Set<Promise<void>>,
  flushSpeech: (() => Promise<void>) | undefined,
  task: () => Promise<T>,
): Promise<T> {
  await flushSpeech?.()
  return waitForPendingWrites(pending, task)
}

export function buildTranscriptSegment(input: BuildTranscriptSegmentInput): TranscriptSegment {
  return {
    id: input.id,
    session_id: input.context?.sessionId ?? input.defaultSessionId,
    t_start: input.tStart,
    t_end: input.tEnd,
    raw_text: input.rawText,
    confidence: input.confidence,
    annotation_id: input.context ? input.context.annotationId : (input.defaultAnnotationId ?? null),
    page_block_id: input.context ? (input.context.pageBlockId ?? null) : (input.defaultPageBlockId ?? null),
    text_block_id: null,
    text_start: null,
    text_end: null,
    created_at: input.createdAt,
  }
}

/** The insert payload: ordinary speech leaves out page_block_id, so it saves even before the page_speech migration. */
export function segmentInsertRow(row: TranscriptSegment): TranscriptSegment {
  if (row.page_block_id) return row
  const { page_block_id: _, ...rest } = row
  return rest
}
