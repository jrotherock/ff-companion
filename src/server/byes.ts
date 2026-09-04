import { holes, type Hole } from './waivers.js'

/**
 * Which weeks you cannot field a lineup, seen from far enough away to fix it.
 *
 * A bye is the one shortage you can always see coming, and the only one worth
 * spending waiver money on early — by the week itself, everyone else has had
 * the same idea and the replacements are gone.
 */
export interface ByeWeek {
  week: number
  shortfalls: Hole[]
  /** How many of your starters are away that week, shortfall or not. */
  away: number
}

export function byePlan(
  slots: { name: string; eligible: string[] }[],
  squad: {
    id: string; pos: string | null; starter: boolean; injuryStatus: string | null
    projected: number | null; byeWeek?: number | null
  }[],
  fromWeek: number,
  throughWeek = 14,
): ByeWeek[] {
  const out: ByeWeek[] = []
  for (let w = fromWeek; w <= throughWeek; w++) {
    const away = squad.filter((p) => p.byeWeek === w).length
    if (!away) continue
    /*
     * The same test the waiver screen uses, asked about a future week instead
     * of this one. A bye and an injury are the same fact to a lineup: the slot
     * cannot be filled.
     */
    // Every week reaching here has somebody away; the earlier guard saw to it.
    out.push({ week: w, shortfalls: holes(slots, squad, w), away })
  }
  return out
}
