import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { statePath } from './paths.js'

/**
 * Fetching and caching an nflverse table.
 *
 * These files are megabytes and change once a week, so they are cached on disk
 * and re-read rather than pulled on every request. Asset names have moved
 * before — weekly player stats live under stats_player, not player_stats — so
 * the caller passes the exact release and file rather than having it guessed.
 */

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download'
const MAX_AGE = 12 * 3600000

/**
 * A CSV line, respecting quotes. These tables run to a hundred and fifty
 * columns and a naive split on commas silently shifts every field after the
 * first quoted one — which would read a target share out of the wrong column
 * and never look wrong enough to notice.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

export interface Table {
  head: string[]
  rows: string[][]
  col: (name: string) => number
}

function parse(text: string): Table {
  const lines = text.split('\n').filter((l) => l.trim())
  const head = splitCsvLine(lines[0])
  const index = new Map(head.map((h, i) => [h.trim(), i]))
  return {
    head,
    rows: lines.slice(1).map(splitCsvLine),
    col: (name) => index.get(name) ?? -1,
  }
}

/**
 * The current season's file, or nothing.
 *
 * Before week one no file exists, and reading last season's would be worse
 * than reading none: it looks like data, and every number would describe a
 * year that has finished.
 */
export async function table(
  release: string,
  file: string,
  season: number,
): Promise<{ table: Table | null; season: number; note: string }> {
  const cache = statePath(`nflverse-${release}-${season}.json`)
  if (existsSync(cache)) {
    try {
      const c = JSON.parse(readFileSync(cache, 'utf8')) as { at: number; text: string }
      if (Date.now() - c.at < MAX_AGE) {
        return { table: parse(c.text), season, note: 'cached' }
      }
    } catch { /* fall through and refetch */ }
  }
  /*
   * Most tables are published one file per season; the schedule is a single
   * file holding every year, and is asked for with season 0.
   */
  const url = season
    ? `${BASE}/${release}/${file}_${season}.csv`
    : `${BASE}/${release}/${file}.csv`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      return {
        table: null, season,
        note: `no ${season} data yet — nflverse publishes it once games are played`,
      }
    }
    const text = await res.text()
    writeFileSync(cache, JSON.stringify({ at: Date.now(), text }))
    return { table: parse(text), season, note: 'fetched' }
  } catch (e) {
    return { table: null, season, note: `could not reach nflverse: ${(e as Error).message}` }
  }
}
