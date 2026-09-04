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

export function evaluate(s: Snapshot, now = Date.now()): Alert[] {
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
    if (near) {
      const best = s.advice.swaps[0]
      out.push({
        id: `${s.leagueId}:lineup:${Math.round(s.advice.gain)}:${best?.in.name ?? ''}`,
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
    if (lock == null || lock - now > NEAR_LOCK) continue
    out.push({
      id: `${s.leagueId}:q:${p.id}:${Math.floor(lock / 3600000)}`,
      leagueId: s.leagueId,
      rule: 'starter-questionable',
      headline: `${p.name} is still ${p.injuryStatus.toLowerCase()} — ${s.label}`,
      detail: `Kickoff is in under three hours and he is in your lineup.`,
      consequence: 50,
      deadline: lock,
      link: s.link,
    })
  }

  return out
}
