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
  // One line per companion, so a hosted copy that is not being reached says so
  // instead of simply staying empty.
  const targets = (s.targets || []).map((t) => {
    const cls = t.ok === null ? 'muted' : t.ok ? 'ok' : 'bad'
    const dot = t.ok === null ? '·' : t.ok ? '●' : '●'
    const host = t.base.replace(/^https?:\/\//, '')
    return `<div class="row"><span><span class="dot ${cls}"></span>${host}</span>` +
           `<span class="muted">${t.detail}</span></div>`
  }).join('')
  el.innerHTML = targets +
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
chrome.storage.local.get(['base', 'token', 'base2', 'token2'], (v) => {
  document.getElementById('base').value = v?.base || ''
  document.getElementById('token').value = v?.token || ''
  document.getElementById('base2').value = v?.base2 || ''
  document.getElementById('token2').value = v?.token2 || ''
})
document.getElementById('save').addEventListener('click', () => {
  const clean = (id) => document.getElementById(id).value.trim().replace(/\/+$/, '')
  const base = clean('base')
  const token = document.getElementById('token').value.trim()
  const base2 = clean('base2')
  const token2 = document.getElementById('token2').value.trim()
  chrome.storage.local.set({ base, token, base2, token2 }, () => {
    const el = document.getElementById('saved')
    el.textContent = ' saved'
    setTimeout(() => { el.textContent = '' }, 1500)
  })
})
