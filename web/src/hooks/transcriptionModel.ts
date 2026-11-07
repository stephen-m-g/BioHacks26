// Provider-neutral helpers for the speech pipeline (P3). No SDK imports so node:test can load it.
export interface TranscriptionContext {
  sessionId: string
  annotationId: string | null
}

export type TranscriptionResultHandler = (
  text: string,
  confidence: number | null,
  tStart: string,
  tEnd: string,
  context: TranscriptionContext | null,
) => void

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
