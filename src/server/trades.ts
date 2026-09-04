/**
 * Who has what you need, and needs what you have.
 *
 * Valuing an offer is solved everywhere; finding one is not. This does the
 * finding — which of eleven other managers is deep exactly where you are thin,
 * and thin exactly where you are deep — and stops there. It proposes a
 * conversation, not a price.
 */

export interface Squad {
  teamId: string
  manager: string
  players: { id: string; name: string; pos: string | null; projected: number | null }[]
}

export interface Fit {
  teamId: string
  manager: string
  /** What you would be asking for. */
  theyCanSpare: { pos: string; players: { name: string; projected: number | null }[] }
  /** What you would be offering. */
  youCanSpare: { pos: string; players: { name: string; projected: number | null }[] }
  /** How well it fits, for ranking. Not a valuation. */
  strength: number
  why: string
}

/**
 * Depth measured against what a lineup actually demands, so "deep at running
 * back" means more startable backs than there are places to start them — not
 * simply a lot of them.
 */
function depth(
  squad: Squad,
  required: Record<string, number>,
): Map<string, { spare: number; short: number; ranked: Squad['players'] }> {
  const out = new Map<string, { spare: number; short: number; ranked: Squad['players'] }>()
  const positions = new Set([
    ...Object.keys(required),
    ...squad.players.map((p) => (p.pos ?? '').toUpperCase()).filter(Boolean),
  ])
  for (const pos of positions) {
    const ranked = squad.players
      .filter((p) => (p.pos ?? '').toUpperCase() === pos)
      .sort((a, b) => (b.projected ?? 0) - (a.projected ?? 0))
    const need = required[pos] ?? 0
    out.set(pos, { spare: Math.max(0, ranked.length - need), short: Math.max(0, need - ranked.length), ranked })
  }
  return out
}

/**
 * How strong each squad is at a position, measured as the points its best
 * legal starters would score. Counting bodies finds nothing: every slot has
 * somebody in it, so a search for empty ones returns nothing every week.
 */
export function strengthAt(squad: Squad, pos: string, n: number): number {
  return squad.players
    .filter((p) => (p.pos ?? '').toUpperCase() === pos)
    .sort((a, b) => (b.projected ?? 0) - (a.projected ?? 0))
    .slice(0, n)
    .reduce((acc, p) => acc + (p.projected ?? 0), 0)
}

/**
 * Who is weak where, across the whole league at once. Both halves of a trade
 * need this: mine to know what to ask for, theirs to know what they would
 * actually want in return.
 */
export function weakSpots(
  squads: Squad[],
  required: Record<string, number>,
): Map<string, string[]> {
  const out = new Map<string, string[]>(squads.map((s) => [s.teamId, []]))
  for (const [pos, n] of Object.entries(required)) {
    const scored = squads.map((s) => ({ id: s.teamId, v: strengthAt(s, pos, n) }))
    const sorted = [...scored].sort((a, b) => a.v - b.v)
    const cutoff = sorted[Math.floor(sorted.length / 3)]?.v ?? 0
    const best = sorted[sorted.length - 1]?.v ?? 0
    for (const { id, v } of scored) {
      // Bottom third of the league, and behind the best by a real margin
      // rather than by a rounding difference.
      if (v <= cutoff && v < best * 0.85) out.get(id)!.push(pos)
    }
  }
  return out
}

export function findFits(
  mine: Squad,
  others: Squad[],
  required: Record<string, number>,
  /** Positions where your own starters are genuinely weak. */
  weakAt: string[] = [],
  limit = 5,
  /** Where each other manager is weak, so the offer is one they would want. */
  theirWeak: Map<string, string[]> = new Map(),
): Fit[] {
  const me = depth(mine, required)
  const myNeeds = [...me.entries()]
    .filter(([pos, d]) => d.short > 0 || weakAt.includes(pos))
    .map(([pos]) => pos)
  const mySpare = [...me.entries()].filter(([, d]) => d.spare > 0).map(([pos]) => pos)
  if (!myNeeds.length || !mySpare.length) return []

  const fits: Fit[] = []
  for (const other of others) {
    const them = depth(other, required)
    // What they can spare that I need, and the reverse. Both must hold, or it
    // is a wish rather than a trade.
    const wants = theirWeak.get(other.teamId) ?? []
    const give = myNeeds.find((pos) => (them.get(pos)?.spare ?? 0) > 0)
    const take = mySpare.find(
      (pos) => (them.get(pos)?.short ?? 0) > 0 || wants.includes(pos),
    )
    if (!give || !take || give === take) continue

    const theirs = them.get(give)!
    const ours = me.get(take)!
    // The players each side could actually part with: those past the starters.
    const theirSpare = theirs.ranked.slice(required[give] ?? 0)
    const ourSpare = ours.ranked.slice(required[take] ?? 0)
    if (!theirSpare.length || !ourSpare.length) continue

    fits.push({
      teamId: other.teamId,
      manager: other.manager,
      theyCanSpare: { pos: give, players: theirSpare.slice(0, 2).map((p) => ({ name: p.name, projected: p.projected })) },
      youCanSpare: { pos: take, players: ourSpare.slice(0, 2).map((p) => ({ name: p.name, projected: p.projected })) },
      strength: theirs.spare + (wants.includes(take) ? 2 : 0) +
        (theirSpare[0]?.projected ?? 0) / 100,
      why: `They can spare a ${give}, which is where you are thin, and they are ` +
        `${wants.includes(take) ? 'weak' : 'short'} at ${take}, where you have cover.`,
    })
  }
  return fits.sort((a, b) => b.strength - a.strength).slice(0, limit)
}
