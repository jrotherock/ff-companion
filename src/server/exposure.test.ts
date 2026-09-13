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

test('the worst designation wins, not the first one read', () => {
  /*
   * The comment said so for a season while the code took whichever league came
   * first, so a man Out on one platform and Questionable on a slower one showed
   * as Questionable.
   */
  const out = exposure([
    league('slow', [pl('Hurt', { injuryStatus: 'Q' })]),
    league('fresh', [pl('Hurt', { injuryStatus: 'Out' })]),
  ])
  assert.equal(out[0].injuryStatus, 'Out')

  const reversed = exposure([
    league('fresh', [pl('Hurt', { injuryStatus: 'Out' })]),
    league('slow', [pl('Hurt', { injuryStatus: 'Q' })]),
  ])
  assert.equal(reversed[0].injuryStatus, 'Out', 'and it does not matter which league is read first')
})

test('live scoring sums across leagues, each against its own projection', () => {
  // PPR in one league, half-PPR in the other: different points, same player.
  const out = exposure([
    league('ppr', [pl('Gibbs', { projected: 20, points: 26, game: 'done' })]),
    league('half', [pl('Gibbs', { projected: 17, points: 22, game: 'done' })]),
  ])
  assert.deepEqual(out[0].live, { got: 48, swing: 11, leagues: 2, playing: false },
    'six over in one and five over in the other is eleven over, whatever the units')
})

test('before his game starts there is no live reading at all', () => {
  const out = exposure([
    league('a', [pl('Later', { points: null, game: 'pre' })]),
    league('b', [pl('Later', { points: null, game: 'pre' })]),
  ])
  assert.equal(out[0].live, null)
})

test('one league with no baseline withholds the swing rather than under-reporting it', () => {
  const out = exposure([
    league('a', [pl('Gibbs', { projected: 20, points: 26, game: 'done' })]),
    league('b', [pl('Gibbs', { projected: 0, points: 22, game: 'done' })]),
  ])
  assert.equal(out[0].live?.got, 48, 'the points are still real')
  assert.equal(out[0].live?.swing, null, 'but a sum that silently skips a league is a smaller lie')
})

test('news without a designation still reaches the section', () => {
  const news = { headline: 'Rookie takes over early downs', link: null, at: 1 }
  const out = exposure([
    league('a', [pl('Healthy', { news })]),
    league('b', [pl('Healthy')]),
  ])
  assert.equal(out[0].injuryStatus, null)
  assert.deepEqual(out[0].news, news, 'a role change is as much news as a hamstring')
})
