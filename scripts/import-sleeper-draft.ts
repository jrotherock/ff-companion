/**
 * Imports a Sleeper draft the companion never watched.
 *
 * Sleeper has no endpoint that lists your mocks — `user/<id>/drafts` returns
 * only drafts attached to a league — so a mock played without the companion
 * running leaves nothing behind locally. Its picks are still served by the API
 * for anyone with the draft id, which makes a mock recoverable after the fact
 * from the draft-room URL alone.
 *
 *   npx tsx scripts/import-sleeper-draft.ts <draftId or draft-room URL> …
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { PlayerIndex } from '../src/kernel/match.js'
import type { LeagueConfig, Player } from '../src/kernel/types.js'

const SLEEPER_USER = process.env.SLEEPER_USER ?? '862745311741882368'
const LEAGUE_ID = process.env.LEAGUE ?? 'sleeper-meta4'

const args = process.argv.slice(2)
if (!args.length) {
  console.error('usage: import-sleeper-draft <draftId | draft URL> …')
  process.exit(1)
}

const { players } = JSON.parse(readFileSync('data/players.json', 'utf8')) as { players: Player[] }
const index = new PlayerIndex(players)
const league = JSON.parse(readFileSync(`data/leagues/${LEAGUE_ID}.json`, 'utf8')) as LeagueConfig

const manifestPath = 'fixtures/drafts/manifest.json'
const manifest: Record<string, any> = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : {}

for (const arg of args) {
  // Accept the draft-room URL as readily as a bare id; copying the URL is the
  // least a mock can ask, since there is nothing else to identify it by.
  const draftId = /(\d{6,})/.exec(arg)?.[1]
  if (!draftId) {
    console.error(`  skipped ${arg}: no draft id in it`)
    continue
  }

  const meta = (await (await fetch(`https://api.sleeper.app/v1/draft/${draftId}`)).json()) as any
  if (!meta?.draft_id) {
    console.error(`  skipped ${draftId}: Sleeper does not know it`)
    continue
  }
  const picks = (await (
    await fetch(`https://api.sleeper.app/v1/draft/${draftId}/picks`)
  ).json()) as any[]
  if (!Array.isArray(picks) || !picks.length) {
    console.error(`  skipped ${draftId}: no picks`)
    continue
  }

  const teams = meta.settings?.teams ?? league.teams
  const rounds = meta.settings?.rounds ?? league.rounds
  // Your slot is whichever one drafted for you, which the picks themselves say.
  // Asking for it would be asking about a draft you played days ago.
  const mine = picks.find((p) => p.picked_by === SLEEPER_USER)
  const mySlot = mine?.draft_slot ?? null

  const key = `${LEAGUE_ID}-${draftId}`
  const logPath = `fixtures/log-${LEAGUE_ID}-${draftId}.jsonl`
  /*
   * Never rewrite a draft the companion actually watched. A sensed log carries
   * a timestamp per pick — forty-eight of them across one draft — while an
   * import can only stamp every pick with the draft's start time, so importing
   * over a watched draft trades real timing for a flat one and cannot be undone.
   */
  if (existsSync(logPath)) {
    console.log(`  ${key}: already recorded — left alone`)
    continue
  }
  const at = Number(meta.start_time ?? meta.created ?? Date.now())

  const lines: string[] = []
  if (mySlot != null) lines.push(JSON.stringify({ t: 'slot', at, slot: mySlot }))
  let unresolved = 0
  for (const p of picks) {
    const player = index.resolve({
      name: `${p.metadata?.first_name ?? ''} ${p.metadata?.last_name ?? ''}`.trim(),
      pos: p.metadata?.position,
      team: p.metadata?.team,
    })
    const playerId = player?.id ?? p.player_id
    if (!player) unresolved++
    lines.push(
      JSON.stringify({
        t: 'pick',
        at,
        source: 'sleeper-import',
        pick: {
          overall: p.pick_no,
          round: p.round,
          slot: p.draft_slot,
          teamId: p.picked_by || `slot-${p.draft_slot}`,
          playerId,
        },
      }),
    )
  }
  mkdirSync('fixtures', { recursive: true })
  writeFileSync(logPath, lines.join('\n') + '\n')

  /*
   * Rankings are frozen as they stand today, not as they stood on the night.
   * For a mock played this week that is close enough to be useful, but it is
   * recorded as approximate rather than passed off as contemporaneous.
   */
  const rankingsFile = `fixtures/drafts/rankings-${key}.json`
  if (!existsSync(rankingsFile)) {
    writeFileSync(rankingsFile, readFileSync(`data/rankings-${LEAGUE_ID}.json`, 'utf8'))
  }

  manifest[key] = {
    key,
    leagueId: LEAGUE_ID,
    leagueLabel: league.label,
    platform: 'sleeper',
    draftId,
    mock: !meta.league_id,
    teams,
    rounds,
    mySlot,
    startedAt: at,
    updatedAt: Date.now(),
    picks: picks.length,
    complete: picks.length >= teams * rounds,
    rankingsFile,
    rankingsApproximate: true,
  }
  console.log(
    `  ${key}: ${picks.length} picks, ${teams}x${rounds}, slot ${mySlot ?? '?'}` +
      (unresolved ? `, ${unresolved} unresolved` : ''),
  )
}

mkdirSync('fixtures/drafts', { recursive: true })
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n')
console.log(`manifest now holds ${Object.keys(manifest).length} drafts`)
