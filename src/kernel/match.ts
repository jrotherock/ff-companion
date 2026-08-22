import type { Player, PlayerId, Pos } from './types.js'

/**
 * Sleeper carries a yahoo_id for barely half its players and none for most
 * recent rookies, so cross-platform joins resolve by name plus position and
 * team rather than by id.
 */

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g

/** Ranking sources use the name the broadcast uses; Sleeper uses the legal one. */
const NICKNAMES: Record<string, string> = {
  'hollywood brown': 'marquise brown',
  'gabe davis': 'gabriel davis',
  'chig okonkwo': 'chigoziem okonkwo',
  'cam ward': 'cameron ward',
  'josh palmer': 'joshua palmer',
  'mike thomas': 'michael thomas',
}

export function normaliseName(name: string): string {
  const base = rawNormalise(name)
  return NICKNAMES[base] ?? base
}

function rawNormalise(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.'`’]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(SUFFIX, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "Jahmyr Gibbs" -> "j gibbs", so first-name spellings cannot break a join. */
function initialLast(name: string): string {
  const parts = normaliseName(name).split(' ')
  if (parts.length < 2) return parts[0] ?? ''
  return `${parts[0][0]} ${parts[parts.length - 1]}`
}

export interface MatchQuery {
  name: string
  pos?: Pos | null
  team?: string | null
}

export class PlayerIndex {
  private byExact = new Map<string, Player[]>()
  private byInitial = new Map<string, Player[]>()
  private byId = new Map<PlayerId, Player>()

  constructor(players: Player[]) {
    for (const p of players) {
      this.byId.set(p.id, p)
      const add = (map: Map<string, Player[]>, key: string) => {
        if (!key) return
        ;(map.get(key) ?? map.set(key, []).get(key)!).push(p)
      }
      add(this.byExact, normaliseName(p.name))
      add(this.byInitial, initialLast(p.name))
      // Defenses are written every way there is: "Rams", "LAR", "Los Angeles
      // Rams". Index the nickname and the abbreviation as well as the full name.
      if (p.pos === 'DST') {
        const parts = normaliseName(p.name).split(' ')
        add(this.byExact, parts[parts.length - 1])
        add(this.byExact, p.team.toLowerCase())
      }
    }
  }

  get(id: PlayerId): Player | undefined {
    return this.byId.get(id)
  }

  all(): Player[] {
    return [...this.byId.values()]
  }

  /** Narrows candidates by position then team; ambiguity resolves to null. */
  private disambiguate(candidates: Player[], q: MatchQuery): Player | null {
    if (candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0]

    let pool = candidates
    if (q.pos) {
      const byPos = pool.filter((p) => p.pos === q.pos)
      if (byPos.length) pool = byPos
    }
    if (q.team) {
      const t = q.team.toUpperCase()
      const byTeam = pool.filter((p) => p.team.toUpperCase() === t)
      if (byTeam.length) pool = byTeam
    }
    return pool.length === 1 ? pool[0] : null
  }

  resolve(q: MatchQuery): Player | null {
    const exact = this.byExact.get(normaliseName(q.name)) ?? []
    const hit = this.disambiguate(exact, q)
    if (hit) return hit

    const initials = this.byInitial.get(initialLast(q.name)) ?? []
    return this.disambiguate(initials, q)
  }

  /**
   * Incremental search for manual entry. Matches on prefix of any name part so
   * "gib", "jah gib" and "jahmyr" all land on the same player.
   */
  search(query: string, limit = 8, positions?: Pos[]): Player[] {
    const q = normaliseName(query)
    if (!q) return []
    const terms = q.split(' ')
    const scored: { p: Player; score: number }[] = []

    for (const p of this.byId.values()) {
      if (positions && !positions.includes(p.pos)) continue
      const parts = normaliseName(p.name).split(' ')
      let score = 0
      let ok = true
      for (const t of terms) {
        const idx = parts.findIndex((part) => part.startsWith(t))
        if (idx === -1) {
          ok = false
          break
        }
        // Surname matches and full-part matches are stronger signals.
        score += (idx === parts.length - 1 ? 3 : 1) + (parts[idx] === t ? 2 : 0)
      }
      if (!ok) continue
      if (normaliseName(p.name).startsWith(q)) score += 4
      scored.push({ p, score })
    }

    return scored
      .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
      .slice(0, limit)
      .map((s) => s.p)
  }
}
