/*
 * Bridges the content script to the local companion.
 *
 * The content script can read Yahoo but cannot POST to http://localhost from an
 * HTTPS page. The extension can, so every write goes through here.
 */

/*
 * Where the companion lives, and how to prove we are allowed to talk to it.
 *
 * Hosted, the companion is guarded and this cannot use Face ID — an extension
 * has no way to perform WebAuthn — so it presents the token instead. That is
 * the job the token keeps once passkeys handle the browser: machine access.
 *
 * Set both from the extension's popup; they persist across restarts.
 */
let BASE = 'http://localhost:4600'
let TOKEN = ''

chrome.storage?.local.get(['base', 'token'], (v) => {
  if (v?.base) BASE = String(v.base).replace(/\/+$/, '')
  if (v?.token) TOKEN = String(v.token)
})
chrome.storage?.onChanged.addListener((ch) => {
  if (ch.base) BASE = String(ch.base.newValue || '').replace(/\/+$/, '') || 'http://localhost:4600'
  if (ch.token) TOKEN = String(ch.token.newValue || '')
})

/** Every call to the companion carries the token when one is configured. */
function authHeaders(extra) {
  return TOKEN ? { ...extra, authorization: `Bearer ${TOKEN}` } : { ...extra }
}

let status = { connected: false, lastPush: null, lastError: null, counts: {} }

async function leagues() {
  const res = await fetch(`${BASE}/api/leagues`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`companion HTTP ${res.status}`)
  const all = await res.json()
  // Only Yahoo leagues, paired with the numeric id the results page uses.
  return all
    .filter((l) => l.platform === 'yahoo')
    .map((l) => ({
      leagueId: l.id,
      label: l.label,
      yahooLeagueId: String(l.leagueKey || '').split('.').pop() || l.leagueId,
    }))
}

/** Replying to a closed port throws; the sender has simply gone away. */
function safeReply(reply, value) {
  try {
    reply(value)
  } catch {
    // Nothing to do — the tab or popup that asked is no longer listening.
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'yahooRoster') {
    fetch(`${BASE}/api/cockpit/yahoo-roster`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(msg),
    })
      .then((r) => r.json())
      .then((v) => safeReply(reply, v))
      .catch((err) => safeReply(reply, { ok: false, error: String(err) }))
    return true
  }

  if (msg.type === 'leagues') {
    leagues()
      .then((list) => {
        status.connected = true
        status.lastError = null
        safeReply(reply, { leagues: list })
      })
      .catch((err) => {
        status.connected = false
        status.lastError = String(err.message || err)
        safeReply(reply, { leagues: null, error: status.lastError })
      })
    return true
  }

  if (msg.type === 'detected') {
    fetch(`${BASE}/api/detect`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        platform: 'yahoo',
        yahooLeagueId: msg.yahooLeagueId,
        teamId: msg.teamId,
        shape: msg.shape,
        rows: msg.rows,
      }),
    })
      .then((r) => r.json())
      .then((json) => {
        status.connected = true
        status.lastPush = Date.now()
        if (json.leagueId) status.counts[json.leagueId] = json.accepted ?? 0
        safeReply(reply, json)
      })
      .catch((err) => {
        status.connected = false
        status.lastError = String(err.message || err)
        safeReply(reply, { ok: false })
      })
    return true
  }

  if (msg.type === 'snapshot') {
    // Must return true and reply only once the fetch settles. Returning false
    // lets Chrome tear the service worker down mid-request, which silently
    // drops the push — the sensor looks alive and nothing ever arrives.
    fetch(`${BASE}/api/league/${msg.leagueId}/yahoo`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ rows: msg.rows, shape: msg.shape }),
    })
      .then((r) => r.json())
      .then((json) => {
        status.connected = true
        status.lastPush = Date.now()
        status.counts[msg.leagueId] = json.accepted ?? 0
        status.lastError = json.unresolved?.length
          ? `${json.unresolved.length} unresolved: ${json.unresolved.slice(0, 3).join(', ')}`
          : null
        safeReply(reply, { ok: true, accepted: json.accepted ?? 0 })
      })
      .catch((err) => {
        status.connected = false
        status.lastError = String(err.message || err)
        safeReply(reply, { ok: false, error: status.lastError })
      })
    return true
  }

  if (msg.type === 'error') {
    status.lastError = `${msg.leagueId}: ${msg.message}`
    // Forward to the companion so its health badge tells the truth.
    fetch(`${BASE}/api/league/${msg.leagueId}/yahoo`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ error: msg.message }),
    })
      .then(() => safeReply(reply, { ok: true }))
      .catch(() => safeReply(reply, { ok: false }))
    return true
  }

  if (msg.type === 'status') {
    safeReply(reply, status)
    return true
  }
  return false
})
