/**
 * Where the signals disagree — and only there.
 *
 * The optimiser has to pick one man, so it consults its tiebreaks in order and
 * the first with an opinion wins. That is right for choosing and wrong for
 * explaining: it hides that the consensus and the usage were pointing at
 * different players, which is the one thing about a coin flip worth a manager's
 * attention.
 *
 * The consensus is not a clean second opinion for a man carrying a designation,
 * either. A questionable receiver is ranked low partly because he may not play
 * at all — the ranking answers "will he play and how well", while the question
 * being asked is "if he plays, is he the better start". His usage is measured
 * from games he did play, which is exactly the read that survives the
 * distinction.
 *
 * Silence is the default. Every signal agreeing is not a decision, and one
 * signal alone is the tiebreak doing its job unopposed. Across five real
 * leagues this surfaced one close call out of six.
 */
import { ROLE_GAP } from './lineup.js'

/** A consensus rank within this many places is not an opinion, it is a tie. */
export const RANK_GAP = 5

export interface Weather {
  roof?: string | null
  tempF?: number | null
  windMph?: number | null
  summary?: string | null
}

/**
 * The corner he draws, from RotoBaller's WR/CB chart where it has been read in
 * — a score for every receiver — or failing that the column's handful of
 * named upgrades and downgrades.
 */
export interface Coverage {
  corner: string
  score?: number | null
  side?: 'upgrade' | 'downgrade' | null
}

/*
 * How far apart two receivers' matchup scores must be before the chart has an
 * opinion between them. About one standard deviation: week two's 99 scores
 * spread 5.08 around their mean. Deliberately not set from the one call it was
 * first looked at against — Jalen Coker at -2.00 and Michael Wilson at +2.21
 * sit 4.21 apart, and a threshold moved to catch them would be fitted to them.
 */
export const COVERAGE_GAP = 5

export interface Side {
  name: string
  weekRank?: number | null
  role?: number | null
  roleWeeks?: number | null
  weather?: Weather | null
  injuryStatus?: string | null
  coverage?: Coverage | null
}

export interface Vote {
  signal: 'consensus' | 'role' | 'coverage' | 'weather'
  prefers: string
  why: string
}

export interface Split {
  votes: Vote[]
  /** Why the consensus may be answering a different question than you asked. */
  caveat: string | null
}

/**
 * How much weather is in the way: nothing at all under a roof, otherwise one
 * count for each thing a forecast can do to a passing game.
 */
function against(w: Weather | null | undefined): number | null {
  if (!w || !w.roof) return null
  if (w.roof === 'dome' || w.roof === 'retractable') return 0
  let n = 0
  if ((w.windMph ?? 0) >= 15) n++
  if (w.tempF != null && w.tempF <= 25) n++
  if (w.summary && /rain|snow|shower/i.test(w.summary)) n++
  return n
}

const hurt = (s: string | null | undefined) =>
  !!s && /^(Q|QUESTIONABLE|D|DOUBTFUL)$/i.test(s.trim())

export function disagreement(keep: Side, alt: Side): Split | null {
  const votes: Vote[] = []

  if (keep.weekRank != null && alt.weekRank != null &&
      Math.abs(keep.weekRank - alt.weekRank) >= RANK_GAP) {
    const better = keep.weekRank < alt.weekRank ? keep : alt
    votes.push({
      signal: 'consensus',
      prefers: better.name,
      why: `ranked ${Math.abs(keep.weekRank - alt.weekRank)} places higher this week`,
    })
  }

  if (keep.role != null && alt.role != null && Math.abs(keep.role - alt.role) >= ROLE_GAP) {
    const bigger = keep.role > alt.role ? keep : alt
    const weeks = bigger.roleWeeks ?? 0
    votes.push({
      signal: 'role',
      prefers: bigger.name,
      why: `${Math.round(bigger.role! * 100)}% of his team's touches` +
        (weeks ? ` over ${weeks} week${weeks === 1 ? '' : 's'}` : ''),
    })
  }

  /*
   * The WR/CB column. An upgrade leans towards a man and a downgrade away from
   * him; a man the column never mentioned leans neither way, and that is still
   * a difference — being singled out is the opinion. Two upgrades cancel, as
   * two receivers the column likes equally tell you nothing about which to
   * start.
   */
  const ks = keep.coverage?.score, as = alt.coverage?.score
  const lean = (p: Side) =>
    p.coverage?.side === 'upgrade' ? 1 : p.coverage?.side === 'downgrade' ? -1 : 0
  if (typeof ks === 'number' && typeof as === 'number') {
    // Both on the chart: the scores decide, and a gap inside a standard
    // deviation is no opinion at all.
    if (Math.abs(ks - as) >= COVERAGE_GAP) {
      const favoured = ks > as ? keep : alt
      const other = favoured === keep ? alt : keep
      const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`
      votes.push({
        signal: 'coverage',
        prefers: favoured.name,
        why: `his matchup with ${favoured.coverage!.corner} scores ${signed(favoured.coverage!.score!)}, ` +
          `${other.name}'s with ${other.coverage!.corner} ${signed(other.coverage!.score!)}`,
      })
    }
  } else if (lean(keep) !== lean(alt)) {
    const favoured = lean(keep) > lean(alt) ? keep : alt
    const other = favoured === keep ? alt : keep
    votes.push({
      signal: 'coverage',
      prefers: favoured.name,
      why: favoured.coverage?.side === 'upgrade'
        ? `RotoBaller calls his matchup with ${favoured.coverage.corner} an upgrade`
        : `RotoBaller calls ${other.name}'s matchup with ${other.coverage!.corner} a downgrade`,
    })
  }

  const wk = against(keep.weather), wa = against(alt.weather)
  if (wk != null && wa != null && wk !== wa) {
    const clearer = wk < wa ? keep : alt
    const rough = wk < wa ? alt : keep
    votes.push({
      signal: 'weather',
      prefers: clearer.name,
      why: rough.weather?.roof === 'open'
        ? `${rough.name} plays in the weather${
            rough.weather?.summary ? ` — ${rough.weather.summary.toLowerCase()}` : ''}`
        : `${clearer.name} plays indoors`,
    })
  }

  // Two opinions at least, and they must actually differ.
  if (votes.length < 2 || new Set(votes.map((v) => v.prefers)).size < 2) return null

  const q = [keep, alt].find((p) => hurt(p.injuryStatus))
  return {
    votes,
    caveat: q
      ? `${q.name} is ${(q.injuryStatus ?? '').toLowerCase()}, so his consensus rank is partly ` +
        `a bet on whether he plays at all. His usage is measured from the games he did play.`
      : null,
  }
}
