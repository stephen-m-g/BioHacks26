import assert from 'node:assert/strict'
import test from 'node:test'

import {
  annotationCardsForImage,
  annotationExplanation,
  annotationsForImage,
  isTranscriptPartHighlighted,
  NO_EXPLANATION,
  studyKeyTerms,
  transcriptParagraphParts,
} from './notesModel.ts'

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

test('maps separate annotations to exact spans inside the same compiled paragraph', () => {
  const paragraph = 'First circle. Between them. Second circle.'
  const segments = [
    { id: 's-a', text_block_id: 'block-1', text_start: 0, text_end: 13, annotation_id: 'ann-a' },
    { id: 's-gap', text_block_id: 'block-1', text_start: 14, text_end: 27, annotation_id: null },
    { id: 's-b', text_block_id: 'block-1', text_start: 28, text_end: 42, annotation_id: 'ann-b' },
  ]

  assert.deepEqual(transcriptParagraphParts(paragraph, 'block-1', segments), [
    { text: 'First circle.', segmentId: 's-a', annotationId: 'ann-a' },
    { text: ' ', segmentId: null, annotationId: null },
    { text: 'Between them.', segmentId: 's-gap', annotationId: null },
    { text: ' ', segmentId: null, annotationId: null },
    { text: 'Second circle.', segmentId: 's-b', annotationId: 'ann-b' },
  ])
})

test('uses browser UTF-16 offsets correctly after an emoji', () => {
  const paragraph = '🧬 DNA marker next part'
  const parts = transcriptParagraphParts(paragraph, 'block-1', [
    { id: 's-emoji', text_block_id: 'block-1', text_start: 0, text_end: 13, annotation_id: 'ann-a' },
    { id: 's-next', text_block_id: 'block-1', text_start: 14, text_end: 23, annotation_id: 'ann-b' },
  ])

  assert.deepEqual(parts, [
    { text: '🧬 DNA marker', segmentId: 's-emoji', annotationId: 'ann-a' },
    { text: ' ', segmentId: null, annotationId: null },
    { text: 'next part', segmentId: 's-next', annotationId: 'ann-b' },
  ])
})

test('empty annotations create no unrelated transcript span', () => {
  const parts = transcriptParagraphParts('Unrelated lecture text.', 'block-1', [
    { id: 'other', text_block_id: 'block-1', text_start: 0, text_end: 23, annotation_id: 'ann-other' },
  ])

  assert.equal(parts.some((part) => part.annotationId === 'ann-empty'), false)
})

test('selecting one circle highlights only its own span', () => {
  const parts = transcriptParagraphParts('First circle. Second circle.', 'block-1', [
    { id: 's-a', text_block_id: 'block-1', text_start: 0, text_end: 13, annotation_id: 'ann-a' },
    { id: 's-b', text_block_id: 'block-1', text_start: 14, text_end: 28, annotation_id: 'ann-b' },
  ])
  const highlighted = (annotationId) => parts.filter((part) => isTranscriptPartHighlighted(part, annotationId)).map((part) => part.text)

  assert.deepEqual(highlighted('ann-a'), ['First circle.'])
  assert.deepEqual(highlighted('ann-b'), ['Second circle.'])
  assert.deepEqual(highlighted('ann-empty'), [])
})

const circle = (id, blockId, drawnAt, label, status = 'confirmed') => ({
  id,
  block_id: blockId,
  status,
  drawn_at: drawnAt,
  label,
  bubble_text: null,
})

const mountainCircles = [
  circle('ann-coast', 'image-a', '2026-11-07T19:00:02Z', 'Coastline'),
  circle('ann-peak', 'image-a', '2026-11-07T19:00:01Z', 'Peak'),
  circle('ann-river', 'image-a', '2026-11-07T19:00:03Z', 'River'),
  circle('ann-forest', 'image-a', '2026-11-07T19:00:04Z', 'Forest'),
  circle('ann-pending', 'image-a', '2026-11-07T19:00:05Z', null, 'pending'),
  circle('ann-cell', 'image-b', '2026-11-07T19:00:06Z', 'Nucleus'),
]
const mountainSpeech = [
  segment('s-peak', 'ann-peak', 'Um, the highest point on the mountain.', '2026-11-07T19:00:01Z'),
  segment('s-coast', 'ann-coast', 'Where the mountain meets the ocean.', '2026-11-07T19:00:02Z'),
]

test('four confirmed circles produce exactly four compact cards, spoken and silent', () => {
  assert.deepEqual(annotationCardsForImage(mountainCircles, 'image-a', mountainSpeech), [
    { id: 'ann-peak', title: 'Peak', text: 'The highest point on the mountain.' },
    { id: 'ann-coast', title: 'Coastline', text: 'Where the mountain meets the ocean.' },
    { id: 'ann-river', title: 'River', text: NO_EXPLANATION },
    { id: 'ann-forest', title: 'Forest', text: NO_EXPLANATION },
  ])
})

test('each image only gets cards for its own circles', () => {
  assert.deepEqual(annotationCardsForImage(mountainCircles, 'image-b', mountainSpeech).map((card) => card.id), ['ann-cell'])
  assert.deepEqual(annotationCardsForImage(mountainCircles, 'image-c', mountainSpeech), [])
})

test('cards are identical after a reload returns rows in a different order', () => {
  const reloaded = [...mountainCircles].reverse()
  assert.deepEqual(
    annotationCardsForImage(reloaded, 'image-a', [...mountainSpeech].reverse()),
    annotationCardsForImage(mountainCircles, 'image-a', mountainSpeech),
  )
})

test('untitled circles get a stable positional title', () => {
  const cards = annotationCardsForImage([circle('ann-x', 'image-a', '2026-11-07T19:00:01Z', '  ')], 'image-a', [])
  assert.deepEqual(cards, [{ id: 'ann-x', title: 'Annotation 1', text: NO_EXPLANATION }])
})

test('generated key terms never duplicate annotation cards', () => {
  const keyTerms = [
    { term: 'Peak', definition: 'The highest point on the mountain.' },
    { term: 'coastline ', definition: 'Where the mountain meets the ocean.' },
    { term: 'Erosion', definition: 'Wearing away of rock.' },
  ]
  const titles = annotationCardsForImage(mountainCircles, 'image-a', mountainSpeech).map((card) => card.title)

  assert.deepEqual(studyKeyTerms(keyTerms, true, titles), [])
  assert.deepEqual(studyKeyTerms(keyTerms, false, titles).map((keyTerm) => keyTerm.term), ['Erosion'])
  assert.deepEqual(studyKeyTerms(keyTerms, false, []), keyTerms)
})
