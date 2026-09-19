/**
 * Cut the parser tests' fixture out of a Yahoo recording.
 *
 *   tsx scripts/yahoo-fixture.ts fixtures/yahoo-recording-2026-09-19.json
 *
 * A recording is every league's rosters, standings and moves with leaguemates'
 * team names in it, taken through the deployed server, and it stays out of the
 * repository. The tests need Yahoo's shapes, not the people: so this keeps the
 * structure exactly as it arrived — the one-key fragments, the keyed lists,
 * the empty array where a chopped team's roster was — and a handful of players
 * chosen for the cases they exercise, and replaces every team and manager name
 * with a placeholder. Links go too, the league invitation among them.
 *
 * Player names stay. They are public, and they are what the resolver matches.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const src = process.argv[2]
if (!src) throw new Error('usage: tsx scripts/yahoo-fixture.ts <recording.json>')
const rec = JSON.parse(readFileSync(src, 'utf8')) as { recordedAt: number; calls: Record<string, any> }
const call = (end: (p: string) => boolean) => {
  const p = Object.keys(rec.calls).find(end)
  if (!p) throw new Error('the recording has no call like that')
  return structuredClone(rec.calls[p])
}

/* The shapes, as the parser reads them. */
const flat = (parts: any) => Object.assign({}, ...(Array.isArray(parts) ? parts : [parts])
  .filter((x: any) => x && typeof x === 'object' && !Array.isArray(x)))
const items = (o: any) => Object.keys(o ?? {}).filter((k) => /^\d+$/.test(k)).map((k) => o[k])
/** Keep the items a predicate picks, renumbered, with the count to match. */
function keep(o: any, pick: (item: any, i: number) => boolean): any {
  if (!o || Array.isArray(o)) return o
  const chosen = items(o).filter(pick)
  const out: any = {}
  for (const [k, v] of Object.entries(o)) if (!/^\d+$/.test(k) && k !== 'count') out[k] = v
  chosen.forEach((v, i) => { out[String(i)] = v })
  out.count = chosen.length
  return out
}

const leagueKeyOf = (l: any) => flat(l.league[0]).league_key
const teamIdOf = (t: any) => flat(t.team[0]).team_id
const playerOf = (p: any) => flat(p.player[0])

/* ------------------------------------------------------------ anonymising */

const DROP = new Set([
  'url', 'image_url', 'logo_url', 'team_logos', 'headshot', 'short_invitation_url', 'recordbook_url',
  'draft_recap_url', 'editorial_team_url', 'matchup_recap_url', 'matchup_recap_title', 'persistent_url',
  'guid', 'email', 'felo_score', 'felo_tier', 'iris_group_chat_id', 'sendbird_channel_url', 'edit_key',
  'matchup_grades', 'image_url_small',
])

function scrub(x: any, teamNames: Map<string, string>): any {
  if (Array.isArray(x)) return x.map((v) => scrub(v, teamNames))
  if (!x || typeof x !== 'object') return x
  const out: any = {}
  for (const [k, v] of Object.entries(x)) {
    if (DROP.has(k)) continue
    if (k === 'nickname') { out[k] = `Manager ${x.manager_id ?? ''}`.trim(); continue }
    if (k === 'source_team_name' || k === 'destination_team_name') {
      const key = x[k === 'source_team_name' ? 'source_team_key' : 'destination_team_key']
      out[k] = `Team ${String(key).split('.').pop()}`
      continue
    }
    out[k] = scrub(v, teamNames)
  }
  return out
}

/** A team's name sits in a fragment of its own; replace it by the team's id. */
function renameTeams(x: any): any {
  if (Array.isArray(x)) {
    const id = x.find((p) => p && typeof p === 'object' && !Array.isArray(p) && 'team_id' in p)?.team_id
    return x.map((p) =>
      id != null && p && typeof p === 'object' && !Array.isArray(p) && typeof p.name === 'string'
        ? { ...p, name: `Team ${id}` }
        : renameTeams(p))
  }
  if (!x || typeof x !== 'object') return x
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, renameTeams(v)]))
}

const clean = (x: any) => renameTeams(scrub(x, new Map()))

/* ------------------------------------------------------------- selection */

const H2H = '470.l.1604981'
const CHOP = '470.l.310904'
const DEATH = '470.l.1667636'

/**
 * Players chosen for what they test, not for who they are: the first of each
 * case on a team, and nobody twice.
 */
const CASES: [string, (m: any, slot: string) => boolean][] = [
  ['questionable', (m) => m.status === 'Q'],
  ['defence', (m) => m.display_position === 'DEF'],
  ['kicker', (m) => m.display_position === 'K'],
  ['compound position', (m) => /,/.test(m.display_position)],
  ['bench', (_m, slot) => slot === 'BN'],
  ['reserve', (_m, slot) => slot === 'IR'],
  ['flex', (_m, slot) => slot === 'W/R/T'],
  ['played on Thursday', (m) => m.name?.full === 'Jahmyr Gibbs'],
]
function pickCases(players: any): any {
  const chosen = new Set<any>()
  for (const [, is] of CASES) {
    const hit = items(players).find((p) => !chosen.has(p) &&
      is(playerOf(p), flat(p.player.slice(1)).selected_position ? flat(flat(p.player.slice(1)).selected_position).position : ''))
    if (hit) chosen.add(hit)
  }
  return keep(players, (p) => chosen.has(p))
}
function trimRoster(team: any): any {
  const t = structuredClone(team)
  const roster = flat(t.team.slice(1)).roster
  if (roster && roster['0'] && !Array.isArray(roster['0'].players)) {
    roster['0'].players = pickCases(roster['0'].players)
  }
  return t
}

const out: Record<string, any> = { recordedAt: rec.recordedAt }

const disc = call((p) => p.startsWith('users;'))
out.discovery = clean(disc)

const settings = call((p) => p.endsWith('/settings'))
for (const l of items(settings.fantasy_content.leagues)) {
  const s = l.league[1].settings[0]
  // Only the stats this league scores: the rest are names nobody reads.
  const scored = new Set((s.stat_modifiers?.stats ?? []).map((x: any) => String(x.stat.stat_id)))
  l.league[1].settings[0] = {
    roster_positions: s.roster_positions,
    stat_categories: {
      ...s.stat_categories,
      stats: (s.stat_categories?.stats ?? []).filter((x: any) => scored.has(String(x.stat.stat_id))),
    },
    stat_modifiers: s.stat_modifiers,
    uses_faab: s.uses_faab, waiver_type: s.waiver_type, waiver_rule: s.waiver_rule,
    waiver_time: s.waiver_time, draft_time: s.draft_time, playoff_start_week: s.playoff_start_week,
  }
}
out.settings = clean(settings)

const rosters = call((p) => p.endsWith('/teams/roster'))
rosters.fantasy_content.leagues = keep(rosters.fantasy_content.leagues, (l) => [H2H, CHOP].includes(leagueKeyOf(l)))
for (const l of items(rosters.fantasy_content.leagues)) {
  const want = leagueKeyOf(l) === H2H ? ['5', '8'] : ['5', '16']
  l.league[1].teams = keep(l.league[1].teams, (t) => want.includes(teamIdOf(t)))
  for (const k of Object.keys(l.league[1].teams).filter((x) => /^\d+$/.test(x))) {
    l.league[1].teams[k] = trimRoster(l.league[1].teams[k])
  }
}
out.rosters = clean(rosters)

const standings = call((p) => p.endsWith('/standings'))
standings.fantasy_content.leagues = keep(standings.fantasy_content.leagues, (l) => [H2H, CHOP, DEATH].includes(leagueKeyOf(l)))
for (const l of items(standings.fantasy_content.leagues)) {
  const want = leagueKeyOf(l) === H2H ? ['5', '1', '8'] : leagueKeyOf(l) === CHOP ? ['5', '17', '12', '16'] : ['3', '5', '11']
  l.league[1].standings[0].teams = keep(l.league[1].standings[0].teams, (t) => want.includes(teamIdOf(t)))
}
out.standings = clean(standings)

const tx = call((p) => p.endsWith('/transactions'))
tx.fantasy_content.leagues = keep(tx.fantasy_content.leagues, (l) => [H2H, CHOP].includes(leagueKeyOf(l)))
for (const l of items(tx.fantasy_content.leagues)) {
  const seen = new Set<string>()
  l.league[1].transactions = keep(l.league[1].transactions, (t) => {
    const type = t.transaction[0].type
    if (leagueKeyOf(l) === H2H) return true
    if (seen.has(type)) return false
    seen.add(type)
    return true
  })
}
out.transactions = clean(tx)

const sb = call((p) => /\/scoreboard$/.test(p))
sb.fantasy_content.leagues = keep(sb.fantasy_content.leagues, (l) => [H2H, CHOP].includes(leagueKeyOf(l)))
for (const l of items(sb.fantasy_content.leagues)) {
  if (leagueKeyOf(l) !== CHOP) continue
  const m = l.league[1].scoreboard['0']
  m.matchups = keep(m.matchups, (x) => items(x.matchup['0'].teams).some((t: any) => ['5', '17', '18'].includes(teamIdOf(t))))
}
out.scoreboard = clean(sb)

const w1 = call((p) => p.endsWith('/scoreboard;week=1'))
w1.fantasy_content.leagues = keep(w1.fantasy_content.leagues, (l) => [H2H].includes(leagueKeyOf(l)))
out.scoreboardWeek1 = clean(w1)

const tw = call((p) => p.startsWith(`team/${H2H}.t.5/`))
const twRoster = tw.fantasy_content.team[1].roster
twRoster['0'].players = pickCases(twRoster['0'].players)
out.teamWeek = clean(tw)

/*
 * One line. Pretty-printed it ran to sixteen thousand lines and swamped every
 * diff it appeared in; nobody reads it by scrolling, and the tests say what in
 * it matters.
 */
writeFileSync('fixtures/yahoo-api.json', JSON.stringify(out) + '\n')
console.log(`wrote fixtures/yahoo-api.json (${Math.round(JSON.stringify(out).length / 1024)} KB)`)
