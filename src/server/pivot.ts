/**
 * What to do about a questionable starter before you know whether he plays.
 *
 * Clubs name their inactives ninety minutes before kickoff, and that is when
 * a questionable player stops being a question. Whether you can still act on
 * the answer depends on who is left: a replacement whose game has already
 * started cannot be brought in. Ladd McConkey plays at 4:05 on a Sunday, so
 * his status is known at 2:35 — after every one-o'clock game has locked.
 *
 * So the plan is one of four, and none of it is a medical opinion:
 *
 *   covered       someone at his position is still unlocked when the news comes
 *   use-flex      only flex-eligible players are, and he can sit in the flex —
 *                 so if he is out, any of them can take his place from there
 *   decide-early  every replacement has locked by then; decide before the last
 *                 one kicks off
 *   no-cover      nobody on the bench could replace him at all
 *
 * The current slot of each starter is not known for Yahoo leagues — the sensor
 * reads who starts, not where — so "can he sit in the flex" is asked of the
 * lineup as a whole: with him in the flex, can everyone else still be placed?
 */
import { cannotPlay, type Slot } from './lineup.js'

/** Inactives are named this long before kickoff. */
export const INACTIVES_BEFORE = 90 * 60_000

export interface PivotMan {
  id: string
  name: string
  pos: string | null
  projected: number | null
  injuryStatus: string | null
  starter: boolean
  /** Kickoff of his game in ms, or null where the schedule does not say. */
  kickoff: number | null
}

export interface Cover {
  id: string
  name: string
  pos: string | null
  projected: number | null
  kickoff: number
}

export interface Pivot {
  playerId: string
  name: string
  kickoff: number
  inactivesAt: number
  plan: 'covered' | 'use-flex' | 'decide-early' | 'no-cover'
  /** At his position, still unlocked when his status is known. */
  direct: Cover[]
  /** Able to replace him only from a flex, still unlocked then. */
  viaFlex: Cover[]
  /** The flex he can be moved into with the rest of the lineup still legal. */
  flex: string | null
  /**
   * For use-flex: the move has to be made before anyone it might shift has
   * kicked off, since a locked player cannot change slots.
   */
  moveBy: number | null
  /** For decide-early: when the last available replacement locks. */
  decideBy: number | null
  /** What he projects, so a replacement can be weighed against him. */
  projected: number | null
  /**
   * Who the decision is actually between, best first.
   *
   * The plan used to say when to decide and never who by — it worked out the
   * candidates to find the deadline and then dropped them, leaving "decide by
   * one o'clock" with nothing to decide about.
   */
  decideAmong: Cover[]
  /**
   * A free agent who projects better than anyone on the bench, where the wire
   * can be seen at all — Sleeper's, and Yahoo's once the API has read every
   * roster. `onWaivers` marks a man dropped inside the waiver period, who is
   * claimed overnight rather than added now.
   */
  pickup?: (Cover & { onWaivers?: boolean }) | null
}

const QUESTIONABLE = /^(Q|QUESTIONABLE)$/i
const fits = (slot: Slot, pos: string | null) =>
  !!pos && slot.eligible.some((e) => e.toUpperCase() === pos.toUpperCase())
const unlockedAt = (m: PivotMan, t: number) => m.kickoff == null || m.kickoff > t
const cover = (m: PivotMan): Cover => ({
  id: m.id, name: m.name, pos: m.pos, projected: m.projected, kickoff: m.kickoff ?? Number.POSITIVE_INFINITY,
})
const byProjection = (a: PivotMan, b: PivotMan) => (b.projected ?? 0) - (a.projected ?? 0)

/**
 * Whether every other starter can still be placed with `him` in `flex`.
 *
 * Narrowest slot first, as the optimiser fills a lineup: a dedicated slot
 * takes the one position it accepts, and what is left goes to the flexes.
 * A starter whose game has begun is fixed where he is, and since where that
 * is cannot be seen, a rearrangement that might need to move him is refused
 * rather than guessed at.
 */
function canSitIn(flex: number, him: PivotMan, slots: Slot[], starters: PivotMan[], now: number): boolean {
  const others = starters.filter((s) => s.id !== him.id)
  if (others.some((o) => fits(slots[flex], o.pos) && !unlockedAt(o, now))) return false
  const open = slots.map((s, i) => ({ s, i })).filter(({ i }) => i !== flex)
    .sort((a, b) => a.s.eligible.length - b.s.eligible.length)
  const placed = new Set<string>()
  for (const { s } of open) {
    const pick = others.find((o) => !placed.has(o.id) && fits(s, o.pos))
    if (pick) placed.add(pick.id)
  }
  return placed.size === others.length
}

export function pivotPlans(slots: Slot[], squad: PivotMan[], now: number): Pivot[] {
  const starters = squad.filter((m) => m.starter)
  const bench = squad.filter((m) => !m.starter && !cannotPlay(m.injuryStatus))
  const out: Pivot[] = []

  for (const him of starters) {
    if (!him.injuryStatus || !QUESTIONABLE.test(him.injuryStatus.trim())) continue
    // Once his game has begun there is no plan left to make.
    if (him.kickoff == null || him.kickoff <= now) continue
    const inactivesAt = him.kickoff - INACTIVES_BEFORE

    const flexes = slots.map((s, i) => ({ s, i }))
      .filter(({ s }) => s.eligible.length > 1 && fits(s, him.pos))
    const usable = flexes.find(({ i }) => canSitIn(i, him, slots, starters, now)) ?? null

    const samePos = bench.filter((b) => b.pos && him.pos && b.pos.toUpperCase() === him.pos.toUpperCase())
    const flexOnly = usable
      ? bench.filter((b) => !samePos.includes(b) && fits(usable.s, b.pos))
      : []

    const direct = samePos.filter((b) => unlockedAt(b, inactivesAt)).sort(byProjection)
    const viaFlex = flexOnly.filter((b) => unlockedAt(b, inactivesAt)).sort(byProjection)

    let plan: Pivot['plan']
    let decideBy: number | null = null
    // Everyone who could replace him and has not kicked off yet.
    const stillOpen = [...samePos, ...flexOnly].filter((b) => unlockedAt(b, now) && b.kickoff != null)
    if (direct.length) plan = 'covered'
    else if (viaFlex.length) plan = 'use-flex'
    else if (stillOpen.length) {
      // All of them lock before his news: the last to kick off is the last
      // moment the decision can still be made.
      plan = 'decide-early'
      decideBy = Math.max(...stillOpen.map((b) => b.kickoff!))
    } else plan = 'no-cover'

    const moveBy = plan === 'use-flex' && usable
      ? Math.min(him.kickoff, ...starters
          .filter((o) => o.id !== him.id && o.kickoff != null && fits(usable.s, o.pos))
          .map((o) => o.kickoff!))
      : null

    out.push({
      playerId: him.id, name: him.name, kickoff: him.kickoff, inactivesAt, plan,
      direct: direct.slice(0, 3).map(cover),
      viaFlex: viaFlex.slice(0, 3).map(cover),
      flex: plan === 'use-flex' && usable ? usable.s.name : null,
      moveBy,
      decideBy,
      projected: him.projected,
      decideAmong: [...stillOpen].sort(byProjection).slice(0, 3).map(cover),
    })
  }
  return out
}
