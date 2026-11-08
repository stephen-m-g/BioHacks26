import type { Annotation, Block, NotesSection, TranscriptSegment } from '../types'

type ExplanationAnnotation = Pick<Annotation, 'id' | 'bubble_text'>
type ExplanationSegment = Pick<
  TranscriptSegment,
  'id' | 'annotation_id' | 'raw_text' | 't_start' | 't_end' | 'created_at' | 'text_block_id' | 'text_start' | 'text_end'
>

/** Accepted cleaned text by source block ID; the offsets on transcript segments index into these strings. */
export type SourceTexts = ReadonlyMap<string, string>

type ImageAnnotation = Pick<Annotation, 'id' | 'block_id' | 'status' | 'drawn_at'>

type SpanSegment = Pick<
  TranscriptSegment,
  'id' | 'text_block_id' | 'text_start' | 'text_end' | 'annotation_id'
>

/** Longer than the backend's 120s Gemini timeout plus the final refine, so a slow compile isn't duplicated. */
export const COMPILE_GRACE_MS = 180_000

/** How long the notes page waits for End session's compile before starting one itself; null while not ended. */
export function compileFallbackDelay(endedAt: string | null | undefined, now: number): number | null {
  if (!endedAt) return null
  return Math.max(0, Date.parse(endedAt) + COMPILE_GRACE_MS - now)
}

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

export const NO_EXPLANATION = 'No explanation recorded.'

export interface AnnotationCard {
  id: string
  title: string
  text: string
}

type CardAnnotation = ImageAnnotation & ExplanationAnnotation & Pick<Annotation, 'label'>

/** One compact card per confirmed circle on the image, keyed by the persisted annotation ID. */
export function annotationCardsForImage(
  annotations: CardAnnotation[],
  blockId: string,
  segments: ExplanationSegment[],
  sourceTexts: SourceTexts,
): AnnotationCard[] {
  return annotationsForImage(annotations, blockId).map((annotation, index) => ({
    id: annotation.id,
    title: annotation.label?.trim() || `Annotation ${index + 1}`,
    text: annotationExplanation(annotation, segments, sourceTexts) || NO_EXPLANATION,
  }))
}

/**
 * The text each segment's offsets index into: the displayed compiled paragraph when the notes map it to its
 * block, otherwise the block's stored cleaned text. Blocks without text (images, PDF pages) map to ''.
 */
export function annotationSourceTexts(
  blocks: Pick<Block, 'id' | 'text'>[],
  sections: Pick<NotesSection, 'paragraphs' | 'paragraph_block_ids'>[],
): SourceTexts {
  const texts = new Map<string, string>()
  for (const block of blocks) texts.set(block.id, block.text ?? '')
  for (const section of sections) {
    section.paragraph_block_ids?.forEach((blockId, index) => {
      const paragraph = section.paragraphs[index]
      if (paragraph !== undefined) texts.set(blockId, paragraph)
    })
  }
  return texts
}

/**
 * Gemini key terms restate what the teacher said about circled regions, so a section that shows
 * annotation cards drops its key terms, and no key term may repeat an annotation's title elsewhere.
 */
export function studyKeyTerms<T extends { term: string }>(
  keyTerms: T[],
  sectionHasAnnotationCards: boolean,
  annotationTitles: string[],
): T[] {
  if (sectionHasAnnotationCards) return []
  const normalize = (value: string) => value.trim().toLowerCase()
  const titles = new Set(annotationTitles.map(normalize))
  return keyTerms.filter((keyTerm) => !titles.has(normalize(keyTerm.term)))
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

function compareSpeechOrder(a: ExplanationSegment, b: ExplanationSegment): number {
  const aStart = a.t_start ?? a.created_at
  const bStart = b.t_start ?? b.created_at
  return (
    aStart.localeCompare(bStart) ||
    (a.t_end ?? aStart).localeCompare(b.t_end ?? bStart) ||
    a.created_at.localeCompare(b.created_at) ||
    a.id.localeCompare(b.id)
  )
}

function hasValidSpan(segment: ExplanationSegment, source: string): boolean {
  return (
    Number.isInteger(segment.text_start) &&
    Number.isInteger(segment.text_end) &&
    segment.text_start! >= 0 &&
    segment.text_end! > segment.text_start! &&
    segment.text_end! <= source.length
  )
}

/**
 * The circle's explanation is the exact cleaned text the transcript shows for its linked segments, sliced by
 * their persisted UTF-16 offsets and joined in speech order. A refined segment with null offsets was only
 * filler and contributes nothing. Lectures refined before offsets existed fall back to raw linked speech, then
 * the saved bubble.
 */
export function annotationExplanation(
  annotation: ExplanationAnnotation,
  segments: ExplanationSegment[],
  sourceTexts: SourceTexts,
): string | null {
  const linked = segments.filter((segment) => segment.annotation_id === annotation.id).sort(compareSpeechOrder)
  const blocksWithSpans = new Set(
    segments
      .filter((segment) => {
        const source = segment.text_block_id ? sourceTexts.get(segment.text_block_id) : undefined
        return source !== undefined && hasValidSpan(segment, source)
      })
      .map((segment) => segment.text_block_id),
  )

  let mapped = false
  const cleaned: string[] = []
  for (const segment of linked) {
    const source = segment.text_block_id ? sourceTexts.get(segment.text_block_id) : undefined
    if (source === undefined) continue
    if (hasValidSpan(segment, source)) {
      mapped = true
      cleaned.push(source.slice(segment.text_start!, segment.text_end!).trim())
    } else if (segment.text_start === null && segment.text_end === null) {
      // A filler-only batch has no paragraph of its own; otherwise its block's other segments carry offsets.
      if (!source.trim() || blocksWithSpans.has(segment.text_block_id)) mapped = true
    }
  }
  if (mapped) return cleaned.filter(Boolean).join(' ') || null
  return legacyExplanation(annotation, linked)
}

/** Old lectures without source offsets: raw linked speech with the original light cleanup, else the bubble. */
function legacyExplanation(annotation: ExplanationAnnotation, linked: ExplanationSegment[]): string | null {
  const raw = linked
    .map((segment) => segment.raw_text.trim())
    .filter(Boolean)
    .join(' ')
  if (!raw) return annotation.bubble_text?.trim() || null

  const cleaned = raw
    .replace(/\b(?:um+|uh+)\b[\s,]*/gi, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!cleaned) return null
  return cleaned[0].toUpperCase() + cleaned.slice(1)
}
