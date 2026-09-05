import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DraftState } from './state.js'

test('a sensor that reports nothing has lost sight of the board, not emptied it', () => {
  const s = new DraftState(18)
  s.applySnapshot(
    [{ overall: 1, playerId: 'a' }, { overall: 2, playerId: 'b' }] as any,
    'yahoo-ext',
  )
  const diff = s.applySnapshot([] as any, 'yahoo-ext')
  assert.equal(s.all().length, 2, 'an empty push must not retract the draft')
  assert.equal(diff.removed.length, 0)
  assert.equal(diff.changed, false)
})

test('a sensor still retracts a pick it owns when it reports the others', () => {
  const s = new DraftState(18)
  s.applySnapshot(
    [{ overall: 1, playerId: 'a' }, { overall: 2, playerId: 'b' }] as any,
    'yahoo-ext',
  )
  // Pick 2 undone in the draft room: the feed says so by still reporting 1.
  const diff = s.applySnapshot([{ overall: 1, playerId: 'a' }] as any, 'yahoo-ext')
  assert.equal(diff.removed.length, 1)
  assert.equal(s.all().length, 1)
})
