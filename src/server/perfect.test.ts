import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slotsFor } from './lineup.js'
import { perfectWeek, record } from './perfect.js'

const slots = slotsFor(
  { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 },
  [{ name: 'FLEX', eligible: ['RB', 'WR', 'TE'], count: 1 }],
)
const m = (id: string, pos: string, starter: boolean) => ({ id, name: id, pos, starter })
const squad = [
  m('QB1', 'QB', true), m('RB1', 'RB', true), m('RB2', 'RB', true),
  m('WR1', 'WR', true), m('WR2', 'WR', true), m('TE1', 'TE', true),
  m('FLEX1', 'RB', true), m('K1', 'K', true), m('DST1', 'DST', true),
  m('BENCH_RB', 'RB', false), m('BENCH_WR', 'WR', false),
]
const scored = (over: Record<string, number>) => (id: string) =>
  ({ QB1: 20, RB1: 15, RB2: 10, WR1: 12, WR2: 9, TE1: 7, FLEX1: 8, K1: 6, DST1: 5,
     BENCH_RB: 4, BENCH_WR: 3, ...over } as Record<string, number>)[id] ?? 0

test('a lineup nobody could have improved is a hundred per cent', () => {
  const w = perfectWeek(2, slots, squad, scored({}))
  assert.equal(w.actual, 92)
  assert.equal(w.perfect, 92)
  assert.equal(w.left, 0)
  assert.equal(w.share, 1)
  assert.deepEqual(w.missed, [])
})

test('the points that sat on the bench, and who they belonged to', () => {
  /* The bench back went for twenty-two; the flex played for eight. */
  const w = perfectWeek(2, slots, squad, scored({ BENCH_RB: 22 }))
  assert.equal(w.actual, 92)
  assert.equal(w.perfect, 106, 'the bench man takes the flex')
  assert.equal(w.left, 14)
  assert.equal(w.share, 0.8679)
  /*
   * The slot named is where the man coming in lands, which for a back who
   * outscores the starter is the back's own slot — the lineup shuffles down
   * from there, and the eight-point flex is the one who ends up out.
   */
  assert.deepEqual(w.missed, [{ in: 'BENCH_RB', out: 'FLEX1', slot: 'RB', gain: 14 }])
})

test('a slot nobody on the bench could fill is not a miss', () => {
  /* The bench receiver outscored the kicker, and cannot kick. */
  const w = perfectWeek(2, slots, squad, scored({ K1: 1, BENCH_WR: 11 }))
  assert.equal(w.left, 3, 'he takes a receiver slot and pushes the nine-point one to the flex')
  assert.ok(w.missed.every((x) => x.slot !== 'K'), 'the kicker keeps his slot whatever he scored')
})

test('a week nobody scored in cannot be graded', () => {
  const w = perfectWeek(2, slots, squad, () => 0)
  assert.equal(w.share, null)
  assert.equal(w.left, 0)
})

test('the season is the average of the weeks that have one', () => {
  const r = record([
    { week: 2, actual: 80, perfect: 100, left: 20, share: 0.8, missed: [] },
    { week: 1, actual: 90, perfect: 90, left: 0, share: 1, missed: [] },
    { week: 3, actual: 0, perfect: 0, left: 0, share: null, missed: [] },
  ])
  assert.equal(r.share, 0.9)
  assert.equal(r.left, 20)
  assert.deepEqual(r.weeks.map((w) => w.week), [1, 2, 3], 'in the order they were played')
})
