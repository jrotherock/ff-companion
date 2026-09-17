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

/*
 * The pages that exist: half-PPR for the positions that catch the ball, and
 * the plain page for the three that do not. IDP is ranked elsewhere and on a
 * different scale.
 *
 * A reception is worth half a point and a quarterback does not have any, so
 * FantasyPros publishes no PPR variant for QB, K or DST. Asking for one is a
 * 302 to the preseason draft cheatsheet — every position, week nought — which
 * fetch follows without complaint and answers 200. The week check below
 * refused it, and rightly: draft ranks passed off as this week's consensus
 * would have been worse than none. But it refused in silence, every week, so
 * from the day this consensus was added every quarterback decision was made
 * without it — which from the outside reads exactly like a week the experts
 * had nothing to say.
 */
export const PAGES: [string, string][] = [
  ['QB', 'qb'],
  ['RB', 'half-point-ppr-rb'],
  ['WR', 'half-point-ppr-wr'],
  ['TE', 'half-point-ppr-te'],
  ['K', 'k'],
  ['DST', 'dst'],
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

interface Cache {
  at: number; week: number; ranks: Record<string, WeekRank>; sources: string[]
  /** Which pages produced it. */
  pages?: string
}

/*
 * A cache is only an answer to the question that filled it. Railway's state
 * volume outlives a deploy, so the week-two file written by the old page list
 * — three positions in it and no quarterbacks — would have gone on answering
 * for six hours after the fix shipped, and the fix would have looked like it
 * had not worked. Any change to the page list now empties the cache with it.
 */
const PAGE_SET = PAGES.map(([, slug]) => slug).join(',')

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
      if (c.week === week && c.pages === PAGE_SET && Date.now() - c.at < MAX_AGE) {
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
      if (!res.ok) { console.warn(`ranks: ${pos} page answered ${res.status}`); continue }
      const m = /var\s+ecrData\s*=\s*(\{[\s\S]*?\});/.exec(await res.text())
      if (!m) continue
      const data = JSON.parse(m[1]) as any
      /*
       * A stale page would rank last week, so it is refused rather than
       * believed — but out loud. Early in the week this fires for a page that
       * has not rolled over yet, which is worth seeing; refusing quietly is how
       * three positions went unranked for a fortnight with nothing to show for
       * it but an empty column.
       */
      if (data.ranking_type_name !== 'weekly' || Number(data.week) !== week) {
        const via = res.redirected ? ` (redirected to ${new URL(res.url).pathname})` : ''
        console.warn(`ranks: ${pos} page${via} is ${data.ranking_type_name} week ${data.week}, not weekly week ${week}`)
        continue
      }
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
  writeFileSync(CACHE, JSON.stringify({ at: Date.now(), week, ranks, sources, pages: PAGE_SET } satisfies Cache))
  return { week, at: Date.now(), byId: new Map(Object.entries(ranks)), sources }
}
