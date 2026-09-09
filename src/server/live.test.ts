/**
 * A tile during a game.
 *
 * "Lineup set, nobody flagged" is a sentence about a decision that has closed,
 * and "watch one starter" after his kickoff asks for something no longer
 * possible. Both were shown all Sunday.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weekState, liveWhy } from './cockpit.js'
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
