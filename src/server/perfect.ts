/**
 * What the week would have been if you had known.
 *
 * Both league apps grade a manager on this and neither explains it: Sleeper
 * puts "100.0% avg start & sit accuracy" beside your name on the matchup
 * screen. It is the one number that separates a bad week from a badly managed
 * one — a hundred and nineteen points with nothing better on the bench is a
 * good week; the same score with twenty sitting behind it is not.
 *
 * Graded against the best legal lineup rather than against the highest scorers,
 * because a lineup is slots: two receivers and a flex cannot be filled with
 * four receivers however they scored. The optimiser that fills a lineup by
 * projection fills it the same way by points, so this asks it the question
 * afterwards.
 *
 * It is hindsight, and the app should say so. Nobody could have started the
 * man who scored twenty-eight on four targets; what the number is for is the
 * pattern across a season, and the weeks where the answer was on the bench in
 * plain sight.
 */
import { bestLineup, type Candidate, type Slot } from './lineup.js'

export interface Perfect {
  week: number
  /** What the lineup actually scored. */
  actual: number
  /** What the best legal lineup from the same roster would have scored. */
  perfect: number
  /** The difference, which is what sat on the bench. */
  left: number
  /** actual / perfect, or null where the perfect lineup scored nothing. */
  share: number | null
  /** Who would have played instead, worst miss first. */
  missed: { in: string; out: string; slot: string; gain: number }[]
}

/**
 * One week, graded.
 *
 * `points` is what each man actually scored; anyone the week has no number for
 * counts as nought, which for a finished week is what he scored.
 */
export function perfectWeek(
  week: number,
  slots: Slot[],
  squad: { id: string; name: string; pos: string | null; starter: boolean }[],
  points: (id: string) => number | null,
): Perfect {
  const as = (m: typeof squad[number]): Candidate => ({
    id: m.id, name: m.name, pos: m.pos, projected: points(m.id) ?? 0,
    starter: m.starter, injuryStatus: null,
  })
  const all = squad.map(as)
  const actual = all.filter((c) => c.starter).reduce((a, c) => a + (c.projected ?? 0), 0)

  const best = bestLineup(slots, all)
  const perfect = [...best.values()].reduce((a, c) => a + (c.projected ?? 0), 0)

  /*
   * What the difference was made of. Each slot the best lineup filled with
   * somebody who did not start it, paired with whoever did — which is the
   * form the miss is remembered in: "Warren for Black at the flex, nine
   * points".
   */
  const started = new Set(all.filter((c) => c.starter).map((c) => c.id))
  const kept = new Set([...best.values()].map((c) => c.id))
  const dropped = all.filter((c) => c.starter && !kept.has(c.id))
    .sort((a, b) => (a.projected ?? 0) - (b.projected ?? 0))
  const missed: Perfect['missed'] = []
  for (const [slotIdx, inc] of best.entries()) {
    if (started.has(inc.id)) continue
    const out = dropped.shift()
    missed.push({
      in: inc.name,
      out: out?.name ?? '—',
      slot: slots[slotIdx].name,
      gain: Number(((inc.projected ?? 0) - (out?.projected ?? 0)).toFixed(2)),
    })
  }

  return {
    week,
    actual: Number(actual.toFixed(2)),
    perfect: Number(perfect.toFixed(2)),
    left: Number((perfect - actual).toFixed(2)),
    share: perfect > 0 ? Number((actual / perfect).toFixed(4)) : null,
    missed: missed.sort((a, b) => b.gain - a.gain).slice(0, 3),
  }
}

/** The season so far, and the average of the weeks that have one. */
export function record(weeks: Perfect[]): { weeks: Perfect[]; share: number | null; left: number } {
  const graded = weeks.filter((w) => w.share != null)
  return {
    weeks: [...weeks].sort((a, b) => a.week - b.week),
    share: graded.length
      ? Number((graded.reduce((a, w) => a + (w.share ?? 0), 0) / graded.length).toFixed(4))
      : null,
    left: Number(weeks.reduce((a, w) => a + w.left, 0).toFixed(2)),
  }
}
