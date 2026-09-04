import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, type Snapshot } from './rules.js'

const FRI = new Date(2026, 8, 4, 9, 0, 0).getTime()
const player = (o: Partial<Snapshot['players'][0]> & { name: string }) => ({
  id: o.name, pos: 'RB', starter: true, injuryStatus: null,
  projected: 10, kickoff: 'Sun 1:25 pm', ...o,
})
const snap = (o: Partial<Snapshot>): Snapshot => ({
  leagueId: 'l', label: 'Steward', link: null, players: [], advice: null, ...o,
})

test('a ruled-out starter always fires, and carries his own kickoff', () => {
  const a = evaluate(snap({ players: [player({ name: 'Henry', injuryStatus: 'OUT' })] }), FRI)
  assert.equal(a.length, 1)
  assert.equal(a[0].rule, 'starter-out')
  assert.ok(a[0].consequence >= 80, 'must clear the always-fire floor')
  assert.equal(new Date(a[0].deadline!).getDay(), 0)
})

test('a ruled-out bench player is not news', () => {
  const a = evaluate(snap({
    players: [player({ name: 'Washington', starter: false, injuryStatus: 'IR' })],
  }), FRI)
  assert.equal(a.length, 0)
})

test('points on the bench fire only near lock and only when material', () => {
  const players = [player({ name: 'Watson' })]
  const big = { gain: 8, swaps: [{ in: { name: 'Lloyd' }, out: { name: 'Watson' }, slot: 'W/R/T', gain: 8 }] }
  // Two days out, nothing to do yet.
  assert.equal(evaluate(snap({ players, advice: big }), FRI).length, 0)
  // Sunday morning, same fact, now actionable.
  const SUN = new Date(2026, 8, 6, 9, 0, 0).getTime()
  const near = evaluate(snap({ players, advice: big }), SUN)
  assert.equal(near.length, 1)
  assert.equal(near[0].rule, 'lineup-gain')
  // A single point never interrupts.
  assert.equal(evaluate(snap({ players, advice: { gain: 1, swaps: [] } }), SUN).length, 0)
})

test('a lineup nudge never outranks a ruled-out starter', () => {
  const SUN = new Date(2026, 8, 6, 9, 0, 0).getTime()
  const a = evaluate(snap({
    players: [player({ name: 'Henry', injuryStatus: 'OUT' })],
    advice: { gain: 30, swaps: [{ in: { name: 'Lloyd' }, out: { name: 'Henry' }, slot: 'RB', gain: 30 }] },
  }), SUN)
  const out = a.find((x) => x.rule === 'starter-out')!
  const gain = a.find((x) => x.rule === 'lineup-gain')!
  assert.ok(out.consequence > gain.consequence)
})

test('questionable waits until three hours before kickoff', () => {
  const players = [player({ name: 'Waddle', injuryStatus: 'Q', kickoff: 'Sun 1:25 pm' })]
  const SUN_MORNING = new Date(2026, 8, 6, 8, 0, 0).getTime()
  assert.equal(evaluate(snap({ players }), SUN_MORNING).length, 0, 'five hours out is a note')
  const SUN_NEAR = new Date(2026, 8, 6, 11, 0, 0).getTime()
  const a = evaluate(snap({ players }), SUN_NEAR)
  assert.equal(a.length, 1)
  assert.equal(a[0].rule, 'starter-questionable')
})

test('every alert carries a deadline, or it is a note not an alert', () => {
  const SUN = new Date(2026, 8, 6, 11, 0, 0).getTime()
  const all = evaluate(snap({
    players: [player({ name: 'Henry', injuryStatus: 'OUT' }), player({ name: 'Waddle', injuryStatus: 'Q' })],
    advice: { gain: 9, swaps: [{ in: { name: 'Lloyd' }, out: { name: 'Henry' }, slot: 'RB', gain: 9 }] },
  }), SUN)
  assert.ok(all.length >= 3)
  assert.ok(all.every((x) => x.deadline != null))
})
