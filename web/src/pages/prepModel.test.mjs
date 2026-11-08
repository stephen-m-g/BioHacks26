import assert from 'node:assert/strict'
import test from 'node:test'

import { backAction, canSaveLecture, saveLecture } from './prepModel.ts'

const fresh = { isNew: true, loaded: true, busy: false, materialCount: 0, pending: 0 }

test('a new empty lecture cannot be saved', () => {
  assert.equal(canSaveLecture(fresh), false)
})

test('a new lecture with one stored material (image, PDF or typed note) can be saved', () => {
  // Each kind becomes one asset row once its insert succeeds; Prep counts those rows.
  assert.equal(canSaveLecture({ ...fresh, materialCount: 1 }), true)
})

test('an upload still running or one that failed does not enable Save', () => {
  assert.equal(canSaveLecture({ ...fresh, pending: 1 }), false) // running: not stored yet
  assert.equal(canSaveLecture({ ...fresh, materialCount: 1, pending: 1 }), false) // wait for the running one
  assert.equal(canSaveLecture({ ...fresh, pending: 0 }), false) // it failed: nothing was stored
})

test('removing the only new material disables Save again', () => {
  assert.equal(canSaveLecture({ ...fresh, materialCount: 1 }), true)
  assert.equal(canSaveLecture({ ...fresh, materialCount: 0 }), false)
})

test('Save is disabled while saving and before the lecture has loaded', () => {
  assert.equal(canSaveLecture({ ...fresh, materialCount: 2, busy: true }), false)
  assert.equal(canSaveLecture({ ...fresh, materialCount: 2, loaded: false }), false)
})

test('an existing lecture keeps its save behaviour, with or without materials', () => {
  assert.equal(canSaveLecture({ ...fresh, isNew: false }), true)
  assert.equal(canSaveLecture({ ...fresh, isNew: false, materialCount: 3 }), true)
})

test('Save runs the existing persistence steps in order, then opens the dashboard', async () => {
  const events = []
  await saveLecture({
    updateTitle: async () => events.push('title'),
    deleteRemoved: async () => events.push('removals'),
    updateClasses: async () => events.push('classes'),
    navigate: (to) => events.push(`navigate ${to}`),
  })
  assert.deepEqual(events, ['title', 'removals', 'classes', 'navigate /'])
})

test('unchanged title and classes are skipped; a failed write does not navigate', async () => {
  const events = []
  await saveLecture({ deleteRemoved: async () => events.push('removals'), navigate: (to) => events.push(to) })
  assert.deepEqual(events, ['removals', '/'])

  const navigated = []
  await assert.rejects(
    saveLecture({
      updateTitle: async () => {
        throw new Error('network down')
      },
      deleteRemoved: async () => navigated.push('removals'),
      navigate: (to) => navigated.push(to),
    }),
    /network down/,
  )
  assert.deepEqual(navigated, [])
})

test('the back arrow still asks Save / Don’t save / Cancel when something would be lost', () => {
  assert.equal(backAction(false, true), 'confirm') // a new lecture always asks
  assert.equal(backAction(true, false), 'confirm')
  assert.equal(backAction(false, false), 'leave')
})
