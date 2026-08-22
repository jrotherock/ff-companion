import type { Adjustment, LeagueConfig, Player, Pos, Ranking } from './types.js'

/**
 * Per-player counts of events the ranking source cannot score, measured from
 * real prior-season stats rather than assumed.
 */
export interface BigPlayRates {
  rec40: number
  recTd40: number
  rush40: number
  rushTd40: number
  passCmp40: number
  passTd40: number
  gamesOver150Rec: number
  gamesOver150Rush: number
  gamesOver350Pass: number
  fgYards: number
  fgMade: number
}

/**
 * BEER+ is scarcity-adjusted, not raw points over replacement, so season points
 * do not convert to value by a single constant. The data pipeline measures
 * dValue/dPoint per position by perturbing a known scoring field, and stores
 * the slope here. Without a measured slope the adjustment is skipped rather
 * than guessed.
 */
export type ValueSlopes = Partial<Record<Pos, number>>

export interface AdjustmentData {
  rates: Record<string, BigPlayRates>
  slopes: ValueSlopes
  season: number
}

function seasonPoints(a: Adjustment, r: BigPlayRates): number {
  switch (a.kind) {
    case 'bigPlay':
      return (
        r.rec40 * (a.points.rec40 ?? 0) +
        r.recTd40 * (a.points.recTd40 ?? 0) +
        r.rush40 * (a.points.rush40 ?? 0) +
        r.rushTd40 * (a.points.rushTd40 ?? 0) +
        r.passCmp40 * (a.points.passCmp40 ?? 0) +
        r.passTd40 * (a.points.passTd40 ?? 0)
      )
    case 'yardageMilestone':
      return (
        r.gamesOver150Rec * (a.points.rec150 ?? 0) +
        r.gamesOver150Rush * (a.points.rush150 ?? 0) +
        r.gamesOver350Pass * (a.points.pass350 ?? 0)
      )
    case 'kickerDistance':
      // Distance scoring replaces flat per-make scoring rather than adding to it.
      return r.fgYards * (a.points.perYard ?? 0) - r.fgMade * (a.points.replacesFlat ?? 0)
  }
}

export interface AdjustedRanking extends Ranking {
  adjustedValue: number
  adjustmentDelta: number
  adjustmentDetail: string[]
}

/**
 * Applies enabled adjustments on top of BEER+. Off by default at the league
 * level; the UI toggles `enabled` at runtime.
 */
/** How many of a position come off the board as starters, i.e. replacement depth. */
function replacementRank(league: LeagueConfig, pos: Pos): number {
  const dedicated = league.starters[pos] ?? 0
  const flexShare = league.flex
    .filter((f) => f.eligible.includes(pos))
    .reduce((s, f) => s + f.count / f.eligible.length, 0)
  return Math.max(1, Math.round(league.teams * (dedicated + flexShare)))
}

export function applyAdjustments(
  rankings: Ranking[],
  players: Map<string, Player>,
  league: LeagueConfig,
  data: AdjustmentData | null,
  enabled: boolean,
): AdjustedRanking[] {
  const plain = (r: Ranking): AdjustedRanking => ({
    ...r,
    adjustedValue: r.value,
    adjustmentDelta: 0,
    adjustmentDetail: [],
  })
  if (!enabled || !data || league.adjustments.length === 0) return rankings.map(plain)

  const bonusOf = (playerId: string): number | null => {
    const rates = data.rates[playerId]
    if (!rates) return 0
    let pts = 0
    for (const a of league.adjustments) pts += seasonPoints(a, rates)
    return pts
  }

  // The board is value over replacement, so the bonus must be measured the same
  // way: a bonus every starter also earns is not an edge.
  const replacementBonus = new Map<Pos, number>()
  for (const pos of new Set([...players.values()].map((p) => p.pos))) {
    const atPos = rankings
      .filter((r) => players.get(r.playerId)?.pos === pos)
      .sort((a, b) => b.value - a.value)
    if (atPos.length === 0) continue
    const idx = Math.min(replacementRank(league, pos), atPos.length) - 1
    replacementBonus.set(pos, bonusOf(atPos[idx].playerId) ?? 0)
  }

  return rankings.map((r) => {
    const base = plain(r)
    const rates = data.rates[r.playerId]
    const pos = players.get(r.playerId)?.pos
    const slope = pos ? data.slopes[pos] : undefined
    if (!pos || !slope) return base

    const detail: string[] = []
    let pts = 0
    for (const a of league.adjustments) {
      const p = rates ? seasonPoints(a, rates) : 0
      if (Math.abs(p) < 0.5) continue
      pts += p
      detail.push(`${a.label} ${p > 0 ? '+' : ''}${p.toFixed(0)}pts`)
    }

    const over = pts - (replacementBonus.get(pos) ?? 0)
    const delta = over * slope
    if (Math.abs(delta) < 0.005) return base

    return {
      ...base,
      adjustedValue: r.value + delta,
      adjustmentDelta: delta,
      adjustmentDetail: detail,
    }
  })
}
