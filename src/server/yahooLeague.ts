/**
 * Everything about a Yahoo league that is not my own team.
 *
 * The browser sensor could read exactly one page — my team — because that is
 * the only Yahoo URL that needs no ids guessed at. Four features were written
 * against data it could never supply and have been dark all season: the trade
 * finder, the opponent's lineup, the transaction feed and the luck split. This
 * is where the API puts what they need.
 *
 * Deliberately a store rather than a client. Nothing above this line knows how
 * Yahoo shapes a response, so the one adapter that does can be written against
 * the real thing once access is granted, rather than guessed at now and found
 * to be wrong in October. Everything reads a snapshot with an honest
 * timestamp, exactly as the roster capture does.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { statePath } from './paths.js'
import type { Move } from './transactions.js'
import type { WeekScores } from './allplay.js'
import type { YSettings, YStanding } from './yahooParse.js'

const STORE = statePath('yahoo-leagues.json')

export interface Squad {
  teamId: string
  manager: string
  /** The team's own name, which is what the league page shows beside the manager's. */
  name?: string
  players: {
    id: string; name: string; pos: string | null; projected: number | null
    /** Yahoo's status code and injury note, as the API gave them: 'D', 'Knee - Meniscus'. */
    status?: string | null; injury?: string | null
  }[]
  /** Who is in a starting slot this week. */
  starters?: string[]
  /** Names Yahoo gave that the player map could not match, kept so a gap can be seen. */
  unmatched?: string[]
}

/** The week in progress: every team's points so far and Yahoo's projection for it. */
export interface Current {
  week: number
  /** When it was read. */
  at: number
  status: string | null
  sides: { teamId: string; name: string; points: number | null; projected: number | null }[]
  pairs: [string, string][]
}

export interface LeagueWide {
  yahooLeagueId: string
  /** When this was read, because a stale league is worse than an absent one. */
  at: number
  myTeamId: string | null
  squads: Squad[]
  transactions: Move[]
  weeks: WeekScores[]
  /** Who played whom, per week, for separating the record from the draw. */
  draw: { week: number; pairs: [string, string][] }[]
  name?: string
  /** A guillotine league has no opponents, so no draw and no luck split. */
  guillotine?: boolean
  teams?: { teamId: string; name: string; manager: string }[]
  standings?: YStanding[]
  current?: Current | null
  settings?: YSettings | null
  /** When each part was last written, since each arrives on its own schedule. */
  partsAt?: Record<string, number>
}

type Store = Record<string, LeagueWide>

export function load(): Store {
  if (!existsSync(STORE)) return {}
  try { return JSON.parse(readFileSync(STORE, 'utf8')) as Store } catch { return {} }
}

function save(s: Store): void {
  mkdirSync(dirname(STORE), { recursive: true })
  writeFileSync(STORE, JSON.stringify(s, null, 1))
}

/**
 * Merged rather than replaced, part by part.
 *
 * The four parts arrive on different schedules — rosters change slowly,
 * transactions constantly, scores weekly — so a poll that fetched one of them
 * must not blank the other three. This is the same rule that stopped an empty
 * roster push reporting a team with nobody on it, applied one level up.
 */
export function record(msg: Partial<LeagueWide> & { yahooLeagueId: string }): LeagueWide {
  const store = load()
  const prev = store[msg.yahooLeagueId]
  const keep = <T,>(next: T[] | undefined, old: T[] | undefined): T[] =>
    next && next.length ? next : (old ?? [])
  const now = Date.now()
  const partsAt = { ...(prev?.partsAt ?? {}) }
  for (const k of ['squads', 'transactions', 'weeks', 'draw', 'standings', 'current', 'settings'] as const) {
    if (msg[k] != null) partsAt[k] = now
  }
  const rec: LeagueWide = {
    yahooLeagueId: msg.yahooLeagueId,
    at: now,
    myTeamId: msg.myTeamId ?? prev?.myTeamId ?? null,
    squads: keep(msg.squads, prev?.squads),
    transactions: keep(msg.transactions, prev?.transactions),
    weeks: keep(msg.weeks, prev?.weeks),
    draw: keep(msg.draw, prev?.draw),
    name: msg.name ?? prev?.name,
    guillotine: msg.guillotine ?? prev?.guillotine,
    teams: keep(msg.teams, prev?.teams),
    standings: keep(msg.standings, prev?.standings),
    current: msg.current ?? prev?.current ?? null,
    settings: msg.settings ?? prev?.settings ?? null,
    partsAt,
  }
  store[msg.yahooLeagueId] = rec
  save(store)
  return rec
}

/**
 * What is known about a league, or nothing.
 *
 * A record with no squads in it is not a league, in the same way an empty
 * roster capture is not a roster: reading one back as "a league where nobody
 * has any players" is a different and much more alarming thing to be told.
 */
export function forLeague(yahooLeagueId: string): LeagueWide | null {
  const rec = load()[yahooLeagueId]
  return rec && (rec.squads.length || rec.transactions.length || rec.weeks.length ||
    rec.standings?.length || rec.current)
    ? rec
    : null
}

/** My squad and everyone else's, the shape the trade finder wants. */
export function squadsFor(
  yahooLeagueId: string,
  myTeamId: string | null,
): { mine: Squad; others: Squad[] } | null {
  const wide = forLeague(yahooLeagueId)
  if (!wide || !wide.squads.length) return null
  const me = myTeamId ?? wide.myTeamId
  const mine = wide.squads.find((s) => s.teamId === me)
  if (!mine) return null
  return { mine, others: wide.squads.filter((s) => s.teamId !== me) }
}

/** Where I stand against the chopping block this week. */
export interface Chop {
  week: number | null
  /** My place among the survivors by live projection, and how many survive. */
  place: number
  of: number
  projected: number | null
  points: number | null
  fromChop: number | null
  cushion: number | null
  onTheBlock: boolean
  bottom: { teamId: string; name: string; manager: string; mine: boolean
            projected: number | null; points: number | null }[]
  faab: number | null
  at: number
}

/**
 * Where I stand against the chopping block, from Yahoo's own standings.
 *
 * A guillotine week is not a game against anybody: the lowest score is cut,
 * so the only margin that means anything is the one over whoever is projected
 * lowest among the others. Yahoo ranks the survivors by live projection and
 * says how far each is from the chop in points so far; this adds the cushion
 * in projection, which is the number that moves as the week plays out.
 *
 * Null for a league the API has not read, where the tile falls back to what
 * the extension captured.
 */
export function chopFor(yahooLeagueId: string): Chop | null {
  const wide = forLeague(yahooLeagueId)
  if (!wide?.guillotine || !wide.standings?.length) return null
  // The chopped have no players left: Yahoo releases them to waivers.
  const alive = new Set(wide.squads.filter((sq) => sq.players.length).map((sq) => sq.teamId))
  const rows = wide.standings
    .filter((r) => !alive.size || alive.has(r.teamId))
    .filter((r) => r.projectedWeek != null)
    .sort((a, b) => (b.projectedWeek ?? 0) - (a.projectedWeek ?? 0))
  const me = rows.find((r) => r.mine)
  if (!me) return null
  const others = rows.filter((r) => !r.mine)
  const lowest = others[others.length - 1] ?? null
  const place = rows.indexOf(me) + 1
  const row = (r: YStanding) => ({
    teamId: r.teamId, name: r.name, manager: r.manager, mine: r.mine,
    projected: r.projectedWeek, points: r.pointsWeek,
  })
  return {
    week: wide.current?.week ?? null,
    place,
    of: rows.length,
    projected: me.projectedWeek,
    points: me.pointsWeek,
    /** Yahoo's figure: points so far, less those of whoever is on the block. */
    fromChop: me.fromChop,
    /** Projected cushion over the lowest of the others; negative means I am the one. */
    cushion: lowest && me.projectedWeek != null && lowest.projectedWeek != null
      ? Number((me.projectedWeek - lowest.projectedWeek).toFixed(2))
      : null,
    onTheBlock: place === rows.length,
    bottom: rows.slice(-3).map(row),
    faab: me.faab,
    at: wide.partsAt?.standings ?? wide.at,
  }
}
