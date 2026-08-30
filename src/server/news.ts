/**
 * News, resolved against every roster you hold.
 *
 * The differentiated half is not the feed — everyone has a feed. It is the
 * fan-out: one item, four leagues, four different meanings decided by format,
 * scoring and who owns the player. Nobody else can do it, because nobody else
 * holds all four.
 *
 * Two tiers, and only the first may ever interrupt you. Tier one is derived
 * from structured fields that either changed or did not, so it cannot be wrong
 * the way a summary of a beat reporter can.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import type { LeagueConfig, Player, PlayerId } from '../kernel/types.js'

const SNAP = 'fixtures/player-snapshot.json'

export type Verdict = 'act' | 'watch' | 'hold' | 'ignore'

export interface Impact {
  leagueId: string
  label: string
  verdict: Verdict
  note: string
}

export interface Item {
  id: string
  kind: 'availability' | 'depth' | 'trending' | 'team'
  headline: string
  detail: string
  at: number
  playerId: PlayerId | null
  /** Only tier one is allowed to notify. */
  tier: 1 | 2
  impacts: Impact[]
}

interface Snap { at: number; players: Record<string, { s: string | null; i: string | null; d: number | null; t: string }> }

function loadSnap(): Snap | null {
  if (!existsSync(SNAP)) return null
  try { return JSON.parse(readFileSync(SNAP, 'utf8')) as Snap } catch { return null }
}

/** Called after every player refresh; the diff between two of these is the news. */
export function writeSnapshot(players: Player[]): void {
  const out: Snap = { at: Date.now(), players: {} }
  for (const p of players) {
    out.players[p.id] = {
      s: p.status ?? null, i: p.injuryStatus ?? null,
      d: p.depthOrder ?? null, t: p.team,
    }
  }
  mkdirSync('fixtures', { recursive: true })
  writeFileSync(SNAP, JSON.stringify(out))
}

const WORSE = ['Questionable', 'Doubtful', 'Out', 'IR', 'PUP', 'Injured Reserve', 'NFI', 'Suspended']

/**
 * A player's meaning in one league. Owning him is the first question; the
 * format is the second, because a hobbled back is a different risk in a league
 * that eliminates its lowest scorer every week.
 */
function impactFor(
  league: LeagueConfig,
  rosterOf: (id: string) => Set<PlayerId>,
  playerId: PlayerId,
  worse: boolean,
): Impact {
  const mine = rosterOf(league.id)
  const owned = mine.has(playerId)
  const survival = league.teams >= 16
  if (!owned) {
    return { leagueId: league.id, label: league.label, verdict: 'ignore', note: 'Not on your roster.' }
  }
  if (!worse) {
    return { leagueId: league.id, label: league.label, verdict: 'hold', note: 'On your roster — this helps you here.' }
  }
  return {
    leagueId: league.id,
    label: league.label,
    verdict: 'act',
    note: survival
      ? 'Yours, and this league eliminates its lowest scorer — a hobbled starter is the wrong risk.'
      : 'On your roster. Check the replacement before lock.',
  }
}

export async function buildNews(opts: {
  leagues: LeagueConfig[]
  players: Map<PlayerId, Player>
  rosterOf: (leagueId: string) => Set<PlayerId>
}): Promise<{ items: Item[]; scanned: number; baseline: number | null }> {
  const { leagues, players, rosterOf } = opts
  const items: Item[] = []
  const prev = loadSnap()
  let scanned = 0

  /* ---- tier one: what actually changed since the last snapshot ---------- */
  if (prev) {
    for (const [id, p] of players) {
      const was = prev.players[id]
      if (!was) continue
      scanned++
      const nowInj = p.injuryStatus ?? null
      const nowSt = p.status ?? null
      if (was.i !== nowInj || was.s !== nowSt) {
        const from = was.i ?? was.s ?? 'Active'
        const to = nowInj ?? nowSt ?? 'Active'
        if (from === to) continue
        const worse = WORSE.indexOf(to) > WORSE.indexOf(from)
        items.push({
          id: `avail-${id}-${to}`,
          kind: 'availability',
          headline: `${p.name} is ${to.toLowerCase()}`,
          detail: `${p.pos} ${p.team} · was ${from}${p.injuryBody ? ` · ${p.injuryBody}` : ''}`,
          at: Date.now(), playerId: id, tier: 1,
          impacts: leagues.map((l) => impactFor(l, rosterOf, id, worse)),
        })
      } else if (was.d !== (p.depthOrder ?? null) && p.pos === 'RB') {
        const up = (p.depthOrder ?? 9) < (was.d ?? 9)
        items.push({
          id: `depth-${id}-${p.depthOrder}`,
          kind: 'depth',
          headline: `${p.name} moves ${up ? 'up' : 'down'} the depth chart`,
          detail: `${p.pos} ${p.team} · ${was.d ?? '—'} → ${p.depthOrder ?? '—'}`,
          at: Date.now(), playerId: id, tier: 1,
          impacts: leagues.map((l) => impactFor(l, rosterOf, id, !up)),
        })
      }
    }
  }

  /* ---- tier two: what the market is doing, which is not a fact about you -- */
  try {
    const res = await fetch('https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=10')
    if (res.ok) {
      for (const row of (await res.json()) as any[]) {
        const p = players.get(row.player_id)
        if (!p) continue
        items.push({
          id: `trend-${row.player_id}`,
          kind: 'trending',
          headline: `${p.name} added in ${Number(row.count).toLocaleString()} leagues`,
          detail: `${p.pos} ${p.team} · last 24 hours`,
          at: Date.now(), playerId: row.player_id, tier: 2,
          impacts: leagues.map((l) => {
            const owned = rosterOf(l.id).has(row.player_id)
            return {
              leagueId: l.id, label: l.label,
              verdict: owned ? ('hold' as Verdict) : ('watch' as Verdict),
              note: owned ? 'Already yours here.' : 'Free agent — worth a look.',
            }
          }),
        })
      }
    }
  } catch {
    // A quiet market is indistinguishable from a failed fetch, so say nothing.
  }

  const rank: Record<Verdict, number> = { act: 0, watch: 1, hold: 2, ignore: 3 }
  items.sort((a, b) => {
    const av = Math.min(...a.impacts.map((i) => rank[i.verdict]))
    const bv = Math.min(...b.impacts.map((i) => rank[i.verdict]))
    return av - bv || a.tier - b.tier
  })
  return { items: items.slice(0, 25), scanned, baseline: prev?.at ?? null }
}
