import assert from 'node:assert/strict'
import test from 'node:test'

import { MIC_OFF, isMicOn, shouldRecord, turnMicOn } from './micModel.ts'

test('a live session opens with the mic off and does not record', () => {
  assert.equal(isMicOn(MIC_OFF, 'session-a'), false)
  assert.equal(shouldRecord(MIC_OFF, 'session-a', 'live'), false)
})

test('recording starts only after the teacher turns the mic on', () => {
  const on = turnMicOn('session-a')
  assert.equal(isMicOn(on, 'session-a'), true)
  assert.equal(shouldRecord(on, 'session-a', 'live'), true)
})

test('turning the mic off stops recording', () => {
  assert.equal(shouldRecord(MIC_OFF, 'session-a', 'live'), false)
})

test('entering another session starts with the mic off', () => {
  const on = turnMicOn('session-a')
  assert.equal(isMicOn(on, 'session-b'), false)
  assert.equal(shouldRecord(on, 'session-b', 'live'), false)
})

test('never records while the session is loading or ended', () => {
  const on = turnMicOn('session-a')
  assert.equal(shouldRecord(on, 'session-a', undefined), false)
  assert.equal(shouldRecord(on, 'session-a', 'ended'), false)
})
