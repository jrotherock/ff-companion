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

export interface Side {
  name: string
  weekRank?: number | null
  role?: number | null
  roleWeeks?: number | null
  weather?: Weather | null
  injuryStatus?: string | null
}

export interface Vote {
  signal: 'consensus' | 'role' | 'weather'
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
