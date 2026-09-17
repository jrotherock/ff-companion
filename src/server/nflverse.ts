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
import { statePath } from './paths.js'
import { splitCsvLine } from './nflverseCsv.js'
import {
  bodyOf, designationOf, loadPlayRates, playRate, posGroupOf, practiceOf, severityOfRate,
  type PlayRates, type Rate,
} from './playRates.js'

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download'
const CACHE = statePath('nflverse-injuries.json')
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
  /**
   * How often players with this report have played, measured, with the count
   * behind it. Null where nothing has been measured.
   */
  rate: Rate | null
  /**
   * The club has not set game statuses for this week yet, so the report is a
   * practice log and nothing more. Read off the report itself: game statuses
   * are published for a whole club at once, so a club with any player carrying
   * one has finished its report. On the Thursday of week two that was Buffalo
   * and Detroit, who play that night, and nobody else.
   */
  pending: boolean
}

/*
 * The version rides in the cache because the rows changed shape: a report
 * cached before rates existed would otherwise be served for six hours with
 * every rate missing, which looks like nothing having been measured.
 */
interface Cache { v: 2; at: number; season: number; rows: Practice[] }

/**
 * The report as rows. Split on commas that are not inside quotes: the file
 * spells one linebacker "Kenneth Murray, Jr.", and a bare split moved every
 * column after his name one to the right — his practice status read from the
 * injury, his injury from the column beside it.
 */
export function csv(text: string): { head: string[]; rows: string[][] } {
  const lines = text.split('\n').filter((l) => l.trim())
  return { head: splitCsvLine(lines[0]), rows: lines.slice(1).map(splitCsvLine) }
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

/**
 * Each player's latest report, with its rate.
 *
 * Pure, so the parts that went wrong can be tested without a network: the
 * quoted name, the injury that only the practice column had named yet, and a
 * report read as final before the club had finished it.
 */
export function reportFrom(text: string, index: PlayerIndex, rates: PlayRates | null): Practice[] {
  const { head, rows } = csv(text)
  const at = (n: string) => head.indexOf(n)
  const iName = at('full_name'), iTeam = at('team'), iWeek = at('week'), iPos = at('position')
  const iRep = at('report_status'), iPrac = at('practice_status')
  const iInj = at('report_primary_injury'), iPracInj = at('practice_primary_injury')

  const finished = new Set<string>()
  for (const r of rows) if ((r[iRep] ?? '').trim()) finished.add(`${r[iTeam]}|${r[iWeek]}`)

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
    // Until the game status is set, only the practice column names the injury.
    const injury = ((r[iInj] ?? '').trim() || (r[iPracInj] ?? '').trim())
    const pending = !finished.has(`${r[iTeam]}|${r[iWeek]}`)
    const measured = rates
      ? playRate(rates, {
          designation: pending ? 'pending' : designationOf(report),
          practice: practiceOf(practice),
          pos: posGroupOf(r[iPos]),
          body: bodyOf(injury),
        })
      : null
    const rate = measured && rates?.seasons ? { ...measured, seasons: rates.seasons } : measured
    out.push({
      playerId: hit.id, name: r[iName], team: r[iTeam], week: Number(r[iWeek]) || 0,
      report, practice, injury,
      severity: rate ? severityOfRate(rate.rate) : severityOf(report, practice),
      rate, pending,
    })
  }
  return out
}

/** Only the reports for the week being played. */
export const forWeek = (rows: Practice[], week: number) => rows.filter((r) => r.week === week)

export async function practiceReport(
  index: PlayerIndex,
  season = new Date().getFullYear(),
  /**
   * Read a previous season's file. Only the parser check uses this: a report
   * from last year cannot describe this Sunday, and showing it greyed is still
   * showing it. The app takes the current season or nothing.
   */
  allowPreviousSeason = false,
  /**
   * The week being played. A player's latest report used to be his report, so
   * a man listed in week one and healthy in week two carried week one's
   * practice into week two — seventy-six of them in the cache on the Thursday
   * this was found, none on our rosters that day and every one a stale warning
   * waiting to be shown. Omitted, every player's latest report is returned.
   */
  week?: number,
): Promise<{ rows: Practice[]; season: number; note: string }> {
  const thisWeek = (rows: Practice[]) => (week == null ? rows : forWeek(rows, week))
  if (existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, 'utf8')) as Cache
      const usable = c.v === 2 && (allowPreviousSeason || c.season === season)
      if (usable && Date.now() - c.at < MAX_AGE) {
        return { rows: thisWeek(c.rows), season: c.season, note: `cached, ${c.season} season` }
      }
    } catch {
      // A torn cache is not worth failing over; fall through and refetch.
    }
  }

  const years = allowPreviousSeason ? [season, season - 1] : [season]
  for (const yr of years) {
    try {
      const res = await fetch(`${BASE}/injuries/injuries_${yr}.csv`, { redirect: 'follow' })
      if (!res.ok) continue
      const out = reportFrom(await res.text(), index, loadPlayRates())

      mkdirSync('fixtures', { recursive: true })
      writeFileSync(CACHE, JSON.stringify({ v: 2, at: Date.now(), season: yr, rows: out } satisfies Cache))
      return {
        rows: thisWeek(out), season: yr,
        note: yr === season
          ? `${yr} season, ${out.length} players on the report`
          : `${yr} — this season's report is not published until games are played`,
      }
    } catch {
      // Try the previous season before giving up entirely.
    }
  }
  return {
    rows: [], season: 0,
    note: `not published yet — the ${season} injury report starts in week one`,
  }
}
