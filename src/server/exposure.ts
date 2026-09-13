/**
 * How much of your season rides on one player.
 *
 * You own the same names across four leagues, so one hamstring can hit three
 * teams at once. No commercial tool can tell you this, because none of them
 * sees all four leagues — which is the one thing this app has that they do not.
 */

export interface Holding {
  leagueId: string
  label: string
  starter: boolean
  projected: number | null
  /** What he has scored in this league, under this league's rules. */
  points?: number | null
}

export interface Exposure {
  playerId: string
  name: string
  pos: string | null
  team: string | null
  byeWeek: number | null
  injuryStatus: string | null
  /** The blurb and link the roster rows already carry, kept for the ones that matter. */
  why: { note: string | null; headline: string | null; link: string | null } | null
  /** Whether he practised, which is what makes a designation mean something. */
  practice: string | null
  severity: string | null
  leagues: Holding[]
  /** In how many lineups he is actually starting, which is what a loss costs. */
  startingIn: number
  /** Points riding on him this week across every league at once. */
  projectedAcross: number
  /**
   * Recent news about him that is not an injury designation.
   *
   * The reason attached to a player was only ever looked up when he carried a
   * tag, so a healthy man starting in three leagues could lose his job to a
   * rookie on Wednesday and this section would never say so. For the players
   * who matter in more than one place at once, a role change is exactly as
   * much news as a hamstring.
   */
  news: { headline: string; link: string | null; at: number } | null
  /**
   * How he is doing today, summed across the leagues that start him, each
   * against his own projection there — so a PPR league and a half-PPR one can
   * be added up without pretending their points are the same unit.
   *
   * Null until his game has started.
   */
  live: { got: number; swing: number | null; leagues: number; playing: boolean } | null
}

export interface Squad {
  leagueId: string
  label: string
  players: {
    id: string; name: string; pos: string | null; team: string | null
    byeWeek: number | null; injuryStatus: string | null
    starter: boolean; projected: number | null
    why?: { note: string | null; headline: string | null; link: string | null } | null
    practice?: string | null
    severity?: string | null
    news?: { headline: string; link: string | null; at: number } | null
    /** Live points in this league, where a matchup has been read. */
    points?: number | null
    /** Where his club's game stands. */
    game?: 'pre' | 'playing' | 'done' | null
  }[]
}

/*
 * Worst first. Ordering the tags rather than taking whichever arrived first,
 * because a player can be listed Questionable on a platform that has not caught
 * up and Out on one that has — and the one that has not caught up is the one
 * that must not be believed.
 */
const severity = (s: string | null | undefined): number => {
  const t = (s ?? '').trim().toUpperCase()
  if (!t) return 0
  if (/^(OUT|O|IR|PUP|NFI|SUS|SUSP|SUSPENDED|NA|COV)$/.test(t)) return 5
  if (/^(D|DOUBTFUL)$/.test(t)) return 4
  if (/^(Q|QUESTIONABLE)$/.test(t)) return 2
  return 1
}

export function exposure(squads: Squad[], minLeagues = 2): Exposure[] {
  const byPlayer = new Map<string, Exposure>()
  for (const s of squads) {
    for (const p of s.players) {
      const hit = byPlayer.get(p.id) ?? {
        playerId: p.id, name: p.name, pos: p.pos, team: p.team,
        byeWeek: p.byeWeek, injuryStatus: null as string | null,
        why: null, practice: null, severity: null, news: null,
        leagues: [], startingIn: 0, projectedAcross: 0, live: null,
      }
      hit.leagues.push({
        leagueId: s.leagueId, label: s.label, starter: p.starter, projected: p.projected,
        points: p.points ?? null,
      })
      if (p.starter) {
        hit.startingIn++
        hit.projectedAcross += p.projected ?? 0
        /*
         * Summed only where his game has started and a real projection exists
         * to measure against — the same rule the tile's movers use, so the two
         * cannot disagree about whether he is having a good day.
         */
        if ((p.game === 'playing' || p.game === 'done') && p.points != null) {
          const l = hit.live ?? { got: 0, swing: 0 as number | null, leagues: 0, playing: false }
          l.got = Number((l.got + p.points).toFixed(2))
          l.leagues++
          l.playing = l.playing || p.game === 'playing'
          if (l.swing != null && p.projected != null && p.projected > 0) {
            l.swing = Number((l.swing + (p.points - p.projected)).toFixed(2))
          } else {
            // One league with no baseline poisons the sum rather than being
            // silently skipped, which would under-report the swing.
            l.swing = null
          }
          hit.live = l
        }
      }
      /*
       * A designation seen in any league is true everywhere, and the worst one
       * wins. This said as much in a comment for a season while taking
       * whichever league happened to be read first — so a man Out in one
       * league and Questionable in the next showed as Questionable.
       */
      if (severity(p.injuryStatus) > severity(hit.injuryStatus)) hit.injuryStatus = p.injuryStatus
      if (!hit.news && p.news) hit.news = p.news
      /*
       * The reason, not just the tag. When three teams ride on one man, "Q" is
       * not enough — whether he practised, and what was written about him, is
       * the whole difference between a precaution and a lost week.
       */
      if (!hit.why && p.why?.headline) hit.why = p.why
      if (!hit.practice && p.practice) { hit.practice = p.practice; hit.severity = p.severity ?? null }
      byPlayer.set(p.id, hit)
    }
  }
  return [...byPlayer.values()]
    .filter((e) => e.leagues.length >= minLeagues)
    .sort((a, b) =>
      b.startingIn - a.startingIn ||
      b.projectedAcross - a.projectedAcross ||
      b.leagues.length - a.leagues.length)
}

/**
 * The players whose loss would be felt in more than one place at once, which is
 * the only reason to look at this list on a Sunday morning.
 */
export function atRisk(all: Exposure[]): Exposure[] {
  const HURT = /^(OUT|IR|SUS|D|DOUBTFUL|Q|QUESTIONABLE|PUP|NA)$/i
  return all.filter((e) => e.startingIn >= 2 && e.injuryStatus && HURT.test(e.injuryStatus.trim()))
}
