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
  if (m) return { yahooLeagueId: m[1], teamId: m[2], kind: 'team' }
  /*
   * The matchup page, which is where Yahoo keeps the projections. The team
   * page has no projection column at all — its "Fan Pts" is points already
   * scored, blank until kickoff — so the number quoted on the site could never
   * have come from the page being read. This one also carries the opponent,
   * which the team page cannot.
   */
  const mm = /^\/f1\/(\d+)\/matchup/.exec(location.pathname)
  if (mm) {
    const mid = new URLSearchParams(location.search).get('mid1')
    return { yahooLeagueId: mm[1], teamId: mid ?? '', kind: 'matchup' }
  }
  return null
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
  // Every row here is mine: the matchup page, which does carry two lineups, is
  // read by parseMatchup instead. Splitting this one by table lost my bench.
  const trs = []
  for (const tr of doc.querySelectorAll('tr')) {
    const link =
      tr.querySelector('a[href*="/players/"], a[href*="/nfl/players/"]') ??
      tr.querySelector('a[href*="/teams/"]')
    if (!link) continue
    const name = (link.textContent || '').trim()
    if (!name || name.length > 40) continue
    trs.push({ tr, name, link, table: tr.closest('table') })
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

  const tables = []
  for (const { table } of trs) if (table && !tables.includes(table)) tables.push(table)

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

  /*
   * A shape report, so a page that does not parse can be diagnosed from the log
   * rather than by guessing at markup nobody here can see. Three wrong guesses
   * at the projection column cost five extension reloads; one header dump ended
   * it in a single pass.
   */
  const shape = tables.map((t, i) => ({
    table: i,
    players: trs.filter((x) => x.table === t).length,
    caption: (t.closest('[class*=matchup], section, div')?.querySelector('h1,h2,h3,caption')
      ?.textContent || '').trim().slice(0, 40),
  }))
  return { rows, unread, projCol, sawHeaders: headerCells, shape, totalPlayerRows: trs.length }
}

/*
 * The matchup page, as it actually is — read from the live page rather than
 * inferred. Four guesses at its shape were all wrong, so this records what is
 * there:
 *
 *   cell 1  my player      cell 2  my projection
 *   cell 4  the slot       (QB RB WR TE W/R/T K DEF BN) — authoritative
 *   cell 8  their proj     cell 9  their player
 *
 * Both lineups share every row; they are mirrored across the slot column, not
 * held in separate tables. That is why splitting by table produced my own bench
 * as the opposing team, and why one projection column could never be right for
 * both sides.
 *
 * Two details that cost captures before: the DEF row carries no player link at
 * all (the name "Vikings" is plain text), and the slot label is printed, so
 * starters need not be guessed at by counting.
 */
/*
 * Every slot label Yahoo prints across these leagues. A bare "D" is the
 * defensive flex in the IDP league — it accepts a defensive back, lineman or
 * linebacker, and is not a team defence, which Yahoo writes as DEF. Leaving it
 * out silently dropped that row: a starter missing from the roster, from the
 * projected total and from start/sit, with nothing to show it had happened.
 */
const SLOT = /^(QB|RB|WR|TE|W\/R\/T|Q\/W\/R\/T|K|DEF|D\/ST|D|BN|IR|DB|DL|LB)$/i

function parseMatchup(doc) {
  /*
   * A defence links somewhere other than /players/, so restricting to that href
   * dropped the Vikings and took the surrounding interface text as the name.
   * The first anchor that reads like a name works for both, once the note,
   * forecast and kickoff links are excluded.
   */
  const read = (cell) => {
    if (!cell) return null
    let name = null
    for (const a of cell.querySelectorAll('a')) {
      const t = (a.textContent || '').trim()
      if (!t || t.length > 40) continue
      if (/note|forecast|video|\bvs\b|@\s|\d{1,2}:\d{2}/i.test(t)) continue
      name = t
      break
    }
    if (!name) return null
    // "Min - DEF" sits in the same cell, giving club and position for free and
    // making resolution exact instead of a name lookup and a hope.
    const flat = (cell.textContent || '').replace(/\s+/g, ' ')
    const m = /\b([A-Za-z]{2,3})\s*-\s*(QB|RB|WR|TE|K|DEF|DB|DL|LB)\b/.exec(flat)
    /*
     * "Sun 1:25 pm vs GB" — the kickoff, which is when this player's slot
     * locks. A weekly deadline would be wrong for anyone playing Thursday or
     * Monday, and those are exactly the lineups that go unattended.
     */
    const k = /\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{1,2}:\d{2}\s*[ap]m)\b/i.exec(flat)
    return {
      name,
      team: m ? m[1].toUpperCase() : null,
      pos: m ? m[2].toUpperCase() : null,
      kickoff: k ? `${k[1]} ${k[2]}`.replace(/\s+/g, ' ') : null,
    }
  }
  const num = (cell) => {
    const n = Number.parseFloat(((cell && cell.textContent) || '').trim())
    return Number.isFinite(n) ? n : null
  }

  const mine = []
  const opp = []
  for (const tr of doc.querySelectorAll('tr')) {
    const c = tr.children
    if (c.length < 10) continue
    const slot = (c[4].textContent || '').trim()
    if (!SLOT.test(slot)) continue
    const bench = /^(BN|IR)$/i.test(slot)
    const left = read(c[1])
    const right = read(c[9])
    if (!left && !right) continue
    /*
     * Fan Pts sits beside each projection — cell 3 mine, cell 7 theirs — and
     * reads "\u2013" until kickoff, so a null here means the week has not
     * started rather than that the player scored nothing.
     */
    if (left) mine.push({ ...left, slot, bench, projected: num(c[2]), points: num(c[3]) })
    if (right) opp.push({ ...right, slot, bench, projected: num(c[8]), points: num(c[7]) })
  }
  if (mine.length < 5 || opp.length < 5) return null

  // Team names sit beside each side's logo link; the page owner's comes first.
  const names = []
  for (const a of doc.querySelectorAll('a[href]')) {
    if (!/^\/f1\/\d+\/\d+$/.test(a.getAttribute('href') || '')) continue
    if (!a.querySelector('img')) continue
    const t = ((a.parentElement && a.parentElement.textContent) || '')
      .trim().replace(/\s+/g, ' ')
    const m = /^(.{2,34}?)\s+\S+\s+\d+-\d+-\d+/.exec(t)
    if (m) names.push(m[1])
  }
  return { mine, opponent: opp, teamName: names[0] || null, opponentName: names[1] || null }
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
  const matchup = parseMatchup(document)
  const { rows, unread, projCol, sawHeaders, shape, totalPlayerRows } = parseRoster(document)
  // Say so rather than failing silently: a page with no readable rows is the
  // symptom of Yahoo changing its markup, and silence looks identical to
  // "you never opened the page".
  if (!rows.length && !unread.length && !matchup) {
    await send({ type: 'error', leagueId: 'yahoo-roster', message:
      `no player rows found on ${location.pathname}` })
    return
  }
  lastRosterPush = Date.now()
  await send({
    type: 'yahooRoster',
    kind: team.kind,
    yahooLeagueId: team.yahooLeagueId,
    teamId: team.teamId,
    players: matchup ? matchup.mine : rows,
    matchup,
    unread,
    projCol,
    sawHeaders,
    shape,
    totalPlayerRows,
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
