/*
 * Yahoo sensor.
 *
 * This deliberately does NOT read the draft room. It fetches Yahoo's own
 * server-rendered draft results page, same-origin, from whatever Yahoo tab
 * happens to be open. That means:
 *
 *   - it needs no API approval and no cookie export, because the fetch
 *     inherits the session already in the browser
 *   - it survives Yahoo redesigning the draft room, because a results table is
 *     a far more stable surface than React internals
 *   - it works while you draft from the phone app, as long as one desktop tab
 *     is sitting on any Yahoo fantasy page
 *
 * The match pattern is the whole fantasysports domain rather than a draft-room
 * URL, because matching on URL shape is exactly the failure this design exists
 * to avoid.
 *
 * The POST to localhost goes through the background worker: a page served over
 * HTTPS cannot fetch plain HTTP, but the extension can.
 */

/*
 * Yahoo rate-limits with HTTP 999 and it is unforgiving: a 3s poll got the whole
 * origin blocked, after which the companion showed a stale board while looking
 * healthy. Poll gently and back off hard when refused.
 */
const POLL_MS = 6000
const MAX_BACKOFF_MS = 120000

/** Yahoo abbreviates a few positions differently from the app. */
const POS_ALIAS = { DEF: 'DST', D: 'DST' }

function parseDraftResults(doc) {
  const rows = []
  for (const table of doc.querySelectorAll('table')) {
    for (const tr of table.rows) {
      const cells = tr.cells
      if (!cells || cells.length < 3) continue
      const link = cells[1].querySelector('a.name')
      if (!link) continue

      const pickInRound = Number((cells[0].textContent || '').trim().replace('.', ''))
      if (!pickInRound) continue

      const meta = cells[1].querySelector('span')
      const m = /\(([\w.\- ]+)\s*-\s*([A-Z/]+)\)/.exec(meta ? meta.textContent : '')
      const manager = (cells[2].getAttribute('title') || cells[2].textContent || '').trim()

      rows.push({
        pickInRound,
        name: link.textContent.trim(),
        team: m ? m[1].trim().toUpperCase() : '',
        pos: m ? POS_ALIAS[m[2]] || m[2] : '',
        manager,
      })
    }
  }

  // Yahoo renders one table per round, in order, so the round is the table the
  // row came from. Recovered by walking pick numbers rather than table index,
  // which keeps working if the markup nests differently.
  let round = 0
  let last = Infinity
  for (const r of rows) {
    if (r.pickInRound <= last) round++
    last = r.pickInRound
    r.round = round
  }
  return rows
}

async function pollLeague(mapping) {
  const url = `/f1/${mapping.yahooLeagueId}/draftresults`
  const res = await fetch(url, { credentials: 'include' })
  if (res.status === 999) {
    const err = new Error('Yahoo is rate limiting (HTTP 999) — backing off')
    err.rateLimited = true
    throw err
  }
  if (!res.ok) throw new Error(`draftresults HTTP ${res.status}`)
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
  const rows = parseDraftResults(doc)
  if (!rows.length) return { leagueId: mapping.leagueId, rows: [], skipped: 'no picks yet' }
  return { leagueId: mapping.leagueId, rows }
}

let mappings = []
let timer = null
let mappingTimer = null
let failures = 0

/**
 * A draft room URL carries everything needed to sense a draft the companion has
 * never heard of: /draftclient/f1/<leagueId>/<teamId>. Reading it means a mock
 * is picked up by opening it, with no id to copy anywhere.
 */
/**
 * Your own team page, which is the one Yahoo URL that needs no guessing.
 *
 * With no API access, roster state has to come from somewhere, and every other
 * route requires knowing your team id in advance — which nothing knows before a
 * draft. Visiting your team is the one moment you hand it over for free, so the
 * sensor takes it then rather than hunting for it.
 *
 *   /f1/<leagueId>/<teamId>
 */
function detectedTeam() {
  /*
   * Yahoo hangs extra segments off a team page — /team, /roster, a week number —
   * and an exact match caught none of them. Anything under /f1/<league>/<team>
   * is the same team page, so the id is taken and the rest ignored.
   *
   * The draft room is excluded: it lives at /draftclient/f1/... and is handled
   * by the pick sensor, which wants the draft rather than the roster.
   */
  const m = /^\/f1\/(\d+)\/(\d+)(?:\/|$)/.exec(location.pathname)
  return m ? { yahooLeagueId: m[1], teamId: m[2] } : null
}

/**
 * Players on the page, read off the links Yahoo puts round every name.
 *
 * Deliberately loose: this is scraping, the markup will change, and a parser
 * that insists on one structure fails silently the week it matters. Anything
 * it cannot read is reported rather than dropped, so a broken selector shows up
 * as a complaint instead of an empty roster.
 */
function parseRoster(doc) {
  const rows = []
  const unread = []

  // Player rows first; the column layout is worked out from them afterwards.
  const trs = []
  for (const tr of doc.querySelectorAll('tr')) {
    const link =
      tr.querySelector('a[href*="/players/"], a[href*="/nfl/players/"]') ??
      tr.querySelector('a[href*="/teams/"]')
    if (!link) continue
    const name = (link.textContent || '').trim()
    if (!name || name.length > 40) continue
    trs.push({ tr, name, link })
  }

  /*
   * Which column holds the projection, decided by testing rather than by
   * reading a header. Matching header text alone picked column zero — the
   * word "proj" appeared in the first cell of an unrelated row, and the
   * position column was read as points for every player.
   *
   * A candidate has to parse as a plausible score on most player rows to be
   * accepted, which no label can fake.
   */
  const width = Math.max(0, ...trs.map((x) => x.tr.children.length))
  const headerCells = []
  for (const tr of doc.querySelectorAll('tr')) {
    const cells = [...tr.children].map((c) => (c.textContent || '').trim())
    if (cells.length === width && cells.some((h) => /player|pos|proj|pts/i.test(h))) {
      headerCells.push(...cells)
      break
    }
  }

  /*
   * A projection carries a decimal point; a bye week does not. Accepting any
   * integer in a plausible range took the bye column — ten for Nix, seven for
   * Cook, thirteen for Henry, all correct byes and all read as points, summing
   * to eighty against Yahoo's ninety-nine.
   */
  let projCol = -1
  let bestScore = 0
  for (let c = 0; c < width; c++) {
    let numeric = 0
    let decimals = 0
    for (const { tr } of trs) {
      const raw = (tr.children[c]?.textContent || '').trim()
      if (!/^\d+(\.\d+)?$/.test(raw)) continue
      const n = Number.parseFloat(raw)
      if (!Number.isFinite(n) || n < 0 || n >= 80) continue
      numeric++
      if (raw.includes('.')) decimals++
    }
    const enough = numeric >= Math.max(3, trs.length * 0.6)
    // Most values must be fractional, which no week number ever is.
    const fractional = decimals >= numeric * 0.5
    if (!enough || !fractional) continue
    const labelled = /proj/i.test(headerCells[c] ?? '') ? 1.5 : 1
    const score = (numeric / Math.max(1, trs.length)) * labelled
    if (score > bestScore) { bestScore = score; projCol = c }
  }

  for (const { tr, name } of trs) {
    const text = (tr.textContent || '').replace(/\s+/g, ' ')
    const posTeam = /\b([A-Z]{2,3})\s*-\s*(QB|RB|WR|TE|K|DEF|D\/ST|DB|DL|LB)\b/.exec(text)
    const slot = (tr.querySelector('td')?.textContent || '').trim().slice(0, 6)
    const isDef = /^(DEF|D\/ST|DST|D)$/i.test(slot) || /\bDEF\b/.test(text)
    let projected = null
    if (projCol >= 0) {
      const n = Number.parseFloat((tr.children[projCol]?.textContent || '').trim())
      if (Number.isFinite(n)) projected = n
    }
    rows.push({
      name,
      team: posTeam ? posTeam[1] : null,
      pos: posTeam ? posTeam[2] : isDef ? 'DEF' : null,
      slot,
      projected,
    })
  }

  return { rows, unread, projCol, sawHeaders: headerCells }
}

function detectedDraft() {
  const m = /\/draftclient\/f1\/(\d+)\/(\d+)/.exec(location.pathname)
  return m ? { yahooLeagueId: m[1], teamId: m[2] } : null
}

/** Team count and round count are both readable off the results table. */
function shapeOf(rows) {
  if (!rows.length) return null
  return {
    teams: Math.max(...rows.map((r) => r.pickInRound)),
    rounds: Math.max(...rows.map((r) => r.round)),
  }
}

/**
 * Every message goes through here. Two things bite otherwise: an unchecked
 * runtime.lastError logs an error for any send whose reply never lands, and
 * after the extension is reloaded the old content script keeps running against
 * a dead context, throwing "Extension context invalidated" on every tick.
 */
function send(message) {
  return new Promise((resolve) => {
    try {
      if (!chrome.runtime?.id) {
        stopAll()
        return resolve(null)
      }
      chrome.runtime.sendMessage(message, (reply) => {
        // Reading it is what marks it handled; an unread lastError is logged.
        if (chrome.runtime.lastError) return resolve(null)
        resolve(reply ?? null)
      })
    } catch {
      stopAll()
      resolve(null)
    }
  })
}

function stopAll() {
  clearInterval(timer)
  clearInterval(mappingTimer)
  timer = null
  mappingTimer = null
}

let backoff = 0

/**
 * Rosters change when you make a move, not minute to minute, so this pushes
 * whatever the page already shows rather than polling for it. Stale-but-real
 * with an honest timestamp beats absent, and beats invented by a mile.
 */
let lastRosterPush = 0
async function captureRoster() {
  const team = detectedTeam()
  if (!team) return
  if (Date.now() - lastRosterPush < 60000) return
  const { rows, unread, projCol, sawHeaders } = parseRoster(document)
  // Say so rather than failing silently: a page with no readable rows is the
  // symptom of Yahoo changing its markup, and silence looks identical to
  // "you never opened the page".
  if (!rows.length && !unread.length) {
    await send({ type: 'error', leagueId: 'yahoo-roster', message:
      `no player rows found on ${location.pathname}` })
    return
  }
  lastRosterPush = Date.now()
  await send({
    type: 'yahooRoster',
    yahooLeagueId: team.yahooLeagueId,
    teamId: team.teamId,
    players: rows,
    unread,
    projCol,
    sawHeaders,
    url: location.href,
  })
}

async function tick() {
  await captureRoster()
  if (backoff && Date.now() < backoff) return

  // A draft room open in this tab is sensed whether or not it is configured.
  const detected = detectedDraft()
  const targets = [...mappings]
  if (detected && !targets.some((m) => m.yahooLeagueId === detected.yahooLeagueId)) {
    targets.push({ leagueId: null, ...detected, adhoc: true })
  }
  if (!targets.length) return

  for (const mapping of targets) {
    try {
      // Always report, even with nothing to say. Before a draft starts there
      // are no picks, and a sensor that only speaks when it has picks is
      // indistinguishable from one that is dead — which is exactly the thing
      // you need to know at 9:55pm.
      const payload = await pollLeague(mapping)
      backoff = 0
      failures = 0
      // The shape goes with every push, not just the first. A team count
      // asserted once and never rechecked is how a 14-team mock was read as
      // twelve, collapsing two picks of every round onto one another.
      const shape = shapeOf(payload.rows)
      if (mapping.adhoc) {
        await send({
          type: 'detected',
          yahooLeagueId: mapping.yahooLeagueId,
          teamId: mapping.teamId,
          shape,
          rows: payload.rows,
        })
        continue
      }
      // Awaiting the reply keeps the service worker alive until the POST lands.
      await send({ type: 'snapshot', ...payload, shape })
    } catch (err) {
      const message = String(err && err.message ? err.message : err)
      if (err && err.rateLimited) {
        failures++
        backoff = Date.now() + Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS)
      }
      // Tell the companion, not just the popup: silence is indistinguishable
      // from a quiet draft, and it would keep showing the last good board.
      await send({ type: 'error', leagueId: mapping.leagueId ?? 'detected', message })
    }
  }
}

async function loadMappings(onReady) {
  const reply = await send({ type: 'leagues' })
  if (!reply || !reply.leagues) {
    // The companion is not running yet; try again rather than dying.
    setTimeout(() => loadMappings(onReady), 5000)
    return
  }
  mappings = reply.leagues
  if (onReady) onReady()
}

function start() {
  loadMappings(() => {
    if (!mappings.length) return
    clearInterval(timer)
    tick()
    timer = setInterval(tick, POLL_MS)
  })
  // A mock started mid-session adds a league the companion did not have when
  // this tab loaded. Re-reading the list means that heals itself instead of
  // needing a reload at exactly the wrong moment.
  clearInterval(mappingTimer)
  mappingTimer = setInterval(() => loadMappings(null), 30000)
}

start()
