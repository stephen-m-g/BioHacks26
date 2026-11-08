import assert from 'node:assert/strict'
import test from 'node:test'

import { annotationExplanation, annotationsForImage } from './notesModel.ts'

const annotation = (id, bubbleText = null) => ({ id, bubble_text: bubbleText })
const segment = (id, annotationId, rawText, time) => ({
  id,
  annotation_id: annotationId,
  raw_text: rawText,
  t_start: time,
  created_at: time,
})

test('uses each annotations own linked transcript when several annotations share an image', () => {
  const segments = [
    segment('s2', 'ann-b', 'Uh, these inner folds are called cristae.', '2026-11-07T19:00:04Z'),
    segment('s1', 'ann-a', 'Um, this oval is the mitochondrion.', '2026-11-07T19:00:02Z'),
    segment('s3', 'ann-a', 'It makes ATP for the cell.', '2026-11-07T19:00:03Z'),
  ]

  assert.equal(
    annotationExplanation(annotation('ann-a'), segments),
    'This oval is the mitochondrion. It makes ATP for the cell.',
  )
  assert.equal(annotationExplanation(annotation('ann-b'), segments), 'These inner folds are called cristae.')
})

test('prefers complete linked speech over a possibly stale saved bubble', () => {
  const segments = [segment('s1', 'ann-a', 'raw speech', '2026-11-07T19:00:02Z')]

  assert.equal(annotationExplanation(annotation('ann-a', 'A stale partial bubble.'), segments), 'Raw speech')
})

test('returns null when an annotation genuinely has no linked speech', () => {
  const segments = [segment('s1', 'another-annotation', 'Unrelated speech.', '2026-11-07T19:00:02Z')]

  assert.equal(annotationExplanation(annotation('ann-empty'), segments), null)
})

test('returns every confirmed annotation on its own image exactly once, including empty ones', () => {
  const annotations = [
    { id: 'ann-4', block_id: 'image-a', status: 'confirmed', drawn_at: '2026-11-07T19:00:04Z' },
    { id: 'ann-2', block_id: 'image-a', status: 'confirmed', drawn_at: '2026-11-07T19:00:02Z' },
    { id: 'ann-1', block_id: 'image-a', status: 'confirmed', drawn_at: '2026-11-07T19:00:01Z' },
    { id: 'ann-3', block_id: 'image-a', status: 'confirmed', drawn_at: '2026-11-07T19:00:03Z' },
    { id: 'pending', block_id: 'image-a', status: 'pending', drawn_at: '2026-11-07T19:00:00Z' },
    { id: 'rejected', block_id: 'image-a', status: 'rejected', drawn_at: '2026-11-07T19:00:00Z' },
    { id: 'other-image', block_id: 'image-b', status: 'confirmed', drawn_at: '2026-11-07T19:00:00Z' },
  ]

  assert.deepEqual(annotationsForImage(annotations, 'image-a').map((item) => item.id), [
    'ann-1', 'ann-2', 'ann-3', 'ann-4',
  ])
  assert.deepEqual(annotationsForImage(annotations, 'image-b').map((item) => item.id), ['other-image'])
})
