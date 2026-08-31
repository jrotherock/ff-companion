/**
 * nflverse: the practice report, which is what makes "questionable" mean
 * something.
 *
 * Sleeper gives a game-day designation and nothing else, and in late August
 * fifty-nine ranked players carry Questionable — a label so common it cannot
 * be acted on. The official injury report also records whether a player
 * practised, and that is the part that separates a precaution from a problem:
 * questionable after a full week of practice is noise, questionable having not
 * practised at all is most of the way to out.
 *
 * The 2026 files do not exist until games are played, so this reads whichever
 * season is published and says which one it used rather than failing quietly.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { PlayerIndex } from '../kernel/match.js'
import type { PlayerId } from '../kernel/types.js'

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download'
const CACHE = 'fixtures/nflverse-injuries.json'
const MAX_AGE = 6 * 3600000

export interface Practice {
  playerId: PlayerId
  name: string
  team: string
  week: number
  /** Out, Doubtful, Questionable — the game-day call. */
  report: string
  /** Full, Limited, Did Not Participate — the week that led to it. */
  practice: string
  injury: string
  /** How much the practice week darkens the designation. */
  severity: 'likely-out' | 'coin-flip' | 'likely-plays' | 'unknown'
}

interface Cache { at: number; season: number; rows: Practice[] }

function csv(text: string): { head: string[]; rows: string[][] } {
  const lines = text.split('\n').filter((l) => l.trim())
  return { head: lines[0].split(','), rows: lines.slice(1).map((l) => l.split(',')) }
}

/**
 * A questionable tag means very different things after a full week and after
 * none. This is the whole reason to reach for nflverse at all.
 */
function severityOf(report: string, practice: string): Practice['severity'] {
  const p = practice.toLowerCase()
  if (!p) return 'unknown'
  if (p.startsWith('did not')) return 'likely-out'
  if (p.startsWith('limited')) return 'coin-flip'
  if (p.startsWith('full')) return report.toLowerCase() === 'out' ? 'likely-out' : 'likely-plays'
  return 'unknown'
}

export async function practiceReport(
  index: PlayerIndex,
  season = new Date().getFullYear(),
): Promise<{ rows: Practice[]; season: number; note: string }> {
  if (existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, 'utf8')) as Cache
      if (Date.now() - c.at < MAX_AGE) {
        return { rows: c.rows, season: c.season, note: `cached, ${c.season} season` }
      }
    } catch {
      // A torn cache is not worth failing over; fall through and refetch.
    }
  }

  // This season first, last season as the shape check before week one.
  for (const yr of [season, season - 1]) {
    try {
      const res = await fetch(`${BASE}/injuries/injuries_${yr}.csv`, { redirect: 'follow' })
      if (!res.ok) continue
      const { head, rows } = csv(await res.text())
      const at = (n: string) => head.indexOf(n)
      const iName = at('full_name'), iTeam = at('team'), iWeek = at('week')
      const iRep = at('report_status'), iPrac = at('practice_status')
      const iInj = at('report_primary_injury')

      // Latest week per player: an injury report is a running story, and only
      // the most recent chapter bears on Sunday.
      const latest = new Map<string, string[]>()
      for (const r of rows) {
        const key = `${r[iName]}|${r[iTeam]}`
        const prev = latest.get(key)
        if (!prev || Number(r[iWeek]) >= Number(prev[iWeek])) latest.set(key, r)
      }

      const out: Practice[] = []
      for (const r of latest.values()) {
        const hit = index.resolve({ name: r[iName], team: r[iTeam] })
        if (!hit) continue
        const report = (r[iRep] ?? '').trim()
        const practice = (r[iPrac] ?? '').trim()
        if (!report && !practice) continue
        out.push({
          playerId: hit.id, name: r[iName], team: r[iTeam], week: Number(r[iWeek]) || 0,
          report, practice, injury: (r[iInj] ?? '').trim(),
          severity: severityOf(report, practice),
        })
      }

      mkdirSync('fixtures', { recursive: true })
      writeFileSync(CACHE, JSON.stringify({ at: Date.now(), season: yr, rows: out } satisfies Cache))
      return {
        rows: out, season: yr,
        note: yr === season
          ? `${yr} season, ${out.length} players on the report`
          : `${yr} — this season's report is not published until games are played`,
      }
    } catch {
      // Try the previous season before giving up entirely.
    }
  }
  return { rows: [], season: 0, note: 'nflverse injury report unavailable' }
}
