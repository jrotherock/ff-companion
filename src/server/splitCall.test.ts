import { test } from 'node:test'
import assert from 'node:assert/strict'
import { disagreement, type Side } from './splitCall.js'

const dome = { roof: 'dome' }
const rough = { roof: 'open', windMph: 22, summary: 'Windy' }

test('everything agreeing is not a decision', () => {
  const a: Side = { name: 'Swift', weekRank: 14, role: 0.35, weather: dome }
  const b: Side = { name: 'Warren', weekRank: 27, role: 0.29, weather: rough }
  assert.equal(disagreement(a, b), null, 'three signals, one answer, nothing to say')
})

test('one signal alone is the tiebreak doing its job, not a split', () => {
  const a: Side = { name: 'Smith', weekRank: 10 }
  const b: Side = { name: 'McConkey', weekRank: 39, role: null }
  assert.equal(disagreement(a, b), null)
})

test('the consensus and the usage pointing at different men is', () => {
  /* The real call: Waddle ranked higher, McConkey using more of his offence. */
  const waddle: Side = { name: 'Jaylen Waddle', weekRank: 21, role: 0.08, roleWeeks: 1 }
  const ladd: Side = { name: 'Ladd McConkey', weekRank: 39, role: 0.16, roleWeeks: 1,
                       injuryStatus: 'Questionable' }
  const s = disagreement(waddle, ladd)!
  assert.ok(s, 'flagged')
  assert.deepEqual(s.votes.map((v) => [v.signal, v.prefers]),
    [['consensus', 'Jaylen Waddle'], ['role', 'Ladd McConkey']])
  assert.match(s.caveat!, /Ladd McConkey is questionable/)
  assert.match(s.caveat!, /measured from the games he did play/)
})

test('a rank within five places is a tie, not an opinion', () => {
  const a: Side = { name: 'A', weekRank: 22, role: 0.30 }
  const b: Side = { name: 'B', weekRank: 25, role: 0.10 }
  // Only the role has an opinion, so there is nothing for it to disagree with.
  assert.equal(disagreement(a, b), null)
})

test('a roof is the absence of weather, not good weather', () => {
  const a: Side = { name: 'Indoors', weekRank: 30, role: 0.10, weather: dome }
  const b: Side = { name: 'Outdoors', weekRank: 12, role: 0.10, weather: { roof: 'open' } }
  // Open and calm is no worse than a dome, so weather has no opinion here and
  // only the consensus speaks.
  assert.equal(disagreement(a, b), null)
  const windy = disagreement(a, { ...b, weather: rough })!
  assert.deepEqual(windy.votes.map((v) => v.signal), ['consensus', 'weather'])
  assert.equal(windy.votes[1].prefers, 'Indoors')
})

test('no forecast at all is silence, not fair weather', () => {
  const a: Side = { name: 'A', weekRank: 12, role: 0.10, weather: null }
  const b: Side = { name: 'B', weekRank: 30, role: 0.25, weather: { roof: null } }
  const s = disagreement(a, b)!
  assert.deepEqual(s.votes.map((v) => v.signal), ['consensus', 'role'])
})
