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
      projected?: number | null
    }[]
    unread?: string[]
    url?: string
  },
): CapturedRoster {
  const players: PlayerId[] = []
  const starters: PlayerId[] = []
  const projected: Record<string, number> = {}
  const unmatched: string[] = [...(msg.unread ?? [])]

  for (const row of msg.players ?? []) {
    // Yahoo writes DEF where the player map says DST.
    const raw = row.pos === 'DEF' || row.pos === 'D/ST' ? 'DST' : row.pos
    const KNOWN: Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'DB', 'DL', 'LB']
    const pos = raw && (KNOWN as string[]).includes(raw) ? (raw as Pos) : undefined
    /*
     * Name first, then narrowed by whatever else the page happened to say. A
     * suffix is dropped on the retry because Yahoo writes "James Cook III"
     * where the player map has "James Cook".
     */
    /*
     * Yahoo names a defence by its city — "Minnesota" — where the player map
     * holds the full club name. Tried first so a city cannot collide with a
     * person of the same name.
     */
    if (pos === 'DST') {
      const dst = [...index.all()].find(
        (p) =>
          p.pos === 'DST' &&
          (p.name === row.name ||
            p.name.toLowerCase().startsWith(row.name.toLowerCase() + ' ') ||
            p.name.toLowerCase().endsWith(' ' + row.name.toLowerCase())),
      )
      if (dst) {
        players.push(dst.id)
        if (typeof row.projected === 'number') projected[dst.id] = row.projected
        if (!BENCH.includes((row.slot ?? '').toUpperCase())) starters.push(dst.id)
        continue
      }
    }

    const hit =
      index.resolve({ name: row.name, pos, team: row.team ?? undefined }) ??
      index.resolve({ name: row.name, pos }) ??
      index.resolve({ name: row.name }) ??
      index.resolve({ name: row.name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/i, '').trim() })
    if (!hit) { unmatched.push(row.name); continue }
    players.push(hit.id)
    if (typeof row.projected === 'number') projected[hit.id] = row.projected
    if (!BENCH.includes((row.slot ?? '').toUpperCase())) starters.push(hit.id)
  }

  /*
   * The matchup page lists starters first and the bench after, and does not
   * label the slot the way the team page does — so every player arrived marked
   * as starting and the total came to a hundred and thirty-one against Yahoo's
   * ninety-nine. Where no slot said otherwise, the league's own starting count
   * decides the split, which is exactly where the two totals agree.
   */
  if (starters.length === players.length && msg.startingSlots && players.length > msg.startingSlots) {
    starters.length = 0
    starters.push(...players.slice(0, msg.startingSlots))
  }

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
