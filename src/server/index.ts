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
import {
  buildTiles, sleeperRoster, sleeperLeagueRosters, sleeperMatchup, sleeperWaivers,
  sleeperAllSquads,
} from './cockpit.js'
import { buildNews, type Rosters } from './news.js'
import { fetchWire, CLUB } from './wire.js'
import * as yahooRoster from './yahooRoster.js'
import { advise, slotsFor } from './lineup.js'
import { holes, targets, nextWaiverClear } from './waivers.js'
import { findFits, weakSpots } from './trades.js'
import { exposure, atRisk, type Squad as ExposureSquad } from './exposure.js'
import { byePlan } from './byes.js'
import { weekGames, opponents, club } from './schedule.js'
import { defenceVsPosition, describe as describeMatchup } from './dvp.js'
import { usageReport, rising } from './usage.js'
import { STATE_DIR } from './paths.js'
import { loadLeagues } from './leagueConfig.js'
import * as passkeys from './passkeys.js'

/** First path segment, for routes that must answer before the guard runs. */
const parts0 = (u: URL) => u.pathname.split('/').filter(Boolean)[0]
import * as deliver from './deliver.js'
import * as alerts from './alerts.js'
import type { Alert } from './alerts.js'
import { evaluate } from './rules.js'
import { practiceReport } from './nflverse.js'
import { weeklyProjections } from './projections.js'
import { poll, recentEvents, loadNotes, saveNotes, type LeagueRosters } from './poller.js'

const PORT = Number(process.env.PORT ?? 4600)
/** Unset locally; required once this is reachable from anywhere but this Mac. */
const APP_TOKEN = process.env.APP_TOKEN ?? ''

/** Constant time, so the token cannot be guessed a character at a time. */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

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
/*
 * No default. A hardcoded id would quietly read somebody else's roster in a
 * fork, and be the last thing anyone thought to check.
 */
const SLEEPER_USER = process.env.SLEEPER_USER ?? ''
const playerMap = new Map(players.map((p) => [p.id, p]))
/** For resolving names pushed for a league that has no session of its own. */
const sharedIndex = new PlayerIndex(players)

const sessions = new Map<string, LeagueSession>()
const configured = loadLeagues()
for (const league of configured.leagues) {
  if (!existsSync(`data/rankings-${league.id}.json`)) {
    console.warn(`skipping ${league.id}: no rankings, run npm run data:rankings`)
    continue
  }
  // Keep the real draft id so a mock can be swapped in and back out again.
  ;(league as any).configuredDraftId = league.draftId
  sessions.set(league.id, new LeagueSession(league, players, adjustments))
}
console.log(
  `loaded ${sessions.size} leagues from ${configured.source}: ${[...sessions.keys()].join(', ')}`,
)

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
/**
 * Turn what the poll found into what is worth interrupting you for.
 *
 * It asks this server for the same league view the cockpit renders, rather than
 * recomputing the roster a second way. A second implementation would drift, and
 * an alert contradicting the screen it points at is the fastest way to make a
 * channel worth muting. Re-reading it over the loopback costs a few
 * milliseconds every ten minutes and keeps one source of truth.
 */
/**
 * What the rules last found, per league.
 *
 * The same judgement drives three things: whether to push, what the league
 * view shouts about, and whether a tile carries a mark. Only the push is
 * rationed — a budget decides what is worth interrupting you for, never what
 * is worth showing you once you have opened the app. That is what "the rest
 * degrade to notes you find later" has to mean to be true.
 */
export const outstanding = new Map<string, Alert[]>()

/** Which side of the matchup each league was on last time, for spotting a flip. */
const margins = new Map<string, boolean>()

async function gatherAlerts(): Promise<Alert[]> {
  const found: Alert[] = []
  {
    for (const session of sessions.values()) {
      const l = session.league
      if ((l as any).detected) continue
      const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
      const preDraft = draftAt != null && draftAt > Date.now()
      if (preDraft) {
        /*
         * A league that has not drafted has no roster to reason about, but it
         * does have a draft — which used to be skipped entirely, so the one
         * alert that cannot be recovered from was the one never sent.
         */
        found.push(...evaluate({
          leagueId: l.id, label: l.label, link: leagueLink(l),
          players: [], advice: null,
          draft: { at: draftAt!, slotSet: l.mySlot != null, mySlot: l.mySlot ?? null },
        }))
        outstanding.set(l.id, evaluate({
          leagueId: l.id, label: l.label, link: leagueLink(l),
          players: [], advice: null,
          draft: { at: draftAt!, slotSet: l.mySlot != null, mySlot: l.mySlot ?? null },
        }, Date.now(), { display: true }))
        continue
      }

      const detail = await fetch(`http://localhost:${PORT}/api/cockpit/league/${l.id}`, {
        // The server calling itself still has to get past its own front door.
        headers: APP_TOKEN ? { authorization: `Bearer ${APP_TOKEN}` } : {},
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
      if (!detail?.roster) continue
      const yahooId = String(l.leagueKey).split('.').pop() ?? ''
      const kicks = l.feed === 'sleeper' ? {} : (yahooRoster.rosterFor(yahooId)?.kickoff ?? {})
      /*
       * Where the head to head stood last time. A margin that wobbles all
       * afternoon is noise; the crossing is the event, and it cannot be seen
       * without remembering the side you were on.
       */
      const prevAhead = margins.get(l.id) ?? null
      if (detail.matchup) {
        margins.set(l.id, detail.matchup.projected.mine >= detail.matchup.projected.theirs)
      }
      const snap = {
        leagueId: l.id,
        label: l.label,
        link: leagueLink(l),
        waivers: detail.waivers ?? null,
        capturedAt: l.feed === 'sleeper' ? null : (detail.roster.capturedAt ?? null),
        byes: detail.byes ?? null,
        week: detail.roster.week ?? null,
        matchup: detail.matchup
          ? { mine: detail.matchup.projected.mine, theirs: detail.matchup.projected.theirs,
              wasAhead: prevAhead }
          : null,
        players: detail.roster.players.map((p: any) => ({
          id: p.id, name: p.name, pos: p.pos, starter: p.starter,
          injuryStatus: p.injuryStatus, projected: p.projected,
          kickoff: kicks[p.id] ?? null,
        })),
        advice: detail.roster.advice ?? null,
      }
      found.push(...evaluate(snap))
      /*
       * Stored ungated, because this is what the screens read. The push path
       * evaluates again with the gates on, so a questionable tag shows all week
       * and only interrupts you three hours before kickoff.
       */
      outstanding.set(l.id, evaluate(snap, Date.now(), { display: true }))
    }
  }
  /*
   * One name, several teams.
   *
   * Per league this fires once for each, which describes the same hamstring
   * twice and understates it both times: what matters is that twenty-eight
   * points across two lineups just went out, not that one team lost thirteen.
   * Nothing sold commercially can say this, because nothing else sees all four
   * leagues at once.
   */
  const squads: ExposureSquad[] = []
  for (const session of sessions.values()) {
    const l = session.league
    if ((l as any).detected) continue
    const detail = await fetch(`http://localhost:${PORT}/api/cockpit/league/${l.id}`, {
      headers: APP_TOKEN ? { authorization: `Bearer ${APP_TOKEN}` } : {},
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (!detail?.roster) continue
    squads.push({ leagueId: l.id, label: l.label, players: detail.roster.players })
  }
  for (const e of atRisk(exposure(squads))) {
    const hurt = /^(OUT|IR|SUS|SUSP|PUP|NA)$/i.test((e.injuryStatus ?? '').trim())
    found.push({
      id: `exposure:${e.playerId}:${e.injuryStatus}`,
      leagueId: e.leagues[0]?.leagueId ?? '',
      rule: 'exposure',
      headline: `${e.name} is ${(e.injuryStatus ?? '').toLowerCase()} — he starts in ${e.startingIn} of your leagues`,
      detail: `${e.projectedAcross.toFixed(1)} points across ${e.leagues.filter((x) => x.starter).map((x) => x.label).join(' and ')}.`,
      // More than one team, so worse than the single-league case it replaces.
      consequence: hurt ? 95 : 65,
      deadline: null,
      link: null,
    })
  }

  return found
}

async function runAlerts(): Promise<void> {
  try {
    const found = await gatherAlerts()
    // Logged even when empty: silence and a broken pass look identical, and
    // this one only speaks when something is wrong with your team.
    if (!found.length) { console.log('alerts: nothing worth sending'); return }
    const { send, held } = alerts.admitBatch(found)
    for (const a of send) {
      const r = await deliver.deliver(a)
      alerts.markSent(a)
      console.log(`alert: ${a.headline} \u2192 ${r.web} web${r.pushover ? ' + pushover' : ''}`)
    }
    if (held.length) {
      console.log(`alert: ${held.length} held (${[...new Set(held.map((h) => h.why))].join(', ')})`)
    }
  } catch (err) {
    console.warn('alerts failed:', String((err as Error)?.message ?? err))
  }
}

/**
 * What this league wants doing, worked out here rather than read from the last
 * poll — a freshly started server would otherwise show an empty callout for ten
 * minutes while the header counted problems it would not name.
 */
function leagueNeeds(l: any, roster: any, waivers: any): Alert[] {
  const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
  const draft = draftAt != null && draftAt > Date.now()
    ? { at: draftAt, slotSet: l.mySlot != null, mySlot: l.mySlot ?? null }
    : null
  // A league with no roster still has a draft, and the screen should say so
  // rather than going quiet because there are no players to reason about.
  if (!roster?.players?.length) {
    return draft
      ? evaluate({ leagueId: l.id, label: l.label, link: leagueLink(l),
          players: [], advice: null, draft }, Date.now(), { display: true })
      : []
  }
  const kicks =
    l.feed === 'sleeper'
      ? {}
      : yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')?.kickoff ?? {}
  return evaluate({
    leagueId: l.id,
    label: l.label,
    link: leagueLink(l),
    waivers: waivers ?? null,
    draft,
    players: roster.players.map((p: any) => ({
      id: p.id, name: p.name, pos: p.pos, starter: p.starter,
      injuryStatus: p.injuryStatus, projected: p.projected,
      kickoff: (kicks as Record<string, string>)[p.id] ?? null,
    })),
    advice: roster.advice ?? null,
  }, Date.now(), { display: true })
}

/** Where to act. iOS routes these to the league's own app when it is installed. */
function leagueLink(l: any): string | null {
  if (l.feed === 'sleeper') return `https://sleeper.com/leagues/${l.leagueKey}/team`
  const id = String(l.leagueKey).split('.').pop()
  return id ? `https://football.fantasysports.yahoo.com/f1/${id}` : null
}

void runPoll().then(runAlerts)
setInterval(() => { void runPoll().then(runAlerts) }, POLL_MS).unref()

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
  // Without these the icons went out as application/octet-stream, and iOS will
  // not take a Home Screen icon it has not been told is an image.
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Serves the built UI so draft night is one process and one URL. Falls back to
 * index.html so the app still loads if the build is missing a hashed asset.
 */
function serveStatic(pathname: string, res: any): boolean {
  if (!existsSync('dist')) return false
  // Two apps, one process, one URL: /home is the four-league view and /draft
  // is the board. Extensionless paths map to their own html entry.
  /*
   * /home is the four-league view and /draft is the board. Drafting is two
   * days of a season; the rest of it is the thing you open every morning, and
   * "cockpit" only ever described it to the person who built it.
   *
   * Root lands on home because it has to land somewhere, and /cockpit still
   * resolves: it is the manifest's old start_url and where every notification
   * already sent before today points. A link that breaks because the app was
   * rearranged is the worst kind of breakage.
   */
  /*
   * The old path redirects rather than quietly serving the same page, so a
   * bookmark or an old notification link lands on /home and the address bar
   * says so. Serving both silently left the address showing a name the app no
   * longer uses.
   */
  if (pathname === '/cockpit' || pathname === '/cockpit/') {
    res.writeHead(302, { Location: '/home' })
    res.end()
    return true
  }
  const HOME = ['/', '/home', '/home/']
  const rel =
    HOME.includes(pathname) ? '/cockpit.html'
    : pathname === '/draft' || pathname === '/draft/' ? '/index.html'
    : pathname
  // Keep the resolved path inside dist, whatever the request asks for.
  const file = join('dist', normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  const found = existsSync(file) && !file.endsWith('/')

  /*
   * A missing asset is a 404, not the index page.
   *
   * Falling back for every path meant a stale tab asking for a hashed bundle
   * that a deploy had replaced got index.html back with a hundred-per-cent
   * success — which the browser then parsed as CSS, and as JavaScript. The
   * result was an unstyled brown page with no app on it and no error anywhere
   * to say why. Only a navigation can fall back; anything with a file
   * extension answers for itself.
   */
  const isAsset = /\.[a-z0-9]+$/i.test(rel)
  if (!found && isAsset) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found — this build no longer has that file; reload the page')
    return true
  }

  const target = found ? file : 'dist/index.html'
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
    /*
     * Named for the league it mirrors, not for Yahoo's id. A mock cloned from
     * Harker Experi(Mental) appeared as "Yahoo draft 10935997", which is the
     * one thing about it nobody recognises — the draft was there in the list
     * and read as somebody else's.
     */
    label: `${template.league.label} mock`,
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

  /*
   * On a public URL this app hands out roster data and, worse, accepts pushes
   * from the browser extension. Locally there is nothing to defend against and
   * a password would only be something to lose; set APP_TOKEN and it is
   * required, leave it unset and nothing changes.
   *
   * Visiting once with ?token= sets a cookie, so the phone is not asked again
   * and the token never sits in a bookmarked URL after the first load.
   */
  /*
   * Answered before the token check. A health probe carries no credentials, so
   * a guarded one fails permanently and the deploy is marked unhealthy for the
   * single reason that is not a fault. It reports nothing private.
   */
  if (url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      leagues: sessions.size,
      lastPoll: lastPoll.at ? new Date(lastPoll.at).toISOString() : null,
      pollOk: lastPoll.ok,
      state: STATE_DIR,
    })
  }

  /*
   * Identity of this site, taken from the request rather than configured, so
   * the same build works on localhost and on whatever hostname Railway gives
   * it. A passkey is bound to this value: get it wrong and every credential
   * silently stops verifying.
   */
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(':')[0]
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http')
  const rpID = host || 'localhost'
  const origin = `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`
  /*
   * decodeURIComponent throws on a malformed value, and a throw here killed
   * the process: "Cookie: ff_session=%" took the whole server down, health
   * check and all. A cookie is attacker-controlled on a public URL, so it is
   * decoded defensively and a bad one is simply not a credential.
   */
  const cookies = (name: string) => {
    const raw = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1] ?? ''
    if (!raw) return ''
    try { return decodeURIComponent(raw) } catch { return '' }
  }
  const sessionCookie = (token: string) =>
    `ff_session=${token}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${60 * 60 * 24 * 180}${proto === 'https' ? '; Secure' : ''}`

  /*
   * A token in the address is honoured on any path, not only under /api.
   *
   * Guarding the data alone let the unlock screen load, and quietly broke the
   * one journey that matters: opening /home?token=… served the page, set no
   * cookie, and the page's own API calls were then refused — so the address
   * that is supposed to let you in showed the screen telling you to use it.
   * Setting the cookie is not a grant of access; the guard below still decides
   * that. It only remembers what you presented.
   */
  const presented =
    (url.searchParams.get('token') || '') ||
    (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const held = cookies('ff_token')
  if (APP_TOKEN && safeEqual(presented, APP_TOKEN) && !safeEqual(held, APP_TOKEN)) {
    res.setHeader('Set-Cookie',
      `ff_token=${encodeURIComponent(APP_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; ` +
      `Max-Age=${60 * 60 * 24 * 180}${proto === 'https' ? '; Secure' : ''}`)
  }

  /*
   * Passkey exchanges run before the guard, because signing in cannot require
   * being signed in. Enrolling a new one cannot: that needs the token or an
   * existing session, or anyone reaching the page could add their own key.
   */
  if (parts0(url) === 'api' && url.pathname.startsWith('/api/auth/passkey/')) {
    const step = url.pathname.split('/').pop()
    const signedIn = passkeys.validSession(cookies('ff_session'))
    const tokenOk = !APP_TOKEN || safeEqual(url.searchParams.get('token') || '', APP_TOKEN) ||
      safeEqual(cookies('ff_token'), APP_TOKEN)

    if (step === 'state') {
      /*
       * A count, not the labels. The caller only ever needs to know whether
       * anything is enrolled; "iPhone, Mac" told an unauthenticated stranger
       * which devices the owner carries.
       */
      const known = passkeys.enrolled()
      return json(res, 200, {
        enrolled: signedIn || tokenOk ? known : known.map(() => ({ label: 'a device' })),
        count: known.length,
        signedIn,
        needsToken: !!APP_TOKEN && !signedIn && !tokenOk,
      })
    }
    if (step === 'login-options') {
      const out = await passkeys.loginOptions(rpID)
      if (!out) return json(res, 404, { error: 'no passkey enrolled yet' })
      res.setHeader('Set-Cookie', `ff_chal=${out.key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`)
      return json(res, 200, out.options)
    }
    if (step === 'login-verify' && req.method === 'POST') {
      const out = await passkeys.loginVerify(await body(req), cookies('ff_chal'), rpID, origin)
      if (!out.ok) return json(res, 401, { error: out.error })
      res.setHeader('Set-Cookie', sessionCookie(out.session))
      return json(res, 200, { ok: true })
    }
    if (step === 'register-options') {
      if (!signedIn && !tokenOk) return json(res, 401, { error: 'sign in before adding a passkey' })
      const out = await passkeys.registerOptions(rpID, 'Fantasy Companion')
      res.setHeader('Set-Cookie', `ff_chal=${out.key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`)
      return json(res, 200, out.options)
    }
    if (step === 'register-verify' && req.method === 'POST') {
      if (!signedIn && !tokenOk) return json(res, 401, { error: 'sign in before adding a passkey' })
      const b = await body(req)
      const out = await passkeys.registerVerify(
        b.credential, cookies('ff_chal'), rpID, origin, String(b.label ?? 'this device'),
      )
      if (!out.ok) return json(res, 400, { error: out.error })
      res.setHeader('Set-Cookie', sessionCookie(out.session))
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'no such step' })
  }

  /*
   * Only the data is guarded, not the shell that asks you to sign in. Guarding
   * the HTML too meant the unlock screen could never load: the page offering
   * Face ID was itself behind Face ID. The bundle contains no roster, no
   * league and no secret — everything it shows, it fetches.
   */
  if (APP_TOKEN && parts0(url) === 'api') {
    // A passkey session is the everyday way in; the token is how a device is
    // enrolled and how the extension, which cannot do WebAuthn, gets through.
    const signedIn = passkeys.validSession(cookies('ff_session'))
    const ok = signedIn || safeEqual(presented, APP_TOKEN) || safeEqual(held, APP_TOKEN)
    if (!ok) {
      return json(res, 401, { error: 'this companion is private — open it with ?token=' })
    }
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
    // Marked per league, so a tile can say "this one needs you" before it is
    // opened. Read from the last rules pass rather than recomputed here: four
    // league evaluations on every poll of the home screen would be absurd.
    const marks: Record<string, { count: number; worst: number; first: string }> = {}
    for (const [leagueId, list] of outstanding) {
      if (!list.length) continue
      const worst = Math.max(...list.map((a) => a.consequence))
      marks[leagueId] = {
        count: list.length, worst,
        first: list.find((a) => a.consequence === worst)?.headline ?? '',
      }
    }
    const tiles = await buildTiles(
      [...sessions.values()].map((s) => s.league),
      { sleeperUserId: SLEEPER_USER, players: playerMap },
    )
    return json(res, 200, { generatedAt: Date.now(), tiles, marks })
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
    const startingSlots = session
      ? Object.values(session.league.starters as Record<string, number>).reduce((a, b) => a + b, 0) +
        session.league.flex.reduce((a, f) => a + f.count, 0)
      : undefined
    const rec = yahooRoster.record(session?.index ?? sharedIndex, { ...data, startingSlots })
    console.log(
      `yahoo ${data.kind ?? 'team'} ${data.yahooLeagueId}: ${rec.players.length} players` +
      (rec.unmatched.length ? `, ${rec.unmatched.length} unmatched` : '') +
      `, projections ${Object.keys(rec.projected ?? {}).length}` +
      (data.projCol === -1
        ? ` (no projection column; headers seen: ${JSON.stringify(data.sawHeaders ?? [])})`
        : ` (column ${data.projCol})`) +
      (data.shape ? `\n  tables: ${JSON.stringify(data.shape)}` : '') +
      (rec.opponent ? `\n  opponent: ${rec.opponent.players.length} players` : '\n  opponent: none'),
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
      // 'FA' marks an unsigned veteran, not a club: the regex fallback below
      // would match any headline using "FA" as a word.
      if (!p?.team || p.team === 'FA') continue
      const club = CLUB[p.team]
      const hit = wire.items.find((w) => {
        if (Date.now() - w.at >= 2 * DAY_MS) return false
        // A teammate named in the story is the point: a back rises because the
        // man ahead of him got hurt, and that is the reason worth showing.
        if (w.mentions.some((m) => playerMap.get(m.id)?.team === p.team)) return true
        /*
         * The club name counts only in the headline. Searching the body
         * attached a Detroit story about Jared Goff to a New Orleans receiver,
         * because the quote compared Goff to Drew Brees and the summary
         * mentioned the Saints. A headline is about its subject; a body can
         * mention anybody.
         */
        return club
          ? w.title.includes(club)
          : new RegExp(`\\b${p.team}\\b`).test(w.title)
      })
      if (hit) item.because = hit.title.length > 78 ? hit.title.slice(0, 78) + '…' : hit.title
    }

    /*
     * Roles changing, which moves days before the points do — and is a better
     * basis for "rising" than trending adds, where the market is reacting to
     * news that has already broken. Empty until games are played, and it says
     * so rather than pretending the wire is the same thing.
     */
    const usage = await usageReport(Number(new Date().getFullYear()))
    const owned = new Set<string>()
    for (const session of sessions.values()) {
      const cap = yahooRoster.rosterFor(String(session.league.leagueKey).split('.').pop() ?? '')
      for (const id of cap?.players ?? []) owned.add(id)
    }
    const roles = rising(usage.rows, 10).map((u) => ({
      name: u.name, pos: u.pos, team: u.team,
      snapTrend: u.snapTrend, targetTrend: u.targetTrend,
      latestSnap: u.snapPct[0]?.pct ?? null,
      latestTargets: u.targetShare[0]?.share ?? null,
    }))

    return json(res, 200, {
      ...news, wire,
      practice: { season: report.season, note: report.note, players: report.rows.length },
      roles: { rows: roles, note: usage.note, season: usage.season },
    })
  }

  /*
   * Push. The key is public by design — it identifies this server to the
   * browser's push service and is useless without the private half.
   */
  if (parts[1] === 'push' && parts[2] === 'key') {
    return json(res, 200, {
      key: deliver.vapidKeys().publicKey,
      subscribers: deliver.subscriberCount(),
      pushover: deliver.pushoverConfigured(),
      budget: alerts.budget(),
      spentThisWeek: alerts.spent().length,
    })
  }
  if (parts[1] === 'push' && parts[2] === 'subscribe' && req.method === 'POST') {
    const sub = await body(req)
    if (!sub?.endpoint) return json(res, 400, { error: 'not a subscription' })
    return json(res, 200, { subscribers: deliver.subscribe(sub) })
  }
  if (parts[1] === 'push' && parts[2] === 'pushover' && req.method === 'POST') {
    const b = await body(req)
    if (!b?.token || !b?.user) return json(res, 400, { error: 'token and user required' })
    deliver.configurePushover(String(b.token), String(b.user))
    return json(res, 200, { ok: true })
  }
  if (parts[1] === 'push' && parts[2] === 'budget' && req.method === 'POST') {
    const b = await body(req)
    const n = Number(b?.budget)
    if (!Number.isFinite(n) || n < 0 || n > 200) return json(res, 400, { error: 'out of range' })
    alerts.setBudget(Math.round(n))
    return json(res, 200, { budget: alerts.budget() })
  }
  /*
   * A test send, so the chain can be proved end to end before it matters on a
   * Sunday. It bypasses the budget deliberately: this is you asking, not a rule
   * firing, and it should not spend one of your twenty.
   */
  /*
   * What would fire right now, and what the budget would hold back — without
   * sending anything. The only way to see the rules working on a quiet week.
   */
  if (parts[1] === 'push' && parts[2] === 'dryrun') {
    const found = await gatherAlerts()
    const { send, held } = alerts.admitBatch(found)
    return json(res, 200, {
      would: send.map((a) => ({
        rule: a.rule, headline: a.headline, detail: a.detail,
        consequence: a.consequence,
        deadline: a.deadline ? new Date(a.deadline).toLocaleString() : null,
      })),
      held: held.map((h) => ({ rule: h.alert.rule, headline: h.alert.headline, why: h.why })),
      budget: alerts.budget(), spentThisWeek: alerts.spent().length,
    })
  }
  if (parts[1] === 'push' && parts[2] === 'test' && req.method === 'POST') {
    const out = await deliver.deliver({
      id: `test:${Date.now()}`, leagueId: '', rule: 'test',
      headline: 'Fantasy companion is connected',
      detail: 'This is what an alert looks like. Tapping it opens the app.',
      consequence: 0, deadline: null, link: '/home',
    })
    return json(res, 200, out)
  }

  /*
   * Exposure: how much of the season rides on one name. You own the same
   * players across four leagues, so one hamstring can cost three teams at
   * once — and no commercial tool can see that, because none of them sees all
   * four leagues.
   */
  if (parts[1] === 'cockpit' && parts[2] === 'exposure') {
    const squads: ExposureSquad[] = []
    for (const session of sessions.values()) {
      const l = session.league
      if ((l as any).detected) continue
      const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
      if (draftAt != null && draftAt > Date.now()) continue
      const detail = await fetch(`http://localhost:${PORT}/api/cockpit/league/${l.id}`, {
        headers: APP_TOKEN ? { authorization: `Bearer ${APP_TOKEN}` } : {},
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      if (!detail?.roster) continue
      squads.push({
        leagueId: l.id, label: l.label,
        players: detail.roster.players.map((p: any) => ({
          id: p.id, name: p.name, pos: p.pos, team: p.team, byeWeek: p.byeWeek,
          injuryStatus: p.injuryStatus, starter: p.starter, projected: p.projected,
          why: p.why ?? null, practice: p.practice ?? null, severity: p.severity ?? null,
        })),
      })
    }
    const all = exposure(squads)
    return json(res, 200, {
      leagues: squads.length,
      shared: all,
      atRisk: atRisk(all),
    })
  }

  /*
   * Trades, which is the one question that needs every manager's roster rather
   * than only mine. Sleeper hands those over; Yahoo does not without an API
   * grant, so those leagues say so instead of guessing.
   */
  if (parts[1] === 'cockpit' && parts[2] === 'trades') {
    const out: any[] = []
    for (const session of sessions.values()) {
      const l = session.league
      if ((l as any).detected) continue
      const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
      if (draftAt != null && draftAt > Date.now()) continue
      if (l.feed !== 'sleeper') {
        out.push({ leagueId: l.id, label: l.label, blocked: 'needs every roster, which Yahoo will not give without an API grant' })
        continue
      }
      const squads = await sleeperAllSquads(l.leagueKey, SLEEPER_USER)
      if (!squads) { out.push({ leagueId: l.id, label: l.label, blocked: 'could not read the league' }); continue }
      const state = await fetch('https://api.sleeper.app/v1/state/nfl')
        .then((r) => r.json()).catch(() => null)
      const wk = Number(state?.display_week ?? state?.week ?? 1)
      const proj = await weeklyProjections(
        String(state?.season ?? new Date().getFullYear()), wk,
      )
      const toSquad = (r: any) => ({
        teamId: r.teamId, manager: r.manager,
        players: r.playerIds.map((id: string) => {
          const p = playerMap.get(id)
          return { id, name: p?.name ?? id, pos: p?.pos ?? null, projected: proj.pts.get(id) ?? null }
        }),
      })
      // What a lineup demands, flex included, so depth is measured against
      // places to start rather than against a raw count.
      /*
       * Flex places count. Measuring depth against the dedicated slots alone
       * made the fourth running back on a roster with a W/R/T look spare when
       * one of them is filling that flex — and the finder would offer a man
       * who is currently starting.
       */
      const required: Record<string, number> = { ...(l.starters as Record<string, number>) }
      for (const f of (l.flex ?? []) as { eligible: string[]; count: number }[]) {
        // Charged to the position that most often fills it, so the count is
        // raised once rather than once per eligible position.
        const main = f.eligible[0]
        if (main) required[main] = (required[main] ?? 0) + f.count
      }
      const mineSquad = toSquad(squads.mine)
      const otherSquads = squads.others.map(toSquad)

      /*
       * Weakness is judged against the league rather than against zero, for
       * every manager at once — mine to know what to ask for, theirs to know
       * what they would actually want back.
       */
      const weak = weakSpots([mineSquad, ...otherSquads], required)
      const weakAt = weak.get(mineSquad.teamId) ?? []

      const fits = findFits(mineSquad, otherSquads, required, weakAt, 5, weak)
      out.push({ leagueId: l.id, label: l.label, fits, weakAt })
    }
    return json(res, 200, out)
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
      /*
       * A league's own projection wins where it exists. Sleeper's model gave a
       * different total for the same Yahoo roster — not wrong, but not the
       * number that league will score against, and two totals for one team is
       * worse than either alone.
       */
      const yahooLeague = l.feed !== 'sleeper'
      const own = yahooLeague
        ? yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')?.projected ?? {}
        : {}
      let counted = 0
      for (const p of roster.players) {
        if (yahooLeague) {
          /*
           * One source per league, never a blend. Falling back to Sleeper for
           * the players Yahoo did not print would quietly mix two models into
           * one total, and a total nobody can reproduce on the league site is
           * worse than a total with a gap in it.
           */
          const mine = own[p.id]
          p.projected = typeof mine === 'number' ? mine : null
        } else {
          p.projected = projections.pts.get(p.id) ?? null
        }
        if (p.projected != null) counted++
      }
      ;(roster as any).projectedTotal = roster.players
        .filter((p: any) => p.starter)
        .reduce((a: number, p: any) => a + (p.projected ?? 0), 0)
      ;(roster as any).week = week
      ;(roster as any).projectionSource = yahooLeague ? 'Yahoo' : 'Sleeper'
      // A gap is reported rather than filled, so the total can be checked.
      ;(roster as any).projectionCoverage = { counted, of: roster.players.length }

      /*
       * The call itself. Every number for this was already on screen and the
       * app said nothing, which left the arithmetic to the reader at the one
       * moment they are least able to do it — Sunday morning, on a phone.
       */
      if (counted > 0) {
        const advice = advise(
          slotsFor(l.starters as Record<string, number>, l.flex as any),
          roster.players.map((p: any) => ({
            id: p.id, name: p.name, pos: p.pos, projected: p.projected,
            injuryStatus: p.injuryStatus, starter: p.starter,
          })),
        )
        ;(roster as any).advice = {
          gain: advice.gain,
          swaps: advice.swaps.filter((sw) => sw.gain > 0.05).map((sw) => ({
            in: { id: sw.in.id, name: sw.in.name, pos: sw.in.pos, projected: sw.in.projected },
            out: sw.out && { id: sw.out.id, name: sw.out.name, pos: sw.out.pos,
              projected: sw.out.projected, injuryStatus: sw.out.injuryStatus },
            slot: sw.slot, gain: sw.gain, reason: sw.reason,
          })),
        }
      }
    }

    /*
     * Waivers. Sleeper reports everything needed; Yahoo reports none of it
     * without an API grant, so those leagues get the holes — which come from
     * the roster we already have — and no targets. A hole with nobody to fill
     * it is worth seeing and is not worth a notification.
     */
    let waivers: any = null
    if (roster) {
      const squad = roster.players.map((p: any) => ({
        id: p.id, pos: p.pos, starter: p.starter, injuryStatus: p.injuryStatus,
        projected: p.projected, byeWeek: p.byeWeek,
      }))
      const need = holes(
        slotsFor(l.starters as Record<string, number>, l.flex as any), squad, week,
      )
      /*
       * Interest, read straight from Sleeper. It only ever breaks ties between
       * players who project the same — a name everybody is adding who projects
       * for four is still a player who projects for four.
       */
      const trending = new Map<string, number>()
      if (l.feed === 'sleeper') {
        try {
          const t = await fetch(
            'https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=50',
          ).then((r) => (r.ok ? r.json() : []))
          for (const row of t as any[]) trending.set(row.player_id, row.count ?? 0)
        } catch { /* interest is a nicety; its absence must not hide a hole */ }
      }
      if (l.feed === 'sleeper') {
        const [w, all] = await Promise.all([
          sleeperWaivers(l.leagueKey, SLEEPER_USER),
          sleeperLeagueRosters(l.leagueKey, SLEEPER_USER),
        ])
        const clear = nextWaiverClear(w?.dayOfWeek ?? null)
        const free = all
          ? players.filter((p) => !all.taken.has(p.id) && p.pos)
              .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team }))
          : []
        waivers = {
          clearsAt: clear?.at ?? null,
          assumedDay: clear?.assumed ?? null,
          budget: w?.budget ?? null,
          spent: w?.spent ?? 0,
          holes: need,
          targets: targets(free, need, projections?.pts ?? new Map(), trending),
        }
      } else {
        waivers = {
          clearsAt: null, assumedDay: null, budget: null, spent: null,
          holes: need, targets: [],
        }
      }
    }

    /*
     * Who each player faces, and what that defence concedes to his position.
     * The schedule is published before the season, so the opponent shows from
     * week one; the concession rates need games to have been played, so the
     * note stays silent until there is something to base it on rather than
     * inventing an adjective.
     */
    if (roster && !preDraft) {
      const [sched, dvp] = await Promise.all([
        weekGames(Number(nflState?.season ?? new Date().getFullYear()), week),
        defenceVsPosition(Number(nflState?.season ?? new Date().getFullYear())),
      ])
      const opp = opponents(sched.games)
      for (const p of roster.players as any[]) {
        const mine = p.team ? club(p.team) : null
        const facing = mine ? opp.get(mine) ?? null : null
        p.opponent = facing
        p.matchupNote = facing && p.pos
          ? describeMatchup(dvp.table.get(`${facing}|${String(p.pos).toUpperCase()}`))
          : null
      }
    }

    /*
     * Byes, seen far enough ahead to do something. It is the one shortage you
     * can always see coming, and the only one worth spending waiver money on
     * early — by the week itself everyone has had the same idea.
     */
    let byes: any = null
    if (roster && !preDraft) {
      byes = byePlan(
        slotsFor(l.starters as Record<string, number>, l.flex as any),
        roster.players.map((p: any) => ({
          id: p.id, pos: p.pos, starter: p.starter, injuryStatus: p.injuryStatus,
          projected: p.projected, byeWeek: p.byeWeek,
        })),
        week + 1,
      )
    }

    let matchup: any = null

    /*
     * Yahoo's matchup page carries both lineups and its own projections, so a
     * league I had written off as never able to show an opponent can show one
     * after all — the same panel Sleeper gets, from a page you were already
     * opening.
     */
    if (l.feed !== 'sleeper' && !preDraft) {
      const cap = yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')
      if (cap?.opponent?.players.length) {
        const side = (
          ids: string[], proj: Record<string, number>, starters: string[],
          live: Record<string, number>,
        ) =>
          ids
            .filter((id) => starters.includes(id))
            .map((id) => {
              const p = playerMap.get(id)
              return {
                id, name: p?.name ?? id, pos: p?.pos ?? null, team: p?.team ?? null,
                projected: proj[id] ?? null,
                points: live[id] ?? null,
                injuryStatus: p?.injuryStatus ?? null,
                injuryBody: p?.injuryBody ?? null,
                why: p ? whyFor(id, p.name) : null,
              }
            })
        const mine = side(cap.players, cap.projected ?? {}, cap.starters, cap.live ?? {})
        const theirs = side(
          cap.opponent.players, cap.opponent.projected, cap.opponent.starters,
          cap.opponent.live ?? {},
        )
        const sum = (xs: { projected: number | null }[]) =>
          xs.reduce((a, x) => a + (x.projected ?? 0), 0)
        const scored = (xs: { points: number | null }[]) =>
          xs.reduce((a, x) => a + (x.points ?? 0), 0)
        /*
         * Yahoo prints an en dash in Fan Pts until kickoff, so a number there
         * — including nought — means the week is under way. Both sides are
         * checked: your own players may all be in later games.
         */
        const started = [...mine, ...theirs].some((x) => x.points != null)
        matchup = {
          week, opponent: cap.opponent.name ?? 'your opponent',
          live: { mine: scored(mine), theirs: scored(theirs) },
          mine, theirs,
          projected: { mine: sum(mine), theirs: sum(theirs) },
          projectionsAt: cap.at,
          started,
        }
      }
    }

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
              points: underWay ? (m.scored[id] ?? 0) : null,
              injuryStatus: p?.injuryStatus ?? null,
              injuryBody: p?.injuryBody ?? null,
              why: p ? whyFor(id, p.name) : null,
            }
          })
        // Decided once, before the rows are built, so a player who has genuinely
        // scored nothing is not confused with a game that has not kicked off.
        const underWay = (m.livePoints.mine ?? 0) > 0 || (m.livePoints.theirs ?? 0) > 0
        const mine = side(m.mine)
        const theirs = side(m.theirs)
        const sum = (xs: { projected: number | null }[]) =>
          xs.reduce((a, x) => a + (x.projected ?? 0), 0)
        matchup = {
          week: m.week, opponent: m.opponent, live: m.livePoints,
          mine, theirs,
          projected: { mine: sum(mine), theirs: sum(theirs) },
          projectionsAt: proj.at,
          started: underWay,
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
      matchup, waivers, byes,
      needs: leagueNeeds(l, roster, waivers).map((a) => ({
        rule: a.rule, headline: a.headline, detail: a.detail,
        consequence: a.consequence,
        deadline: a.deadline,
      })),
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
    /*
     * Every draft on record, each carrying what it cost. The list used to be
     * labels and dates only, which told you nothing about which draft was worth
     * opening — and a draft with no slot captured has no review at all, so say
     * that rather than offering a link that goes nowhere.
     */
    const metrics = new Map(inputs.map((i) => [i.key, i.review]))
    const allDrafts = archive.list().map((rec) => {
      const r = metrics.get(rec.key)
      // Records keep the label they were filed under; the league may have been
      // renamed since, and detected mocks were all filed under a Yahoo id.
      const live = sessions.get(rec.leagueId)?.league
      return {
        ...rec,
        leagueLabel: live?.label ?? rec.leagueLabel,
        mockOf: (live as any)?.templateFrom ?? null,
        reviewable: Boolean(r),
        noReviewReason:
          rec.mySlot == null
            ? 'your slot was never captured'
            : rec.excluded
              ? (rec.excludedReason ?? 'excluded')
              : rec.picks < 20
                ? 'too few picks recorded'
                : null,
        totalCost: r?.totalCost ?? null,
        costEarly: r?.costEarly ?? null,
        gain: r?.counterfactual?.gain ?? null,
        unfilled: r?.structure?.unfilledStarters?.reduce((a: number, u: any) => a + u.count, 0) ?? null,
      }
    })
    return json(res, 200, {
      ...report,
      sources: inputs.map(({ review, ...d }) => d),
      allDrafts,
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
