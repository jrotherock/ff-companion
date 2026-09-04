import { readFileSync, readdirSync, existsSync } from 'node:fs'
import type { LeagueConfig } from '../kernel/types.js'

/**
 * Which leagues this instance is for.
 *
 * The engine is the shareable part; which leagues you play in is not. Keeping
 * the configs out of the repository means a fork works — clone it, set your own
 * leagues, and none of mine come with it — and it is also how a hosted instance
 * gets its leagues without committing them to a public repo.
 *
 * Three sources, in order:
 *   LEAGUES_JSON    an array in one environment variable, for hosting
 *   data/leagues/   local files, which is how this runs on my own machine
 *   *.example.json  so a fresh clone starts rather than crashing
 */
export function loadLeagues(dir = 'data/leagues'): {
  leagues: LeagueConfig[]; source: string
} {
  const env = process.env.LEAGUES_JSON?.trim()
  if (env) {
    try {
      const parsed = JSON.parse(env)
      const leagues = Array.isArray(parsed) ? parsed : [parsed]
      return { leagues: leagues as LeagueConfig[], source: 'LEAGUES_JSON' }
    } catch (e) {
      // Loud, not silent: falling back to the examples here would start the
      // app with somebody else's leagues and look like it had worked.
      throw new Error(`LEAGUES_JSON is set but is not valid JSON: ${(e as Error).message}`)
    }
  }

  if (!existsSync(dir)) return { leagues: [], source: 'nothing' }
  const real = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.example.json'))
  const files = real.length
    ? real
    : readdirSync(dir).filter((f) => f.endsWith('.example.json'))
  return {
    leagues: files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as LeagueConfig),
    source: real.length ? dir : `${dir} (examples — copy one and edit it)`,
  }
}
