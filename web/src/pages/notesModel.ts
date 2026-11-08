import type { Annotation, TranscriptSegment } from '../types'

type ExplanationAnnotation = Pick<Annotation, 'id' | 'bubble_text'>
type ExplanationSegment = Pick<TranscriptSegment, 'annotation_id' | 'raw_text' | 't_start' | 'created_at'>

type ImageAnnotation = Pick<Annotation, 'id' | 'block_id' | 'status' | 'drawn_at'>

/** Cards are a one-to-one projection of persisted confirmed circles, never Gemini's selection. */
export function annotationsForImage<T extends ImageAnnotation>(annotations: T[], blockId: string): T[] {
  return annotations
    .filter((annotation) => annotation.block_id === blockId && annotation.status === 'confirmed')
    .sort((a, b) => a.drawn_at.localeCompare(b.drawn_at) || a.id.localeCompare(b.id))
}

/** Persisted linked segments are complete source-of-truth speech; the saved bubble is a legacy fallback. */
export function annotationExplanation(
  annotation: ExplanationAnnotation,
  segments: ExplanationSegment[],
): string | null {
  const linked = segments
    .filter((segment) => segment.annotation_id === annotation.id && segment.raw_text.trim())
    .sort((a, b) => (a.t_start ?? a.created_at).localeCompare(b.t_start ?? b.created_at))
    .map((segment) => segment.raw_text.trim())
    .join(' ')
  if (!linked) return annotation.bubble_text?.trim() || null

  const cleaned = linked
    .replace(/\b(?:um+|uh+)\b[\s,]*/gi, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!cleaned) return null
  return cleaned[0].toUpperCase() + cleaned.slice(1)
}
