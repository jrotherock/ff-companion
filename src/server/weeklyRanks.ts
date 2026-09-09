/**
 * This week's expert consensus, used only to break ties.
 *
 * A weekly projection is not precise to a tenth, so two flex candidates half a
 * point apart are the same player as far as the model can see. The consensus
 * is a second opinion drawn from a different process — and it carries the
 * spread of expert disagreement, which says how much of an opinion it is.
 *
 * It is deliberately not a projection and never replaces one: these rankings
 * are half-PPR and know nothing of a league's own scoring. They order players
 * the model has already declared indistinguishable, and nothing else.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type { PlayerId } from '../kernel/types.js'
import { statePath } from './paths.js'

const CACHE = statePath('weekly-ranks.json')
const MAX_AGE = 6 * 3600000
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

/** The pages that exist; IDP is ranked elsewhere and on a different scale. */
const PAGES: [string, string][] = [
  ['QB', 'half-point-ppr-qb'],
  ['RB', 'half-point-ppr-rb'],
  ['WR', 'half-point-ppr-wr'],
  ['TE', 'half-point-ppr-te'],
  ['K', 'half-point-ppr-k'],
  ['DST', 'half-point-ppr-dst'],
]

export interface WeekRank {
  /** Expert consensus rank within the position. Lower is better. */
  posRank: number
  /** How much the experts disagree, in rank units. */
  spread: number
  /** Best and worst rank any expert gave him. */
  best: number
  worst: number
  opponent: string | null
}

interface Cache { at: number; week: number; ranks: Record<string, WeekRank>; sources: string[] }

export interface WeeklyRanks {
  week: number
  at: number
  byId: Map<PlayerId, WeekRank>
  /** Positions that actually came back, so a gap can be reported not guessed. */
  sources: string[]
}

/**
 * @param resolve name → player id, so this module needs no player map of its own.
 */
export async function weeklyRanks(
  week: number,
  resolve: (name: string, pos: string, team: string | null) => PlayerId | null,
): Promise<WeeklyRanks> {
  if (existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, 'utf8')) as Cache
      if (c.week === week && Date.now() - c.at < MAX_AGE) {
        return { week, at: c.at, byId: new Map(Object.entries(c.ranks)), sources: c.sources }
      }
    } catch {
      // A torn cache is not worth failing the week over.
    }
  }

  const ranks: Record<string, WeekRank> = {}
  const sources: string[] = []
  for (const [pos, slug] of PAGES) {
    try {
      const res = await fetch(`https://www.fantasypros.com/nfl/rankings/${slug}.php`, {
        headers: { 'User-Agent': UA },
      })
      if (!res.ok) continue
      const m = /var\s+ecrData\s*=\s*(\{[\s\S]*?\});/.exec(await res.text())
      if (!m) continue
      const data = JSON.parse(m[1]) as any
      // A stale page would silently rank last week; say nothing rather than lie.
      if (data.ranking_type_name !== 'weekly' || Number(data.week) !== week) continue
      let n = 0
      for (const p of data.players ?? []) {
        const id = resolve(String(p.player_name ?? ''), pos, p.player_team_id ?? null)
        if (!id) continue
        ranks[id] = {
          posRank: Number(p.pos_rank ?? p.rank_ecr) || Number(p.rank_ecr),
          spread: Number(p.rank_std ?? 0),
          best: Number(p.rank_min ?? 0),
          worst: Number(p.rank_max ?? 0),
          opponent: p.player_opponent ?? null,
        }
        n++
      }
      if (n) sources.push(pos)
    } catch {
      // One position failing is not the others failing.
    }
  }

  mkdirSync('fixtures', { recursive: true })
  writeFileSync(CACHE, JSON.stringify({ at: Date.now(), week, ranks, sources } satisfies Cache))
  return { week, at: Date.now(), byId: new Map(Object.entries(ranks)), sources }
}
