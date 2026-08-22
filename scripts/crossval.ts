/**
 * True cross-draft validation. Parameters fitted on the 2025 Fantasy Steward
 * draft are scored on the 2025 Harker Green draft — different managers, a
 * different roster shape (3 WR), and 15 rounds instead of 13. Nothing about
 * Green was used to choose the parameters.
 */
import { readFile } from 'node:fs/promises'
import type { Player, Pos, Ranking } from '../src/kernel/types.js'

const POSES: Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST']
const FIX: Record<string, Pos | undefined> = {
  DEF: 'DST', QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K',
}

const { players } = JSON.parse(await readFile('data/players.json', 'utf8')) as { players: Player[] }
const pmap = new Map(players.map((p) => [p.id, p]))

interface Fixture {
  league: string
  teams: number
  rounds: number
  roster: Record<string, number>
  positions: string[]
}

async function load(path: string, rankingFile: string) {
  const fx = JSON.parse(await readFile(path, 'utf8')) as Fixture
  const { rankings } = JSON.parse(await readFile(rankingFile, 'utf8')) as { rankings: Ranking[] }
  const byAdp = new Map<Pos, Ranking[]>()
  const byVal = new Map<Pos, Ranking[]>()
  for (const r of rankings) {
    const p = pmap.get(r.playerId)?.pos
    if (!p) continue
    ;(byAdp.get(p) ?? byAdp.set(p, []).get(p)!).push(r)
    ;(byVal.get(p) ?? byVal.set(p, []).get(p)!).push(r)
  }
  for (const l of byAdp.values()) l.sort((a, b) => a.adp - b.adp)
  for (const l of byVal.values()) l.sort((a, b) => b.value - a.value)
  return { fx, byAdp, byVal }
}

const softmax = (s: number[], t: number) => {
  const m = Math.max(...s)
  const e = s.map((x) => Math.exp((x - m) / t))
  const z = e.reduce((a, b) => a + b, 0)
  return e.map((x) => x / z)
}

type Basis = 'value' | 'adp'

function score(
  data: Awaited<ReturnType<typeof load>>,
  basis: Basis,
  need: number,
  temp: number,
  maxRound = 99,
) {
  const { fx, byAdp, byVal } = data
  const starters = fx.roster
  const FLEX: Pos[] = ['RB', 'WR', 'TE']
  const rosters: Record<number, Record<string, number>> = {}
  const taken: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 }
  let ll = 0
  let hit = 0
  let n = 0

  for (let i = 0; i < fx.positions.length; i++) {
    const pick = i + 1
    const round = Math.floor(i / fx.teams) + 1
    const inRound = (i % fx.teams) + 1
    const slot = round % 2 === 1 ? inRound : fx.teams - inRound + 1
    const roster = (rosters[slot] ??= { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 })
    const actual = FIX[fx.positions[i]]

    if (actual && round <= maxRound) {
      const scores = POSES.map((pos) => {
        const list = (basis === 'adp' ? byAdp : byVal).get(pos) ?? []
        const cand = list[Math.min(taken[pos], list.length - 1)]
        const base =
          basis === 'adp' ? (pick - (cand?.adp ?? 400)) / 10 : (cand?.value ?? -5)
        let open = Math.max(0, (starters[pos] ?? 0) - roster[pos])
        if (open === 0 && FLEX.includes(pos)) {
          const used = FLEX.reduce((s, p) => s + Math.max(0, roster[p] - (starters[p] ?? 0)), 0)
          if (used < (starters.flex ?? 0)) open = 1 / FLEX.length
        }
        return base + need * open
      })
      const probs = softmax(scores, temp)
      const ai = POSES.indexOf(actual)
      ll += -Math.log(Math.max(1e-9, probs[ai]))
      if (probs.indexOf(Math.max(...probs)) === ai) hit++
      n++
    }
    if (actual) {
      roster[actual]++
      taken[actual]++
    }
  }
  return { ll: ll / n, acc: hit / n, n }
}

function majority(fx: Fixture, maxRound = 99) {
  const seg = fx.positions.slice(0, maxRound * fx.teams).filter((p) => FIX[p])
  const c: Record<string, number> = {}
  for (const p of seg) c[FIX[p]!] = (c[FIX[p]!] ?? 0) + 1
  return Math.max(...Object.values(c)) / seg.length
}

const steward = await load(
  'fixtures/yahoo-steward-2025-positions.json',
  'data/rankings-yahoo-steward.json',
)
const green = await load(
  'fixtures/yahoo-green-2025-positions.json',
  'data/rankings-yahoo-green.json',
)

const NEEDS = [0, 0.5, 0.8, 1.2, 1.6, 2, 2.5, 3, 4, 6, 8, 12, 20, 30]
const TEMPS = [0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24]

function fit(data: Awaited<ReturnType<typeof load>>, basis: Basis, maxRound: number) {
  let b = { ll: Infinity, acc: 0, need: 0, temp: 0 }
  for (const w of NEEDS)
    for (const t of TEMPS) {
      const r = score(data, basis, w, t, maxRound)
      if (r.ll < b.ll) b = { ...r, need: w, temp: t }
    }
  return b
}

const MAX = 10 // the range the model is actually used over
console.log(`Rounds 1-${MAX} only — the range the shipped model runs over.\n`)

for (const basis of ['adp', 'value'] as Basis[]) {
  const f = fit(steward, basis, MAX)
  const g = score(green, basis, f.need, f.temp, MAX)
  console.log(`${basis.toUpperCase()} + need`)
  console.log(`  fitted on Steward : need ${f.need}, temp ${f.temp} -> ll ${f.ll.toFixed(4)}, top-1 ${(f.acc * 100).toFixed(1)}%`)
  console.log(`  scored on Green   : ll ${g.ll.toFixed(4)}, top-1 ${(g.acc * 100).toFixed(1)}%  (n=${g.n})`)
  console.log(`  Green majority    : ${(majority(green.fx, MAX) * 100).toFixed(1)}%   uniform ll ${Math.log(6).toFixed(4)}\n`)
}

// What the shipped constants actually score, as opposed to a refit.
const SHIPPED = { need: 1.6, temp: 1.5 }
const shippedGreen = score(green, 'adp', SHIPPED.need, SHIPPED.temp, MAX)
const shippedSteward = score(steward, 'adp', SHIPPED.need, SHIPPED.temp, MAX)
console.log(`SHIPPED CONSTANTS need ${SHIPPED.need}, temp ${SHIPPED.temp}`)
console.log(`  Steward : ll ${shippedSteward.ll.toFixed(4)}, top-1 ${(shippedSteward.acc * 100).toFixed(1)}%`)
console.log(`  Green   : ll ${shippedGreen.ll.toFixed(4)}, top-1 ${(shippedGreen.acc * 100).toFixed(1)}%`)

// Refit on Green alone, to see how far apart the two drafts really want to be.
const gFit = fit(green, 'adp', MAX)
console.log(`\nGreen refit on itself : need ${gFit.need}, temp ${gFit.temp} -> ll ${gFit.ll.toFixed(4)}, top-1 ${(gFit.acc * 100).toFixed(1)}%`)
console.log(`  gap between Steward-fitted and Green-refit on Green: ${(shippedGreen.ll - gFit.ll).toFixed(4)} ll`)
