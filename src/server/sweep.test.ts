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
/* The other kind the rule returns: a body is there, but he may not play. */
const TE_SHAKY = { slot: 'TE', pos: ['TE'], reason: 'your only TE is questionable, with no cover', severity: 55 }

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

test('an only tight end who may not play is cover, not an empty slot', () => {
  /*
   * The rule returns both as "holes", but they are different problems and
   * saying "fills TE" against a slot with a doubtful tight end in it is a
   * false statement about the roster.
   */
  const shaky = squad().map((p) => (p.id === 'TE1' ? { ...p, injuryStatus: 'Questionable' } : p))
  const rows = sweep([league({ squad: shaky, holes: [TE_SHAKY], free: [free('FA_TE', 'TE', 12)] })])
  assert.equal(rows[0].chances[0].why, 'cover', 'even though he also beats the man outright')
  const empty = sweep([league({ squad: noTE(), holes: [TE_HOLE], free: [free('FA_TE', 'TE', 12)] })])
  assert.equal(empty[0].chances[0].why, 'hole')
})

test('a starter the feed forgot is not a starter worth nothing', () => {
  /*
   * The projection tables drop people — one real tight end was in week two
   * and week five and missing from three and four. Read as nought, every
   * tight end on the wire became an eight-point upgrade on a man who was
   * nothing of the sort.
   */
  const gap = squad().map((p) =>
    p.id === 'TE1' ? { ...p, projected: null, projectedOver: 9 } : p)
  assert.deepEqual(sweep([league({ squad: gap, free: [free('FA_TE', 'TE', 9.2)] })]), [],
    'a fifth of a point is not an upgrade')
  const asNought = squad().map((p) => (p.id === 'TE1' ? { ...p, projected: null } : p))
  assert.equal(sweep([league({ squad: asNought, free: [free('FA_TE', 'TE', 9.2)] })]).length, 1,
    'and with nothing to stand in, nought is all there is')
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
  const wire = Array.from({ length: 11 }, (_, i) => free(`TE${i}`, 'TE', 8 - i * 0.1))
  const rows = sweep([league({ squad: shaky, free: wire })])
  assert.equal(rows.length, 5, 'the one you want, and four to settle for')
  assert.deepEqual(rows.map((r) => r.id), ['TE0', 'TE1', 'TE2', 'TE3', 'TE4'], 'the best five')
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

test('a role growing under a man nobody has noticed is worth a bench spot', () => {
  /*
   * He projects three points, so he clears no bar and fills no hole — he
   * would never appear on next Sunday's arithmetic at all, which is the whole
   * reason the pickup is worth making now.
   */
  const rising = { ...free('RISER', 'RB', 3), snapTrend: 0.22, targetTrend: 0.01, outlook: 3 }
  const rows = sweep([league({ free: [rising] })])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chances[0].why, 'rising')
  assert.equal(rows[0].chances[0].gain, 0, 'a bet on the future is not a gain next week')
})

test('a climbing snap share on a man nobody projects to score is not a stash', () => {
  /*
   * He took half his team's snaps and none of its targets. The role moved,
   * the relevance did not, and he was ranking above a back who had just
   * inherited a backfield.
   */
  const noise = { ...free('NOISE', 'WR', 0), snapTrend: 0.45, targetTrend: 0.05, outlook: 0.09 }
  const real = { ...free('REAL', 'RB', 1.2), snapTrend: 0.35, targetTrend: 0, outlook: 1.64 }
  const rows = sweep([league({ free: [noise, real] })])
  assert.deepEqual(rows.map((r) => r.id), ['REAL'])
})

test('a man whose role is flat is not a stash', () => {
  const flat = { ...free('FLAT', 'RB', 3), snapTrend: 0.01, targetTrend: 0, outlook: 3 }
  assert.deepEqual(sweep([league({ free: [flat] })]), [])
})

test('every question about next Sunday comes before a bet on next month', () => {
  const rising = { ...free('RISER', 'RB', 3), snapTrend: 0.3, targetTrend: 0.1, outlook: 3 }
  const better = free('FA_WR', 'WR', 14)
  const rows = sweep([league({ free: [rising, better] })])
  assert.deepEqual(rows.map((r) => r.chances[0].why), ['upgrade', 'rising'])
})

test('a man already worth starting is not also filed as a stash', () => {
  /* One case per man per league: the actionable one wins. */
  const both = { ...free('FA_WR', 'WR', 14), snapTrend: 0.3, targetTrend: 0.1 }
  const rows = sweep([league({ free: [both] })])
  assert.equal(rows[0].chances.length, 1)
  assert.equal(rows[0].chances[0].why, 'upgrade')
})

test('the man to drop is the weakest over the horizon, not on a bad Sunday', () => {
  /*
   * The three-point bench man averages nine over the next three weeks — he is
   * on a bye, or drawing a wall. The six-point one averages four and is
   * simply worse. Giving up the first because of one week is the same mistake
   * as giving up an injured man for projecting nought.
   */
  const squadWithLevels = squad().map((p) =>
    p.id === 'BENCH1' ? { ...p, projectedOver: 9 }
    : p.id === 'BENCH2' ? { ...p, projectedOver: 4 } : p)
  const rows = sweep([league({ squad: squadWithLevels, free: [free('FA_WR', 'WR', 14)] })])
  assert.equal(rows[0].chances[0].drop!.id, 'BENCH2')
})

test('speculation is capped for the league, not for each position in it', () => {
  /*
   * Keyed by slot like the rest, this came out twelve deep in one league —
   * three at each position — and buried every question about next Sunday.
   */
  const spec = (id: string, pos: string, t: number) =>
    ({ ...free(id, pos, 2), snapTrend: t, targetTrend: 0, outlook: 2 })
  const wire = ['QB', 'RB', 'WR', 'TE'].flatMap((pos, i) =>
    [0.3, 0.25, 0.2].map((t, j) => spec(`${pos}${j}`, pos, t - i * 0.01)))
  const rows = sweep([league({ free: wire })])
  assert.equal(rows.length, 5, 'five for the league, however many positions are climbing')
  assert.ok(rows.every((r) => r.chances[0].why === 'rising'))
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
