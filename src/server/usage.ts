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

/**
 * A player's share of his own team's targets and carries.
 *
 * The one usage number worth putting into a start/sit decision, and it earned
 * that on the 2025 season scored under this league's own rules. Among pairs of
 * players at one position whose recent scoring a projection could not separate
 * — inside the same coin-flip band the optimiser uses — the man with the larger
 * share of his team's opportunities outscored the other about two times in
 * three. Snap share was measured too and came second: snaps are inflated by
 * pass protection and decoy routes, which are playing time without a chance to
 * score.
 *
 * Averaged over up to four weeks rather than read off the last one. A single
 * week is a game script — Denver threw twenty-eight times in a blowout and
 * made its own receiver look like a bit-part player — and the measurement says
 * so plainly: one week wins 60 to 66 per cent of those pairs, four weeks 66 to
 * 71. The window simply widens as the season supplies weeks, so nothing needs
 * changing later.
 *
 * Weeks he missed are left out rather than counted as nought. The question is
 * what his role is when he plays; a torn hamstring is the injury report's news,
 * not the role's.
 */
export interface Role {
  /** Mean share of his team's targets and carries, 0 to 1. */
  share: number
  /** How many weeks went into it. One is a game script; four is a role. */
  weeks: number
}

export async function roleFor(
  season: number,
  resolve: (name: string, pos: string, team: string) => string | null,
  lookback = 4,
): Promise<{ roles: Map<string, Role>; note: string; through: number }> {
  const stats = await table('stats_player', 'stats_player_week', season)
  const roles = new Map<string, Role>()
  if (!stats.table) return { roles, note: stats.note, through: 0 }

  const t = stats.table
  const [cName, cTeam, cPos, cWeek, cType, cTgt, cCar] =
    ['player_display_name', 'team', 'position', 'week', 'season_type', 'targets', 'carries']
      .map(t.col)
  // Regular season only, and only positions whose opportunities are the ball.
  const keep = t.rows.filter(
    (r) => (cType < 0 || r[cType] === 'REG') &&
      ['RB', 'WR', 'TE'].includes((r[cPos] ?? '').trim().toUpperCase()),
  )
  if (!keep.length) return { roles, note: 'no weeks played yet', through: 0 }
  const latest = Math.max(0, ...keep.map((r) => num(r[cWeek]) ?? 0))
  const inWindow = keep.filter((r) => {
    const w = num(r[cWeek]) ?? 0
    return w > latest - lookback && w <= latest
  })

  // Each team's own total, so a share means something on a team that throws
  // forty times and on one that throws twenty.
  const teamTotal = new Map<string, number>()
  for (const r of inWindow) {
    const k = `${r[cTeam]}|${r[cWeek]}`
    teamTotal.set(k, (teamTotal.get(k) ?? 0) + (num(r[cTgt]) ?? 0) + (num(r[cCar]) ?? 0))
  }

  const seen = new Map<string, { sum: number; weeks: number }>()
  for (const r of inWindow) {
    const total = teamTotal.get(`${r[cTeam]}|${r[cWeek]}`) ?? 0
    if (!total) continue
    const id = resolve(r[cName] ?? '', (r[cPos] ?? '').toUpperCase(), (r[cTeam] ?? '').toUpperCase())
    if (!id) continue
    const opp = (num(r[cTgt]) ?? 0) + (num(r[cCar]) ?? 0)
    const at = seen.get(id) ?? { sum: 0, weeks: 0 }
    at.sum += opp / total
    at.weeks += 1
    seen.set(id, at)
  }
  for (const [id, v] of seen) roles.set(id, { share: v.sum / v.weeks, weeks: v.weeks })
  return { roles, note: `weeks ${Math.max(1, latest - lookback + 1)}-${latest}`, through: latest }
}
