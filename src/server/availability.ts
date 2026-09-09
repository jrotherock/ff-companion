/**
 * Who is hurt, kept current.
 *
 * The player map is a build artifact — written by `fetch-players`, committed,
 * and otherwise never touched. Everything in it is stable across a season
 * except the one field that changes hour to hour: the game-day designation.
 * So the board went on showing Puka Nacua as Questionable two days after
 * Sleeper had cleared him, and the only way to correct it was to remember to
 * re-run a script.
 *
 * nflverse cannot cover this: it publishes the practice report, which is what
 * makes a designation mean something, and its files for a season do not exist
 * until games have been played. In week one there is no second source.
 *
 * So this refreshes the volatile fields alone, from Sleeper's own map, into
 * the state directory rather than back over the committed file — a designation
 * clearing is not a change to the roster of the NFL, and should not show up as
 * one in a diff.
 *
 * Sleeper asks that the player map be fetched sparingly; it is five megabytes
 * and mostly constant. Three hours is the compromise: often enough that a
 * Sunday-morning clearance lands before kickoff, rare enough to be a good
 * guest.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type { Player, PlayerId } from '../kernel/types.js'
import { statePath } from './paths.js'

const CACHE = statePath('availability.json')
const MAX_AGE = 3 * 3600000

interface Volatile {
  status: string | null
  injuryStatus: string | null
  injuryBody: string | null
  injuryNotes: string | null
}
interface Cache { at: number; by: Record<string, Volatile> }

/**
 * Sleeper clears a designation to an empty string as often as to null, and the
 * two are the same fact. Left alone, "" reads as a designation that renders as
 * nothing — a tag with no letters in it.
 */
const clean = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()
  return s === '' ? null : s
}

const same = (a: Volatile, p: Player) =>
  a.status === clean(p.status) &&
  a.injuryStatus === clean(p.injuryStatus) &&
  a.injuryBody === clean(p.injuryBody) &&
  a.injuryNotes === clean(p.injuryNotes)

/**
 * Applies the freshest designations onto a player map, in place.
 *
 * @returns what changed, so a poll can say so rather than working silently.
 */
export async function refreshAvailability(
  players: Map<PlayerId, Player>,
  now = Date.now(),
): Promise<{ changed: { name: string; from: string | null; to: string | null }[]; at: number; fetched: boolean }> {
  let cache: Cache | null = null
  if (existsSync(CACHE)) {
    try { cache = JSON.parse(readFileSync(CACHE, 'utf8')) as Cache } catch { cache = null }
  }

  let fetched = false
  if (!cache || now - cache.at >= MAX_AGE) {
    try {
      const res = await fetch('https://api.sleeper.app/v1/players/nfl', {
        headers: { 'user-agent': 'Mozilla/5.0 (fantasy companion, personal use)' },
      })
      if (res.ok) {
        const raw = (await res.json()) as Record<string, any>
        const by: Record<string, Volatile> = {}
        // Only the players this instance actually holds; the rest is 5MB of
        // people nobody here will ever start.
        for (const id of players.keys()) {
          const p = raw[id]
          if (!p) continue
          by[id] = {
            status: clean(p.status),
            injuryStatus: clean(p.injury_status),
            injuryBody: clean(p.injury_body_part),
            injuryNotes: clean(p.injury_notes),
          }
        }
        cache = { at: now, by }
        fetched = true
        mkdirSync('fixtures', { recursive: true })
        writeFileSync(CACHE, JSON.stringify(cache))
      }
    } catch {
      // A refused refresh leaves yesterday's designations, which is what the
      // committed map holds anyway. Never worth failing a poll over.
    }
  }
  if (!cache) return { changed: [], at: 0, fetched }

  const changed: { name: string; from: string | null; to: string | null }[] = []
  for (const [id, raw] of Object.entries(cache.by)) {
    const p = players.get(id)
    if (!p) continue
    /*
     * Cleaned on the way out as well as on the way in. Doing it only at fetch
     * time left any cache written before this rule — or by any other path —
     * putting an empty string back onto the board, which renders as a tag with
     * no letters in it.
     */
    const v: Volatile = {
      status: clean(raw.status),
      injuryStatus: clean(raw.injuryStatus),
      injuryBody: clean(raw.injuryBody),
      injuryNotes: clean(raw.injuryNotes),
    }
    if (same(v, p)) continue
    if (clean(p.injuryStatus) !== v.injuryStatus) {
      changed.push({ name: p.name, from: p.injuryStatus ?? null, to: v.injuryStatus })
    }
    p.status = v.status
    p.injuryStatus = v.injuryStatus
    p.injuryBody = v.injuryBody
    p.injuryNotes = v.injuryNotes
  }
  return { changed, at: cache.at, fetched }
}
