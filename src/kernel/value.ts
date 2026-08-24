import type {
  LeagueConfig, Player, PlayerId, Pos, Recommendation, RecommendationAxis, Roster, Verdict,
} from './types.js'
import type { AdjustedRanking } from './adjust.js'
import { myPicks, nextPickFor, picksBetween } from './snake.js'
import { blendedSurvival } from './opponents.js'

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

  const eligible = forced
    ? ranked.filter((r) => forcedSet.has(players.get(r.playerId)?.pos ?? ('' as Pos)))
    : ranked
  const shortlist = (eligible.length ? eligible : ranked).slice(
    0,
    Math.max(15, (ctx.limit ?? 3) * 5),
  )

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

  scored.sort((a, b) => b.vona - a.vona || b.r.adjustedValue - a.r.adjustedValue)
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

  return { picks, gap: gap === Infinity ? 0 : gap, unanimous, confidence, modelConflict }
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
