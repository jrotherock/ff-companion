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
import { buildTiles } from './cockpit.js'

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

  // Closest configured league by team count is the best available template.
  const templates = [...sessions.values()].filter((s) => s.league.platform === 'yahoo')
  if (!templates.length) return null
  const template = templates.sort(
    (a, b) => Math.abs(a.league.teams - shape.teams) - Math.abs(b.league.teams - shape.teams),
  )[0]

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
  if (parts[1] === 'cockpit') {
    const tiles = await buildTiles(
      [...sessions.values()].map((s) => s.league),
      { sleeperUserId: SLEEPER_USER, players: playerMap },
    )
    return json(res, 200, { generatedAt: Date.now(), tiles })
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
    const report = analyseSegmented(inputs)
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
