import { table } from './nflverseCsv.js'

/**
 * Who each club plays, and when.
 *
 * Unlike the statistics files, the schedule is published before a ball is
 * kicked — so this works in week one, which is exactly when a matchup note is
 * the only thing there is to say about a player.
 */

export interface Game {
  week: number
  home: string
  away: string
  kickoff: string
}

/** nflverse writes a few clubs differently from the platforms. */
const ALIAS: Record<string, string> = {
  LA: 'LAR', LAR: 'LAR', LAC: 'LAC', LV: 'LV', OAK: 'LV',
  JAC: 'JAX', JAX: 'JAX', WAS: 'WAS', WSH: 'WAS', ARZ: 'ARI', ARI: 'ARI',
  BLT: 'BAL', BAL: 'BAL', CLV: 'CLE', CLE: 'CLE', HST: 'HOU', HOU: 'HOU',
  SL: 'LAR', SD: 'LAC', STL: 'LAR',
}
export const club = (t: string) => ALIAS[t.trim().toUpperCase()] ?? t.trim().toUpperCase()

export async function weekGames(
  season: number,
  week: number,
): Promise<{ games: Game[]; note: string }> {
  // One file holds every season, so it is filtered rather than fetched per year.
  const t = await table('schedules', 'games', season)
  if (!t.table) {
    // The combined file has no season suffix; fall back to the plain name.
    const all = await table('schedules', 'games', 0)
    if (!all.table) return { games: [], note: t.note }
    return { games: rowsFor(all.table, season, week), note: 'fetched' }
  }
  return { games: rowsFor(t.table, season, week), note: t.note }
}

function rowsFor(t: NonNullable<Awaited<ReturnType<typeof table>>['table']>,
                 season: number, week: number): Game[] {
  const [cSeason, cType, cWeek, cAway, cHome, cDay, cTime] =
    ['season', 'game_type', 'week', 'away_team', 'home_team', 'gameday', 'gametime'].map(t.col)
  return t.rows
    .filter((r) =>
      Number(r[cSeason]) === season &&
      Number(r[cWeek]) === week &&
      (cType < 0 || r[cType] === 'REG'))
    .map((r) => ({
      week, home: club(r[cHome]), away: club(r[cAway]),
      kickoff: `${r[cDay] ?? ''} ${r[cTime] ?? ''}`.trim(),
    }))
}

/** Which club each team faces this week, both directions. */
export function opponents(games: Game[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const g of games) { m.set(g.home, g.away); m.set(g.away, g.home) }
  return m
}
