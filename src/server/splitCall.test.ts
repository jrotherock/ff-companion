import { test } from 'node:test'
import assert from 'node:assert/strict'
import { disagreement, reopens, type Side, type Split } from './splitCall.js'

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

const humphrey = { side: 'upgrade' as const, corner: 'Marlon Humphrey' }
const mitchell = { side: 'downgrade' as const, corner: 'Quinyon Mitchell' }

test('the coverage column votes for the man it upgraded', () => {
  // The consensus prefers the other receiver by ten places; RotoBaller singled
  // this one out for the corner he draws. Two voices, two answers.
  const olave: Side = { name: 'Chris Olave', weekRank: 18, coverage: humphrey }
  const other: Side = { name: 'Tetairoa McMillan', weekRank: 8 }
  const s = disagreement(olave, other)!
  assert.ok(s, 'flagged')
  assert.deepEqual(s.votes.map((v) => [v.signal, v.prefers]),
    [['consensus', 'Tetairoa McMillan'], ['coverage', 'Chris Olave']])
  assert.equal(s.votes[1].why, 'RotoBaller calls his matchup with Marlon Humphrey an upgrade')
})

test('and against the man it downgraded, naming him rather than the other', () => {
  /*
   * The vote goes to the receiver the column left alone, but the reason is
   * about the one it marked down — "calls his matchup a downgrade" under the
   * wrong man's name would say the opposite of what the column said.
   */
  const tate: Side = { name: 'Carnell Tate', weekRank: 20, coverage: mitchell }
  const other: Side = { name: 'Jalen Coker', weekRank: 30 }
  const s = disagreement(tate, other)!
  assert.ok(s, 'flagged')
  assert.deepEqual(s.votes.map((v) => [v.signal, v.prefers]),
    [['consensus', 'Carnell Tate'], ['coverage', 'Jalen Coker']])
  assert.equal(s.votes[1].why, "RotoBaller calls Carnell Tate's matchup with Quinyon Mitchell a downgrade")
})

test('two upgrades cancel out', () => {
  // Two receivers the column likes equally say nothing about which to start,
  // so only the consensus is left with an opinion — and one opinion is not a split.
  const a: Side = { name: 'A', weekRank: 10, coverage: humphrey }
  const b: Side = { name: 'B', weekRank: 30, coverage: { side: 'upgrade', corner: 'Chris Johnson' } }
  assert.equal(disagreement(a, b), null)
})

test('the column agreeing with the consensus is not a split', () => {
  const a: Side = { name: 'A', weekRank: 10, coverage: humphrey }
  const b: Side = { name: 'B', weekRank: 30 }
  assert.equal(disagreement(a, b), null, 'two voices, one answer')
})

test('with the chart read in, a score gap of a standard deviation is an opinion', () => {
  const nacua: Side = { name: 'Puka Nacua', weekRank: 12, coverage: { corner: 'Greg Newsome II', score: 16.89 } }
  const other: Side = { name: 'Garrett Wilson', weekRank: 4, coverage: { corner: 'Keisean Nixon', score: 3.52 } }
  const s = disagreement(nacua, other)!
  assert.ok(s, 'flagged')
  assert.deepEqual(s.votes.map((v) => [v.signal, v.prefers]),
    [['consensus', 'Garrett Wilson'], ['coverage', 'Puka Nacua']])
  assert.equal(s.votes[1].why,
    "his matchup with Greg Newsome II scores +16.89, Garrett Wilson's with Keisean Nixon +3.52")
})

test('and anything closer is not', () => {
  // The call it was first looked at against: 4.21 apart, just inside the noise.
  const coker: Side = { name: 'Jalen Coker', weekRank: 30, coverage: { corner: 'Avieon Terrell', score: -2.00 } }
  const wilson: Side = { name: 'Michael Wilson', weekRank: 40, coverage: { corner: 'Josh Jobe', score: 2.21 } }
  assert.equal(disagreement(coker, wilson), null, 'only the consensus has an opinion')
})

test('a receiver off the chart gives the chart nothing to compare', () => {
  /*
   * A tight end in the flex has no corner. Scoring him as nought would have
   * the chart preferring any receiver with a positive matchup over him, which
   * is an opinion it never gave.
   */
  const wr: Side = { name: 'Chris Olave', weekRank: 30, coverage: { corner: 'Marlon Humphrey', score: 10.12 } }
  const te: Side = { name: 'Isaiah Likely', weekRank: 10 }
  assert.equal(disagreement(wr, te), null)
})

test('one dissenting signal does not reopen a call the projection decided', () => {
  /*
   * Inside the coin flip a single disagreement is the whole point. Once the
   * projection has an opinion, something disagrees with it constantly — the
   * lower-projected man wins 38% of three-point gaps — so one voice is the
   * ordinary state of the world and two are a reason to look again.
   */
  const one: Split = { votes: [{ signal: 'consensus', prefers: 'Lawrence', why: '' },
                               { signal: 'role', prefers: 'Love', why: '' }], caveat: null }
  assert.equal(reopens(one, 'Lawrence'), false)
  const two: Split = { votes: [{ signal: 'consensus', prefers: 'Lawrence', why: '' },
                               { signal: 'weather', prefers: 'Lawrence', why: '' },
                               { signal: 'role', prefers: 'Love', why: '' }], caveat: null }
  assert.equal(reopens(two, 'Lawrence'), true)
  assert.equal(reopens(null, 'Lawrence'), false)
})

test('outside the coin flip, the signals are disagreeing with the projection', () => {
  /*
   * Jordan Love over Trevor Lawrence: the projection likes Love by 2.4, the
   * consensus has Lawrence six places higher and Love's game is the wet one.
   * The two dissenters agree with each other, so without the projection in the
   * room there was no disagreement to find and the call disappeared.
   */
  const love: Side = { name: 'Jordan Love', weekRank: 16, weather: { roof: 'open', summary: '50% rain' } }
  const law: Side = { name: 'Trevor Lawrence', weekRank: 10, weather: { roof: 'open', summary: null } }
  assert.equal(disagreement(love, law), null, 'both dissenters point the same way')

  const s = disagreement(love, law, { prefers: 'Jordan Love', gap: 2.36 })!
  assert.deepEqual(s.votes.map((v) => [v.signal, v.prefers]),
    [['projection', 'Jordan Love'], ['consensus', 'Trevor Lawrence'], ['weather', 'Trevor Lawrence']])
  assert.equal(s.votes[0].why, 'projects 2.4 higher')
  assert.equal(reopens(s, 'Trevor Lawrence'), true, 'two signals against the projection reopens it')
})

test('the projection alone, with nothing against it, is not a split', () => {
  const a: Side = { name: 'A', weekRank: 10 }
  const b: Side = { name: 'B', weekRank: 12 }
  assert.equal(disagreement(a, b, { prefers: 'A', gap: 2.2 }), null, 'one voice is not an argument')
})
