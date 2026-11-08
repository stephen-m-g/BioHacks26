// P3 owns this hook. ElevenLabs Scribe v2 Realtime is the only speech-to-text engine; it feeds
// final utterances to the segment pipeline through onFinal.
import { CommitStrategy, RealtimeEvents, useScribe, type UseScribeReturn, type WordTimestamp } from '@elevenlabs/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api } from '../lib/api'
import {
  SCRIBE_MODEL_ID,
  ScribeUtteranceBuffer,
  TimestampedCommitQueue,
  classifyTokenError,
  describeMicrophoneError,
  describeScribeError,
  parseKeyterms,
  partitionTimestampedTranscript,
  type AnnotationCaptureInterval,
  type ScribeErrorKind,
  type ScribeFailure,
} from './scribeModel'
import {
  calculateSpeechMetrics,
  countWords,
  getRestartDelay,
  type SpeechMetrics,
  type SpeechSample,
  type TranscriptionContext,
  type TranscriptionResultHandler,
} from './transcriptionModel'

const KEYTERMS = parseKeyterms(import.meta.env.VITE_ELEVENLABS_KEYTERMS)
const MICROPHONE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
/** How long an intentional stop waits for the server to commit the segment being spoken. */
const STOP_FLUSH_TIMEOUT_MS = 1_500

const EMPTY_METRICS: SpeechMetrics = { rollingWpm: null, averageConfidence: null, baselineWpm: null }

interface UtteranceCapture {
  onFinal: TranscriptionResultHandler
  context: TranscriptionContext | null
  startedAt: string
}

interface Attempt {
  generation: number
  buffer: ScribeUtteranceBuffer<UtteranceCapture>
  pendingCommits: TimestampedCommitQueue<{ capture: UtteranceCapture; text: string }>
  /** Wall-clock time of the first microphone audio frame; Scribe word times use this cumulative audio clock. */
  audioStartedAt: number | null
  detachAudioStarted: (() => void) | null
  /** scribe.connect() was called, so a close event belongs to this attempt. */
  connected: boolean
  stopping: Promise<void> | null
  failure: ScribeFailure | null
  onCommit: (() => void) | null
}

export interface UseScribeTranscriptionOptions {
  enabled: boolean
  /** Live session the API mints the single-use token for. */
  sessionId: string
  onFinal: TranscriptionResultHandler
  /** Snapshot v2 session/annotation ownership when an utterance first appears. */
  captureContext?: () => TranscriptionContext
  /** Current persisted/optimistic Smart-circle intervals, read when delayed word timings arrive. */
  captureAnnotationIntervals?: () => AnnotationCaptureInterval[]
  /** The PDF page active at a wall-clock time (undefined = unknown: the page captured at speech start applies). */
  capturePageAt?: (ms: number) => string | null | undefined
  /** Invalidates callbacks and metrics when the active session changes. */
  scopeKey?: string
}

function isSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof WebSocket !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  )
}

/** Surfaces permission errors with their DOMException name; the SDK only reports a message. */
async function preflightMicrophone(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  for (const track of stream.getTracks()) track.stop()
}

export function useScribeTranscription({
  enabled,
  sessionId,
  onFinal,
  captureContext,
  captureAnnotationIntervals,
  capturePageAt,
  scopeKey,
}: UseScribeTranscriptionOptions) {
  const [interim, setInterim] = useState('')
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [metrics, setMetrics] = useState<SpeechMetrics>(EMPTY_METRICS)
  const supported = isSupported()

  const onFinalRef = useRef(onFinal)
  const captureContextRef = useRef(captureContext)
  const captureAnnotationIntervalsRef = useRef(captureAnnotationIntervals)
  const capturePageAtRef = useRef(capturePageAt)
  const sessionIdRef = useRef(sessionId)
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)
  const attemptRef = useRef<Attempt | null>(null)
  const shouldListenRef = useRef(false)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retriesRef = useRef(0)
  const samplesRef = useRef<SpeechSample[]>([])
  const metricsStartedAtRef = useRef<number | null>(null)
  const scribeRef = useRef<UseScribeReturn | null>(null)

  onFinalRef.current = onFinal
  captureContextRef.current = captureContext
  captureAnnotationIntervalsRef.current = captureAnnotationIntervals
  capturePageAtRef.current = capturePageAt
  sessionIdRef.current = sessionId
  enabledRef.current = enabled

  const refreshMetrics = useCallback((now = Date.now()) => {
    setMetrics(calculateSpeechMetrics(samplesRef.current, now, metricsStartedAtRef.current))
  }, [])

  // Everything below reads refs only, so closures from any render behave the same.
  const isLive = (attempt: Attempt) => attemptRef.current === attempt && attempt.generation === generationRef.current

  const capture = (): UtteranceCapture => ({
    onFinal: onFinalRef.current,
    context: captureContextRef.current?.() ?? null,
    startedAt: new Date().toISOString(),
  })

  const save = (
    captured: UtteranceCapture,
    text: string,
    tStart: string,
    tEnd: string,
    annotationId: string | null,
    pageBlockId: string | null,
  ) => {
    const completedAt = Date.now()
    const context = captured.context ? { ...captured.context, annotationId, pageBlockId } : null
    captured.onFinal(text, null, tStart, tEnd, context)
    samplesRef.current = [...samplesRef.current, { completedAt, wordCount: countWords(text), confidence: null }]
    refreshMetrics(completedAt)
  }

  const saveParts = (captured: UtteranceCapture, text: string, words: WordTimestamp[] | undefined) => {
    const endedAt = new Date().toISOString()
    const intervals = captureAnnotationIntervalsRef.current?.() ?? []
    const pageAt = capturePageAtRef.current
    const parts = partitionTimestampedTranscript(
      text,
      words,
      attemptRef.current?.audioStartedAt ?? null,
      captured.startedAt,
      endedAt,
      intervals,
      { at: (ms) => pageAt?.(ms), fallback: captured.context?.pageBlockId ?? null },
    )
    for (const part of parts) save(captured, part.text, part.tStart, part.tEnd, part.annotationId, part.pageBlockId)
  }

  const saveFallback = ({ capture: captured, text }: { capture: UtteranceCapture; text: string }) =>
    saveParts(captured, text, undefined)

  const clearRetry = () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null
  }

  /** Closes the attempt. `flush` saves an uncommitted partial instead of dropping it. */
  const endAttempt = (attempt: Attempt, flush: boolean) => {
    if (attemptRef.current !== attempt) return
    if (flush && attempt.generation === generationRef.current) {
      const leftover = attempt.buffer.flushPartial()
      if (leftover) saveFallback(leftover)
      for (const pending of attempt.pendingCommits.drain()) {
        saveFallback(pending)
      }
    }
    attempt.detachAudioStarted?.()
    attemptRef.current = null
    attempt.onCommit?.()
    scribeRef.current?.disconnect()
    setListening(false)
    setInterim('')
  }

  const scheduleReconnect = (generation: number) => {
    if (!shouldListenRef.current || retryTimerRef.current || generationRef.current !== generation) return
    const delay = getRestartDelay(retriesRef.current)
    if (delay === null) {
      shouldListenRef.current = false
      setError('ElevenLabs disconnected repeatedly. Turn the microphone off and on to retry.')
      return
    }
    retriesRef.current += 1
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null
      if (shouldListenRef.current && generationRef.current === generation && !attemptRef.current) void begin(generation)
    }, delay)
  }

  const begin = async (generation: number) => {
    const attempt: Attempt = {
      generation,
      buffer: new ScribeUtteranceBuffer<UtteranceCapture>(),
      pendingCommits: new TimestampedCommitQueue<{ capture: UtteranceCapture; text: string }>(),
      audioStartedAt: null,
      detachAudioStarted: null,
      connected: false,
      stopping: null,
      failure: null,
      onCommit: null,
    }
    attemptRef.current = attempt
    const failed = (failure: ScribeFailure) => {
      if (!isLive(attempt)) return
      attemptRef.current = null
      setError(failure.message)
      if (failure.fatal) shouldListenRef.current = false
      else scheduleReconnect(generation)
    }

    try {
      await preflightMicrophone()
    } catch (micError) {
      failed(describeMicrophoneError(micError))
      return
    }
    if (!isLive(attempt)) return

    let token: string
    try {
      token = (await api.scribeToken(sessionIdRef.current)).token
    } catch (tokenError) {
      console.warn('scribe token failed', tokenError)
      failed(classifyTokenError(tokenError instanceof ApiError ? tokenError.status : undefined))
      return
    }
    if (!isLive(attempt) || !scribeRef.current) return

    attempt.connected = true
    try {
      await scribeRef.current.connect({ token })
      const connection = scribeRef.current.getConnection()
      if (connection) {
        const markAudioStarted = () => {
          if (isLive(attempt) && attempt.audioStartedAt === null) attempt.audioStartedAt = Date.now()
        }
        connection.on(RealtimeEvents.AUDIO_STARTED, markAudioStarted)
        attempt.detachAudioStarted = () => connection.off(RealtimeEvents.AUDIO_STARTED, markAudioStarted)
      }
    } catch (connectError) {
      attempt.connected = false
      failed(describeScribeError('other', connectError instanceof Error ? connectError.message : undefined))
    }
  }

  const flushAndEnd = async (attempt: Attempt) => {
    const scribe = scribeRef.current
    if (scribe && attempt.connected && isLive(attempt)) {
      try {
        scribe.mute()
      } catch {
        // microphone not attached yet
      }
      try {
        scribe.commit()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, STOP_FLUSH_TIMEOUT_MS)
          attempt.onCommit = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      } catch {
        // socket already closed; endAttempt saves the partial
      }
    }
    endAttempt(attempt, true)
  }

  /** Commit the current audio boundary without stopping the microphone (used by Smart ✓). */
  const flushCurrent = async () => {
    const attempt = attemptRef.current
    const scribe = scribeRef.current
    if (!attempt || !scribe || !attempt.connected || !isLive(attempt)) return
    try {
      scribe.commit()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STOP_FLUSH_TIMEOUT_MS)
        attempt.onCommit = () => {
          attempt.onCommit = null
          clearTimeout(timer)
          resolve()
        }
      })
    } catch {
      // The interval is already closed locally; the next VAD callback is still assigned by word time.
    }
  }

  const requestStop = (): Promise<void> => {
    shouldListenRef.current = false
    clearRetry()
    const attempt = attemptRef.current
    if (!attempt) {
      setListening(false)
      setInterim('')
      return Promise.resolve()
    }
    attempt.stopping ??= flushAndEnd(attempt)
    return attempt.stopping
  }

  const hardStop = () => {
    shouldListenRef.current = false
    clearRetry()
    const attempt = attemptRef.current
    attemptRef.current = null
    attempt?.onCommit?.()
    scribeRef.current?.disconnect()
  }

  const events = {
    sessionStarted() {
      const attempt = attemptRef.current
      if (!attempt || !isLive(attempt)) return
      if (metricsStartedAtRef.current === null) metricsStartedAtRef.current = Date.now()
      setListening(true)
      setError(null)
      refreshMetrics()
    },
    partial(text: string) {
      const attempt = attemptRef.current
      if (!attempt || !isLive(attempt)) return
      retriesRef.current = 0
      attempt.buffer.partial(text, capture)
      setInterim(attempt.buffer.pendingText)
    },
    committed(text: string) {
      const attempt = attemptRef.current
      if (!attempt || !isLive(attempt)) return
      retriesRef.current = 0
      const utterance = attempt.buffer.commit(text, capture)
      setInterim('')
      if (utterance) attempt.pendingCommits.push(utterance.text, utterance)
      else attempt.onCommit?.()
    },
    timestamped(text: string, words: WordTimestamp[] | undefined) {
      const attempt = attemptRef.current
      if (!attempt || !isLive(attempt)) return
      const pending = attempt.pendingCommits.take(text)
      if (!pending) return
      saveParts(pending.capture, text, words)
      // The SDK keeps every committed segment in state; the board already has them.
      scribeRef.current?.clearTranscripts()
      attempt.onCommit?.()
    },
    fail(kind: ScribeErrorKind, detail?: string) {
      const attempt = attemptRef.current
      if (!attempt || !isLive(attempt) || attempt.stopping) return
      // The SDK reports a specific error first, then the same one again through onError.
      if (kind === 'other' && attempt.failure) return
      const failure = describeScribeError(kind, detail)
      attempt.failure = failure
      setError(failure.message)
      if (failure.fatal) {
        shouldListenRef.current = false
        endAttempt(attempt, true)
      }
    },
    closed() {
      const attempt = attemptRef.current
      // Intentional stops clear the attempt first; an attempt still fetching its token isn't connected.
      if (!attempt || !attempt.connected) return
      const generation = attempt.generation
      endAttempt(attempt, true)
      if (!attempt.failure && shouldListenRef.current) setError('ElevenLabs connection closed. Reconnecting…')
      scheduleReconnect(generation)
    },
  }
  const eventsRef = useRef(events)
  eventsRef.current = events
  const stopRef = useRef(requestStop)
  stopRef.current = requestStop
  const flushRef = useRef(flushCurrent)
  flushRef.current = flushCurrent

  const callbacks = useMemo(() => {
    const fail = (kind: ScribeErrorKind) => (data: { error: string }) => eventsRef.current.fail(kind, data.error)
    return {
      onSessionStarted: () => eventsRef.current.sessionStarted(),
      onPartialTranscript: (data: { text: string }) => eventsRef.current.partial(data.text),
      onCommittedTranscript: (data: { text: string }) => eventsRef.current.committed(data.text),
      onCommittedTranscriptWithTimestamps: (data: { text: string; words?: WordTimestamp[] }) =>
        eventsRef.current.timestamped(data.text, data.words),
      onAuthError: fail('auth'),
      onQuotaExceededError: fail('quota'),
      onUnacceptedTermsError: fail('unaccepted_terms'),
      onRateLimitedError: fail('rate_limited'),
      onResourceExhaustedError: fail('resource_exhausted'),
      onSessionTimeLimitExceededError: fail('session_time_limit'),
      onInsufficientAudioActivityError: fail('insufficient_audio'),
      onTranscriberError: fail('transcriber'),
      onInputError: fail('input'),
      onError: (err: Error | Event) => eventsRef.current.fail('other', err instanceof Error ? err.message : undefined),
      onDisconnect: () => eventsRef.current.closed(),
    }
  }, [])

  const scribe = useScribe({
    modelId: SCRIBE_MODEL_ID,
    commitStrategy: CommitStrategy.VAD,
    languageCode: 'en',
    keyterms: KEYTERMS,
    microphone: MICROPHONE,
    includeTimestamps: true,
    ...callbacks,
  })
  scribeRef.current = scribe

  const stop = useCallback(() => stopRef.current(), [])
  const flush = useCallback(() => flushRef.current(), [])

  useEffect(() => {
    if (!listening) return
    const timer = window.setInterval(refreshMetrics, 1_000)
    return () => window.clearInterval(timer)
  }, [listening, refreshMetrics])

  // Layout cleanup invalidates old callbacks before passive-effect cleanup runs on a route change.
  useLayoutEffect(() => {
    const generation = ++generationRef.current
    samplesRef.current = []
    metricsStartedAtRef.current = null
    retriesRef.current = 0
    setInterim('')
    setListening(false)
    setError(null)
    setMetrics(EMPTY_METRICS)

    return () => {
      if (generationRef.current === generation) generationRef.current += 1
    }
  }, [scopeKey])

  useEffect(() => {
    if (!enabled) {
      shouldListenRef.current = false
      clearRetry()
      setInterim('')
      setListening(false)
      return
    }
    if (!supported) {
      setError('ElevenLabs needs microphone access on a secure page (HTTPS or localhost) in a modern browser.')
      return
    }

    const generation = generationRef.current
    shouldListenRef.current = true
    retriesRef.current = 0
    setError(null)
    void begin(generation)

    return () => {
      const flushFinalResult = enabledRef.current === false && generationRef.current === generation
      if (flushFinalResult) void requestStop()
      else hardStop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, scopeKey, supported])

  return { interim, listening, supported, error, metrics, confidenceSupported: false, stop, flush }
}
