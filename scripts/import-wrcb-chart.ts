/**
 * Bring a week's WR/CB chart into the app — here, and on Railway with --push.
 *
 *   npx tsx --env-file-if-exists=.env scripts/import-wrcb-chart.ts \
 *     <season> <week> <rows file> <column url> [--push]
 *
 * The rows are read off RotoBaller's four chart screenshots, one receiver per
 * line in the format chartRowsFromText documents. The chart is checked with
 * the same rules the server applies — every row against its own printed
 * score, all or nothing — before it is written anywhere.
 *
 * --push sends it to WRCB_IMPORT_URL (Railway by default), authorised by
 * WRCB_IMPORT_KEY from .env. That key can write a chart and nothing else, and
 * must match the WRCB_IMPORT_KEY variable set on the Railway service.
 *
 * Nothing lands in the repository. The same chart is sold as a premium tool.
 */
import { readFileSync } from 'node:fs'
import { chartRowsFromText, saveChart, validateChart } from '../src/server/wrcb.js'

const args = process.argv.slice(2)
const push = args.includes('--push')
const [season, week, file, link] = args.filter((a) => a !== '--push')
if (!Number(season) || !Number(week) || !file) {
  console.error('usage: npx tsx --env-file-if-exists=.env scripts/import-wrcb-chart.ts <season> <week> <rows file> <column url> [--push]')
  process.exit(2)
}

const checked = validateChart({
  season: Number(season), week: Number(week), link: link ?? null,
  rows: chartRowsFromText(readFileSync(file, 'utf8')),
})
if (!checked.ok) {
  for (const e of checked.errors) console.error(`  ${e}`)
  console.error('refused: nothing written')
  process.exit(1)
}
const chart = checked.chart
console.log(`${chart.rows.length} rows, every one consistent with its score -> ${saveChart(chart)}`)

if (push) {
  const key = process.env.WRCB_IMPORT_KEY
  const base = process.env.WRCB_IMPORT_URL ?? 'https://roffco.up.railway.app'
  if (!key) {
    console.error('--push needs WRCB_IMPORT_KEY in .env, matching the variable on the Railway service')
    process.exit(1)
  }
  const res = await fetch(`${base}/api/wrcb/chart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-import-key': key },
    body: JSON.stringify(chart),
  })
  const said = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    console.error(`${base} refused it (${res.status}):`, said)
    process.exit(1)
  }
  console.log(`pushed to ${base}: ${said.rows} rows for week ${said.week}`)
}
