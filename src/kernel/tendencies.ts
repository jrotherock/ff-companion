import type { DraftReview } from './review.js'

/**
 * Patterns across drafts.
 *
 * One draft tells you almost nothing — a single costly pick could be a lapse or
 * a considered contrarian call. The same shape appearing in five drafts is a
 * habit, and habits are the only thing worth changing.
 *
 * Everything here refuses to speak below a sample it can stand behind.
 */

export interface DraftInput {
  key: string
  label: string
  platform: string
  mock: boolean
  when: number
  review: DraftReview
}

export interface Tendency {
  id: string
  headline: string
  detail: string
  /** How much to trust it: drafts the claim rests on. */
  drafts: number
  strength: 'clear' | 'suggestive' | 'thin'
}

export interface TendencyReport {
  drafts: number
  picks: number
  avgCost: number
  tendencies: Tendency[]
  /** Cost by round, averaged — where the value actually leaks. */
  costByRound: { round: number; avgCost: number; picks: number }[]
  /** How often each position was taken, by round band. */
  positionByPhase: { phase: string; counts: Record<string, number> }[]
  caveat: string
}

const strengthOf = (n: number): Tendency['strength'] =>
  n >= 5 ? 'clear' : n >= 3 ? 'suggestive' : 'thin'

export function analyseTendencies(drafts: DraftInput[]): TendencyReport {
  const n = drafts.length
  const allPicks = drafts.flatMap((d) => d.review.picks)
  const tendencies: Tendency[] = []

  // ---- where value leaks, by round
  const byRound = new Map<number, { cost: number; picks: number }>()
  for (const p of allPicks) {
    const e = byRound.get(p.round) ?? { cost: 0, picks: 0 }
    e.cost += p.cost
    e.picks++
    byRound.set(p.round, e)
  }
  const costByRound = [...byRound.entries()]
    .map(([round, e]) => ({ round, avgCost: r2(e.cost / e.picks), picks: e.picks }))
    .sort((a, b) => a.round - b.round)

  const worst = [...costByRound].filter((r) => r.picks >= n).sort((a, b) => b.avgCost - a.avgCost)[0]
  if (worst && worst.avgCost >= 0.5) {
    tendencies.push({
      id: 'leak-round',
      headline: `Round ${worst.round} is where you leak most`,
      detail: `Across ${n} draft${n === 1 ? '' : 's'} your round ${worst.round} pick cost ${worst.avgCost.toFixed(1)} on average against the best available that fitted.`,
      drafts: n,
      strength: strengthOf(n),
    })
  }

  // ---- early versus late
  const early = drafts.reduce((s, d) => s + d.review.costEarly, 0)
  const late = drafts.reduce((s, d) => s + d.review.costLate, 0)
  if (early + late >= n * 2) {
    const frontLoaded = early > late * 1.5
    if (frontLoaded || late > early * 1.5) {
      tendencies.push({
        id: 'phase',
        headline: frontLoaded ? 'Your mistakes are early' : 'Your mistakes are late',
        detail: frontLoaded
          ? `${r2(early)} of ${r2(early + late)} total cost came in the first half. Early picks are worth several late ones, so this is the expensive way round.`
          : `${r2(late)} of ${r2(early + late)} came after halfway, where a miss costs least.`,
        drafts: n,
        strength: strengthOf(n),
      })
    }
  }

  // ---- position habits by phase
  const phases: [string, (r: number) => boolean][] = [
    ['rounds 1-3', (r) => r <= 3],
    ['rounds 4-8', (r) => r >= 4 && r <= 8],
    ['rounds 9+', (r) => r >= 9],
  ]
  const positionByPhase = phases.map(([phase, test]) => {
    const counts: Record<string, number> = {}
    for (const p of allPicks) {
      if (!test(p.round) || !p.taken.pos) continue
      counts[p.taken.pos] = (counts[p.taken.pos] ?? 0) + 1
    }
    return { phase, counts }
  })

  const openers = positionByPhase[0].counts
  const openTotal = Object.values(openers).reduce((a, b) => a + b, 0)
  const dominant = Object.entries(openers).sort((a, b) => b[1] - a[1])[0]
  if (dominant && openTotal >= n * 2 && dominant[1] / openTotal >= 0.6) {
    tendencies.push({
      id: 'opener',
      headline: `You open ${dominant[0]}-heavy`,
      detail: `${dominant[1]} of your first ${openTotal} picks were ${dominant[0]}. Worth knowing whether that is the plan or a habit.`,
      drafts: n,
      strength: strengthOf(n),
    })
  }

  // ---- depth picks taken over players who filled a hole
  const depth = allPicks.filter((p) => p.notes.some((x) => x.includes('depth pick')))
  if (depth.length >= n) {
    const cost = r2(depth.reduce((s, p) => s + p.cost, 0))
    tendencies.push({
      id: 'depth',
      headline: 'You take depth while starting slots are open',
      detail: `${depth.length} picks went to positions with no open slot, costing ${cost} against players who would have filled one.`,
      drafts: n,
      strength: strengthOf(n),
    })
  }

  // ---- does the pre-draft list help or hurt
  const likeCost = drafts.reduce((s, d) => s + d.review.preference.likeCost, 0)
  const likeCount = drafts.reduce((s, d) => s + d.review.preference.likesTaken, 0)
  if (likeCount >= n * 2) {
    const per = likeCost / likeCount
    tendencies.push({
      id: 'preference',
      headline:
        per < 0.2
          ? 'Your pre-draft list agrees with the board'
          : 'Your pre-draft list is costing you value',
      detail:
        per < 0.2
          ? `${likeCount} picks came off your own list at ${per.toFixed(2)} average cost — the list and the board want the same players.`
          : `${likeCount} picks off your list cost ${per.toFixed(2)} each on average. Either the list is out of date or the board is wrong about those players; both are worth checking before draft night.`,
      drafts: n,
      strength: strengthOf(n),
    })
  }

  const avoids = drafts.reduce((s, d) => s + d.review.preference.avoidsTaken.length, 0)
  if (avoids > 0) {
    tendencies.push({
      id: 'avoids',
      headline: 'You draft players you said you would not',
      detail: `${avoids} picks across ${n} draft${n === 1 ? '' : 's'} came off your do-not-draft list. Either the list needs pruning or the discipline does.`,
      drafts: n,
      strength: strengthOf(n),
    })
  }

  const totalCost = drafts.reduce((s, d) => s + d.review.totalCost, 0)

  return {
    drafts: n,
    picks: allPicks.length,
    avgCost: allPicks.length ? r2(totalCost / n) : 0,
    tendencies: tendencies.sort((a, b) => rankStrength(b) - rankStrength(a)),
    costByRound,
    positionByPhase,
    caveat:
      n >= 5
        ? 'Five or more drafts is enough to call these habits rather than noise.'
        : n >= 3
          ? 'Three or four drafts shows a shape, not yet a habit. Treat these as questions.'
          : 'One or two drafts cannot separate a habit from a one-off. Run a few more before changing anything.',
  }
}

const rankStrength = (t: Tendency) =>
  t.strength === 'clear' ? 3 : t.strength === 'suggestive' ? 2 : 1
const r2 = (n: number) => Math.round(n * 100) / 100
