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

/*
 * The poller already reads Sleeper's player map every ten minutes and keeps a
 * snapshot of it to diff for news. Fetching the same five megabytes again on a
 * three-hour timer was a second reader of one source at a worse cadence, and
 * it showed: the news feed reported Brock Bowers doubtful with a meniscus
 * within minutes, while the alerts and the lineup optimiser — which read this
 * — still had him clear and projected for 11.5, because the overlay would not
 * refresh for another two hours.
 *
 * So this reads the poller's snapshot instead. Ten minutes fresh, and one
 * fetch where there were two.
 */
const SNAP = statePath('player-snapshot.json')

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

/**
 * Applies the freshest designations onto a player map, in place.
 *
 * @returns what changed, so a poll can say so rather than working silently.
 */
export async function refreshAvailability(
  players: Map<PlayerId, Player>,
  now = Date.now(),
): Promise<{ changed: { name: string; from: string | null; to: string | null }[]; at: number; fetched: boolean }> {
  let snap: { at: number; players: Record<string, { s?: string | null; i?: string | null }> } | null = null
  if (existsSync(SNAP)) {
    try { snap = JSON.parse(readFileSync(SNAP, 'utf8')) } catch { snap = null }
  }
  if (!snap?.players) return { changed: [], at: 0, fetched: false }
  const cache: Cache = {
    at: snap.at,
    by: Object.fromEntries(
      Object.entries(snap.players).map(([id, r]) => [
        id,
        {
          status: clean(r.s),
          injuryStatus: clean(r.i),
          // The snapshot keeps only what it needs to diff; the body and the
          // note come from the committed map until they are needed here.
          injuryBody: null,
          injuryNotes: null,
        },
      ]),
    ),
  }

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
    if (v.status === clean(p.status) && v.injuryStatus === clean(p.injuryStatus)) continue
    if (clean(p.injuryStatus) !== v.injuryStatus) {
      changed.push({ name: p.name, from: p.injuryStatus ?? null, to: v.injuryStatus })
    }
    p.status = v.status
    p.injuryStatus = v.injuryStatus
    /*
     * The body part belongs to the designation. When one clears the other has
     * to go with it — a cleared player still carrying "Undisclosed" reads as
     * hurt in every place that shows the detail beside the tag. But while a
     * designation stands, a snapshot that does not track the body must not
     * erase the one already known.
     */
    if (v.injuryStatus == null) {
      p.injuryBody = null
      p.injuryNotes = null
    } else {
      if (v.injuryBody != null) p.injuryBody = v.injuryBody
      if (v.injuryNotes != null) p.injuryNotes = v.injuryNotes
    }
  }
  return { changed, at: cache.at, fetched: false }
}
