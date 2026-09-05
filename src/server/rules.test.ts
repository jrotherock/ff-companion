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

test('waivers need money, a hole and somebody to fix it — all three', () => {
  const SOON = Date.now() + 2 * 60 * 60 * 1000
  const full = {
    clearsAt: SOON, assumedDay: 'Tuesday', budget: 200, spent: 0,
    holes: [{ slot: 'TE', reason: 'nobody who can play', severity: 95 }],
    targets: [{ name: 'A Tight End', pos: 'TE', fills: 'TE', projected: 8 }],
  }
  const fire = evaluate(snap({ waivers: full }), Date.now())
  assert.equal(fire.length, 1)
  assert.equal(fire[0].rule, 'waivers-closing')

  // Remove any one leg and it stays quiet.
  assert.equal(evaluate(snap({ waivers: { ...full, spent: 200 } }), Date.now()).length, 0)
  assert.equal(evaluate(snap({ waivers: { ...full, holes: [] } }), Date.now()).length, 0)
  assert.equal(evaluate(snap({ waivers: { ...full, targets: [] } }), Date.now()).length, 0)
})

test('waivers do not interrupt two days early', () => {
  const FAR = Date.now() + 48 * 60 * 60 * 1000
  assert.equal(evaluate(snap({ waivers: {
    clearsAt: FAR, assumedDay: 'Tuesday', budget: 200, spent: 0,
    holes: [{ slot: 'TE', reason: 'x', severity: 95 }],
    targets: [{ name: 'T', pos: 'TE', fills: 'TE', projected: 8 }],
  } }), Date.now()).length, 0)
})

test('a waiver alert never outranks a ruled-out starter', () => {
  const SOON = Date.now() + 2 * 60 * 60 * 1000
  const a = evaluate(snap({
    players: [player({ name: 'Henry', injuryStatus: 'OUT' })],
    waivers: { clearsAt: SOON, assumedDay: 'Tue', budget: 200, spent: 0,
      holes: [{ slot: 'TE', reason: 'x', severity: 100 }],
      targets: [{ name: 'T', pos: 'TE', fills: 'TE', projected: 8 }] },
  }), Date.now())
  const out = a.find((x) => x.rule === 'starter-out')!
  const wav = a.find((x) => x.rule === 'waivers-closing')!
  assert.ok(out.consequence > wav.consequence)
})

test('a draft warns half an hour out, and not before', () => {
  const at = Date.now() + 90 * 60 * 1000
  const league = { leagueId: 'g', label: 'Harker Football Green', link: null,
    players: [], advice: null, draft: { at, slotSet: false, mySlot: null } }
  assert.equal(evaluate(snap(league as any), Date.now()).length, 0,
    'ninety minutes out is not yet news')

  const near = Date.now() + 20 * 60 * 1000
  const a = evaluate(snap({ ...league, draft: { at: near, slotSet: false, mySlot: null } } as any), Date.now())
  assert.equal(a.length, 1)
  assert.equal(a[0].rule, 'draft-imminent')
  assert.match(a[0].headline, /drafts in \d+ minutes/)
})

test('a missed draft cannot be undone, so it is never rationed', () => {
  const near = Date.now() + 10 * 60 * 1000
  const a = evaluate(snap({ leagueId: 'g', label: 'Green', link: null, players: [], advice: null,
    draft: { at: near, slotSet: true, mySlot: 8 } } as any), Date.now())
  assert.ok(a[0].consequence >= 80, 'must clear the always-fire floor')
  assert.match(a[0].detail, /slot 8/)
})

test('a draft already begun is not announced as upcoming', () => {
  const past = Date.now() - 60 * 1000
  assert.equal(evaluate(snap({ leagueId: 'g', label: 'Green', link: null, players: [], advice: null,
    draft: { at: past, slotSet: true, mySlot: 8 } } as any), Date.now()).length, 0)
})

test('a stale roster is only worth saying before the games', () => {
  const old = Date.now() - 4 * 24 * 60 * 60 * 1000
  const base = { players: [player({ name: 'Nix', kickoff: 'Sun 1:25 pm' })], capturedAt: old }
  const FRI = new Date(2026, 8, 4, 9, 0, 0).getTime()
  assert.equal(evaluate(snap(base as any), FRI).filter((a) => a.rule === 'roster-stale').length, 0,
    'two days out there is time; it is not news yet')
  const SUN = new Date(2026, 8, 6, 9, 0, 0).getTime()
  const a = evaluate(snap(base as any), SUN).find((x) => x.rule === 'roster-stale')!
  assert.ok(a, 'the morning of, it is')
  assert.match(a.headline, /has not been read for \d+ days/)
})

test('a fresh roster is never called stale', () => {
  const SUN = new Date(2026, 8, 6, 9, 0, 0).getTime()
  assert.equal(evaluate(snap({
    players: [player({ name: 'Nix' })], capturedAt: SUN - 3600000,
  } as any), SUN).filter((a) => a.rule === 'roster-stale').length, 0)
})

test('a bye warns the week before, not during', () => {
  const byes = [{ week: 7, away: 3, shortfalls: [{ slot: 'QB' }] }]
  const waivers = { clearsAt: Date.now() + 86400000, assumedDay: 'Tue', budget: 200, spent: 0,
    holes: [], targets: [] }
  const early = evaluate(snap({ byes, week: 6, waivers } as any), Date.now())
    .find((a) => a.rule === 'bye-ahead')
  assert.ok(early, 'the week before is when there is still somebody to claim')
  assert.match(early!.headline, /Week 7 leaves you short at QB/)
  assert.equal(evaluate(snap({ byes, week: 4, waivers } as any), Date.now())
    .filter((a) => a.rule === 'bye-ahead').length, 0, 'three weeks out is too early to act')
  assert.equal(evaluate(snap({ byes, week: 7, waivers } as any), Date.now())
    .filter((a) => a.rule === 'bye-ahead').length, 0, 'during the week it is too late')
})

test('only a real move in role is worth mentioning', () => {
  const roles = [
    { name: 'Big Mover', pos: 'WR', snapTrend: 0.22, targetTrend: 0.04, owned: true },
    { name: 'Barely Moved', pos: 'WR', snapTrend: 0.03, targetTrend: 0.01, owned: false },
  ]
  const out = evaluate(snap({ roles } as any), Date.now()).filter((a) => a.rule === 'role-changing')
  assert.equal(out.length, 1)
  assert.match(out[0].headline, /Big Mover/)
  assert.ok(out[0].consequence < 80, 'never worth waking anyone for')
})

test('the matchup alerts on the crossing, not on the wobble', () => {
  const behindAllAlong = { mine: 90, theirs: 100, wasAhead: false }
  assert.equal(evaluate(snap({ matchup: behindAllAlong } as any), Date.now())
    .filter((a) => a.rule === 'matchup-flipped').length, 0, 'behind and staying behind is not news')
  const justFlipped = { mine: 90, theirs: 100, wasAhead: true }
  const a = evaluate(snap({ matchup: justFlipped } as any), Date.now())
    .find((x) => x.rule === 'matchup-flipped')!
  assert.ok(a)
  assert.match(a.detail, /you were ahead at the last look/)
})
