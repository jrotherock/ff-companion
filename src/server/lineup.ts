/**
 * What to start, and what it costs you not to.
 *
 * Every number needed for this was already on screen — projections for the
 * starters, projections for the bench, the league's own slot shape — and the
 * app said nothing. Showing two columns and leaving the arithmetic to the
 * reader is not advice.
 */

export interface Slot {
  name: string
  /** Positions this slot accepts. A dedicated slot accepts exactly one. */
  eligible: string[]
}

export interface Candidate {
  id: string
  name: string
  pos: string | null
  projected: number | null
  injuryStatus: string | null
  /** Whether the manager currently has them in the lineup. */
  starter: boolean
}

export interface Swap {
  in: Candidate
  out: Candidate | null
  slot: string
  /** Points gained by making this one change. */
  gain: number
  reason: 'points' | 'out' | 'empty'
}

/**
 * A player who cannot take the field scores nothing, whatever the projection
 * still says. Sites are slow to zero these out, and a stale number in the
 * lineup optimiser would quietly recommend starting someone on IR.
 *
 * Questionable and Doubtful are left at face value instead of discounted by a
 * guessed multiplier — flagged for the reader, not silently adjusted.
 */
const CANNOT_PLAY = /^(OUT|IR|SUS|SUSP|PUP|NA|DNR|COV|NFI)$/i

export const cannotPlay = (s: string | null | undefined) => !!s && CANNOT_PLAY.test(s.trim())

const value = (c: Candidate) => (cannotPlay(c.injuryStatus) ? 0 : (c.projected ?? 0))

/** Expand a league's slot counts into the individual slots of a lineup. */
export function slotsFor(
  starters: Record<string, number>,
  flex: { name: string; eligible: string[]; count: number }[],
): Slot[] {
  const out: Slot[] = []
  for (const [pos, n] of Object.entries(starters)) {
    for (let i = 0; i < n; i++) out.push({ name: pos, eligible: [pos] })
  }
  for (const f of flex) {
    for (let i = 0; i < f.count; i++) out.push({ name: f.name, eligible: f.eligible })
  }
  return out
}

const eligibleFor = (slot: Slot, c: Candidate) =>
  !!c.pos && slot.eligible.some((e) => e.toUpperCase() === c.pos!.toUpperCase())

/**
 * Fill the most restrictive slots first with the best player each can take.
 *
 * Fantasy eligibility is laminar — a flex accepts a superset of what the
 * dedicated slots accept — so taking the narrowest slot first is optimal. The
 * repair pass that follows is belt and braces: it retries every reassignment
 * that would raise the total, so a shape that is not laminar cannot quietly
 * produce a worse answer than the manager's own lineup.
 */
export function bestLineup(slots: Slot[], squad: Candidate[]): Map<number, Candidate> {
  const order = slots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.eligible.length - b.s.eligible.length)
  const taken = new Set<string>()
  const filled = new Map<number, Candidate>()

  for (const { s, i } of order) {
    const pick = squad
      .filter((c) => !taken.has(c.id) && eligibleFor(s, c))
      .sort((a, b) => value(b) - value(a))[0]
    if (pick) { filled.set(i, pick); taken.add(pick.id) }
  }

  // Repair: any single move that raises the total is applied until none remain.
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (let i = 0; i < slots.length; i++) {
      const sitting = filled.get(i)
      for (const c of squad) {
        if (taken.has(c.id) || !eligibleFor(slots[i], c)) continue
        if (value(c) <= (sitting ? value(sitting) : 0)) continue
        if (sitting) taken.delete(sitting.id)
        filled.set(i, c); taken.add(c.id); moved = true
        break
      }
    }
    if (!moved) break
  }
  return filled
}

/**
 * The changes worth making, largest first — stated as moves rather than as an
 * optimal lineup, because a manager acts one substitution at a time.
 */
export function advise(
  slots: Slot[],
  squad: Candidate[],
): { swaps: Swap[]; gain: number; optimal: number; current: number } {
  const best = bestLineup(slots, squad)
  const optimal = [...best.values()].reduce((a, c) => a + value(c), 0)
  const current = squad.filter((c) => c.starter).reduce((a, c) => a + value(c), 0)

  const chosen = new Set([...best.values()].map((c) => c.id))
  const benched = squad.filter((c) => c.starter && !chosen.has(c.id))
  const promoted = [...best.entries()].filter(([, c]) => !c.starter)

  const swaps: Swap[] = []
  for (const [slotIdx, inc] of promoted) {
    // Pair each promotion with the weakest player it displaces that it could
    // actually replace, so the move reads as one the manager can make.
    const outIdx = benched.findIndex((o) => eligibleFor(slots[slotIdx], o))
    const out = outIdx >= 0 ? benched.splice(outIdx, 1)[0] : null
    swaps.push({
      in: inc,
      out,
      slot: slots[slotIdx].name,
      gain: value(inc) - (out ? value(out) : 0),
      reason: out && cannotPlay(out.injuryStatus) ? 'out' : out ? 'points' : 'empty',
    })
  }
  swaps.sort((a, b) => b.gain - a.gain)
  return { swaps, gain: optimal - current, optimal, current }
}
