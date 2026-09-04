import type { Alert } from './alerts.js'
import { soonestLock, kickoffAt } from './lock.js'
import { cannotPlay } from './lineup.js'

/**
 * Which facts are worth interrupting you for.
 *
 * Every rule states a fact, a deadline and a consequence — the standard the
 * settings screen already sets. A rule missing any of the three is a note, not
 * an alert, and belongs in the app where you find it in your own time.
 */

export interface Snapshot {
  leagueId: string
  label: string
  /** Waivers, where the league reports them. Null where it does not. */
  waivers?: {
    clearsAt: number | null
    assumedDay: string | null
    budget: number | null
    spent: number | null
    holes: { slot: string; reason: string; severity: number }[]
    targets: { name: string; pos: string | null; fills: string; projected: number | null }[]
  } | null
  /** Opens the league in its own app on iOS, via universal links. */
  link: string | null
  players: {
    id: string; name: string; pos: string | null; starter: boolean
    injuryStatus: string | null; projected: number | null; kickoff: string | null
  }[]
  advice: {
    gain: number
    swaps: { in: { name: string }; out: { name: string } | null; slot: string; gain: number }[]
  } | null
}

/** Three hours: close enough to lock that a questionable tag has become news. */
const NEAR_LOCK = 3 * 60 * 60 * 1000

/**
 * Two thresholds, one set of rules.
 *
 * A timing gate exists to stop a notification arriving on Wednesday about a
 * kickoff on Sunday. It has no business deciding what the league screen shows
 * once you have opened it and are looking — the same distinction already drawn
 * for the alert budget: ration the interruption, never the information.
 *
 * `display` drops the gates and keeps the rules. What gets pushed stays gated.
 */
export function evaluate(
  s: Snapshot,
  now = Date.now(),
  opts: { display?: boolean } = {},
): Alert[] {
  const out: Alert[] = []
  const starters = s.players.filter((p) => p.starter)
  const kicks = Object.fromEntries(
    s.players.filter((p) => p.kickoff).map((p) => [p.id, p.kickoff!]),
  )

  /*
   * A starter who cannot play is the one alert that is never rationed: the slot
   * scores nothing, the fix is free, and it is the single most expensive thing
   * to find out about on Monday.
   */
  for (const p of starters) {
    if (!cannotPlay(p.injuryStatus)) continue
    const lock = p.kickoff ? kickoffAt(p.kickoff, new Date(now)) : null
    out.push({
      id: `${s.leagueId}:out:${p.id}:${p.injuryStatus}`,
      leagueId: s.leagueId,
      rule: 'starter-out',
      headline: `${p.name} is ${(p.injuryStatus ?? 'out').toLowerCase()} — ${s.label}`,
      detail: `He is in your lineup and will not play${
        p.projected ? `, where you had ${p.projected.toFixed(1)} projected` : ''}.`,
      consequence: 90,
      deadline: lock,
      link: s.link,
    })
  }

  /*
   * Points left on the bench, but only once close enough to lock that it is
   * worth acting on — and never for a rounding difference. Scaled by the gap,
   * because a point is not worth a notification and eight are.
   */
  if (s.advice && s.advice.gain >= 3) {
    const lock = soonestLock(starters.map((p) => p.id), kicks, new Date(now))
    const near = lock != null && lock - now < 24 * 60 * 60 * 1000
    if (near || opts.display) {
      const best = s.advice.swaps[0]
      out.push({
        /*
         * Keyed on the move, not the size of it. Rounding the gain into the id
         * meant a projection drifting from 8.4 to 8.6 minted a new identity and
         * pushed the same advice twice, out of a budget of twenty a week.
         */
        id: `${s.leagueId}:lineup:${best?.in.name ?? ''}:${best?.out?.name ?? ''}`,
        leagueId: s.leagueId,
        rule: 'lineup-gain',
        headline: `${s.advice.gain.toFixed(1)} points on your bench — ${s.label}`,
        detail: best
          ? `Start ${best.in.name}${best.out ? ` over ${best.out.name}` : ''} at ${best.slot}.`
          : 'Your bench outprojects your lineup.',
        // A big gap is worth more than a small one, but this never outranks a
        // ruled-out starter: it is an improvement, not a hole.
        consequence: Math.min(70, 40 + s.advice.gain * 2),
        deadline: lock,
        link: s.link,
      })
    }
  }

  /*
   * Questionable is not news on Wednesday — it is news three hours before
   * kickoff, when the beat reporters have filed and you can still act.
   */
  for (const p of starters) {
    if (!p.injuryStatus || cannotPlay(p.injuryStatus)) continue
    if (!/^(Q|QUESTIONABLE|D|DOUBTFUL)$/i.test(p.injuryStatus.trim())) continue
    const lock = p.kickoff ? kickoffAt(p.kickoff, new Date(now)) : null
    const nearLock = lock != null && lock - now <= NEAR_LOCK
    if (!nearLock && !opts.display) continue
    out.push({
      id: `${s.leagueId}:q:${p.id}:${lock ? Math.floor(lock / 3600000) : 'x'}`,
      leagueId: s.leagueId,
      rule: 'starter-questionable',
      headline: `${p.name} is ${p.injuryStatus.toLowerCase()} — ${s.label}`,
      detail: nearLock
        ? 'Kickoff is in under three hours and he is in your lineup.'
        : 'He is in your lineup. Worth a look nearer kickoff.',
      // Only worth waking you for once you can act on it and not before.
      consequence: nearLock ? 50 : 20,
      deadline: lock,
      link: s.link,
    })
  }

  /*
   * Waivers only interrupt you when all three are true: money left, a hole to
   * fix, and somebody available to fix it. A deadline on its own is a calendar
   * reminder, and the calendar already has one.
   */
  const w = s.waivers
  if (w?.clearsAt && w.holes.length && w.targets.length) {
    const left = (w.budget ?? 0) - (w.spent ?? 0)
    const SIX_HOURS = 6 * 60 * 60 * 1000
    const closing = w.clearsAt - now
    if (left > 0 && closing > 0 && (closing < SIX_HOURS || opts.display)) {
      const hole = w.holes[0]
      const pick = w.targets[0]
      out.push({
        id: `${s.leagueId}:waiver:${Math.floor(w.clearsAt / 86400000)}:${hole.slot}`,
        leagueId: s.leagueId,
        rule: 'waivers-closing',
        headline: `Waivers close tonight with $${left} unspent — ${s.label}`,
        detail: `${hole.slot}: ${hole.reason}. ${pick.name} is available${
          pick.projected ? ` and projects ${pick.projected.toFixed(1)}` : ''}.`,
        // Real money and a real hole, but recoverable next week — so it is
        // rationed, unlike a starter who cannot play.
        consequence: Math.min(75, 40 + hole.severity / 3),
        deadline: w.clearsAt,
        link: s.link,
      })
    }
  }

  return out
}
