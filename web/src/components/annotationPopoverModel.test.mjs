import assert from 'node:assert/strict'
import test from 'node:test'

import { annotationCardId, isAnnotationTarget, popoverReducer } from './annotationPopoverModel.ts'

const run = (events, state = null) => events.reduce(popoverReducer, state)

test('hovering a circle opens its own popover', () => {
  assert.deepEqual(run([{ type: 'enter', id: 'ann-3' }]), { id: 'ann-3', via: 'hover' })
})

test('leaving the circle closes the hover popover', () => {
  assert.equal(run([{ type: 'enter', id: 'ann-3' }, { type: 'leave', id: 'ann-3' }]), null)
})

test('a stale leave from another circle does not close the current popover', () => {
  assert.deepEqual(
    run([{ type: 'enter', id: 'ann-1' }, { type: 'enter', id: 'ann-3' }, { type: 'leave', id: 'ann-1' }]),
    { id: 'ann-3', via: 'hover' },
  )
})

test('clicking a circle that navigates dismisses the popover immediately', () => {
  assert.equal(run([{ type: 'enter', id: 'ann-3' }, { type: 'activate', id: 'ann-3', navigates: true }]), null)
})

test('clicking a second circle never leaves the first popover open', () => {
  const state = run([
    { type: 'enter', id: 'ann-1' },
    { type: 'activate', id: 'ann-1', navigates: true },
    { type: 'enter', id: 'ann-3' },
    { type: 'activate', id: 'ann-3', navigates: true },
  ])
  assert.equal(state, null)
})

test('keyboard focus shows the popover and Enter dismisses it while navigating', () => {
  assert.deepEqual(run([{ type: 'focus', id: 'ann-2' }]), { id: 'ann-2', via: 'focus' })
  assert.equal(run([{ type: 'focus', id: 'ann-2' }, { type: 'activate', id: 'ann-2', navigates: true }]), null)
  assert.equal(run([{ type: 'focus', id: 'ann-2' }, { type: 'blur', id: 'ann-2' }]), null)
})

test('without navigation a tap toggles a preview popover', () => {
  const opened = run([{ type: 'activate', id: 'ann-1', navigates: false }])
  assert.deepEqual(opened, { id: 'ann-1', via: 'tap' })
  assert.equal(run([{ type: 'activate', id: 'ann-1', navigates: false }], opened), null)
  assert.deepEqual(run([{ type: 'activate', id: 'ann-2', navigates: false }], opened), { id: 'ann-2', via: 'tap' })
})

test('hover leave does not close a tap preview', () => {
  const opened = run([{ type: 'activate', id: 'ann-1', navigates: false }])
  assert.deepEqual(run([{ type: 'leave', id: 'ann-1' }], opened), opened)
})

test('each circle targets its own card by annotation ID', () => {
  const ids = ['ann-1', 'ann-2', 'ann-3', 'ann-4'].map(annotationCardId)
  assert.equal(new Set(ids).size, 4)
  assert.equal(annotationCardId('ann-3'), 'annotation-card-ann-3')
  assert.notEqual(annotationCardId('ann-3'), annotationCardId('ann-1'))
})

test('outside click, transcript click, Escape and scroll all dismiss any popover', () => {
  for (const opened of [
    run([{ type: 'enter', id: 'ann-1' }]),
    run([{ type: 'focus', id: 'ann-1' }]),
    run([{ type: 'activate', id: 'ann-1', navigates: false }]),
  ]) {
    assert.equal(popoverReducer(opened, { type: 'dismiss' }), null)
  }
})

test('a dismissed popover stays closed until the next hover', () => {
  const state = run([{ type: 'enter', id: 'ann-1' }, { type: 'dismiss' }, { type: 'leave', id: 'ann-1' }])
  assert.equal(state, null)
  assert.deepEqual(popoverReducer(state, { type: 'enter', id: 'ann-2' }), { id: 'ann-2', via: 'hover' })
})

const fakeElement = (matches, inRoot) => ({ closest: () => (matches ? {} : null), inRoot })
const root = { contains: (node) => node.inRoot }

test('only this images circles and popover count as inside', () => {
  assert.equal(isAnnotationTarget(fakeElement(true, true), root), true)
  assert.equal(isAnnotationTarget(fakeElement(false, true), root), false, 'image background')
  assert.equal(isAnnotationTarget(fakeElement(false, false), root), false, 'transcript or page background')
  assert.equal(isAnnotationTarget(fakeElement(true, false), root), false, 'circle on another image')
  assert.equal(isAnnotationTarget(null, root), false)
  assert.equal(isAnnotationTarget(fakeElement(true, true), null), false)
})
