/*
 * Bridges the content script to the local companion.
 *
 * The content script can read Yahoo but cannot POST to http://localhost from an
 * HTTPS page. The extension can, so every write goes through here.
 */

const BASE = 'http://localhost:4600'

let status = { connected: false, lastPush: null, lastError: null, counts: {} }

async function leagues() {
  const res = await fetch(`${BASE}/api/leagues`)
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: msg.rows }),
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
      headers: { 'Content-Type': 'application/json' },
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
