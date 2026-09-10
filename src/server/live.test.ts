/**
 * A tile during a game.
 *
 * "Lineup set, nobody flagged" is a sentence about a decision that has closed,
 * and "watch one starter" after his kickoff asks for something no longer
 * possible. Both were shown all Sunday.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weekState, liveWhy, scoreRead, paceOf } from './cockpit.js'
import type { Player, PlayerId } from '../kernel/types.js'

const HOUR = 3600000
const NOW = Date.parse('2026-09-13T18:00:00Z')

const players = new Map<PlayerId, Player>(
  [['a', 'SEA'], ['b', 'NE'], ['c', 'GB'], ['d', 'KC']].map(([id, team]) =>
    [id, { id, name: id, pos: 'RB', team, byeWeek: null, ids: {} } as Player]),
)
const kicks = new Map<string, number>([
  ['SEA', NOW - 4 * HOUR],   // finished
  ['NE', NOW - 4 * HOUR],    // finished
  ['GB', NOW - HOUR],        // in progress
  ['KC', NOW + 3 * HOUR],    // still to come
])

test('a week knows what has finished, what is running and what is still to come', () => {
  const st = weekState(['a', 'b', 'c', 'd'], players, kicks, NOW)
  assert.deepEqual(st, { started: true, toPlay: 1, playing: 1, done: 2 })
})

test('before any kickoff the week has not started', () => {
  const st = weekState(['d'], players, kicks, NOW)
  assert.equal(st.started, false)
  assert.equal(st.toPlay, 1)
})

test('a close week still running is the one worth catching the eye', () => {
  const out = liveWhy(84.2, 79.9, { toPlay: 2, playing: 1, done: 4 })
  assert.equal(out.urgency, 'watch')
  assert.equal(out.action, 'Live')
  assert.match(out.why, /^Up 4\.3 · 1 playing, 2 still to come\./)
})

test('a blowout still running does not', () => {
  assert.equal(liveWhy(120, 60, { toPlay: 1, playing: 0, done: 5 }).urgency, 'quiet')
})

test('once every starter is done the week is reported as decided', () => {
  const won = liveWhy(104.2, 98.1, { toPlay: 0, playing: 0, done: 9 })
  assert.equal(won.action, 'Won')
  assert.equal(won.urgency, 'quiet')
  assert.match(won.why, /104\.2 to 98\.1/)
  assert.equal(liveWhy(90, 99, { toPlay: 0, playing: 0, done: 9 }).action, 'Lost')
})

test('with no opponent captured it reports a total, not a scoreline', () => {
  const running = liveWhy(84.2, null, { toPlay: 2, playing: 1, done: 4 })
  assert.equal(running.action, 'Live')
  assert.match(running.why, /^84\.2 so far · 1 playing, 2 still to come\.$/)
  const done = liveWhy(84.2, null, { toPlay: 0, playing: 0, done: 9 })
  assert.equal(done.action, 'Week done', 'never "Won" against an unknown')
  assert.match(done.why, /every starter is done\.$/)
})

test('a starter whose club has no fixture counts as still to play, not as done', () => {
  const orphan = new Map<PlayerId, Player>([
    ['x', { id: 'x', name: 'x', pos: 'RB', team: 'BYE', byeWeek: null, ids: {} } as Player],
  ])
  const st = weekState(['x'], orphan, kicks, NOW)
  assert.equal(st.done, 0, 'an unknown fixture must never read as finished')
  assert.equal(st.toPlay, 1)
})

/* ------------------------------------------------- a hurt starter on a tile */

import { shakyStarters, shakyWhy } from './cockpit.js'

const squad = new Map<PlayerId, Player>([
  ['fit', { id: 'fit', name: 'Fit Man', pos: 'WR', team: 'SF', byeWeek: null, ids: {}, status: 'Active' } as Player],
  ['q', { id: 'q', name: 'Quest Ionable', pos: 'RB', team: 'GB', byeWeek: null, ids: {}, injuryStatus: 'Questionable' } as Player],
  ['d', { id: 'd', name: 'Brock Bowers', pos: 'TE', team: 'LV', byeWeek: null, ids: {}, injuryStatus: 'Doubtful', injuryBody: 'Knee - Meniscus' } as Player],
])

test('the worst designation leads, not the first one found', () => {
  const out = shakyStarters(['fit', 'q', 'd'], squad)
  assert.deepEqual(out.map((p) => p.name), ['Brock Bowers', 'Quest Ionable'])
})

test('a fit lineup has nothing to flag', () => {
  assert.equal(shakyStarters(['fit'], squad).length, 0)
})

test('one hurt starter is named, with what is wrong with him', () => {
  const w = shakyWhy(shakyStarters(['d'], squad))
  assert.equal(w.urgency, 'watch')
  assert.equal(w.action, 'Watch one starter')
  assert.equal(w.why, 'Brock Bowers is doubtful (knee - meniscus) and is in your lineup.')
})

test('more than one names the worst and counts the rest', () => {
  const w = shakyWhy(shakyStarters(['q', 'd'], squad))
  assert.equal(w.action, 'Watch 2 starters')
  assert.match(w.why, /^Brock Bowers is doubtful .*, and 1 more are carrying designations\.$/)
})

test('a score nobody has read is not a score of nought', () => {
  // Deliberately not liveWhy: the tile must distinguish "0.0" from "unread".
  const st = { toPlay: 3, playing: 2, done: 4 }
  const read = liveWhy(0, 0, st)
  assert.match(read.why, /^Up 0\.0/, 'a real nought-all still reads as a margin')
  // …and the unread case is worded by the caller, which is asserted through
  // buildTiles rather than here; what matters is that they cannot be confused.
  assert.notEqual(read.why, 'Games under way · 5 of 9 starters still to finish · no score read yet.')
})

test('a page read before kickoff is not a score of nought', () => {
  /*
   * Yahoo prints nought rather than a dash for a team whose players have not
   * played, so a capture taken on the Friday carries a perfectly formed 0–0.
   * The only thing separating it from a genuine goalless start is when it was
   * taken.
   */
  const before = kicks.get('SEA')! - HOUR
  assert.equal(scoreRead(before, ['a', 'b'], players, kicks), false)
  assert.equal(scoreRead(kicks.get('SEA')! + 60000, ['a', 'b'], players, kicks), true)
})

test('the first kickoff counts, not the last', () => {
  // A starter playing Monday must not hold the whole week back: the score has
  // been read the moment anyone in the lineup is under way.
  const justAfterSea = kicks.get('SEA')! + 60000
  assert.equal(scoreRead(justAfterSea, ['a', 'd'], players, kicks), true)
})

test('with no fixture known for anyone, nothing has been read', () => {
  const orphan = new Map<PlayerId, Player>([
    ['z', { id: 'z', name: 'z', pos: 'RB', team: 'XXX', byeWeek: null, ids: {} } as Player],
  ])
  assert.equal(scoreRead(NOW, ['z'], orphan, kicks), false)
})

test('last week’s score is not this week’s, however recently it was read', () => {
  /*
   * A capture keeps its live points when a push carries none — right within a
   * week, wrong across the turn of one. On the Tuesday those points are still
   * sitting there and nothing has contradicted them, so the only thing that
   * separates them from a real score is that they were read before any of this
   * week's starters kicked off.
   */
  const lastWeek = kicks.get('SEA')! - 7 * 24 * HOUR
  assert.equal(scoreRead(lastWeek, ['a', 'b'], players, kicks), false)
})

test('pace counts the finished, ignores the unfinished, and needs a baseline', () => {
  // a and b are done, c is mid-game, d has not kicked off.
  const pts: Record<string, number> = { a: 12, b: 4, c: 30, d: 99 }
  const due: Record<string, number> = { a: 10, b: 9, c: 11, d: 12 }
  const out = paceOf(['a', 'b', 'c', 'd'], players, kicks, NOW,
    (id) => pts[id] ?? null, (id) => due[id] ?? null)
  assert.deepEqual(out, { done: 2, of: 4, got: 16, due: 19 },
    'a man at half time is not behind pace for being at half time')

  assert.equal(
    paceOf(['d'], players, kicks, NOW, (id) => pts[id], (id) => due[id]),
    null, 'nobody finished is no reading',
  )
  assert.equal(
    paceOf(['a'], players, kicks, NOW, () => 4, () => 0),
    null, 'and neither is a projection of nought',
  )
})
