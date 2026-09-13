/**
 * A tile during a game.
 *
 * "Lineup set, nobody flagged" is a sentence about a decision that has closed,
 * and "watch one starter" after his kickoff asks for something no longer
 * possible. Both were shown all Sunday.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weekState, liveWhy, scoreRead, paceOf, moversOf, leadOf, phaseAsRead } from './cockpit.js'
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

test('movers: a finished man counts both ways, a playing one only once he is past it', () => {
  // a, b done; c playing; d not started.
  const pts: Record<string, number> = { a: 20, b: 3, c: 8, d: 0 }
  const due: Record<string, number> = { a: 12, b: 13, c: 16, d: 14 }
  const out = moversOf(['a', 'b', 'c', 'd'], players, kicks, NOW,
    (id) => pts[id] ?? null, (id) => due[id] ?? null)
  assert.deepEqual(out.map((m) => [m.id, m.swing]), [['b', -10], ['a', 8]],
    'the half-time man is on schedule, not eight short, and the unstarted man is nowhere')
})

test('movers: an equal swing goes to the man you were relying on more', () => {
  const due: Record<string, number> = { a: 10, b: 20 }
  const out = moversOf(['a', 'b'], players, kicks, NOW,
    (id) => ({ a: 16, b: 14 } as Record<string, number>)[id] ?? null, (id) => due[id] ?? null)
  assert.deepEqual(out.map((m) => m.id), ['b', 'a'], 'six each, and b was due twice as much')
})

test('movers: a playing man already past his projection is known good news', () => {
  const out = moversOf(['c'], players, kicks, NOW, () => 21, () => 16)
  assert.equal(out.length, 1)
  assert.equal(out[0].swing, 5)
  assert.equal(out[0].live, true, 'and it is marked as a floor, because he is still out there')
})

test('movers: no baseline, no swing', () => {
  assert.deepEqual(moversOf(['a'], players, kicks, NOW, () => 9, () => 0), [])
  assert.deepEqual(moversOf(['a'], players, kicks, NOW, () => 9, () => null), [])
})

test('lead: the most-expected starter under way, stated as progress', () => {
  const due: Record<string, number> = { a: 12, c: 22, d: 30 }
  const lead = leadOf(['a', 'c', 'd'], players, kicks, NOW,
    (id) => ({ a: 14, c: 6 } as Record<string, number>)[id] ?? null, (id) => due[id] ?? null)
  assert.deepEqual(lead, { id: 'c', got: 6, due: 22 },
    'd carries more expectation but has not kicked off, so he is not the one to report')
})

test('a half-time capture is not a final score just because the clock has moved on', () => {
  /*
   * The laptop sleeps at two and the sensor stops; the one o'clock games end at
   * a quarter past four. By five the clock calls those men finished, and their
   * half-time totals would be reported as their day.
   */
  const sea = kicks.get('SEA')!                  // kicked off four hours before NOW
  const halfTime = sea + 90 * 60 * 1000          // read an hour and a half in
  assert.equal(phaseAsRead(sea, NOW, NOW), 'done', 'read after the whistle: final')
  assert.equal(phaseAsRead(sea, NOW, halfTime), 'playing', 'read at half time: still playing, whatever the clock says')

  // 6 of a projected 16 at half time. Treated as final this is a ten-point
  // shortfall; treated honestly it is not a verdict at all.
  const stale = moversOf(['a'], players, kicks, NOW, () => 6, () => 16, halfTime)
  assert.deepEqual(stale, [], 'no bad news from a score that was never final')
  const fresh = moversOf(['a'], players, kicks, NOW, () => 6, () => 16, NOW)
  assert.equal(fresh[0]?.swing, -10, 'the same numbers read after the whistle are a real shortfall')
})
