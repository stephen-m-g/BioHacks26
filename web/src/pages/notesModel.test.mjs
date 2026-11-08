import assert from 'node:assert/strict'
import test from 'node:test'

import {
  annotationCardsForImage,
  annotationExplanation,
  annotationsForImage,
  annotationSourceTexts,
  COMPILE_GRACE_MS,
  compileFallbackDelay,
  isTranscriptPartHighlighted,
  NO_EXPLANATION,
  rawAnnotationCardsForImage,
  rawAnnotationExplanation,
  rawParagraphParts,
  rawSpeechParts,
  studyKeyTerms,
  transcriptParagraphParts,
  transcriptSections,
} from './notesModel.ts'

const annotation = (id, bubbleText = null) => ({ id, bubble_text: bubbleText })
const segment = (id, annotationId, rawText, time) => ({
  id,
  annotation_id: annotationId,
  raw_text: rawText,
  t_start: time,
  t_end: time,
  created_at: time,
  text_block_id: null,
  text_start: null,
  text_end: null,
})
const NO_SOURCES = new Map()

test('legacy: uses each annotations own linked transcript when several annotations share an image', () => {
  const segments = [
    segment('s2', 'ann-b', 'Uh, these inner folds are called cristae.', '2026-11-07T19:00:04Z'),
    segment('s1', 'ann-a', 'Um, this oval is the mitochondrion.', '2026-11-07T19:00:02Z'),
    segment('s3', 'ann-a', 'It makes ATP for the cell.', '2026-11-07T19:00:03Z'),
  ]

  assert.equal(
    annotationExplanation(annotation('ann-a'), segments, NO_SOURCES),
    'This oval is the mitochondrion. It makes ATP for the cell.',
  )
  assert.equal(annotationExplanation(annotation('ann-b'), segments, NO_SOURCES), 'These inner folds are called cristae.')
})

test('legacy: prefers complete linked speech over a possibly stale saved bubble', () => {
  const segments = [segment('s1', 'ann-a', 'raw speech', '2026-11-07T19:00:02Z')]

  assert.equal(annotationExplanation(annotation('ann-a', 'A stale partial bubble.'), segments, NO_SOURCES), 'Raw speech')
})

test('legacy: falls back to the saved bubble when no speech is linked', () => {
  assert.equal(annotationExplanation(annotation('ann-a', ' Saved bubble. '), [], NO_SOURCES), 'Saved bubble.')
})

test('returns null when an annotation genuinely has no linked speech', () => {
  const segments = [segment('s1', 'another-annotation', 'Unrelated speech.', '2026-11-07T19:00:02Z')]

  assert.equal(annotationExplanation(annotation('ann-empty'), segments, NO_SOURCES), null)
})

/**
 * Mirrors the backend refine step (join_refined_segments): cleaned parts joined with one space, each segment
 * stamped with its UTF-16 span in the block's text, and filler-only segments left with null offsets.
 */
function refine(blockId, items) {
  let text = ''
  const segments = items.map(({ id, annotationId, raw, cleaned, time }) => {
    const row = { ...segment(id, annotationId, raw, time), text_block_id: blockId }
    if (!cleaned) return row
    if (text) text += ' '
    const start = text.length
    text += cleaned
    return { ...row, text_start: start, text_end: text.length }
  })
  return { block: { id: blockId, kind: 'text', text }, segments }
}

const t = (second) => `2026-11-07T19:00:${String(second).padStart(2, '0')}Z`

/** What the student reads in the paragraph, the card, and the hover popup for one circle. */
function threeViews(annotationId, blocks, sections, segments, imageBlockId = 'image-1') {
  const sourceTexts = annotationSourceTexts(blocks, sections)
  const circles = [...new Set([...segments.map((s) => s.annotation_id).filter(Boolean), annotationId])].map((id, i) =>
    circle(id, imageBlockId, t(i), id),
  )
  const card = annotationCardsForImage(circles, imageBlockId, segments, sourceTexts).find((c) => c.id === annotationId)
  // Notes.tsx hands each card's text to ImageBlock as bubble_text; the popup renders bubble_text.trim().
  const popup = card.text.trim()
  const highlighted = sections
    .flatMap((s) => s.paragraphs.map((p, i) => transcriptParagraphParts(p, s.paragraph_block_ids?.[i], segments)))
    .flatMap((parts) => parts.filter((part) => isTranscriptPartHighlighted(part, annotationId)).map((part) => part.text))
  return { paragraph: highlighted.join(' '), card: card.text, popup }
}

const sectionFor = (...blocks) => ({
  paragraphs: blocks.map((b) => b.text),
  paragraph_block_ids: blocks.map((b) => b.id),
})

test('paragraph, card and popup show the same cleaned speech after filler removal', () => {
  const { block, segments } = refine('text-1', [
    {
      id: 's1',
      annotationId: 'ann-mito',
      raw: 'Um, so this is the, the mitochondria, and uh it produces ATP.',
      cleaned: 'So this is the mitochondria, and it produces ATP.',
      time: t(1),
    },
  ])
  const views = threeViews('ann-mito', [block], [sectionFor(block)], segments)

  assert.deepEqual(views, {
    paragraph: 'So this is the mitochondria, and it produces ATP.',
    card: 'So this is the mitochondria, and it produces ATP.',
    popup: 'So this is the mitochondria, and it produces ATP.',
  })
})

test('duplicate words, false starts and corrected terms match the paragraph exactly', () => {
  const { block, segments } = refine('text-1', [
    { id: 's1', annotationId: 'ann-a', raw: 'the the nucleus holds DNA', cleaned: 'The nucleus holds DNA.', time: t(1) },
    {
      id: 's2',
      annotationId: 'ann-b',
      raw: 'it goes, well, I mean the ribosome makes a tee pee',
      cleaned: 'The ribosome makes ATP.',
      time: t(2),
    },
  ])
  const sections = [sectionFor(block)]
  const a = threeViews('ann-a', [block], sections, segments)
  const b = threeViews('ann-b', [block], sections, segments)

  assert.deepEqual(a, { paragraph: 'The nucleus holds DNA.', card: 'The nucleus holds DNA.', popup: 'The nucleus holds DNA.' })
  assert.deepEqual(b, { paragraph: 'The ribosome makes ATP.', card: 'The ribosome makes ATP.', popup: 'The ribosome makes ATP.' })
  assert.doesNotMatch(a.card, /the the/i)
  assert.doesNotMatch(b.card, /I mean|tee pee/)
})

test('a filler-only segment with null offsets never reappears', () => {
  const { block, segments } = refine('text-1', [
    { id: 's1', annotationId: 'ann-a', raw: 'Um, uh.', cleaned: '', time: t(1) },
    { id: 's2', annotationId: 'ann-a', raw: 'This is the cell wall.', cleaned: 'This is the cell wall.', time: t(2) },
  ])

  assert.equal(segments[0].text_start, null)
  assert.equal(threeViews('ann-a', [block], [sectionFor(block)], segments).card, 'This is the cell wall.')
})

test('an annotation whose speech was all filler shows the empty message, not the raw filler', () => {
  const spoken = refine('text-1', [
    { id: 's1', annotationId: 'ann-other', raw: 'The cell wall.', cleaned: 'The cell wall.', time: t(1) },
    { id: 's2', annotationId: 'ann-filler', raw: 'Um, uh, hmm.', cleaned: '', time: t(2) },
  ])
  const sourceTexts = annotationSourceTexts([spoken.block], [sectionFor(spoken.block)])
  const circles = [circle('ann-filler', 'image-1', t(1), 'Filler')]

  assert.equal(annotationExplanation(annotation('ann-filler', 'Um, uh, hmm.'), spoken.segments, sourceTexts), null)
  assert.equal(annotationCardsForImage(circles, 'image-1', spoken.segments, sourceTexts)[0].text, NO_EXPLANATION)

  // A batch that was only filler under a PDF page is attached to the page block, which has no text.
  const page = { id: 'page-1', kind: 'image', text: null }
  const underPage = [{ ...segment('s3', 'ann-filler', 'Uh, um.', t(3)), text_block_id: 'page-1' }]
  assert.equal(annotationExplanation(annotation('ann-filler'), underPage, annotationSourceTexts([page], [])), null)
})

test('multiple annotations on one image show only their own cleaned speech', () => {
  const { block, segments } = refine('text-1', [
    { id: 's1', annotationId: 'ann-a', raw: 'uh this is the stem', cleaned: 'This is the stem.', time: t(1) },
    { id: 's2', annotationId: null, raw: 'and so, um, moving on', cleaned: 'Moving on.', time: t(2) },
    { id: 's3', annotationId: 'ann-b', raw: 'the the leaf', cleaned: 'The leaf.', time: t(3) },
  ])
  const sourceTexts = annotationSourceTexts([block], [sectionFor(block)])
  const circles = [circle('ann-a', 'image-1', t(1), 'Stem'), circle('ann-b', 'image-1', t(3), 'Leaf')]

  assert.deepEqual(annotationCardsForImage(circles, 'image-1', segments, sourceTexts), [
    { id: 'ann-a', title: 'Stem', text: 'This is the stem.' },
    { id: 'ann-b', title: 'Leaf', text: 'The leaf.' },
  ])
})

test('several segments for one annotation join in speech order across transcript blocks', () => {
  const first = refine('text-1', [
    { id: 's1', annotationId: 'ann-a', raw: 'um first', cleaned: 'First part.', time: t(1) },
    { id: 's2', annotationId: null, raw: 'aside', cleaned: 'An aside.', time: t(2) },
    { id: 's3', annotationId: 'ann-a', raw: 'second', cleaned: 'Second part.', time: t(3) },
  ])
  const second = refine('text-2', [{ id: 's4', annotationId: 'ann-a', raw: 'uh third', cleaned: 'Third part.', time: t(4) }])
  const blocks = [first.block, second.block]
  const segments = [...second.segments, ...first.segments].reverse()
  const sourceTexts = annotationSourceTexts(blocks, [sectionFor(first.block), sectionFor(second.block)])

  assert.equal(annotationExplanation(annotation('ann-a'), segments, sourceTexts), 'First part. Second part. Third part.')
})

test('speech given under a PDF page maps to that page annotation', () => {
  const page = { id: 'page-3', kind: 'image', text: null }
  const { block, segments } = refine('text-page', [
    { id: 's1', annotationId: 'ann-graph', raw: 'uh this graph shows, shows growth', cleaned: 'This graph shows growth.', time: t(1) },
  ])
  const views = threeViews('ann-graph', [page, { ...block, page_block_id: 'page-3' }], [sectionFor(block)], segments, 'page-3')

  assert.deepEqual(views, {
    paragraph: 'This graph shows growth.',
    card: 'This graph shows growth.',
    popup: 'This graph shows growth.',
  })
})

test('UTF-16 offsets after an emoji slice the same text the paragraph shows', () => {
  const { block, segments } = refine('text-1', [
    { id: 's1', annotationId: null, raw: 'um 🧬 look', cleaned: '🧬 Look.', time: t(1) },
    { id: 's2', annotationId: 'ann-dna', raw: 'the the DNA marker 🔬', cleaned: 'The DNA marker 🔬.', time: t(2) },
  ])

  assert.equal(segments[1].text_start, '🧬 Look. '.length)
  assert.deepEqual(threeViews('ann-dna', [block], [sectionFor(block)], segments), {
    paragraph: 'The DNA marker 🔬.',
    card: 'The DNA marker 🔬.',
    popup: 'The DNA marker 🔬.',
  })
})

test('prefers the displayed compiled paragraph, and uses block text when notes lack paragraph mappings', () => {
  const { block, segments } = refine('text-1', [
    { id: 's1', annotationId: 'ann-a', raw: 'uh the vacuole', cleaned: 'The vacuole.', time: t(1) },
  ])
  const sourceTexts = annotationSourceTexts([{ ...block, text: 'stale' }], [sectionFor(block)])
  assert.equal(sourceTexts.get('text-1'), 'The vacuole.')

  const withoutIds = annotationSourceTexts([block], [{ paragraphs: [block.text] }])
  assert.equal(annotationExplanation(annotation('ann-a'), segments, withoutIds), 'The vacuole.')
})

test('legacy rows refined before offsets existed keep a raw-speech fallback', () => {
  const block = { id: 'text-old', kind: 'text', text: 'Old cleaned paragraph.' }
  const segments = [{ ...segment('s1', 'ann-a', 'um old speech', t(1)), text_block_id: 'text-old' }]
  const sourceTexts = annotationSourceTexts([block], [sectionFor(block)])

  assert.equal(annotationExplanation(annotation('ann-a', 'Saved.'), segments, sourceTexts), 'Old speech')
  assert.equal(annotationExplanation(annotation('ann-a', 'Saved.'), [], sourceTexts), 'Saved.')
})

test('refreshing compiled notes keeps every explanation identical', () => {
  const first = refine('text-1', [
    { id: 's1', annotationId: 'ann-a', raw: 'uh alpha', cleaned: 'Alpha.', time: t(1) },
    { id: 's2', annotationId: 'ann-b', raw: 'beta beta', cleaned: 'Beta.', time: t(2) },
  ])
  const second = refine('text-2', [{ id: 's3', annotationId: 'ann-a', raw: 'um gamma', cleaned: 'Gamma.', time: t(3) }])
  const blocks = [first.block, second.block]
  const segments = [...first.segments, ...second.segments]
  const circles = [circle('ann-a', 'image-1', t(1), 'A'), circle('ann-b', 'image-1', t(2), 'B')]
  const cards = (sections, rows = segments, blockRows = blocks) =>
    annotationCardsForImage(circles, 'image-1', rows, annotationSourceTexts(blockRows, sections))

  const compiled = cards([sectionFor(first.block, second.block)])
  assert.deepEqual(compiled.map((card) => card.text), ['Alpha. Gamma.', 'Beta.'])
  // Recompiled into different sections, rows reloaded in another order, and before the notes row arrives.
  assert.deepEqual(cards([sectionFor(first.block), sectionFor(second.block)], [...segments].reverse(), [...blocks].reverse()), compiled)
  assert.deepEqual(cards([]), compiled)
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
  assert.deepEqual(annotationCardsForImage(mountainCircles, 'image-a', mountainSpeech, NO_SOURCES), [
    { id: 'ann-peak', title: 'Peak', text: 'The highest point on the mountain.' },
    { id: 'ann-coast', title: 'Coastline', text: 'Where the mountain meets the ocean.' },
    { id: 'ann-river', title: 'River', text: NO_EXPLANATION },
    { id: 'ann-forest', title: 'Forest', text: NO_EXPLANATION },
  ])
})

test('each image only gets cards for its own circles', () => {
  assert.deepEqual(annotationCardsForImage(mountainCircles, 'image-b', mountainSpeech, NO_SOURCES).map((card) => card.id), ['ann-cell'])
  assert.deepEqual(annotationCardsForImage(mountainCircles, 'image-c', mountainSpeech, NO_SOURCES), [])
})

test('cards are identical after a reload returns rows in a different order', () => {
  const reloaded = [...mountainCircles].reverse()
  assert.deepEqual(
    annotationCardsForImage(reloaded, 'image-a', [...mountainSpeech].reverse(), NO_SOURCES),
    annotationCardsForImage(mountainCircles, 'image-a', mountainSpeech, NO_SOURCES),
  )
})

test('untitled circles get a stable positional title', () => {
  const cards = annotationCardsForImage([circle('ann-x', 'image-a', '2026-11-07T19:00:01Z', '  ')], 'image-a', [], NO_SOURCES)
  assert.deepEqual(cards, [{ id: 'ann-x', title: 'Annotation 1', text: NO_EXPLANATION }])
})

test('generated key terms never duplicate annotation cards', () => {
  const keyTerms = [
    { term: 'Peak', definition: 'The highest point on the mountain.' },
    { term: 'coastline ', definition: 'Where the mountain meets the ocean.' },
    { term: 'Erosion', definition: 'Wearing away of rock.' },
  ]
  const titles = annotationCardsForImage(mountainCircles, 'image-a', mountainSpeech, NO_SOURCES).map((card) => card.title)

  assert.deepEqual(studyKeyTerms(keyTerms, true, titles), [])
  assert.deepEqual(studyKeyTerms(keyTerms, false, titles).map((keyTerm) => keyTerm.term), ['Erosion'])
  assert.deepEqual(studyKeyTerms(keyTerms, false, []), keyTerms)
})

test('the notes page only compiles itself once the end-session compile has had its chance', () => {
  const endedAt = '2026-11-07T19:00:00Z'
  const ended = Date.parse(endedAt)

  assert.equal(compileFallbackDelay(null, ended), null)
  assert.equal(compileFallbackDelay(endedAt, ended), COMPILE_GRACE_MS)
  assert.equal(compileFallbackDelay(endedAt, ended + 60_000), COMPILE_GRACE_MS - 60_000)
  assert.equal(compileFallbackDelay(endedAt, ended + COMPILE_GRACE_MS + 1), 0)
  assert.equal(compileFallbackDelay(endedAt, ended + 24 * 60 * 60_000), 0)
})

// ---------- Transcript view: raw speech ----------

const rawSegment = (id, annotationId, rawText, time, extra = {}) => ({
  ...segment(id, annotationId, rawText, time),
  ...extra,
})

test('raw explanation keeps fillers, repeats and recognition errors, in speech order', () => {
  const segments = [
    rawSegment('s2', 'ann-a', ' the the mighty condria makes ATP ', '2026-11-07T19:00:03Z'),
    rawSegment('s1', 'ann-a', 'Um, so uh this oval,', '2026-11-07T19:00:02Z'),
    rawSegment('s3', 'ann-b', 'Unrelated.', '2026-11-07T19:00:01Z'),
  ]
  assert.equal(rawAnnotationExplanation('ann-a', segments), 'Um, so uh this oval, the the mighty condria makes ATP')
})

test('raw explanation includes filler-only segments whose cleaned offsets are null', () => {
  const segments = [
    rawSegment('s1', 'ann-a', 'This is the nucleus.', '2026-11-07T19:00:02Z', { text_block_id: 'b1', text_start: 0, text_end: 20 }),
    rawSegment('s2', 'ann-a', 'Uh, um.', '2026-11-07T19:00:03Z', { text_block_id: 'b1' }),
  ]
  assert.equal(rawAnnotationExplanation('ann-a', segments), 'This is the nucleus. Uh, um.')
})

test('raw explanation breaks timestamp ties by created_at then id', () => {
  const t = '2026-11-07T19:00:02Z'
  const segments = [
    rawSegment('b', 'ann-a', 'second', t, { created_at: '2026-11-07T19:00:05Z' }),
    rawSegment('a', 'ann-a', 'first', t, { created_at: '2026-11-07T19:00:05Z' }),
    rawSegment('c', 'ann-a', 'zeroth', t, { created_at: '2026-11-07T19:00:04Z' }),
  ]
  assert.equal(rawAnnotationExplanation('ann-a', segments), 'zeroth first second')
})

test('raw explanation is null without linked speech, never the saved bubble', () => {
  assert.equal(rawAnnotationExplanation('ann-a', [rawSegment('s1', 'ann-b', 'Other.', '2026-11-07T19:00:02Z')]), null)
  assert.equal(rawAnnotationExplanation('ann-a', [rawSegment('s1', 'ann-a', '   ', '2026-11-07T19:00:02Z')]), null)
})

test('raw cards: one per confirmed circle on the image, in drawing order, with raw speech', () => {
  const annotations = [
    { id: 'ann-b', block_id: 'img', status: 'confirmed', drawn_at: '2026-11-07T19:00:09Z', label: 'Cristae', bubble_text: 'Cleaned.' },
    { id: 'ann-a', block_id: 'img', status: 'confirmed', drawn_at: '2026-11-07T19:00:01Z', label: null, bubble_text: 'Saved.' },
    { id: 'ann-c', block_id: 'img', status: 'rejected', drawn_at: '2026-11-07T19:00:02Z', label: 'X', bubble_text: null },
    { id: 'ann-d', block_id: 'other', status: 'confirmed', drawn_at: '2026-11-07T19:00:02Z', label: 'Y', bubble_text: null },
  ]
  const segments = [rawSegment('s1', 'ann-b', 'uh these folds folds', '2026-11-07T19:00:10Z')]
  assert.deepEqual(rawAnnotationCardsForImage(annotations, 'img', segments), [
    { id: 'ann-a', title: 'Annotation 1', text: NO_EXPLANATION },
    { id: 'ann-b', title: 'Cristae', text: 'uh these folds folds' },
  ])
})

test('raw explanation does not mutate or reorder segment rows', () => {
  const segments = [
    rawSegment('s2', 'ann-a', ' b ', '2026-11-07T19:00:03Z'),
    rawSegment('s1', 'ann-a', 'a', '2026-11-07T19:00:02Z'),
  ]
  const before = structuredClone(segments)
  rawAnnotationExplanation('ann-a', segments)
  assert.deepEqual(segments, before)
})

// ---------- Transcript view: section cards ----------

const text = (id, pageBlockId = null) => ({ id, kind: 'text', page_block_id: pageBlockId })
const image = (id) => ({ id, kind: 'image', page_block_id: null })
const ownersOf = (blocks, pageIds) =>
  new Map(blocks.map((b) => [b.id, pageIds.includes(b.id) ? b.id : pageIds.includes(b.page_block_id) ? b.page_block_id : null]))
const speech = (id, time, extra = {}) => rawSegment(id, null, `words ${id}`, time, extra)
const shape = (sections) =>
  sections.map((s) => ({
    id: s.id,
    media: s.media?.id ?? null,
    paragraphs: s.paragraphs.map((b) => b.id),
    unrefined: s.unrefined.map((x) => x.id),
  }))

test('sections: each PDF page is one card with its own paragraphs and speech, in page order', () => {
  const pages = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
  const blocks = pages.flatMap((p) => [image(p), text(`t-${p}`, p)])
  const sections = transcriptSections(blocks, ownersOf(blocks, pages), [])
  assert.equal(sections.length, 7)
  assert.deepEqual(
    shape(sections).map((s) => [s.media, s.paragraphs]),
    pages.map((p) => [p, [`t-${p}`]]),
  )
})

test('sections: page paragraphs join their page by page_block_id, wherever they sit on the board', () => {
  const blocks = [image('p1'), image('p2'), text('t1', 'p1'), text('t2', 'p2'), text('t3', 'p1')]
  assert.deepEqual(shape(transcriptSections(blocks, ownersOf(blocks, ['p1', 'p2']), [])), [
    { id: 'p1', media: 'p1', paragraphs: ['t1', 't3'], unrefined: [] },
    { id: 'p2', media: 'p2', paragraphs: ['t2'], unrefined: [] },
  ])
})

test('sections: an ordinary image takes the paragraphs that follow it; leading text has its own card', () => {
  const blocks = [text('a'), image('img1'), text('b'), text('c'), image('img2'), text('d')]
  assert.deepEqual(shape(transcriptSections(blocks, ownersOf(blocks, []), [])), [
    { id: 'text-a', media: null, paragraphs: ['a'], unrefined: [] },
    { id: 'img1', media: 'img1', paragraphs: ['b', 'c'], unrefined: [] },
    { id: 'img2', media: 'img2', paragraphs: ['d'], unrefined: [] },
  ])
})

test('sections: ordinary text after a PDF page is not attributed to that page', () => {
  const blocks = [image('p1'), text('t1', 'p1'), text('loose')]
  assert.deepEqual(shape(transcriptSections(blocks, ownersOf(blocks, ['p1']), [])), [
    { id: 'p1', media: 'p1', paragraphs: ['t1'], unrefined: [] },
    { id: 'text-loose', media: null, paragraphs: ['loose'], unrefined: [] },
  ])
})

test('sections: unrefined speech goes to its page, else after the last ordinary card, each exactly once', () => {
  const blocks = [image('p1'), image('img')]
  const segments = [
    speech('s3', '2026-11-07T19:00:03Z'),
    speech('s1', '2026-11-07T19:00:01Z', { page_block_id: 'p1' }),
    speech('s2', '2026-11-07T19:00:02Z', { page_block_id: 'gone' }),
    speech('refined', '2026-11-07T19:00:00Z', { text_block_id: 'x' }),
  ]
  assert.deepEqual(shape(transcriptSections(blocks, ownersOf(blocks, ['p1']), segments)), [
    { id: 'p1', media: 'p1', paragraphs: [], unrefined: ['s1'] },
    { id: 'img', media: 'img', paragraphs: [], unrefined: ['s2', 's3'] },
  ])
})

test('sections: trailing unrefined speech after a PDF page gets its own card', () => {
  const blocks = [image('p1')]
  const segments = [speech('s1', '2026-11-07T19:00:01Z')]
  assert.deepEqual(shape(transcriptSections(blocks, ownersOf(blocks, ['p1']), segments)), [
    { id: 'p1', media: 'p1', paragraphs: [], unrefined: [] },
    { id: 'speech-s1', media: null, paragraphs: [], unrefined: ['s1'] },
  ])
})

test('sections: an empty board has no cards', () => {
  assert.deepEqual(transcriptSections([], new Map(), []), [])
})

// ---------- Transcript view: raw paragraphs ----------

test('raw paragraph: rebuilt from its own segments in speech order, wording untouched', () => {
  const segments = [
    rawSegment('s3', null, 'Other block.', '2026-11-07T19:00:01Z', { text_block_id: 'b2' }),
    rawSegment('s2', 'ann-a', ' the the mighty condria ', '2026-11-07T19:00:03Z', { text_block_id: 'b1', text_start: 0, text_end: 15 }),
    rawSegment('s1', null, 'Um, so uh,', '2026-11-07T19:00:02Z', { text_block_id: 'b1' }),
  ]
  assert.deepEqual(rawParagraphParts('b1', segments), [
    { text: 'Um, so uh,', segmentId: 's1', annotationId: null },
    { text: 'the the mighty condria', segmentId: 's2', annotationId: 'ann-a' },
  ])
})

test('raw paragraph: filler-only segments with null offsets are kept', () => {
  const segments = [
    rawSegment('s1', null, 'Uh, um.', '2026-11-07T19:00:02Z', { text_block_id: 'b1', text_start: null, text_end: null }),
  ]
  assert.deepEqual(rawParagraphParts('b1', segments), [{ text: 'Uh, um.', segmentId: 's1', annotationId: null }])
})

test('raw paragraph: null when no segment maps to the block (legacy), so the view can say so', () => {
  assert.equal(rawParagraphParts('b1', [rawSegment('s1', null, 'x', '2026-11-07T19:00:02Z', { text_block_id: 'b2' })]), null)
})

test('raw speech parts: sorted by speech time with stable tie-breakers, blank rows dropped, input untouched', () => {
  const t = '2026-11-07T19:00:02Z'
  const segments = [
    rawSegment('b', null, 'second', t, { created_at: '2026-11-07T19:00:05Z' }),
    rawSegment('blank', null, '  ', t),
    rawSegment('a', null, 'first', t, { created_at: '2026-11-07T19:00:05Z' }),
    rawSegment('z', null, 'zeroth', '2026-11-07T19:00:01Z'),
  ]
  const before = structuredClone(segments)
  assert.deepEqual(
    rawSpeechParts(segments).map((p) => p.text),
    ['zeroth', 'first', 'second'],
  )
  assert.deepEqual(segments, before)
})
