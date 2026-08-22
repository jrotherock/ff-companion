/**
 * Calibrates the opponent model against two independent targets.
 *
 * 1. TEMPERATURE against ADP. ADP is the aggregate of thousands of real drafts,
 *    so with no roster information the model must reproduce it. If it does not,
 *    the sharpness is wrong before any roster signal is added.
 *
 * 2. NEED_WEIGHT against the 2025 draft from this same league. Player values
 *    from 2025 are unavailable, but the *position* taken at each pick is, and
 *    that is exactly what the need term predicts.
 *
 * The control matters more than either: a need-blind model is scored alongside,
 * so we find out whether modelling need earns its place at all.
 */
import { readFile } from 'node:fs/promises'
import type { Player, Pos, Ranking } from '../src/kernel/types.js'

const POSES: Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST']
const FIX_POS: Record<string, Pos> = { DEF: 'DST', QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K' }

const league = JSON.parse(await readFile('data/leagues/yahoo-steward.json', 'utf8'))
const { players } = JSON.parse(await readFile('data/players.json', 'utf8')) as { players: Player[] }
const { rankings } = JSON.parse(await readFile('data/rankings-yahoo-steward.json', 'utf8')) as {
  rankings: Ranking[]
}
const fixture = JSON.parse(
  await readFile('fixtures/yahoo-steward-2025-positions.json', 'utf8'),
) as { positions: string[]; teams: number; rounds: number }

const pmap = new Map(players.map((p) => [p.id, p]))
const posOf = (id: string) => pmap.get(id)?.pos

/** Players at each position, best value first. */
const byPos = new Map<Pos, Ranking[]>()
for (const r of rankings) {
  const p = posOf(r.playerId)
  if (!p) continue
  ;(byPos.get(p) ?? byPos.set(p, []).get(p)!).push(r)
}
for (const list of byPos.values()) list.sort((a, b) => b.value - a.value)

const softmax = (scores: number[], temp: number): number[] => {
  const max = Math.max(...scores)
  const e = scores.map((s) => Math.exp((s - max) / temp))
  const z = e.reduce((a, b) => a + b, 0)
  return e.map((x) => x / z)
}

// ---------------------------------------------------------------- target 1
/**
 * With empty rosters the model has no need signal, so the order it implies must
 * match ADP. Measured as mean absolute error between the model's expected pick
 * number and the player's actual ADP, over the players who actually get drafted.
 */
function adpFit(temp: number): number {
  const pool = [...rankings].sort((a, b) => b.value - a.value)
  const taken = new Map<string, number>()
  const expectedPick = new Map<string, number>()
  const totalPicks = league.teams * league.rounds

  for (let pick = 1; pick <= totalPicks; pick++) {
    const live = pool.filter((r) => (taken.get(r.playerId) ?? 0) < 0.999)
    if (!live.length) break
    const probs = softmax(
      live.map((r) => r.value),
      temp,
    )
    live.forEach((r, i) => {
      const p = probs[i] * (1 - (taken.get(r.playerId) ?? 0))
      taken.set(r.playerId, Math.min(1, (taken.get(r.playerId) ?? 0) + p))
      // Expected pick number is the probability-weighted mean of when he goes.
      expectedPick.set(r.playerId, (expectedPick.get(r.playerId) ?? 0) + p * pick)
    })
  }

  let err = 0
  let n = 0
  for (const r of rankings) {
    if (r.adp > totalPicks) continue
    const ep = expectedPick.get(r.playerId)
    const mass = taken.get(r.playerId) ?? 0
    if (!ep || mass < 0.5) continue
    err += Math.abs(ep / mass - r.adp)
    n++
  }
  return n ? err / n : Infinity
}

// ---------------------------------------------------------------- target 2
/**
 * Replays the 2025 draft. At each pick the drafting team's roster is rebuilt
 * from the picks before it, and the model predicts which position goes next.
 * Scored by log-loss against what was actually taken.
 */
function positionFit(needWeight: number, temp: number): { logloss: number; top1: number } {
  const { positions, teams } = fixture
  const starters: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 }
  const flexEligible: Pos[] = ['RB', 'WR', 'TE']
  const rosters: Record<number, Record<string, number>> = {}
  const takenAtPos: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 }

  let logloss = 0
  let correct = 0
  let scored = 0

  for (let i = 0; i < positions.length; i++) {
    const pick = i + 1
    const round = Math.floor(i / teams) + 1
    const inRound = (i % teams) + 1
    const slot = round % 2 === 1 ? inRound : teams - inRound + 1
    const roster = (rosters[slot] ??= { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 })

    // Best value still on the board at each position, approximated from the
    // 2026 curve at the same positional depth.
    const scores: number[] = []
    const open: number[] = []
    for (const pos of POSES) {
      const list = byPos.get(pos) ?? []
      const idx = Math.min(takenAtPos[pos], list.length - 1)
      const v = list[idx]?.value ?? -5
      const filled = roster[pos]
      let openStarters = Math.max(0, (starters[pos] ?? 0) - filled)
      if (openStarters === 0 && flexEligible.includes(pos)) {
        const flexUsed = flexEligible.reduce(
          (s, p) => s + Math.max(0, roster[p] - (starters[p] ?? 0)),
          0,
        )
        if (flexUsed < 1) openStarters = 1 / flexEligible.length
      }
      scores.push(v + needWeight * openStarters)
      open.push(openStarters)
    }

    const probs = softmax(scores, temp)
    const actual = FIX_POS[positions[i]]
    const ai = POSES.indexOf(actual)
    if (ai >= 0) {
      logloss += -Math.log(Math.max(1e-9, probs[ai]))
      const best = probs.indexOf(Math.max(...probs))
      if (best === ai) correct++
      scored++
    }
    roster[actual] = (roster[actual] ?? 0) + 1
    takenAtPos[actual] = (takenAtPos[actual] ?? 0) + 1
    void pick
    void open
  }
  return { logloss: logloss / scored, top1: correct / scored }
}

// ---------------------------------------------------------------- run
console.log('TARGET 1 — reproduce ADP with no roster information')
console.log('  temp    mean |expected pick - ADP|')
let bestTemp = 0.35
let bestErr = Infinity
for (const t of [0.15, 0.25, 0.35, 0.5, 0.7, 0.9, 1.2, 1.6, 2.2, 3.0]) {
  const e = adpFit(t)
  if (e < bestErr) {
    bestErr = e
    bestTemp = t
  }
  console.log(`  ${t.toFixed(2).padStart(5)}   ${e.toFixed(2)}`)
}
console.log(`  -> best temperature ${bestTemp} (MAE ${bestErr.toFixed(2)} picks)\n`)

console.log('TARGET 2 — predict the position taken, 2025 draft, 156 picks')
console.log('  needWeight   logloss   top-1 accuracy')
let bestNeed = 0
let bestLL = Infinity
for (const w of [0, 0.25, 0.5, 0.8, 1.2, 1.6, 2.0, 2.5, 3.0, 4.0, 5.0]) {
  const { logloss, top1 } = positionFit(w, bestTemp)
  if (logloss < bestLL) {
    bestLL = logloss
    bestNeed = w
  }
  const flag = w === 0 ? '   <- need-blind control' : ''
  console.log(
    `  ${w.toFixed(2).padStart(9)}   ${logloss.toFixed(4)}   ${(top1 * 100).toFixed(1)}%${flag}`,
  )
}
const control = positionFit(0, bestTemp)
console.log(`\n  -> best needWeight ${bestNeed} (logloss ${bestLL.toFixed(4)})`)
console.log(
  `     vs need-blind control ${control.logloss.toFixed(4)} — ` +
    `${(((control.logloss - bestLL) / control.logloss) * 100).toFixed(1)}% better`,
)

// A uniform-over-6-positions baseline, to check the model beats guessing.
console.log(`     vs uniform guess ${Math.log(6).toFixed(4)}`)
