import assert from 'node:assert/strict'
import test from 'node:test'

import { annotationExplanation } from './notesModel.ts'

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

test('prefers the cleaned explanation saved by annotation close', () => {
  const segments = [segment('s1', 'ann-a', 'raw speech', '2026-11-07T19:00:02Z')]

  assert.equal(annotationExplanation(annotation('ann-a', 'The mitochondrion makes ATP.'), segments), 'The mitochondrion makes ATP.')
})

test('returns null when an annotation genuinely has no linked speech', () => {
  const segments = [segment('s1', 'another-annotation', 'Unrelated speech.', '2026-11-07T19:00:02Z')]

  assert.equal(annotationExplanation(annotation('ann-empty'), segments), null)
})
