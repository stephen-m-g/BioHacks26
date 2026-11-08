import type { Annotation, TranscriptSegment } from '../types'

type ExplanationAnnotation = Pick<Annotation, 'id' | 'bubble_text'>
type ExplanationSegment = Pick<TranscriptSegment, 'annotation_id' | 'raw_text' | 't_start' | 'created_at'>

/** Prefer /close's cleaned speech, then recover faithfully from persisted annotation-linked raw segments. */
export function annotationExplanation(
  annotation: ExplanationAnnotation,
  segments: ExplanationSegment[],
): string | null {
  const saved = annotation.bubble_text?.trim()
  if (saved) return saved

  const linked = segments
    .filter((segment) => segment.annotation_id === annotation.id && segment.raw_text.trim())
    .sort((a, b) => (a.t_start ?? a.created_at).localeCompare(b.t_start ?? b.created_at))
    .map((segment) => segment.raw_text.trim())
    .join(' ')
  if (!linked) return null

  const cleaned = linked
    .replace(/\b(?:um+|uh+)\b[\s,]*/gi, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!cleaned) return null
  return cleaned[0].toUpperCase() + cleaned.slice(1)
}
