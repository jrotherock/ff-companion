/**
 * Hand-read injury takes, and grading them against who took a snap.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grade, mergeTakes, records, validateTakes, type Take } from './experts.js'
import { snapIndex, type Rec } from './playRates.js'

const snap = (player: string, team: string, week: number): Rec => ({
  game_type: 'REG', team, player, week: String(week), offense_snaps: '30', defense_snaps: '0', st_snaps: '0',
})
const teammate = (team: string, week: number) => snap('Somebody Else', team, week)

const raw = (over: Record<string, unknown> = {}) => ({
  week: 2, player: 'Ladd McConkey', team: 'LAC', analyst: 'Jesse Morse', credential: 'MD',
  outlet: 'The Injury Expertz', call: 'game-time', note: 'Practice this week decides it; no timeline given.',
  link: 'https://www.theinjuryexpertz.com/ladd-mcconkey', at: '2026-09-17', ...over,
})
const take = (over: Record<string, unknown> = {}): Take => {
  const r = validateTakes({ season: 2026, takes: [raw(over)] })
  if (!r.ok) throw new Error(r.errors.join('; '))
  return r.takes[0]
}

/* ------------------------------------------------------------- validating */

test('a take is kept with the credential its outlet states, and an id per analyst, player and week', () => {
  const t = take()
  assert.equal(t.credential, 'MD')
  assert.equal(t.id, '2026-2-jesse-morse-ladd-mcconkey')
})

test('a link that is not https never becomes an href', () => {
  for (const link of ['javascript:alert(1)', 'http://example.com/x', 'not a url']) {
    assert.equal(validateTakes({ season: 2026, takes: [raw({ link })] }).ok, false, link)
  }
})

test('the note is a plain line, not markup and not an essay', () => {
  assert.equal(validateTakes({ season: 2026, takes: [raw({ note: '<b>plays</b>' })] }).ok, false)
  assert.equal(validateTakes({ season: 2026, takes: [raw({ note: 'x'.repeat(161) })] }).ok, false)
})

test('an out-weeks call needs its range, fewest first', () => {
  assert.equal(validateTakes({ season: 2026, takes: [raw({ call: 'out-weeks' })] }).ok, false)
  assert.equal(validateTakes({ season: 2026, takes: [raw({ call: 'out-weeks', weeks: [4, 2] })] }).ok, false)
  assert.ok(validateTakes({ season: 2026, takes: [raw({ call: 'out-weeks', weeks: [2, 4] })] }).ok)
})

test('a credential is letters as outlets write them, not a sentence', () => {
  assert.ok(validateTakes({ season: 2026, takes: [raw({ credential: 'MS, ATC' })] }).ok)
  assert.equal(validateTakes({ season: 2026, takes: [raw({ credential: 'orthopedic surgeon' })] }).ok, false)
})

test('a later take from the same analyst that week replaces the earlier one', () => {
  const first = take({ call: 'game-time', at: '2026-09-17' })
  const second = take({ call: 'sits', at: '2026-09-19' })
  const ledger = mergeTakes(mergeTakes({ season: 2026, takes: [] }, [first]), [second])
  assert.equal(ledger.takes.length, 1)
  assert.equal(ledger.takes[0].call, 'sits')
})

/* ----------------------------------------------------------------- grading */

test('plays and sits are graded on whether he took a snap', () => {
  const snaps = snapIndex([snap('Ladd McConkey', 'LAC', 2)])
  assert.equal(grade(take({ call: 'plays' }), snaps), 'right')
  assert.equal(grade(take({ call: 'sits' }), snaps), 'wrong')
})

test('a week not yet played is pending, not wrong', () => {
  const snaps = snapIndex([snap('Ladd McConkey', 'LAC', 1)])
  assert.equal(grade(take({ call: 'sits' }), snaps), 'pending')
})

test('a game-time call is never graded', () => {
  // It is an honest answer, not a call; grading it would reward hedging.
  const snaps = snapIndex([snap('Ladd McConkey', 'LAC', 2)])
  assert.equal(grade(take({ call: 'game-time' }), snaps), 'hedged')
})

test('out two to four weeks, back after three games, is right', () => {
  const snaps = snapIndex([
    teammate('LAC', 2), teammate('LAC', 3), teammate('LAC', 4), snap('Ladd McConkey', 'LAC', 5),
  ])
  assert.equal(grade(take({ call: 'out-weeks', weeks: [2, 4] }), snaps), 'right')
})

test('a bye is not a game missed', () => {
  // Out two games, with the Chargers' bye between them: back in week 5, two missed.
  const snaps = snapIndex([teammate('LAC', 2), teammate('LAC', 4), snap('Ladd McConkey', 'LAC', 5)])
  assert.equal(grade(take({ call: 'out-weeks', weeks: [2, 2] }), snaps), 'right')
})

test('past the most games called, it is wrong before he is even back', () => {
  const snaps = snapIndex([teammate('LAC', 2), teammate('LAC', 3), teammate('LAC', 4)])
  assert.equal(grade(take({ call: 'out-weeks', weeks: [1, 2] }), snaps), 'wrong')
})

test('still out and still inside the range is pending', () => {
  const snaps = snapIndex([teammate('LAC', 2)])
  assert.equal(grade(take({ call: 'out-weeks', weeks: [1, 4] }), snaps), 'pending')
})

test('the Rams are LA in the snap file and LAR everywhere else', () => {
  const snaps = snapIndex([snap('Puka Nacua', 'LA', 2)])
  assert.equal(grade(take({ call: 'plays', player: 'Puka Nacua', team: 'LAR' }), snaps), 'right')
})

test('a record counts right, wrong, hedged and pending per analyst', () => {
  const snaps = snapIndex([snap('Ladd McConkey', 'LAC', 2), teammate('BUF', 2)])
  const takes = [
    take({ call: 'plays' }),
    take({ call: 'sits', player: 'James Cook', team: 'BUF' }),
    take({ call: 'game-time', player: 'Josh Allen', team: 'BUF' }),
    take({ call: 'plays', player: 'Jaylen Waddle', team: 'DEN' }),
  ]
  const [r] = records({ season: 2026, takes }, snaps)
  assert.deepEqual({ right: r.right, wrong: r.wrong, hedged: r.hedged, pending: r.pending },
    { right: 2, wrong: 0, hedged: 1, pending: 1 })
})
