/**
 * Weekly projected points, from Sleeper.
 *
 * The matchup was comparing board value, which is value over replacement and
 * not a score — useful for drafting, meaningless for "am I winning on Sunday".
 * Sleeper publishes real per-week projections and half-PPR is the scoring all
 * four leagues use, so the honest number was available the whole time.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type { PlayerId } from '../kernel/types.js'
import { statePath } from './paths.js'

const CACHE = statePath('projections.json')
const MAX_AGE = 3600000
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DB', 'DL', 'LB']

interface Cache {
  at: number; week: number; season: string
  pts: Record<string, number>
  stats?: Record<string, Record<string, number>>
}

/**
 * Sleeper's projection key → the league scoring key it is paid under. Only the
 * defensive ones: everything on offence is already carried by `pts_half_ppr`.
 */
const IDP_KEYS: [string, string][] = [
  ['idp_tkl_solo', 'idp_tkl_solo'],
  ['idp_tkl_ast', 'idp_tkl_ast'],
  ['idp_sack', 'idp_sack'],
  ['idp_tkl_loss', 'idp_tfl'],
  ['idp_pass_def', 'idp_pass_def'],
  ['idp_int', 'idp_int'],
  ['idp_ff', 'idp_ff'],
  ['idp_fum_rec', 'idp_fum_rec'],
  ['idp_def_td', 'idp_td'],
  ['idp_safety', 'idp_safe'],
  ['idp_blk_kick', 'idp_blk_kick'],
]

/**
 * A defender's week, scored under the league he is in rather than under
 * half-PPR.
 *
 * `pts_half_ppr` pays a solo tackle nothing, so it projected T.J. Watt at 1.01
 * and Jack Campbell at 0.49 — every defender in the eighteen-team IDP league
 * arrived worth about a point, indistinguishable from each other and from a
 * waiver linebacker, and the start/sit optimiser had nothing to work with.
 * The components were in the same payload the whole time; only the total was
 * wrong. Campbell's week one is 16.9 under this league's own settings.
 */
export function scoreIdp(
  stats: Record<string, number> | undefined,
  scoring: Record<string, number> | undefined,
): number | null {
  if (!stats || !scoring) return null
  let total = 0
  let paid = false
  for (const [from, to] of IDP_KEYS) {
    const v = stats[from]
    const w = scoring[to]
    if (typeof v !== 'number' || typeof w !== 'number') continue
    total += v * w
    paid = true
  }
  return paid ? Number(total.toFixed(2)) : null
}

export interface Projections {
  week: number
  season: string
  at: number
  /** Player id → projected half-PPR points for the week. */
  pts: Map<PlayerId, number>
  /** The raw projected components, so a league can score them its own way. */
  stats: Map<PlayerId, Record<string, number>>
}

export async function weeklyProjections(season: string, week: number): Promise<Projections> {
  if (existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, 'utf8')) as Cache
      if (c.week === week && c.season === season && Date.now() - c.at < MAX_AGE) {
        return {
          week, season, at: c.at,
          pts: new Map(Object.entries(c.pts)),
          stats: new Map(Object.entries(c.stats ?? {})),
        }
      }
    } catch {
      // A torn cache is not worth failing over.
    }
  }

  const pts: Record<string, number> = {}
  const stats: Record<string, Record<string, number>> = {}
  const qs = POSITIONS.map((p) => `position[]=${p}`).join('&')
  try {
    const res = await fetch(
      `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&${qs}&order_by=pts_half_ppr`,
      { headers: { 'user-agent': 'Mozilla/5.0 (fantasy companion, personal use)' } },
    )
    if (res.ok) {
      for (const row of (await res.json()) as any[]) {
        const id = row.player_id ?? row.player?.player_id
        if (!id) continue
        const v = row.stats?.pts_half_ppr
        // A projection of zero is a real answer — a player who is not playing.
        if (typeof v === 'number') pts[String(id)] = v
        // Kept whole: a defender's total has to be recomputed per league.
        if (row.stats) stats[String(id)] = row.stats
      }
    }
  } catch {
    // Fall through with whatever was gathered; the caller reports emptiness.
  }

  mkdirSync('fixtures', { recursive: true })
  writeFileSync(CACHE, JSON.stringify({ at: Date.now(), week, season, pts, stats } satisfies Cache))
  return {
    week, season, at: Date.now(),
    pts: new Map(Object.entries(pts)),
    stats: new Map(Object.entries(stats)),
  }
}
