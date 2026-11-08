import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ensureJoinCodeWith,
  formatJoinCode,
  generateJoinCode,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_TRIES,
  normalizeJoinCode,
} from './joinCodeModel.ts'

/** A fake store that answers claim() from a script and records every call. */
function fakeStore({ claims = [], read = { data: null, error: null } } = {}) {
  const calls = []
  return {
    calls,
    claim(sessionId, code) {
      calls.push(['claim', sessionId, code])
      const next = claims.shift() ?? { data: null, error: null }
      if (next instanceof Error) return Promise.reject(next)
      return Promise.resolve(typeof next === 'function' ? next(code) : next)
    },
    read(sessionId) {
      calls.push(['read', sessionId])
      return Promise.resolve(read)
    },
  }
}

const taken = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
const codes = (...list) => {
  const queue = [...list]
  return () => queue.shift()
}

test('the alphabet leaves out characters that are easy to misread', () => {
  for (const c of '0O1IL') assert.equal(JOIN_CODE_ALPHABET.includes(c), false, c)
  assert.equal(new Set(JOIN_CODE_ALPHABET).size, JOIN_CODE_ALPHABET.length)
})

test('generated codes are 6 characters from the alphabet', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) {
    const code = generateJoinCode()
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
    seen.add(code)
  }
  assert.ok(seen.size > 190, 'codes should not repeat in a small sample')
})

test('normalizing keeps uppercase letters and digits, at most 6', () => {
  assert.equal(normalizeJoinCode(' abc-12 3 '), 'ABC123')
  assert.equal(normalizeJoinCode('ab c'), 'ABC')
  assert.equal(normalizeJoinCode('xyz 789 extra'), 'XYZ789')
  assert.equal(normalizeJoinCode('é!?'), '')
})

test('formatting splits the code into two groups of three', () => {
  assert.equal(formatJoinCode('ABC123'), 'ABC 123')
  assert.equal(formatJoinCode('AB'), 'AB')
})

test('a session without a code gets a fresh one', async () => {
  const store = fakeStore({ claims: [(code) => ({ data: { join_code: code }, error: null })] })
  assert.equal(await ensureJoinCodeWith(store, 's1', codes('KQ7M2X')), 'KQ7M2X')
  assert.deepEqual(store.calls, [['claim', 's1', 'KQ7M2X']])
})

test('a taken code is retried with a new one', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const store = fakeStore({ claims: [taken, (code) => ({ data: { join_code: code }, error: null })] })
  assert.equal(await ensureJoinCodeWith(store, 's1', codes('AAAAAA', 'BBBBBB')), 'BBBBBB')
  assert.deepEqual(
    store.calls.map((c) => c[2]),
    ['AAAAAA', 'BBBBBB'],
  )
})

test('when nothing changed, the existing code is read back', async () => {
  const store = fakeStore({ claims: [{ data: null, error: null }], read: { data: { join_code: 'HJK234' }, error: null } })
  assert.equal(await ensureJoinCodeWith(store, 's1'), 'HJK234')
  assert.deepEqual(store.calls.at(-1), ['read', 's1'])
})

test('other errors (e.g. no join_code column yet) give null without retrying', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const missingColumn = { data: null, error: { code: 'PGRST204', message: "Could not find the 'join_code' column" } }
  const store = fakeStore({ claims: [missingColumn] })
  assert.equal(await ensureJoinCodeWith(store, 's1'), null)
  assert.equal(store.calls.length, 1)
  assert.equal(warn.mock.callCount(), 1)
})

test('gives up with null after 5 taken codes', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const store = fakeStore({ claims: Array(10).fill(taken) })
  assert.equal(await ensureJoinCodeWith(store, 's1'), null)
  assert.equal(store.calls.length, JOIN_CODE_TRIES)
})

test('never throws, even when the request itself fails', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const store = fakeStore({ claims: [new Error('network down')] })
  assert.equal(await ensureJoinCodeWith(store, 's1'), null)
})
