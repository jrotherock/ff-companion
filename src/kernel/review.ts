import type { LeagueConfig, Pick, Player, PlayerId, Pos, Ranking, Roster } from './types.js'
import { buildRoster } from './roster.js'
import { myPicks } from './snake.js'
import type { PlayerFlags } from './preferences.js'

/**
 * Post-draft review.
 *
 * This measures decisions against the board you were actually looking at, not
 * against ADP. Grading against ADP would score you on how closely you tracked
 * consensus, which is precisely the thing this tool exists to depart from — a
 * good ADP grade would be evidence it was not working.
 *
 * The important limit: this is a consistency check, not a correctness check. If
 * the board was wrong about a player, the review will confidently say you were
 * wrong to disagree with it. Consistency is what you control, so it is the
 * useful thing to measure, but it is not the same as being right.
 */

export interface PickReview {
  overall: number
  round: number
  /** What you took. */
  taken: { id: PlayerId; name: string; pos: Pos | null; value: number }
  /** Best available at the time, by the board as it stood then. */
  best: { id: PlayerId; name: string; pos: Pos | null; value: number } | null
  /** Best available that also filled an unfilled starting slot. */
  bestNeeded: { id: PlayerId; name: string; pos: Pos | null; value: number } | null
  /** Value forgone against the best pick that fitted the roster. */
  cost: number
  verdict: 'best' | 'fine' | 'costly' | 'offboard'
  notes: string[]
}

export interface StructureAudit {
  unfilledStarters: { pos: string; count: number }[]
  byeConflicts: { week: number; players: string[] }[]
  positionCounts: Record<string, number>
  /** Positions where you hold fewer than the league requires to start. */
  shortfalls: string[]
}

/**
 * The roster you would have had by taking the recommended pick every time.
 *
 * The other eleven teams are held fixed, which is the honest simplification to
 * name: in reality a different pick of yours changes what reaches them. It is a
 * lower bound on the difference, not a simulation of the alternate draft.
 */
export interface Counterfactual {
  totalValue: number
  actualValue: number
  gain: number
  roster: { pos: string; name: string; value: number }[]
  swaps: { round: number; tookInstead: string; wouldHaveTaken: string; gain: number }[]
}

export interface DraftReview {
  picks: PickReview[]
  counterfactual: Counterfactual
  totalCost: number
  /** Cost split by phase, since early and late mistakes are different animals. */
  costEarly: number
  costLate: number
  structure: StructureAudit
  preference: {
    likesTaken: number
    likeCost: number
    avoidsTaken: { name: string; overall: number }[]
  }
  summary: string[]
}

/** A pick is "fine" inside this much of the best available. */
const FINE = 0.35
/** Beyond this, the pick cost something worth naming. */
const COSTLY = 1.0

export function reviewDraft(opts: {
  league: LeagueConfig
  players: Map<PlayerId, Player>
  rankings: Ranking[]
  picks: Pick[]
  mySlot: number
  flagsFor: (id: PlayerId) => PlayerFlags
}): DraftReview {
  const { league, players, rankings, picks, mySlot, flagsFor } = opts
  const rank = new Map(rankings.map((r) => [r.playerId, r]))
  const valueOf = (id: PlayerId) => rank.get(id)?.value ?? -99
  /** The board had no opinion on this player, so no decision can be scored. */
  const unranked = (id: PlayerId) => !rank.has(id)
  const nameOf = (id: PlayerId) => players.get(id)?.name ?? id
  const posOf = (id: PlayerId) => players.get(id)?.pos ?? null

  const mine = new Set(myPicks(mySlot, league.teams, league.rounds))
  const ordered = [...picks].sort((a, b) => a.overall - b.overall)

  const reviews: PickReview[] = []
  const takenSoFar = new Set<PlayerId>()
  const myIds: PlayerId[] = []
  const half = Math.ceil(league.rounds / 2)

  // Parallel run: always take the best available that fits.
  const cfIds: PlayerId[] = []
  const cfTaken = new Set<PlayerId>()
  const swaps: Counterfactual['swaps'] = []

  for (const pick of ordered) {
    if (!mine.has(pick.overall)) {
      takenSoFar.add(pick.playerId)
      continue
    }

    // The board exactly as it stood at this pick.
    const available = rankings
      .filter((r) => !takenSoFar.has(r.playerId))
      .sort((a, b) => b.value - a.value)

    const roster = buildRoster(league, myIds, players, valueOf)
    const openPositions = new Set<Pos>()
    for (const s of roster.slots) if (!s.filled) s.eligible.forEach((p) => openPositions.add(p))

    const best = available[0] ?? null
    const bestNeeded =
      available.find((r) => {
        const p = posOf(r.playerId)
        return p != null && openPositions.has(p)
      }) ?? null

    const brief = (r: Ranking | null) =>
      r ? { id: r.playerId, name: nameOf(r.playerId), pos: posOf(r.playerId), value: r.value } : null

    const takenValue = valueOf(pick.playerId)
    // Measured against the best pick that actually fitted, not the best overall:
    // passing on a player you had no room for is not a mistake.
    const benchmark = bestNeeded ?? best
    /*
     * A player the board never ranked cannot be scored against it. Charging the
     * gap to a sentinel value turned every late flier into a 94-point disaster
     * and drowned the real findings. It is reported, not priced.
     */
    const off = unranked(pick.playerId)
    const cost = off || !benchmark ? 0 : Math.max(0, benchmark.value - takenValue)

    const notes: string[] = []
    if (off) notes.push('was not on your board at all')
    const flags = flagsFor(pick.playerId)
    if (flags.tags.includes('avoid')) notes.push('was on your do-not-draft list')
    if (flags.likeRank != null) notes.push(`your pre-draft rank #${flags.likeRank}`)
    const pos = posOf(pick.playerId)
    if (pos && !openPositions.has(pos)) notes.push(`no ${pos} slot was open — depth pick`)
    if (benchmark && benchmark.playerId !== pick.playerId && cost >= COSTLY) {
      notes.push(`${nameOf(benchmark.playerId)} was there at ${benchmark.value.toFixed(1)}`)
    }

    reviews.push({
      overall: pick.overall,
      round: pick.round,
      taken: { id: pick.playerId, name: nameOf(pick.playerId), pos, value: takenValue },
      best: brief(best),
      bestNeeded: brief(bestNeeded),
      cost,
      verdict: off ? 'offboard' : cost <= FINE ? 'best' : cost < COSTLY ? 'fine' : 'costly',
      notes,
    })

    // ---- the disciplined alternative, at this same pick
    const cfAvailable = rankings
      .filter((r) => !takenSoFar.has(r.playerId) && !cfTaken.has(r.playerId))
      .sort((a, b) => b.value - a.value)
    const cfRoster = buildRoster(league, cfIds, players, valueOf)
    const cfOpen = new Set<Pos>()
    for (const sl of cfRoster.slots) if (!sl.filled) sl.eligible.forEach((p) => cfOpen.add(p))
    const cfPick =
      cfAvailable.find((r) => {
        const p = posOf(r.playerId)
        return p != null && cfOpen.has(p)
      }) ?? cfAvailable[0]
    if (cfPick) {
      cfIds.push(cfPick.playerId)
      cfTaken.add(cfPick.playerId)
      if (cfPick.playerId !== pick.playerId) {
        swaps.push({
          round: pick.round,
          tookInstead: nameOf(pick.playerId),
          wouldHaveTaken: nameOf(cfPick.playerId),
          gain: round2(cfPick.value - takenValue),
        })
      }
    }

    takenSoFar.add(pick.playerId)
    myIds.push(pick.playerId)
  }

  const roster = buildRoster(league, myIds, players, valueOf)
  const structure = auditStructure(league, roster, myIds, players)

  const likes = reviews.filter((r) => flagsFor(r.taken.id).likeRank != null)
  const avoids = reviews
    .filter((r) => flagsFor(r.taken.id).tags.includes('avoid'))
    .map((r) => ({ name: r.taken.name, overall: r.overall }))

  const scored = reviews.filter((r) => r.verdict !== 'offboard')
  const totalCost = scored.reduce((s, r) => s + r.cost, 0)
  const costEarly = scored.filter((r) => r.round <= half).reduce((s, r) => s + r.cost, 0)
  const costLate = totalCost - costEarly

  const startersOf = (ids: PlayerId[]) => {
    const r = buildRoster(league, ids, players, valueOf)
    return r.slots
      .filter((sl) => sl.filled)
      .map((sl) => ({
        pos: sl.eligible.length === 1 ? sl.eligible[0] : sl.name,
        name: nameOf(sl.filled!),
        value: round2(valueOf(sl.filled!)),
      }))
  }
  const sumStarters = (ids: PlayerId[]) =>
    startersOf(ids).reduce((s, x) => s + Math.max(0, x.value), 0)

  const actualValue = round2(sumStarters(myIds))
  const cfValue = round2(sumStarters(cfIds))

  return {
    picks: reviews,
    counterfactual: {
      totalValue: cfValue,
      actualValue,
      gain: round2(cfValue - actualValue),
      roster: startersOf(cfIds),
      swaps: swaps.filter((s) => s.gain > 0.05).sort((a, b) => b.gain - a.gain),
    },
    totalCost: round2(totalCost),
    costEarly: round2(costEarly),
    costLate: round2(costLate),
    structure,
    preference: {
      likesTaken: likes.length,
      likeCost: round2(likes.reduce((s, r) => s + r.cost, 0)),
      avoidsTaken: avoids,
    },
    summary: summarise(reviews, totalCost, costEarly, costLate, structure, likes.length,
      round2(likes.reduce((s, r) => s + r.cost, 0)), avoids.length,
      reviews.filter((r) => r.verdict === 'offboard').length),
  }
}

function auditStructure(
  league: LeagueConfig,
  roster: Roster,
  myIds: PlayerId[],
  players: Map<PlayerId, Player>,
): StructureAudit {
  const unfilled = new Map<string, number>()
  for (const s of roster.slots) {
    if (s.filled) continue
    const label = s.eligible.length === 1 ? s.eligible[0] : s.name
    unfilled.set(label, (unfilled.get(label) ?? 0) + 1)
  }

  const positionCounts: Record<string, number> = {}
  const byeWeeks = new Map<number, string[]>()
  for (const id of myIds) {
    const p = players.get(id)
    if (!p) continue
    positionCounts[p.pos] = (positionCounts[p.pos] ?? 0) + 1
    if (p.byeWeek != null) {
      ;(byeWeeks.get(p.byeWeek) ?? byeWeeks.set(p.byeWeek, []).get(p.byeWeek)!).push(p.name)
    }
  }

  const shortfalls: string[] = []
  for (const [pos, need] of Object.entries(league.starters ?? {})) {
    if ((positionCounts[pos] ?? 0) < (need as number)) shortfalls.push(pos)
  }

  return {
    unfilledStarters: [...unfilled.entries()].map(([pos, count]) => ({ pos, count })),
    byeConflicts: [...byeWeeks.entries()]
      .filter(([, names]) => names.length >= 3)
      .map(([week, players]) => ({ week, players }))
      .sort((a, b) => b.players.length - a.players.length),
    positionCounts,
    shortfalls,
  }
}

function summarise(
  reviews: PickReview[],
  total: number,
  early: number,
  late: number,
  structure: StructureAudit,
  likesTaken: number,
  likeCost: number,
  avoidsTaken: number,
  offboard: number,
): string[] {
  const out: string[] = []
  const costly = reviews.filter((r) => r.verdict === 'costly').sort((a, b) => b.cost - a.cost)
  const scored = reviews.length - offboard

  if (total < 1) {
    out.push(`You took the best available that fitted the roster essentially every time, across ${scored} scored picks.`)
  } else {
    out.push(
      `You gave up ${total.toFixed(1)} in value across ${scored} scored picks, ` +
        `${early.toFixed(1)} of it in the first half of the draft.`,
    )
  }
  if (offboard > 0) {
    out.push(
      `${offboard} pick${offboard === 1 ? '' : 's'} went to players your board never ranked, so they are reported but not scored.`,
    )
  }

  if (costly.length) {
    const worst = costly.slice(0, 2)
    out.push(
      `The expensive ones: ${worst
        .map((r) => `${r.taken.name} at ${r.overall} (−${r.cost.toFixed(1)})`)
        .join(', ')}.`,
    )
  }

  if (early > late * 2 && total >= 2) {
    out.push('Your early rounds cost more than your late ones, which is the wrong way round — early picks are worth several late ones.')
  } else if (late > early * 2 && total >= 2) {
    out.push('Most of the leak is late, where it matters least.')
  }

  if (likesTaken > 0) {
    out.push(
      likeCost < 0.5
        ? `You took ${likesTaken} from your own pre-draft list at no real cost.`
        : `Your pre-draft list cost ${likeCost.toFixed(1)} across ${likesTaken} picks — worth asking whether the list or the board is wrong.`,
    )
  }
  if (avoidsTaken > 0) {
    out.push(`You drafted ${avoidsTaken} player${avoidsTaken === 1 ? '' : 's'} off your own do-not-draft list.`)
  }
  if (structure.shortfalls.length) {
    out.push(`You finished short at ${structure.shortfalls.join(', ')}.`)
  }
  for (const c of structure.byeConflicts.slice(0, 1)) {
    out.push(`${c.players.length} of your players share the week ${c.week} bye.`)
  }
  return out
}

const round2 = (n: number) => Math.round(n * 100) / 100
