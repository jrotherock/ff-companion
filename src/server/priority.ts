/**
 * How hard an alert should knock.
 *
 * Every alert already carries a consequence from nought to a hundred, and the
 * budget uses it — but every one of them then went out as the same flat push,
 * so a doubtful starter three hours before kickoff and a player trending on
 * the waiver wire buzzed a phone identically. Ranking that nothing downstream
 * can see is not a ranking.
 *
 * Derived from the consequence, so a new rule is sensible without being listed
 * here, with a per-rule override for the cases where the score is a poor proxy
 * — a missed draft cannot be undone whatever it scores, and a role change is
 * never worth interrupting a meal for.
 */
import type { Alert } from './alerts.js'

export type Level = 'high' | 'normal' | 'low'

/**
 * Rules whose urgency is not well described by their consequence.
 *
 * Keep this short. Anything here is a claim that the score is wrong for this
 * rule specifically, and the honest fix is usually to change the score.
 */
const BY_RULE: Record<string, Level> = {
  // Missing a draft cannot be undone, and the window is minutes wide.
  'draft-imminent': 'high',
  // True, useful, and never worth interrupting anything for: it is a reason to
  // look at the wire this evening, not now.
  'role-changing': 'low',
  'roster-stale': 'low',
}

/** At or above this a consequence speaks for itself. */
const HIGH = 80
/** Below this it can wait for the phone to wake on its own. */
const LOW = 30

export function levelFor(a: Pick<Alert, 'rule' | 'consequence'>): Level {
  return BY_RULE[a.rule] ?? (a.consequence >= HIGH ? 'high' : a.consequence < LOW ? 'low' : 'normal')
}

export interface Delivery {
  level: Level
  /**
   * The Web Push urgency header. `high` asks the push service to wake a dozing
   * device now; `low` lets it batch with whatever else is queued.
   */
  urgency: 'high' | 'normal' | 'low'
  /**
   * Whether the notification stays on screen until it is dealt with. Right for
   * a starter who will not play; wrong for anything you would only act on
   * later, which is most of them.
   */
  requireInteraction: boolean
  /**
   * Pushover's own scale, -2 to 2. Two is an emergency that re-alerts until
   * acknowledged, which is more than any of this warrants — the ceiling here is
   * one, "bypass the quiet hours".
   */
  pushoverPriority: number
}

export function deliveryFor(a: Pick<Alert, 'rule' | 'consequence'>): Delivery {
  const level = levelFor(a)
  if (level === 'high') {
    return { level, urgency: 'high', requireInteraction: true, pushoverPriority: 1 }
  }
  if (level === 'low') {
    return { level, urgency: 'low', requireInteraction: false, pushoverPriority: -1 }
  }
  return { level, urgency: 'normal', requireInteraction: false, pushoverPriority: 0 }
}
