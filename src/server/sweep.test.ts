import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slotsFor } from './lineup.js'
import { sweep, played, claimWeek, WORTH_IT, type LeagueNeed, type Free, type Held } from './sweep.js'

const slots = slotsFor(
  { QB: 1, RB: 2, WR: 2, TE: 1 },
  [{ name: 'FLEX', eligible: ['RB', 'WR', 'TE'], count: 1 }],
)
const held = (id: string, pos: string, starter: boolean, projected: number,
               injuryStatus: string | null = null): Held =>
  ({ id, name: id, pos, starter, projected, injuryStatus })
const free = (id: string, pos: string, projected: number, onWaivers = false): Free =>
  ({ id, name: id, pos, team: 'NYJ', onWaivers, projected })

/* A whole starting lineup, so nothing is a hole unless a test makes one. */
const squad = (): Held[] => [
  held('QB1', 'QB', true, 18), held('RB1', 'RB', true, 15), held('RB2', 'RB', true, 12),
  held('WR1', 'WR', true, 14), held('WR2', 'WR', true, 11), held('TE1', 'TE', true, 9),
  held('FLEX1', 'WR', true, 10),
  held('BENCH1', 'RB', false, 3), held('BENCH2', 'WR', false, 6),
]
/* The same lineup with nobody at tight end, which is what a hole actually is. */
const noTE = (): Held[] => squad().filter((p) => p.pos !== 'TE')
const TE_HOLE = { slot: 'TE', pos: ['TE'], reason: 'nobody on the roster can fill it', severity: 95 }

const league = (over: Partial<LeagueNeed> = {}): LeagueNeed => ({
  leagueId: 'a', label: 'League A', slots, holes: [], squad: squad(), free: [],
  budget: 100, spent: 25, freeAsOf: 1, clearsAt: 2, ...over,
})

test('a slot nobody can fill puts every body in it, best first', () => {
  const rows = sweep([league({
    squad: noTE(), holes: [TE_HOLE],
    free: [free('FA_TE', 'TE', 7), free('FA_TE2', 'TE', 4)],
  })])
  assert.deepEqual(rows.map((r) => r.id), ['FA_TE', 'FA_TE2'])
  assert.equal(rows[0].chances[0].why, 'hole')
  // Nothing is in the slot, so the whole of his projection is the gain.
  assert.equal(rows[0].chances[0].gain, 7)
  assert.equal(rows[0].chances[0].fills, 'TE')
})

test('an upgrade is measured against the weakest starter it could replace', () => {
  /* The worst man who can hold a WR slot projects 10; 14 is four better. */
  const rows = sweep([league({ free: [free('FA_WR', 'WR', 14)] })])
  assert.equal(rows[0].chances[0].why, 'upgrade')
  assert.equal(rows[0].chances[0].gain, 4)
})

test('beating only the bench is not a reason to do anything', () => {
  /* Seven beats both bench men and every one of my starting receivers is better. */
  assert.deepEqual(sweep([league({ free: [free('FA_WR', 'WR', 7)] })]), [])
})

test('an upgrade too small to be worth the move is not offered', () => {
  const under = sweep([league({ free: [free('FA_WR', 'WR', 10 + WORTH_IT - 0.1)] })])
  const over = sweep([league({ free: [free('FA_WR', 'WR', 10 + WORTH_IT)] })])
  assert.deepEqual(under, [], 'inside the margin, so it says nothing')
  assert.equal(over.length, 1, 'and at the margin it does')
})

test('a starter who cannot play is worth nothing, so the gap to him is real', () => {
  /*
   * The ten-point receiver is on IR. He keeps his place only because nobody
   * better is eligible, and the lineup he leaves behind is genuinely weaker —
   * so the same free agent is worth more here than to a healthy squad, and
   * the difference is what the injury cost.
   */
  const hurt = squad().map((p) => (p.id === 'FLEX1' ? { ...p, injuryStatus: 'IR' } : p))
  const healthy = sweep([league({ free: [free('FA_WR', 'WR', 12)] })])[0]
  const out = sweep([league({ squad: hurt, free: [free('FA_WR', 'WR', 12)] })])[0]
  assert.equal(healthy.chances[0].gain, 2, 'he displaces the ten-point man at the flex')
  assert.equal(out.chances[0].gain, 6, 'and with him out, the six-point bench man')
})

test('a man who cannot play holds his slot but is not counted in it', () => {
  /*
   * The only tight end is out. Nobody else is eligible, so the optimiser has
   * to leave him there — but the lineup is worth nothing at that slot, and a
   * free tight end is worth all of his own projection rather than the gap to
   * a man who is not going to play. Counting him at his projection would make
   * the replacement look four points worse than doing nothing.
   */
  const outTE = squad().map((p) => (p.id === 'TE1' ? { ...p, injuryStatus: 'OUT' } : p))
  const rows = sweep([league({ squad: outTE, free: [free('FA_TE', 'TE', 5)] })])
  assert.equal(rows.length, 1, 'he is worth having')
  assert.equal(rows[0].chances[0].gain, 5, 'the whole of his projection, not 5 less 9')
})

test('the same man in several leagues is one row that says where', () => {
  const rows = sweep([
    league({ free: [free('FA_WR', 'WR', 14)] }),
    league({
      leagueId: 'b', label: 'League B', budget: null, spent: null,
      squad: noTE(), holes: [TE_HOLE],
      free: [free('FA_WR', 'WR', 14), free('FA_TE', 'TE', 5)],
    }),
  ])
  const wr = rows.find((r) => r.id === 'FA_WR')!
  assert.deepEqual(wr.chances.map((c) => c.leagueId), ['a', 'b'])
  assert.equal(wr.best, 4, 'the best he does anywhere')
  assert.equal(wr.chances[1].budgetLeft, null, 'a league that does not bid says so')
})

test('a hole outranks a bigger upgrade, because nothing is worse than nobody', () => {
  const rows = sweep([league({
    squad: noTE(), holes: [TE_HOLE],
    free: [free('FA_TE', 'TE', 5), free('FA_WR', 'WR', 20)],
  })])
  assert.deepEqual(rows.map((r) => r.id), ['FA_TE', 'FA_WR'])
  assert.ok(rows[1].best > rows[0].best, 'even though the upgrade is worth more points')
})

test('what a claim costs is the weakest man on that bench', () => {
  const rows = sweep([league({ free: [free('FA_WR', 'WR', 14)] })])
  assert.equal(rows[0].chances[0].drop!.id, 'BENCH1')
  assert.equal(rows[0].chances[0].drop!.projected, 3)
  assert.equal(rows[0].chances[0].budgetLeft, 75)
})

test('an injured man is not the cheap body to drop', () => {
  /*
   * He projects nought this week because he is hurt, which makes him look
   * like the obvious thing to give up for a two-point upgrade. It is not:
   * the number expires and the player does not.
   */
  const hurt = squad().map((p) => (p.id === 'BENCH1' ? { ...p, injuryStatus: 'OUT' } : p))
  const rows = sweep([league({ squad: hurt, free: [free('FA_WR', 'WR', 14)] })])
  assert.equal(rows[0].chances[0].drop!.id, 'BENCH2', 'the fit man behind him')
})

test('a bench of nobody fit to drop names nobody', () => {
  const allHurt = squad().map((p) => (p.starter ? p : { ...p, injuryStatus: 'OUT' }))
  assert.equal(sweep([league({ squad: allHurt, free: [free('FA_WR', 'WR', 14)] })])[0].chances[0].drop, null)
})

test('a bench with nobody on it costs nothing to claim into', () => {
  const thin = squad().filter((p) => p.starter)
  assert.equal(sweep([league({ squad: thin, free: [free('FA_WR', 'WR', 14)] })])[0].chances[0].drop, null)
})

test('a wire that could not be read is not a wire with nobody on it', () => {
  assert.deepEqual(sweep([league({ squad: noTE(), free: null, holes: [TE_HOLE] })]), [])
})

test('one case per man per league, and the hole is the one kept', () => {
  /* He fills the empty tight end slot and would also upgrade the flex. */
  const rows = sweep([league({
    squad: noTE(), holes: [TE_HOLE], free: [free('FA_TE', 'TE', 16)],
  })])
  assert.equal(rows[0].chances.length, 1)
  assert.equal(rows[0].chances[0].why, 'hole')
})

test('a doubtful starter with nobody behind him makes cover worth having', () => {
  /*
   * The only tight end is questionable and projects 8.4. A free one at 8.2 is
   * not an upgrade — on paper he is a fifth of a point worse — but if the
   * doubtful man sits there is nobody at all, and that is the commonest
   * reason to claim anyone on a Monday. It is insurance, and it says so.
   */
  const shaky = squad().map((p) => (p.id === 'TE1' ? { ...p, injuryStatus: 'Questionable' } : p))
  const rows = sweep([league({ squad: shaky, free: [free('FA_TE', 'TE', 8.2)] })])
  assert.equal(rows.length, 1, 'a straight comparison would have said nothing')
  assert.equal(rows[0].chances[0].why, 'cover')
  assert.equal(rows[0].chances[0].gain, 8.2, 'what he is worth if the doubtful man sits')
})

test('cover is not claimed where somebody on the bench already covers it', () => {
  /* The doubtful man is a receiver, and the bench has two more. */
  const shaky = squad().map((p) => (p.id === 'WR1' ? { ...p, injuryStatus: 'Questionable' } : p))
  assert.deepEqual(sweep([league({ squad: shaky, free: [free('FA_WR', 'WR', 6.5)] })]), [],
    'six and a half is below what the bench already offers')
})

test('a real upgrade is still called an upgrade, not insurance', () => {
  const shaky = squad().map((p) => (p.id === 'TE1' ? { ...p, injuryStatus: 'Questionable' } : p))
  const rows = sweep([league({ squad: shaky, free: [free('FA_TE', 'TE', 20)] })])
  assert.equal(rows[0].chances[0].why, 'upgrade')
})

test('insurance comes before an upgrade, however many points the upgrade is', () => {
  /* A slot that may be empty on Sunday is a worse problem than a weak one. */
  const shaky = squad().map((p) => (p.id === 'TE1' ? { ...p, injuryStatus: 'Questionable' } : p))
  const rows = sweep([league({ squad: shaky, free: [free('FA_WR', 'WR', 20), free('FA_TE', 'TE', 8.2)] })])
  assert.deepEqual(rows.map((r) => r.chances[0].why), ['cover', 'upgrade'])
  assert.ok(rows[1].best > rows[0].best, 'even though the upgrade is worth more')
})

test('one league\'s problem does not own the screen', () => {
  /*
   * A questionable tight end makes every tight end on the wire cover worth
   * his whole projection. Unchecked, twenty of them buried the other leagues.
   */
  const shaky = squad().map((p) => (p.id === 'TE1' ? { ...p, injuryStatus: 'Questionable' } : p))
  const wire = Array.from({ length: 9 }, (_, i) => free(`TE${i}`, 'TE', 8 - i * 0.1))
  const rows = sweep([league({ squad: shaky, free: wire })])
  assert.equal(rows.length, 3, 'the one you want, and two to settle for')
  assert.deepEqual(rows.map((r) => r.id), ['TE0', 'TE1', 'TE2'], 'the best three')
})

test('a claim made when the slate is done is a claim for next week', () => {
  /*
   * The screen is for the hours after a week's games, when that week is over
   * and the man you claim plays next week. Ranking him on the week just
   * finished ranked him on games already played.
   */
  assert.equal(claimWeek(2, { done: 16, of: 16 }), 3, 'every game played')
  assert.equal(claimWeek(2, { done: 15, of: 16 }), 3, 'only the Monday game left, and waivers clear before it ends')
  assert.equal(claimWeek(2, { done: 9, of: 16 }), 2, 'mid-Sunday, still this week')
  assert.equal(claimWeek(2, { done: 0, of: 16 }), 2, 'and before any of it')
  assert.equal(claimWeek(2, { done: 0, of: 0 }), 2, 'no schedule read is not a reason to skip a week')
})

test('the week is only as read as the games that have been played', () => {
  const kick = [0, 3 * 3600_000, 30 * 3600_000]
  const now = 10 * 3600_000
  const p = played(kick, now)
  assert.equal(p.of, 3)
  assert.equal(p.done, 2, 'both afternoon games are over')
  assert.equal(p.next, 30 * 3600_000, 'and the late one has not kicked off')
  assert.equal(played(kick, 40 * 3600_000).next, null, 'nothing left once it has')
})
