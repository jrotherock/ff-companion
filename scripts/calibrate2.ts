/**
 * Decisive test: what do opponents actually draft by?
 *
 * The first calibration showed a VBD-value-driven opponent model cannot
 * reproduce ADP, which is suspicious because ADP *is* aggregate real drafting.
 * This scores five models against the 2025 draft's position sequence to find
 * out which signal — value, ADP, or roster need — is doing the work.
 */
import { readFile } from 'node:fs/promises'
import type { Player, Pos, Ranking } from '../src/kernel/types.js'

const POSES: Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST']
const FIX: Record<string, Pos> = { DEF: 'DST', QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K' }

const { players } = JSON.parse(await readFile('data/players.json', 'utf8')) as { players: Player[] }
const { rankings } = JSON.parse(await readFile('data/rankings-yahoo-steward.json', 'utf8')) as {
  rankings: Ranking[]
}
const fixture = JSON.parse(
  await readFile('fixtures/yahoo-steward-2025-positions.json', 'utf8'),
) as { positions: string[]; teams: number }

const pmap = new Map(players.map((p) => [p.id, p]))
const byPosValue = new Map<Pos, Ranking[]>()
const byPosAdp = new Map<Pos, Ranking[]>()
for (const r of rankings) {
  const p = pmap.get(r.playerId)?.pos
  if (!p) continue
  ;(byPosValue.get(p) ?? byPosValue.set(p, []).get(p)!).push(r)
  ;(byPosAdp.get(p) ?? byPosAdp.set(p, []).get(p)!).push(r)
}
for (const l of byPosValue.values()) l.sort((a, b) => b.value - a.value)
for (const l of byPosAdp.values()) l.sort((a, b) => a.adp - b.adp)

const softmax = (s: number[], t: number) => {
  const m = Math.max(...s)
  const e = s.map((x) => Math.exp((x - m) / t))
  const z = e.reduce((a, b) => a + b, 0)
  return e.map((x) => x / z)
}

const STARTERS: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 }
const FLEX: Pos[] = ['RB', 'WR', 'TE']

type Basis = 'value' | 'adp' | 'none'

function run(basis: Basis, needWeight: number, temp: number, range?: [number, number]) {
  const { positions, teams } = fixture
  const rosters: Record<number, Record<string, number>> = {}
  const taken: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 }
  let ll = 0
  let hit = 0
  let n = 0

  for (let i = 0; i < positions.length; i++) {
    const pick = i + 1
    const round = Math.floor(i / teams) + 1
    const inRound = (i % teams) + 1
    const slot = round % 2 === 1 ? inRound : teams - inRound + 1
    const roster = (rosters[slot] ??= { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 })

    const scores = POSES.map((pos) => {
      let base = 0
      if (basis === 'value') {
        const l = byPosValue.get(pos) ?? []
        base = l[Math.min(taken[pos], l.length - 1)]?.value ?? -5
      } else if (basis === 'adp') {
        const l = byPosAdp.get(pos) ?? []
        const adp = l[Math.min(taken[pos], l.length - 1)]?.adp ?? 400
        // How overdue the best remaining player at this position is. Positive
        // means the room already expects him gone.
        base = (pick - adp) / 10
      }
      let open = Math.max(0, (STARTERS[pos] ?? 0) - roster[pos])
      if (open === 0 && FLEX.includes(pos)) {
        const used = FLEX.reduce((s, p) => s + Math.max(0, roster[p] - (STARTERS[p] ?? 0)), 0)
        if (used < 1) open = 1 / FLEX.length
      }
      return base + needWeight * open
    })

    const probs = softmax(scores, temp)
    const actual = FIX[positions[i]]
    const ai = POSES.indexOf(actual)
    // The draft still has to be replayed in full to keep rosters correct, but
    // only picks inside the range are scored.
    if (!range || (pick >= range[0] && pick <= range[1])) {
      ll += -Math.log(Math.max(1e-9, probs[ai]))
      if (probs.indexOf(Math.max(...probs)) === ai) hit++
      n++
    }
    roster[actual]++
    taken[actual]++
  }
  return { ll: ll / n, acc: hit / n }
}

function best(basis: Basis, needs: number[], temps: number[], range?: [number, number]) {
  let b = { ll: Infinity, acc: 0, need: 0, temp: 0 }
  for (const w of needs)
    for (const t of temps) {
      const r = run(basis, w, t, range)
      if (r.ll < b.ll) b = { ...r, need: w, temp: t }
    }
  return b
}

const NEEDS = [0, 0.25, 0.5, 0.8, 1.2, 1.6, 2, 2.5, 3, 4, 5, 6, 8, 10, 14, 20, 30]
// Value spans roughly +/-5 while the ADP term spans +/-30, so the sweep has to
// be wide enough to be fair to both bases.
const TEMPS = [0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]

// Always guessing the most common position is the bar any model must clear.
const counts: Record<string, number> = {}
for (const p of fixture.positions) counts[FIX[p]] = (counts[FIX[p]] ?? 0) + 1
const majority = Math.max(...Object.values(counts)) / fixture.positions.length

console.log('Scored on the real 2025 draft — 156 picks, same league\n')
console.log('  model                          logloss   top-1     vs uniform')
console.log(`  uniform over 6 positions        ${Math.log(6).toFixed(4)}   16.7%     —`)
console.log(
  `  always guess WR (majority)        —      ${(majority * 100).toFixed(1)}%     —`,
)

const rows: [string, ReturnType<typeof best>][] = [
  ['need only (no player signal)', best('none', NEEDS, TEMPS)],
  ['value only', best('value', [0], TEMPS)],
  ['value + need', best('value', NEEDS, TEMPS)],
  ['ADP only', best('adp', [0], TEMPS)],
  ['ADP + need', best('adp', NEEDS, TEMPS)],
]
for (const [label, r] of rows) {
  const gain = ((Math.log(6) - r.ll) / Math.log(6)) * 100
  console.log(
    `  ${label.padEnd(30)} ${r.ll.toFixed(4)}   ${(r.acc * 100).toFixed(1)}%     ` +
      `${gain.toFixed(1)}% better   [need ${r.need}, temp ${r.temp}]`,
  )
}


// ------------------------------------------------- hold-out validation
// Two parameters fitted on 156 picks from a single draft will overfit unless
// checked. Fit on the first seven rounds, score on the last six.
const TRAIN: [number, number] = [1, 84]
const TEST: [number, number] = [85, 156]
console.log('\nHOLD-OUT — fit on rounds 1-7, scored on rounds 8-13')
console.log('  model            fitted params        train ll   TEST ll   TEST top-1')
for (const basis of ['value', 'adp'] as Basis[]) {
  const fit = best(basis, NEEDS, TEMPS, TRAIN)
  const test = run(basis, fit.need, fit.temp, TEST)
  console.log(
    `  ${(basis + ' + need').padEnd(16)} need ${String(fit.need).padEnd(4)} temp ${String(fit.temp).padEnd(4)}   ` +
      `${fit.ll.toFixed(4)}    ${test.ll.toFixed(4)}    ${(test.acc * 100).toFixed(1)}%`,
  )
}
// What the whole-draft fit scores on the same test window, to see the gap.
const whole = best('adp', NEEDS, TEMPS)
const wholeOnTest = run('adp', whole.need, whole.temp, TEST)
console.log(
  `  adp fitted on ALL   need ${whole.need} temp ${whole.temp}      ${whole.ll.toFixed(4)}    ` +
    `${wholeOnTest.ll.toFixed(4)}    ${(wholeOnTest.acc * 100).toFixed(1)}%`,
)
const majorityTest = (() => {
  const seg = fixture.positions.slice(84)
  const c: Record<string, number> = {}
  for (const p of seg) c[FIX[p]] = (c[FIX[p]] ?? 0) + 1
  return Math.max(...Object.values(c)) / seg.length
})()
console.log(`  majority baseline on the same test window: ${(majorityTest * 100).toFixed(1)}%`)


// ------------------------------------------------- phase analysis
// Rounds 1-3 and rounds 11-13 are different games: early picks are best-player
// -available, late picks are pure slot filling. Fit each window separately to
// see whether one parameter set can describe both.
console.log('\nPHASE — fit and score inside the same window (in-sample, shows regime)')
console.log('  window        best need  temp    ll      top-1')
const windows: [string, [number, number]][] = [
  ['rounds 1-4', [1, 48]],
  ['rounds 5-8', [49, 96]],
  ['rounds 9-13', [97, 156]],
]
for (const [label, w] of windows) {
  const f = best('adp', NEEDS, TEMPS, w)
  console.log(`  ${label.padEnd(13)} ${String(f.need).padEnd(10)} ${String(f.temp).padEnd(7)} ${f.ll.toFixed(4)}  ${(f.acc*100).toFixed(1)}%`)
}

console.log('\nGENERALISATION inside the decision-relevant range only')
console.log('  (survival only matters while good players are still coming off the board)')
const early: [number, number] = [1, 48]
const mid: [number, number] = [49, 96]
for (const basis of ['value','adp'] as Basis[]) {
  const f = best(basis, NEEDS, TEMPS, early)
  const t = run(basis, f.need, f.temp, mid)
  const majMid = (() => {
    const seg = fixture.positions.slice(48, 96)
    const c: Record<string, number> = {}
    for (const p of seg) c[FIX[p]] = (c[FIX[p]] ?? 0) + 1
    return Math.max(...Object.values(c)) / seg.length
  })()
  console.log(
    `  ${(basis+' + need').padEnd(12)} fit R1-4 [need ${f.need}, temp ${f.temp}] -> R5-8 ll ${t.ll.toFixed(4)}  top-1 ${(t.acc*100).toFixed(1)}%  (majority ${(majMid*100).toFixed(1)}%)`
  )
}
