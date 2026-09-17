/**
 * Measure how often designated players actually play, and write
 * data/play-rates.json.
 *
 *   npx tsx scripts/measure-play-rates.ts [first season] [last season]
 *
 * Ten regular seasons by default, 2016 to 2025: 2016 is the first without
 * "probable", so every season in the count speaks the same three designations.
 * Aggregate counts of public nflverse data, so the result is committed like
 * data/idp-measured.json. Rerun it once a season has finished.
 */
import { writeFileSync } from 'node:fs'
import { splitCsvLine } from '../src/server/nflverseCsv.js'
import { countSeason, type PlayRates, type Rec } from '../src/server/playRates.js'

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download'
const first = Number(process.argv[2] ?? 2016)
const last = Number(process.argv[3] ?? 2025)

async function records(url: string): Promise<Rec[]> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} for ${url}`)
  const lines = (await res.text()).split('\n').filter((l) => l.trim())
  const head = splitCsvLine(lines[0])
  return lines.slice(1).map((l) => {
    const f = splitCsvLine(l)
    return Object.fromEntries(head.map((h, i) => [h.trim(), f[i] ?? '']))
  })
}

const into: Pick<PlayRates, 'designated' | 'byPractice'> = { designated: {}, byPractice: {} }
for (let y = first; y <= last; y++) {
  const [injuries, snaps] = await Promise.all([
    records(`${BASE}/injuries/injuries_${y}.csv`),
    records(`${BASE}/snap_counts/snap_counts_${y}.csv`),
  ])
  const before = into.byPractice.DNP?.listed ?? 0
  countSeason(injuries, snaps, into)
  console.log(`${y}: ${injuries.length} report rows, ${snaps.length} snap rows`)
  void before
}

const sorted = (t: Record<string, unknown>) => Object.fromEntries(Object.entries(t).sort(([a], [b]) => a.localeCompare(b)))
const out: PlayRates = {
  seasons: [first, last],
  population: 'players who took a snap in their club\'s previous game (looking through one bye)',
  method: 'nflverse injury reports matched to nflverse snap counts, regular season; "played" is at least one ' +
    'offensive, defensive or special-teams snap that week. Keys are designation|practice, optionally ' +
    '|pos:GROUP or |body:PART; byPractice drops the designation, for reports not yet final.',
  designated: sorted(into.designated) as PlayRates['designated'],
  byPractice: sorted(into.byPractice) as PlayRates['byPractice'],
}
writeFileSync('data/play-rates.json', JSON.stringify(out, null, 1) + '\n')
console.log(`wrote data/play-rates.json: ${Object.keys(out.designated).length} designated cells, ${Object.keys(out.byPractice).length} by practice`)
