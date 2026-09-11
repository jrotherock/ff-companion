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

const STORE = statePath('yahoo-leagues.json')

export interface Squad {
  teamId: string
  manager: string
  players: { id: string; name: string; pos: string | null; projected: number | null }[]
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
  const rec: LeagueWide = {
    yahooLeagueId: msg.yahooLeagueId,
    at: Date.now(),
    myTeamId: msg.myTeamId ?? prev?.myTeamId ?? null,
    squads: keep(msg.squads, prev?.squads),
    transactions: keep(msg.transactions, prev?.transactions),
    weeks: keep(msg.weeks, prev?.weeks),
    draw: keep(msg.draw, prev?.draw),
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
  return rec && (rec.squads.length || rec.transactions.length || rec.weeks.length)
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
