import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advise, bestLineup, slotsFor, type Candidate } from './lineup.js'

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

test('the IDP league fields a full fifteen, D flex included', () => {
  const slots = slotsFor(
    { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DB: 2, DL: 2, LB: 2 },
    [{ name: 'W/R/T', eligible: ['RB', 'WR', 'TE'], count: 1 },
     { name: 'D', eligible: ['DB', 'DL', 'LB'], count: 1 }],
  )
  const squad = [
    p('QB1', 'QB', 18, true), p('RB1', 'RB', 14, true), p('RB2', 'RB', 12, true),
    p('WR1', 'WR', 13, true), p('WR2', 'WR', 11, true), p('TE1', 'TE', 8, true),
    p('FLEX', 'WR', 10, true), p('K1', 'K', 9, true),
    p('DB1', 'DB', 9, true), p('DB2', 'DB', 8, true),
    p('DL1', 'DL', 7, true), p('DL2', 'DL', 6, true),
    p('LB1', 'LB', 12, true), p('LB2', 'LB', 11, true),
    p('LB3', 'LB', 10, true),   // the D flex
  ]
  const out = advise(slots, squad)
  assert.equal(out.swaps.length, 0, 'a full, correct fifteen needs no changes')
  assert.equal(out.current, 158)
})

test('the D flex takes the best defender left, not a receiver', () => {
  const slots = slotsFor({ DB: 1 }, [{ name: 'D', eligible: ['DB', 'DL', 'LB'], count: 1 }])
  const out = advise(slots, [
    p('starterDB', 'DB', 5, true),
    p('benchLB', 'LB', 11, false),
    p('benchWR', 'WR', 30, false),
  ])
  assert.equal(out.swaps.length, 1)
  assert.equal(out.swaps[0].in.name, 'benchLB')
  assert.equal(out.swaps[0].slot, 'D')
})

/* ------------------------------------------------- close calls and tiebreaks */

const cand = (o: Partial<Candidate> & { id: string }): Candidate => ({
  name: o.id, pos: 'RB', projected: 10, injuryStatus: null, starter: false, ...o,
})

test('a difference the projections cannot see is called a coin flip', () => {
  const slots = slotsFor({ RB: 1 }, [])
  const out = advise(slots, [
    cand({ id: 'starting', projected: 9.5, starter: true }),
    cand({ id: 'bench', projected: 10.1 }),
  ])
  assert.equal(out.swaps.length, 1)
  assert.equal(out.swaps[0].close, true, '0.6 apart is inside the noise')
  assert.equal(out.decisive, 0, 'nothing decisive is on the table')
})

test('a real gap is not a coin flip', () => {
  const slots = slotsFor({ RB: 1 }, [])
  const out = advise(slots, [
    cand({ id: 'starting', projected: 6, starter: true }),
    cand({ id: 'bench', projected: 12 }),
  ])
  assert.equal(out.swaps[0].close, false)
  assert.equal(out.decisive, 6)
})

test('a player ruled out is never a coin flip, however small the gain', () => {
  const slots = slotsFor({ RB: 1 }, [])
  const out = advise(slots, [
    cand({ id: 'hurt', projected: 9.9, starter: true, injuryStatus: 'Out' }),
    cand({ id: 'fit', projected: 0.5 }),
  ])
  assert.equal(out.swaps[0].reason, 'out')
  assert.equal(out.swaps[0].close, false)
})

test('consensus breaks a tie the projections cannot, and only then', () => {
  const slots = slotsFor({ RB: 1 }, [])
  // Half a point apart: the lower projection with the better expert rank wins.
  const inside = bestLineup(slots, [
    cand({ id: 'higher-proj', projected: 10.1, weekRank: 30 }),
    cand({ id: 'better-rank', projected: 9.6, weekRank: 4 }),
  ])
  assert.equal([...inside.values()][0].id, 'better-rank')

  // Six points apart: the projection is not in doubt, so rank is ignored.
  const outside = bestLineup(slots, [
    cand({ id: 'higher-proj', projected: 16, weekRank: 30 }),
    cand({ id: 'better-rank', projected: 9.6, weekRank: 4 }),
  ])
  assert.equal([...outside.values()][0].id, 'higher-proj')
})

test('the defence faced breaks a tie the consensus cannot', () => {
  const slots = slotsFor({ RB: 1 }, [])
  // Same projection band, no consensus either way: the softer defence wins.
  const out = bestLineup(slots, [
    cand({ id: 'hard-matchup', projected: 10.1, dvpRank: 31 }),
    cand({ id: 'soft-matchup', projected: 9.7, dvpRank: 3 }),
  ])
  assert.equal([...out.values()][0].id, 'soft-matchup')
})

test('the consensus outranks the matchup when they disagree', () => {
  const slots = slotsFor({ RB: 1 }, [])
  const out = bestLineup(slots, [
    cand({ id: 'experts-like-him', projected: 10.0, weekRank: 5, dvpRank: 31 }),
    cand({ id: 'soft-matchup', projected: 9.8, weekRank: 26, dvpRank: 2 }),
  ])
  assert.equal([...out.values()][0].id, 'experts-like-him')
})

test('the tiebreak never makes the headline negative', () => {
  const slots = slotsFor({ RB: 1 }, [])
  // The consensus prefers the lower projection; the gain must not go below zero.
  const out = advise(slots, [
    cand({ id: 'starting', projected: 10.2, weekRank: 30, starter: true }),
    cand({ id: 'bench', projected: 9.3, weekRank: 6 }),
  ])
  assert.ok(out.gain >= 0, `gain was ${out.gain}`)
  assert.equal(out.decisive, 0, 'nothing decisive when the only move is inside the noise')
  assert.equal(out.swaps[0]?.close, true)
})
