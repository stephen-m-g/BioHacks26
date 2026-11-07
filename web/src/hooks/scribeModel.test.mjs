import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_BIOLOGY_KEYTERMS,
  MAX_KEYTERMS,
  ScribeUtteranceBuffer,
  classifyTokenError,
  describeMicrophoneError,
  describeScribeError,
  normalizeKeyterms,
  parseKeyterms,
} from './scribeModel.ts'
import { splitSentences } from './transcriptionModel.ts'

test('keeps keyterms within the Scribe Realtime limits', () => {
  const terms = normalizeKeyterms([' mitochondria ', 'Mitochondria', '', 'a'.repeat(21), 'ATP   synthase'])
  assert.deepEqual(terms, ['mitochondria', 'ATP synthase'])

  const many = normalizeKeyterms(Array.from({ length: 80 }, (_, i) => `term${i}`))
  assert.equal(many.length, MAX_KEYTERMS)
})

test('default biology keyterms are all valid', () => {
  assert.deepEqual(normalizeKeyterms(DEFAULT_BIOLOGY_KEYTERMS), DEFAULT_BIOLOGY_KEYTERMS)
  assert.ok(DEFAULT_BIOLOGY_KEYTERMS.includes('phosphorylation'))
  assert.ok(DEFAULT_BIOLOGY_KEYTERMS.includes('chlorophyll'))
})

test('a keyterm env override replaces the defaults, and an empty one keeps them', () => {
  assert.deepEqual(parseKeyterms('osmosis, Calvin cycle ,'), ['osmosis', 'Calvin cycle'])
  assert.deepEqual(parseKeyterms(undefined), DEFAULT_BIOLOGY_KEYTERMS)
  assert.deepEqual(parseKeyterms(' , '), DEFAULT_BIOLOGY_KEYTERMS)
})

test('token failures that retrying cannot fix are fatal and say transcription is unavailable', () => {
  for (const status of [503, 404, 409]) {
    const failure = classifyTokenError(status)
    assert.equal(failure.fatal, true)
    assert.match(failure.message, /Transcription is unavailable/)
    assert.doesNotMatch(failure.message, /Chrome/i)
  }
  for (const status of [undefined, 429, 502, 500]) assert.equal(classifyTokenError(status).fatal, false)
  assert.match(classifyTokenError(503).message, /not configured/)
})

test('auth, quota and terms errors stop reconnecting; transient ones retry', () => {
  for (const kind of ['auth', 'quota', 'unaccepted_terms', 'input']) {
    const failure = describeScribeError(kind)
    assert.equal(failure.fatal, true)
    assert.doesNotMatch(failure.message, /Chrome/i)
  }
  for (const kind of ['rate_limited', 'session_time_limit', 'insufficient_audio', 'transcriber', 'other']) {
    assert.equal(describeScribeError(kind).fatal, false)
  }
})

test('microphone errors are actionable and fatal', () => {
  assert.match(describeMicrophoneError(new DOMException('denied', 'NotAllowedError')).message, /permission/i)
  assert.match(describeMicrophoneError({ name: 'NotFoundError' }).message, /No working microphone/)
  assert.match(describeMicrophoneError(new TypeError('no mediaDevices')).message, /HTTPS or localhost/)
  assert.equal(describeMicrophoneError(null).fatal, true)
})

test('captures context at the first partial and keeps it through the commit', () => {
  const buffer = new ScribeUtteranceBuffer()
  let annotation = 'annotation-a'
  const capture = () => ({ annotation })

  buffer.partial('the mito', capture)
  annotation = 'annotation-b'
  buffer.partial('the mitochondria makes', capture)
  assert.equal(buffer.pendingText, 'the mitochondria makes')

  const committed = buffer.commit('The mitochondria makes ATP.', capture)
  assert.deepEqual(committed, { capture: { annotation: 'annotation-a' }, text: 'The mitochondria makes ATP.' })
  assert.equal(buffer.pendingText, '')
})

test('a commit without partials captures context then, and empty commits are dropped', () => {
  const buffer = new ScribeUtteranceBuffer()
  assert.deepEqual(buffer.commit(' Osmosis. ', () => 'now'), { capture: 'now', text: 'Osmosis.' })

  buffer.partial('um', () => 'first')
  assert.equal(buffer.commit('   ', () => 'second'), null)
  assert.equal(buffer.flushPartial(), null)
})

test('flushes an uncommitted partial exactly once', () => {
  const buffer = new ScribeUtteranceBuffer()
  buffer.partial('   ', () => 'ignored')
  assert.equal(buffer.flushPartial(), null)

  buffer.partial('chlorophyll absorbs light', () => 'ctx')
  assert.deepEqual(buffer.flushPartial(), { capture: 'ctx', text: 'chlorophyll absorbs light' })
  assert.equal(buffer.flushPartial(), null)
})

test('splits committed text into sentence segments', () => {
  assert.deepEqual(splitSentences('Cells divide. Then what? They grow!'), ['Cells divide.', 'Then what?', 'They grow!'])
  assert.deepEqual(splitSentences('no punctuation here'), ['no punctuation here'])
})
