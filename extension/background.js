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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'leagues') {
    leagues()
      .then((list) => {
        status.connected = true
        status.lastError = null
        reply({ leagues: list })
      })
      .catch((err) => {
        status.connected = false
        status.lastError = String(err.message || err)
        reply({ leagues: null, error: status.lastError })
      })
    return true
  }

  if (msg.type === 'snapshot') {
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
      })
      .catch((err) => {
        status.connected = false
        status.lastError = String(err.message || err)
      })
    return false
  }

  if (msg.type === 'error') {
    status.lastError = `${msg.leagueId}: ${msg.message}`
    return false
  }

  if (msg.type === 'status') {
    reply(status)
    return true
  }
  return false
})
