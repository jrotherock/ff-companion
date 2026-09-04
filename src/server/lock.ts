/**
 * When a slot stops being changeable.
 *
 * Yahoo prints a kickoff beside each player — "Sun 1:25 pm", "Mon 5:15 pm" —
 * in the reader's own timezone. Your week one roster spans Wednesday to Monday,
 * so a single weekly deadline would be wrong for most of it, and wrong in the
 * direction that matters: the Thursday and Monday lineups are the ones that go
 * unattended.
 */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/**
 * Resolve a printed kickoff to a moment. The page shows the current week, so
 * the next occurrence of that weekday is the right reading — except once the
 * game has been played, which the caller knows because points have appeared.
 */
export function kickoffAt(printed: string, now = new Date()): number | null {
  const m = /^(\w{3})\s+(\d{1,2}):(\d{2})\s*([ap])m$/i.exec(printed.trim())
  if (!m) return null
  const day = DAYS.indexOf(m[1].toLowerCase())
  if (day < 0) return null
  let hour = Number(m[2]) % 12
  if (m[4].toLowerCase() === 'p') hour += 12
  const minute = Number(m[3])

  const at = new Date(now)
  at.setHours(hour, minute, 0, 0)
  const ahead = (day - at.getDay() + 7) % 7
  at.setDate(at.getDate() + ahead)
  // Same weekday but the hour has passed: that is next week's game, not today's.
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 7)
  return at.getTime()
}

/**
 * The soonest lock among a set of players — the deadline an alert about them
 * should carry, because that is when acting stops being possible.
 */
export function soonestLock(
  ids: string[],
  kickoffs: Record<string, string>,
  now = new Date(),
): number | null {
  const times = ids
    .map((id) => (kickoffs[id] ? kickoffAt(kickoffs[id], now) : null))
    .filter((t): t is number => t != null)
  return times.length ? Math.min(...times) : null
}
