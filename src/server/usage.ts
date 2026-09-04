import { table } from './nflverseCsv.js'

/**
 * Snap share and target share: the role, before the points.
 *
 * A player's share of his team's snaps and targets moves days before his
 * fantasy points do. That is the whole reason to look at it — by the time
 * production has changed, the waiver wire has changed too. It is also a better
 * basis for "rising" than trending adds, which is the market reacting to news
 * that has already broken.
 */

export interface Usage {
  name: string
  team: string
  pos: string
  /** Most recent week first. */
  snapPct: { week: number; pct: number }[]
  targetShare: { week: number; share: number }[]
  /** Change from the average of the earlier weeks to the latest. */
  snapTrend: number | null
  targetTrend: number | null
}

/*
 * Only positions that score. A left tackle's snap share is a perfect signal of
 * nothing, and the first run of this filled the whole rising list with linemen
 * returning from injury at a hundred per cent.
 */
const FANTASY = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DB', 'DL', 'LB', 'S', 'CB', 'DE', 'DT', 'OLB', 'ILB', 'MLB'])

const num = (s: string | undefined) => {
  const n = Number.parseFloat((s ?? '').trim())
  return Number.isFinite(n) ? n : null
}

/** Latest against the mean of what came before — a move, not a level. */
function trend(series: { week: number; pct?: number; share?: number }[]): number | null {
  const vals = series.map((s) => s.pct ?? s.share ?? 0)
  if (vals.length < 2) return null
  const latest = vals[0]
  const before = vals.slice(1)
  const mean = before.reduce((a, b) => a + b, 0) / before.length
  return latest - mean
}

export async function usageReport(
  season = new Date().getFullYear(),
  lookback = 4,
): Promise<{ rows: Map<string, Usage>; note: string; season: number }> {
  const [snaps, stats] = await Promise.all([
    table('snap_counts', 'snap_counts', season),
    table('stats_player', 'stats_player_week', season),
  ])
  const rows = new Map<string, Usage>()
  if (!snaps.table && !stats.table) {
    return { rows, season, note: snaps.note, }
  }

  const key = (name: string, team: string) => `${name.toLowerCase()}|${team.toUpperCase()}`
  const touch = (name: string, team: string, pos: string) => {
    const k = key(name, team)
    const hit = rows.get(k) ?? { name, team, pos, snapPct: [], targetShare: [], snapTrend: null, targetTrend: null }
    rows.set(k, hit)
    return hit
  }

  /*
   * The window has to be measured over the rows that survive the filters, not
   * over the file. Postseason rows run to week twenty-two, so taking the latest
   * week from the whole table and then keeping only regular-season rows put
   * every one of them outside the window — and target share came back empty for
   * every player in the league without erroring once.
   */
  if (snaps.table) {
    const t = snaps.table
    const [cName, cTeam, cPos, cWeek, cPct, cType] =
      ['player', 'team', 'position', 'week', 'offense_pct', 'game_type'].map(t.col)
    const keep = t.rows.filter(
      (r) => (cType < 0 || !r[cType] || r[cType] === 'REG') &&
        FANTASY.has((r[cPos] ?? '').trim().toUpperCase()),
    )
    const latest = Math.max(0, ...keep.map((r) => num(r[cWeek]) ?? 0))
    for (const r of keep) {
      const w = num(r[cWeek]) ?? 0
      if (w <= latest - lookback) continue
      const pct = num(r[cPct])
      if (pct == null) continue
      touch(r[cName], r[cTeam], (r[cPos] ?? '').trim().toUpperCase())
        .snapPct.push({ week: w, pct })
    }
  }

  if (stats.table) {
    const t = stats.table
    const [cName, cTeam, cPos, cWeek, cShare, cType] =
      ['player_display_name', 'team', 'position', 'week', 'target_share', 'season_type'].map(t.col)
    const keep = t.rows.filter(
      (r) => (cType < 0 || !r[cType] || r[cType] === 'REG') &&
        FANTASY.has((r[cPos] ?? '').trim().toUpperCase()),
    )
    const latest = Math.max(0, ...keep.map((r) => num(r[cWeek]) ?? 0))
    for (const r of keep) {
      const w = num(r[cWeek]) ?? 0
      if (w <= latest - lookback) continue
      const pos = (r[cPos] ?? '').trim().toUpperCase()
      const share = num(r[cShare])
      if (share == null) continue
      touch(r[cName], r[cTeam], pos).targetShare.push({ week: w, share })
    }
  }

  for (const u of rows.values()) {
    u.snapPct.sort((a, b) => b.week - a.week)
    u.targetShare.sort((a, b) => b.week - a.week)
    u.snapTrend = trend(u.snapPct)
    u.targetTrend = trend(u.targetShare)
  }
  return { rows, season, note: stats.note }
}

/** Players whose role is growing fastest — the point of the whole exercise. */
export function rising(rows: Map<string, Usage>, limit = 12): Usage[] {
  return [...rows.values()]
    .filter((u) => (u.snapTrend ?? 0) > 0.08 || (u.targetTrend ?? 0) > 0.03)
    .sort((a, b) =>
      ((b.snapTrend ?? 0) + (b.targetTrend ?? 0) * 2) -
      ((a.snapTrend ?? 0) + (a.targetTrend ?? 0) * 2))
    .slice(0, limit)
}
