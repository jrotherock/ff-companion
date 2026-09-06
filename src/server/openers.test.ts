/**
 * The 18-team opener rule. Measured from the 5 September mock at slot 14:
 * twenty-seven picks separate the second-round pick from the third, and the
 * receiver pool fell twice as far across that gap as the backfield did. Each
 * pick in that mock was right on its own value and the roster still finished
 * with a 0.8 receiver in the second slot, so the rule prices the wait rather
 * than the pick.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateStrategy } from '../kernel/preferences.js'
import { buildRoster } from '../kernel/roster.js'
import type { Player, Pos } from '../kernel/types.js'

const league = JSON.parse(readFileSync('data/leagues/yahoo-guillotine.json', 'utf8'))
const rules = JSON.parse(readFileSync('data/preferences/yahoo-guillotine.rules.json', 'utf8'))
const { players } = JSON.parse(readFileSync('data/players.json', 'utf8')) as { players: Player[] }
const map = new Map(players.map((p) => [p.id, p]))
const prefs = { leagueId: league.id, likes: [], avoids: [], rules: rules.rules }

const someone = (pos: Pos) => players.find((p) => p.pos === pos)!.id
const advise = (squad: string[], round: number) =>
  evaluateStrategy(
    prefs as any,
    buildRoster(league, squad, map, () => 1),
    round,
    league,
    new Map(),
    new Map(),
  ).filter((a) => a.ruleId === 'two-backs-two-receivers-by-4')

test('a back-heavy start is told what it still owes, and by when', () => {
  // RB-RB-RB, which is the shape that finished with a 0.8 receiver.
  const out = advise([someone('RB'), someone('RB'), someone('RB')], 3)
  assert.equal(out.length, 1, 'the rule should speak while there is still time to act')
  assert.match(out[0].message, /2 more WR/)
  assert.match(out[0].message, /by round 4/)
})

test('it falls silent once both are in hand', () => {
  const squad = [someone('RB'), someone('WR'), someone('TE'), someone('QB')]
  // Only one of each so far: still short.
  assert.equal(advise(squad, 3).length, 1)
})

test('nothing to say when the shape is already right', () => {
  const rb = players.filter((p) => p.pos === 'RB').slice(0, 2).map((p) => p.id)
  const wr = players.filter((p) => p.pos === 'WR').slice(0, 2).map((p) => p.id)
  assert.equal(advise([...rb, ...wr], 4).length, 0)
})

test('the old RB-RB opener is gone from the eighteen-team league', () => {
  const ids = rules.rules.map((r: any) => r.id)
  assert.ok(!ids.includes('rb-rb-start'), 'RB-RB would contradict the receiver deadline')
  assert.ok(ids.includes('two-backs-two-receivers-by-4'))
})

/**
 * The round-14 kicker. A defensive line slot sat empty from round ten until
 * round twenty, and nothing said so — the "kicker last" rule only speaks once
 * the kicker is the last pick left to make, which is a reminder rather than a
 * warning.
 */
test('a kicker while a starting slot is empty is called depth, and says what fills it', () => {
  const rb = players.filter((p) => p.pos === 'RB').slice(0, 2).map((p) => p.id)
  const wr = players.filter((p) => p.pos === 'WR').slice(0, 2).map((p) => p.id)
  const lb = players.filter((p) => p.pos === 'LB').slice(0, 3).map((p) => p.id)
  const db = players.filter((p) => p.pos === 'DB').slice(0, 2).map((p) => p.id)
  // Everything but the second defensive line slot, which is what happened.
  const squad = [...rb, ...wr, ...lb, ...db, someone('QB'), someone('TE'),
    players.filter((p) => p.pos === 'DL')[0].id]
  const best = new Map<Pos, { name: string; value: number; tierLeft: number }>([
    ['DL', { name: 'Maxx Crosby', value: 2.4, tierLeft: 3 }],
  ])
  const out = evaluateStrategy(
    prefs as any,
    buildRoster(league, squad, map, () => 1),
    14,
    league,
    new Map(),
    best,
  ).filter((a) => a.ruleId === 'starters-before-depth')
  assert.equal(out.length, 1, 'round 14 with an empty DL slot must be flagged')
  assert.match(out[0].message, /DL/)
  assert.match(out[0].message, /Maxx Crosby/)
  assert.match(out[0].message, /bench depth/)
})

test('it stays quiet early, and once the lineup is whole', () => {
  const full = [
    ...players.filter((p) => p.pos === 'RB').slice(0, 3).map((p) => p.id),
    ...players.filter((p) => p.pos === 'WR').slice(0, 2).map((p) => p.id),
    ...players.filter((p) => p.pos === 'LB').slice(0, 3).map((p) => p.id),
    ...players.filter((p) => p.pos === 'DL').slice(0, 2).map((p) => p.id),
    ...players.filter((p) => p.pos === 'DB').slice(0, 2).map((p) => p.id),
    someone('QB'), someone('TE'), someone('K'),
  ]
  const only = (squad: string[], round: number) =>
    evaluateStrategy(prefs as any, buildRoster(league, squad, map, () => 1), round, league, new Map(), new Map())
      .filter((a) => a.ruleId === 'starters-before-depth')
  assert.equal(only([someone('RB')], 3).length, 0, 'silent before round 10')
  assert.equal(only(full, 15).length, 0, 'silent when every slot is filled')
})
