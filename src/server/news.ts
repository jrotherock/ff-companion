/**
 * Changes, grouped by what they ask of you.
 *
 * The old version was a flat list of twenty-five items where an injury and a
 * popularity stat got identical treatment, and sixty of its hundred league
 * chips said "this does not concern you". The fix is not fewer sources — it is
 * scope, grouping, and ranking each source by the right number.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import type { LeagueConfig, Player, PlayerId } from '../kernel/types.js'
import { recentEvents, type Event, type Opening } from './poller.js'
import type { Practice } from './nflverse.js'
import { statePath } from './paths.js'

const TREND = statePath('trending-snapshot.json')
const BOARD = statePath('board-snapshot.json')

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
  /** Why he is rising, when a reason can be found rather than guessed. */
  because?: string | null
  /** The practice week, where the injury report has one. */
  practice?: { status: string; severity: string; report: string } | null
  /**
   * Why, as far as anything will say. A designation with no explanation sends
   * you to another tab, which is the tab this was meant to replace.
   */
  why?: { note: string | null; headline: string | null; link: string | null } | null
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

/**
 * The board moving is a signal in its own right, and an earlier one than the
 * waiver wire: projection systems reprice a player before the crowd reacts.
 * Spears and Marks each rose across all four boards at once last week, which
 * read as signal precisely because it happened everywhere rather than in one
 * place.
 */
function boardMoves(players: Map<PlayerId, Player>): { id: PlayerId; delta: number; from: number; to: number }[] {
  const now = new Map<PlayerId, number>()
  const files = existsSync('data') ? readdirSync('data').filter((f) => f.startsWith('rankings-')) : []
  const seen = new Map<PlayerId, number[]>()
  for (const f of files) {
    try {
      const { rankings } = JSON.parse(readFileSync(`data/${f}`, 'utf8')) as {
        rankings: { playerId: PlayerId; value: number }[]
      }
      for (const r of rankings) {
        const list = seen.get(r.playerId) ?? []
        list.push(r.value)
        seen.set(r.playerId, list)
      }
    } catch {
      // A board mid-write is not worth failing the whole feed for.
    }
  }
  // Averaged across boards: a player who moves on one is noise, on all four
  // is the projection catching up to something real.
  for (const [id, vals] of seen) now.set(id, vals.reduce((a, b) => a + b, 0) / vals.length)

  let prev: Record<string, number> = {}
  if (existsSync(BOARD)) {
    try { prev = JSON.parse(readFileSync(BOARD, 'utf8')) as Record<string, number> } catch { prev = {} }
  }
  mkdirSync('fixtures', { recursive: true })
  writeFileSync(BOARD, JSON.stringify(Object.fromEntries(now)))

  const out: { id: PlayerId; delta: number; from: number; to: number }[] = []
  for (const [id, to] of now) {
    const from = prev[id]
    if (from == null) continue
    const delta = to - from
    // Half a point on a scarcity-adjusted board is a real reprice, not drift.
    if (delta >= 0.5 && players.has(id)) out.push({ id, delta, from, to })
  }
  return out.sort((a, b) => b.delta - a.delta).slice(0, 8)
}

export async function buildNews(opts: {
  leagues: LeagueConfig[]
  players: Map<PlayerId, Player>
  rosters: Rosters[]
  /** The practice week behind each designation, when the report is published. */
  practice?: Map<PlayerId, Practice>
  /** Which season that report is from. Last season's cannot explain today. */
  practiceSeason?: number
  /** Headlines, so a designation can carry the story behind it. */
  wire?: { title: string; link: string; mentions: { id: string }[] }[]
}): Promise<{ items: Item[]; watched: number; quiet: number; ignored: number; trendAt: number | null }> {
  const { players, rosters } = opts
  const practice = opts.practice ?? new Map<PlayerId, Practice>()
  /*
   * Only this season's report is used at all. An earlier one cannot describe
   * this Sunday, and showing it greyed is still showing it — the first attempt
   * offered a 2025 injury as the reason a player was being added in 2026, which
   * was fluent, specific and wrong.
   */
  const current = opts.practiceSeason === new Date().getFullYear()

  /*
   * A game-day designation on its own cannot be acted on — in August most of
   * the first three rounds carry Questionable. The practice week is what makes
   * it mean something, so it is appended wherever a designation is shown.
   */
  /*
   * Why someone is being picked up, told by the injury report rather than by a
   * headline about his club. It needs no roster, which matters while there are
   * none — and it is a better answer besides: "his man in front did not
   * practise" beats "his team made cuts".
   */
  const practiceCause = (id: PlayerId): string | null => {
    if (!current) return null
    const p = players.get(id)
    if (!p?.team) return null
    for (const [otherId, pr] of practice) {
      if (otherId === id) continue
      const other = players.get(otherId)
      if (!other || other.team !== p.team || other.pos !== p.pos) continue
      if (pr.severity !== 'likely-out') continue
      return `${pr.name} is ${pr.report.toLowerCase()} and did not practise`
    }
    const own = practice.get(id)
    if (!own?.practice) return null
    const p2 = own.practice.toLowerCase()
    if (p2.startsWith('did not')) return 'he did not practise this week'
    if (p2.startsWith('limited')) return 'he was limited in practice'
    return null
  }

  /*
   * The explanation behind a tag, from whatever will give one: Sleeper's own
   * note where it exists (seventy-one of four hundred and sixty have one), the
   * wire where a headline names the player, and a search when neither does.
   * "Questionable" with nothing after it is the thing that sends you elsewhere.
   */
  const whyFor = (id: PlayerId, name: string): Item['why'] => {
    const p = players.get(id)
    const hit = (opts.wire ?? []).find((w) => w.mentions.some((m) => m.id === id))
    return {
      note: p?.injuryNotes ?? null,
      headline: hit?.title ?? null,
      link: hit?.link ?? `https://www.google.com/search?q=${encodeURIComponent(name + ' injury news')}&tbm=nws`,
    }
  }

  const practiceNote = (id: PlayerId): string => {
    if (!current) return ''
    const pr = practice.get(id)
    if (!pr?.practice) return ''
    const short = pr.practice
      .replace(/ In Practice$| in Practice$/i, '')
      .replace('Did Not Participate', 'did not practise')
      .replace('Limited Participation', 'limited in practice')
      .replace('Full Participation', 'practised fully')
    return ` · ${short}`
  }
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
        why: whyFor(ev.playerId, ev.name),
        id: `nd-${ev.id}`, group: 'needs',
        headline: `${ev.name} is ${ev.to.toLowerCase()}`,
        detail: `${ev.pos} ${ev.team}${ev.body ? ` · ${ev.body}` : ''} · was ${ev.from}${practiceNote(ev.playerId)}`,
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
        why: whyFor(ev.playerId, ev.name),
        id: `kn-${ev.id}`, group: 'knowing',
        headline: `${ev.name} ${ev.kind === 'depth' ? `moves to ${ev.to} on the depth chart` : `is ${ev.to.toLowerCase()}`}`,
        detail: `${ev.pos} ${ev.team}${ev.body ? ` · ${ev.body}` : ''}${practiceNote(ev.playerId)}`,
        at: ev.at, playerId: ev.playerId, chips: mine, weight: 1,
      })
    }
  }

  /*
   * What is true right now about your own players, not only what changed.
   *
   * Everything above comes from a diff, which is right for a sensor and wrong
   * for a screen: a fresh instance never saw the player healthy, so it cannot
   * know he is hurt. Deployed on Friday, the app reported nothing of yours in
   * the news while the league view was showing a questionable starter — one
   * app disagreeing with itself, because two screens asked different questions.
   *
   * A standing designation is emitted for anyone you roster, skipped where a
   * diff already said it.
   */
  const CARRIES = /^(OUT|IR|SUS|SUSP|PUP|NA|DNR|COV|NFI|D|DOUBTFUL|Q|QUESTIONABLE)$/i
  for (const r of rosters) {
    for (const id of r.mine) {
      const p = players.get(id)
      const tag = (p?.injuryStatus ?? '').trim()
      if (!p || !tag || !CARRIES.test(tag)) continue
      if (items.some((i) => i.playerId === id)) continue
      const mine = ownChips(id, rosters)
      if (!mine.length) continue
      const starting = mine.some((c) => c.note === 'starting')
      items.push({
        why: whyFor(id, p.name),
        id: `st-${id}-${tag}`, group: 'knowing',
        headline: `${p.name} is ${tag.toLowerCase()}`,
        detail: `${p.pos ?? ''} ${p.team ?? ''}${p.injuryBody ? ` · ${p.injuryBody}` : ''}${practiceNote(id)}`,
        at: Date.now(), playerId: id, chips: mine,
        // Below anything that just changed: standing facts are context, and a
        // change is news.
        weight: starting ? 3 : 1,
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

      /*
       * A number with no cause is trivia. Someone leaping up the add lists is
       * only worth a look once you know why — and the poller has usually just
       * seen the reason go past: a man on the same team at the same position
       * ruled out, or this player moving to the top of the chart himself.
       */
      const causes = new Map<PlayerId, string>()
      for (const ev of events) {
        if (ev.opening) causes.set(ev.opening.playerId, `${ev.name} is ${ev.to.toLowerCase()}`)
        if (ev.kind === 'depth' && !ev.worse && ev.to === '1') {
          causes.set(ev.playerId, 'moved to first on the depth chart')
        }
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
          because: causes.get(row.player_id)
            ?? practiceCause(row.player_id)
            ?? (p.depthOrder === 1 ? `now first on the ${p.team} depth chart` : null),
          practice:
            current && practice.get(row.player_id)
              ? {
                  status: practice.get(row.player_id)!.practice,
                  severity: practice.get(row.player_id)!.severity,
                  report: practice.get(row.player_id)!.report,
                }
              : null,
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

  /*
   * The practice report standing alone. A player of yours listed questionable
   * who did not practise all week is the clearest warning the feeds produce,
   * and it arrives days before the inactive list rather than ninety minutes.
   */
  for (const [id, pr] of practice) {
    // Only this season's report may raise an item of its own.
    if (!current) break
    if (pr.severity !== 'likely-out') continue
    const mine = ownChips(id, rosters)
    if (!mine.length) continue
    if (items.some((i) => i.playerId === id && i.group === 'needs')) continue
    const p = players.get(id)
    items.push({
      id: `pr-${id}-${pr.week}`, group: 'needs',
      headline: `${pr.name} is ${pr.report.toLowerCase()} and has not practised`,
      detail: `${p?.pos ?? ''} ${pr.team}${pr.injury ? ` · ${pr.injury}` : ''} · week ${pr.week} report`,
      at: Date.now(), playerId: id, chips: mine,
      weight: mine.filter((c) => c.tone === 'act').length * 10 + 8,
      because: 'the practice report, not the game-day tag',
    })
  }

  for (const m of boardMoves(players)) {
    const p = players.get(m.id)!
    items.push({
      id: `bd-${m.id}`, group: 'rising',
      headline: `${p.name} is worth more than he was`,
      detail: `${p.pos} ${p.team} · board value ${m.from.toFixed(1)} → ${m.to.toFixed(1)}`,
      at: Date.now(), playerId: m.id,
      chips: freeChips(m.id, rosters),
      weight: m.delta * 5,
      because: 'the projections moved, not the market',
    })
  }

  items.sort((a, b) => {
    /*
     * Anything about your own players outranks anything about the market. The
     * first ordering put rising above knowing, so a starter turning questionable
     * sat below twenty-one trending names — technically present, practically
     * invisible, which is the same as absent.
     */
    const order: Group[] = ['needs', 'opening', 'knowing', 'rising']
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
