import type { LeagueConfig, Player, PlayerId, Pick, Pos } from './types.js'
import type { AdjustedRanking } from './adjust.js'
import { buildRoster } from './roster.js'
import { slotFor } from './snake.js'
import { survival } from './value.js'

/**
 * ADP survival treats the picks between my turns as an anonymous draw from the
 * market. But those picks belong to specific teams whose rosters I can see, and
 * a team with two RBs already is not taking a third.
 *
 * This models each intervening pick as that team taking whichever player is
 * most overdue against ADP, weighted by its own positional need.
 *
 * Validated across two real drafts: parameters fitted on the 2025 Fantasy
 * Steward draft score 51.7% top-1 on the 2025 Harker Green draft — different
 * managers, a 3-WR roster, and no influence on the fit — against a 40.8%
 * majority-class baseline, and within 0.013 logloss of Green's own best fit.
 *
 * It is still blended with rather than substituted for ADP, because that
 * validation is at the position level; the model has no demonstrated skill at
 * choosing between two players at the same position.
 */

/**
 * Fitted against the 2025 Fantasy Steward draft (156 real picks, same league).
 * See scripts/calibrate2.ts.
 *
 * Softmax sharpness. The first guess of 0.35 was roughly four times too sharp
 * and produced 0%/100% survival claims the data does not support.
 */
const TEMPERATURE = 1.5
/** How much an open starter slot is worth to an opponent, in score units. */
const NEED_WEIGHT = 1.6

/**
 * Opponents draft by ADP, not by value over replacement. Scoring by BEER+ value
 * performed *worse* than always guessing the most common position on held-out
 * picks; scoring by how overdue a player is against ADP beat it.
 */
const ADP_SCALE = 10

/**
 * Weight on the ADP model in the blend. The opponent model is validated at the
 * position level but has no demonstrated skill at picking individual players,
 * and it beat a majority-class guess by only ~2 points out of sample — so it
 * informs the estimate rather than driving it.
 */
export const DEFAULT_ADP_WEIGHT = 0.72

/**
 * Beyond this round the draft stops being predictable: late picks are pure slot
 * filling, and a model fitted on early rounds generalises to them terribly.
 * Survival also stops mattering once everyone is available.
 */
const MAX_MODELLED_ROUND = 10

function openStarters(
  league: LeagueConfig,
  ids: PlayerId[],
  players: Map<PlayerId, Player>,
  valueOf: (id: PlayerId) => number,
): Map<Pos, number> {
  const roster = buildRoster(league, ids, players, valueOf)
  const open = new Map<Pos, number>()
  for (const s of roster.slots) {
    if (s.filled) continue
    for (const p of s.eligible) open.set(p, (open.get(p) ?? 0) + 1 / s.eligible.length)
  }
  return open
}

export interface OpponentContext {
  league: LeagueConfig
  pool: AdjustedRanking[]
  players: Map<PlayerId, Player>
  picks: Pick[]
  /** Exclusive lower bound: the pick I am making now. */
  from: number
  /** My next turn. */
  to: number
  valueOf: (id: PlayerId) => number
}

/** P(each available player is still on the board at `to`), opponent-aware. */
export function opponentSurvival(ctx: OpponentContext): Map<PlayerId, number> {
  const { league, pool, players, picks, from, to, valueOf } = ctx
  const taken = new Map<PlayerId, number>()
  if (to <= from + 1) return new Map(pool.map((r) => [r.playerId, 1]))
  // Past the early rounds the model is not better than ADP, so it stands aside.
  const round = Math.floor((from - 1) / league.teams) + 1
  if (round > MAX_MODELLED_ROUND) return new Map(pool.map((r) => [r.playerId, 1]))

  const idsBySlot = new Map<number, PlayerId[]>()
  for (const p of picks) {
    ;(idsBySlot.get(p.slot) ?? idsBySlot.set(p.slot, []).get(p.slot)!).push(p.playerId)
  }
  const needCache = new Map<number, Map<Pos, number>>()

  for (let pick = from + 1; pick < to; pick++) {
    const slot = slotFor(pick, league.teams)
    let open = needCache.get(slot)
    if (!open) {
      open = openStarters(league, idsBySlot.get(slot) ?? [], players, valueOf)
      needCache.set(slot, open)
    }

    let max = -Infinity
    const scored: { id: PlayerId; s: number; left: number }[] = []
    for (const r of pool) {
      const left = 1 - (taken.get(r.playerId) ?? 0)
      if (left <= 0.001) continue
      const pos = players.get(r.playerId)?.pos
      if (!pos) continue
      // How overdue this player is relative to where the room drafts him.
      const s = (pick - r.adp) / ADP_SCALE + NEED_WEIGHT * (open.get(pos) ?? 0)
      if (s > max) max = s
      scored.push({ id: r.playerId, s, left })
    }
    if (scored.length === 0) break

    let z = 0
    const weights = scored.map((x) => {
      const e = Math.exp((x.s - max) / TEMPERATURE) * x.left
      z += e
      return { id: x.id, e }
    })
    if (z <= 0) break
    for (const { id, e } of weights) {
      taken.set(id, Math.min(1, (taken.get(id) ?? 0) + e / z))
    }
  }

  const out = new Map<PlayerId, number>()
  for (const r of pool) out.set(r.playerId, Math.max(0, 1 - (taken.get(r.playerId) ?? 0)))
  return out
}

/**
 * Blended survival. Falls back to pure ADP when there is no opponent estimate,
 * so the value engine never depends on this model being available.
 */
export function blendedSurvival(
  r: AdjustedRanking,
  to: number,
  opponent: Map<PlayerId, number> | null,
  adpWeight = DEFAULT_ADP_WEIGHT,
): number {
  const adp = survival(r.adp, to, r.adpStdev)
  const opp = opponent?.get(r.playerId)
  if (opp == null) return adp
  return adpWeight * adp + (1 - adpWeight) * opp
}

/**
 * Positions the teams picking before my next turn most need, which is what
 * actually drives a run rather than what has already happened.
 */
export function upcomingDemand(ctx: OpponentContext): { pos: Pos; demand: number }[] {
  const { league, players, picks, from, to, valueOf } = ctx
  const idsBySlot = new Map<number, PlayerId[]>()
  for (const p of picks) {
    ;(idsBySlot.get(p.slot) ?? idsBySlot.set(p.slot, []).get(p.slot)!).push(p.playerId)
  }
  const total = new Map<Pos, number>()
  for (let pick = from + 1; pick < to; pick++) {
    const slot = slotFor(pick, league.teams)
    const open = openStarters(league, idsBySlot.get(slot) ?? [], players, valueOf)
    for (const [pos, n] of open) total.set(pos, (total.get(pos) ?? 0) + n)
  }
  return [...total.entries()]
    .map(([pos, demand]) => ({ pos, demand: Math.round(demand * 10) / 10 }))
    .sort((a, b) => b.demand - a.demand)
}
