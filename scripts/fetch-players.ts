/**
 * Builds the canonical player map. Sleeper ids are the join key; Sleeper also
 * carries yahoo_id and espn_id, which is why it is the spine for everything.
 * Bye weeks are not in Sleeper, so they are derived from the schedule: a team's
 * bye is the week it has no game.
 */
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises'
import type { Player, Pos } from '../src/kernel/types.js'

const SEASON = 2026
const KEEP: Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'DB', 'DL', 'LB']

async function byeWeeks(): Promise<Map<string, number>> {
  const playing = new Map<number, Set<string>>()
  const all = new Set<string>()

  for (let week = 1; week <= 18; week++) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&seasontype=2&dates=${SEASON}`
    const res = await fetch(url)
    if (!res.ok) continue
    const data = (await res.json()) as any
    const teams = new Set<string>()
    for (const ev of data.events ?? []) {
      for (const c of ev.competitions?.[0]?.competitors ?? []) {
        const abbr = c.team?.abbreviation
        if (abbr) {
          teams.add(abbr)
          all.add(abbr)
        }
      }
    }
    playing.set(week, teams)
  }

  const byes = new Map<string, number>()
  for (const team of all) {
    for (const [week, teams] of playing) {
      if (!teams.has(team)) {
        byes.set(team, week)
        break
      }
    }
  }
  return byes
}

/** ESPN abbreviations differ from Sleeper's for a handful of teams. */
const ESPN_TO_SLEEPER: Record<string, string> = { WSH: 'WAS' }

/** Sleeper reports granular defensive positions; leagues roster them in buckets. */
const POS_MAP: Record<string, Pos> = {
  QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'DST',
  CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB', DB: 'DB',
  DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL',
  LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB',
}

/**
 * Unsigned veterans worth keeping on the board. The team filter below drops
 * anyone Sleeper has no club for, which is right for the retirees it also
 * lists — but it silently took Bobby Wagner off an IDP board where he had
 * just finished LB7 and played 90%+ of snaps in all 17 games. Listed by
 * Sleeper id so a name change cannot quietly empty this.
 */
const KEEP_UNSIGNED = new Set(['1233', '1192', '5894'])

/**
 * Anyone a ranking or a like/avoid list already points at, so a refresh cannot
 * drop a player the rest of the data still names. Tyreek Hill went unsigned
 * while sitting in three ranking files; without this he vanishes from the map
 * and every board that references him loses a row with no error anywhere.
 * Kept players carry team 'FA' and therefore no bye week.
 */
async function referenced(): Promise<Set<string>> {
  const ids = new Set<string>()
  const dirs = [
    ['data', (f: string) => f.startsWith('rankings-') && f.endsWith('.json')],
    ['data/preferences', (f: string) => f.endsWith('.json') && !f.endsWith('.rules.json')],
  ] as const
  for (const [dir, keep] of dirs) {
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names.filter(keep)) {
      try {
        const raw = JSON.parse(await readFile(`${dir}/${name}`, 'utf8'))
        for (const r of raw.rankings ?? []) if (r.playerId) ids.add(String(r.playerId))
        for (const id of [...(raw.likes ?? []), ...(raw.avoids ?? [])]) ids.add(String(id))
      } catch {
        // A malformed or half-written file must not take the whole map down.
      }
    }
  }
  return ids
}

async function main() {
  console.log('fetching sleeper player map…')
  const res = await fetch('https://api.sleeper.app/v1/players/nfl')
  const raw = (await res.json()) as Record<string, any>

  const keep = await referenced()
  for (const id of KEEP_UNSIGNED) keep.add(id)

  console.log('deriving bye weeks from schedule…')
  const espnByes = await byeWeeks()
  const byes = new Map<string, number>()
  for (const [team, week] of espnByes) byes.set(ESPN_TO_SLEEPER[team] ?? team, week)

  const players: Player[] = []
  for (const [id, p] of Object.entries(raw)) {
    const pos = POS_MAP[p.position ?? p.fantasy_positions?.[0] ?? '']
    if (!pos || !KEEP.includes(pos)) continue
    // Only rostered players; Sleeper's `active` flag and `search_rank` both
    // still list retirees, so a ranked free agent is backfilled by the rankings
    // import instead of widening the filter here.
    const team =
      p.team ?? (pos === 'DST' ? p.player_id : keep.has(id) ? 'FA' : null)
    if (!team) continue
    const name =
      p.full_name?.trim() || `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
    if (!name) continue
    players.push({
      id,
      name,
      pos,
      team,
      byeWeek: byes.get(team) ?? null,
      // Needed to tell a rookie flier from a veteran, and a starter from the
      // back-up behind him — the two archetypes worth taking late.
      yearsExp: typeof p.years_exp === 'number' ? p.years_exp : null,
      depthOrder: typeof p.depth_chart_order === 'number' ? p.depth_chart_order : null,
      // Kept so a league that must score from week one can avoid a player who
      // will not be on the field for it. Both fields matter: `status` carries
      // the season-long designations, `injury_status` the weekly one.
      status: p.status ?? null,
      injuryStatus: p.injury_status ?? null,
      injuryBody: p.injury_body_part ?? null,
      injuryNotes: p.injury_notes ?? null,
      ids: {
        yahoo: p.yahoo_id ? String(p.yahoo_id) : undefined,
        espn: p.espn_id ? String(p.espn_id) : undefined,
        fantasypros: p.fantasy_data_id ? String(p.fantasy_data_id) : undefined,
      },
    })
  }

  await mkdir('data', { recursive: true })
  await writeFile('data/players.json', JSON.stringify({ season: SEASON, players }, null, 1))
  // The diff between two of these is the news feed's first tier, so every
  // refresh leaves a baseline behind for the next one to compare against.
  // The poller keeps its own snapshot from Sleeper directly, so nothing here
  // needs to seed it — left as a note rather than a stale import.
  const withBye = players.filter((p) => p.byeWeek != null).length
  console.log(`wrote ${players.length} players (${withBye} with bye weeks) -> data/players.json`)
}

main()
