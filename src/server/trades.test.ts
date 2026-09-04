import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findFits, type Squad } from './trades.js'

const REQ = { QB: 1, RB: 2, WR: 2, TE: 1 }
const sq = (teamId: string, manager: string, spec: [string, string, number][]): Squad => ({
  teamId, manager,
  players: spec.map(([name, pos, projected]) => ({ id: name, name, pos, projected })),
})

const me = sq('me', 'me', [
  ['QB1', 'QB', 18], ['RB1', 'RB', 15], ['RB2', 'RB', 13], ['RB3', 'RB', 12], ['RB4', 'RB', 11],
  ['WR1', 'WR', 12], ['TE1', 'TE', 9],
])

test('finds the manager who is the mirror image of you', () => {
  const mirror = sq('t2', 'Arthur', [
    ['QB1', 'QB', 17], ['RB1', 'RB', 14],
    ['WR1', 'WR', 16], ['WR2', 'WR', 14], ['WR3', 'WR', 12], ['TE1', 'TE', 8],
  ])
  const fits = findFits(me, [mirror], REQ)
  assert.equal(fits.length, 1)
  assert.equal(fits[0].manager, 'Arthur')
  assert.equal(fits[0].theyCanSpare.pos, 'WR')
  assert.equal(fits[0].youCanSpare.pos, 'RB')
})

test('a manager deep everywhere is not a trade partner', () => {
  const stacked = sq('t3', 'Rich', [
    ['QB1', 'QB', 17], ['RB1', 'RB', 15], ['RB2', 'RB', 14], ['RB3', 'RB', 13],
    ['WR1', 'WR', 16], ['WR2', 'WR', 14], ['WR3', 'WR', 13], ['TE1', 'TE', 9],
  ])
  assert.equal(findFits(me, [stacked], REQ).length, 0)
})

test('it only ever offers players past the starters', () => {
  const mirror = sq('t2', 'Arthur', [
    ['QB1', 'QB', 17], ['RB1', 'RB', 14],
    ['WR1', 'WR', 16], ['WR2', 'WR', 14], ['WR3', 'WR', 12], ['TE1', 'TE', 8],
  ])
  const f = findFits(me, [mirror], REQ)[0]
  assert.deepEqual(f.youCanSpare.players.map((p) => p.name), ['RB3', 'RB4'])
  assert.deepEqual(f.theyCanSpare.players.map((p) => p.name), ['WR3'])
})

test('needing and sparing the same position is not a trade', () => {
  const odd = sq('t4', 'Sam', [['RB1', 'RB', 14], ['RB2', 'RB', 13], ['RB3', 'RB', 12]])
  assert.ok(findFits(me, [odd], REQ).every((f) => f.theyCanSpare.pos !== f.youCanSpare.pos))
})

test('a weak starter counts as a need even with bodies present', () => {
  const thin = sq('me2', 'me', [
    ['QB1', 'QB', 18], ['RB1', 'RB', 15], ['RB2', 'RB', 13], ['RB3', 'RB', 12],
    ['WR1', 'WR', 3], ['WR2', 'WR', 2], ['TE1', 'TE', 9],
  ])
  const mirror = sq('t2', 'Arthur', [
    ['RB1', 'RB', 14], ['WR1', 'WR', 16], ['WR2', 'WR', 14], ['WR3', 'WR', 12],
  ])
  const fits = findFits(thin, [mirror], REQ, ['WR'])
  assert.equal(fits.length, 1, 'two bad receivers still fill two slots, so only weakAt finds this')
  assert.equal(fits[0].theyCanSpare.pos, 'WR')
})
