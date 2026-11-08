import assert from 'node:assert/strict'
import test from 'node:test'

import { PageTimeline, USER_SCROLL_WINDOW_MS, activePageAt, isUserScroll } from './pageSpeechModel.ts'

test('the timeline answers which page was active at any moment, including after he went back', () => {
  const timeline = new PageTimeline()
  assert.equal(timeline.at(1_000), undefined) // nothing recorded yet: the caller's fallback applies
  timeline.set('p1', 1_000)
  timeline.set('p2', 5_000)
  timeline.set(null, 8_000) // scrolled to an ordinary paragraph
  timeline.set('p1', 9_000) // back to page 1

  assert.equal(timeline.at(999), undefined)
  assert.equal(timeline.at(1_000), 'p1')
  assert.equal(timeline.at(4_999), 'p1')
  assert.equal(timeline.at(5_000), 'p2')
  assert.equal(timeline.at(8_500), null)
  assert.equal(timeline.at(12_000), 'p1')
  assert.equal(timeline.current, 'p1')
})

test('setting the same page again is not a change, and old history is dropped', () => {
  const timeline = new PageTimeline(10_000)
  timeline.set('p1', 0)
  timeline.set('p1', 3_000)
  assert.equal(timeline.at(1_000), 'p1')
  timeline.set('p2', 20_000)
  timeline.set('p3', 40_000)
  assert.equal(timeline.at(35_000), 'p2') // the entry in force at the cutoff is kept
  assert.equal(timeline.at(5_000), undefined)
})

const items = [
  { top: 0, bottom: 400, owner: 'p1' }, // page 1
  { top: 410, bottom: 450, owner: 'p1' }, // a paragraph about page 1
  { top: 460, bottom: 900, owner: 'p2' }, // page 2
  { top: 910, bottom: 950, owner: null }, // ordinary paragraph
]

test('the page at the reading line is active, and its own paragraphs keep it active', () => {
  assert.equal(activePageAt(items, 200), 'p1')
  assert.equal(activePageAt(items, 430), 'p1')
  assert.equal(activePageAt(items, 600), 'p2')
  assert.equal(activePageAt(items, 930), null)
})

test('in a gap the item above wins; above everything the first item does', () => {
  assert.equal(activePageAt(items, 455), 'p1')
  assert.equal(activePageAt(items, 2_000), null)
  assert.equal(activePageAt(items, -50), 'p1')
  assert.equal(activePageAt([], 100), null)
})

test('only scrolling right after his own input counts as his', () => {
  assert.equal(isUserScroll(10_000, 10_200), true)
  assert.equal(isUserScroll(10_000, 10_000 + USER_SCROLL_WINDOW_MS), true)
  assert.equal(isUserScroll(10_000, 10_001 + USER_SCROLL_WINDOW_MS), false) // auto-scroll / showing a PDF
})
