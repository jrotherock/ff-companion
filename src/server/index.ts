import { createServer } from 'node:http'
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { LeagueSession } from './session.js'
import { SleeperAdapter } from '../adapters/sleeper.js'
import { YahooExtAdapter } from '../adapters/yahoo-ext.js'
import type { AdjustmentData } from '../kernel/adjust.js'
import type { LeagueConfig, Player } from '../kernel/types.js'

const PORT = Number(process.env.PORT ?? 4600)

const { players } = JSON.parse(readFileSync('data/players.json', 'utf8')) as { players: Player[] }
const adjustments: AdjustmentData | null = existsSync('data/adjustments.json')
  ? (JSON.parse(readFileSync('data/adjustments.json', 'utf8')) as AdjustmentData)
  : null

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
  const msg = JSON.stringify({ type: 'view', leagueId, view: session.view() })
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
  const rel = pathname === '/' ? '/index.html' : pathname
  // Keep the resolved path inside dist, whatever the request asks for.
  const file = join('dist', normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  const target = existsSync(file) && !file.endsWith('/') ? file : 'dist/index.html'
  if (!existsSync(target)) return false
  res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' })
  res.end(readFileSync(target))
  return true
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

  if (parts[1] === 'leagues') {
    return json(
      res,
      200,
      [...sessions.values()].map((s) => ({
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
          const draftId = data.draftId ? String(data.draftId).trim() : null
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
