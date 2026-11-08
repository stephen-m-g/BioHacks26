import type { Annotation, TranscriptSegment } from '../types'

type ExplanationAnnotation = Pick<Annotation, 'id' | 'bubble_text'>
type ExplanationSegment = Pick<TranscriptSegment, 'annotation_id' | 'raw_text' | 't_start' | 'created_at'>

type ImageAnnotation = Pick<Annotation, 'id' | 'block_id' | 'status' | 'drawn_at'>

type SpanSegment = Pick<
  TranscriptSegment,
  'id' | 'text_block_id' | 'text_start' | 'text_end' | 'annotation_id'
>

export interface TranscriptParagraphPart {
  text: string
  segmentId: string | null
  annotationId: string | null
}

export function isTranscriptPartHighlighted(
  part: TranscriptParagraphPart,
  selectedAnnotationId: string | null,
): boolean {
  return selectedAnnotationId !== null && part.annotationId === selectedAnnotationId
}

/** Cards are a one-to-one projection of persisted confirmed circles, never Gemini's selection. */
export function annotationsForImage<T extends ImageAnnotation>(annotations: T[], blockId: string): T[] {
  return annotations
    .filter((annotation) => annotation.block_id === blockId && annotation.status === 'confirmed')
    .sort((a, b) => a.drawn_at.localeCompare(b.drawn_at) || a.id.localeCompare(b.id))
}

/** Build display spans only from persisted source offsets; invalid/legacy mappings remain unhighlighted. */
export function transcriptParagraphParts(
  paragraph: string,
  blockId: string | undefined,
  segments: SpanSegment[],
): TranscriptParagraphPart[] {
  if (!blockId) return [{ text: paragraph, segmentId: null, annotationId: null }]
  const linked = segments
    .filter(
      (segment) =>
        segment.text_block_id === blockId &&
        Number.isInteger(segment.text_start) &&
        Number.isInteger(segment.text_end) &&
        segment.text_start! >= 0 &&
        segment.text_end! > segment.text_start! &&
        segment.text_end! <= paragraph.length,
    )
    .sort((a, b) => a.text_start! - b.text_start! || a.text_end! - b.text_end! || a.id.localeCompare(b.id))
  const parts: TranscriptParagraphPart[] = []
  let cursor = 0
  for (const segment of linked) {
    const start = segment.text_start!
    const end = segment.text_end!
    if (start < cursor) continue
    if (start > cursor) parts.push({ text: paragraph.slice(cursor, start), segmentId: null, annotationId: null })
    parts.push({ text: paragraph.slice(start, end), segmentId: segment.id, annotationId: segment.annotation_id })
    cursor = end
  }
  if (cursor < paragraph.length) {
    parts.push({ text: paragraph.slice(cursor), segmentId: null, annotationId: null })
  }
  return parts.length > 0 ? parts : [{ text: paragraph, segmentId: null, annotationId: null }]
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
