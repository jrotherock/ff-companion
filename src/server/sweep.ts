/**
 * The Monday sweep: every league's wire, read once.
 *
 * The job this exists for happens after the week's games and before waivers
 * clear — who do I need because somebody got hurt, and who is worth a bench
 * spot on speculation. Until now it meant opening six league pages, because
 * every waiver panel in this app is per-league, and then holding the answer in
 * your head: the same man is free in three of them and rostered in the other
 * three, and he is worth a different number in each because the leagues score
 * differently.
 *
 * So the unit here is the player, and under him the leagues where he is
 * actually claimable, each with what he would fill, what it gains, and who he
 * would cost. Ranked once, by the best he does anywhere.
 *
 * What this does not do is decide. It has no opinion about your FAAB — there
 * is a budget and there are rivals' budgets and no model to turn those into a
 * number, and a bid invented here would be the most confident wrong figure on
 * the screen.
 */
import { bestLineup, cannotPlay, type Candidate, type Slot } from './lineup.js'
import { RISING_SNAP, RISING_TARGET } from './usage.js'
import type { Hole } from './waivers.js'

/**
 * A free agent, scored this league's way.
 *
 * Both sides of every comparison below have to come from one model. A Yahoo
 * roster carries Yahoo's projections and the wire only ever has Sleeper's, so
 * a pickup that "beats the bench" across the two is a claim about two models
 * rather than about two players. The caller scores everybody alike.
 */
export interface Free {
  id: string
  name: string
  pos: string | null
  team: string | null
  /** Claimable overnight rather than addable now. */
  onWaivers: boolean
  projected: number | null
  /**
   * Where the defence he faces ranks against his position, 1 being the most
   * generous. Passed through to the optimiser, which already breaks a tie on
   * it — two tight ends within the noise of each other are separated by who
   * they play, which is the question a projection alone cannot answer.
   */
  dvpRank?: number | null
  dvpOf?: number | null
  /** Who he faces, so the row can say why. */
  opponent?: string | null
  /**
   * What he averages over HORIZON weeks, byes left out — the level rather
   * than the week. See `HORIZON` for why three.
   */
  outlook?: number | null
  /** A bye inside that window, which is a fact about the calendar, not the man. */
  byeIn?: number | null
  /** His share of his team's snaps and targets against his own earlier weeks. */
  snapTrend?: number | null
  targetTrend?: number | null
  /** The share itself, which a trend alone does not give. */
  snapShare?: number | null
  /** How many weeks the trend rests on. In September that is one change. */
  trendWeeks?: number | null
}

/** A man already on my roster there, scored the same way. */
export interface Held {
  id: string
  name: string
  pos: string | null
  starter: boolean
  projected: number | null
  injuryStatus: string | null
  dvpRank?: number | null
  /** His own level over the horizon, so a drop is judged on more than a week. */
  projectedOver?: number | null
}

export interface LeagueNeed {
  leagueId: string
  label: string
  slots: Slot[]
  holes: Hole[]
  squad: Held[]
  /** Null where the wire could not be read, which is not the same as empty. */
  free: Free[] | null
  budget: number | null
  spent: number | null
  /** When "free" was last true. A day-old answer sends you to claim a man somebody already has. */
  freeAsOf: number | null
  clearsAt: number | null
}

/** One league's case for one player. */
export interface Chance {
  leagueId: string
  label: string
  /** The slot he answers. */
  fills: string
  /**
   * A slot nobody can fill; cover for a man who may not play; somebody better
   * than what is there; or a role growing under a man nobody has noticed yet.
   */
  why: 'hole' | 'cover' | 'upgrade' | 'rising'
  projected: number | null
  /** Points over the man he would displace, which is the whole of the case. */
  gain: number
  onWaivers: boolean
  /** The weakest man on that bench: what the claim costs. */
  drop: { id: string; name: string; pos: string | null; projected: number | null } | null
  budgetLeft: number | null
}

/** The week a claim made now would first be played in. */
export interface Target { week: number; of: number; done: number }

/**
 * How many weeks ahead a pickup is judged over. Three, measured rather than
 * picked.
 *
 * On the 2025 season, ranking players by a single week's scoring predicts
 * their mean over the four weeks *after* it at r=0.59. Widen the window and
 * it climbs to 0.69 at two weeks and 0.72 at three, then stops: four weeks
 * buys 0.02 and five and six buy nothing. One week is simply noisy — a week's
 * scoring correlates with the next week's at only 0.48, and, revealingly, at
 * 0.44 with the week eight ahead, so almost none of what a single week tells
 * you is about *that* week rather than about the player.
 *
 * Three is also as far as the projections themselves say anything: 64% of
 * players carry an identical number in week three and week six, so a longer
 * window mostly averages in the same constant and dilutes the matchup
 * information the near weeks do have.
 *
 * It is a tiebreak here and never the headline. The gain a row leads with is
 * what the lineup is worth next Sunday, which is a claim that can be checked
 * by Monday; this is the level behind it, which cannot.
 */
export const HORIZON = 3

/** Below this over the horizon, the projections have no opinion on a man. */
export const RELEVANT = 0.5

export interface SweepRow {
  id: string
  name: string
  pos: string | null
  team: string | null
  /** The best he does in any league, which is what the list is ranked by. */
  best: number
  /** Worth a bench spot somewhere, rather than merely available. */
  chances: Chance[]
  /** Who he faces next, and how that defence ranks against his position. */
  opponent?: string | null
  dvpRank?: number | null
  dvpOf?: number | null
  /** His level over the next `HORIZON` weeks, and a bye inside them. */
  outlook?: number | null
  byeIn?: number | null
  /** Why he is rising, where that is the case being made. */
  snapTrend?: number | null
  targetTrend?: number | null
  snapShare?: number | null
  trendWeeks?: number | null
}

/**
 * An upgrade has to be worth the move. Half a point is rounding, and a wire
 * that reports every man who projects a tenth above your worst starter is a
 * search page with extra steps.
 */
export const WORTH_IT = 1.5

/**
 * A man I hold, as the optimiser sees him.
 *
 * Where the week has no number for him, his level over the horizon stands in
 * rather than a nought. The feeds drop people: Dallas Goedert is in the week
 * two and week five tables and absent from three and four, and read as nought
 * he made every tight end on the wire look like an eight-point upgrade on a
 * man who is nothing of the sort. A projection nobody published is not a
 * projection of nought — the same rule the cached tables already follow.
 */
const asCandidate = (p: Held): Candidate => ({
  id: p.id,
  name: p.name,
  pos: p.pos,
  projected: p.projected ?? p.projectedOver ?? 0,
  starter: p.starter,
  injuryStatus: p.injuryStatus,
})

/**
 * What a man is worth in a lineup, which for one who cannot play is nothing.
 *
 * `cannotPlay` rather than a test of our own: the optimiser already prices an
 * unplayable man at zero when it decides where he goes, so totalling him at
 * his projection afterwards would credit the lineup with points the same
 * function had just refused to count. This started as a second copy of that
 * rule here, and the copy was narrower — it left out DOUBTFUL, so a doubtful
 * starter was a bar his replacement had to clear in this one screen and
 * nowhere else in the app.
 */
const worth = (c: Candidate) => (cannotPlay(c.injuryStatus) ? 0 : c.projected ?? 0)

/**
 * Not out, but not certain either — and a starter nobody can replace.
 *
 * `cannotPlay` covers the men who are already ruled out. This is the other
 * half of the job the sweep is for: a questionable starter with nobody behind
 * him is the commonest reason to claim anybody on a Monday, and he is
 * invisible to a straight comparison because on paper he still outprojects
 * his replacement. The league page offered a tight end worth 8.25 against a
 * doubtful one worth 8.42 and called it a target; it is not an upgrade, it is
 * insurance, and the two should not be described the same way.
 */
const DOUBTFUL = /^(Q|QUESTIONABLE|D|DOUBTFUL|GTD)$/i
const doubtful = (s: string | null) => !!s && DOUBTFUL.test(s.trim())

const totalOf = (lineup: Map<number, Candidate>) =>
  [...lineup.values()].reduce((a, c) => a + worth(c), 0)

/**
 * What he is worth here, which is what the lineup is worth with him in it.
 *
 * The first version of this measured a free agent against the weakest starter
 * who could hold each slot, and a tight end counted as the bar for the flex —
 * so a receiver was credited with the gap to a man who was never going to
 * leave the tight end slot. A lineup is not a list of slots taken separately:
 * adding a receiver moves a receiver to the flex and the flex man to the
 * bench, and only the total says what that was worth.
 *
 * So the optimiser answers it, the same one that fills the lineup everywhere
 * else in the app, asked twice.
 */
/**
 * The two lineups every question here is asked against: the one I would field
 * today, and the one I would be left with if the men in the balance all sat.
 *
 * Shared with `barFor` below, so the number the screen prints as the bar is
 * the one the sweep actually applied rather than a second version of it that
 * could drift from the first.
 */
function lineups(need: LeagueNeed) {
  const mine = need.squad.map(asCandidate)
  const base = bestLineup(need.slots, mine)
  const anyDoubt = need.squad.some((p) => p.starter && doubtful(p.injuryStatus))
  /*
   * The same lineup with every doubtful starter priced at nothing: what I
   * would be left holding if the ones in the balance all sat. A free agent
   * who does nothing for the lineup as it stands can be the whole of it here.
   */
  const ifOut = anyDoubt
    ? mine.map((c) => (c.starter && doubtful(c.injuryStatus) ? { ...c, projected: 0 } : c))
    : mine
  const outBase = anyDoubt ? bestLineup(need.slots, ifOut) : base
  /*
   * Nobody below the weakest man in a lineup can improve it, whatever slot he
   * is eligible for, so the optimiser is never asked about him. On a wire of
   * two thousand names that is the difference between a screen and a wait.
   */
  const floorOf = (l: Map<number, Candidate>) =>
    l.size < need.slots.length ? 0 : Math.min(...[...l.values()].map(worth))
  return {
    mine, baseTotal: totalOf(base), anyDoubt, ifOut, outTotal: totalOf(outBase),
    floor: floorOf(base), floorIfOut: floorOf(outBase),
  }
}

/**
 * What a free agent has to beat in this league before he is worth a word.
 *
 * On the screen because "nothing here" and "nothing here that beats 12.4" are
 * different answers, and only the second tells you whether it is worth a look
 * of your own. A league that reports nothing should be able to say why.
 */
export function barFor(need: LeagueNeed): number | null {
  if (!need.free) return null
  const l = lineups(need)
  return Number(Math.min(l.floor, l.floorIfOut).toFixed(2))
}

function chancesIn(need: LeagueNeed): Map<string, Chance> {
  const out = new Map<string, Chance>()
  if (!need.free) return out

  const { mine, baseTotal, anyDoubt, ifOut, outTotal, floor, floorIfOut } = lineups(need)
  /*
   * The two kinds of hole the rule returns are not the same problem, and
   * calling them both "fills" put "fills TE" against a slot that had a tight
   * end in it — a doubtful one, which is the whole point. Nobody-at-all is a
   * hole; an only body who may not play is cover, whichever way the
   * arithmetic comes out.
   */
  const EMPTY = 90
  const holeNames = new Set(need.holes.filter((h) => h.severity >= EMPTY).map((h) => h.slot))
  const coverNames = new Set(need.holes.filter((h) => h.severity < EMPTY).map((h) => h.slot))

  /*
   * What the claim costs: the weakest man on the bench who is fit to play.
   *
   * Fit deliberately. An injured man is always the cheapest thing on a bench,
   * because his projection for this week is nought — so the first version of
   * this offered Brock Bowers as the man to drop for a two-point upgrade. His
   * number is low for a reason that expires, and whether to give up on him is
   * a decision about him rather than a consequence of somebody else's claim.
   * If the only spare bodies are hurt, this says nobody and lets the reader
   * pick.
   */
  const level = (p: Held) => p.projectedOver ?? p.projected ?? 0
  const bench = need.squad
    .filter((p) => !p.starter && !cannotPlay(p.injuryStatus) && !doubtful(p.injuryStatus))
    .sort((a, b) => level(a) - level(b))
  /*
   * Sorted on the horizon rather than on the week, where it is known. The
   * weakest man on a bench this Sunday is often just the one on a bye or in a
   * bad matchup, and giving him up for that is the same mistake as giving up
   * an injured man for projecting nought.
   */
  const drop = bench[0]
    ? { id: bench[0].id, name: bench[0].name, pos: bench[0].pos, projected: bench[0].projected }
    : null
  const budgetLeft = need.budget == null ? null : Math.max(0, need.budget - (need.spent ?? 0))

  for (const f of need.free) {
    const p = f.projected ?? 0
    if (!f.pos || (p <= floor && p <= floorIfOut)) continue
    const him: Candidate = {
      id: f.id, name: f.name, pos: f.pos, projected: p,
      starter: false, injuryStatus: null, dvpRank: f.dvpRank ?? null,
    }
    const withHim = bestLineup(need.slots, [...mine, him])
    const slotIdx = [...withHim.entries()].find(([, c]) => c.id === f.id)?.[0]
    const gain = slotIdx == null ? 0 : totalOf(withHim) - baseTotal

    /* And what he is worth if the men in the balance do not play. */
    let cover = 0
    let coverSlot: number | null = null
    if (anyDoubt) {
      const ifHim = bestLineup(need.slots, [...ifOut, him])
      coverSlot = [...ifHim.entries()].find(([, c]) => c.id === f.id)?.[0] ?? null
      if (coverSlot != null) cover = totalOf(ifHim) - outTotal
    }

    const idx = gain > 0 ? slotIdx : coverSlot
    if (idx == null) continue
    const fills = need.slots[idx].name
    // Holes come from the existing rule, so the sweep and the alert agree.
    const why = holeNames.has(fills) && gain > 0 ? 'hole'
      : coverNames.has(fills) && (cover >= WORTH_IT || gain > 0) ? 'cover'
      : gain >= WORTH_IT ? 'upgrade'
      : cover >= WORTH_IT ? 'cover'
      : null
    if (!why) continue
    out.set(f.id, {
      leagueId: need.leagueId, label: need.label, fills, why,
      projected: f.projected,
      gain: Number((why === 'cover' ? cover : gain).toFixed(2)),
      onWaivers: f.onWaivers, drop, budgetLeft,
    })
  }

  /*
   * And the men whose role is growing, which is the only case here that is not
   * about next Sunday at all.
   *
   * A back who has just taken over a job projects for what he did last month,
   * so he clears no bar and answers no hole — he would never appear above, and
   * that is exactly the pickup worth making, because by the time the points
   * arrive the wire has gone. His gain is nought and stays nought: inventing a
   * number for a bet on the future would put it in the same column as a claim
   * about next week that can be checked by Monday.
   */
  for (const f of need.free) {
    if (out.has(f.id) || !f.pos) continue
    if (!((f.snapTrend ?? 0) > RISING_SNAP || (f.targetTrend ?? 0) > RISING_TARGET)) continue
    /*
     * And the projections have to grant him something, anything, over the
     * horizon. A floor of half a point across three weeks is not a judgement
     * about how good he is — it is the line below which the model has no
     * opinion on him at all, and a snap share climbing on a man nobody
     * projects to score is a rotational body rather than a job changing
     * hands. A receiver taking half his team's snaps and none of its targets
     * ranked above the back who had just inherited a backfield.
     *
     * Set low on purpose. The whole case for watching usage is that points
     * arrive after the role does, so anything stricter would throw away
     * exactly the man this is for.
     */
    if ((f.outlook ?? 0) < RELEVANT) continue
    out.set(f.id, {
      leagueId: need.leagueId, label: need.label, fills: f.pos, why: 'rising',
      projected: f.projected, gain: 0,
      onWaivers: f.onWaivers, drop, budgetLeft,
    })
  }
  return out
}

/**
 * Every league's wire, gathered under the players rather than the leagues.
 *
 * `limit` caps the list, not the leagues under each man: a player worth
 * claiming in four places should say so in all four.
 */
/*
 * Nothing is worse than nobody; a man who may not play is the next worst; and
 * a bet on next month comes after every question about next Sunday.
 */
const RANK: Record<Chance['why'], number> = { hole: 0, cover: 1, upgrade: 2, rising: 3 }

export function sweep(
  needs: LeagueNeed[], limit = 40, perSlot = 5, perLeagueRising = 5,
): SweepRow[] {
  /*
   * Every case, then the best few for each slot.
   *
   * Without the cap one league's problem owns the screen: a questionable
   * tight end with nobody behind him makes every tight end on the wire worth
   * his whole projection as cover, and twenty of them outranked all five
   * other leagues put together. Five is what a claim needs — the one you
   * want, and enough behind him that the men you were going to ask about are
   * on the page rather than in a follow-up question.
   */
  const pool: { f: Free; c: Chance }[] = []
  for (const need of needs) {
    for (const [id, c] of chancesIn(need)) pool.push({ f: need.free!.find((x) => x.id === id)!, c })
  }
  /*
   * A cap for the whole league on the speculative ones, rather than five per
   * position. Keyed by slot like the rest, a rising list came out twelve deep
   * in one league — three at each position — and buried every question about
   * next Sunday underneath it.
   */
  const per = new Map<string, number>()
  const rows = new Map<string, SweepRow>()
  /*
   * Gain first, and the steadier man where two are level on it. A week's
   * scoring is a noisy measure of anybody — see HORIZON — so where next
   * Sunday cannot separate two players, the three weeks behind it can.
   */
  const climb = (f: Free) => (f.snapTrend ?? 0) + (f.targetTrend ?? 0) * 2
  for (const { f, c } of pool.sort((a, b) =>
    RANK[a.c.why] - RANK[b.c.why] ||
    (a.c.why === 'rising' ? climb(b.f) - climb(a.f) : 0) ||
    b.c.gain - a.c.gain ||
    (b.f.outlook ?? 0) - (a.f.outlook ?? 0))) {
    const key = c.why === 'rising' ? `${c.leagueId}|rising` : `${c.leagueId}|${c.fills}|${c.why}`
    const n = per.get(key) ?? 0
    if (n >= (c.why === 'rising' ? perLeagueRising : perSlot)) continue
    per.set(key, n + 1)
    const row = rows.get(f.id) ?? {
      id: f.id, name: f.name, pos: f.pos, team: f.team, best: 0, chances: [],
      opponent: f.opponent ?? null, dvpRank: f.dvpRank ?? null, dvpOf: f.dvpOf ?? null,
      outlook: f.outlook ?? null, byeIn: f.byeIn ?? null,
      snapTrend: f.snapTrend ?? null, targetTrend: f.targetTrend ?? null,
      snapShare: f.snapShare ?? null, trendWeeks: f.trendWeeks ?? null,
    }
    row.chances.push(c)
    row.best = Math.max(row.best, c.gain)
    rows.set(f.id, row)
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      best: Number(r.best.toFixed(2)),
      // A hole first, then the biggest gain: the order you would work down.
      chances: r.chances.sort((a, b) => RANK[a.why] - RANK[b.why] || b.gain - a.gain),
    }))
    .sort((a, b) =>
      // A man who fills a hole somewhere outranks one who is merely an upgrade.
      RANK[a.chances[0].why] - RANK[b.chances[0].why] ||
      b.best - a.best ||
      b.chances.length - a.chances.length)
    .slice(0, limit)
}

/**
 * How much of the week the sweep is actually looking at.
 *
 * It matters on the Monday this is for: a man's week is not his week until his
 * game has been played, and a list ranked before the late game is ranked on
 * part of the evidence. Said on the face of the screen rather than left for
 * the reader to remember.
 */
/**
 * Which week a claim made now is actually for.
 *
 * Not the week the calendar is in. This screen exists for the hours after a
 * week's games, when that week is over and the claim you are about to make
 * plays next week — and ranking it on the week just finished was ranking it
 * on games already played. Sleeper's own state does not turn over until the
 * Tuesday, so the schedule answers it instead: once the slate is down to its
 * last game, the week being claimed for is the next one.
 *
 * Deliberately not "once the last game ends". Waivers clear before Monday
 * night is out in most leagues, so by the time the final whistle goes the
 * claim has already been made.
 */
export function claimWeek(week: number, games: { done: number; of: number }): number {
  return games.of > 0 && games.done >= games.of - 1 ? week + 1 : week
}

export function played(
  kickoffs: number[],
  now: number,
  /** How long after kickoff a game is counted finished. */
  runs = 3.25 * 3600_000,
): { done: number; of: number; next: number | null } {
  const of = kickoffs.length
  const done = kickoffs.filter((k) => now >= k + runs).length
  const next = kickoffs.filter((k) => now < k + runs).sort((a, b) => a - b)[0] ?? null
  return { done, of, next }
}
