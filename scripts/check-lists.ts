/**
 * Do the hand-kept lists still describe the world?
 *
 * A handcuff order is written once and the season moves underneath it. MarShawn
 * Lloyd was third on this list as Josh Jacobs's back-up and is now Green Bay's
 * starter; Rhamondre Stevenson was first and leads New England. Neither is a
 * handcuff any more, and a list that still calls them one quietly recommends
 * the wrong players.
 *
 *   npx tsx scripts/check-lists.ts
 */
import { readFileSync, readdirSync } from 'node:fs'
import type { Player } from '../src/kernel/types.js'

const { players } = JSON.parse(readFileSync('data/players.json', 'utf8')) as { players: Player[] }
const byName = new Map(players.map((p) => [p.name.toLowerCase(), p]))
const OUT = ['Injured Reserve', 'IR', 'PUP', 'NFI', 'Suspended', 'Out', 'Doubtful']

let problems = 0
for (const file of readdirSync('data/preferences').filter((f) => f.endsWith('.rules.json'))) {
  const rules = JSON.parse(readFileSync(`data/preferences/${file}`, 'utf8')) as { rules: any[] }
  const lt = rules.rules.find((r) => r.kind === 'lateTargets')
  if (!lt) continue
  const notes: string[] = []

  for (const name of (lt.handcuffOrder ?? []) as string[]) {
    const p = byName.get(name.toLowerCase())
    if (!p) { notes.push(`${name} — not in the player map`); continue }
    if ((p.depthOrder ?? 9) === 1) {
      notes.push(`${name} — now ${p.team}'s starter, so not a handcuff`)
    }
    const bad = p.injuryStatus ?? p.status ?? ''
    if (OUT.includes(bad)) notes.push(`${name} — ${bad}${p.injuryBody ? ` (${p.injuryBody})` : ''}`)
  }

  for (const name of (lt.rookieShortlist ?? []) as string[]) {
    const p = byName.get(name.toLowerCase())
    if (!p) { notes.push(`${name} — not in the player map`); continue }
    if ((p.yearsExp ?? 0) !== 0) notes.push(`${name} — no longer a rookie`)
    const bad = p.injuryStatus ?? p.status ?? ''
    if (OUT.includes(bad)) notes.push(`${name} — ${bad}${p.injuryBody ? ` (${p.injuryBody})` : ''}`)
  }

  if (notes.length) {
    problems += notes.length
    console.log(`\n${file.replace('.rules.json', '')}`)
    for (const n of [...new Set(notes)]) console.log(`  · ${n}`)
  }
}
console.log(problems ? `\n${problems} entries worth revisiting` : '\nlists still describe the world')
