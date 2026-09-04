import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * End to end: a real server, over real HTTP, on a state directory of its own.
 *
 * The unit tests check that each piece is right; these check that the pieces
 * are wired together, which is where the day's actual bugs were. The trades
 * route was written, compiled and unit-tested while returning "not found" to
 * every caller, because the process holding the port was the old build. The
 * waiver figures were computed correctly and left out of the response. Neither
 * is visible from below.
 *
 * It never touches the live state directory, and never the real leagues: it
 * runs against the committed examples, so a passing suite proves the thing a
 * stranger cloning this would get.
 */

const PORT = 4788
const BASE = `http://localhost:${PORT}`
let server: ChildProcess
let state: string

const get = (path: string, init?: RequestInit) => fetch(`${BASE}${path}`, init)
const json = async (path: string, init?: RequestInit) => {
  const r = await get(path, init)
  return { status: r.status, body: await r.json().catch(() => null) as any }
}

async function waitForHealth(timeoutMs = 45000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('server never became healthy')
}

before(async () => {
  state = mkdtempSync(join(tmpdir(), 'ff-e2e-'))
  server = spawn('npx', ['tsx', 'src/server/index.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      STATE_DIR: state,
      ALERT_STORE: join(state, 'alerts.json'),
      APP_TOKEN: 'e2e-token',
      SLEEPER_USER: '',
      CONTACT_EMAIL: 'e2e@example.com',
    },
    stdio: 'ignore',
  })
  await waitForHealth()
})

after(() => {
  server?.kill('SIGTERM')
  rmSync(state, { recursive: true, force: true })
})

const auth = { headers: { authorization: 'Bearer e2e-token' } }

describe('the front door', () => {
  test('health answers without credentials, because a probe carries none', async () => {
    const { status, body } = await json('/api/health')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.state, state, 'must write to the state directory it was given')
  })

  test('data is refused without the token', async () => {
    assert.equal((await get('/api/cockpit')).status, 401)
    assert.equal((await get('/api/cockpit?token=wrong')).status, 401)
  })

  test('the shell is served so the unlock screen can load', async () => {
    // Guarding this too meant the page offering Face ID sat behind Face ID.
    assert.equal((await get('/cockpit')).status, 200)
  })

  test('the token opens it, by header or by query', async () => {
    assert.equal((await get('/api/cockpit', auth)).status, 200)
    assert.equal((await get('/api/cockpit?token=e2e-token')).status, 200)
  })

  test('signing in is possible without being signed in', async () => {
    const { status, body } = await json('/api/auth/passkey/state')
    assert.equal(status, 200)
    assert.equal(body.needsToken, true)
    assert.deepEqual(body.enrolled, [])
  })

  test('a passkey cannot be enrolled by whoever asks', async () => {
    assert.equal((await get('/api/auth/passkey/register-options')).status, 401)
    const ok = await get('/api/auth/passkey/register-options?token=e2e-token')
    assert.equal(ok.status, 200)
  })
})

describe('notifications', () => {
  test('the key is a real P-256 point, or no browser will accept it', async () => {
    const { body } = await json('/api/push/key', auth)
    const raw = Buffer.from(body.key, 'base64url')
    assert.equal(raw.length, 65)
    assert.equal(raw[0], 4, 'uncompressed point marker')
  })

  test('the budget is reported and is the number that was asked for', async () => {
    const { body } = await json('/api/push/key', auth)
    assert.equal(body.budget, 20)
    assert.equal(body.spentThisWeek, 0)
  })

  test('a dry run answers rather than throwing on a quiet week', async () => {
    const { status, body } = await json('/api/push/dryrun', auth)
    assert.equal(status, 200)
    assert.ok(Array.isArray(body.would))
    assert.ok(Array.isArray(body.held))
  })

  test('a test send reports honestly that nothing is subscribed', async () => {
    const { status, body } = await json('/api/push/test', { method: 'POST', ...auth })
    assert.equal(status, 200)
    assert.equal(body.web, 0)
  })

  test('a subscription must actually be one', async () => {
    const { status } = await json('/api/push/subscribe', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ nonsense: true }),
    })
    assert.equal(status, 400)
  })
})

describe('the routes that exist', () => {
  // Every one of these was written, compiled, and returned "not found" or an
  // undefined field at some point today.
  for (const path of ['/api/cockpit', '/api/cockpit/news', '/api/cockpit/trades']) {
    test(`${path} is reachable and not a 404`, async () => {
      const { status, body } = await json(path, auth)
      assert.equal(status, 200)
      assert.notEqual(body?.error, 'not found')
    })
  }

  test('trades answers per league, and says why when it cannot', async () => {
    const { body } = await json('/api/cockpit/trades', auth)
    assert.ok(Array.isArray(body))
    for (const lg of body) {
      assert.ok(lg.leagueId && lg.label)
      assert.ok(Array.isArray(lg.fits) || typeof lg.blocked === 'string',
        'a league must return fits or an explanation, never silence')
    }
  })
})
