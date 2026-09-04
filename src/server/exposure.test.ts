import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exposure, atRisk, type Squad } from './exposure.js'
import { byePlan } from './byes.js'
import { slotsFor } from './lineup.js'

const pl = (id: string, o: any = {}) => ({
  id, name: id, pos: 'RB', team: 'X', byeWeek: null, injuryStatus: null,
  starter: true, projected: 10, ...o,
})
const league = (leagueId: string, players: any[]): Squad =>
  ({ leagueId, label: leagueId, players })

test('a player started in three leagues outranks one started in one', () => {
  const out = exposure([
    league('a', [pl('Bijan'), pl('Solo')]),
    league('b', [pl('Bijan')]),
    league('c', [pl('Bijan')]),
  ])
  assert.equal(out[0].playerId, 'Bijan')
  assert.equal(out[0].startingIn, 3)
  assert.equal(out[0].projectedAcross, 30)
  assert.ok(!out.some((e) => e.playerId === 'Solo'), 'one league is not exposure')
})

test('bench copies count as holdings but not as points at risk', () => {
  const out = exposure([
    league('a', [pl('Swift', { starter: true, projected: 12 })]),
    league('b', [pl('Swift', { starter: false, projected: 12 })]),
  ])
  assert.equal(out[0].leagues.length, 2)
  assert.equal(out[0].startingIn, 1)
  assert.equal(out[0].projectedAcross, 12)
})

test('a designation seen in one league carries to the others', () => {
  const out = exposure([
    league('a', [pl('Hurt', { injuryStatus: null })]),
    league('b', [pl('Hurt', { injuryStatus: 'Q' })]),
  ])
  assert.equal(out[0].injuryStatus, 'Q')
})

test('at risk means hurt and starting in more than one place', () => {
  const all = exposure([
    league('a', [pl('Hurt', { injuryStatus: 'OUT' }), pl('Fine')]),
    league('b', [pl('Hurt', { injuryStatus: 'OUT' }), pl('Fine')]),
  ])
  assert.deepEqual(atRisk(all).map((e) => e.playerId), ['Hurt'])
})

const SLOTS = slotsFor({ QB: 1, RB: 2, TE: 1 }, [])

test('a bye week you cannot cover is reported ahead of time', () => {
  const squad = [
    pl('QB1', { pos: 'QB', byeWeek: 7 }),
    pl('RB1', { byeWeek: 7 }), pl('RB2', { byeWeek: 7 }),
    pl('TE1', { pos: 'TE', byeWeek: 9 }),
  ]
  const plan = byePlan(SLOTS, squad, 5, 10)
  const seven = plan.find((w) => w.week === 7)!
  assert.equal(seven.away, 3)
  assert.ok(seven.shortfalls.some((h) => h.slot === 'QB'))
  assert.ok(seven.shortfalls.some((h) => h.slot === 'RB'))
})

test('weeks with nobody away are not listed at all', () => {
  const squad = [pl('RB1', { byeWeek: 7 })]
  assert.deepEqual(byePlan(SLOTS, squad, 8, 12).map((w) => w.week), [])
})

test('the planner looks forward, never back', () => {
  const squad = [pl('RB1', { byeWeek: 3 }), pl('RB2', { byeWeek: 11 })]
  const weeks = byePlan(SLOTS, squad, 6, 14).map((w) => w.week)
  assert.ok(!weeks.includes(3), 'a bye already past cannot be planned for')
  assert.ok(weeks.includes(11))
})
