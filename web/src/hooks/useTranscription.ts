// P3 owns this hook. Basic Web Speech API version so the board works end to end; harden it or
// swap in Deepgram (see the P3 role notes) if iPad Safari is unreliable.
import { useEffect, useRef, useState } from 'react'

type OnFinal = (text: string, confidence: number | null, tStart: string, tEnd: string) => void

/* eslint-disable @typescript-eslint/no-explicit-any */
function getRecognitionCtor(): any {
  if (typeof window === 'undefined') return null
  const w = window as any
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Split long results into roughly sentence-length pieces. */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]*/g) ?? [text]
  return parts.map((p) => p.trim()).filter(Boolean)
}

export function useTranscription({ enabled, onFinal }: { enabled: boolean; onFinal: OnFinal }) {
  const [interim, setInterim] = useState('')
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = getRecognitionCtor() !== null
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal

  useEffect(() => {
    const Ctor = getRecognitionCtor()
    if (!enabled || !Ctor) return
    let stopped = false
    let rec: any = null
    let utteranceStart: string | null = null

    const start = () => {
      rec = new Ctor()
      rec.continuous = true
      rec.interimResults = true
      rec.lang = 'en-CA'
      rec.onstart = () => {
        setListening(true)
        setError(null)
      }
      rec.onresult = (e: any) => {
        let interimText = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]
          utteranceStart ??= new Date().toISOString()
          if (r.isFinal) {
            const text = String(r[0].transcript ?? '').trim()
            const end = new Date().toISOString()
            for (const part of splitSentences(text)) onFinalRef.current(part, r[0].confidence || null, utteranceStart, end)
            utteranceStart = null
          } else {
            interimText += r[0].transcript
          }
        }
        setInterim(interimText)
      }
      rec.onerror = (e: any) => {
        setError(e.error)
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') stopped = true
      }
      // Safari and Chrome stop on their own after silence; restart unless we were turned off.
      rec.onend = () => {
        setListening(false)
        if (!stopped) setTimeout(() => !stopped && start(), 250)
      }
      try {
        rec.start()
      } catch (err) {
        console.warn('speech start failed', err)
      }
    }

    start()
    return () => {
      stopped = true
      rec?.stop()
      setInterim('')
      setListening(false)
    }
  }, [enabled])

  return { interim, listening, supported, error }
}
