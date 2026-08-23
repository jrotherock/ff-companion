chrome.runtime.sendMessage({ type: 'leagues' }, (l) => {
  const el = document.getElementById('leagues')
  if (el) {
    el.innerHTML = l && l.leagues
      ? l.leagues.map((x) => `<div class="row"><span>${x.label}</span><code>${x.yahooLeagueId}</code></div>`).join('')
      : '<div class="err">could not read the league list</div>'
  }
})

chrome.runtime.sendMessage({ type: 'status' }, (s) => {
  const el = document.getElementById('body')
  if (!s) {
    el.textContent = 'no response from the extension worker'
    return
  }
  const rows = Object.entries(s.counts || {})
    .map(([k, v]) => `<div class="row"><span>${k}</span><span class="muted">${v} picks</span></div>`)
    .join('')
  const age = s.lastPush ? `${Math.round((Date.now() - s.lastPush) / 1000)}s ago` : 'never'
  el.innerHTML =
    `<div class="row"><span><span class="dot ${s.connected ? 'ok' : 'bad'}"></span>` +
    `${s.connected ? 'companion connected' : 'companion unreachable'}</span>` +
    `<span class="muted">${age}</span></div>` +
    rows +
    (s.lastError ? `<div class="err">${s.lastError}</div>` : '') +
    (!s.connected ? '<div class="err">start it with <code>npm run dev</code></div>' : '')
})
