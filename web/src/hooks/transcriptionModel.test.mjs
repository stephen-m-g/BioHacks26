import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateSpeechMetrics, countWords, getRestartDelay } from './transcriptionModel.ts'

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

test('bounds automatic reconnects', () => {
  assert.equal(getRestartDelay(0), 500)
  assert.equal(getRestartDelay(1), 1_000)
  assert.equal(getRestartDelay(2), 2_000)
  assert.equal(getRestartDelay(3), null)
})
