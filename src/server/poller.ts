/**
 * The clock the cockpit was missing.
 *
 * News tier one is the difference between two snapshots of the league's player
 * data, so without something taking the second snapshot there is no news — the
 * feed showed the market and nothing else, and looked static because it was.
 *
 * This reads Sleeper directly and keeps its own snapshot rather than rewriting
 * `data/players.json`, which the draft board is built from. With four drafts
 * this week, a background job must not be able to move the board underneath a
 * pick.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import type { LeagueConfig, PlayerId } from '../kernel/types.js'

const SNAP = 'fixtures/player-snapshot.json'
const EVENTS = 'fixtures/news-log.jsonl'
const NOTES = 'fixtures/notifications.json'

export interface Event {
  id: string
  at: number
  kind: 'availability' | 'depth'
  playerId: PlayerId
  name: string
  pos: string
  team: string
  from: string
  to: string
  body: string | null
  worse: boolean
}

export interface Note {
  id: string
  at: number
  title: string
  body: string
  deadline: string | null
  leagues: string[]
  rule: string
  read: boolean
}

interface Snap {
  at: number
  players: Record<string, { s: string | null; i: string | null; d: number | null; t: string; n: string; p: string }>
}

const WORSE = ['Active', 'Questionable', 'Doubtful', 'Out', 'Suspended', 'PUP', 'NFI', 'IR', 'Injured Reserve']
const rank = (v: string | null) => {
  const i = WORSE.indexOf(v ?? 'Active')
  return i < 0 ? 0 : i
}

function loadSnap(): Snap | null {
  if (!existsSync(SNAP)) return null
  try { return JSON.parse(readFileSync(SNAP, 'utf8')) as Snap } catch { return null }
}

export function recentEvents(limit = 40): Event[] {
  if (!existsSync(EVENTS)) return []
  const lines = readFileSync(EVENTS, 'utf8').trim().split('\n').filter(Boolean)
  const out: Event[] = []
  for (const l of lines.slice(-limit)) {
    try { out.push(JSON.parse(l) as Event) } catch { /* torn final line */ }
  }
  return out.reverse()
}

export function loadNotes(): Note[] {
  if (!existsSync(NOTES)) return []
  try { return JSON.parse(readFileSync(NOTES, 'utf8')) as Note[] } catch { return [] }
}
export function saveNotes(n: Note[]): void {
  mkdirSync('fixtures', { recursive: true })
  writeFileSync(NOTES, JSON.stringify(n.slice(0, 200), null, 1))
}

/**
 * Which rules may wake you. Each needs a fact that changed, a consequence on a
 * roster you hold, and a deadline — anything missing one of the three becomes a
 * note you find later instead.
 */
function notesFor(
  ev: Event,
  leagues: LeagueConfig[],
  rosterOf: (id: string) => Set<PlayerId>,
): Note[] {
  if (!ev.worse) return []
  const hit = leagues.filter((l) => rosterOf(l.id).has(ev.playerId))
  if (!hit.length) return []

  const ruledOut = ['Out', 'Doubtful', 'IR', 'Injured Reserve', 'PUP', 'NFI'].includes(ev.to)
  if (!ruledOut && ev.to !== 'Questionable') return []
  // Questionable only counts close to a lock; in August it means almost nothing.
  if (!ruledOut) return []

  return [{
    id: `n-${ev.id}`,
    at: ev.at,
    title: `${ev.name} is ${ev.to.toLowerCase()}${hit.length > 1 ? `. ${hit.length} lineups affected` : ''}`,
    body: `${ev.pos} ${ev.team}${ev.body ? ` · ${ev.body}` : ''} · was ${ev.from}. On your roster in ${hit
      .map((l) => l.label)
      .join(' and ')}.`,
    deadline: null,
    leagues: hit.map((l) => l.id),
    rule: 'A starter is ruled out',
    read: false,
  }]
}

export interface PollResult { checked: number; events: Event[]; notes: Note[]; firstRun: boolean }

export async function poll(opts: {
  leagues: LeagueConfig[]
  rosterOf: (leagueId: string) => Set<PlayerId>
}): Promise<PollResult> {
  const res = await fetch('https://api.sleeper.app/v1/players/nfl')
  if (!res.ok) throw new Error(`sleeper players HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, any>

  const prev = loadSnap()
  const next: Snap = { at: Date.now(), players: {} }
  const events: Event[] = []

  for (const [id, p] of Object.entries(raw)) {
    if (!p.team || !p.position) continue
    const name = p.full_name?.trim() || `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
    const row = {
      s: p.status ?? null, i: p.injury_status ?? null,
      d: typeof p.depth_chart_order === 'number' ? p.depth_chart_order : null,
      t: p.team, n: name, p: p.position,
    }
    next.players[id] = row

    const was = prev?.players[id]
    if (!was) continue

    const fromA = was.i ?? was.s ?? 'Active'
    const toA = row.i ?? row.s ?? 'Active'
    if (fromA !== toA) {
      events.push({
        id: `av-${id}-${next.at}`, at: next.at, kind: 'availability', playerId: id,
        name, pos: row.p, team: row.t, from: fromA, to: toA,
        body: p.injury_body_part ?? null, worse: rank(toA) > rank(fromA),
      })
    } else if (was.d !== row.d && row.p === 'RB' && (was.d != null || row.d != null)) {
      events.push({
        id: `dp-${id}-${next.at}`, at: next.at, kind: 'depth', playerId: id,
        name, pos: row.p, team: row.t,
        from: String(was.d ?? '—'), to: String(row.d ?? '—'), body: null,
        worse: (row.d ?? 9) > (was.d ?? 9),
      })
    }
  }

  mkdirSync('fixtures', { recursive: true })
  writeFileSync(SNAP, JSON.stringify(next))
  if (events.length) {
    appendFileSync(EVENTS, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  }

  const fresh: Note[] = []
  for (const ev of events) fresh.push(...notesFor(ev, opts.leagues, opts.rosterOf))
  if (fresh.length) {
    const have = loadNotes()
    const seen = new Set(have.map((n) => n.id))
    saveNotes([...fresh.filter((n) => !seen.has(n.id)), ...have])
  }

  return { checked: Object.keys(next.players).length, events, notes: fresh, firstRun: prev == null }
}
