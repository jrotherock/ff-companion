/**
 * Yahoo's Fantasy API, once they grant it.
 *
 * The browser sensor exists because this did not. It reads one server-rendered
 * page, same-origin, from whatever tab happens to be open — an architecture
 * chosen under protest and defended well. This replaces the half of it that
 * was always a compromise, and keeps the half that was not: the server decides
 * cadence, a refusal stops the whole round, and nothing is read twice by two
 * readers on different schedules.
 *
 * Deliberately conservative about what it asks for. Yahoo publishes no rate
 * limit for Fantasy that I can point at, and the last time this app guessed at
 * one it earned an HTTP 999 across the whole fantasysports origin and took the
 * fantasy baseball league down with it. The batched calls here are designed so
 * a full day costs a few hundred requests rather than a few thousand.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { statePath } from './paths.js'

const STORE = statePath('yahoo-oauth.json')

const AUTH = 'https://api.login.yahoo.com/oauth2/request_auth'
const TOKEN = 'https://api.login.yahoo.com/oauth2/get_token'
const API = 'https://fantasysports.yahooapis.com/fantasy/v2'

const CLIENT_ID = () => process.env.YAHOO_CLIENT_ID ?? ''
const CLIENT_SECRET = () => process.env.YAHOO_CLIENT_SECRET ?? ''
/** Must match the app's registered redirect URI character for character. */
export const REDIRECT = () =>
  process.env.YAHOO_REDIRECT ?? 'https://roffco.up.railway.app/api/yahoo/callback'

/** Whether there is any point trying. */
export const configured = () => !!CLIENT_ID() && !!CLIENT_SECRET()

interface Tokens {
  access: string
  refresh: string
  /** When the access token stops working, in ms since the epoch. */
  expires: number
}

function load(): Tokens | null {
  if (!existsSync(STORE)) return null
  try { return JSON.parse(readFileSync(STORE, 'utf8')) as Tokens } catch { return null }
}

function save(t: Tokens): void {
  mkdirSync(dirname(STORE), { recursive: true })
  writeFileSync(STORE, JSON.stringify(t), { mode: 0o600 })
}

export const connected = () => load() != null

/**
 * Where to send the manager to say yes.
 *
 * `state` is not decoration: without it anyone who can make your browser issue
 * a GET can graft their own Yahoo account onto this install. It is checked on
 * the way back and then thrown away.
 */
export function authUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: CLIENT_ID(),
    redirect_uri: REDIRECT(),
    response_type: 'code',
    state,
  })
  return `${AUTH}?${q}`
}

/** Basic auth, which is how Yahoo wants the client credentials presented. */
const basic = () =>
  'Basic ' + Buffer.from(`${CLIENT_ID()}:${CLIENT_SECRET()}`).toString('base64')

async function grant(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: {
      authorization: basic(),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ redirect_uri: REDIRECT(), ...body }).toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    /*
     * The body is quoted deliberately. This is the one place where Yahoo says
     * plainly whether the grant exists — an unprovisioned app fails here with a
     * reason, and paraphrasing it would throw away the only diagnostic there
     * is. It carries no token: the request failed.
     */
    throw new Error(`token ${res.status}: ${text.slice(0, 300)}`)
  }
  const j = JSON.parse(text) as {
    access_token: string; refresh_token: string; expires_in: number
  }
  return {
    access: j.access_token,
    refresh: j.refresh_token,
    // A minute of margin, so a call started just before expiry does not race it.
    expires: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000,
  }
}

export async function exchange(code: string): Promise<void> {
  save(await grant({ grant_type: 'authorization_code', code }))
}

/*
 * One refresh at a time.
 *
 * Five leagues polling at once would otherwise each notice the same expiry and
 * each start their own refresh, and Yahoo may well invalidate the losers —
 * turning a routine renewal into being logged out.
 */
let refreshing: Promise<Tokens> | null = null

async function fresh(): Promise<Tokens> {
  const held = load()
  if (!held) throw new Error('not connected to Yahoo yet')
  if (Date.now() < held.expires) return held
  if (!refreshing) {
    refreshing = grant({ grant_type: 'refresh_token', refresh_token: held.refresh })
      .then((t) => {
        // Yahoo may or may not hand back a new refresh token; keep the old one
        // when it does not, or the next renewal has nothing to present.
        const merged = { ...t, refresh: t.refresh || held.refresh }
        save(merged)
        return merged
      })
      .finally(() => { refreshing = null })
  }
  return refreshing
}

/**
 * One call, with the manners the sensor learned the hard way.
 *
 * Throws rather than returning null on an unreadable answer: silence is
 * indistinguishable from nothing to say, and that is precisely how a broken
 * parser stayed invisible for an evening.
 */
export async function call<T = unknown>(path: string): Promise<T> {
  const t = await fresh()
  const url = `${API}/${path.replace(/^\/+/, '')}${path.includes('?') ? '&' : '?'}format=json`
  const res = await fetch(url, { headers: { authorization: `Bearer ${t.access}` } })
  if (res.status === 429 || res.status === 999) {
    const err = new Error(`Yahoo is rate limiting (HTTP ${res.status}) — backing off`) as any
    err.rateLimited = true
    throw err
  }
  if (!res.ok) throw new Error(`yahoo ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return await res.json() as T
}

/**
 * The smallest question worth asking, used to find out whether the grant has
 * landed. It names no league and reads nothing private beyond the fact that
 * this account plays fantasy football.
 */
export async function check(): Promise<{ ok: true; leagues: number } | { ok: false; why: string }> {
  try {
    const j = await call<any>('users;use_login=1/games;game_keys=nfl/leagues')
    const users = j?.fantasy_content?.users
    const count = JSON.stringify(users ?? {}).match(/league_key/g)?.length ?? 0
    return { ok: true, leagues: count }
  } catch (e) {
    return { ok: false, why: String(e instanceof Error ? e.message : e) }
  }
}
