export interface TranscriptionContext {
  sessionId: string
  annotationId: string | null
}

export interface SpeechSample {
  completedAt: number
  wordCount: number
  confidence: number | null
}

export interface SpeechMetrics {
  rollingWpm: number | null
  averageConfidence: number | null
  baselineWpm: number | null
}

const ROLLING_WINDOW_MS = 60_000
const BASELINE_WINDOW_MS = 180_000
const MINIMUM_RATE_WINDOW_MS = 1_000
const RESTART_DELAYS_MS = [500, 1_000, 2_000] as const
const CROSS_RUN_DEDUP_WINDOW_MS = 5_000
const FATAL_RECOGNITION_ERRORS = new Set([
  'audio-capture',
  'language-not-supported',
  'not-allowed',
  'service-not-allowed',
])

/** Keeps an utterance's first context and prevents duplicate final callbacks per recognition run. */
export class FinalResultTracker {
  private contexts = new Map<number, unknown>()
  private handled = new Set<number>()

  contextFor<T>(index: number, capture: () => T): T {
    if (!this.contexts.has(index)) this.contexts.set(index, capture())
    return this.contexts.get(index) as T
  }

  claimFinal(index: number): boolean {
    if (this.handled.has(index)) return false
    this.handled.add(index)
    return true
  }

  reset(): void {
    this.contexts.clear()
    this.handled.clear()
  }
}

/** Suppresses a browser replay only when the same final crosses a recognition-run boundary. */
export class CrossRunFinalDeduper {
  private finals = new Map<string, { run: number; completedAt: number }>()

  claim(
    text: string,
    confidence: number | null,
    resultIndex: number,
    run: number,
    completedAt: number,
  ): boolean {
    const normalized = text.trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
    const fingerprint = `${normalized}\u0000${confidence ?? 'unknown'}\u0000${resultIndex}`
    const previous = this.finals.get(fingerprint)
    if (
      previous &&
      previous.run !== run &&
      completedAt - previous.completedAt <= CROSS_RUN_DEDUP_WINDOW_MS
    ) {
      return false
    }

    this.finals.set(fingerprint, { run, completedAt })
    for (const [key, value] of this.finals) {
      if (completedAt - value.completedAt > CROSS_RUN_DEDUP_WINDOW_MS) this.finals.delete(key)
    }
    return true
  }
}

interface StoppableRecognitionEngine {
  stop(): void
}

/** Intentional stops keep callbacks attached long enough for Web Speech to emit its final result. */
export function stopRecognitionEngine(
  engine: StoppableRecognitionEngine,
  flushFinalResult: boolean,
  detach: () => void,
): void {
  if (!flushFinalResult) detach()
  try {
    engine.stop()
  } catch {
    detach()
  }
}

/** Split long final results into board-friendly sentence segments. */
export function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]*/g) ?? [text]
  return parts.map((part) => part.trim()).filter(Boolean)
}

export function countWords(text: string): number {
  const normalized = text.trim()
  return normalized ? normalized.split(/\s+/u).length : 0
}

export function getRestartDelay(attemptsCompleted: number): number | null {
  return RESTART_DELAYS_MS[attemptsCompleted] ?? null
}

export function isFatalRecognitionError(error: string): boolean {
  return FATAL_RECOGNITION_ERRORS.has(error)
}

export function getRecognitionErrorMessage(error: string): string {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission was denied. Allow microphone access in the browser, then try again.'
    case 'audio-capture':
      return 'No working microphone was found. Check the microphone connection and system input settings.'
    case 'language-not-supported':
      return 'English (Canada) speech recognition is not supported by this browser.'
    case 'network':
      return 'Speech recognition lost its network connection. It will retry automatically.'
    case 'no-speech':
      return 'No speech was detected. Listening will resume automatically.'
    default:
      return `Speech recognition stopped (${error}). It will retry automatically.`
  }
}

export function calculateSpeechMetrics(
  samples: SpeechSample[],
  now: number,
  startedAt: number | null,
): SpeechMetrics {
  if (startedAt === null) return { rollingWpm: null, averageConfidence: null, baselineWpm: null }

  const rollingSamples = samples.filter((sample) => sample.completedAt > now - ROLLING_WINDOW_MS)
  const rollingWords = rollingSamples.reduce((total, sample) => total + sample.wordCount, 0)
  const rollingDurationMs = Math.min(ROLLING_WINDOW_MS, Math.max(MINIMUM_RATE_WINDOW_MS, now - startedAt))
  const confidences = rollingSamples
    .map((sample) => sample.confidence)
    .filter((confidence): confidence is number => confidence !== null)
  const baselineSamples = samples.filter((sample) => sample.completedAt <= startedAt + BASELINE_WINDOW_MS)
  const baselineWords = baselineSamples.reduce((total, sample) => total + sample.wordCount, 0)
  const baselineDurationMs = Math.min(BASELINE_WINDOW_MS, Math.max(MINIMUM_RATE_WINDOW_MS, now - startedAt))

  return {
    rollingWpm: Math.round(rollingWords / (rollingDurationMs / ROLLING_WINDOW_MS)),
    averageConfidence:
      confidences.length > 0
        ? confidences.reduce((total, confidence) => total + confidence, 0) / confidences.length
        : null,
    baselineWpm: Math.round(baselineWords / (baselineDurationMs / ROLLING_WINDOW_MS)),
  }
}
