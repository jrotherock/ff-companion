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
  opponent?: {
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

export function record(
  index: PlayerIndex,
  msg: {
    /** How many starting slots this league has, for pages that omit the slot. */
    startingSlots?: number
    yahooLeagueId: string
    teamId: string
    kind?: 'team' | 'matchup'
    players: {
      name: string; team?: string | null; pos?: string | null; slot: string
      projected?: number | null; side?: number
    }[]
    unread?: string[]
    url?: string
  },
): CapturedRoster {
  /*
   * The matchup page carries two lineups. Which one is yours is decided by
   * overlap with what the team page already captured, rather than by assuming
   * the left column — a guess that would be wrong half the time and silently.
   */
  const known = new Set<PlayerId>(load()[msg.yahooLeagueId]?.players ?? [])
  const sides = new Map<number, typeof msg.players>()
  for (const row of msg.players ?? []) {
    const k = row.side ?? 0
    const list = sides.get(k) ?? []
    list.push(row)
    sides.set(k, list)
  }

  const KNOWN_POS: Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'DB', 'DL', 'LB']
  const resolveSide = (rows: typeof msg.players) => {
    const ids: PlayerId[] = []
    const start: PlayerId[] = []
    const proj: Record<string, number> = {}
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
      if (!BENCH.includes((row.slot ?? '').toUpperCase())) start.push(hit.id)
    }
    return { ids, start, proj, miss }
  }

  const players: PlayerId[] = []
  const starters: PlayerId[] = []
  const projected: Record<string, number> = {}
  const unmatched: string[] = [...(msg.unread ?? [])]

  /*
   * Two lineups where the page showed two, and yours is whichever overlaps
   * what was already known — not whichever came first.
   */
  const resolved = [...sides.entries()].map(([side, rows]) => ({ side, ...resolveSide(rows) }))
  const mineIdx = resolved.length < 2
    ? 0
    : resolved
        .map((r, i) => ({ i, hits: r.ids.filter((id) => known.has(id)).length }))
        .sort((a, b) => b.hits - a.hits)[0].i

  /*
   * A second table is not a second team. On this page the split fell between
   * my starters and my own bench, and the bench was presented as the opponent's
   * lineup — a fabricated matchup, which is worse than no matchup at all.
   *
   * A side only counts as an opponent when it shares nothing with the roster
   * already known, and holds enough players to be a lineup rather than a bench.
   */
  const mineSide = resolved[mineIdx] ?? { ids: [], start: [], proj: {}, miss: [] }
  players.push(...mineSide.ids)
  starters.push(...mineSide.start)
  Object.assign(projected, mineSide.proj)
  unmatched.push(...mineSide.miss)

  const oppCandidates = resolved.filter((_, i) => i !== mineIdx)
  const oppSide =
    known.size > 0
      ? oppCandidates.find(
          (r) =>
            r.ids.length >= (msg.startingSlots ?? 9) &&
            r.ids.every((id) => !known.has(id)),
        ) ?? null
      : null

  /*
   * The matchup page lists starters first and the bench after, and does not
   * label the slot the way the team page does — so every player arrived marked
   * as starting and the total came to a hundred and thirty-one against Yahoo's
   * ninety-nine. Where no slot said otherwise, the league's own starting count
   * decides the split, which is exactly where the two totals agree.
   */
  const splitByCount = (ids: PlayerId[], start: PlayerId[]) => {
    if (start.length === ids.length && msg.startingSlots && ids.length > msg.startingSlots) {
      return ids.slice(0, msg.startingSlots)
    }
    return start
  }
  starters.length = 0
  starters.push(...splitByCount(players, mineSide.start))

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
    opponent: oppSide
      ? {
          players: oppSide.ids,
          starters: splitByCount(oppSide.ids, oppSide.start),
          projected: oppSide.proj,
        }
      : (prev?.opponent ?? null),
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
