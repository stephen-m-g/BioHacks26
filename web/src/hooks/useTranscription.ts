// P3 owns this hook. Browser recognition is kept behind this provider boundary so a future
// realtime provider can preserve the same enabled/onFinal contract.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  CrossRunFinalDeduper,
  FinalResultTracker,
  calculateSpeechMetrics,
  countWords,
  getRecognitionErrorMessage,
  getRestartDelay,
  isFatalRecognitionError,
  stopRecognitionEngine,
  type SpeechMetrics,
  type SpeechSample,
  type TranscriptionContext,
} from './transcriptionModel'

type SpeechAlternative = { transcript: string; confidence: number }
type SpeechResult = { isFinal: boolean; 0: SpeechAlternative }
type SpeechEvent = { resultIndex: number; results: ArrayLike<SpeechResult> }
type SpeechErrorEvent = { error: string }

interface SpeechEngine {
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: (() => void) | null
  onresult: ((event: SpeechEvent) => void) | null
  onerror: ((event: SpeechErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

type SpeechConstructor = new () => SpeechEngine
export type TranscriptionResultHandler = (
  text: string,
  confidence: number | null,
  tStart: string,
  tEnd: string,
  context: TranscriptionContext | null,
) => void

export interface UseTranscriptionOptions {
  enabled: boolean
  onFinal: TranscriptionResultHandler
  /** Snapshot v2 session/annotation ownership when an utterance first appears. */
  captureContext?: () => TranscriptionContext
  /** Invalidates recognizer callbacks and metrics when the active session changes. */
  scopeKey?: string
}

interface UtteranceCapture {
  onFinal: TranscriptionResultHandler
  context: TranscriptionContext | null
  startedAt: string
}

const EMPTY_METRICS: SpeechMetrics = {
  rollingWpm: null,
  averageConfidence: null,
  baselineWpm: null,
}

function getRecognitionCtor(): SpeechConstructor | null {
  if (typeof window === 'undefined') return null
  const browser = window as Window & {
    SpeechRecognition?: SpeechConstructor
    webkitSpeechRecognition?: SpeechConstructor
  }
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null
}

/** Split long final results into board-friendly sentence segments. */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]*/g) ?? [text]
  return parts.map((part) => part.trim()).filter(Boolean)
}

export function useTranscription({ enabled, onFinal, captureContext, scopeKey }: UseTranscriptionOptions) {
  const [interim, setInterim] = useState('')
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [metrics, setMetrics] = useState<SpeechMetrics>(EMPTY_METRICS)
  const supported = getRecognitionCtor() !== null

  const onFinalRef = useRef(onFinal)
  const captureContextRef = useRef(captureContext)
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)
  const shouldListenRef = useRef(false)
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restartAttemptsRef = useRef(0)
  const samplesRef = useRef<SpeechSample[]>([])
  const metricsStartedAtRef = useRef<number | null>(null)
  const stopCurrentRef = useRef<() => Promise<void>>(() => Promise.resolve())

  onFinalRef.current = onFinal
  captureContextRef.current = captureContext
  enabledRef.current = enabled

  const stop = useCallback(() => stopCurrentRef.current(), [])

  const refreshMetrics = useCallback((now = Date.now()) => {
    setMetrics(calculateSpeechMetrics(samplesRef.current, now, metricsStartedAtRef.current))
  }, [])

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
    restartAttemptsRef.current = 0
    setInterim('')
    setListening(false)
    setError(null)
    setMetrics(EMPTY_METRICS)

    return () => {
      if (generationRef.current === generation) generationRef.current += 1
    }
  }, [scopeKey])

  useEffect(() => {
    const Engine = getRecognitionCtor()
    if (!enabled) {
      shouldListenRef.current = false
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current)
        restartTimerRef.current = null
      }
      setInterim('')
      setListening(false)
      return
    }
    if (!Engine) {
      setError('Speech recognition is not supported in this browser. Try Chrome or Safari.')
      return
    }

    const recognition = new Engine()
    const generation = generationRef.current
    const tracker = new FinalResultTracker()
    const crossRunDeduper = new CrossRunFinalDeduper()
    let recognitionRun = 0
    let disposed = false
    let stopPromise: Promise<void> | null = null
    let resolveStop: (() => void) | null = null
    let stopFallbackTimer: ReturnType<typeof setTimeout> | null = null
    const isCurrent = () => !disposed && generationRef.current === generation

    const detach = () => {
      if (disposed) return
      disposed = true
      if (stopFallbackTimer) clearTimeout(stopFallbackTimer)
      recognition.onstart = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      resolveStop?.()
      resolveStop = null
    }

    const requestStop = (): Promise<void> => {
      if (disposed) return Promise.resolve()
      if (stopPromise) return stopPromise
      shouldListenRef.current = false
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current)
        restartTimerRef.current = null
      }
      stopPromise = new Promise<void>((resolve) => {
        resolveStop = resolve
      })
      stopRecognitionEngine(recognition, true, detach)
      if (!disposed) stopFallbackTimer = setTimeout(detach, 1_000)
      return stopPromise
    }

    stopCurrentRef.current = requestStop

    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-CA'
    shouldListenRef.current = true
    restartAttemptsRef.current = 0
    setError(null)

    const scheduleRestart = () => {
      if (!isCurrent() || !shouldListenRef.current || restartTimerRef.current) return
      const delay = getRestartDelay(restartAttemptsRef.current)
      if (delay === null) {
        shouldListenRef.current = false
        setError('Speech recognition stopped repeatedly. Turn the microphone off and on to try again.')
        return
      }

      restartAttemptsRef.current += 1
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null
        if (!isCurrent() || !shouldListenRef.current) return
        try {
          recognition.start()
        } catch (startError) {
          console.warn('speech restart failed', startError)
          scheduleRestart()
        }
      }, delay)
    }

    recognition.onstart = () => {
      if (!isCurrent()) return
      if (metricsStartedAtRef.current === null) metricsStartedAtRef.current = Date.now()
      setListening(true)
      setError(null)
      refreshMetrics()
    }

    recognition.onresult = (event) => {
      if (!isCurrent()) return
      restartAttemptsRef.current = 0

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const captured = tracker.contextFor<UtteranceCapture>(index, () => ({
          onFinal: onFinalRef.current,
          context: captureContextRef.current?.() ?? null,
          startedAt: new Date().toISOString(),
        }))
        if (!result.isFinal || !tracker.claimFinal(index)) continue

        const text = String(result[0]?.transcript ?? '').trim()
        if (!text) continue
        const confidence = Number.isFinite(result[0]?.confidence) ? result[0].confidence : null
        const completedAt = Date.now()
        const endedAt = new Date(completedAt).toISOString()
        if (!crossRunDeduper.claim(text, confidence, index, recognitionRun, completedAt)) continue

        for (const sentence of splitSentences(text)) {
          captured.onFinal(sentence, confidence, captured.startedAt, endedAt, captured.context)
        }
        samplesRef.current = [
          ...samplesRef.current,
          { completedAt, wordCount: countWords(text), confidence },
        ]
        refreshMetrics(completedAt)
      }

      const partials: string[] = []
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (!result.isFinal) {
          const text = String(result[0]?.transcript ?? '').trim()
          if (text) partials.push(text)
        }
      }
      setInterim(partials.join(' '))
    }

    recognition.onerror = (event) => {
      if (!isCurrent()) return
      if (event.error === 'aborted' && !shouldListenRef.current) return
      setError(getRecognitionErrorMessage(event.error))
      if (isFatalRecognitionError(event.error)) shouldListenRef.current = false
    }

    recognition.onend = () => {
      if (!isCurrent()) return
      setListening(false)
      setInterim('')
      tracker.reset()
      recognitionRun += 1
      if (!shouldListenRef.current) {
        detach()
        return
      }
      scheduleRestart()
    }

    try {
      recognition.start()
    } catch (startError) {
      console.warn('speech start failed', startError)
      scheduleRestart()
    }

    return () => {
      shouldListenRef.current = false
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current)
        restartTimerRef.current = null
      }
      const flushFinalResult = enabledRef.current === false && generationRef.current === generation
      if (flushFinalResult) void requestStop()
      else stopRecognitionEngine(recognition, false, detach)
    }
  }, [enabled, refreshMetrics, scopeKey])

  return { interim, listening, supported, error, metrics, stop }
}
