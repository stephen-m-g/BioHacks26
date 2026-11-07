import type { TranscriptSegment } from '../types'
import type { TranscriptionContext } from './transcriptionModel'

interface BuildTranscriptSegmentInput {
  id: string
  defaultSessionId: string
  defaultAnnotationId?: string | null
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

export function buildTranscriptSegment(input: BuildTranscriptSegmentInput): TranscriptSegment {
  return {
    id: input.id,
    session_id: input.context?.sessionId ?? input.defaultSessionId,
    t_start: input.tStart,
    t_end: input.tEnd,
    raw_text: input.rawText,
    confidence: input.confidence,
    annotation_id: input.context ? input.context.annotationId : (input.defaultAnnotationId ?? null),
    text_block_id: null,
    created_at: input.createdAt,
  }
}
