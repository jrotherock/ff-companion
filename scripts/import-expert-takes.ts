/**
 * Bring injury analysts' takes into the app — here, and on Railway with --push.
 *
 *   npx tsx --env-file-if-exists=.env scripts/import-expert-takes.ts <season> <takes file> [--push]
 *
 * The file is a JSON list of takes read by hand, one per analyst per player
 * per week: week, player, team, analyst, credential as the outlet states it,
 * outlet, call (plays, game-time, sits, out-weeks), weeks for out-weeks as
 * [fewest, most] games, a one-line note in our own words, an https link, and
 * the date it was published. Validated whole with the same rules the server
 * applies; a take from the same analyst about the same player that week
 * replaces the earlier one.
 *
 * --push sends it to WRCB_IMPORT_URL (Railway by default) under
 * WRCB_IMPORT_KEY, the key for hand-read imports.
 */
import { readFileSync } from 'node:fs'
import { ledgerFor, mergeTakes, saveLedger, validateTakes } from '../src/server/experts.js'

const args = process.argv.slice(2)
const push = args.includes('--push')
const [season, file] = args.filter((a) => a !== '--push')
if (!Number(season) || !file) {
  console.error('usage: npx tsx --env-file-if-exists=.env scripts/import-expert-takes.ts <season> <takes file> [--push]')
  process.exit(2)
}

const raw = JSON.parse(readFileSync(file, 'utf8'))
const checked = validateTakes({ season: Number(season), takes: Array.isArray(raw) ? raw : raw.takes })
if (!checked.ok) {
  for (const e of checked.errors) console.error(`  ${e}`)
  console.error('refused: nothing written')
  process.exit(1)
}
const ledger = mergeTakes(ledgerFor(checked.season), checked.takes)
console.log(`${checked.takes.length} takes checked; ${ledger.takes.length} held for ${checked.season} -> ${saveLedger(ledger)}`)

if (push) {
  const key = process.env.WRCB_IMPORT_KEY
  const base = process.env.WRCB_IMPORT_URL ?? 'https://roffco.up.railway.app'
  if (!key) {
    console.error('--push needs WRCB_IMPORT_KEY in .env, matching the variable on the Railway service')
    process.exit(1)
  }
  const res = await fetch(`${base}/api/experts/takes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-import-key': key },
    body: JSON.stringify({ season: checked.season, takes: checked.takes }),
  })
  const said = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    console.error(`${base} refused it (${res.status}):`, said)
    process.exit(1)
  }
  console.log(`pushed to ${base}: ${said.received} takes, ${said.held} held for the season`)
}
