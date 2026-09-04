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
}

export interface Exposure {
  playerId: string
  name: string
  pos: string | null
  team: string | null
  byeWeek: number | null
  injuryStatus: string | null
  leagues: Holding[]
  /** In how many lineups he is actually starting, which is what a loss costs. */
  startingIn: number
  /** Points riding on him this week across every league at once. */
  projectedAcross: number
}

export interface Squad {
  leagueId: string
  label: string
  players: {
    id: string; name: string; pos: string | null; team: string | null
    byeWeek: number | null; injuryStatus: string | null
    starter: boolean; projected: number | null
  }[]
}

export function exposure(squads: Squad[], minLeagues = 2): Exposure[] {
  const byPlayer = new Map<string, Exposure>()
  for (const s of squads) {
    for (const p of s.players) {
      const hit = byPlayer.get(p.id) ?? {
        playerId: p.id, name: p.name, pos: p.pos, team: p.team,
        byeWeek: p.byeWeek, injuryStatus: p.injuryStatus,
        leagues: [], startingIn: 0, projectedAcross: 0,
      }
      hit.leagues.push({
        leagueId: s.leagueId, label: s.label, starter: p.starter, projected: p.projected,
      })
      if (p.starter) {
        hit.startingIn++
        hit.projectedAcross += p.projected ?? 0
      }
      // A designation seen in any league is true everywhere; the platforms
      // update at different times and the worst-informed one should not win.
      if (!hit.injuryStatus && p.injuryStatus) hit.injuryStatus = p.injuryStatus
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
