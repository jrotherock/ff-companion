/**
 * Where the roster is thin, and who is available to fix it.
 *
 * The notification rule for this already existed — "waivers close with money
 * unspent, and only if a target fits a hole" — with nothing underneath it. A
 * deadline alone is a calendar reminder; the rule only earns an interruption
 * because of the second half.
 */

export interface Hole {
  slot: string
  pos: string[]
  /** Why this is thin, in the manager's terms. */
  reason: string
  /** How badly, 0-100, for ranking against other holes and other alerts. */
  severity: number
}

export interface Target {
  id: string
  name: string
  pos: string | null
  team: string | null
  projected: number | null
  /** Net adds across Sleeper in the last day — interest, not quality. */
  trending: number | null
  fills: string
}

const CANNOT = /^(OUT|IR|SUS|SUSP|PUP|NA|DNR|COV|NFI)$/i

/**
 * A hole is a starting slot that cannot be filled properly, not merely a
 * position you would like to upgrade. Wanting a better running back is not a
 * waiver emergency and must never spend one of twenty notifications.
 */
export function holes(
  slots: { name: string; eligible: string[] }[],
  squad: { id: string; pos: string | null; starter: boolean; injuryStatus: string | null
           projected: number | null; byeWeek?: number | null }[],
  week?: number,
): Hole[] {
  const out: Hole[] = []
  const healthy = (p: typeof squad[0]) =>
    !CANNOT.test(p.injuryStatus ?? '') && !(week != null && p.byeWeek === week)

  for (const slot of slots) {
    const eligible = squad.filter(
      (p) => p.pos && slot.eligible.some((e) => e.toUpperCase() === p.pos!.toUpperCase()),
    )
    const usable = eligible.filter(healthy)
    if (usable.length === 0) {
      out.push({
        slot: slot.name, pos: slot.eligible, severity: 95,
        reason: eligible.length
          ? `nobody who can play — all ${eligible.length} are out or on bye`
          : 'nobody on the roster can fill it',
      })
      continue
    }
    /*
     * Thin only counts when the one body is already doubtful. Carrying a single
     * quarterback in a one-quarterback league is the normal state of almost
     * every roster, and flagging it weekly would be pure noise — the first
     * version of this rule did exactly that.
     */
    if (usable.length === 1 && slot.eligible.length === 1) {
      const only = usable[0]
      if (only.injuryStatus && /^(Q|QUESTIONABLE|D|DOUBTFUL)$/i.test(only.injuryStatus.trim())) {
        out.push({
          slot: slot.name, pos: slot.eligible, severity: 55,
          reason: `your only ${slot.name} is ${only.injuryStatus.toLowerCase()}, with no cover`,
        })
      }
    }
  }
  return out.sort((a, b) => b.severity - a.severity)
}

/** Free agents that fit the holes, best first. Interest breaks ties, never leads. */
export function targets(
  free: { id: string; name: string; pos: string | null; team: string | null }[],
  need: Hole[],
  projected: Map<string, number>,
  trending: Map<string, number>,
  limit = 6,
): Target[] {
  if (!need.length) return []
  const wanted = new Map<string, Hole>()
  for (const h of need) for (const p of h.pos) if (!wanted.has(p)) wanted.set(p, h)

  return free
    .filter((p) => p.pos && wanted.has(p.pos.toUpperCase()))
    .map((p) => ({
      ...p,
      projected: projected.get(p.id) ?? null,
      trending: trending.get(p.id) ?? null,
      fills: wanted.get(p.pos!.toUpperCase())!.slot,
    }))
    .sort((a, b) =>
      // Points first. A player everyone is adding who projects for four is
      // still a player who projects for four.
      (b.projected ?? 0) - (a.projected ?? 0) ||
      (b.trending ?? 0) - (a.trending ?? 0))
    .slice(0, limit)
}

/**
 * When waivers next clear.
 *
 * Sleeper reports the day as a number and its convention is not documented
 * anywhere I can check, so the resolved date is surfaced in the app rather than
 * buried here. An assumption you can see is one you can correct; the same
 * mistake unseen would fire alerts on the wrong evening all season.
 */
export function nextWaiverClear(
  dayOfWeek: number | null | undefined,
  now = new Date(),
  hour = 3,
): { at: number; assumed: string } | null {
  if (dayOfWeek == null) return null
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const day = ((dayOfWeek % 7) + 7) % 7
  const at = new Date(now)
  at.setHours(hour, 0, 0, 0)
  at.setDate(at.getDate() + (((day - at.getDay() + 7) % 7) || (at <= now ? 7 : 0)))
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 7)
  return { at: at.getTime(), assumed: DAYS[day] }
}
