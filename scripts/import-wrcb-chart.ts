/**
 * Bring a week's WR/CB chart into the state directory.
 *
 *   tsx scripts/import-wrcb-chart.ts <season> <week> <rows file> <column url>
 *
 * The rows are read off RotoBaller's four chart screenshots, one receiver per
 * line in the format chartRowsFromText documents. Every row is checked against
 * its own printed score before anything is written, and one row that fails
 * refuses the whole import: a chart with a receiver quietly missing looks
 * complete from every screen that reads it.
 *
 * The file lands in STATE_DIR, not the repository. The same chart is sold as a
 * premium tool.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { statePath } from '../src/server/paths.js'
import { chartRowsFromText, consistent } from '../src/server/wrcb.js'

const [season, week, file, link] = process.argv.slice(2)
if (!Number(season) || !Number(week) || !file) {
  console.error('usage: tsx scripts/import-wrcb-chart.ts <season> <week> <rows file> <column url>')
  process.exit(2)
}

const rows = chartRowsFromText(readFileSync(file, 'utf8'))
const bad = rows.filter((r) => !consistent(r))
if (bad.length) {
  for (const r of bad) {
    console.error(`  ${r.receiver} vs ${r.corner}: ${r.offence} - ${r.defence} = ` +
      `${(r.offence - r.defence).toFixed(2)}, printed ${r.score}`)
  }
  console.error(`refused: ${bad.length} of ${rows.length} rows disagree with their own score`)
  process.exit(1)
}

const out = statePath(`wrcb-chart-${season}-${week}.json`)
writeFileSync(out, JSON.stringify({ season: Number(season), week: Number(week), link: link ?? null, rows }, null, 1))
console.log(`${rows.length} rows, every one consistent with its score -> ${out}`)
