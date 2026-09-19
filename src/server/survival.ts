/**
 * The guillotine's one alert: projected near the bottom, on the morning it
 * can still be fixed.
 *
 * Settings has listed "Guillotine survival risk — projected bottom three,
 * Sunday morning only" since the first cockpit, and nothing behind it could
 * fire: working out a place among the survivors needs every team's
 * projection, and the extension reads one team. The API's standings carry all
 * of them.
 *
 * Sunday morning because that is when there is still something to do — a
 * lineup to set, a waiver to claim — and not the rest of the week, when a
 * bottom-three projection on a Tuesday is noise about a Sunday nobody has
 * seen yet.
 */
import type { Alert } from './alerts.js'
import type { Chop } from './yahooLeague.js'

/** How long before the first Sunday kickoff the morning starts. */
export const MORNING = 6 * 3600_000

const inEastern = (ms: number) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false,
  }).formatToParts(new Date(ms))
  return {
    weekday: parts.find((p) => p.type === 'weekday')?.value ?? '',
    hour: Number(parts.find((p) => p.type === 'hour')?.value ?? NaN),
  }
}

const ordinal = (n: number) =>
  `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`

/**
 * The alert, or nothing.
 *
 * `nextKickoff` is the next game to start anywhere in the league. It has to be
 * a Sunday game in the early afternoon Eastern or before — the first slate —
 * so the Sunday evening wait for the late games is not "morning", and the
 * morning is the six hours before it.
 */
export function survivalAlert(
  chop: Chop | null,
  league: { id: string; label: string },
  link: string | null,
  now: number,
  nextKickoff: number | null,
): Alert | null {
  if (!chop || chop.cushion == null) return null
  if (chop.place <= chop.of - 3) return null
  if (nextKickoff == null || nextKickoff <= now || nextKickoff - now > MORNING) return null
  const et = inEastern(nextKickoff)
  if (et.weekday !== 'Sun' || !(et.hour <= 13)) return null

  const gap = Math.abs(chop.cushion).toFixed(1)
  const next = chop.bottom.filter((r) => !r.mine).slice(-1)[0]
  return {
    id: `guillotine-risk:${league.id}:${chop.week ?? ''}`,
    leagueId: league.id,
    rule: 'guillotine-risk',
    headline: chop.onTheBlock
      ? `${league.label}: you are projected lowest — ${gap} behind the next team`
      : `${league.label}: projected ${ordinal(chop.place)} of ${chop.of}, ${gap} clear of the chop`,
    detail: chop.onTheBlock
      ? `The lowest score this week is cut. ${next ? `${next.name} is next lowest at ${next.projected?.toFixed(1) ?? '—'}. ` : ''}` +
        'Check your lineup and the wire before the first kickoff.'
      : 'The lowest score this week is cut, and you are in the bottom three. Check your lineup and the wire before the first kickoff.',
    // On the block is the one thing in fantasy that ends a season outright.
    consequence: chop.onTheBlock ? 95 : chop.place === chop.of - 1 ? 85 : 75,
    deadline: nextKickoff,
    link,
  }
}
