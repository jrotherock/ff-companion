/**
 * Re-prices a league's IDP board from `data/idp-measured.json`.
 *
 * The board's IDP order comes from FantasyPros' expert consensus, which is a
 * generic IDP opinion — it does not know that this league pays two points a
 * solo tackle, that eighteen teams start two linebackers plus a defensive
 * flex, or that a guillotine season ends on one bad week rather than on a
 * season-long average. `data/idp-measured.json` is that order recomputed from
 * 2025 box scores under these settings, with snap share breaking ties.
 *
 * The likes list could not do this job: `likeRank` only annotates a player the
 * board already offers, so a defender the consensus omits — an unsigned Bobby
 * Wagner, say — never appears at all however highly he is ranked by hand.
 *
 * Measured players take the top of their position; everyone else keeps their
 * consensus order below them. Run per league so a draft that has already
 * happened is never touched:
 *
 *   npx tsx scripts/apply-idp-measured.ts yahoo-guillotine
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { Player, Ranking } from '../src/kernel/types.js'
import { idpAdp, idpValue, idpDemand } from './fetch-idp.js'

const POS = ['LB', 'DL', 'DB'] as const

async function main() {
  const leagueId = process.argv[2]
  if (!leagueId) throw new Error('usage: apply-idp-measured.ts <leagueId>')

  const league = JSON.parse(await readFile(`data/leagues/${leagueId}.json`, 'utf8'))
  const { players } = JSON.parse(await readFile('data/players.json', 'utf8')) as { players: Player[] }
  const byId = new Map(players.map((p) => [p.id, p]))
  const measured = JSON.parse(await readFile('data/idp-measured.json', 'utf8')) as {
    positions: Record<string, { posRank: number; playerId: string; name: string }[]>
  }

  const path = `data/rankings-${leagueId}.json`
  const current = JSON.parse(await readFile(path, 'utf8')) as { rankings: Ranking[] }
  const rankByIdp = new Map(current.rankings.map((r) => [r.playerId, r]))

  let added = 0
  let repriced = 0
  let demoted = 0
  for (const pos of POS) {
    const demand = idpDemand(league, pos)
    const rows = measured.positions[pos] ?? []
    const pinned = new Set(rows.map((r) => r.playerId))

    for (const row of rows) {
      const player = byId.get(row.playerId)
      if (!player) throw new Error(`${row.name} (${row.playerId}) is not in the player map`)
      if (player.pos !== pos) throw new Error(`${row.name} is ${player.pos}, measured under ${pos}`)
      const value = idpValue(pos, row.posRank, demand)
      const existing = rankByIdp.get(row.playerId)
      if (existing) {
        Object.assign(existing, { value, posRank: row.posRank, source: 'measured-2025' })
        repriced++
      } else {
        // A defender the consensus never listed. Without this he is absent
        // from the board entirely, not merely ranked low.
        const fresh = {
          playerId: row.playerId, myRank: 0, tier: 0, value, posRank: row.posRank,
          adp: idpAdp(row.posRank, league.teams), adpStdev: 8,
          source: 'measured-2025', estimatedValue: true,
        } as unknown as Ranking
        current.rankings.push(fresh)
        rankByIdp.set(row.playerId, fresh)
        added++
      }
    }

    // Everyone the measurement did not cover keeps the consensus order, but
    // below the measured block — otherwise a consensus LB1 ties the measured
    // LB1 on value and the pinning does nothing.
    const rest = current.rankings
      .filter((r) => byId.get(r.playerId)?.pos === pos && !pinned.has(r.playerId))
      .sort((a, b) => (a.posRank ?? 1e9) - (b.posRank ?? 1e9))
    rest.forEach((r, i) => {
      r.posRank = rows.length + i + 1
      r.value = idpValue(pos, r.posRank, demand)
      demoted++
    })
  }

  current.rankings.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  current.rankings.forEach((r, i) => { r.myRank = i + 1 })
  await writeFile(path, JSON.stringify(current, null, 1))

  const first = current.rankings.findIndex((r: any) => String(r.source ?? '').startsWith('measured'))
  console.log(`${leagueId}: ${added} added, ${repriced} repriced, ${demoted} kept below on consensus order`)
  console.log(`first measured defender on the board: #${first + 1} of ${current.rankings.length}`)
  for (const pos of POS) {
    const top = current.rankings.filter((r) => byId.get(r.playerId)?.pos === pos).slice(0, 5)
    console.log(`  ${pos}: ` + top.map((r) => `${byId.get(r.playerId)!.name} (#${r.myRank})`).join(', '))
  }
}

main()
