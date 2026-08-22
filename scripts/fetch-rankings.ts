/**
 * Configures TapThatDraft from each league's real settings and captures the
 * BEER+ board, resolving names to canonical Sleeper player ids.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { PlayerIndex, normaliseName } from '../src/kernel/match.js'
import { fetchBoardWithUrl, type BoardRow } from './ttd-client.js'
import type { Player, Pos, Ranking } from '../src/kernel/types.js'

/**
 * A ranked player with no NFL team is absent from the rostered player map, so
 * he is pulled from the full Sleeper map on demand and added to it.
 */
async function backfill(missing: BoardRow[], players: Player[]): Promise<Player[]> {
  if (missing.length === 0) return []
  const raw = (await (await fetch('https://api.sleeper.app/v1/players/nfl')).json()) as Record<string, any>
  const have = new Set(players.map((p) => p.id))
  const wanted = new Map(missing.map((m) => [normaliseName(m.name), m]))
  const added: Player[] = []

  for (const [id, p] of Object.entries(raw)) {
    if (have.has(id)) continue
    const full = p.full_name?.trim() || `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
    const key = normaliseName(full)
    const want = wanted.get(key)
    if (!want || p.position !== want.pos) continue
    added.push({
      id,
      name: full,
      pos: want.pos as Pos,
      team: p.team ?? 'FA',
      byeWeek: null,
      ids: { yahoo: p.yahoo_id ? String(p.yahoo_id) : undefined },
    })
    wanted.delete(key)
  }
  return added
}

async function main() {
  const file = JSON.parse(await readFile('data/players.json', 'utf8')) as {
    season: number
    players: Player[]
  }
  let players = file.players
  let index = new PlayerIndex(players)

  for (const name of (await readdir('data/leagues')).filter((f) => f.endsWith('.json'))) {
    const path = `data/leagues/${name}`
    const league = JSON.parse(await readFile(path, 'utf8'))
    const { rows, url } = await fetchBoardWithUrl(league)

    const missing = rows.filter((r) => !index.resolve({ name: r.name, pos: r.pos, team: r.team }))
    const added = await backfill(missing, players)
    if (added.length) {
      players = [...players, ...added]
      index = new PlayerIndex(players)
      await writeFile('data/players.json', JSON.stringify({ season: file.season, players }, null, 1))
      console.log(`  backfilled ${added.length}: ${added.map((p) => p.name).join(', ')}`)
    }

    const rankings: Ranking[] = []
    const unmatched: string[] = []
    for (const row of rows) {
      const player = index.resolve({ name: row.name, pos: row.pos, team: row.team })
      if (!player) {
        unmatched.push(`${row.name} (${row.pos} ${row.team})`)
        continue
      }
      rankings.push({
        playerId: player.id,
        myRank: row.overall,
        tier: 0,
        value: row.value,
        posRank: row.posRank,
        adp: row.adp ?? row.overall,
        adpStdev: 0,
      })
    }

    await writeFile(
      `data/rankings-${league.id}.json`,
      JSON.stringify(
        { leagueId: league.id, source: url, fetchedAt: new Date().toISOString(), rankings },
        null,
        1,
      ),
    )
    if (league.rankingUrl !== url) {
      league.rankingUrl = url
      await writeFile(path, JSON.stringify(league, null, 2) + '\n')
    }
    console.log(
      `${league.id.padEnd(18)} ${String(rankings.length).padStart(4)} ranked` +
        (unmatched.length ? `  UNMATCHED ${unmatched.length}: ${unmatched.slice(0, 5).join(', ')}` : ''),
    )
  }
}

main()
