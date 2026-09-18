/**
 * Plans for a questionable starter, on a Sunday laid out like a real one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slotsFor } from './lineup.js'
import { pivotPlans, INACTIVES_BEFORE, type PivotMan } from './pivot.js'

const slots = slotsFor(
  { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 },
  [{ name: 'FLEX', eligible: ['RB', 'WR', 'TE'], count: 1 }],
)
const H = 3600_000
const THURSDAY = Date.UTC(2026, 8, 17, 0, 15)      // already played
const NOW = Date.UTC(2026, 8, 20, 14, 0)            // Sunday 10:00 ET
const ONE = Date.UTC(2026, 8, 20, 17, 0)            // 1:00 ET
const FOUR = Date.UTC(2026, 8, 20, 20, 5)           // 4:05 ET
const NIGHT = Date.UTC(2026, 8, 21, 0, 20)          // 8:20 ET

const man = (id: string, pos: string, kickoff: number, starter: boolean, over: Partial<PivotMan> = {}): PivotMan =>
  ({ id, name: id, pos, projected: 10, injuryStatus: null, starter, kickoff, ...over })

// Everyone but the receivers and the flex, the same in every case.
const core = [
  man('qb', 'QB', ONE, true), man('rb1', 'RB', ONE, true), man('rb2', 'RB', ONE, true),
  man('te', 'TE', ONE, true), man('k', 'K', ONE, true), man('dst', 'DST', ONE, true),
]
const ladd = man('McConkey', 'WR', FOUR, true, { injuryStatus: 'Questionable' })

test('a late-game receiver with a late-game receiver behind him is covered', () => {
  const [plan] = pivotPlans(slots, [...core, ladd, man('Watson', 'WR', ONE, true), man('Waddle', 'WR', ONE, true),
    man('Tucker', 'WR', FOUR, false)], NOW)
  assert.equal(plan.plan, 'covered')
  assert.equal(plan.inactivesAt, FOUR - INACTIVES_BEFORE, 'ninety minutes before his kickoff')
  assert.deepEqual(plan.direct.map((c) => c.id), ['Tucker'])
})

test('when only a running back is still unlocked, he belongs in the flex', () => {
  /*
   * The one-o'clock receiver on the bench has locked by 2:35. A night-game
   * running back has not — but can only replace a receiver from the flex, so
   * the receiver has to be sitting there when the news comes, and moved there
   * before Waddle, who might be the one in it now, kicks off at one.
   */
  const [plan] = pivotPlans(slots, [...core, ladd, man('Watson', 'WR', ONE, true), man('Waddle', 'WR', ONE, true),
    man('EarlyWR', 'WR', ONE, false), man('NightRB', 'RB', NIGHT, false)], NOW)
  assert.equal(plan.plan, 'use-flex')
  assert.equal(plan.flex, 'FLEX')
  assert.deepEqual(plan.viaFlex.map((c) => c.id), ['NightRB'])
  assert.equal(plan.moveBy, ONE, 'before the receivers who might shift have kicked off')
})

test('he cannot sit in the flex if nobody else could fill the receiver slots', () => {
  // Only one other receiver starts; the flex holds a running back. Moving him
  // leaves a receiver slot empty, so the night-game back is no help.
  const [plan] = pivotPlans(slots, [...core, ladd, man('Watson', 'WR', ONE, true), man('FlexRB', 'RB', ONE, true),
    man('EarlyWR', 'WR', ONE, false), man('NightRB', 'RB', NIGHT, false)], NOW)
  assert.equal(plan.plan, 'decide-early')
  assert.equal(plan.decideBy, ONE, 'the bench receiver is the last replacement, and he locks at one')
})

test('a starter who has already played cannot be moved out of the way', () => {
  // Waddle played on Thursday. If he is the one in the flex he is stuck there.
  const [plan] = pivotPlans(slots, [...core, ladd, man('Watson', 'WR', ONE, true), man('Waddle', 'WR', THURSDAY, true),
    man('NightRB', 'RB', NIGHT, false)], NOW)
  assert.notEqual(plan.plan, 'use-flex')
})

test('nobody on the bench who could replace him is no cover', () => {
  const [plan] = pivotPlans(slots, [...core, ladd, man('Watson', 'WR', ONE, true), man('FlexRB', 'RB', ONE, true),
    man('BackupK', 'K', FOUR, false)], NOW)
  assert.equal(plan.plan, 'no-cover')
})

test('a replacement ruled out himself is not offered', () => {
  const [plan] = pivotPlans(slots, [...core, ladd, man('Watson', 'WR', ONE, true), man('Waddle', 'WR', ONE, true),
    man('HurtWR', 'WR', FOUR, false, { injuryStatus: 'Out' })], NOW)
  assert.ok(!plan.direct.some((c) => c.id === 'HurtWR'))
})

test('no plan for a healthy starter, or for one whose game has begun', () => {
  assert.deepEqual(pivotPlans(slots, [...core, man('Healthy', 'WR', FOUR, true)], NOW), [])
  assert.deepEqual(pivotPlans(slots, [...core, { ...ladd, kickoff: NOW - H }], NOW), [])
})

test('the deadline is the last replacement to lock, not the first', () => {
  /*
   * A night-game receiver's status is known at 6:50, after both bench
   * receivers have kicked off. The decision can wait for the 4:05 game —
   * saying one o'clock would have hurried it by three hours for nothing.
   */
  const [plan] = pivotPlans(slots, [...core, { ...ladd, kickoff: NIGHT },
    man('Watson', 'WR', ONE, true), man('FlexRB', 'RB', ONE, true),
    man('EarlyWR', 'WR', ONE, false), man('LateWR', 'WR', FOUR, false)], NOW)
  assert.equal(plan.plan, 'decide-early')
  assert.equal(plan.decideBy, FOUR)
})

test('a decision made blind still says who it is between', () => {
  /*
   * Nate Landman plays Monday night; the linebacker who would replace him
   * kicks off at one on Sunday. The plan knew that — it is how the deadline
   * was found — and then dropped the name, leaving "decide by one o'clock"
   * with nothing to decide about.
   */
  const [plan] = pivotPlans(slots, [...core, { ...ladd, kickoff: NIGHT, pos: 'WR' },
    man('Watson', 'WR', ONE, true), man('FlexRB', 'RB', ONE, true),
    man('EarlyWR', 'WR', ONE, false, { projected: 9.9 })], NOW)
  assert.equal(plan.plan, 'decide-early')
  assert.deepEqual(plan.decideAmong.map((c) => c.name), ['EarlyWR'])
  assert.equal(plan.projected, 10, 'and what he projects, to weigh against')
})
