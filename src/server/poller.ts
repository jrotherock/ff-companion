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
import type { LeagueConfig, Player, PlayerId } from '../kernel/types.js'
import { statePath } from './paths.js'

/*
 * The same backfield corrections the draft board uses. Without them the poller
 * reads Sleeper's raw chart and hands Carolina's job to the wrong man — the
 * override exists precisely because that chart is stale, and a feature that
 * reads depth charts has to honour it too.
 */
function depthOverrides(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!existsSync('data/depth-overrides.json')) return out
  try {
    const { backfields } = JSON.parse(readFileSync('data/depth-overrides.json', 'utf8')) as {
      backfields: Record<string, string[]>
    }
    for (const [team, order] of Object.entries(backfields ?? {})) out.set(team, order)
  } catch {
    // A malformed override should not stop the poll.
  }
  return out
}

const SNAP = statePath('player-snapshot.json')
const EVENTS = statePath('news-log.jsonl')
const NOTES = statePath('notifications.json')

export interface Event {
  id: string
  at: number
  kind: 'availability' | 'depth'
  /** Set when this change hands somebody else the job. */
  opening?: Opening | null
  /** Leagues where the changed player is on your roster. */
  yours?: string[]
  playerId: PlayerId
  name: string
  pos: string
  team: string
  from: string
  to: string
  body: string | null
  worse: boolean
}

/**
 * Who gains when a starter goes down.
 *
 * Scoping news to your own players throws away the most valuable item there is:
 * somebody else's back tears a knee, and the man behind him is sitting on
 * waivers in two of your leagues. That is not news about your roster — it is an
 * opening, and it closes within hours.
 */
export interface Opening {
  playerId: PlayerId
  name: string
  pos: string
  team: string
  /** Where he can still be had, and for how much. */
  freeIn: { leagueId: string; label: string; budget: number | null }[]
  takenIn: { leagueId: string; label: string }[]
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

/**
 * The man who inherits the job. The depth chart answers it directly for a
 * backfield; for receivers it is a proxy, since target share does not step
 * neatly down a list — but the next man up is still the first place to look.
 */
function beneficiary(
  hurt: { id: PlayerId; pos: string; team: string; depth: number | null },
  all: Map<PlayerId, { n: string; p: string; t: string; d: number | null }>,
): { id: PlayerId; n: string; p: string; t: string } | null {
  // Only a starter losing his job creates an opening worth chasing.
  if ((hurt.depth ?? 9) > 1) return null
  const same = [...all.entries()]
    .filter(([id, x]) => id !== hurt.id && x.t === hurt.team && x.p === hurt.pos && x.d != null)
    .sort((a, b) => (a[1].d ?? 9) - (b[1].d ?? 9))
  const next = same[0]
  return next ? { id: next[0], n: next[1].n, p: next[1].p, t: next[1].t } : null
}

export interface LeagueRosters {
  leagueId: string
  label: string
  mine: Set<PlayerId>
  taken: Set<PlayerId>
  budget: number | null
}

export interface PollResult {
  checked: number
  events: Event[]
  notes: Note[]
  openings: number
  firstRun: boolean
}

export async function poll(opts: {
  leagues: LeagueConfig[]
  rosterOf: (leagueId: string) => Set<PlayerId>
  /** Full league rosters, so a free agent can be told from a rostered player. */
  rosters?: LeagueRosters[]
}): Promise<PollResult> {
  const res = await fetch('https://api.sleeper.app/v1/players/nfl')
  if (!res.ok) throw new Error(`sleeper players HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, any>

  const prev = loadSnap()
  const next: Snap = { at: Date.now(), players: {} }
  const events: Event[] = []
  const index = new Map<PlayerId, { n: string; p: string; t: string; d: number | null }>()
  const rosters = opts.rosters ?? []

  for (const [id, p] of Object.entries(raw)) {
    if (!p.team || !p.position) continue
    const name = p.full_name?.trim() || `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
    const row = {
      s: p.status ?? null, i: p.injury_status ?? null,
      d: typeof p.depth_chart_order === 'number' ? p.depth_chart_order : null,
      t: p.team, n: name, p: p.position,
    }
    next.players[id] = row
    index.set(id, { n: name, p: row.p, t: row.t, d: row.d })

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
    } else if (
      was.d !== row.d &&
      /*
       * Every skill position, not just running backs. A rookie receiver moving
       * to first is the cleanest signal a breakout is coming, and restricting
       * this to backs made that invisible — the only way it surfaced was as a
       * trending add, by which point the market has already taken him.
       */
      ['RB', 'WR', 'TE', 'QB'].includes(row.p) &&
      (was.d != null || row.d != null)
    ) {
      events.push({
        id: `dp-${id}-${next.at}`, at: next.at, kind: 'depth', playerId: id,
        name, pos: row.p, team: row.t,
        from: String(was.d ?? '—'), to: String(row.d ?? '—'), body: null,
        worse: (row.d ?? 9) > (was.d ?? 9),
      })
    }
  }

  // Corrections applied before anything reads the chart.
  const overrides = depthOverrides()
  if (overrides.size) {
    const byTeam = new Map<string, [PlayerId, { n: string; p: string; t: string; d: number | null }][]>()
    for (const [id, x] of index) {
      if (x.p !== 'RB') continue
      const list = byTeam.get(x.t) ?? []
      list.push([id, x])
      byTeam.set(x.t, list)
    }
    for (const [team, order] of overrides) {
      const backs = byTeam.get(team) ?? []
      order.forEach((name, i) => {
        const hit = backs.find(([, x]) => x.n === name)
        if (hit) hit[1].d = i + 1
      })
      let next = order.length + 1
      for (const [, x] of backs) if (!order.includes(x.n)) x.d = next++
    }
  }

  /*
   * Resolved after the whole map is read: the man who inherits the job may sit
   * further down the same iteration, so this cannot be done inline.
   */
  const OUT = ['Out', 'Doubtful', 'IR', 'Injured Reserve', 'PUP', 'NFI', 'Suspended']
  let openings = 0
  for (const ev of events) {
    ev.yours = rosters.filter((r) => r.mine.has(ev.playerId)).map((r) => r.leagueId)
    if (ev.kind !== 'availability' || !ev.worse || !OUT.includes(ev.to)) continue
    const self = index.get(ev.playerId)
    const heir = beneficiary(
      { id: ev.playerId, pos: ev.pos, team: ev.team, depth: self?.d ?? null }, index,
    )
    if (!heir) continue
    const freeIn = rosters.filter((r) => !r.taken.has(heir.id))
      .map((r) => ({ leagueId: r.leagueId, label: r.label, budget: r.budget }))
    const takenIn = rosters.filter((r) => r.taken.has(heir.id))
      .map((r) => ({ leagueId: r.leagueId, label: r.label }))
    // An heir nobody can sign is trivia, not an opening.
    if (!freeIn.length) continue
    ev.opening = { playerId: heir.id, name: heir.n, pos: heir.p, team: heir.t, freeIn, takenIn }
    openings++
  }

  mkdirSync('fixtures', { recursive: true })
  writeFileSync(SNAP, JSON.stringify(next))
  if (events.length) {
    appendFileSync(EVENTS, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  }

  const fresh: Note[] = []
  for (const ev of events) {
    fresh.push(...notesFor(ev, opts.leagues, opts.rosterOf))
    /*
     * The opposite of damage control, and often worth more. The player is not
     * yours, which is exactly why the window closes — everyone else can see it
     * too, and the fastest claim wins.
     */
    if (ev.opening) {
      fresh.push({
        id: `o-${ev.id}`,
        at: ev.at,
        title: `${ev.opening.name} inherits ${ev.team}'s ${ev.pos} job`,
        body: `${ev.name} is ${ev.to.toLowerCase()}${ev.body ? ` (${ev.body})` : ''}. ` +
          `${ev.opening.name} is a free agent in ${ev.opening.freeIn.map((f) => f.label).join(' and ')}.`,
        deadline: null,
        leagues: ev.opening.freeIn.map((f) => f.leagueId),
        rule: 'A starter goes down and his replacement is free',
        read: false,
      })
    }
  }
  if (fresh.length) {
    const have = loadNotes()
    const seen = new Set(have.map((n) => n.id))
    saveNotes([...fresh.filter((n) => !seen.has(n.id)), ...have])
  }

  return {
    checked: Object.keys(next.players).length,
    events, notes: fresh, openings, firstRun: prev == null,
  }
}
