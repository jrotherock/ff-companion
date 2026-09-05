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
 * IDP has no projections in league scoring, so value stays a placement
 * heuristic rather than a measurement — but it is now anchored to what the
 * league actually demands rather than to one flat curve for all three groups.
 *
 * The demand is the thing. Eighteen teams starting two linebackers plus a
 * defensive flex that any sane manager fills with a third need fifty-four
 * startable linebackers; the NFL produces about twenty who play every down,
 * and the count falls every year as nickel and dime eat the base defence. Two
 * defensive line and two defensive back slots need thirty-six each, and there
 * are sixty-four starting safeties before anyone counts corners.
 *
 * So the top linebackers sit where a fourth or fifth round pick sits, the top
 * linemen a little below, and the backs later still — not because backs score
 * less, but because the twentieth is nearly the second.
 *
 * The anchors are deliberately short of what value over replacement implies.
 * On this scale an elite linebacker at nineteen points a game against a
 * replacement at six would out-rank the first pick of the draft, which is a
 * conclusion drawn from a baseline nobody has measured for an eighteen-team
 * IDP guillotine. Rounds four and five are the recommendation; the arithmetic
 * that suggests round one is not trusted enough to ship.
 */
const IDP_TOP: Record<string, number> = { LB: 3.0, DL: 2.4, DB: 1.4 }
const IDP_FLOOR = -1.0

function idpValue(pos: string, posRank: number, demand: number): number {
  const top = IDP_TOP[pos] ?? 1.2
  const slope = (top - IDP_FLOOR) / Math.max(1, demand - 1)
  return Number((top - (posRank - 1) * slope).toFixed(2))
}

/**
 * How many of a position the whole league has to start. The defensive flex is
 * counted as a linebacker: in this scoring they out-score the other two groups
 * at the top and do it with a steadier weekly line, so that is where it goes.
 */
function idpDemand(league: any, pos: string): number {
  const base = (league.starters?.[pos] ?? 0) * league.teams
  const flex = (league.flex ?? []).filter(
    (f: any) => f.eligible?.includes(pos) && f.eligible.every((e: string) => ['DB', 'DL', 'LB'].includes(e)),
  ).reduce((a: number, f: any) => a + f.count, 0)
  return base + (pos === 'LB' ? flex * league.teams : 0)
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

    // FantasyPros ranks IDP in one list; the value needs where a player sits
    // among his own kind, since that is what the league's demand is counted in.
    const seen: Record<string, number> = {}
    let added = 0
    let repriced = 0
    const unmatched: string[] = []
    for (const row of rows) {
      const player = index.resolve({ name: row.name, pos: row.pos, team: row.team })
      if (!player) {
        unmatched.push(`${row.name} (${row.pos} ${row.team})`)
        continue
      }
      const posRank = (seen[row.pos] = (seen[row.pos] ?? 0) + 1)
      const value = idpValue(row.pos, posRank, idpDemand(league, row.pos))
      /*
       * Re-price players already on the board rather than skipping them. The
       * first run of this only touched new arrivals, so a re-run left every
       * existing defender carrying the old flat curve and changed nothing.
       */
      const existing = current.rankings.find((r) => r.playerId === player.id)
      if (existing) {
        Object.assign(existing, { value, posRank, tier: row.tier, source: 'fantasypros-idp' })
        repriced++
        continue
      }
      current.rankings.push({
        playerId: player.id,
        myRank: 0,
        tier: row.tier,
        value,
        posRank,
        adp: idpAdp(row.rank, league.teams),
        // Expert spread, converted from rank units into pick units.
        adpStdev: Math.max(4, row.stdev * ((5 * league.teams) / 55)),
        source: 'fantasypros-idp',
        estimatedValue: true,
      } as any)
      have.add(player.id)
      added++
    }

    /*
     * Merge, rather than append.
     *
     * These were pushed on the end and numbered from there, so the board ran
     * every offensive player and every kicker first and then the whole
     * defensive pool. Jordyn Brooks sat at 337 on a value of 1.2, below two
     * hundred players worth less than him and below kickers worth minus five —
     * and no deadline rule could be satisfied, because the board never offered
     * a linebacker until round nineteen. Sorting by value is the whole fix.
     */
    current.rankings.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    current.rankings.forEach((r, i) => { r.myRank = i + 1 })

    const firstIdp = current.rankings.findIndex((r: any) => r.source === 'fantasypros-idp')
    await writeFile(path, JSON.stringify(current, null, 1))
    console.log(
      `${league.id.padEnd(18)} +${added} IDP, ${repriced} repriced` +
        (firstIdp >= 0 ? `, first at #${firstIdp + 1}` : '') +
        (unmatched.length ? `  unmatched ${unmatched.length}: ${unmatched.slice(0, 4).join(', ')}` : ''),
    )
  }
}

main()
