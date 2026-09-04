chrome.runtime.sendMessage({ type: 'leagues' }, (l) => {
  if (chrome.runtime.lastError) return
  const el = document.getElementById('leagues')
  if (el) {
    el.innerHTML = l && l.leagues
      ? l.leagues.map((x) => `<div class="row"><span>${x.label}</span><code>${x.yahooLeagueId}</code></div>`).join('')
      : '<div class="err">could not read the league list</div>'
  }
})

chrome.runtime.sendMessage({ type: 'status' }, (s) => {
  if (chrome.runtime.lastError) return
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

/*
 * Where the companion lives. Hosted, it is guarded and this cannot use Face ID
 * — an extension has no way to perform WebAuthn — so it presents the token.
 * That is the job the token keeps once passkeys handle the browser.
 */
chrome.storage.local.get(['base', 'token'], (v) => {
  document.getElementById('base').value = v?.base || ''
  document.getElementById('token').value = v?.token || ''
})
document.getElementById('save').addEventListener('click', () => {
  const base = document.getElementById('base').value.trim().replace(/\/+$/, '')
  const token = document.getElementById('token').value.trim()
  chrome.storage.local.set({ base, token }, () => {
    const el = document.getElementById('saved')
    el.textContent = ' saved'
    setTimeout(() => { el.textContent = '' }, 1500)
  })
})
