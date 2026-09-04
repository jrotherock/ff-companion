import { createServer } from 'node:http'
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { LeagueSession } from './session.js'
import { SleeperAdapter } from '../adapters/sleeper.js'
import { YahooExtAdapter } from '../adapters/yahoo-ext.js'
import type { AdjustmentData } from '../kernel/adjust.js'
import type { LeagueConfig, Player } from '../kernel/types.js'
import * as archive from './archive.js'
import { reviewDraft } from '../kernel/review.js'
import { analyseSegmented, type DraftInput } from '../kernel/tendencies.js'
import { PlayerIndex } from '../kernel/match.js'
import { buildTiles, sleeperRoster, sleeperLeagueRosters, sleeperMatchup } from './cockpit.js'
import { buildNews, type Rosters } from './news.js'
import { fetchWire, CLUB } from './wire.js'
import * as yahooRoster from './yahooRoster.js'
import { practiceReport } from './nflverse.js'
import { weeklyProjections } from './projections.js'
import { poll, recentEvents, loadNotes, saveNotes, type LeagueRosters } from './poller.js'

const PORT = Number(process.env.PORT ?? 4600)

const { players } = JSON.parse(readFileSync('data/players.json', 'utf8')) as { players: Player[] }

/*
 * Handcuff detection reads the depth chart directly, so a backfield the feed
 * has stale points the insurance at the wrong man — Carolina still listed Chuba
 * Hubbard ahead of Jonathon Brooks. Corrections live in data rather than here.
 */
if (existsSync('data/depth-overrides.json')) {
  const { backfields } = JSON.parse(readFileSync('data/depth-overrides.json', 'utf8')) as {
    backfields: Record<string, string[]>
  }
  for (const [team, order] of Object.entries(backfields ?? {})) {
    const backs = players.filter((p) => p.pos === 'RB' && p.team === team)
    order.forEach((name, i) => {
      const p = backs.find((x) => x.name === name)
      if (p) p.depthOrder = i + 1
      else console.warn(`depth override: no ${team} RB named ${name}`)
    })
    // Anyone unnamed falls in behind, so a partial override cannot leave two
    // players sharing the starter's place.
    let next = order.length + 1
    for (const p of backs) if (!order.includes(p.name)) p.depthOrder = next++
  }
}
const adjustments: AdjustmentData | null = existsSync('data/adjustments.json')
  ? (JSON.parse(readFileSync('data/adjustments.json', 'utf8')) as AdjustmentData)
  : null

/** Whose roster to read on Sleeper; overridable so this is not hard-wired. */
const SLEEPER_USER = process.env.SLEEPER_USER ?? '862745311741882368'
const playerMap = new Map(players.map((p) => [p.id, p]))
/** For resolving names pushed for a league that has no session of its own. */
const sharedIndex = new PlayerIndex(players)

const sessions = new Map<string, LeagueSession>()
for (const file of readdirSync('data/leagues').filter((f) => f.endsWith('.json'))) {
  const league = JSON.parse(readFileSync(`data/leagues/${file}`, 'utf8')) as LeagueConfig
  if (!existsSync(`data/rankings-${league.id}.json`)) {
    console.warn(`skipping ${league.id}: no rankings, run npm run data:rankings`)
    continue
  }
  // Keep the real draft id so a mock can be swapped in and back out again.
  ;(league as any).configuredDraftId = league.draftId
  sessions.set(league.id, new LeagueSession(league, players, adjustments))
}
console.log(`loaded ${sessions.size} leagues: ${[...sessions.keys()].join(', ')}`)

/*
 * The clock. Availability moves all week and nothing else in this process was
 * looking, so the feed had only the market to show and appeared frozen.
 *
 * Ten minutes is the compromise: fast enough that a Sunday inactive lands while
 * you can still act on it, slow enough that Sleeper is not being hammered for a
 * five-megabyte player map. Failures are recorded rather than thrown, because a
 * poller that dies silently is worse than one that reports being stuck.
 */
const POLL_MS = Number(process.env.POLL_MS ?? 600000)
const lastPoll: { at: number | null; ok: boolean; error: string | null } = {
  at: null, ok: true, error: null,
}

async function runPoll(): Promise<void> {
  try {
    const leagues = [...sessions.values()].map((s) => s.league).filter((l) => !(l as any).detected)
    const rosters = new Map<string, Set<string>>()
    const full: LeagueRosters[] = []
    for (const l of leagues) {
      if (l.feed !== 'sleeper') { rosters.set(l.id, new Set()); continue }
      const r = await sleeperLeagueRosters(l.leagueKey, SLEEPER_USER)
      rosters.set(l.id, new Set(r?.mine ?? []))
      if (r) {
        full.push({
          leagueId: l.id, label: l.label,
          mine: new Set(r.mine), taken: r.taken,
          budget: (l as any).faabBudget ?? null,
        })
      }
    }
    const out = await poll({ leagues, rosterOf: (id) => rosters.get(id) ?? new Set(), rosters: full })
    lastPoll.at = Date.now(); lastPoll.ok = true; lastPoll.error = null
    if (out.firstRun) console.log('poll: first snapshot written, diffs start next run')
    else if (out.events.length) {
      console.log(
        `poll: ${out.events.length} change(s), ${out.openings} opening(s), ` +
        `${out.notes.length} worth notifying`,
      )
    }
  } catch (err) {
    lastPoll.at = Date.now(); lastPoll.ok = false
    lastPoll.error = String((err as Error)?.message ?? err)
    console.warn('poll failed:', lastPoll.error)
  }
}
void runPoll()
setInterval(runPoll, POLL_MS).unref()

const clients = new Set<WebSocket>()

function broadcast(leagueId: string) {
  const session = sessions.get(leagueId)
  if (!session) return
  const view = session.view()
  // Recorded as it happens, not at the end: a draft abandoned halfway is still
  // worth reviewing, and nothing prompts you to press save.
  if (view.picks.length > 0) {
    try {
      archive.record(session.league, {
        picks: view.picks.length,
        complete: view.clock.complete,
        mock: Boolean((session.league as any).isMock || (session.league as any).detected),
      })
    } catch {
      // Archiving must never take the live board down.
    }
  }
  const msg = JSON.stringify({ type: 'view', leagueId, view })
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg)
}

// Adapters run continuously; the UI is a view, never a gate on the feed.
for (const session of sessions.values()) {
  const onSnapshot = (picks: any, source: string) => {
    if (session.onSnapshot(picks, source)) broadcast(session.league.id)
  }
  if (session.league.feed === 'sleeper' && session.league.draftId) {
    // Point at a mock draft without editing config: SLEEPER_DRAFT_ID=<id> npm run dev
    const draftId = process.env.SLEEPER_DRAFT_ID || session.league.draftId
    if (draftId !== session.league.draftId) {
      console.log(`  ${session.league.id}: overriding draft id -> ${draftId}`)
    }
    const adapter = new SleeperAdapter(draftId, (session.league as any).leagueKey)
    session.adapters.push(adapter)
    adapter.start(onSnapshot)
  }
  if (session.league.feed === 'yahoo-ext') {
    const adapter = new YahooExtAdapter(session.league.teams, session.index)
    session.adapters.push(adapter)
    adapter.start(onSnapshot)
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

/**
 * Serves the built UI so draft night is one process and one URL. Falls back to
 * index.html so the app still loads if the build is missing a hashed asset.
 */
function serveStatic(pathname: string, res: any): boolean {
  if (!existsSync('dist')) return false
  // Two apps, one process, one URL: / is the draft companion, /cockpit is the
  // four-league view. Extensionless paths map to their own html entry.
  const rel =
    pathname === '/' ? '/index.html'
    : pathname === '/cockpit' || pathname === '/cockpit/' ? '/cockpit.html'
    : pathname
  // Keep the resolved path inside dist, whatever the request asks for.
  const file = join('dist', normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  const target = existsSync(file) && !file.endsWith('/') ? file : 'dist/index.html'
  if (!existsSync(target)) return false
  /*
   * Assets carry a content hash so they can be cached for ever; index.html
   * points at them and must never be. Without this a reload can serve a stale
   * page referencing a bundle from two builds ago, and changes appear not to
   * have shipped.
   */
  const hashed = /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(target)
  res.writeHead(200, {
    'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-store, must-revalidate',
  })
  res.end(readFileSync(target))
  return true
}

/**
 * A draft the companion has never seen — a mock, usually — sensed from an open
 * draft room. Everything needed is derivable: the results page gives the team
 * and round counts, and the roster and scoring are cloned from the configured
 * league that most resembles it, which for a mock of your own league is the
 * league itself.
 */
function ensureDetectedLeague(
  yahooLeagueId: string,
  teamId: string,
  shape: { teams: number; rounds: number } | null,
): LeagueSession | null {
  const id = `yahoo-live-${yahooLeagueId}`

  /*
   * The team count is only knowable once a round boundary has been seen. Early
   * in a draft `max(pickInRound)` is a lower bound, not the answer — trusting it
   * on the first detection built a one-team league and every pick afterwards
   * collapsed into slot 1.
   */
  const credible = shape != null && shape.rounds >= 2 && shape.teams >= 4
  const existing = sessions.get(id)

  if (existing) {
    // A league built from a smaller sample gets corrected once more is known.
    if (credible && shape!.teams > existing.league.teams) {
      console.log(
        `correcting ${id}: ${existing.league.teams} -> ${shape!.teams} teams now a round boundary is visible`,
      )
      for (const a of existing.adapters) a.stop()
      sessions.delete(id)
    } else {
      return existing
    }
  }
  if (!credible) return null

  /*
   * You mock for the draft you are about to do, so the league drafting soonest
   * is a far better guess than the closest team count — which ties among every
   * twelve-team league and then silently takes whichever sorts first. That put
   * every mock on Harker Green's fifteen rounds, including mocks of a thirteen
   * round league, which left two bench seats that were never going to be filled
   * and stopped kicker and defence being forced at the end.
   */
  const templates = [...sessions.values()].filter(
    (s) => s.league.platform === 'yahoo' && !(s.league as any).detected,
  )
  if (!templates.length) return null
  const now = Date.now()
  const template = templates.sort((a, b) => {
    const fit = Math.abs(a.league.teams - shape.teams) - Math.abs(b.league.teams - shape.teams)
    if (fit !== 0) return fit
    const at = a.league.draftTime ? new Date(a.league.draftTime).getTime() : Infinity
    const bt = b.league.draftTime ? new Date(b.league.draftTime).getTime() : Infinity
    // Soonest draft still ahead of us; anything past sinks below.
    const av = at >= now ? at : Infinity
    const bv = bt >= now ? bt : Infinity
    return av - bv
  })[0]

  const league: LeagueConfig = {
    ...structuredClone(template.league),
    id,
    label: `Yahoo draft ${yahooLeagueId}`,
    leagueKey: `470.l.${yahooLeagueId}`,
    teams: shape!.teams,
    // Rounds seen so far is a floor; keep the template's if it is larger.
    rounds: Math.max(shape!.rounds, template.league.rounds),
    mySlot: null,
    myTeamId: teamId,
    draftTime: undefined,
    feed: 'yahoo-ext',
  }
  ;(league as any).leagueId = yahooLeagueId
  ;(league as any).detected = true
  ;(league as any).templateFrom = template.league.id

  const rankingSource = `data/rankings-${template.league.id}.json`
  if (!existsSync(rankingSource)) return null
  const target = `data/rankings-${id}.json`
  if (!existsSync(target)) writeFileSync(target, readFileSync(rankingSource, 'utf8'))

  // Written to disk so a finished draft is still there after a restart; the
  // pick log always survived, but the league that gave it meaning did not.
  writeFileSync(`data/leagues/${id}.json`, JSON.stringify(league, null, 2) + '\n')

  const session = new LeagueSession(league, players, adjustments)
  const adapter = new YahooExtAdapter(league.teams, session.index)
  session.adapters.push(adapter)
  adapter.start((picks: any, source: string) => {
    if (session.onSnapshot(picks, source)) broadcast(id)
  })
  sessions.set(id, session)
  console.log(`detected Yahoo draft ${yahooLeagueId} -> ${id} (from ${template.league.id})`)
  return session
}

const json = (res: any, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

async function body(req: any): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

/**
 * Replays one archived draft against the board frozen with it, so decisions are
 * scored against what was actually on the screen at the time.
 */
function buildReview(rec: archive.DraftRecord) {
  if (rec.mySlot == null) return null
  const session = sessions.get(rec.leagueId)
  const league: LeagueConfig = session
    ? { ...session.league, teams: rec.teams, rounds: rec.rounds, mySlot: rec.mySlot }
    : ({ ...(JSON.parse(
        readFileSync(`data/leagues/${rec.leagueId}.json`, 'utf8'),
      ) as LeagueConfig), teams: rec.teams, rounds: rec.rounds, mySlot: rec.mySlot })

  const rankings = archive.rankingsFor(rec)
  if (!rankings.length) return null
  const picks = archive.picksFor(rec)
  if (!picks.length) return null

  const pmap = new Map(players.map((p) => [p.id, p]))
  // Today's board, so a decision the board has since come round to can say so.
  const currentPath = `data/rankings-${rec.leagueId}.json`
  const currentRankings = existsSync(currentPath)
    ? (JSON.parse(readFileSync(currentPath, 'utf8')) as any).rankings
    : []

  return reviewDraft({
    league,
    players: pmap,
    rankings,
    currentRankings,
    picks: picks as any,
    mySlot: rec.mySlot,
    flagsFor: (id) =>
      session ? session.flagsFor(id) : { tags: [], likeRank: null, notes: [] },
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    return res.end()
  }

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api') {
    if (serveStatic(url.pathname, res)) return
    return json(res, 404, { error: 'not found — run npm run build to bundle the UI' })
  }

  if (parts[1] === 'detect' && req.method === 'POST') {
    const data = await body(req)
    const session = ensureDetectedLeague(
      String(data.yahooLeagueId),
      String(data.teamId ?? ''),
      data.shape ?? null,
    )
    if (!session) return json(res, 200, { ok: false, reason: 'not enough to build a league yet' })
    const adapter = session.adapters.find((a) => a.name === 'yahoo-ext') as
      | YahooExtAdapter
      | undefined
    const result = adapter ? adapter.ingest(data.rows ?? []) : { accepted: 0, unresolved: [] }
    broadcast(session.league.id)
    return json(res, 200, { ok: true, leagueId: session.league.id, ...result })
  }

  /**
   * Four leagues on one surface. Read-only and additive — the draft companion
   * is untouched by it, which matters with drafts five days out.
   */
  /**
   * Which build is on disk. A single-page app keeps running the bundle it
   * loaded, so a tab open across a rebuild goes on showing yesterday's UI while
   * the server serves today's — and every symptom of that looks like a bug in
   * the feature rather than a stale tab.
   */
  if (parts[1] === 'build') {
    let entry = ''
    try {
      entry = /assets\/cockpit-[^"]+\.js/.exec(readFileSync('dist/cockpit.html', 'utf8'))?.[0] ?? ''
    } catch { /* no build yet */ }
    return json(res, 200, { entry })
  }

  if (parts[1] === 'cockpit' && !parts[2]) {
    const tiles = await buildTiles(
      [...sessions.values()].map((s) => s.league),
      { sleeperUserId: SLEEPER_USER, players: playerMap },
    )
    return json(res, 200, { generatedAt: Date.now(), tiles })
  }

  /**
   * A Yahoo roster, pushed by the browser sensor when you visit your own team.
   * The only route to Yahoo roster state that needs no API grant.
   */
  if (parts[1] === 'cockpit' && parts[2] === 'yahoo-roster' && req.method === 'POST') {
    const data = await body(req)
    const session = [...sessions.values()].find(
      (s) => s.league.leagueKey.split('.').pop() === String(data.yahooLeagueId),
    )
    const rec = yahooRoster.record(session?.index ?? sharedIndex, data)
    console.log(
      `yahoo roster ${data.yahooLeagueId}: ${rec.players.length} players` +
      (rec.unmatched.length ? `, ${rec.unmatched.length} unmatched` : ''),
    )
    return json(res, 200, {
      ok: true, players: rec.players.length,
      starters: rec.starters.length, unmatched: rec.unmatched,
    })
  }

  /** One item of news, resolved against every roster you hold. */
  if (parts[1] === 'cockpit' && parts[2] === 'news') {
    const leagues = [...sessions.values()].map((s) => s.league).filter((l) => !(l as any).detected)
    const rosters: Rosters[] = []
    for (const l of leagues) {
      if (l.feed === 'sleeper') {
        const r = await sleeperLeagueRosters(l.leagueKey, SLEEPER_USER)
        if (!r) continue
        rosters.push({
          leagueId: l.id, label: l.label,
          mine: new Set(r.mine), starters: new Set(r.starters), taken: r.taken,
        })
        continue
      }
      /*
       * Yahoo, captured by the sensor. `taken` stays empty because scraping
       * your own team says nothing about the other eleven — so an opening will
       * not claim a player is free here, which is the honest failure.
       */
      const cap = yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')
      if (!cap) continue
      rosters.push({
        leagueId: l.id, label: l.label,
        mine: new Set(cap.players), starters: new Set(cap.starters), taken: new Set(cap.players),
      })
    }
    const report = await practiceReport(sharedIndex)
    const practice = new Map(report.rows.map((r) => [r.playerId, r]))
    // The wire is fetched first so a designation can carry the story behind it.
    const wireFirst = await fetchWire({
      players: playerMap,
      rosters: rosters.map((r) => ({ leagueId: r.leagueId, label: r.label, mine: r.mine })),
    })
    const [news, wire] = await Promise.all([
      buildNews({
        leagues, players: playerMap, rosters, practice,
        practiceSeason: report.season, wire: wireFirst.items,
      }),
      Promise.resolve(wireFirst),
    ])

    /*
     * A number with no cause is trivia. The poller only knows what has changed
     * since it started running, which on a fresh install is nothing — but the
     * wire is carrying the reasons already, in prose. Matching a rising player
     * to a headline about his own club recovers the "why" the structured feeds
     * cannot yet supply.
     *
     * Attributed to the headline rather than asserted, because this is a
     * correlation on a team name and not a fact the app established.
     */
    const DAY_MS = 86400000
    for (const item of news.items) {
      if (item.group !== 'rising' || item.because || !item.playerId) continue
      const p = playerMap.get(item.playerId)
      if (!p?.team) continue
      const club = CLUB[p.team]
      const hit = wire.items.find((w) => {
        if (Date.now() - w.at >= 2 * DAY_MS) return false
        if (w.mentions.some((m) => playerMap.get(m.id)?.team === p.team)) return true
        const hay = `${w.title} ${w.summary}`
        return club ? hay.includes(club) : new RegExp(`\\b${p.team}\\b`).test(hay)
      })
      if (hit) item.because = hit.title.length > 78 ? hit.title.slice(0, 78) + '…' : hit.title
    }

    return json(res, 200, { ...news, wire, practice: { season: report.season, note: report.note, players: report.rows.length } })
  }

  /**
   * One league in full: the decisions outstanding, then the roster beneath as
   * reference. Before a draft there is no roster, so it reports readiness
   * instead — which is the only thing that can actually be wrong that week.
   */
  if (parts[1] === 'cockpit' && parts[2] === 'league' && parts[3]) {
    const session = sessions.get(parts[3])
    if (!session) return json(res, 404, { error: 'no such league' })
    const l = session.league
    const now = Date.now()
    const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
    const preDraft = draftAt != null && draftAt > now

    let boardAt: string | null = null
    let boardSize = 0
    try {
      const rk = JSON.parse(readFileSync(`data/rankings-${l.id}.json`, 'utf8'))
      boardAt = rk.fetchedAt ?? null
      boardSize = rk.rankings?.length ?? 0
    } catch { /* no board for this league yet */ }

    const report = await practiceReport(sharedIndex)
    const practice = new Map(report.rows.map((r) => [r.playerId, r]))

    /*
     * Both feeds land in the same shape. Sleeper is read live; Yahoo comes from
     * whatever the browser sensor last captured, which is stale-but-real — the
     * league screen should not care which, only how old it is.
     */
    /*
     * Why a designation is there. A Q on its own is the thing that sends you to
     * another tab — Sleeper's own note where it has one, a headline that names
     * the player, and a news search when neither does.
     */
    const wireForLeague = await fetchWire({ players: playerMap, rosters: [] })
      .catch(() => ({ items: [] as any[] }))
    const whyFor = (pid: string, name: string) => {
      const pl = playerMap.get(pid)
      // "Active" is a status, not a designation — testing truthiness attached a
      // reason to every healthy player on the roster.
      const tag = pl?.injuryStatus ?? (pl?.status !== 'Active' ? pl?.status : null)
      if (!tag) return null
      const hit = wireForLeague.items.find((w: any) =>
        w.mentions.some((m: any) => m.id === pid),
      )
      return {
        note: pl?.injuryNotes ?? null,
        headline: hit?.title ?? null,
        link: hit?.link ??
          `https://www.google.com/search?q=${encodeURIComponent(name + ' injury news')}&tbm=nws`,
      }
    }

    let roster: { players: any[]; starters: string[]; capturedAt?: number } | null = null
    const held =
      l.feed === 'sleeper'
        ? await sleeperRoster(l.leagueKey, SLEEPER_USER).then((r) =>
            r ? { players: r.players, starters: r.starters, at: Date.now() } : null,
          )
        : (() => {
            const cap = yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')
            return cap ? { players: cap.players, starters: cap.starters, at: cap.at } : null
          })()

    if (held) {
      const r = held
      roster = {
        starters: r.starters,
        capturedAt: r.at,
        players: r.players.map((id) => {
            const p = playerMap.get(id)
            return p
              ? { id, name: p.name, pos: p.pos, team: p.team, byeWeek: p.byeWeek,
                  injuryStatus: p.injuryStatus ?? null, injuryBody: p.injuryBody ?? null,
                  // The week behind the tag: questionable having not practised
                  // is most of the way to out, and the tag alone cannot say so.
                  practice: practice.get(id)?.practice ?? null,
                  severity: practice.get(id)?.severity ?? null,
                  why: whyFor(id, p.name),
                  starter: r.starters.includes(id) }
              : { id, name: id, pos: null, team: null, byeWeek: null, injuryStatus: null,
                  injuryBody: null, practice: null, severity: null, starter: false }
        }),
      }
    }

    /*
     * Before a draft the question is whether you are ready for it; afterwards it
     * is whether the lineup holds. The readiness checks were still being served
     * four hours after a draft finished, all ticked, answering a question that
     * had closed.
     */
    const lineupChecks = () => {
      if (!roster) return []
      const startersOut: string[] = []
      const flagged: string[] = []
      const byes: string[] = []
      for (const p of roster.players) {
        if (!p.starter) continue
        if (p.injuryStatus || (p.severity && p.severity !== 'likely-plays')) {
          const tag = p.injuryStatus ?? p.severity
          const line = `${p.name} — ${String(tag).toLowerCase()}${p.injuryBody ? ` (${String(p.injuryBody).toLowerCase()})` : ''}`
          if (['Out', 'Doubtful', 'IR'].includes(String(p.injuryStatus))) startersOut.push(line)
          else flagged.push(line)
        }
        if (p.byeWeek != null) byes.push(`${p.name} wk${p.byeWeek}`)
      }
      const slotsOpen = l.feed === 'sleeper' ? 0 : 0
      const byeCount = new Map<number, number>()
      for (const p of roster.players) {
        if (!p.starter || p.byeWeek == null) continue
        byeCount.set(p.byeWeek, (byeCount.get(p.byeWeek) ?? 0) + 1)
      }
      const worstBye = [...byeCount.entries()].sort((a, b) => b[1] - a[1])[0]
      return [
        { k: 'Lineup', ok: roster.starters.length > 0 && !startersOut.length,
          v: startersOut.length ? startersOut.join(' · ')
            : `${roster.starters.length} starters set, ${roster.players.length - roster.starters.length} on the bench` },
        { k: 'Designations', ok: flagged.length === 0,
          v: flagged.length ? flagged.join(' · ') : 'nobody in your lineup is carrying one' },
        { k: 'Worst bye', ok: !worstBye || worstBye[1] < 3,
          v: worstBye ? `week ${worstBye[0]} takes ${worstBye[1]} of your starters` : 'no byes among your starters' },
        { k: 'Seen', ok: (roster.capturedAt ?? 0) > Date.now() - 6 * 3600000,
          v: roster.capturedAt ? new Date(roster.capturedAt).toLocaleString() : 'unknown' },
      ]
    }

    // What has to be true before the draft, in the order it becomes knowable.
    const draftChecks = [
      { k: 'Draft time', ok: draftAt != null,
        v: l.draftTime ? new Date(l.draftTime).toLocaleString() : 'not set' },
      { k: 'Your slot', ok: l.mySlot != null,
        v: l.mySlot != null ? `slot ${l.mySlot} of ${l.teams}`
          : l.platform === 'yahoo' ? 'revealed ~30 min before' : 'not published yet' },
      { k: 'Board', ok: boardAt != null && now - new Date(boardAt).getTime() < 2 * 86400000,
        v: boardAt ? `${boardSize} players, fetched ${new Date(boardAt).toLocaleDateString()}` : 'none' },
      { k: 'Strategy', ok: true, v: `${session.strategyCount ?? 0} rules loaded` },
    ]
    const checks = preDraft || !roster ? draftChecks : lineupChecks()

    /*
     * A Yahoo mock is archived under the detected league it created, so
     * filtering on this league's id finds nothing — every past Yahoo draft
     * looked missing. Mocks genuinely are not tied to a league: Yahoo mints a
     * fresh id and never says which league you launched from. Matching on
     * platform and team count is the honest approximation, and the flag says so.
     */
    /*
     * Projections belong to the players, not to the platform. They were behind
     * the Sleeper branch because the matchup is, which left the Yahoo leagues
     * with a roster and no numbers on it — the same players, projected by the
     * same source, withheld for the accident of where the roster came from.
     */
    const nflState = !preDraft
      ? await fetch('https://api.sleeper.app/v1/state/nfl').then((r) => r.json()).catch(() => null)
      : null
    const week = Number(nflState?.display_week ?? nflState?.week ?? 1)
    const projections = !preDraft
      ? await weeklyProjections(String(nflState?.season ?? new Date().getFullYear()), week)
      : null
    if (roster && projections) {
      for (const p of roster.players) p.projected = projections.pts.get(p.id) ?? null
      ;(roster as any).projectedTotal = roster.players
        .filter((p: any) => p.starter)
        .reduce((a: number, p: any) => a + (p.projected ?? 0), 0)
      ;(roster as any).week = week
    }

    let matchup: any = null
    if (l.feed === 'sleeper' && !preDraft) {
      const st = nflState
      const wk = week
      const m = await sleeperMatchup(l.leagueKey, SLEEPER_USER, wk)
      if (m) {
        const proj = projections ?? await weeklyProjections(String(st?.season ?? new Date().getFullYear()), wk)
        const side = (ids: string[]) =>
          ids.map((id) => {
            const p = playerMap.get(id)
            return {
              id, name: p?.name ?? id, pos: p?.pos ?? null, team: p?.team ?? null,
              projected: proj.pts.get(id) ?? null,
              injuryStatus: p?.injuryStatus ?? null,
              injuryBody: p?.injuryBody ?? null,
              why: p ? whyFor(id, p.name) : null,
            }
          })
        const mine = side(m.mine)
        const theirs = side(m.theirs)
        const sum = (xs: { projected: number | null }[]) =>
          xs.reduce((a, x) => a + (x.projected ?? 0), 0)
        matchup = {
          week: m.week, opponent: m.opponent, live: m.livePoints,
          mine, theirs,
          projected: { mine: sum(mine), theirs: sum(theirs) },
          projectionsAt: proj.at,
          started: (m.livePoints.mine ?? 0) > 0 || (m.livePoints.theirs ?? 0) > 0,
        }
      }
    }

    const archived = archive.list().filter((r) => {
      if (r.leagueId === l.id) return true
      if (r.platform !== l.platform) return false
      return r.teams === l.teams && String(r.leagueId).startsWith('yahoo-live-')
    })

    return json(res, 200, {
      id: l.id, label: l.label, platform: l.platform, teams: l.teams, rounds: l.rounds,
      starters: l.starters, flex: l.flex, benchSize: l.benchSize, scoring: l.scoring,
      draftTime: l.draftTime ?? null, mySlot: l.mySlot, feed: l.feed,
      preDraft, msToDraft: draftAt == null ? null : draftAt - now,
      checks, roster,
      connected: l.feed === 'sleeper' || roster != null,
      blocked:
        l.feed === 'sleeper' || roster != null
          ? null
          : 'Open your Yahoo team once and the sensor captures the roster.',
      matchup,
      drafts: archived.map((r) => ({
        key: r.key, picks: r.picks, at: r.startedAt, mySlot: r.mySlot,
        teams: r.teams, rounds: r.rounds,
        // True where the draft was played in this league rather than matched to it.
        exact: r.leagueId === l.id,
      })),
    })
  }

  /** What has actually changed, and what of it was worth waking you for. */
  if (parts[1] === 'cockpit' && parts[2] === 'notifications') {
    if (req.method === 'POST') {
      const body_ = await body(req)
      const notes = loadNotes()
      if (body_.readAll) for (const n of notes) n.read = true
      else if (body_.id) { const n = notes.find((x) => x.id === body_.id); if (n) n.read = true }
      saveNotes(notes)
      return json(res, 200, { ok: true })
    }
    const notes = loadNotes()
    return json(res, 200, {
      notes,
      unread: notes.filter((n) => !n.read).length,
      events: recentEvents(40),
      lastPollAt: lastPoll.at,
      lastPollOk: lastPoll.ok,
      lastPollError: lastPoll.error,
    })
  }

  /** Where every league's data comes from, and how old it is. */
  if (parts[1] === 'cockpit' && parts[2] === 'sources') {
    const rows = [...sessions.values()]
      .filter((s) => !(s.league as any).detected)
      .map((s) => {
        const rk = `data/rankings-${s.league.id}.json`
        let boardAt: string | null = null
        try { boardAt = JSON.parse(readFileSync(rk, 'utf8')).fetchedAt ?? null } catch { /* no board yet */ }
        return {
          id: s.league.id, label: s.league.label, platform: s.league.platform,
          feed: s.league.feed, leagueKey: s.league.leagueKey,
          mySlot: s.league.mySlot, teams: s.league.teams, rounds: s.league.rounds,
          draftTime: s.league.draftTime ?? null,
          boardAt,
          connected: s.league.feed === 'sleeper',
          note: s.league.feed === 'sleeper'
            ? 'Sleeper serves rosters publicly — no credentials needed.'
            : 'Yahoo API access applied for. Draft nights use the browser sensor.',
        }
      })
    return json(res, 200, { sources: rows, playerCount: players.length })
  }

  /** Every draft this machine has seen, newest first. */
  if (parts[1] === 'drafts' && !parts[2]) {
    return json(res, 200, archive.list())
  }

  /** Mark a draft as not reflecting your own decisions, or restore it. */
  if (parts[1] === 'drafts' && parts[2] && parts[3] === 'exclude' && req.method === 'POST') {
    const data = await body(req)
    const rec = archive.setExcluded(parts[2], Boolean(data.excluded), data.reason)
    return rec ? json(res, 200, rec) : json(res, 404, { error: 'no such draft' })
  }

  /** Decision review and structural audit for one draft. */
  if (parts[1] === 'drafts' && parts[2] && parts[3] === 'review') {
    const rec = archive.get(parts[2])
    if (!rec) return json(res, 404, { error: 'no such draft' })
    const review = buildReview(rec)
    return review ? json(res, 200, { draft: rec, review }) : json(res, 400, {
      error: 'this draft has no recorded slot, so there are no picks of yours to review',
    })
  }

  /** Patterns across every analysable draft. */
  if (parts[1] === 'tendencies') {
    const inputs: DraftInput[] = []
    for (const rec of archive.analysable()) {
      const review = buildReview(rec)
      if (review) {
        inputs.push({
          key: rec.key, label: rec.leagueLabel, platform: rec.platform,
          mock: rec.mock, when: rec.updatedAt, review,
        })
      }
    }
    /*
     * Judge the past on the board as it stood; recommend only what you would
     * still take. Both lists are read live, so ruling a player out today
     * silently stops him being suggested tomorrow without touching any review.
     */
    const excluded = { ids: new Set<string>(), names: new Set<string>() }
    for (const session of sessions.values()) {
      for (const id of session.avoidIds()) {
        excluded.ids.add(id)
        const p = playerMap.get(id)
        if (p) excluded.names.add(p.name.toLowerCase())
      }
    }
    const report = analyseSegmented(inputs, excluded)
    return json(res, 200, {
      ...report,
      sources: inputs.map(({ review, ...d }) => d),
      // Every draft on record, so excluded ones can be seen and restored.
      allDrafts: archive.list(),
    })
  }

  if (parts[1] === 'leagues') {
    /*
     * Detected leagues are kept on disk so a finished draft is not lost, but a
     * completed mock has no business in the picker for ever after — its picks
     * live in the archive and are reachable from Tendencies. Hidden once done
     * unless ?all=1.
     */
    const showAll = url.searchParams.get('all') === '1'
    const visible = [...sessions.values()].filter((s) => {
      if (showAll) return true
      if (!(s.league as any).detected) return true
      const v = s.view()
      return !v.clock.complete
    })
    return json(
      res,
      200,
      visible.map((s) => ({
        id: s.league.id,
        label: s.league.label,
        platform: s.league.platform,
        // The extension needs this to build the Yahoo draft-results URL.
        leagueKey: s.league.leagueKey,
        teams: s.league.teams,
        mySlot: s.league.mySlot,
        draftTime: s.league.draftTime ?? null,
        feed: s.league.feed,
        draftId: s.league.draftId ?? null,
        configuredDraftId: (s.league as any).configuredDraftId ?? null,
        isMock: Boolean((s.league as any).isMock),
        detected: Boolean((s.league as any).detected),
        // Enough for the client to notice a draft running somewhere else.
        live: (() => {
          const v = s.view()
          if (v.clock.complete || v.picks.length === 0) return false
          return v.health.some(
            (h: any) => h.ok && h.lastUpdate != null && Date.now() - h.lastUpdate < 30000,
          )
        })(),
        picks: s.view().picks.length,
      })),
    )
  }

  const session = sessions.get(parts[2] ?? '')
  if (parts[1] === 'league' && session) {
    const action = parts[3]
    if (req.method === 'GET' && !action) return json(res, 200, session.view())

    if (action === 'explain') {
      const id = url.searchParams.get('playerId') ?? ''
      const e = session.explain(id)
      return e ? json(res, 200, e) : json(res, 404, { error: 'not in the available pool' })
    }

    if (action === 'search') {
      return json(res, 200, session.search(url.searchParams.get('q') ?? ''))
    }

    if (req.method === 'POST') {
      const data = await body(req)
      switch (action) {
        case 'pick': {
          const ok = session.manualPick(Number(data.overall), String(data.playerId))
          broadcast(session.league.id)
          return json(res, 200, { ok })
        }
        case 'undo': {
          const ok = session.undo(Number(data.overall))
          broadcast(session.league.id)
          return json(res, 200, { ok })
        }
        case 'slot': {
          session.setSlot(data.slot == null ? null : Number(data.slot))
          broadcast(session.league.id)
          return json(res, 200, { ok: true })
        }
        case 'adjustments': {
          session.adjustmentsEnabled = Boolean(data.enabled)
          broadcast(session.league.id)
          return json(res, 200, { ok: true, enabled: session.adjustmentsEnabled })
        }
        /*
         * The round count is a guess for a detected league and a guess can be
         * wrong. Correcting it mid-draft matters: too many rounds and the app
         * believes bench seats remain, so it never forces kicker and defence at
         * the end — which is exactly how a mock finishes without them.
         */
        case 'shape': {
          const league = session.league as any
          const rounds = Number(data.rounds)
          const teams = Number(data.teams)
          if (Number.isFinite(rounds) && rounds >= 1) league.rounds = rounds
          if (Number.isFinite(teams) && teams >= 2 && teams !== league.teams) {
            league.teams = teams
            session.retune()
          }
          // Bench is whatever the rounds leave once every starting slot is filled.
          const slots =
            Object.values(league.starters as Record<string, number>).reduce((a, b) => a + b, 0) +
            (league.flex as { count: number }[]).reduce((a, f) => a + f.count, 0)
          league.benchSize = Math.max(0, league.rounds - slots)
          writeFileSync(`data/leagues/${league.id}.json`, JSON.stringify(league, null, 2) + '\n')
          broadcast(league.id)
          return json(res, 200, {
            ok: true, teams: league.teams, rounds: league.rounds, benchSize: league.benchSize,
          })
        }

        case 'reset': {
          session.reset()
          broadcast(session.league.id)
          return json(res, 200, { ok: true })
        }
        case 'source': {
          // Accept a pasted draft-room URL as readily as a bare id — Sleeper has
          // no way to list your mocks, so copying the URL is the least it can be.
          const raw = data.draftId ? String(data.draftId).trim() : ''
          const draftId = (/(\d{6,})/.exec(raw)?.[1] ?? raw) || null
          const league = session.league as any
          league.draftId = draftId || league.configuredDraftId || league.draftId
          league.isMock = Boolean(data.isMock)
          // Each draft owns its own pick log, so switching never mixes them.
          session.useDraft(league.draftId ?? null)
          // Rebind the feed in place; the pick log is untouched, so switching
          // to a mock and back does not lose a real draft.
          for (const a of session.adapters) a.stop()
          session.adapters = []
          if (league.feed === 'sleeper' && league.draftId) {
            const adapter = new SleeperAdapter(league.draftId, league.leagueKey)
            session.adapters.push(adapter)
            adapter.start((picks: any, source: string) => {
              if (session.onSnapshot(picks, source)) broadcast(league.id)
            })
          }
          if (league.feed === 'yahoo-ext') {
            const adapter = new YahooExtAdapter(league.teams, session.index)
            session.adapters.push(adapter)
            adapter.start((picks: any, source: string) => {
              if (session.onSnapshot(picks, source)) broadcast(league.id)
            })
          }
          broadcast(league.id)
          return json(res, 200, { ok: true, draftId: league.draftId, isMock: league.isMock })
        }
        case 'preferences': {
          session.setPreferences(data)
          broadcast(session.league.id)
          return json(res, 200, {
            ok: true,
            likes: data.likes?.length ?? 0,
            avoids: data.avoids?.length ?? 0,
          })
        }
        case 'yahoo': {
          /*
           * A team count that disagrees with what the sensor can see is not a
           * detail: overall = (round-1)*teams + pickInRound, so being wrong by
           * two collapses two picks of every round onto each other. Trust the
           * page over the config, once the page has seen a round boundary.
           */
          const seen = data.shape
          /*
           * Upward only. A partial page under-counts teams and can never
           * over-count, so a smaller number is always the less complete
           * reading — correcting downward on one short poll wiped a finished
           * draft mid-session.
           */
          if (
            seen?.teams &&
            seen.rounds >= 2 &&
            seen.teams > session.league.teams &&
            (session.league as any).detected
          ) {
            console.log(
              `${session.league.id}: correcting ${session.league.teams} -> ${seen.teams} teams`,
            )
            session.league.teams = seen.teams
            if (seen.rounds > session.league.rounds) session.league.rounds = seen.rounds
            session.retune()
            writeFileSync(
              `data/leagues/${session.league.id}.json`,
              JSON.stringify(session.league, null, 2) + '\n',
            )
            // retune tears the sensors down; this league only has the one.
            const fresh = new YahooExtAdapter(session.league.teams, session.index)
            session.adapters.push(fresh)
            fresh.start((picks: any, source: string) => {
              if (session.onSnapshot(picks, source)) broadcast(session.league.id)
            })
          }
          const adapter = session.adapters.find((a) => a.name === 'yahoo-ext') as
            | YahooExtAdapter
            | undefined
          if (!adapter) return json(res, 400, { error: 'no yahoo adapter' })
          if (data.error) {
            adapter.reportError(String(data.error))
            broadcast(session.league.id)
            return json(res, 200, { ok: true, recorded: 'error' })
          }
          return json(res, 200, adapter.ingest(data.rows ?? []))
        }
      }
    }
  }

  return json(res, 404, { error: 'not found' })
})

const wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.send(
    JSON.stringify({
      type: 'hello',
      leagues: [...sessions.values()].map((s) => ({ id: s.league.id, label: s.league.label })),
    }),
  )
})

// Health ticks so the UI can show seconds-since-update without polling.
setInterval(() => {
  for (const id of sessions.keys()) broadcast(id)
}, 5000)

server.listen(PORT, () => console.log(`draft companion on http://localhost:${PORT}`))
