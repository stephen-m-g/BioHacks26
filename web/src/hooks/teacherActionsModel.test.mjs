import assert from 'node:assert/strict'
import test from 'node:test'

import { RefineCoordinator, buildTranscriptSegment } from './teacherActionsModel.ts'

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
