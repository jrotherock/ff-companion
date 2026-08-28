import type { Player, PlayerId, Pos } from './types.js'

/**
 * Late-round archetypes.
 *
 * Once every starting slot is filled, the remaining picks are not about this
 * week's lineup — they are lottery tickets and insurance. Ranking them by value
 * over replacement misses the point entirely, because a back-up running back is
 * worth nothing until the man ahead of him is hurt, at which point he is worth
 * a great deal. The board cannot price that, so it consistently recommends
 * veteran depth nobody actually wants.
 *
 * These are the two archetypes worth the picks, named so the app can stop
 * arguing with a deliberate strategy.
 */

export type Archetype = 'rookie' | 'handcuff' | 'backup'

export interface ArchetypeInfo {
  kinds: Archetype[]
  /** For a handcuff, the starter he sits behind. */
  behind: { id: PlayerId; name: string; mine: boolean } | null
  label: string
}

const NONE: ArchetypeInfo = { kinds: [], behind: null, label: '' }

/**
 * A back-up on the same team as a running back you already own is insurance on
 * an asset you have paid for; the same player on another roster is a lottery
 * ticket. Both are worth taking late, but the first is worth more.
 */
export function classify(
  player: Player | undefined,
  players: Map<PlayerId, Player>,
  myIds: PlayerId[],
  /**
   * Backfield order by ADP, used only where the depth chart has nothing. It
   * cannot be the primary source: a handcuff is precisely the player nobody
   * drafts until the starter is hurt, so ADP is silent on most of them.
   */
  backfieldOrder?: Map<string, PlayerId[]>,
): ArchetypeInfo {
  if (!player) return NONE
  const kinds: Archetype[] = []
  if (player.yearsExp === 0) kinds.push('rookie')

  /*
   * The depth chart is the right source after all, and ADP is the wrong one:
   * seventeen of the thirty-two second-string backs have no ADP at all, because
   * nobody drafts a handcuff until the starter is hurt. Ordering a backfield by
   * ADP therefore cannot see the very players this is looking for.
   *
   * ADP survives only as a fallback for teams the depth chart has nothing on.
   */
  let behind: ArchetypeInfo['behind'] = null
  if (player.pos === 'RB') {
    const depth = player.depthOrder ?? 0
    const backfield = [...players.values()].filter((p) => p.pos === 'RB' && p.team === player.team)
    let starter: Player | undefined
    if (depth >= 2) starter = backfield.find((p) => p.depthOrder === 1)
    /*
     * ADP only speaks where the depth chart is silent about the whole backfield.
     * Consulting it per player made Chuba Hubbard and Jonathon Brooks back up
     * each other: Hubbard is the listed starter, but Brooks goes earlier, so
     * asking the market about a man the depth chart had already answered for
     * inverted him.
     */
    if (!starter && depth === 0 && backfieldOrder && !backfield.some((p) => p.depthOrder != null)) {
      const order = backfieldOrder.get(player.team) ?? []
      if (order.indexOf(player.id) > 0) starter = players.get(order[0])
    }
    if (starter && starter.id !== player.id) {
      const mine = myIds.includes(starter.id)
      behind = { id: starter.id, name: starter.name, mine }
      kinds.push(mine ? 'handcuff' : 'backup')
    }
  }

  if (!kinds.length) return NONE
  const label = kinds.includes('handcuff')
    ? `handcuff to ${behind?.name ?? 'your back'}`
    : kinds.includes('rookie') && kinds.includes('backup')
      ? 'rookie back-up'
      : kinds.includes('rookie')
        ? 'rookie'
        : `back-up behind ${behind?.name ?? 'the starter'}`
  return { kinds, behind, label }
}

/**
 * The window where these archetypes are the right pick: after every starting
 * slot is filled, and before the rounds reserved for kicker and defence.
 */
export function inLateWindow(opts: {
  openStarterSlots: number
  picksRemaining: number
  reservedForLateSlots: number
}): boolean {
  const { openStarterSlots, picksRemaining, reservedForLateSlots } = opts
  if (openStarterSlots > 0) return false
  return picksRemaining > reservedForLateSlots
}

/**
 * Ranks archetypes so the strongest kind of late pick sorts first.
 *
 * Insurance on a back you already paid for is worth more than the same ticket
 * on someone else's starter, so an owned handcuff clears the field outright
 * rather than edging ahead — but the others still appear behind it, because
 * some drafts leave nothing of yours worth insuring.
 */
export function archetypeRank(info: ArchetypeInfo, prefer: Archetype[]): number {
  if (!info.kinds.length) return 0
  let best = 0
  for (const k of info.kinds) {
    const i = prefer.indexOf(k)
    if (i >= 0) best = Math.max(best, prefer.length - i)
  }
  if (info.behind?.mine) best += prefer.length
  return best
}

/** Each team's backs in the order the market drafts them. */
export function backfieldByAdp(
  rankings: { playerId: PlayerId; adp: number }[],
  players: Map<PlayerId, Player>,
): Map<string, PlayerId[]> {
  const byTeam = new Map<string, { id: PlayerId; adp: number }[]>()
  for (const r of rankings) {
    const p = players.get(r.playerId)
    if (!p || p.pos !== 'RB' || !p.team) continue
    ;(byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)!).push({ id: r.playerId, adp: r.adp })
  }
  const out = new Map<string, PlayerId[]>()
  for (const [team, list] of byTeam) {
    out.set(
      team,
      list.sort((a, b) => a.adp - b.adp).map((x) => x.id),
    )
  }
  return out
}

export const POS_FOR_ARCHETYPE: Record<Archetype, Pos[]> = {
  rookie: ['WR', 'RB', 'TE', 'QB'],
  handcuff: ['RB'],
  backup: ['RB'],
}
