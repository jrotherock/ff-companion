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
  /**
   * What to actually do about it next time. A tendency with no experiment
   * attached is trivia — it tells you something about yourself and leaves you
   * no way to find out whether changing it helps.
   */
  tryNext: string | null
}

/**
 * What to do differently next time, in order of what it is worth.
 *
 * Structured after the deliberate-practice account of feedback, which scores it
 * on three parts: the task, the performance gap, and the action plan. Studies of
 * real feedback find the task named about half the time but a gap in under 4% of
 * cases and a plan in under 14% — almost all feedback describes and stops. The
 * first version of this screen did exactly that.
 *
 * So each item carries all three, and the gap names the actual pick: "round 4
 * costs 0.8 on average" is forgettable, "you took Maye over Swift" is not.
 *
 * Capped at three, because deliberate practice works on one or two gaps at a
 * time and a list of everything wrong is a list nobody acts on.
 */
export interface PlaybookItem {
  id: string
  /** The instruction, in the imperative. */
  action: string
  /** The moment it applies, so it can be recognised at the table. */
  when: string
  /** Concrete evidence, naming real picks. */
  because: string
  /** What to look for afterwards. */
  check: string
  worth: number
  strength: 'clear' | 'suggestive' | 'thin'
}

export interface TendencyReport {
  /** Read this before the next mock; everything else is supporting detail. */
  playbook: PlaybookItem[]
  headline: string
  drafts: number
  picks: number
  avgCost: number
  tendencies: Tendency[]
  /**
   * Cost by round with the spread kept. An average hides the difference between
   * one disastrous round and six mediocre ones, which need opposite responses.
   */
  costByRound: {
    round: number
    avgCost: number
    worst: number
    picks: number
    points: number[]
  }[]
  /** What the disciplined alternative would have produced, per draft. */
  counterfactual: { label: string; actual: number; ideal: number; gain: number }[]
  /** Opening shape crossed with what it cost — counts alone say nothing. */
  openerCost: { shape: string; drafts: number; avgCost: number }[]
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
  const byRound = new Map<number, number[]>()
  for (const p of allPicks) {
    ;(byRound.get(p.round) ?? byRound.set(p.round, []).get(p.round)!).push(p.cost)
  }
  const costByRound = [...byRound.entries()]
    .map(([round, points]) => ({
      round,
      avgCost: r2(points.reduce((a, b) => a + b, 0) / points.length),
      worst: r2(Math.max(...points)),
      picks: points.length,
      points: points.map(r2),
    }))
    .sort((a, b) => a.round - b.round)

  const worst = [...costByRound].filter((r) => r.picks >= n).sort((a, b) => b.avgCost - a.avgCost)[0]
  if (worst && worst.avgCost >= 0.5) {
    tendencies.push({
      id: 'leak-round',
      headline: `Round ${worst.round} is where you leak most`,
      detail: `Across ${n} draft${n === 1 ? '' : 's'} your round ${worst.round} pick cost ${worst.avgCost.toFixed(1)} on average against the best available that fitted, worst case ${worst.worst.toFixed(1)}.`,
      drafts: n,
      strength: strengthOf(n),
      tryNext: `Next mock, pause on your round ${worst.round} pick and open the why panel on both your choice and the top card before deciding.`,
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
        tryNext: frontLoaded
          ? 'Next mock, take the verdict without deviation for the first four rounds and spend your judgement later.'
          : 'Nothing urgent — late leakage is the cheap kind. Worth checking your last few rounds are not being autopicked.',
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

  /*
   * Opening shape against what it cost.
   *
   * Two traps here, both of which produced a confident and wrong reading first
   * time round. Total draft cost cannot be attributed to the first two picks —
   * a bad round thirteen would count against the opener. And a longer draft
   * accumulates more cost simply by having more picks, so a fifteen-round Yahoo
   * league looks worse than a fourteen-round Sleeper one whatever was drafted.
   *
   * So: cost per pick, only over the rounds the opening actually shapes, and
   * nothing is reported until at least two drafts share a shape and there are
   * enough drafts overall for the comparison to mean anything.
   */
  const OPENER_MIN_DRAFTS = 6
  const openerCost = (() => {
    if (n < OPENER_MIN_DRAFTS) return []
    const shapes = new Map<string, { cost: number; picks: number; n: number }>()
    for (const d of drafts) {
      const first = d.review.picks
        .filter((p) => p.round <= 2)
        .sort((a, b) => a.round - b.round)
        .map((p) => p.taken.pos ?? '?')
      if (first.length < 2) continue
      const shape = first.slice(0, 2).join('-')
      // Only the rounds the opening plausibly constrains.
      const window = d.review.picks.filter(
        (p) => p.round >= 3 && p.round <= 8 && p.verdict !== 'offboard',
      )
      if (!window.length) continue
      const e = shapes.get(shape) ?? { cost: 0, picks: 0, n: 0 }
      e.cost += window.reduce((s, p) => s + p.cost, 0)
      e.picks += window.length
      e.n++
      shapes.set(shape, e)
    }
    return [...shapes.entries()]
      .filter(([, e]) => e.n >= 2)
      .map(([shape, e]) => ({ shape, drafts: e.n, avgCost: r2(e.cost / e.picks) }))
      .sort((a, b) => a.avgCost - b.avgCost)
  })()

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
      tryNext: `Run one mock from a different draft slot and see whether you still open ${dominant[0]} — if it is the slot rather than you, the shape will change.`,
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
      tryNext: 'Use the position filter to check what is left at your open slots before taking depth — press the position key rather than scanning the whole board.',
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
      tryNext:
        per < 0.2
          ? null
          : 'Re-pull your Yahoo pre-draft ranks — the list was built earlier in the preseason and the board has moved since.',
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
      tryNext: 'Turn on HIDE AVOIDS for a mock and see whether you miss any of them.',
    })
  }

  const totalCost = drafts.reduce((s, d) => s + d.review.totalCost, 0)

  // ---------- the playbook: instructions, not observations
  const playbook: PlaybookItem[] = []
  const named = (pred: (p: any) => boolean) =>
    allPicks
      .filter((p) => pred(p) && p.verdict !== 'offboard' && p.bestNeeded)
      .sort((a, b) => b.cost - a.cost)[0] ?? null

  // the single worst decision across every draft
  const worstPick = named(() => true)
  if (worstPick && worstPick.cost >= 0.8) {
    playbook.push({
      id: 'worst-round',
      action: `Slow down on your round ${worstPick.round} pick`,
      when: `Round ${worstPick.round}, before you confirm`,
      because: `Your costliest decision across ${n} draft${n === 1 ? '' : 's'} was taking ${worstPick.taken.name} over ${worstPick.bestNeeded!.name}, who filled a hole and was worth ${worstPick.cost.toFixed(1)} more.`,
      check: `Open the why panel on the top card before you pick. If you still disagree, you will at least know what you are giving up.`,
      worth: worstPick.cost,
      strength: strengthOf(n),
    })
  }

  // depth taken while a starting slot sat empty
  const depthPicks = allPicks.filter(
    (p) => p.notes.some((x) => x.includes('depth pick')) && p.cost > 0.3 && p.bestNeeded,
  )
  if (depthPicks.length >= 2) {
    const w = depthPicks.sort((a, b) => b.cost - a.cost)[0]
    const total = r2(depthPicks.reduce((s, p) => s + p.cost, 0))
    playbook.push({
      id: 'depth',
      action: 'Fill your open slots before taking depth',
      when: 'Any pick where the position you want is already full',
      because: `${depthPicks.length} picks went to positions with every slot filled, worth ${total} in total. The worst was ${w.taken.name} in round ${w.round} while ${w.bestNeeded!.name} would have filled a starting spot.`,
      check: 'Press the position key for each empty slot before deciding — the filter shows what is actually left there.',
      worth: total,
      strength: strengthOf(n),
    })
  }

  // early rounds cost more than late ones
  const earlyCost = drafts.reduce((s, d) => s + d.review.costEarly, 0)
  const lateCost = drafts.reduce((s, d) => s + d.review.costLate, 0)
  if (earlyCost > lateCost * 1.5 && earlyCost >= n) {
    playbook.push({
      id: 'early',
      action: 'Take the verdict without deviation for the first four rounds',
      when: 'Rounds 1 to 4',
      because: `${r2(earlyCost)} of your ${r2(earlyCost + lateCost)} total cost came in the first half, where a pick is worth several late ones.`,
      check: 'Your early cost should be near zero. Spend your disagreement in the middle rounds instead, where it is cheaper to be wrong.',
      worth: earlyCost / n,
      strength: strengthOf(n),
    })
  }

  // the pre-draft list pulling against the board
  const likeCostAll = drafts.reduce((s, d) => s + d.review.preference.likeCost, 0)
  const likeCountAll = drafts.reduce((s, d) => s + d.review.preference.likesTaken, 0)
  if (likeCountAll >= n * 2 && likeCostAll / likeCountAll >= 0.2) {
    const worstLike = named((p) => p.notes.some((x: string) => x.includes('pre-draft rank')))
    playbook.push({
      id: 'list',
      action: 'Re-pull your Yahoo pre-draft ranks',
      when: 'Before the next mock, not during it',
      because:
        `${likeCountAll} picks came off your own list at ${(likeCostAll / likeCountAll).toFixed(2)} average cost` +
        (worstLike ? `, worst being ${worstLike.taken.name} over ${worstLike.bestNeeded!.name}.` : '.') +
        ' The list was built earlier in the preseason and the board has moved since.',
      check: 'After re-pulling, the same players should stop showing a gap against the board.',
      worth: likeCostAll / n,
      strength: strengthOf(n),
    })
  }

  // players taken off the do-not-draft list
  const avoidCount = drafts.reduce((s, d) => s + d.review.preference.avoidsTaken.length, 0)
  if (avoidCount > 0) {
    const who = drafts.flatMap((d) => d.review.preference.avoidsTaken.map((a) => a.name))
    playbook.push({
      id: 'avoids',
      action: 'Turn on HIDE AVOIDS and see whether you miss them',
      when: 'At the start of the next mock',
      because: `You drafted ${avoidCount} player${avoidCount === 1 ? '' : 's'} off your own do-not-draft list: ${[...new Set(who)].slice(0, 3).join(', ')}.`,
      check: 'If the draft feels no worse without them, prune the list. If you miss one, that name does not belong on it.',
      worth: 0.5,
      strength: strengthOf(n),
    })
  }

  playbook.sort((a, b) => b.worth - a.worth)
  playbook.splice(3)

  const avgGainAll = drafts.length
    ? drafts.reduce((s, d) => s + (d.review.counterfactual?.gain ?? 0), 0) / drafts.length
    : 0
  const worstRoundEntry = [...costByRound].sort((a, b) => b.avgCost - a.avgCost)[0]
  const headline =
    totalCost < n
      ? `Across ${n} draft${n === 1 ? '' : 's'} you have taken close to the best available fit almost every time.`
      : `Across ${n} draft${n === 1 ? '' : 's'} you have left about ${r2(avgGainAll)} of starting-lineup value on the board per draft, concentrated in round ${worstRoundEntry?.round ?? '?'}.`

  const counterfactual = drafts
    .filter((d) => d.review.counterfactual)
    .map((d) => ({
      label: d.label,
      actual: d.review.counterfactual.actualValue,
      ideal: d.review.counterfactual.totalValue,
      gain: d.review.counterfactual.gain,
    }))

  const avgGain = counterfactual.length
    ? counterfactual.reduce((s, c) => s + c.gain, 0) / counterfactual.length
    : 0
  if (avgGain > 1) {
    tendencies.push({
      id: 'counterfactual',
      headline: `Following the board would have gained ${avgGain.toFixed(1)} a draft`,
      detail: `Taking the best available that fitted the roster every time would have produced a stronger starting lineup in ${counterfactual.filter((c) => c.gain > 0).length} of ${counterfactual.length} drafts. Other teams are held fixed, so this is a floor on the difference rather than a simulation of the alternate draft.`,
      drafts: counterfactual.length,
      strength: strengthOf(counterfactual.length),
      tryNext:
        'Next mock, take the top verdict card every time from rounds 1 to 6 even where you disagree, and compare the counterfactual gain afterwards.',
    })
  }

  return {
    playbook,
    headline,
    drafts: n,
    picks: allPicks.length,
    avgCost: allPicks.length ? r2(totalCost / n) : 0,
    tendencies: tendencies.sort((a, b) => rankStrength(b) - rankStrength(a)),
    costByRound,
    counterfactual,
    openerCost,
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
