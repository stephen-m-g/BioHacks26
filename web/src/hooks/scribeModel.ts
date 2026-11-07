// Pure helpers for the ElevenLabs Scribe Realtime provider (P3). No SDK imports so node:test can load it.
export type TranscriptionProvider = 'chrome' | 'elevenlabs'

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

/** ElevenLabs needs a real live session to mint a token, so demo sessions always use Chrome. */
export function resolveProvider(selected: TranscriptionProvider, demo: boolean): TranscriptionProvider {
  return selected === 'elevenlabs' && !demo ? 'elevenlabs' : 'chrome'
}

export interface ScribeFailure {
  message: string
  /** Fatal failures stop reconnecting until the teacher toggles the mic or switches provider. */
  fatal: boolean
}

const SWITCH_HINT = 'Switch to Chrome in the session menu to keep transcribing.'

/** `status` is the token endpoint's HTTP status, or undefined when the request never got a response. */
export function classifyTokenError(status: number | undefined): ScribeFailure {
  switch (status) {
    case undefined:
      return { message: 'Could not reach the API for an ElevenLabs token. Retrying…', fatal: false }
    case 503:
      return { message: `ElevenLabs is not configured on the API server. ${SWITCH_HINT}`, fatal: true }
    case 404:
    case 409:
      return { message: `ElevenLabs needs a live session saved in the database. ${SWITCH_HINT}`, fatal: true }
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
      return { message: `ElevenLabs rejected the session token. ${SWITCH_HINT}`, fatal }
    case 'quota':
      return { message: `The ElevenLabs quota is used up. ${SWITCH_HINT}`, fatal }
    case 'unaccepted_terms':
      return { message: `Accept the ElevenLabs terms in the ElevenLabs dashboard. ${SWITCH_HINT}`, fatal }
    case 'input':
      return { message: `ElevenLabs rejected the connection settings${detail ? ` (${detail})` : ''}. ${SWITCH_HINT}`, fatal }
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

/**
 * Tracks the in-progress Scribe segment. Context is captured when the first partial appears (like the
 * Chrome provider), and the last partial can be flushed if the stream ends before the server commits it.
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
