/**
 * IDP rankings for the leagues that roster DB/DL/LB. TapThatDraft has no IDP at
 * all, so these come from FantasyPros' expert consensus, which publishes a rank,
 * a tier, and — unusually — the spread of expert opinion, which is a real
 * measure of dispersion rather than the estimate used elsewhere.
 *
 * MasterIDP (Leo, RPO Football) was the most accurate individual IDP ranker in
 * 2025 and is one of the experts inside this consensus.
 *
 * ADP is anchored to what this league actually does rather than invented: the
 * 2025 Harker Experi(Mental) draft took its IDP overwhelmingly in rounds 7-11.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { PlayerIndex } from '../src/kernel/match.js'
import type { Player, Pos, Ranking } from '../src/kernel/types.js'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

/** FantasyPros reports true positions; leagues roster them in buckets. */
const BUCKET: Record<string, Pos> = {
  LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB',
  DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL',
  CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB', DB: 'DB',
}

interface IdpRow {
  name: string
  team: string
  pos: Pos
  rank: number
  tier: number
  stdev: number
  bye: number | null
}

async function fetchIdp(): Promise<IdpRow[]> {
  const res = await fetch('https://www.fantasypros.com/nfl/rankings/idp-cheatsheets.php', {
    headers: { 'User-Agent': UA },
  })
  const html = await res.text()
  const m = /var\s+ecrData\s*=\s*(\{[\s\S]*?\});/.exec(html)
  if (!m) throw new Error('could not find ecrData on the FantasyPros IDP page')
  const data = JSON.parse(m[1]) as any

  return (data.players ?? [])
    .map((p: any): IdpRow | null => {
      const pos = BUCKET[p.player_position_id]
      if (!pos) return null
      return {
        name: p.player_name,
        team: p.player_team_id,
        pos,
        rank: Number(p.rank_ecr),
        tier: Number(p.tier ?? 0),
        stdev: Number(p.rank_std ?? 0),
        bye: p.player_bye_week ? Number(p.player_bye_week) : null,
      }
    })
    .filter(Boolean) as IdpRow[]
}

/**
 * Observed from the 2025 draft: the first IDP went early as a reach, but the
 * position group cleared between rounds 7 and 11. Rank 1 lands at the top of
 * that window and the pool stretches to the end of it.
 */
function idpAdp(rank: number, teams: number): number {
  const windowStart = 6 * teams
  const perPick = (5 * teams) / 55
  return Math.round(windowStart + (rank - 1) * perPick)
}

/**
 * IDP has no projections in league scoring, so value is a placement heuristic
 * rather than a measurement: the top of the pool sits alongside a mid-round
 * offensive starter, and it decays from there. Flagged so the UI can say so.
 */
function idpValue(rank: number): number {
  return Number((1.2 - (rank - 1) * 0.05).toFixed(2))
}

async function main() {
  const file = JSON.parse(await readFile('data/players.json', 'utf8')) as {
    season: number
    players: Player[]
  }
  const index = new PlayerIndex(file.players)
  const rows = await fetchIdp()
  console.log(`fetched ${rows.length} IDP players from FantasyPros consensus`)

  for (const name of (await readdir('data/leagues')).filter((f) => f.endsWith('.json'))) {
    const league = JSON.parse(await readFile(`data/leagues/${name}`, 'utf8'))
    const needsIdp = ['DB', 'DL', 'LB'].some((p) => (league.starters?.[p] ?? 0) > 0)
    if (!needsIdp) continue

    const path = `data/rankings-${league.id}.json`
    const current = JSON.parse(await readFile(path, 'utf8')) as {
      leagueId: string
      source: string
      rankings: Ranking[]
    }
    const have = new Set(current.rankings.map((r) => r.playerId))

    let added = 0
    const unmatched: string[] = []
    for (const row of rows) {
      const player = index.resolve({ name: row.name, pos: row.pos, team: row.team })
      if (!player) {
        unmatched.push(`${row.name} (${row.pos} ${row.team})`)
        continue
      }
      if (have.has(player.id)) continue
      current.rankings.push({
        playerId: player.id,
        myRank: current.rankings.length + 1,
        tier: row.tier,
        value: idpValue(row.rank),
        posRank: row.rank,
        adp: idpAdp(row.rank, league.teams),
        // Expert spread, converted from rank units into pick units.
        adpStdev: Math.max(4, row.stdev * ((5 * league.teams) / 55)),
        source: 'fantasypros-idp',
        estimatedValue: true,
      } as any)
      have.add(player.id)
      added++
    }

    await writeFile(path, JSON.stringify(current, null, 1))
    console.log(
      `${league.id.padEnd(18)} +${added} IDP` +
        (unmatched.length ? `  unmatched ${unmatched.length}: ${unmatched.slice(0, 4).join(', ')}` : ''),
    )
  }
}

main()
