/**
 * Registers drafts that were played before the archive existed.
 *
 * Their rankings can only be frozen as they stand today, not as they stood at
 * the time — so reviews of these are approximate in a way later ones are not.
 * Flagged in the manifest rather than papered over.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import type { LeagueConfig } from '../src/kernel/types.js'

const DIR = 'fixtures/drafts'
mkdirSync(DIR, { recursive: true })
const manifestPath = `${DIR}/manifest.json`
const manifest: Record<string, any> = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : {}

for (const file of readdirSync('fixtures').filter((f) => f.startsWith('log-') && f.endsWith('.jsonl'))) {
  const entries = readFileSync(`fixtures/${file}`, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l) } catch { return null }
    })
    .filter(Boolean) as any[]

  const byOverall = new Map<number, any>()
  let slot: number | null = null
  let first = Infinity
  let last = 0
  for (const e of entries) {
    if (e.at) { first = Math.min(first, e.at); last = Math.max(last, e.at) }
    if (e.t === 'pick') byOverall.set(e.pick.overall, e.pick)
    else if (e.t === 'undo') byOverall.delete(e.overall)
    else if (e.t === 'reset') byOverall.clear()
    else if (e.t === 'slot') slot = e.slot
  }
  const picks = [...byOverall.values()]
  if (picks.length < 20) continue

  const stem = file.replace(/^log-/, '').replace(/\.jsonl$/, '')
  const m = /^(.*?)-(\d{6,})$/.exec(stem)
  const leagueId = m ? m[1] : stem
  const draftId = m ? m[2] : null
  const key = `${leagueId}-${draftId ?? leagueId}`
  if (manifest[key]) continue

  const cfgPath = `data/leagues/${leagueId}.json`
  if (!existsSync(cfgPath)) {
    console.log(`  skipped ${file}: no league config for ${leagueId}`)
    continue
  }
  const league = JSON.parse(readFileSync(cfgPath, 'utf8')) as LeagueConfig

  const source = `data/rankings-${leagueId}.json`
  const frozen = `${DIR}/rankings-${key}.json`
  if (existsSync(source) && !existsSync(frozen)) writeFileSync(frozen, readFileSync(source, 'utf8'))

  manifest[key] = {
    key,
    leagueId,
    leagueLabel: league.label,
    platform: league.platform,
    draftId,
    mock: true,
    teams: league.teams,
    rounds: league.rounds,
    mySlot: slot,
    startedAt: first === Infinity ? Date.now() : first,
    updatedAt: last || Date.now(),
    picks: picks.length,
    complete: picks.length >= league.teams * league.rounds,
    rankingsFile: frozen,
    // Rankings were frozen after the fact, so the board may have moved since.
    rankingsApproximate: true,
  }
  console.log(`  registered ${key}: ${picks.length} picks, slot ${slot ?? 'unset'}`)
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n')
console.log(`manifest now holds ${Object.keys(manifest).length} drafts`)
