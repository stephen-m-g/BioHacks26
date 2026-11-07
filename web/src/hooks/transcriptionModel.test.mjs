import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FinalResultTracker,
  CrossRunFinalDeduper,
  calculateSpeechMetrics,
  countWords,
  getRecognitionErrorMessage,
  getRestartDelay,
  isFatalRecognitionError,
  stopRecognitionEngine,
} from './transcriptionModel.ts'

test('deduplicates a final result while preserving its first captured context', () => {
  const tracker = new FinalResultTracker()
  let activeSession = 'session-a'

  const first = tracker.contextFor(4, () => ({ sessionId: activeSession, annotationId: 'annotation-a' }))
  activeSession = 'session-b'
  const repeated = tracker.contextFor(4, () => ({ sessionId: activeSession, annotationId: null }))

  assert.deepEqual(first, { sessionId: 'session-a', annotationId: 'annotation-a' })
  assert.equal(repeated, first)
  assert.equal(tracker.claimFinal(4), true)
  assert.equal(tracker.claimFinal(4), false)
})

test('clears result indexes and captured context for a new recognition run', () => {
  const tracker = new FinalResultTracker()
  tracker.contextFor(1, () => ({ sessionId: 'old' }))
  tracker.claimFinal(1)

  tracker.reset()

  assert.deepEqual(tracker.contextFor(1, () => ({ sessionId: 'new' })), { sessionId: 'new' })
  assert.equal(tracker.claimFinal(1), true)
})

test('deduplicates a replayed final across automatic recognition restarts', () => {
  const deduper = new CrossRunFinalDeduper()

  assert.equal(deduper.claim('Cells divide.', 0.91, 4, 0, 1_000), true)
  assert.equal(deduper.claim('Cells divide.', 0.91, 4, 0, 1_100), true)
  assert.equal(deduper.claim('Cells divide.', 0.91, 4, 1, 1_600), false)
  assert.equal(deduper.claim('Cells divide.', 0.91, 4, 2, 7_000), true)
})

test('keeps legitimate repeated text when replay evidence differs', () => {
  const deduper = new CrossRunFinalDeduper()

  assert.equal(deduper.claim('Okay.', 0.71, 0, 0, 1_000), true)
  assert.equal(deduper.claim('Okay.', 0.82, 0, 1, 1_500), true)
  assert.equal(deduper.claim('Okay.', 0.82, 1, 2, 1_800), true)
})

test('keeps final-result handling attached while an intentional stop flushes audio', () => {
  const tracker = new FinalResultTracker()
  let saved = 0
  let onFinal = () => {
    if (tracker.claimFinal(0)) saved += 1
  }
  const engine = { stop: () => onFinal() }
  const detach = () => {
    onFinal = () => undefined
  }

  stopRecognitionEngine(engine, true, detach)
  detach()
  stopRecognitionEngine(engine, false, detach)

  assert.equal(saved, 1)
})

test('counts spoken words while ignoring repeated whitespace', () => {
  assert.equal(countWords('  cells   divide twice '), 3)
  assert.equal(countWords('   '), 0)
})

test('calculates rolling WPM and averages only available confidence', () => {
  const metrics = calculateSpeechMetrics(
    [
      { completedAt: 30_000, wordCount: 10, confidence: 0.6 },
      { completedAt: 60_000, wordCount: 20, confidence: null },
      { completedAt: 80_000, wordCount: 10, confidence: 0.8 },
    ],
    80_000,
    0,
  )

  assert.equal(metrics.rollingWpm, 40)
  assert.equal(metrics.averageConfidence, 0.7)
  assert.equal(metrics.baselineWpm, 30)
})

test('freezes baseline at samples completed in the first three minutes', () => {
  const metrics = calculateSpeechMetrics(
    [
      { completedAt: 60_000, wordCount: 60, confidence: 0.9 },
      { completedAt: 180_000, wordCount: 120, confidence: 0.8 },
      { completedAt: 240_000, wordCount: 200, confidence: 0.7 },
    ],
    240_000,
    0,
  )

  assert.equal(metrics.baselineWpm, 60)
})

test('bounds automatic restarts and stops retrying after fatal errors', () => {
  assert.equal(getRestartDelay(0), 500)
  assert.equal(getRestartDelay(1), 1_000)
  assert.equal(getRestartDelay(2), 2_000)
  assert.equal(getRestartDelay(3), null)
  assert.equal(isFatalRecognitionError('network'), false)
  assert.equal(isFatalRecognitionError('not-allowed'), true)
  assert.equal(isFatalRecognitionError('service-not-allowed'), true)
  assert.equal(isFatalRecognitionError('audio-capture'), true)
})

test('provides actionable recognition error messages', () => {
  assert.match(getRecognitionErrorMessage('not-allowed'), /permission/i)
  assert.match(getRecognitionErrorMessage('audio-capture'), /microphone/i)
  assert.match(getRecognitionErrorMessage('network'), /network/i)
})
