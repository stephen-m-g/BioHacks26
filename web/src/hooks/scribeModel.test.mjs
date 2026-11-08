import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_BIOLOGY_KEYTERMS,
  MAX_KEYTERMS,
  ScribeUtteranceBuffer,
  TimestampedCommitQueue,
  classifyTokenError,
  describeMicrophoneError,
  describeScribeError,
  normalizeKeyterms,
  parseKeyterms,
  partitionTimestampedTranscript,
  timestampedTranscript,
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

test('uses word occurrence times instead of delayed finalization time', () => {
  const timed = timestampedTranscript(
    'Today we learn mountains.',
    [
      { text: 'Today', start: 1.25, end: 1.6, type: 'word' },
      { text: ' ', start: 1.6, end: 1.6, type: 'spacing' },
      { text: 'we learn mountains.', start: 1.6, end: 2.8, type: 'word' },
    ],
    Date.parse('2026-11-07T19:00:00.000Z'),
    '2026-11-07T19:00:09.000Z',
    '2026-11-07T19:00:10.000Z',
  )

  assert.deepEqual(timed, {
    text: 'Today we learn mountains.',
    tStart: '2026-11-07T19:00:01.250Z',
    tEnd: '2026-11-07T19:00:02.800Z',
  })
})

test('matches delayed timestamp callbacks to the correct rapid commits', () => {
  const queue = new TimestampedCommitQueue()
  queue.push('Today we learn mountains.', { utterance: 'first' })
  queue.push('This is the summit.', { utterance: 'second' })

  assert.deepEqual(queue.take('This is the summit.'), { utterance: 'second' })
  assert.deepEqual(queue.take('Today we learn mountains.'), { utterance: 'first' })
  assert.equal(queue.take('Today we learn mountains.'), null)
})

test('keeps duplicate rapid commits stable when timestamp callbacks have identical text', () => {
  const queue = new TimestampedCommitQueue()
  queue.push('Okay.', { occurrence: 1 })
  queue.push('Okay.', { occurrence: 2 })

  assert.deepEqual(queue.take('Okay.'), { occurrence: 1 })
  assert.deepEqual(queue.take('Okay.'), { occurrence: 2 })
})

test('partitions words by the exact circle-to-checkmark intervals despite delayed finalization', () => {
  const parts = partitionTimestampedTranscript(
    'Before. First circle. Between. Second circle. After.',
    [
      { text: 'Before. ', start: 1, end: 1.8, type: 'word' },
      { text: 'First circle. ', start: 2.2, end: 3.5, type: 'word' },
      { text: 'Between. ', start: 4.2, end: 4.8, type: 'word' },
      { text: 'Second circle. ', start: 5.2, end: 6.5, type: 'word' },
      { text: 'After.', start: 7.2, end: 8, type: 'word' },
    ],
    Date.parse('2026-11-07T19:00:00.000Z'),
    '2026-11-07T19:00:09.000Z',
    '2026-11-07T19:00:10.000Z',
    [
      { annotationId: 'ann-a', drawnAt: '2026-11-07T19:00:02.000Z', closedAt: '2026-11-07T19:00:04.000Z' },
      { annotationId: 'ann-b', drawnAt: '2026-11-07T19:00:05.000Z', closedAt: '2026-11-07T19:00:07.000Z' },
    ],
  )

  assert.deepEqual(parts.map(({ text, annotationId }) => ({ text, annotationId })), [
    { text: 'Before.', annotationId: null },
    { text: 'First circle.', annotationId: 'ann-a' },
    { text: 'Between.', annotationId: null },
    { text: 'Second circle.', annotationId: 'ann-b' },
    { text: 'After.', annotationId: null },
  ])
  assert.equal(parts[1].tStart, '2026-11-07T19:00:02.200Z')
  assert.equal(parts[1].tEnd, '2026-11-07T19:00:03.500Z')
})

test('does not attach an unsplittable fallback utterance that crosses an interval boundary', () => {
  const parts = partitionTimestampedTranscript(
    'Speech crossing the checkmark.',
    undefined,
    null,
    '2026-11-07T19:00:03.500Z',
    '2026-11-07T19:00:04.500Z',
    [{ annotationId: 'ann-a', drawnAt: '2026-11-07T19:00:02.000Z', closedAt: '2026-11-07T19:00:04.000Z' }],
  )

  assert.deepEqual(parts.map(({ annotationId }) => annotationId), [null])
})

test('preserves the whole utterance when any word timing is missing instead of dropping words', () => {
  const parts = partitionTimestampedTranscript(
    'Every spoken word stays.',
    [
      { text: 'Every ', start: 2.1, end: 2.5, type: 'word' },
      { text: 'spoken ', type: 'word' },
      { text: 'word stays.', start: 3, end: 3.8, type: 'word' },
    ],
    Date.parse('2026-11-07T19:00:00.000Z'),
    '2026-11-07T19:00:02.100Z',
    '2026-11-07T19:00:03.800Z',
    [{ annotationId: 'ann-a', drawnAt: '2026-11-07T19:00:02.000Z', closedAt: '2026-11-07T19:00:04.000Z' }],
  )

  assert.deepEqual(parts, [{
    text: 'Every spoken word stays.',
    tStart: '2026-11-07T19:00:02.100Z',
    tEnd: '2026-11-07T19:00:03.800Z',
    annotationId: 'ann-a',
    pageBlockId: null,
  }])
})

test('splits an utterance at page changes using when each word was spoken, not when it arrived', () => {
  const t0 = Date.parse('2026-11-07T19:00:00.000Z')
  const changes = [
    [t0 + 0, 'p1'],
    [t0 + 3_000, 'p2'],
    [t0 + 6_000, 'p1'],
  ]
  const at = (ms) => changes.filter(([from]) => from <= ms).at(-1)?.[1]
  const parts = partitionTimestampedTranscript(
    'On this page. Next page here. Back again.',
    [
      { text: 'On this page. ', start: 1, end: 2.5, type: 'word' },
      { text: 'Next page here. ', start: 3.5, end: 5, type: 'word' },
      { text: 'Back again.', start: 6.5, end: 7.5, type: 'word' },
    ],
    t0,
    '2026-11-07T19:00:09.000Z',
    '2026-11-07T19:00:10.000Z',
    [{ annotationId: 'ann-a', drawnAt: '2026-11-07T19:00:03.200Z', closedAt: '2026-11-07T19:00:05.500Z' }],
    { at, fallback: 'p9' },
  )

  assert.deepEqual(parts.map(({ text, annotationId, pageBlockId }) => ({ text, annotationId, pageBlockId })), [
    { text: 'On this page.', annotationId: null, pageBlockId: 'p1' },
    { text: 'Next page here.', annotationId: 'ann-a', pageBlockId: 'p2' }, // annotations stay independent of pages
    { text: 'Back again.', annotationId: null, pageBlockId: 'p1' },
  ])
})

test('without word timing, the page captured when speech began is used', () => {
  const parts = partitionTimestampedTranscript(
    'No timings.',
    undefined,
    null,
    '2026-11-07T19:00:01.000Z',
    '2026-11-07T19:00:02.000Z',
    [],
    { at: () => 'p2', fallback: 'p1' },
  )
  assert.equal(parts[0].pageBlockId, 'p1')
})

test('words before any recorded page change fall back to the captured page; no lookup means no page', () => {
  const t0 = Date.parse('2026-11-07T19:00:00.000Z')
  const words = [{ text: 'Hello.', start: 1, end: 2, type: 'word' }]
  const args = ['Hello.', words, t0, '2026-11-07T19:00:01.000Z', '2026-11-07T19:00:02.000Z', []]
  assert.equal(partitionTimestampedTranscript(...args, { at: () => undefined, fallback: 'p1' })[0].pageBlockId, 'p1')
  assert.equal(partitionTimestampedTranscript(...args, { at: () => null, fallback: 'p1' })[0].pageBlockId, null)
  assert.equal(partitionTimestampedTranscript(...args)[0].pageBlockId, null)
})

test('does not attach a boundary-crossing word to either side', () => {
  const parts = partitionTimestampedTranscript(
    'before crossing inside',
    [
      { text: 'before ', start: 1, end: 1.7, type: 'word' },
      { text: 'crossing ', start: 1.8, end: 2.2, type: 'word' },
      { text: 'inside', start: 2.3, end: 2.8, type: 'word' },
    ],
    Date.parse('2026-11-07T19:00:00.000Z'),
    '2026-11-07T19:00:01.000Z',
    '2026-11-07T19:00:02.800Z',
    [{ annotationId: 'ann-a', drawnAt: '2026-11-07T19:00:02.000Z', closedAt: '2026-11-07T19:00:03.000Z' }],
  )

  assert.deepEqual(parts.map(({ text, annotationId }) => ({ text, annotationId })), [
    { text: 'before crossing', annotationId: null },
    { text: 'inside', annotationId: 'ann-a' },
  ])
})
