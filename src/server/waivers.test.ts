import { test } from 'node:test'
import assert from 'node:assert/strict'
import { holes, targets, nextWaiverClear } from './waivers.js'
import { slotsFor } from './lineup.js'

const SLOTS = slotsFor(
  { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 },
  [{ name: 'W/R/T', eligible: ['RB', 'WR', 'TE'], count: 1 }],
)
const p = (id: string, pos: string, o: any = {}) => ({
  id, pos, starter: true, injuryStatus: null, projected: 10, byeWeek: null, ...o,
})

test('a healthy roster has no holes', () => {
  const squad = [p('q', 'QB'), p('r1', 'RB'), p('r2', 'RB'), p('r3', 'RB'),
    p('w1', 'WR'), p('w2', 'WR'), p('w3', 'WR'), p('t', 'TE'), p('t2', 'TE'),
    p('k', 'K'), p('k2', 'K'), p('d', 'DST'), p('d2', 'DST')]
  assert.deepEqual(holes(SLOTS, squad), [])
})

test('a position with nobody who can play is the worst kind of hole', () => {
  const squad = [p('t', 'TE', { injuryStatus: 'IR' })]
  const h = holes(SLOTS, squad).find((x) => x.slot === 'TE')!
  assert.ok(h.severity >= 90)
  assert.match(h.reason, /out or on bye/)
})

test('a lone starter is only thin when he is already doubtful', () => {
  const healthy = [p('q', 'QB')]
  assert.equal(holes(SLOTS, healthy).filter((x) => x.slot === 'QB').length, 0,
    'one healthy quarterback in a one-quarterback league is normal')
  const doubtful = [p('q', 'QB', { injuryStatus: 'Q' })]
  const h = holes(SLOTS, doubtful).find((x) => x.slot === 'QB')!
  assert.match(h.reason, /no cover/)
})

test('a bye counts as unavailable', () => {
  const squad = [p('k', 'K', { byeWeek: 10 })]
  assert.ok(holes(SLOTS, squad, 10).some((x) => x.slot === 'K'))
  assert.ok(!holes(SLOTS, squad, 9).some((x) => x.slot === 'K' && x.severity >= 90))
})

test('wanting an upgrade is not a hole', () => {
  const squad = [p('q', 'QB'), p('q2', 'QB'), p('r1', 'RB', { projected: 2 }),
    p('r2', 'RB', { projected: 2 }), p('r3', 'RB', { projected: 2 }),
    p('w1', 'WR'), p('w2', 'WR'), p('w3', 'WR'), p('t', 'TE'), p('t2', 'TE'),
    p('k', 'K'), p('k2', 'K'), p('d', 'DST'), p('d2', 'DST')]
  // Three bad backs still fill two slots and the flex. Bad is not empty.
  assert.equal(holes(SLOTS, squad).filter((x) => x.pos.includes('RB')).length, 0)
})

test('targets are ranked on points, with interest only breaking ties', () => {
  const need = [{ slot: 'TE', pos: ['TE'], reason: '', severity: 95 }]
  const free = [
    { id: 'hyped', name: 'Everyone Is Adding Him', pos: 'TE', team: 'X' },
    { id: 'good', name: 'Quietly Better', pos: 'TE', team: 'Y' },
    { id: 'wrong', name: 'Wrong Position', pos: 'QB', team: 'Z' },
  ]
  const out = targets(free, need,
    new Map([['hyped', 4], ['good', 9]]), new Map([['hyped', 50000], ['good', 10]]))
  assert.deepEqual(out.map((x) => x.id), ['good', 'hyped'])
  assert.equal(out[0].fills, 'TE')
})

test('no holes means no targets, however tempting the wire', () => {
  assert.deepEqual(targets([{ id: 'a', name: 'A', pos: 'RB', team: 'X' }], [], new Map(), new Map()), [])
})

test('the next clear is in the future and names the day it assumed', () => {
  const FRI = new Date(2026, 8, 4, 9, 0, 0)
  const w = nextWaiverClear(2, FRI)!
  assert.ok(w.at > FRI.getTime())
  assert.equal(w.assumed, 'Tuesday')
  assert.equal(new Date(w.at).getDay(), 2)
})

test('an unknown waiver day yields nothing rather than a guess', () => {
  assert.equal(nextWaiverClear(null), null)
})
