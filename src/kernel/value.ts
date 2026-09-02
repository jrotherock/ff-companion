import type {
  LeagueConfig, Player, PlayerId, Pos, Recommendation, RecommendationAxis, Roster, Verdict,
} from './types.js'
import type { AdjustedRanking } from './adjust.js'
import { myPicks, nextPickFor, picksBetween } from './snake.js'
import { blendedSurvival } from './opponents.js'
import { archetypeRank, backfieldByAdp, classify, inLateWindow, type Archetype } from './archetypes.js'

/** Abramowitz & Stegun 7.1.26 — plenty accurate and dependency free. */
function erf(x: number): number {
  const s = Math.sign(x)
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a)
  return s * y
}

const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))

/**
 * ADP dispersion is not published by the ranking source, so it is estimated.
 * Spread widens deeper into the draft, where consensus decays.
 */
export function estimateAdpStdev(adp: number): number {
  return Math.max(2, 0.18 * adp + 2)
}

/** P(player is still on the board at overall pick `n`). */
export function survival(adp: number, n: number, stdev?: number): number {
  const s = stdev && stdev > 0 ? stdev : estimateAdpStdev(adp)
  return Math.min(1, Math.max(0, 1 - normalCdf((n - adp) / s)))
}

/** Contiguous value gaps define tiers, so a break is a real cliff not a round number. */
export function assignTiers(pool: AdjustedRanking[], gapThreshold = 0.6): Map<PlayerId, number> {
  const out = new Map<PlayerId, number>()
  const sorted = [...pool].sort((a, b) => b.adjustedValue - a.adjustedValue)
  let tier = 1
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i - 1].adjustedValue - sorted[i].adjustedValue >= gapThreshold) tier++
    out.set(sorted[i].playerId, tier)
  }
  return out
}

/**
 * Expected value of the best player still available at `pos` when my next turn
 * comes: each candidate contributes only when he survives and everyone better
 * does not.
 */
export function expectedBestAt(
  pool: AdjustedRanking[],
  pos: Pos,
  players: Map<PlayerId, Player>,
  nextPick: number,
  opponent?: Map<PlayerId, number> | null,
): number {
  const candidates = pool
    .filter((r) => players.get(r.playerId)?.pos === pos)
    .sort((a, b) => b.adjustedValue - a.adjustedValue)
    .slice(0, 30)

  let expected = 0
  let allGone = 1
  for (const c of candidates) {
    const p = blendedSurvival(c, nextPick, opponent ?? null)
    expected += allGone * p * c.adjustedValue
    allGone *= 1 - p
    if (allGone < 1e-4) break
  }
  return expected
}

export interface RecommendContext {
  league: LeagueConfig
  pool: AdjustedRanking[]
  players: Map<PlayerId, Player>
  roster: Roster
  currentPick: number
  /** Opponent-aware survival, blended with ADP when present. */
  opponentSurvival?: Map<PlayerId, number> | null
  limit?: number
  /** Players already on my roster, for spotting a handcuff to one of them. */
  myIds?: PlayerId[]
  /** Archetypes to hunt once the starting lineup is full. */
  lateTargets?: {
    prefer: Archetype[]
    reserveLastRounds: number
    topRookies?: number
    rookiePositions?: Pos[]
    rookieShortlist?: string[]
    handcuffOrder?: string[]
    includeUnownedBackups?: boolean
    topBackups?: number
  } | null
}

export function recommend(ctx: RecommendContext): Verdict {
  const { league, pool, players, roster, currentPick } = ctx
  const opponent = ctx.opponentSurvival ?? null
  const slot = league.mySlot
  const next = slot != null ? nextPickFor(slot, league.teams, league.rounds, currentPick) : null

  const tiers = assignTiers(pool)
  const openPositions = new Set<Pos>()
  for (const s of roster.slots) if (!s.filled) s.eligible.forEach((p) => openPositions.add(p))

  const surv = (r: AdjustedRanking) =>
    next == null ? 1 : blendedSurvival(r, next, opponent)

  const expectedByPos = new Map<Pos, number>()
  if (next != null) {
    for (const pos of openPositions) {
      expectedByPos.set(pos, expectedBestAt(pool, pos, players, next, opponent))
    }
  }

  const ranked = [...pool].sort((a, b) => b.adjustedValue - a.adjustedValue)

  /*
   * Late in a draft the arithmetic stops being about value. If you have as many
   * picks left as you have empty starting slots, every remaining pick is spoken
   * for — recommending the best receiver available when the only holes are
   * kicker and defense is advice you cannot take. Kickers carry a deliberately
   * low value so they never outrank a skill player, which means VONA alone can
   * never surface them.
   */
  const mandatory = roster.slots
    .filter((s) => !s.filled && s.eligible.length === 1)
    .map((s) => s.eligible[0])
  const picksLeft =
    slot != null
      ? myPicks(slot, league.teams, league.rounds).filter((p) => p >= currentPick).length
      : Infinity
  const forced = mandatory.length > 0 && picksLeft <= mandatory.length
  const forcedSet = new Set(forced ? mandatory : [])

  /*
   * Once every starting slot is filled the board stops being useful: value over
   * replacement cannot price a back-up who is worth nothing until an injury,
   * so it keeps offering veteran depth through exactly the rounds a drafter
   * spends on upside and insurance. Where a late-target strategy is declared,
   * those archetypes lead instead.
   */
  const myIds = ctx.myIds ?? []
  /*
   * Kicker and defence do not count as unfilled here. They are deliberately
   * left until the last rounds, so counting them kept the lineup looking
   * incomplete and the window never opened at all.
   */
  const LATE_SLOT_POS = ['K', 'DST']
  const openRealStarters = roster.slots.filter(
    (s) => !s.filled && !s.eligible.every((p) => LATE_SLOT_POS.includes(p)),
  ).length
  const lateWindow =
    ctx.lateTargets != null &&
    inLateWindow({
      openStarterSlots: openRealStarters,
      picksRemaining: picksLeft,
      reservedForLateSlots: ctx.lateTargets.reserveLastRounds,
    })

  const backfield = backfieldByAdp(pool, players)
  const archetypeOf = (id: PlayerId) => classify(players.get(id), players, myIds, backfield)

  /*
   * Only the best few of each archetype qualify. Every rookie is a lottery
   * ticket but most are not worth one, and a back-up behind someone else's
   * starter insures nothing you own.
   */
  const lt = ctx.lateTargets
  const qualifying = new Set<PlayerId>()
  if (lateWindow && lt) {
    const rookiePositions = lt.rookiePositions ?? (['WR'] as Pos[])
    const topRookies = lt.topRookies ?? 5
    // A named shortlist beats the board's own ordering, which ranks rookies by
    // projection and in a thin class surfaces names nobody would take.
    const shortlisted = new Set((lt.rookieShortlist ?? []).map((n) => n.toLowerCase()))
    const rookies = shortlisted.size
      ? ranked.filter((r) => shortlisted.has((players.get(r.playerId)?.name ?? '').toLowerCase()))
      : ranked
          .filter((r) => {
            const p = players.get(r.playerId)
            return p?.yearsExp === 0 && rookiePositions.includes(p.pos)
          })
          .slice(0, topRookies)
    for (const r of rookies) qualifying.add(r.playerId)

    // Handcuffs to your own backs, all of them — there are never many.
    for (const r of ranked) {
      if (archetypeOf(r.playerId).behind?.mine) qualifying.add(r.playerId)
    }
    /*
     * Then the best few behind other people's starters, ranked beneath yours.
     * A named back is kept ahead of the cap rather than sorted after it: taking
     * the top few by value first threw away the very names that were chosen by
     * hand, since a handcuff has barely any value to sort on.
     */
    if (lt.includeUnownedBackups) {
      const named = new Set((lt.handcuffOrder ?? []).map((n) => n.toLowerCase()))
      const backups = ranked.filter((r) => archetypeOf(r.playerId).kinds.includes('backup'))
      const isNamed = (r: AdjustedRanking) =>
        named.has((players.get(r.playerId)?.name ?? '').toLowerCase())
      const keep = [...backups.filter(isNamed), ...backups.filter((r) => !isNamed(r))].slice(
        0,
        lt.topBackups ?? 5,
      )
      for (const r of keep) qualifying.add(r.playerId)
    }
  }


  /*
   * With the draft down to its mandatory slots, the shortlist has to cover each
   * of them. Filtering to the eligible positions and then taking the best three
   * offered three kickers and no defence when both were still needed — which
   * reads as advice to spend your last two picks on kickers.
   */
  const eligible = forced
    ? (() => {
        const byPos = new Map<Pos, AdjustedRanking[]>()
        for (const r of ranked) {
          const pos = players.get(r.playerId)?.pos as Pos | undefined
          if (!pos || !forcedSet.has(pos)) continue
          ;(byPos.get(pos) ?? byPos.set(pos, []).get(pos)!).push(r)
        }
        // Round-robin, so the best of each position leads before the second of any.
        const out: AdjustedRanking[] = []
        const lists = [...byPos.values()]
        for (let i = 0; lists.some((l) => l[i]); i++) {
          for (const l of lists) if (l[i]) out.push(l[i])
        }
        return out
      })()
    : ranked
  const base = (eligible.length ? eligible : ranked).slice(
    0,
    Math.max(15, (ctx.limit ?? 3) * 5),
  )
  /*
   * A handcuff or a rookie flier sits well down a board sorted by value, so
   * taking the top fifteen and then re-ranking never reached them. In the late
   * window they join the shortlist explicitly.
   */
  const shortlist = lateWindow
    ? [...base, ...ranked.filter((r) => qualifying.has(r.playerId) && !base.includes(r))]
    : base

  const scored = shortlist.map((r) => {
    const pos = players.get(r.playerId)?.pos ?? 'WR'
    const expected = expectedByPos.get(pos)
    return {
      r,
      pos,
      vona: expected != null ? r.adjustedValue - expected : 0,
      surv: surv(r),
      need: openPositions.has(pos) ? 1 : 0,
    }
  })

  /*
   * A position with every slot already filled cannot improve the lineup this
   * week — a second quarterback is depth, however good he is. Depth is a real
   * pick in the late rounds, but it must never be offered ahead of a player who
   * fills a hole, which is what happened when a filled position scored a
   * neutral zero and floated above genuinely negative values.
   */
  const fillsNeed = (pos: Pos) => openPositions.has(pos)

  // Each axis nominates its own winner, so divergence is visible rather than
  // averaged away.
  const bestValue = [...scored].sort((a, b) => b.r.adjustedValue - a.r.adjustedValue)[0]
  const bestScarcity = [...scored].sort(
    (a, b) => a.surv - b.surv || b.r.adjustedValue - a.r.adjustedValue,
  )[0]
  const bestNeed = [...scored]
    .filter((s) => s.need === 1)
    .sort((a, b) => b.vona - a.vona)[0]

  const axesOf = (id: PlayerId): RecommendationAxis[] => {
    const out: RecommendationAxis[] = []
    if (bestValue?.r.playerId === id) out.push('value')
    if (bestScarcity?.r.playerId === id) out.push('scarcity')
    if (bestNeed?.r.playerId === id) out.push('need')
    return out
  }

  /*
   * Both named lists are read in the order they are written. Without that,
   * everything here ties: a flier has no ranking, so value cannot separate one
   * handcuff from another and they surfaced in whatever order the pool held.
   * The list position is a tiebreak only — it never lifts a lottery ticket over
   * insurance on a back already paid for.
   */
  const namedOrder = new Map<string, number>()
  for (const list of [lt?.handcuffOrder ?? [], lt?.rookieShortlist ?? []]) {
    list.forEach((n, i) => namedOrder.set(n.toLowerCase(), list.length - i))
  }
  const lateScore = (id: PlayerId) => {
    if (!lateWindow || !lt || !qualifying.has(id)) return 0
    const rank = archetypeRank(archetypeOf(id), lt.prefer)
    const named = namedOrder.get((players.get(id)?.name ?? '').toLowerCase()) ?? 0
    return rank * 1000 + named
  }

  const shortlistOrder = new Map(shortlist.map((r, i) => [r.playerId, i]))
  scored.sort((a, b) => {
    /*
     * When every remaining pick is mandatory, the order the slots were laid out
     * in is the answer — one of each, best first — and value differences inside
     * a position are noise next to leaving a slot empty.
     */
    if (forced) {
      return (
        (shortlistOrder.get(a.r.playerId) ?? 0) - (shortlistOrder.get(b.r.playerId) ?? 0)
      )
    }
    if (lateWindow) {
      const d = lateScore(b.r.playerId) - lateScore(a.r.playerId)
      if (d !== 0) return d
    }
    return (
      Number(fillsNeed(b.pos)) - Number(fillsNeed(a.pos)) ||
      b.vona - a.vona ||
      b.r.adjustedValue - a.r.adjustedValue
    )
  })
  const limit = ctx.limit ?? 3
  const top = scored.slice(0, limit)

  const picks: Recommendation[] = top.map(({ r, pos, vona, surv: s }) => {
    const player = players.get(r.playerId)
    const tier = tiers.get(r.playerId) ?? 0
    const sameTier = ranked.filter((x) => tiers.get(x.playerId) === tier)
    const adpOnly = next != null ? survival(r.adp, next, r.adpStdev) : 1
    const oppOnly = opponent?.get(r.playerId) ?? null

    const reasons: string[] = []
    if (sameTier.length === 1) reasons.push(`last in tier ${tier}`)
    else if (sameTier.length <= 3) reasons.push(`${sameTier.length} left in tier ${tier}`)
    if (next != null) {
      if (s < 0.25) reasons.push(`${Math.round(s * 100)}% to survive to ${next}`)
      else if (s > 0.75) reasons.push(`likely available at ${next}`)
    }
    if (r.adp - r.myRank >= 8) reasons.push(`value vs ADP +${Math.round(r.adp - r.myRank)}`)
    if (r.myRank - r.adp >= 8) reasons.push(`reach vs ADP -${Math.round(r.myRank - r.adp)}`)
    if (forced && forcedSet.has(pos)) {
      reasons.push(
        `${picksLeft} pick${picksLeft === 1 ? '' : 's'} left and ${mandatory.length} slot${
          mandatory.length === 1 ? '' : 's'
        } to fill — this is one of them`,
      )
    } else if (openPositions.has(pos)) reasons.push('fills open starter')
    else if (lateWindow) {
      const info = archetypeOf(r.playerId)
      reasons.push(
        info.label
          ? info.behind?.top
            ? `${info.label} — insurance on one of your first three backs`
            : info.behind?.mine
              ? `${info.label} — insurance on a back you own, but a bench one`
              : info.label
          : `depth — every ${pos} slot is already filled`,
      )
    } else reasons.push(`depth — every ${pos} slot is already filled`)
    if (r.adjustmentDelta !== 0)
      reasons.push(`adj ${r.adjustmentDelta > 0 ? '+' : ''}${r.adjustmentDelta.toFixed(1)}`)

    return {
      playerId: r.playerId,
      name: player?.name ?? r.playerId,
      pos,
      team: player?.team ?? null,
      byeWeek: player?.byeWeek ?? null,
      value: r.value,
      adjustedValue: r.adjustedValue,
      adp: r.adp,
      survival: s,
      survivalAdp: adpOnly,
      survivalOpponent: oppOnly,
      vona,
      tier,
      posRank: r.posRank,
      axes: axesOf(r.playerId),
      reasons,
    }
  })

  const gap = picks.length > 1 ? picks[0].vona - picks[1].vona : Infinity
  const winners = new Set(
    [bestValue?.r.playerId, bestScarcity?.r.playerId, bestNeed?.r.playerId].filter(Boolean),
  )
  const unanimous = winners.size === 1 && gap >= 0.25
  const confidence: Verdict['confidence'] =
    unanimous ? 'clear' : gap < 0.15 ? 'close' : winners.size > 2 ? 'split' : 'close'

  // Surface it when ADP and the opponent model would lead to different picks.
  let modelConflict: string | null = null
  if (opponent && next != null) {
    for (const p of picks) {
      if (p.survivalOpponent == null) continue
      const d = p.survivalOpponent - p.survivalAdp
      if (Math.abs(d) >= 0.35) {
        modelConflict =
          d > 0
            ? `${p.name} looks scarce by ADP but the teams ahead of you do not need ${p.pos} — ${Math.round(p.survivalOpponent * 100)}% he lasts`
            : `${p.name} looks safe by ADP but ${Math.round((1 - p.survivalOpponent) * 100)}% of the teams ahead need ${p.pos}`
        break
      }
    }
  }

  return {
    picks,
    gap: gap === Infinity ? 0 : gap,
    unanimous,
    confidence,
    modelConflict,
    // Emitted in the order they should be taken, not the order they were found,
    // so the board can lead with the same ranking the verdict used.
    lateTargetIds: [...qualifying].sort((a, b) => lateScore(b) - lateScore(a)),
  }
}

/** Positions where the last player of a tier is about to go. */
export function tierBreaks(
  pool: AdjustedRanking[],
  players: Map<PlayerId, Player>,
): { pos: Pos; tier: number; remaining: number; playerId: PlayerId }[] {
  const tiers = assignTiers(pool)
  const groups = new Map<string, AdjustedRanking[]>()
  for (const r of pool) {
    const pos = players.get(r.playerId)?.pos
    if (!pos) continue
    const k = `${pos}:${tiers.get(r.playerId)}`
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(r)
  }
  const out: { pos: Pos; tier: number; remaining: number; playerId: PlayerId }[] = []
  for (const [k, members] of groups) {
    if (members.length > 2) continue
    const [pos, tier] = k.split(':')
    const best = members.sort((a, b) => b.adjustedValue - a.adjustedValue)[0]
    out.push({ pos: pos as Pos, tier: Number(tier), remaining: members.length, playerId: best.playerId })
  }
  return out.sort((a, b) => a.remaining - b.remaining)
}

/** 4 of the last 6 picks at one position signals a run. */
export function detectRun(
  recentPositions: Pos[],
  window = 6,
  threshold = 4,
): { pos: Pos; count: number } | null {
  const recent = recentPositions.slice(-window)
  const counts = new Map<Pos, number>()
  for (const p of recent) counts.set(p, (counts.get(p) ?? 0) + 1)
  for (const [pos, count] of counts) if (count >= threshold) return { pos, count }
  return null
}

export { picksBetween }
