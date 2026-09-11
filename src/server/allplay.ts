/**
 * What the record would be if you played everybody, every week.
 *
 * A head-to-head record is two numbers stuck together: how well you played,
 * and who you happened to draw. Going 1-0 against the worst team in the league
 * while scoring the seventh most points is not a good week, and the standings
 * cannot tell you so — they are the one table in fantasy that systematically
 * hides the thing you would most want to know.
 *
 * All-play separates them. Score each week against every other team rather
 * than against one, and the draw cancels out: what is left is how you actually
 * played. The gap between that and the real record is the luck, and it is
 * worth seeing before concluding anything about a roster.
 *
 * Impossible until now. It needs every team's score every week, and the
 * browser sensor could only ever read my own team page.
 */

export interface WeekScores {
  week: number
  teams: { teamId: string; points: number }[]
}

export interface Tally {
  teamId: string
  wins: number
  losses: number
  ties: number
  /** Win rate, 0 to 1. Null before anyone has played. */
  pct: number | null
}

const pct = (w: number, l: number, t: number) =>
  w + l + t === 0 ? null : (w + t / 2) / (w + l + t)

/**
 * Every team against every other, week by week.
 *
 * Ties count as halves rather than being dropped: in a scoring system with a
 * decimal place an exact tie is rare, but a league that rounds to whole points
 * produces them often enough that discarding them would quietly flatter
 * whoever kept drawing.
 */
export function allPlay(weeks: WeekScores[]): Tally[] {
  const out = new Map<string, Tally>()
  const seen = (id: string) => {
    let t = out.get(id)
    if (!t) { t = { teamId: id, wins: 0, losses: 0, ties: 0, pct: null }; out.set(id, t) }
    return t
  }
  for (const wk of weeks) {
    for (const a of wk.teams) {
      const t = seen(a.teamId)
      for (const b of wk.teams) {
        if (a.teamId === b.teamId) continue
        if (a.points > b.points) t.wins++
        else if (a.points < b.points) t.losses++
        else t.ties++
      }
    }
  }
  for (const t of out.values()) t.pct = pct(t.wins, t.losses, t.ties)
  return [...out.values()].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
}

export interface Luck {
  teamId: string
  /** As the standings have it. */
  actual: Tally
  /** As it would be against the whole league. */
  deserved: Tally
  /**
   * Wins above or below what the scoring earned, in games.
   *
   * Stated in games rather than in win rate because a rate needs translating
   * before it means anything, and "you are a game and a half up on how you
   * have played" is a sentence somebody can act on.
   */
  games: number | null
}

/**
 * The difference between the two, which is the part nobody chose.
 *
 * Ordered by how lucky, so the two ends of the table are the two interesting
 * teams: the one whose record flatters them, and the one being robbed.
 */
export function luck(actual: Tally[], deserved: Tally[]): Luck[] {
  const by = new Map(deserved.map((t) => [t.teamId, t]))
  const out: Luck[] = []
  for (const a of actual) {
    const d = by.get(a.teamId)
    if (!d) continue
    const played = a.wins + a.losses + a.ties
    // The all-play rate, scaled to the games actually played, is what the
    // record would have been against an average draw.
    const games = a.pct == null || d.pct == null ? null
      : Number(((a.pct - d.pct) * played).toFixed(2))
    out.push({ teamId: a.teamId, actual: a, deserved: d, games })
  }
  return out.sort((x, y) => (y.games ?? 0) - (x.games ?? 0))
}

/** The standings as they stand, from the same weekly scores plus the draw. */
export function actualFrom(
  weeks: WeekScores[],
  opponentOf: (week: number, teamId: string) => string | null,
): Tally[] {
  const out = new Map<string, Tally>()
  for (const wk of weeks) {
    const points = new Map(wk.teams.map((t) => [t.teamId, t.points]))
    for (const a of wk.teams) {
      const foe = opponentOf(wk.week, a.teamId)
      if (foe == null) continue
      const theirs = points.get(foe)
      if (theirs == null) continue
      let t = out.get(a.teamId)
      if (!t) { t = { teamId: a.teamId, wins: 0, losses: 0, ties: 0, pct: null }; out.set(a.teamId, t) }
      if (a.points > theirs) t.wins++
      else if (a.points < theirs) t.losses++
      else t.ties++
    }
  }
  for (const t of out.values()) t.pct = pct(t.wins, t.losses, t.ties)
  return [...out.values()]
}
