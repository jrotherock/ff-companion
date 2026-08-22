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

/** Warn when the roster is heading for a composition you do not want. */
export interface CompositionRule extends StrategyRule {
  kind: 'composition'
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

export type Rule = OpenerRule | CompositionRule | PositionWindowRule

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

    if (rule.kind === 'composition') {
      const roundsLeft = rule.throughRound - round
      const matches = Object.entries(rule.avoid).every(
        ([pos, n]) => (counts.get(pos as Pos) ?? 0) >= (n ?? 0),
      )
      const wouldLock = matches && roundsLeft <= 1
      if (matches && roundsLeft <= 2) {
        out.push({
          ruleId: rule.id,
          label: rule.label,
          severity: wouldLock ? 'warn' : 'info',
          message: rule.note,
        })
      }
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
