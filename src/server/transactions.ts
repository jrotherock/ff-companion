/**
 * What the rest of the league just did, filtered to what bears on you.
 *
 * The raw feed is noise: eighteen managers streaming defences produces a
 * hundred rows a week and not one of them is a decision. Three things in it
 * are worth an interruption, and this finds those and discards the rest.
 *
 *   - somebody dropped a player worth having, which is a free upgrade with a
 *     short shelf life
 *   - somebody added at a position where I am thin, which tells me who I am
 *     bidding against before the bidding rather than after
 *   - somebody touched a player I hold, because a handcuff being taken changes
 *     what my own man is worth
 *
 * None of it was visible before. The sensor read my team page, and a team page
 * says nothing about anybody else's week.
 */

export interface Move {
  id: string
  at: number
  type: 'add' | 'drop' | 'add/drop' | 'trade' | 'commish'
  /** The manager who acted, as the league names them. */
  manager: string
  added: { id: string; name: string; pos: string | null }[]
  dropped: { id: string; name: string; pos: string | null }[]
}

export interface Notable {
  move: Move
  /** Why this one survived the filter. */
  kind: 'dropped-worth-having' | 'rival-filling-my-hole' | 'touched-mine'
  /** The player the note is about. */
  player: { id: string; name: string; pos: string | null }
  headline: string
  /** For ranking against everything else that wants the screen, 0-100. */
  consequence: number
}

export interface Lens {
  /** Players I hold, across this league. */
  mine: Set<string>
  /** Positions where my lineup is thin, worst first. */
  holes: string[]
  /**
   * What a player is worth, as the board has it. Used only to decide whether a
   * drop is worth chasing — a name alone cannot say that, and "somebody
   * dropped a player" is true four times an hour.
   */
  value: (id: string) => number | null
  /** Below this, a dropped player is not news. */
  floor?: number
}

const POS = (p: { pos: string | null }) => (p.pos ?? '').toUpperCase()

/**
 * The feed, reduced to what a manager would act on.
 *
 * Ordered by consequence rather than by time. A feed sorted by clock puts a
 * defence stream above a starting back hitting waivers, which is the wrong way
 * round on every day of the week.
 */
export function notable(moves: Move[], lens: Lens): Notable[] {
  const floor = lens.floor ?? 6
  const out: Notable[] = []
  for (const m of moves) {
    for (const d of m.dropped) {
      if (lens.mine.has(d.id)) {
        out.push({
          move: m, kind: 'touched-mine', player: d,
          headline: `${m.manager} dropped ${d.name}, who is on your roster elsewhere`,
          consequence: 35,
        })
        continue
      }
      const worth = lens.value(d.id)
      if (worth == null || worth < floor) continue
      const wanted = lens.holes.includes(POS(d))
      out.push({
        move: m, kind: 'dropped-worth-having', player: d,
        headline: `${m.manager} dropped ${d.name}${wanted ? ` — you are thin at ${POS(d)}` : ''}`,
        // A free upgrade at a position of need is the most actionable thing in
        // the feed, and the window closes when somebody else claims him.
        consequence: Math.min(80, (wanted ? 55 : 30) + Math.round(worth)),
      })
    }
    for (const a of m.added) {
      if (!lens.holes.includes(POS(a))) continue
      if (lens.mine.has(a.id)) continue
      out.push({
        move: m, kind: 'rival-filling-my-hole', player: a,
        headline: `${m.manager} added ${a.name} at ${POS(a)}, where you are thin`,
        // Worth knowing, not worth waking up for: it narrows the pool rather
        // than opening one.
        consequence: 25,
      })
    }
  }
  return out
    .sort((x, y) => y.consequence - x.consequence || y.move.at - x.move.at)
}

/**
 * How busy each manager is, which is the only durable thing the feed says.
 *
 * A manager who has made thirty moves will answer a trade offer; one who has
 * made none since the draft will not, however well the squads fit. The trade
 * finder ranks on fit alone and would happily send you at the wall.
 */
export function activity(moves: Move[], since?: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of moves) {
    if (since != null && m.at < since) continue
    out.set(m.manager, (out.get(m.manager) ?? 0) + 1)
  }
  return out
}
