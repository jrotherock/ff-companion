/**
 * The cockpit: four leagues on one surface, sorted by whether they need you.
 *
 * The draft companion answers "who do I take" for one league at a time. This
 * answers the question that only exists when you hold several — "which of these
 * needs me right now, and which can I leave alone" — which no platform can
 * answer, because each of them knows about exactly one of your leagues.
 */
import { readFileSync, statSync, existsSync } from 'node:fs'
import type { LeagueConfig, Player, PlayerId } from '../kernel/types.js'

/** Ordered worst-first: the tile at the top is the one to open. */
export type Urgency = 'act' | 'soon' | 'watch' | 'quiet' | 'blocked'

export interface Tile {
  id: string
  label: string
  platform: string
  format: string
  teams: number
  urgency: Urgency
  /** The single sentence worth reading on the card. */
  why: string
  /** Short verb for the pill. */
  action: string
  /** Milliseconds since this league's data was last known good, or null. */
  freshMs: number | null
  /** Set while the league is still counting down to its draft. */
  draft: { at: string; inMs: number; slotSet: boolean; boardAgeMs: number | null } | null
  /** Why this league cannot report yet, when it cannot. */
  blocked: string | null
  phase: 'pre-draft' | 'drafting' | 'in-season' | 'complete'
}

const HOUR = 3600000
const DAY = 24 * HOUR

function boardAge(leagueId: string): number | null {
  const p = `data/rankings-${leagueId}.json`
  if (!existsSync(p)) return null
  try {
    const { fetchedAt } = JSON.parse(readFileSync(p, 'utf8')) as { fetchedAt?: string }
    return fetchedAt ? Date.now() - new Date(fetchedAt).getTime() : Date.now() - statSync(p).mtimeMs
  } catch {
    return null
  }
}

export function humanIn(ms: number): string {
  if (ms < 0) return 'now'
  if (ms < HOUR) return `${Math.round(ms / 60000)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${Math.round((ms % HOUR) / 60000)}m`
  return `${Math.round(ms / DAY)}d`
}

/**
 * Sleeper serves rosters to anyone holding the league id, so this needs no
 * credentials. Before a draft the rosters exist but hold no players, which is
 * reported as such rather than dressed up as an empty lineup.
 */
export async function sleeperRoster(
  leagueKey: string,
  userId: string,
): Promise<{ players: PlayerId[]; starters: PlayerId[]; ok: boolean } | null> {
  try {
    const res = await fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`)
    if (!res.ok) return null
    const rosters = (await res.json()) as any[]
    const mine = rosters.find((r) => r.owner_id === userId)
    if (!mine) return null
    return {
      players: (mine.players ?? []).filter(Boolean),
      starters: (mine.starters ?? []).filter((p: string) => p && p !== '0'),
      ok: true,
    }
  } catch {
    return null
  }
}

function formatOf(l: LeagueConfig): string {
  const rec = l.scoring?.rec ?? 0
  const ppr = rec >= 1 ? 'PPR' : rec > 0 ? `${rec} PPR` : 'Standard'
  const idp = ['DB', 'DL', 'LB'].some((p) => (l.starters as any)[p])
  const wr = (l.starters as any).WR ?? 0
  const bits = [ppr]
  if (l.teams >= 16) bits.push('Guillotine')
  if (idp) bits.push('IDP')
  if (wr >= 3) bits.push('3 WR')
  return bits.join(' · ')
}

const RANK: Record<Urgency, number> = { act: 0, soon: 1, watch: 2, blocked: 3, quiet: 4 }

/**
 * A league is urgent when something will go wrong if you do not act, and the
 * clock decides how loudly. A draft counting down outranks everything else,
 * because it is the only deadline in fantasy football you cannot recover from.
 */
export async function buildTiles(
  leagues: LeagueConfig[],
  opts: { sleeperUserId: string; now?: number; players: Map<PlayerId, Player> },
): Promise<Tile[]> {
  const now = opts.now ?? Date.now()
  const tiles: Tile[] = []

  for (const l of leagues) {
    if ((l as any).detected) continue
    const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
    const inMs = draftAt == null ? null : draftAt - now
    const age = boardAge(l.id)
    const preDraft = inMs != null && inMs > 0

    let urgency: Urgency = 'quiet'
    let why = ''
    let action = 'Nothing to do'
    let freshMs: number | null = null
    let blocked: string | null = null
    let phase: Tile['phase'] = preDraft ? 'pre-draft' : 'in-season'

    if (preDraft) {
      const problems: string[] = []
      /*
       * An unset slot is only a problem once it could have been set. Yahoo
       * randomises the order about half an hour before the draft, so warning
       * about it nine days out is a false alarm — and a tile that cries wolf in
       * August is one that gets ignored in September. Sleeper publishes the
       * order as soon as it exists, so there it counts from a day out.
       */
      const slotKnowableIn = l.platform === 'yahoo' ? HOUR : DAY
      if (l.mySlot == null && inMs < slotKnowableIn) {
        problems.push(
          l.platform === 'yahoo'
            ? 'slot is not set and Yahoo has revealed it by now'
            : 'slot is not set',
        )
      }
      if (age != null && age > 2 * DAY && inMs < 2 * DAY) {
        problems.push(`board is ${Math.round(age / DAY)} days old`)
      }
      const near = inMs < 12 * HOUR
      urgency = near ? (problems.length ? 'act' : 'soon') : problems.length ? 'watch' : 'quiet'
      action = near ? 'Open companion' : problems.length ? 'Get ready' : 'Waiting'
      /*
       * With nothing to fix, say what is actually true rather than claiming
       * everything is set — three of these leagues have no slot yet and will
       * not have one until the night, so "slot set" would be a lie told to
       * reassure, which is the same failure as a false alarm wearing a smile.
       */
      const quietWhy =
        l.mySlot == null && l.platform === 'yahoo'
          ? `Drafts in ${humanIn(inMs)}. Yahoo reveals your slot about half an hour before.`
          : l.mySlot == null
            ? `Drafts in ${humanIn(inMs)}. Slot not published yet.`
            : `Drafts in ${humanIn(inMs)}. Slot ${l.mySlot}, board fresh — nothing to do yet.`
      why = problems.length
        ? `Drafts in ${humanIn(inMs)}. ${problems[0][0].toUpperCase()}${problems[0].slice(1)}.`
        : quietWhy
    }

    if (l.feed === 'sleeper') {
      const roster = await sleeperRoster(l.leagueKey, opts.sleeperUserId)
      if (roster) {
        freshMs = 0
        if (!preDraft && roster.players.length === 0) {
          urgency = 'watch'
          action = 'Undrafted'
          why = 'Roster is empty — this league has not drafted.'
        } else if (!preDraft) {
          const filled = roster.starters.length
          urgency = filled ? 'quiet' : 'act'
          action = filled ? 'Nothing to do' : 'Set lineup'
          why = filled
            ? `Lineup set · ${roster.players.length} players rostered.`
            : `No starters set · ${roster.players.length} players rostered.`
        }
      } else {
        blocked = 'Sleeper did not answer'
        urgency = 'blocked'
        action = 'Unavailable'
        why = 'Could not read your roster just now.'
      }
    } else {
      /*
       * Yahoo has no read path yet: the draft sensor is a desktop browser
       * extension, and the official API is applied for but not granted. Saying
       * so is better than an invented roster — a tile you cannot trust is worse
       * than a tile that admits it knows nothing.
       */
      blocked = 'Yahoo API access pending'
      if (!preDraft) {
        urgency = 'blocked'
        action = 'Not connected'
        why = 'No roster feed until the Yahoo API is granted, or the draft sensor is running.'
      }
    }

    tiles.push({
      id: l.id,
      label: l.label,
      platform: l.platform,
      format: formatOf(l),
      teams: l.teams,
      urgency,
      why,
      action,
      freshMs,
      draft:
        draftAt != null && inMs != null
          ? { at: l.draftTime!, inMs, slotSet: l.mySlot != null, boardAgeMs: age }
          : null,
      blocked,
      phase,
    })
  }

  return tiles.sort((a, b) => {
    const r = RANK[a.urgency] - RANK[b.urgency]
    if (r !== 0) return r
    // Within a band the nearer deadline leads; leagues with no clock sink.
    const ax = a.draft?.inMs ?? Infinity
    const bx = b.draft?.inMs ?? Infinity
    return ax - bx
  })
}
