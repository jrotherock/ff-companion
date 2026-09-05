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
