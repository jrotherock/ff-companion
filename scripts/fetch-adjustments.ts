/**
 * Measures the events TapThatDraft cannot score (40+ yard plays, yardage
 * milestones, kicker distance) from real prior-season stats, and calibrates how
 * many BEER+ units a season point is worth.
 *
 * BEER+ is scarcity-adjusted rather than raw points over replacement, so the
 * conversion is measured per position by perturbing one known scoring field and
 * regressing the resulting value change against the known points change.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { PlayerIndex } from '../src/kernel/match.js'
import type { BigPlayRates, ValueSlopes } from '../src/kernel/adjust.js'
import type { Player, Pos } from '../src/kernel/types.js'

const STATS_SEASON = 2025
const WEEKS = 18

type StatLine = Record<string, number>

async function seasonStats(): Promise<Record<string, StatLine>> {
  const res = await fetch(`https://api.sleeper.app/v1/stats/nfl/regular/${STATS_SEASON}`)
  return (await res.json()) as Record<string, StatLine>
}

/** Milestone bonuses are per game, so they need week-by-week lines. */
async function milestoneCounts(): Promise<Record<string, { rec150: number; rush150: number; pass350: number }>> {
  const out: Record<string, { rec150: number; rush150: number; pass350: number }> = {}
  for (let week = 1; week <= WEEKS; week++) {
    const res = await fetch(`https://api.sleeper.app/v1/stats/nfl/regular/${STATS_SEASON}/${week}`)
    if (!res.ok) continue
    const data = (await res.json()) as Record<string, StatLine>
    for (const [id, line] of Object.entries(data)) {
      if (!line) continue
      const e = (out[id] ??= { rec150: 0, rush150: 0, pass350: 0 })
      if ((line.rec_yd ?? 0) >= 150) e.rec150++
      if ((line.rush_yd ?? 0) >= 150) e.rush150++
      if ((line.pass_yd ?? 0) >= 350) e.pass350++
    }
  }
  return out
}

/** Least-squares slope of y on x. */
function slope(points: { x: number; y: number }[]): number | null {
  if (points.length < 8) return null
  const n = points.length
  const mx = points.reduce((s, p) => s + p.x, 0) / n
  const my = points.reduce((s, p) => s + p.y, 0) / n
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.x - mx) * (p.y - my)
    den += (p.x - mx) ** 2
  }
  return den === 0 ? null : num / den
}

async function main() {
  const { players } = JSON.parse(await readFile('data/players.json', 'utf8')) as { players: Player[] }
  const index = new PlayerIndex(players)

  console.log(`fetching ${STATS_SEASON} season totals…`)
  const season = await seasonStats()
  console.log(`fetching ${WEEKS} weeks for milestone counts…`)
  const milestones = await milestoneCounts()

  const rates: Record<string, BigPlayRates> = {}
  for (const p of players) {
    const s = season[p.id]
    if (!s) continue
    const m = milestones[p.id] ?? { rec150: 0, rush150: 0, pass350: 0 }
    const fgYards =
      (s.fgm_0_19 ?? 0) * 15 + (s.fgm_20_29 ?? 0) * 25 + (s.fgm_30_39 ?? 0) * 35 +
      (s.fgm_40_49 ?? 0) * 45 + (s.fgm_50_59 ?? 0) * 54 + (s.fgm_60p ?? 0) * 62
    const entry: BigPlayRates = {
      rec40: s.rec_40p ?? 0,
      recTd40: s.rec_td_40p ?? 0,
      rush40: s.rush_40p ?? 0,
      rushTd40: s.rush_td_40p ?? 0,
      passCmp40: s.pass_cmp_40p ?? 0,
      passTd40: s.pass_td_40p ?? 0,
      gamesOver150Rec: m.rec150,
      gamesOver150Rush: m.rush150,
      gamesOver350Pass: m.pass350,
      fgYards,
      fgMade: s.fgm ?? 0,
    }
    const any = Object.values(entry).some((v) => v > 0)
    if (any) rates[p.id] = entry
  }

  console.log('calibrating value-per-point by position…')
  const slopes = await calibrate(index, season)

  await writeFile(
    'data/adjustments.json',
    JSON.stringify({ season: STATS_SEASON, slopes, rates }, null, 1),
  )
  console.log(`wrote ${Object.keys(rates).length} player rate lines`)
  console.log('slopes (BEER+ per season point):', slopes)
}

/**
 * Perturbs one scoring field and regresses the value change against the known
 * points change, giving BEER+ units per season point for that position.
 */
async function calibrate(index: PlayerIndex, season: Record<string, StatLine>): Promise<ValueSlopes> {
  const { fetchBoard } = await import('./ttd-client.js')
  const league = JSON.parse(await readFile('data/leagues/yahoo-steward.json', 'utf8'))

  const base = await fetchBoard(league, {})
  const slopes: ValueSlopes = {}

  const probes: { positions: Pos[]; field: string; value: number; stat: string; per: number }[] = [
    { positions: ['WR', 'TE', 'RB'], field: 'receptions', value: 1.0, stat: 'rec', per: 0.5 },
    { positions: ['QB'], field: 'pass_tds', value: 6, stat: 'pass_td', per: 2 },
  ]

  for (const probe of probes) {
    const perturbed = await fetchBoard(league, { [probe.field]: probe.value })
    const byName = new Map(perturbed.map((r) => [r.name, r]))

    for (const pos of probe.positions) {
      const pts: { x: number; y: number }[] = []
      for (const row of base) {
        if (row.pos !== pos) continue
        const after = byName.get(row.name)
        if (!after) continue
        const player = index.resolve({ name: row.name, pos: row.pos, team: row.team })
        const stat = player ? season[player.id]?.[probe.stat] : undefined
        if (!stat) continue
        pts.push({ x: probe.per * stat, y: after.value - row.value })
      }
      const s = slope(pts)
      if (s && s > 0) slopes[pos] = Number(s.toFixed(5))
      console.log(`  ${pos}: n=${pts.length} slope=${s?.toFixed(5) ?? 'n/a'}`)
    }
  }
  return slopes
}

main()
