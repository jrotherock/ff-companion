import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * What is worth interrupting you for, and how often.
 *
 * Twenty a week is the stated tolerance, so it is enforced rather than
 * approximated by tuning thresholds and hoping. Every alert carries what it
 * costs you to miss it, sends are counted against a rolling week, and when the
 * budget runs low only the expensive ones get through. The rest degrade to
 * notes you find in the app — which is the same guarantee the freshness rule
 * already makes: never silence, always a quieter channel.
 */

/*
 * Overridable so tests never write here. The first version of the test suite
 * wrote its fixtures straight into the live store — the same mistake as running
 * a test script against a real league, one layer down.
 */
const STORE = process.env.ALERT_STORE ?? 'fixtures/alerts.json'
const WEEK = 7 * 24 * 60 * 60 * 1000

/** Above this, an alert fires whatever the budget says. */
export const ALWAYS = 80

export interface Alert {
  /** Stable across re-evaluations of the same fact, so it is sent once. */
  id: string
  leagueId: string
  rule: string
  headline: string
  detail: string
  /**
   * What missing it costs, 0-100. Not urgency: a waiver you can still make
   * tomorrow scores low however soon the deadline is.
   */
  consequence: number
  /** When it stops mattering. An alert with no deadline is a note, not an alert. */
  deadline: number | null
  /** Where to act — opens the league's own app on iOS via universal links. */
  link: string | null
}

export interface Sent { id: string; at: number; consequence: number; rule: string }

interface Store { sent: Sent[]; budget: number }

const load = (): Store => {
  if (!existsSync(STORE)) return { sent: [], budget: 20 }
  try { return JSON.parse(readFileSync(STORE, 'utf8')) as Store }
  catch { return { sent: [], budget: 20 } }
}
const save = (s: Store) => writeFileSync(STORE, JSON.stringify(s, null, 1))

export const budget = () => load().budget
export const setBudget = (n: number) => { const s = load(); s.budget = n; save(s) }

/** Sends inside the trailing week. The window rolls; it does not reset on Monday. */
export function spent(now = Date.now()): Sent[] {
  return load().sent.filter((x) => now - x.at < WEEK)
}

/**
 * Whether this one gets through, and why not when it does not. The reason is
 * returned rather than logged so the app can show what it held back — a silent
 * drop is indistinguishable from a broken sensor.
 */
export function admits(
  a: Alert,
  now = Date.now(),
): { send: boolean; why: 'new' | 'urgent' | 'duplicate' | 'expired' | 'budget' } {
  const store = load()
  // Already said. Re-stating a fact you have seen is how a useful channel
  // becomes one that gets muted.
  if (store.sent.some((x) => x.id === a.id)) return { send: false, why: 'duplicate' }
  if (a.deadline != null && a.deadline < now) return { send: false, why: 'expired' }
  // A season-ending consequence is never rationed.
  if (a.consequence >= ALWAYS) return { send: true, why: 'urgent' }
  const used = spent(now).length
  if (used >= store.budget) return { send: false, why: 'budget' }
  return { send: true, why: 'new' }
}

export function markSent(a: Alert, now = Date.now()) {
  const s = load()
  s.sent = [...s.sent.filter((x) => now - x.at < WEEK * 4), {
    id: a.id, at: now, consequence: a.consequence, rule: a.rule,
  }]
  save(s)
}

/**
 * Rank a batch so that when the budget only admits some, it admits the ones
 * worth the most. Consequence first, then whichever expires soonest — an alert
 * you can still act on tomorrow yields to one that closes tonight.
 */
export function rank(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) =>
    b.consequence - a.consequence ||
    (a.deadline ?? Infinity) - (b.deadline ?? Infinity))
}

/** The whole batch, decided together, so the budget is spent on the best of it. */
export function admitBatch(alerts: Alert[], now = Date.now()): {
  send: Alert[]; held: { alert: Alert; why: string }[]
} {
  const send: Alert[] = []
  const held: { alert: Alert; why: string }[] = []
  const store = load()
  let used = spent(now).length
  for (const a of rank(alerts)) {
    if (store.sent.some((x) => x.id === a.id)) { held.push({ alert: a, why: 'duplicate' }); continue }
    if (a.deadline != null && a.deadline < now) { held.push({ alert: a, why: 'expired' }); continue }
    if (a.consequence >= ALWAYS) { send.push(a); continue }
    if (used >= store.budget) { held.push({ alert: a, why: 'budget' }); continue }
    send.push(a); used++
  }
  return { send, held }
}
