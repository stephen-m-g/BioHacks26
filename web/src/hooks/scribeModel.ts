// Pure helpers for ElevenLabs Scribe Realtime transcription (P3). No SDK imports so node:test can load it.
export const SCRIBE_MODEL_ID = 'scribe_v2_realtime'

/** Scribe v2 Realtime accepts at most 50 keyterms of up to 20 characters each. */
export const MAX_KEYTERMS = 50
export const MAX_KEYTERM_LENGTH = 20

/** Starter biology vocabulary. Keyterm prompting is billed as an add-on by ElevenLabs. */
export const DEFAULT_BIOLOGY_KEYTERMS = [
  'mitochondria',
  'phosphorylation',
  'chlorophyll',
  'chloroplast',
  'photosynthesis',
  'glycolysis',
  'Krebs cycle',
  'ATP synthase',
  'ribosome',
  'Golgi apparatus',
  'cytoplasm',
  'meiosis',
  'mitosis',
  'cytokinesis',
  'chromosome',
  'chromatid',
  'centromere',
  'allele',
  'genotype',
  'phenotype',
  'homozygous',
  'heterozygous',
  'DNA polymerase',
  'transcription',
  'translation',
  'nucleotide',
  'osmosis',
  'diffusion',
  'enzyme',
  'substrate',
  'homeostasis',
]

/** Trim, drop terms the API would reject, dedupe case-insensitively and cap the list. */
export function normalizeKeyterms(terms: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of terms) {
    const term = raw.trim().replace(/\s+/gu, ' ')
    const key = term.toLocaleLowerCase()
    if (!term || term.length > MAX_KEYTERM_LENGTH || seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length === MAX_KEYTERMS) break
  }
  return out
}

/** Comma-separated override (VITE_ELEVENLABS_KEYTERMS); empty or missing keeps the defaults. */
export function parseKeyterms(value: string | undefined): string[] {
  const custom = normalizeKeyterms((value ?? '').split(','))
  return custom.length > 0 ? custom : normalizeKeyterms(DEFAULT_BIOLOGY_KEYTERMS)
}

export interface ScribeFailure {
  message: string
  /** Fatal failures stop reconnecting until the teacher toggles the mic. */
  fatal: boolean
}

const UNAVAILABLE_HINT = 'Transcription is unavailable until this is fixed; then turn the microphone off and on.'

/** `status` is the token endpoint's HTTP status, or undefined when the request never got a response. */
export function classifyTokenError(status: number | undefined): ScribeFailure {
  switch (status) {
    case undefined:
      return { message: 'Could not reach the API for an ElevenLabs token. Retrying…', fatal: false }
    case 503:
      return { message: `ElevenLabs is not configured on the API server (ELEVENLABS_API_KEY). ${UNAVAILABLE_HINT}`, fatal: true }
    case 404:
    case 409:
      return { message: `ElevenLabs needs a live session saved in the database. ${UNAVAILABLE_HINT}`, fatal: true }
    case 429:
      return { message: 'Too many ElevenLabs token requests. Retrying…', fatal: false }
    default:
      return { message: `ElevenLabs token request failed (${status}). Retrying…`, fatal: false }
  }
}

export type ScribeErrorKind =
  | 'auth'
  | 'quota'
  | 'unaccepted_terms'
  | 'rate_limited'
  | 'session_time_limit'
  | 'insufficient_audio'
  | 'resource_exhausted'
  | 'transcriber'
  | 'input'
  | 'other'

const FATAL_SCRIBE_ERRORS = new Set<ScribeErrorKind>(['auth', 'quota', 'unaccepted_terms', 'input'])

export function describeScribeError(kind: ScribeErrorKind, detail?: string): ScribeFailure {
  const fatal = FATAL_SCRIBE_ERRORS.has(kind)
  switch (kind) {
    case 'auth':
      return { message: `ElevenLabs rejected the session token. ${UNAVAILABLE_HINT}`, fatal }
    case 'quota':
      return { message: `The ElevenLabs quota is used up. ${UNAVAILABLE_HINT}`, fatal }
    case 'unaccepted_terms':
      return { message: `Accept the ElevenLabs terms in the ElevenLabs dashboard. ${UNAVAILABLE_HINT}`, fatal }
    case 'input':
      return { message: `ElevenLabs rejected the connection settings${detail ? ` (${detail})` : ''}. ${UNAVAILABLE_HINT}`, fatal }
    case 'rate_limited':
    case 'resource_exhausted':
      return { message: 'ElevenLabs is busy. Reconnecting…', fatal }
    case 'session_time_limit':
    case 'insufficient_audio':
      return { message: 'ElevenLabs ended the stream. Reconnecting…', fatal }
    default:
      return { message: `ElevenLabs connection problem${detail ? ` (${detail})` : ''}. Reconnecting…`, fatal }
  }
}

export function describeMicrophoneError(error: unknown): ScribeFailure {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { message: 'Microphone permission was denied. Allow microphone access in the browser, then try again.', fatal: true }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { message: 'No working microphone was found. Check the microphone connection and system input settings.', fatal: true }
    case 'NotReadableError':
      return { message: 'The microphone is in use by another app or could not be opened.', fatal: true }
    default:
      return { message: 'Could not open the microphone. Use HTTPS or localhost and check browser permissions.', fatal: true }
  }
}

interface Utterance<T> {
  capture: T
  text: string
}

export interface ScribeWordTimestamp {
  text?: string
  start?: number
  end?: number
  type?: 'word' | 'spacing' | 'audio_event'
}

export interface TimestampedTranscript {
  text: string
  tStart: string
  tEnd: string
}

export interface AnnotationCaptureInterval {
  annotationId: string
  drawnAt: string
  closedAt: string | null
}

export interface AnnotationTranscriptPart extends TimestampedTranscript {
  annotationId: string | null
  /** PDF page block that was active when these words were spoken; null = no page. */
  pageBlockId: string | null
}

/** Which PDF page was active at a wall-clock time. */
export interface PageLookup {
  /** The page at `ms`, null for no page, undefined if unknown (then `fallback` is used). */
  at: (ms: number) => string | null | undefined
  /** The page captured when the utterance began. */
  fallback: string | null
}

function pageAt(pages: PageLookup | undefined, ms: number): string | null {
  if (!pages) return null
  const page = pages.at(ms)
  return page === undefined ? pages.fallback : page
}

/** Convert Scribe's cumulative input-audio clock to persisted wall-clock occurrence times. */
export function timestampedTranscript(
  text: string,
  words: readonly ScribeWordTimestamp[] | undefined,
  audioStartedAt: number | null,
  fallbackStart: string,
  fallbackEnd: string,
): TimestampedTranscript {
  const starts = (words ?? []).map((word) => word.start).filter((value): value is number => Number.isFinite(value))
  const ends = (words ?? []).map((word) => word.end).filter((value): value is number => Number.isFinite(value))
  if (audioStartedAt === null || starts.length === 0 || ends.length === 0) {
    return { text, tStart: fallbackStart, tEnd: fallbackEnd }
  }
  return {
    text,
    tStart: new Date(audioStartedAt + Math.min(...starts) * 1_000).toISOString(),
    tEnd: new Date(audioStartedAt + Math.max(...ends) * 1_000).toISOString(),
  }
}

function containingInterval(
  startMs: number,
  endMs: number,
  intervals: readonly AnnotationCaptureInterval[],
): string | null {
  const interval = intervals.find((item) => {
    const drawnAt = Date.parse(item.drawnAt)
    const closedAt = item.closedAt ? Date.parse(item.closedAt) : Number.POSITIVE_INFINITY
    return drawnAt <= startMs && endMs <= closedAt
  })
  return interval?.annotationId ?? null
}

/**
 * Split a delayed commit at word boundaries and assign each word, by when it was spoken, to the Smart circle
 * open at that time and to the PDF page active at that time. Without complete word timing, the whole utterance
 * keeps the page captured when it began.
 */
export function partitionTimestampedTranscript(
  text: string,
  words: readonly ScribeWordTimestamp[] | undefined,
  audioStartedAt: number | null,
  fallbackStart: string,
  fallbackEnd: string,
  intervals: readonly AnnotationCaptureInterval[],
  pages?: PageLookup,
): AnnotationTranscriptPart[] {
  const wordsWithText = (words ?? []).filter((word): word is ScribeWordTimestamp & { text: string } =>
    typeof word.text === 'string',
  )
  const timedWords = (words ?? []).filter(
    (word): word is ScribeWordTimestamp & { text: string; start: number; end: number } =>
      typeof word.text === 'string' && Number.isFinite(word.start) && Number.isFinite(word.end),
  )
  const completeTiming =
    timedWords.length > 0 &&
    timedWords.length === wordsWithText.length &&
    wordsWithText.map((word) => word.text).join('') === text
  if (audioStartedAt === null || !completeTiming) {
    const startMs = Date.parse(fallbackStart)
    const endMs = Date.parse(fallbackEnd)
    const interval = intervals.find((item) => {
      const drawnAt = Date.parse(item.drawnAt)
      const closedAt = item.closedAt ? Date.parse(item.closedAt) : Number.POSITIVE_INFINITY
      return drawnAt <= startMs && endMs <= closedAt
    })
    return [{
      text,
      tStart: fallbackStart,
      tEnd: fallbackEnd,
      annotationId: interval?.annotationId ?? null,
      pageBlockId: pages?.fallback ?? null,
    }]
  }

  const parts: Array<{
    text: string
    startMs: number
    endMs: number
    annotationId: string | null
    pageBlockId: string | null
  }> = []
  for (const word of timedWords) {
    const startMs = audioStartedAt + word.start * 1_000
    const endMs = audioStartedAt + word.end * 1_000
    const annotationId = containingInterval(startMs, endMs, intervals)
    const pageBlockId = pageAt(pages, startMs)
    const current = parts.at(-1)
    if (current?.annotationId === annotationId && current.pageBlockId === pageBlockId) {
      current.text += word.text
      current.endMs = Math.max(current.endMs, endMs)
    } else {
      parts.push({ text: word.text, startMs, endMs, annotationId, pageBlockId })
    }
  }
  return parts
    .map((part) => ({
      text: part.text.trim(),
      tStart: new Date(part.startMs).toISOString(),
      tEnd: new Date(part.endMs).toISOString(),
      annotationId: part.annotationId,
      pageBlockId: part.pageBlockId,
    }))
    .filter((part) => part.text.length > 0)
}

/** Correlates delayed timestamp messages with stable commits, including repeated identical text. */
export class TimestampedCommitQueue<T> {
  private pending: Array<{ text: string; value: T }> = []

  push(text: string, value: T): void {
    this.pending.push({ text, value })
  }

  take(text: string): T | null {
    const index = this.pending.findIndex((item) => item.text === text)
    if (index < 0) return null
    return this.pending.splice(index, 1)[0].value
  }

  drain(): T[] {
    return this.pending.splice(0).map((item) => item.value)
  }
}

/**
 * Tracks the in-progress Scribe segment. Context is captured when the first partial appears (like the
 * board segment pipeline expects), and the last partial can be flushed if the stream ends before the server commits it.
 */
export class ScribeUtteranceBuffer<T> {
  private current: Utterance<T> | null = null

  partial(text: string, capture: () => T): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!this.current) this.current = { capture: capture(), text: trimmed }
    else this.current.text = trimmed
  }

  get pendingText(): string {
    return this.current?.text ?? ''
  }

  /** A committed transcript closes the current segment; returns null for empty commits. */
  commit(text: string, capture: () => T): Utterance<T> | null {
    const trimmed = text.trim()
    const capturedAt = this.current?.capture
    this.current = null
    if (!trimmed) return null
    return { capture: capturedAt ?? capture(), text: trimmed }
  }

  /** Takes the uncommitted partial, if any, so it is saved instead of lost. */
  flushPartial(): Utterance<T> | null {
    const pending = this.current
    this.current = null
    return pending
  }
}
