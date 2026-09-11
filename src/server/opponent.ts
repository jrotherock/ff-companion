/**
 * Points your opponent has already given away.
 *
 * A manager who leaves a ruled-out player in his lineup is fielding an empty
 * slot, and in a week decided by two points that is the whole margin. Yahoo
 * will not tell you; it shows his lineup and his projection and lets the
 * projection quietly include a man who cannot take the field.
 *
 * Nothing here is new work. The designations, the kickoff times and the rule
 * for who counts as unable to play were all built for my own lineup — this
 * points them at the other side of the tie, which was never possible while the
 * sensor could read one team page and that team page was mine.
 *
 * It reads as gloating and is not: the same function run on my own starters is
 * the check I most want before Sunday, and both sides get it.
 */
import { cannotPlay } from './lineup.js'

export interface Slotted {
  id: string
  name: string
  pos: string | null
  injuryStatus: string | null
  projected: number | null
  /** Where his club's game stands, from the schedule. */
  game?: 'pre' | 'playing' | 'done' | null
}

export interface DeadSlot {
  id: string
  name: string
  pos: string | null
  status: string
  /** What the site still has him down for, which is the size of the hole. */
  projected: number | null
  /**
   * Whether it can still be fixed.
   *
   * Before his game kicks off it is a warning and he may yet act on it; after,
   * it is settled and the slot will score what it scores. The distinction is
   * the difference between a thing worth watching and a thing worth counting.
   */
  fixable: boolean
}

export interface Broken {
  slots: DeadSlot[]
  /** Projected points sitting in slots that cannot score them. */
  points: number
  /** How many of those he could still put right. */
  fixable: number
}

/**
 * Starters who cannot play, and what they were down for.
 *
 * Deliberately silent about Questionable. Fifty-nine ranked players carry one
 * in August and most of them play; calling those dead would turn a sharp
 * signal into a weekly shrug. Only the designations the optimiser already
 * treats as unable to play count here, so the two halves of the app cannot
 * disagree about who is out.
 */
export function brokenLineup(starters: Slotted[], now?: number): Broken | null {
  const slots: DeadSlot[] = []
  for (const p of starters) {
    if (!cannotPlay(p.injuryStatus)) continue
    slots.push({
      id: p.id,
      name: p.name,
      pos: p.pos,
      status: (p.injuryStatus ?? 'out').trim(),
      projected: p.projected,
      fixable: p.game == null || p.game === 'pre',
    })
  }
  if (!slots.length) return null
  return {
    slots: slots.sort((a, b) => (b.projected ?? 0) - (a.projected ?? 0)),
    points: Number(slots.reduce((a, s) => a + (s.projected ?? 0), 0).toFixed(2)),
    fixable: slots.filter((s) => s.fixable).length,
  }
}

/**
 * How to say it, once. The wording differs by side: a hole in my lineup is
 * something to fix, and a hole in his is something to know about.
 */
export function brokenWhy(b: Broken, mine: boolean): string {
  const worst = b.slots[0]
  const rest = b.slots.length - 1
  const who = rest > 0
    ? `${worst.name} and ${rest} more`
    : worst.name
  const tag = worst.status.toLowerCase()
  if (mine) {
    return `${who} ${rest > 0 ? 'are' : `is ${tag} and is`} in your lineup${
      b.points > 0 ? `, where you have ${b.points.toFixed(1)} projected` : ''}.`
  }
  const locked = b.slots.length - b.fixable
  return `Your opponent is starting ${who}${rest > 0 ? '' : ` (${tag})`}${
    b.points > 0 ? ` — ${b.points.toFixed(1)} projected points in slots that cannot score them` : ''
  }${locked > 0 && b.fixable === 0 ? ', and it is too late for him to change it' : ''}.`
}
