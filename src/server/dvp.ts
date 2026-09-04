import { table } from './nflverseCsv.js'

/**
 * Defence versus position: who a player is actually facing.
 *
 * Projections already carry some of this, but they do not say it. "Start him,
 * he is projected higher" and "start him, and note your tight end draws the
 * stingiest defence against tight ends in the league" are different pieces of
 * advice, and only one of them can be argued with.
 */

export interface Allowed {
  team: string
  pos: string
  /** Mean fantasy points conceded to that position, per game. */
  perGame: number
  games: number
  /** 1 is the most generous defence, higher is meaner. */
  rank: number
  of: number
}

const num = (s: string | undefined) => {
  const n = Number.parseFloat((s ?? '').trim())
  return Number.isFinite(n) ? n : null
}

const SCORING = ['QB', 'RB', 'WR', 'TE', 'K']

export async function defenceVsPosition(
  season = new Date().getFullYear(),
): Promise<{ table: Map<string, Allowed>; note: string; season: number }> {
  const t = await table('stats_player', 'stats_player_week', season)
  const out = new Map<string, Allowed>()
  if (!t.table) return { table: out, note: t.note, season }

  const c = t.table
  const [cPos, cOpp, cWeek, cPts, cType] =
    ['position', 'opponent_team', 'week', 'fantasy_points_ppr', 'season_type'].map(c.col)

  // Sum per defence and position, and count the distinct weeks, so a position
  // with three starters in a game is not read as three games.
  const totals = new Map<string, { pts: number; weeks: Set<number> }>()
  for (const r of c.rows) {
    if (cType >= 0 && r[cType] && r[cType] !== 'REG') continue
    const pos = (r[cPos] ?? '').trim().toUpperCase()
    const opp = (r[cOpp] ?? '').trim().toUpperCase()
    const pts = num(r[cPts])
    const week = num(r[cWeek])
    if (!SCORING.includes(pos) || !opp || pts == null || week == null) continue
    const k = `${opp}|${pos}`
    const hit = totals.get(k) ?? { pts: 0, weeks: new Set<number>() }
    hit.pts += pts
    hit.weeks.add(week)
    totals.set(k, hit)
  }

  for (const pos of SCORING) {
    const forPos = [...totals.entries()]
      .filter(([k]) => k.endsWith(`|${pos}`))
      .map(([k, v]) => ({
        team: k.split('|')[0], pos,
        perGame: v.weeks.size ? v.pts / v.weeks.size : 0,
        games: v.weeks.size,
      }))
      // Most generous first, so rank 1 is the defence you want to face.
      .sort((a, b) => b.perGame - a.perGame)
    forPos.forEach((row, i) => {
      out.set(`${row.team}|${pos}`, { ...row, rank: i + 1, of: forPos.length })
    })
  }
  return { table: out, note: t.note, season }
}

/**
 * How a matchup reads in a sentence, or nothing when there is no basis for one.
 * Silence is correct before any games are played; an invented adjective is not.
 */
export function describe(a: Allowed | undefined): string | null {
  if (!a || a.games < 2) return null
  const third = a.of / 3
  if (a.rank <= third) return `a soft matchup — ${a.team} concede the ${ordinal(a.rank)} most to ${a.pos}s`
  if (a.rank > a.of - third) return `a hard matchup — ${a.team} concede the ${ordinal(a.of - a.rank + 1)} least to ${a.pos}s`
  return null
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}
