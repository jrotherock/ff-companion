/** Snake draft position math. Closed form, so availability needs no simulation. */

export function overallFor(round: number, slot: number, teams: number): number {
  const inRound = round % 2 === 1 ? slot : teams - slot + 1
  return (round - 1) * teams + inRound
}

export function roundFor(overall: number, teams: number): number {
  return Math.floor((overall - 1) / teams) + 1
}

export function slotFor(overall: number, teams: number): number {
  const round = roundFor(overall, teams)
  const inRound = ((overall - 1) % teams) + 1
  return round % 2 === 1 ? inRound : teams - inRound + 1
}

/** Every overall pick number belonging to `slot`, in order. */
export function myPicks(slot: number, teams: number, rounds: number): number[] {
  const out: number[] = []
  for (let r = 1; r <= rounds; r++) out.push(overallFor(r, slot, teams))
  return out
}

/** The next pick at or after `afterOverall` that belongs to `slot`. */
export function nextPickFor(
  slot: number,
  teams: number,
  rounds: number,
  afterOverall: number,
): number | null {
  return myPicks(slot, teams, rounds).find((p) => p > afterOverall) ?? null
}

/** Picks the rest of the league makes between two of my turns. */
export function picksBetween(current: number, next: number): number {
  return Math.max(0, next - current - 1)
}
