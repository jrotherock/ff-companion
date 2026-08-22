import type { LeagueConfig, Player, PlayerId, Pos, PositionNeed, Roster, RosterSlotState } from './types.js'

export function emptyRoster(league: LeagueConfig): Roster {
  const slots: RosterSlotState[] = []
  for (const [pos, count] of Object.entries(league.starters)) {
    for (let i = 0; i < (count ?? 0); i++) {
      slots.push({ name: pos, eligible: [pos as Pos], filled: null })
    }
  }
  for (const f of league.flex) {
    for (let i = 0; i < f.count; i++) {
      slots.push({ name: f.name, eligible: f.eligible, filled: null })
    }
  }
  return { slots, bench: [], byPos: {} }
}

/**
 * Fills dedicated slots before flex so a flex-eligible player never displaces
 * himself, then overflows to the bench.
 */
export function buildRoster(
  league: LeagueConfig,
  playerIds: PlayerId[],
  players: Map<PlayerId, Player>,
  valueOf: (id: PlayerId) => number,
): Roster {
  const roster = emptyRoster(league)
  const sorted = [...playerIds].sort((a, b) => valueOf(b) - valueOf(a))

  for (const id of sorted) {
    const pos = players.get(id)?.pos
    if (!pos) {
      roster.bench.push(id)
      continue
    }
    ;(roster.byPos[pos] ??= []).push(id)

    const dedicated = roster.slots.find(
      (s) => s.filled === null && s.eligible.length === 1 && s.eligible[0] === pos,
    )
    const flex = roster.slots.find((s) => s.filled === null && s.eligible.length > 1 && s.eligible.includes(pos))
    const target = dedicated ?? flex
    if (target) target.filled = id
    else roster.bench.push(id)
  }
  return roster
}

export function needs(
  roster: Roster,
  league: LeagueConfig,
  picksRemaining: number,
): PositionNeed[] {
  const open = new Map<Pos, number>()
  for (const s of roster.slots) {
    if (s.filled !== null) continue
    for (const p of s.eligible) open.set(p, (open.get(p) ?? 0) + 1 / s.eligible.length)
  }

  const totalOpen = roster.slots.filter((s) => s.filled === null).length
  return [...open.entries()]
    .map(([pos, openStarters]) => ({
      pos,
      openStarters: Math.round(openStarters * 10) / 10,
      // Urgency rises as open starters approach the picks left to fill them.
      urgency: picksRemaining <= 0 ? 1 : Math.min(1, (totalOpen / picksRemaining) * (openStarters / Math.max(1, totalOpen)) * 3),
    }))
    .sort((a, b) => b.urgency - a.urgency)
}

/** Starters sharing a bye week, which silently costs a week of lineup. */
export function byeConflicts(
  roster: Roster,
  players: Map<PlayerId, Player>,
): { week: number; playerIds: PlayerId[] }[] {
  const byWeek = new Map<number, PlayerId[]>()
  for (const s of roster.slots) {
    if (!s.filled) continue
    const bye = players.get(s.filled)?.byeWeek
    if (bye == null) continue
    ;(byWeek.get(bye) ?? byWeek.set(bye, []).get(bye)!).push(s.filled)
  }
  return [...byWeek.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([week, playerIds]) => ({ week, playerIds }))
    .sort((a, b) => b.playerIds.length - a.playerIds.length)
}

export function rosterFull(roster: Roster, league: LeagueConfig): boolean {
  const filled = roster.slots.filter((s) => s.filled).length + roster.bench.length
  return filled >= roster.slots.length + league.benchSize
}
