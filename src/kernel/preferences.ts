import type { LeagueConfig, PlayerId, Pos, Roster } from './types.js'

/**
 * Personal preference is kept deliberately separate from valuation. The model
 * says what a player is worth; these say what you want. They are surfaced as
 * tags and warnings rather than folded into the value, so the board never
 * quietly lies about a player because you dislike him.
 */

export type Tag = 'like' | 'avoid' | 'target' | 'strategy'

export interface StrategyRule {
  id: string
  label: string
  note: string
}

/** Prefer certain positions in the opening rounds. */
export interface OpenerRule extends StrategyRule {
  kind: 'openers'
  throughRound: number
  prefer: Pos[]
}

/**
 * A shape the roster should reach, or should not.
 *
 * `avoid` warns when you are heading somewhere unwanted; `require` warns when
 * you are about to run out of rounds to reach somewhere wanted. Green starts
 * three receivers, so two backs and three receivers by round five is a floor
 * rather than a preference.
 */
export interface CompositionRule extends StrategyRule {
  kind: 'composition'
  /** Minimum counts to have reached by `throughRound`. */
  require?: Partial<Record<Pos, number>>
  throughRound: number
  /** Exact starter counts to avoid ending the window with. */
  avoid: Partial<Record<Pos, number>>
}

/** Shape appetite at a position: skip the top, or catch a specific window. */
export interface PositionWindowRule extends StrategyRule {
  kind: 'positionWindow'
  pos: Pos
  /** Do not take this position before these players are off the board. */
  afterGone?: string[]
  /** Warn when a run threatens to empty the position. */
  runAlert?: boolean
  /** Fallback names to take late once `afterGone` has cleared. */
  lateTargets?: string[]
}

/** Have at least `count` of a position started by the end of `byRound`. */
export interface DeadlineRule extends StrategyRule {
  kind: 'deadline'
  pos: Pos
  count: number
  byRound: number
  /** Round from which the reminder starts appearing. */
  warnFromRound?: number
}

/**
 * What to hunt once the starting lineup is full. Value over replacement cannot
 * price a back-up who is worth nothing until an injury, so without this the
 * board keeps recommending veteran depth through the rounds you spend on
 * lottery tickets.
 */
export interface LateTargetRule extends StrategyRule {
  kind: 'lateTargets'
  /** Strongest first. */
  prefer: ('rookie' | 'handcuff' | 'backup')[]
  /** Picks kept back for kicker and defence at the very end. */
  reserveLastRounds: number
  /**
   * Only the best few are worth a pick. Every rookie is a lottery ticket, but
   * most are not worth one — without a cap the board fills the late rounds with
   * whoever happens to be a rookie rather than the ones actually worth having.
   */
  topRookies?: number
  /** Positions where a rookie is worth the ticket. */
  rookiePositions?: Pos[]
  /**
   * Named rookies worth a pick. The board ranks rookies by projection, which in
   * a thin class surfaces names nobody would take — so when this is set it wins
   * outright over the board's own ordering.
   */
  rookieShortlist?: string[]
  /**
   * Handcuffs in the order you want them, best first. Insurance on a back you
   * already own still wins outright — this only settles the rest, which are
   * otherwise all priced at the floor and so arrive in no order at all.
   */
  handcuffOrder?: string[]
  /**
   * Back-ups behind other people's starters. Worth having when nothing of yours
   * is left to insure, but always ranked beneath your own handcuffs.
   */
  includeUnownedBackups?: boolean
  /** Cap on those, since only the best few are worth a pick. */
  topBackups?: number
}

/**
 * Availability, for a league that has to score from week one.
 *
 * The two designations are not the same thing and must not be treated as one.
 * In late August fifty-nine ranked players are Questionable — McCaffrey, Chase
 * and Nacua among them — so filtering on that would delete the top of the board
 * to no purpose. A real absence is a much shorter list, and only that list is
 * withheld; Questionable is shown as a note and left to the drafter.
 */
export interface AvailabilityRule extends StrategyRule {
  kind: 'availability'
  /** Season-long designations that keep a player off the board entirely. */
  hardAvoid: string[]
  /** Shown as a note rather than acted on. */
  flagOnly: string[]
}

/**
 * The order the mandatory slots come off at the end.
 *
 * It had been emergent rather than stated: defence sits a round earlier than
 * kicker on the board, so the pick order fell out of ADP and nothing said why.
 * Worth writing down, because the reason is not obvious — defences separate
 * more than kickers do, so taking the kicker first risks the defence you wanted
 * and gains nothing.
 */
export interface LastRoundsRule extends StrategyRule {
  kind: 'lastRounds'
  /** Positions in the order they should be taken, first to last. */
  order: Pos[]
}

export type Rule =
  | OpenerRule
  | CompositionRule
  | PositionWindowRule
  | DeadlineRule
  | LateTargetRule
  | AvailabilityRule
  | LastRoundsRule

export interface Preferences {
  leagueId: string
  /** Ordered — this is the manager's own ranking, best first. */
  likes: PlayerId[]
  avoids: PlayerId[]
  rules: Rule[]
  source?: string
  fetchedAt?: string
}

export interface PlayerFlags {
  tags: Tag[]
  /** Preference rank when the player is on the likes list. */
  likeRank: number | null
  notes: string[]
}

export interface StrategyAdvice {
  ruleId: string
  label: string
  severity: 'info' | 'warn'
  message: string
}

const EMPTY: PlayerFlags = { tags: [], likeRank: null, notes: [] }

export class PreferenceIndex {
  private likeRank = new Map<PlayerId, number>()
  private avoid = new Set<PlayerId>()
  private lateTargets = new Set<PlayerId>()

  constructor(
    readonly prefs: Preferences | null,
    resolve: (name: string) => PlayerId | null,
  ) {
    if (!prefs) return
    prefs.likes.forEach((id, i) => this.likeRank.set(id, i + 1))
    prefs.avoids.forEach((id) => this.avoid.add(id))
    for (const rule of prefs.rules) {
      if (rule.kind !== 'positionWindow' || !rule.lateTargets) continue
      for (const name of rule.lateTargets) {
        const id = resolve(name)
        if (id) this.lateTargets.add(id)
      }
    }
  }

  flags(id: PlayerId): PlayerFlags {
    if (!this.prefs) return EMPTY
    const tags: Tag[] = []
    const notes: string[] = []
    const rank = this.likeRank.get(id) ?? null
    if (rank != null) {
      tags.push('like')
      notes.push(`your pre-draft rank #${rank}`)
    }
    if (this.avoid.has(id)) {
      tags.push('avoid')
      notes.push('on your do-not-draft list')
    }
    if (this.lateTargets.has(id)) {
      tags.push('target')
      notes.push('late-round target')
    }
    return tags.length ? { tags, likeRank: rank, notes } : EMPTY
  }

  isAvoid(id: PlayerId): boolean {
    return this.avoid.has(id)
  }
}

function startersByPos(roster: Roster): Map<Pos, number> {
  const counts = new Map<Pos, number>()
  for (const s of roster.slots) {
    if (!s.filled) continue
    // A filled slot is counted under the position it was drafted to fill.
    const pos = s.eligible.length === 1 ? s.eligible[0] : null
    if (pos) counts.set(pos, (counts.get(pos) ?? 0) + 1)
  }
  return counts
}

/**
 * Evaluates the manager's stated roster-construction rules against the current
 * roster and round. Returns advice, never a hard block.
 */
export function evaluateStrategy(
  prefs: Preferences | null,
  roster: Roster,
  round: number,
  league: LeagueConfig,
  poolByPos: Map<Pos, number>,
  /**
   * The best player still available at each position, so a rule can name the
   * pick it is asking for rather than only the shape it dislikes. A prohibition
   * with homework attached loses to the player already on the board.
   */
  bestByPos?: Map<Pos, { name: string; value: number; tierLeft: number }>,
): StrategyAdvice[] {
  if (!prefs) return []
  const out: StrategyAdvice[] = []
  const counts = startersByPos(roster)
  const filled = roster.slots.filter((s) => s.filled).length

  for (const rule of prefs.rules) {
    if (rule.kind === 'openers') {
      if (round <= rule.throughRound) {
        const have = rule.prefer.filter((p) => (counts.get(p) ?? 0) > 0).length
        const want = rule.prefer.length
        if (filled < rule.throughRound && have < want) {
          out.push({
            ruleId: rule.id,
            label: rule.label,
            severity: 'info',
            message: `${rule.prefer.join('-')} start — ${have} of ${want} so far`,
          })
        }
      }
    }

    if (rule.kind === 'composition' && rule.require) {
      const roundsLeft = rule.throughRound - round
      const short = Object.entries(rule.require)
        .map(([pos, want]) => ({ pos: pos as Pos, want: want ?? 0, have: counts.get(pos as Pos) ?? 0 }))
        .filter((x) => x.have < x.want)
      if (short.length && roundsLeft <= 3) {
        /*
         * Named, and with the arithmetic done: how many picks are left against
         * how many slots still to fill is the whole decision, and working it
         * out in your head at 10pm is how a slot goes unfilled.
         */
        const need = short.reduce((a, x) => a + (x.want - x.have), 0)
        const worst = short
          .map((x) => ({ ...x, best: bestByPos?.get(x.pos) }))
          .sort((a, b) => (b.best?.value ?? -99) - (a.best?.value ?? -99))[0]
        out.push({
          ruleId: rule.id,
          label: rule.label,
          severity: roundsLeft <= 1 ? 'warn' : 'info',
          message:
            `${short.map((x) => `${x.want - x.have} more ${x.pos}`).join(' and ')} ` +
            `by round ${rule.throughRound} — ${roundsLeft + 1} pick${roundsLeft === 0 ? '' : 's'} left ` +
            `for ${need} slot${need === 1 ? '' : 's'}.` +
            (worst?.best ? ` Best ${worst.pos} available is ${worst.best.name} (${worst.best.value.toFixed(1)}).` : ''),
        })
      }
      continue
    }

    if (rule.kind === 'composition') {
      const roundsLeft = rule.throughRound - round
      const matches = Object.entries(rule.avoid).every(
        ([pos, n]) => (counts.get(pos as Pos) ?? 0) >= (n ?? 0),
      )
      const wouldLock = matches && roundsLeft <= 1
      if (matches && roundsLeft <= 2) {
        /*
         * Name the pick, not the prohibition. "Spend one of the next picks on a
         * onesie" is advice you have to go and act on yourself, and next to a
         * receiver already sitting at the top of the board it never wins.
         */
        const unfilled = roster.slots
          .filter((s) => !s.filled && s.eligible.length === 1)
          .map((s) => s.eligible[0])
          .filter((p) => p === 'QB' || p === 'TE')
        type Option = { pos: Pos; best: { name: string; value: number; tierLeft: number } }
        const options: Option[] = []
        for (const pos of unfilled) {
          const best = bestByPos?.get(pos)
          if (best) options.push({ pos, best })
        }
        options.sort((a, b) => b.best.value - a.best.value)
        const top = options[0]
        out.push({
          ruleId: rule.id,
          label: rule.label,
          severity: wouldLock ? 'warn' : 'info',
          message: top
            ? `${rule.note} Best available is ${top.best.name} (${top.pos}, ${top.best.value.toFixed(1)})` +
              (top.best.tierLeft <= 3 ? `, ${top.best.tierLeft} left in his tier.` : '.')
            : rule.note,
        })
      }
    }

    if (rule.kind === 'lateTargets') {
      // Kicker and defence are deliberately left to the end, so they must not
      // make the lineup look incomplete.
      const openStarters = roster.slots.filter(
        (s) => !s.filled && !s.eligible.every((p) => p === 'K' || p === 'DST'),
      ).length
      if (openStarters === 0) {
        out.push({
          ruleId: rule.id,
          label: rule.label,
          severity: 'info',
          message: `starters are full — hunting ${rule.prefer.join(', ')} until the last ${rule.reserveLastRounds} rounds`,
        })
      }
    }

    if (rule.kind === 'lastRounds') {
      const open = rule.order.filter((pos) =>
        roster.slots.some((sl) => !sl.filled && sl.eligible.length === 1 && sl.eligible[0] === pos),
      )
      // Only speaks once these are the picks actually left to make.
      const picksLeft = league.rounds - filled
      if (open.length && picksLeft <= open.length + 1) {
        const next = open[0]
        const best = bestByPos?.get(next)
        out.push({
          ruleId: rule.id,
          label: rule.label,
          severity: picksLeft <= open.length ? 'warn' : 'info',
          message:
            open.length > 1
              ? `${open.join(' then ')} — ${next} first.` +
                (best ? ` Best available is ${best.name}.` : '')
              : `${next} is the last slot open.` + (best ? ` Best available is ${best.name}.` : ''),
        })
      }
    }

    if (rule.kind === 'deadline') {
      const have = counts.get(rule.pos) ?? 0
      if (have >= rule.count) continue
      const from = rule.warnFromRound ?? rule.byRound - 3
      if (round < from) continue
      const left = rule.byRound - round
      out.push({
        ruleId: rule.id,
        label: rule.label,
        severity: left <= 1 ? 'warn' : 'info',
        message:
          left <= 0
            ? `past round ${rule.byRound} with ${rule.count - have} ${rule.pos} still to fill`
            : `${rule.count - have} ${rule.pos} to fill and ${left} round${left === 1 ? '' : 's'} of runway`,
      })
    }

    if (rule.kind === 'positionWindow') {
      const left = poolByPos.get(rule.pos) ?? 0
      if (rule.runAlert && left > 0 && left <= 3) {
        out.push({
          ruleId: rule.id,
          label: rule.label,
          severity: 'warn',
          message: `only ${left} ${rule.pos} left worth starting — this is the window`,
        })
      }
    }
  }
  return out
}
