/**
 * Yahoo's answers, read. Every fixture here is a recorded answer, trimmed and
 * with the managers' names replaced, so each oddity tested is one Yahoo sent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  at, flat, leagueNodes, list, num, parseDiscovery, parseRosters, parseScoreboard, parseSettings,
  parseStandings, parseTeamWeek, parseTransactions,
} from './yahooParse.js'

const F = JSON.parse(readFileSync('fixtures/yahoo-api.json', 'utf8'))
const node = (json: any, key: string) => leagueNodes(json).find((n) => n.meta.league_key === key)!
const H2H = '470.l.1604981'
const CHOP = '470.l.310904'
const DEATH = '470.l.1667636'

/* ---------------------------------------------------------------- shapes */

test('a list is keyed "0", "1" beside a count, and an empty one is []', () => {
  assert.deepEqual(list({ 0: 'a', 1: 'b', count: 2 }), ['a', 'b'])
  assert.deepEqual(list([]), [], 'the chopped team\'s roster')
  assert.deepEqual(list([{ a: 1 }, { b: 2 }]), [{ a: 1 }, { b: 2 }],
    'and a real array is its own collection, never silently dropped')
  assert.deepEqual(list(undefined), [])
  assert.equal(at([{ teams: 1 }], 0).teams, 1, 'standings wrap their teams in a real array')
  assert.equal(at({ 0: { teams: 2 } }, 0).teams, 2, 'a scoreboard wraps its matchups in a keyed one')
})

test('a record is one-key fragments with empty arrays between them', () => {
  assert.deepEqual(flat([{ a: 1 }, [], { b: 2 }, []]), { a: 1, b: 2 })
  assert.deepEqual(flat({ a: 1 }), { a: 1 }, 'and a record that is already whole passes through')
})

test('a number is a number however it was sent, and absent is not nought', () => {
  assert.equal(num('111.06'), 111.06)
  assert.equal(num(104.76), 104.76)
  assert.equal(num('0'), 0)
  assert.equal(num(''), null)
  assert.equal(num(undefined), null)
  assert.equal(num('n/a'), null)
})

/* --------------------------------------------------------------- leagues */

test('every league on the account, with the one that starts late saying so', () => {
  const ls = parseDiscovery(F.discovery)
  assert.equal(ls.length, 5)
  const death = ls.find((l) => l.key === DEATH)!
  assert.equal(death.startWeek, 2)
  assert.equal(death.guillotine, true)
  assert.equal(death.teams, 14)
  assert.equal(ls.find((l) => l.key === H2H)!.guillotine, false)
})

/* --------------------------------------------------------------- rosters */

test('a roster says whose team is mine, and each man\'s slot and status', () => {
  const teams = parseRosters(node(F.rosters, H2H).body)
  const mine = teams.filter((t) => t.mine)
  assert.equal(mine.length, 1, 'exactly one team is the signed-in user\'s')
  assert.equal(mine[0].id, '5')
  assert.equal(mine[0].manager, 'Manager 5')
  const black = mine[0].players.find((p) => p.name === 'Kaelon Black')!
  assert.equal(black.status, 'Q')
  assert.equal(black.injury, 'Groin')
  assert.equal(black.slot, 'BN')
  assert.equal(black.team, 'SF', 'Yahoo\'s mixed-case club, upper-cased')
  assert.equal(black.yahooId, '42712')
})

test('a defence is named by its nickname and a defender by several positions', () => {
  const all = [...parseRosters(node(F.rosters, H2H).body), ...parseRosters(node(F.rosters, CHOP).body)]
    .flatMap((t) => t.players)
  const def = all.find((p) => p.display === 'DEF')!
  assert.ok(!/\s/.test(def.name) || def.name.split(' ').length <= 2, `a nickname, not a city: ${def.name}`)
  assert.ok(all.some((p) => p.display.includes(',')), 'at least one compound position like LB,DE')
})

test('a team the guillotine took has no players, and is still a team', () => {
  const teams = parseRosters(node(F.rosters, CHOP).body)
  const chopped = teams.find((t) => t.id === '16')!
  assert.deepEqual(chopped.players, [])
  assert.ok(teams.find((t) => t.id === '5')!.players.length > 0)
})

test('a team\'s week carries each man\'s points as a number', () => {
  const t = parseTeamWeek(F.teamWeek)!
  assert.equal(t.week, 2)
  assert.equal(t.mine, true)
  const gibbs = t.players.find((p) => p.name === 'Jahmyr Gibbs')!
  assert.equal(gibbs.points, 20.3, 'Detroit played on Thursday')
  assert.ok(t.players.every((p) => typeof p.points === 'number'))
})

/* ------------------------------------------------------------ scoreboard */

test('a finished week names its winner; a running one does not', () => {
  const done = parseScoreboard(node(F.scoreboardWeek1, H2H).body)!
  assert.equal(done.week, 1)
  assert.ok(done.matchups.every((m) => m.status === 'postevent'))
  assert.ok(done.matchups.every((m) => m.winnerTeamId || m.tied))
  const live = parseScoreboard(node(F.scoreboard, H2H).body)!
  assert.equal(live.week, 2)
  assert.ok(live.matchups.every((m) => m.status === 'midevent' && m.winnerTeamId == null))
  assert.ok(live.matchups[0].sides.every((s) => s.projected != null && s.points != null))
})

test('a guillotine "matchup" is every team against the one projected lowest', () => {
  const sb = parseScoreboard(node(F.scoreboard, CHOP).body)!
  const lowest = sb.matchups.map((m) => m.sides[1].teamId)
  assert.ok(lowest.filter((id) => id === '17').length >= 2, 'team 17 is on the other side of every row')
})

/* ------------------------------------------------------------- standings */

test('a head-to-head record, whatever types it arrived in', () => {
  const rows = parseStandings(node(F.standings, H2H).body)
  const me = rows.find((r) => r.mine)!
  assert.equal(me.teamId, '5')
  for (const r of rows) {
    for (const k of ['wins', 'losses', 'ties', 'pointsFor', 'pointsAgainst'] as const) {
      assert.equal(typeof r[k], 'number', `${k} for team ${r.teamId}`)
    }
  }
})

test('a guillotine standing is a live rank and a distance from the chop', () => {
  const rows = parseStandings(node(F.standings, CHOP).body)
  const me = rows.find((r) => r.mine)!
  assert.equal(me.wins, null, 'no record in a league with no games')
  assert.equal(me.rankWeek, 2)
  assert.equal(me.projectedWeek, 155.13)
  const chop = rows.find((r) => r.teamId === '17')!
  assert.ok(chop.fromChop! < 0, 'the team on the block is behind the next lowest')
  assert.equal(rows.find((r) => r.teamId === '16')!.projectedWeek, 0, 'and the chopped team projects nothing')
})

/* ---------------------------------------------------------- transactions */

test('an add is an array and a drop is an object, in the same move', () => {
  const txs = parseTransactions(node(F.transactions, H2H).body)
  const both = txs.find((t) => t.type === 'add/drop')!
  const add = both.players.find((p) => p.kind === 'add')!
  const drop = both.players.find((p) => p.kind === 'drop')!
  assert.ok(add.toTeamId && add.fromType === 'freeagents')
  assert.equal(drop.fromTeamId, add.toTeamId, 'one manager, both halves')
  assert.equal(drop.toType, 'waivers')
  assert.ok(both.at > Date.UTC(2026, 7, 1), 'seconds become milliseconds')
})

test('a commissioner\'s action carries no players and is kept as such', () => {
  const txs = parseTransactions(node(F.transactions, CHOP).body)
  const commish = txs.find((t) => t.type === 'commish')
  assert.ok(commish, 'the recording had one')
  assert.deepEqual(commish!.players, [])
})

/* -------------------------------------------------------------- settings */

test('settings give the slots and what every scored stat is worth', () => {
  const s = parseSettings(node(F.settings, DEATH).body)!
  assert.deepEqual(s.positions.map((p) => `${p.pos}x${p.count}${p.starting ? '' : '-'}`),
    ['QBx1', 'RBx2', 'WRx2', 'TEx1', 'W/R/Tx1', 'BNx7-', 'IRx1-'])
  assert.equal(s.scored.find((x) => x.name === 'Receptions')!.value, 0.5)
  assert.ok(s.draftTime! > Date.UTC(2026, 8, 1))
})
