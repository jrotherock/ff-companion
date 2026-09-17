/**
 * Measured play rates, and the practice report that reads them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlayerIndex } from '../kernel/match.js'
import {
  bodyOf, countSeason, nameKey, playRate, posGroupOf, severityOfRate, type PlayRates, type Rec,
} from './playRates.js'
import { csv, forWeek, reportFrom } from './nflverse.js'

/* ------------------------------------------------------------ normalising */

test('a body part is one question however the report spells it', () => {
  assert.equal(bodyOf('Knee, Ankle'), 'knee', 'filed under the first injury')
  assert.equal(bodyOf('Right Hamstring'), 'hamstring')
  assert.equal(bodyOf('Ribs'), 'rib')
  assert.equal(bodyOf('Not Injury Related - Resting Player'), 'rest')
  assert.equal(bodyOf('Not Injury Related - Personal Matter'), 'personal')
  assert.equal(bodyOf(''), null)
})

test('names agree across two files that spell them differently', () => {
  assert.equal(nameKey('Kenneth Murray, Jr.'), nameKey('Kenneth Murray'))
  assert.equal(nameKey("Ja'Marr Chase"), nameKey('JaMarr Chase'))
})

test('only positions someone starts are counted', () => {
  assert.equal(posGroupOf('CB'), 'DB')
  assert.equal(posGroupOf('OLB'), 'LB')
  assert.equal(posGroupOf('T'), null, 'a tackle is nobody\'s lineup decision')
})

/* ---------------------------------------------------------------- counting */

const report = (full_name: string, week: number, report_status: string, practice_status: string,
                extra: Partial<Rec> = {}): Rec => ({
  game_type: 'REG', team: 'LAC', position: 'WR', full_name, week: String(week),
  report_status, practice_status, report_primary_injury: 'Rib', practice_primary_injury: 'Rib', ...extra,
})
const snap = (player: string, week: number, team = 'LAC'): Rec => ({
  game_type: 'REG', team, player, week: String(week), offense_snaps: '40', defense_snaps: '0', st_snaps: '0',
})
const empty = (): Pick<PlayRates, 'designated' | 'byPractice'> => ({ designated: {}, byPractice: {} })

test('a questionable player who played last week is counted, and whether he played this week', () => {
  const into = empty()
  countSeason(
    [report('Ladd McConkey', 3, 'Questionable', 'Did Not Participate In Practice')],
    [snap('Ladd McConkey', 2), snap('Somebody Else', 3)],
    into,
  )
  assert.deepEqual(into.designated['Questionable|DNP'], { played: 0, listed: 1 })
  assert.deepEqual(into.designated['Questionable|DNP|body:rib'], { played: 0, listed: 1 })
  assert.deepEqual(into.byPractice['DNP|pos:WR'], { played: 0, listed: 1 })
})

test('a player who did not play the week before is not counted at all', () => {
  /*
   * A man in his return window from injured reserve practises fully and sits.
   * Counted, he dragged "questionable after a full week" down to 69%, when
   * among players who had been playing it is 90.
   */
  const into = empty()
  countSeason(
    [report('Back From IR', 6, 'Questionable', 'Full Participation in Practice')],
    [snap('Someone Else', 5), snap('Someone Else', 6)],
    into,
  )
  assert.deepEqual(into.designated, {})
})

test('a bye is looked through to the game before it', () => {
  const into = empty()
  countSeason(
    [report('Ladd McConkey', 8, 'Questionable', 'Limited Participation in Practice')],
    [snap('Ladd McConkey', 6), snap('Ladd McConkey', 8)],   // week 7 is the bye: no LAC rows
    into,
  )
  assert.deepEqual(into.designated['Questionable|Limited'], { played: 1, listed: 1 })
})

test('Mike and Michael are one man, Cam and Mike Jackson are two', () => {
  const into = empty()
  countSeason(
    [report('Mike Onwenu', 4, 'Questionable', 'Full Participation in Practice', { team: 'NE', position: 'WR' })],
    [snap('Michael Onwenu', 3, 'NE'), snap('Michael Onwenu', 4, 'NE')],
    into,
  )
  assert.deepEqual(into.designated['Questionable|Full'], { played: 1, listed: 1 }, 'initial and surname, unambiguous')

  const two = empty()
  countSeason(
    [report('Mike Jackson', 4, 'Questionable', 'Full Participation in Practice', { team: 'CAR' })],
    [snap('Mike Jackson', 3, 'CAR'), snap('Michael Jackson', 4, 'CAR'), snap('Marcus Jackson', 4, 'CAR')],
    two,
  )
  assert.deepEqual(two.designated['Questionable|Full'], { played: 0, listed: 1 },
    'two M. Jacksons that week: no guess is made')
})

/* ------------------------------------------------------------------ reading */

const rates: Pick<PlayRates, 'designated' | 'byPractice'> = {
  designated: {
    'Questionable|DNP': { played: 753, listed: 1508 },
    'Questionable|DNP|pos:WR': { played: 150, listed: 274 },
    'Questionable|DNP|body:rib': { played: 7, listed: 21 },
    'Questionable|DNP|body:hamstring': { played: 37, listed: 120 },
  },
  byPractice: {
    DNP: { played: 2393, listed: 7908 },
    'DNP|body:rib': { played: 11, listed: 99 },
  },
}

test('the most specific count with enough cases is the one read', () => {
  const ham = playRate(rates, { designation: 'Questionable', practice: 'DNP', pos: 'WR', body: 'hamstring' })!
  assert.equal(ham.listed, 120, 'hamstrings: 120 cases, enough')
  assert.equal(ham.basis, 'questionable after not practising, hamstring injuries')

  const rib = playRate(rates, { designation: 'Questionable', practice: 'DNP', pos: 'WR', body: 'rib' })!
  assert.equal(rib.listed, 274, 'ribs: only 21 cases, so receivers')
  assert.equal(rib.basis, 'questionable after not practising, receivers')

  const qb = playRate(rates, { designation: 'Questionable', practice: 'DNP', pos: 'QB', body: 'toe' })!
  assert.equal(qb.listed, 1508, 'nothing narrower measured: everyone')
})

test('mid-week, before a game status, the practice log alone is read', () => {
  const r = playRate(rates, { designation: 'pending', practice: 'DNP', pos: 'WR', body: 'rib' })!
  assert.equal(r.played, 11)
  assert.equal(r.listed, 99)
  assert.equal(r.basis, 'players whose week ended at not practising, rib injuries')
})

test('likely means clearly more than even, either way', () => {
  assert.equal(severityOfRate(0.50), 'coin-flip', 'questionable after no practice: the old buckets said likely out')
  assert.equal(severityOfRate(0.11), 'likely-out')
  assert.equal(severityOfRate(0.90), 'likely-plays')
  assert.equal(severityOfRate(0.25), 'coin-flip', 'the boundary belongs to the coin flip')
  assert.equal(severityOfRate(0.75), 'likely-plays')
})

/* --------------------------------------------------------- the report file */

const HEAD = 'season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,' +
  'report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,practice_secondary_injury,practice_status'

test('a name with a comma in it does not shift every column after it', () => {
  const { rows, head } = csv([
    HEAD,
    '2025,REG,REG,DAL,5,00-0036441,LB,"Kenneth Murray, Jr.",Kenneth,Murray,Knee,,Questionable,Knee,,Limited Participation in Practice',
  ].join('\n'))
  assert.equal(rows[0][head.indexOf('full_name')], 'Kenneth Murray, Jr.')
  assert.equal(rows[0][head.indexOf('practice_status')], 'Limited Participation in Practice')
})

const index = new PlayerIndex([
  { id: 'ladd', name: 'Ladd McConkey', pos: 'WR', team: 'LAC', byeWeek: 7, ids: {} },
  { id: 'cook', name: 'James Cook', pos: 'RB', team: 'BUF', byeWeek: 7, ids: {} },
  { id: 'old', name: 'Week One Only', pos: 'WR', team: 'LAC', byeWeek: 7, ids: {} },
] as any)

const WEEK_TWO = [
  HEAD,
  '2026,REG,REG,LAC,2,x,WR,Ladd McConkey,Ladd,McConkey,,,,Rib,,Did Not Participate In Practice',
  '2026,REG,REG,BUF,2,x,RB,James Cook,James,Cook,Ankle,,Questionable,Ankle,,Limited Participation in Practice',
  '2026,REG,REG,LAC,1,x,WR,Week One Only,Week,One,Knee,,Questionable,Knee,,Limited Participation in Practice',
].join('\n')

test('a club that has not set game statuses is pending, and one that has is not', () => {
  const rows = reportFrom(WEEK_TWO, index, rates as PlayRates)
  const ladd = rows.find((r) => r.playerId === 'ladd')!
  const cook = rows.find((r) => r.playerId === 'cook')!
  assert.equal(ladd.pending, true, 'the Chargers had not finished their report')
  assert.equal(cook.pending, false, 'Buffalo plays Thursday and had')
  assert.equal(ladd.injury, 'Rib', 'named by the practice column before the game status exists')
  assert.equal(ladd.rate!.listed, 99, 'read as a practice log, not as a questionable tag')
  assert.equal(ladd.severity, 'likely-out')
})

test('without measured rates the old reading stands rather than nothing', () => {
  const rows = reportFrom(WEEK_TWO, index, null)
  const ladd = rows.find((r) => r.playerId === 'ladd')!
  assert.equal(ladd.rate, null)
  assert.equal(ladd.severity, 'likely-out')
})

test('a player listed in week one does not carry his report into week two', () => {
  /*
   * A player's latest report used to be his report. Seventy-six players were
   * carrying week one's practice into week two on the Thursday this was found.
   */
  const rows = forWeek(reportFrom(WEEK_TWO, index, rates as PlayRates), 2)
  assert.deepEqual(rows.map((r) => r.playerId).sort(), ['cook', 'ladd'])
})

test('a rest day is not called an injury', () => {
  const r = playRate({ designated: {}, byPractice: { DNP: { played: 1, listed: 2 }, 'DNP|body:rest': { played: 785, listed: 801 } } },
    { designation: 'pending', practice: 'DNP', pos: 'RB', body: 'rest' })!
  assert.equal(r.basis, 'players whose week ended at not practising, rest days')
})
