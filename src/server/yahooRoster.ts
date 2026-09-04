/**
 * Yahoo rosters without the Yahoo API.
 *
 * Access was applied for and has not been granted, and the season starts in ten
 * days — so nothing here may depend on it arriving. The browser sensor already
 * reads Yahoo's draft pages; this extends it to the one page that needs no
 * guessing, your own team, captured whenever you happen to visit it.
 *
 * The result is stale-but-real rather than live. That is a worse feed and an
 * honest one: every roster carries the moment it was seen, and the cockpit is
 * already built to show freshness rather than assume it.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { PlayerIndex } from '../kernel/match.js'
import type { Pos, PlayerId } from '../kernel/types.js'

const STORE = 'fixtures/yahoo-rosters.json'

export interface CapturedRoster {
  yahooLeagueId: string
  teamId: string
  at: number
  /** Resolved to canonical ids; names Yahoo gave that we could not match. */
  players: PlayerId[]
  starters: PlayerId[]
  unmatched: string[]
  url: string
  /** Yahoo's own projection per player, where the page printed one. */
  projected?: Record<string, number>
  /** Which page this came from; only the matchup page carries projections. */
  kind?: 'team' | 'matchup'
  /** The other lineup, where the matchup page showed one. */
  teamName?: string | null
  /** Points scored so far this week, empty before kickoff. */
  live?: Record<string, number>
  /** When each player's slot locks, as the page prints it. */
  kickoff?: Record<string, string>
  opponent?: {
    name?: string | null
    live?: Record<string, number>
    players: PlayerId[]
    starters: PlayerId[]
    projected: Record<string, number>
  } | null
}

type Store = Record<string, CapturedRoster>

export function load(): Store {
  if (!existsSync(STORE)) return {}
  try { return JSON.parse(readFileSync(STORE, 'utf8')) as Store } catch { return {} }
}

function save(s: Store): void {
  mkdirSync('fixtures', { recursive: true })
  writeFileSync(STORE, JSON.stringify(s, null, 1))
}

/** Slots Yahoo uses for reserves; everything else is a starting place. */
const BENCH = ['BN', 'IR', 'IR+', 'NA']

type Row = {
  name: string; team?: string | null; pos?: string | null; slot: string
  projected?: number | null; bench?: boolean
  /** Points actually scored. Null until the games start. */
  points?: number | null
  /** Kickoff as the page prints it, e.g. "Sun 1:25 pm", in local time. */
  kickoff?: string | null
}

export function record(
  index: PlayerIndex,
  msg: {
    /** How many starting slots this league has, for pages that omit the slot. */
    startingSlots?: number
    yahooLeagueId: string
    teamId: string
    kind?: 'team' | 'matchup'
    players: Row[]
    /**
     * The matchup page, read directly rather than inferred: both lineups, each
     * row already labelled with its slot and which side it belongs to.
     */
    matchup?: {
      mine: Row[]; opponent: Row[]
      teamName?: string | null; opponentName?: string | null
    } | null
    unread?: string[]
    url?: string
  },
): CapturedRoster {
  const KNOWN_POS: Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'DB', 'DL', 'LB']
  const resolveRows = (rows: Row[]) => {
    const ids: PlayerId[] = []
    const start: PlayerId[] = []
    const proj: Record<string, number> = {}
    const live: Record<string, number> = {}
    const kick: Record<string, string> = {}
    const miss: string[] = []
    for (const row of rows) {
      // Yahoo writes DEF where the player map says DST, and names a defence by
      // its city where the map holds the club.
      const raw = row.pos === 'DEF' || row.pos === 'D/ST' ? 'DST' : row.pos
      const pos = raw && (KNOWN_POS as string[]).includes(raw) ? (raw as Pos) : undefined
      let hit =
        pos === 'DST'
          ? index.all().find(
              (p) =>
                p.pos === 'DST' &&
                (p.name === row.name ||
                  p.name.toLowerCase().startsWith(row.name.toLowerCase() + ' ') ||
                  p.name.toLowerCase().endsWith(' ' + row.name.toLowerCase())),
            )
          : undefined
      // Name first, then narrowed by whatever else the page happened to say.
      hit ??=
        index.resolve({ name: row.name, pos, team: row.team ?? undefined }) ??
        index.resolve({ name: row.name, pos }) ??
        index.resolve({ name: row.name }) ??
        index.resolve({ name: row.name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/i, '').trim() }) ??
        undefined
      if (!hit) { miss.push(row.name); continue }
      ids.push(hit.id)
      if (typeof row.projected === 'number') proj[hit.id] = row.projected
      if (typeof row.points === 'number') live[hit.id] = row.points
      if (row.kickoff) kick[hit.id] = row.kickoff
      // The matchup page prints the slot, so bench is stated, not deduced.
      const benched = row.bench ?? BENCH.includes((row.slot ?? '').toUpperCase())
      if (!benched) start.push(hit.id)
    }
    return { ids, start, proj, live, kick, miss }
  }

  /*
   * Where the page states both lineups, take them. Every previous attempt here
   * inferred them — from table order, then from overlap — and the page turns
   * out to mirror the two teams across a shared slot column, so neither
   * inference could have been right. My own bench became the opponent.
   */
  const mine = resolveRows(msg.matchup ? msg.matchup.mine : (msg.players ?? []))
  const opp = msg.matchup ? resolveRows(msg.matchup.opponent) : null

  const players: PlayerId[] = [...mine.ids]
  const projected: Record<string, number> = { ...mine.proj }
  const livePoints: Record<string, number> = { ...mine.live }
  const kickoffs: Record<string, string> = { ...mine.kick }
  const unmatched: string[] = [...(msg.unread ?? []), ...mine.miss]

  /*
   * Only the team page omits the slot, and only there must the split be
   * counted: it lists starters first and the bench after, which is what made
   * all thirteen read as starting and the total come to a hundred and
   * thirty-one against Yahoo's ninety-nine.
   */
  const splitByCount = (ids: PlayerId[], start: PlayerId[]) =>
    start.length === ids.length && msg.startingSlots && ids.length > msg.startingSlots
      ? ids.slice(0, msg.startingSlots)
      : start
  const starters: PlayerId[] = splitByCount(players, mine.start)

  const store = load()
  /*
   * A team-page capture must not wipe projections a matchup capture supplied.
   * The two pages carry different halves of the same picture and arrive
   * whenever you happen to visit them.
   */
  const prev = load()[msg.yahooLeagueId]
  const mergedProjected =
    Object.keys(projected).length ? projected : (prev?.projected ?? {})
  const rec: CapturedRoster = {
    yahooLeagueId: msg.yahooLeagueId,
    teamId: msg.teamId,
    at: Date.now(),
    players, starters, unmatched,
    projected: mergedProjected,
    live: Object.keys(livePoints).length ? livePoints : (prev?.live ?? {}),
    kickoff: Object.keys(kickoffs).length ? kickoffs : (prev?.kickoff ?? {}),
    opponent: opp
      ? {
          players: opp.ids,
          starters: opp.start,
          projected: opp.proj,
          live: opp.live,
          name: msg.matchup?.opponentName ?? null,
        }
      : (prev?.opponent ?? null),
    teamName: msg.matchup?.teamName ?? prev?.teamName ?? null,
    kind: msg.kind ?? 'team',
    url: msg.url ?? '',
  }
  store[msg.yahooLeagueId] = rec
  save(store)
  return rec
}

/** What the cockpit needs: who you hold, and how long ago that was true. */
export function rosterFor(yahooLeagueId: string): CapturedRoster | null {
  return load()[yahooLeagueId] ?? null
}
