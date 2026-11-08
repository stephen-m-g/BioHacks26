import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RefineCoordinator,
  buildTranscriptSegment,
  flushSpeechAndWaitForPendingWrites,
  segmentInsertRow,
  waitForPendingWrites,
} from './teacherActionsModel.ts'

const base = {
  id: 'segment-1',
  defaultSessionId: 'session-current',
  rawText: 'Mitochondria produce ATP.',
  confidence: 0.83,
  tStart: '2026-11-07T15:00:00.000Z',
  tEnd: '2026-11-07T15:00:02.000Z',
  createdAt: '2026-11-07T15:00:02.100Z',
}

test('persists the session and annotation captured when speech began', () => {
  const row = buildTranscriptSegment({
    ...base,
    context: { sessionId: 'session-captured', annotationId: 'annotation-captured' },
  })

  assert.equal(row.session_id, 'session-captured')
  assert.equal(row.annotation_id, 'annotation-captured')
  assert.equal(row.raw_text, base.rawText)
  assert.equal(row.confidence, 0.83)
  assert.equal(row.text_block_id, null)
})

test('uses current v2 defaults when no capture context is supplied', () => {
  const row = buildTranscriptSegment({
    ...base,
    context: null,
    defaultAnnotationId: 'annotation-current',
  })

  assert.equal(row.session_id, 'session-current')
  assert.equal(row.annotation_id, 'annotation-current')
  assert.equal('slide_id' in row, false)
  assert.equal('clean_text' in row, false)
})

test('preserves an explicitly captured null annotation when a new annotation opens later', () => {
  const row = buildTranscriptSegment({
    ...base,
    context: { sessionId: 'session-captured', annotationId: null },
    defaultAnnotationId: 'annotation-opened-later',
  })

  assert.equal(row.session_id, 'session-captured')
  assert.equal(row.annotation_id, null)
})

test('persists the page captured with the speech, or the active page without capture context', () => {
  const captured = buildTranscriptSegment({
    ...base,
    context: { sessionId: 'session-captured', annotationId: null, pageBlockId: 'page-2' },
    defaultPageBlockId: 'page-5',
  })
  assert.equal(captured.page_block_id, 'page-2')

  const capturedNone = buildTranscriptSegment({
    ...base,
    context: { sessionId: 'session-captured', annotationId: null, pageBlockId: null },
    defaultPageBlockId: 'page-5',
  })
  assert.equal(capturedNone.page_block_id, null)

  const uncaptured = buildTranscriptSegment({ ...base, context: null, defaultPageBlockId: 'page-5' })
  assert.equal(uncaptured.page_block_id, 'page-5')
})

test('a segment without a page is inserted without the column, so it works before the migration', () => {
  const plain = buildTranscriptSegment({ ...base, context: null })
  assert.equal('page_block_id' in segmentInsertRow(plain), false)
  assert.equal(segmentInsertRow(plain).raw_text, base.rawText)

  const onPage = buildTranscriptSegment({ ...base, context: null, defaultPageBlockId: 'page-1' })
  assert.equal(segmentInsertRow(onPage).page_block_id, 'page-1')
})

test('waits for an active refine and then runs one final drain', async () => {
  const coordinator = new RefineCoordinator()
  const releases = []
  let calls = 0
  const task = () => {
    calls += 1
    return new Promise((resolve) => releases.push(resolve))
  }

  const active = coordinator.run(task)
  const repeated = coordinator.run(task)
  const drain = coordinator.drain(task)
  await Promise.resolve()

  assert.equal(active, repeated)
  assert.equal(calls, 1)
  releases.shift()()
  await active
  await Promise.resolve()
  assert.equal(calls, 2)
  releases.shift()()
  await drain
})

test('runs exactly one final drain when no refine is active', async () => {
  const coordinator = new RefineCoordinator()
  let calls = 0

  await coordinator.drain(async () => {
    calls += 1
  })

  assert.equal(calls, 1)
})

test('waits for pending transcript inserts before closing an annotation', async () => {
  let release
  const pendingWrite = new Promise((resolve) => {
    release = resolve
  })
  const events = []
  const closing = waitForPendingWrites(new Set([pendingWrite]), async () => {
    events.push('close')
    return 'closed'
  })

  await Promise.resolve()
  assert.deepEqual(events, [])
  release()

  assert.equal(await closing, 'closed')
  assert.deepEqual(events, ['close'])
})

test('flushes delayed final speech before waiting for its insert and closing the annotation', async () => {
  let releaseWrite
  const pending = new Set()
  const events = []

  const result = await flushSpeechAndWaitForPendingWrites(
    pending,
    async () => {
      events.push('flush')
      const write = new Promise((resolve) => {
        releaseWrite = () => {
          events.push('write')
          resolve()
        }
      })
      pending.add(write)
      queueMicrotask(releaseWrite)
    },
    async () => {
      events.push('close')
      return 'closed'
    },
  )

  assert.equal(result, 'closed')
  assert.deepEqual(events, ['flush', 'write', 'close'])
})
