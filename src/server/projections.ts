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

interface Cache { at: number; week: number; season: string; pts: Record<string, number> }

export interface Projections {
  week: number
  season: string
  at: number
  /** Player id → projected half-PPR points for the week. */
  pts: Map<PlayerId, number>
}

export async function weeklyProjections(season: string, week: number): Promise<Projections> {
  if (existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, 'utf8')) as Cache
      if (c.week === week && c.season === season && Date.now() - c.at < MAX_AGE) {
        return { week, season, at: c.at, pts: new Map(Object.entries(c.pts)) }
      }
    } catch {
      // A torn cache is not worth failing over.
    }
  }

  const pts: Record<string, number> = {}
  const qs = POSITIONS.map((p) => `position[]=${p}`).join('&')
  try {
    const res = await fetch(
      `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&${qs}&order_by=pts_half_ppr`,
      { headers: { 'user-agent': 'Mozilla/5.0 (fantasy companion, personal use)' } },
    )
    if (res.ok) {
      for (const row of (await res.json()) as any[]) {
        const id = row.player_id ?? row.player?.player_id
        const v = row.stats?.pts_half_ppr
        // A projection of zero is a real answer — a player who is not playing.
        if (id && typeof v === 'number') pts[String(id)] = v
      }
    }
  } catch {
    // Fall through with whatever was gathered; the caller reports emptiness.
  }

  mkdirSync('fixtures', { recursive: true })
  writeFileSync(CACHE, JSON.stringify({ at: Date.now(), week, season, pts } satisfies Cache))
  return { week, season, at: Date.now(), pts: new Map(Object.entries(pts)) }
}
