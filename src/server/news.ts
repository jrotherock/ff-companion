/**
 * Changes, grouped by what they ask of you.
 *
 * The old version was a flat list of twenty-five items where an injury and a
 * popularity stat got identical treatment, and sixty of its hundred league
 * chips said "this does not concern you". The fix is not fewer sources — it is
 * scope, grouping, and ranking each source by the right number.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import type { LeagueConfig, Player, PlayerId } from '../kernel/types.js'
import { recentEvents, type Event, type Opening } from './poller.js'

const TREND = 'fixtures/trending-snapshot.json'

/** Ordered by what they ask of you, which is also the order they are shown. */
export type Group = 'needs' | 'opening' | 'rising' | 'knowing'

export interface Chip {
  leagueId: string
  label: string
  /** What this player is to you here — never "not yours", which is not worth a chip. */
  note: string
  tone: 'act' | 'watch' | 'hold' | 'free'
}

export interface Item {
  id: string
  group: Group
  headline: string
  detail: string
  at: number
  playerId: PlayerId | null
  chips: Chip[]
  /** Ranks within a group. Higher first. */
  weight: number
}

export interface Rosters {
  leagueId: string
  label: string
  mine: Set<PlayerId>
  starters: Set<PlayerId>
  taken: Set<PlayerId>
}

interface TrendSnap { at: number; add: Record<string, number> }

function loadTrend(): TrendSnap | null {
  if (!existsSync(TREND)) return null
  try { return JSON.parse(readFileSync(TREND, 'utf8')) as TrendSnap } catch { return null }
}
function saveTrend(t: TrendSnap): void {
  mkdirSync('fixtures', { recursive: true })
  writeFileSync(TREND, JSON.stringify(t))
}

const OUT = ['Out', 'Doubtful', 'IR', 'Injured Reserve', 'PUP', 'NFI', 'Suspended']

function shortLabel(l: string): string {
  return l.replace(/Harker |Fantasy |Football | League$/g, '').trim().slice(0, 14)
}

/** Where this player is yours — and nothing about leagues where he is not. */
function ownChips(id: PlayerId, rosters: Rosters[]): Chip[] {
  return rosters
    .filter((r) => r.mine.has(id))
    .map((r) => ({
      leagueId: r.leagueId, label: shortLabel(r.label),
      note: r.starters.has(id) ? 'starting' : 'benched',
      tone: (r.starters.has(id) ? 'act' : 'watch') as Chip['tone'],
    }))
}

/** Where he can still be signed, which is the only thing worth saying about a free agent. */
function freeChips(id: PlayerId, rosters: Rosters[]): Chip[] {
  return rosters.map((r) =>
    r.taken.has(id)
      ? { leagueId: r.leagueId, label: shortLabel(r.label), note: r.mine.has(id) ? 'yours' : 'taken',
          tone: (r.mine.has(id) ? 'hold' : 'watch') as Chip['tone'] }
      : { leagueId: r.leagueId, label: shortLabel(r.label), note: 'free', tone: 'free' as Chip['tone'] },
  )
}

export async function buildNews(opts: {
  leagues: LeagueConfig[]
  players: Map<PlayerId, Player>
  rosters: Rosters[]
}): Promise<{ items: Item[]; watched: number; quiet: number; ignored: number; trendAt: number | null }> {
  const { players, rosters } = opts
  const items: Item[] = []
  const watched = new Set<PlayerId>()
  for (const r of rosters) for (const id of r.mine) watched.add(id)

  /* ---- what the poller saw, sorted into groups -------------------------- */
  const events = recentEvents(120)
  const seen = new Set<string>()
  for (const ev of events) {
    if (seen.has(ev.playerId + ev.to)) continue
    seen.add(ev.playerId + ev.to)
    const mine = ownChips(ev.playerId, rosters)

    if (ev.opening) {
      const o = ev.opening as Opening
      items.push({
        id: `op-${ev.id}`, group: 'opening',
        headline: `${o.name} inherits ${ev.team}'s ${ev.pos} job`,
        detail: `${ev.name} is ${ev.to.toLowerCase()}${ev.body ? ` · ${ev.body}` : ''}`,
        at: ev.at, playerId: o.playerId,
        chips: freeChips(o.playerId, rosters),
        weight: o.freeIn.length * 10,
      })
      continue
    }
    if (!mine.length) continue // not yours, and no opening — not your business

    if (ev.kind === 'availability' && ev.worse && OUT.includes(ev.to)) {
      items.push({
        id: `nd-${ev.id}`, group: 'needs',
        headline: `${ev.name} is ${ev.to.toLowerCase()}`,
        detail: `${ev.pos} ${ev.team}${ev.body ? ` · ${ev.body}` : ''} · was ${ev.from}`,
        at: ev.at, playerId: ev.playerId, chips: mine,
        weight: mine.filter((c) => c.tone === 'act').length * 10 + 5,
      })
    } else if (ev.kind === 'depth' && !ev.worse && ev.to === '1') {
      items.push({
        id: `rs-${ev.id}`, group: 'rising',
        headline: `${ev.name} moves to first on the depth chart`,
        detail: `${ev.pos} ${ev.team} · was ${ev.from} · nobody hurt ahead of him`,
        at: ev.at, playerId: ev.playerId, chips: mine, weight: 8,
      })
    } else {
      items.push({
        id: `kn-${ev.id}`, group: 'knowing',
        headline: `${ev.name} ${ev.kind === 'depth' ? `moves to ${ev.to} on the depth chart` : `is ${ev.to.toLowerCase()}`}`,
        detail: `${ev.pos} ${ev.team}${ev.body ? ` · ${ev.body}` : ''}`,
        at: ev.at, playerId: ev.playerId, chips: mine, weight: 1,
      })
    }
  }

  /*
   * Trending stays here rather than moving elsewhere, but ranked by how fast it
   * is moving rather than how big the number is. Eighty thousand adds overnight
   * is a signal; a hundred thousand that have sat still for a week is history,
   * and the raw count cannot tell them apart.
   */
  let trendAt: number | null = null
  try {
    const res = await fetch('https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=25')
    if (res.ok) {
      const rows = (await res.json()) as any[]
      const prev = loadTrend()
      trendAt = prev?.at ?? null
      /*
       * The baseline only rolls forward every half hour. Rewriting it on every
       * request made the comparison window a few seconds wide, so every delta
       * was zero and velocity ranked nothing — the measurement destroyed the
       * thing it was measuring.
       */
      const BASELINE_MS = 1800000
      if (!prev || Date.now() - prev.at > BASELINE_MS) {
        const now: TrendSnap = { at: Date.now(), add: {} }
        for (const row of rows) now.add[row.player_id] = Number(row.count)
        saveTrend(now)
      }

      for (const row of rows) {
        const p = players.get(row.player_id)
        if (!p) continue
        const count = Number(row.count)
        const was = prev?.add[row.player_id]
        const delta = was == null ? null : count - was
        // A player nobody can sign anywhere is a fact about other people's leagues.
        const free = rosters.filter((r) => !r.taken.has(row.player_id))
        if (rosters.length && !free.length) continue
        items.push({
          id: `tr-${row.player_id}`, group: 'rising',
          headline: `${p.name} is being picked up`,
          detail: delta != null && delta > 0
            ? `${p.pos} ${p.team} · +${delta.toLocaleString()} since the last check · ${count.toLocaleString()} in 24h`
            : `${p.pos} ${p.team} · ${count.toLocaleString()} adds in 24h`,
          at: Date.now(), playerId: row.player_id,
          chips: freeChips(row.player_id, rosters),
          /*
           * Velocity leads and volume breaks the tie. Velocity alone collapsed
           * to nothing on a quiet market, leaving the order arbitrary — which
           * is worse than the popularity ranking it replaced.
           */
          weight: Math.max(0, delta ?? 0) / 1000 + count / 1000000,
        })
      }
    }
  } catch {
    // A quiet market and a failed fetch look the same, so say nothing.
  }

  items.sort((a, b) => {
    const order: Group[] = ['needs', 'opening', 'rising', 'knowing']
    const g = order.indexOf(a.group) - order.indexOf(b.group)
    return g !== 0 ? g : b.weight - a.weight || b.at - a.at
  })

  const touched = new Set(items.map((i) => i.playerId).filter(Boolean) as string[])
  return {
    items: items.slice(0, 40),
    watched: watched.size,
    quiet: Math.max(0, watched.size - [...touched].filter((id) => watched.has(id)).length),
    ignored: players.size - watched.size,
    trendAt,
  }
}
