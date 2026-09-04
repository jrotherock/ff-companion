import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advise, slotsFor } from './lineup.js'

const STEWARD = slotsFor(
  { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 },
  [{ name: 'W/R/T', eligible: ['RB', 'WR', 'TE'], count: 1 }],
)
const p = (
  name: string, pos: string, projected: number, starter: boolean,
  injuryStatus: string | null = null,
) => ({ id: name, name, pos, projected, starter, injuryStatus })

// The real lineup, as captured from Yahoo on 4 September 2026.
const squad = [
  p('Bo Nix', 'QB', 16.65, true), p('James Cook III', 'RB', 13.38, true),
  p('Derrick Henry', 'RB', 13.42, true), p('Jaylen Waddle', 'WR', 11.29, true),
  p('Ladd McConkey', 'WR', 10.72, true), p('Dallas Goedert', 'TE', 7.98, true),
  p('Christian Watson', 'WR', 10.21, true), p('Will Reichard', 'K', 9.2, true),
  p('Vikings', 'DST', 6.23, true), p('Rhamondre Stevenson', 'RB', 9.32, false),
  p('MarShawn Lloyd', 'RB', 10.17, false), p('Michael Wilson', 'WR', 7.6, false),
  p('Mike Washington Jr.', 'RB', 4.94, false),
]

test('leaves an already optimal lineup alone', () => {
  const out = advise(STEWARD, squad)
  assert.equal(out.swaps.length, 0)
  assert.equal(out.gain, 0)
  assert.equal(out.current.toFixed(2), '99.08')
})

test('benches a starter who cannot play, however he projects', () => {
  // Henry is the highest-projected back on the roster and is ruled out.
  const hurt = squad.map((x) => (x.name === 'Derrick Henry' ? { ...x, injuryStatus: 'OUT' } : x))
  const out = advise(STEWARD, hurt)
  const move = out.swaps.find((s) => s.out?.name === 'Derrick Henry')
  assert.ok(move, 'expected Henry to be replaced')
  assert.equal(move!.in.name, 'MarShawn Lloyd')
  assert.equal(move!.reason, 'out')
})

test('promotes a bench player who simply projects higher', () => {
  const weak = squad.map((x) => (x.name === 'Christian Watson' ? { ...x, projected: 3.0 } : x))
  const out = advise(STEWARD, weak)
  assert.equal(out.swaps[0].in.name, 'MarShawn Lloyd')
  assert.equal(out.swaps[0].slot, 'W/R/T')
  assert.equal(out.swaps[0].gain.toFixed(2), '7.17')
})

test('respects position eligibility — no kicker in the flex', () => {
  const odd = [...squad, p('Spare Kicker', 'K', 99, false)]
  const out = advise(STEWARD, odd)
  assert.ok(out.swaps.every((s) => s.slot !== 'W/R/T' || s.in.pos !== 'K'))
})

test('handles the IDP league shape', () => {
  const idp = slotsFor(
    { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DB: 2, DL: 2, LB: 2 },
    [{ name: 'W/R/T', eligible: ['RB', 'WR', 'TE'], count: 1 },
     { name: 'D', eligible: ['DB', 'DL', 'LB'], count: 1 }],
  )
  assert.equal(idp.length, 15)
  const out = advise(idp, [p('A Safety', 'DB', 12, false), p('A Weak DB', 'DB', 2, true)])
  assert.equal(out.swaps.length, 1)
  assert.equal(out.swaps[0].in.name, 'A Safety')
})
