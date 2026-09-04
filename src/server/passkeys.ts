import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { statePath } from './paths.js'

/**
 * Face ID, instead of a token in a URL.
 *
 * A passkey is bound to this origin and to the device holding it, so it cannot
 * be phished, reused, or read out of a bookmark — which is precisely what was
 * wrong with the token as the everyday way in. The token stays as the way to
 * enrol a new device and as the break-glass route if every passkey is lost,
 * and as the only thing a browser extension can present, since extensions
 * cannot perform WebAuthn.
 *
 * No username and no password. This has exactly one user, so a username
 * identifies nothing, and a password would be a memorised secret that can be
 * weak, reused or phished — every failure a passkey exists to remove. The
 * fallback is the random token in a password manager, which is a password
 * without the ways a human makes one bad.
 */

const STORE = () => statePath('passkeys.json')
const USER_ID = new TextEncoder().encode('ff-companion-owner')

interface Cred {
  id: string
  publicKey: string
  counter: number
  label: string
  addedAt: number
}
interface Store { creds: Cred[]; sessions: { token: string; at: number }[] }

const SESSION_LIFE = 180 * 24 * 60 * 60 * 1000

const load = (): Store => {
  if (!existsSync(STORE())) return { creds: [], sessions: [] }
  try { return JSON.parse(readFileSync(STORE(), 'utf8')) as Store }
  catch { return { creds: [], sessions: [] } }
}
const save = (s: Store) => writeFileSync(STORE(), JSON.stringify(s, null, 1))

export const enrolled = () =>
  load().creds.map((c) => ({ label: c.label, addedAt: c.addedAt }))

/*
 * Challenges live in memory rather than on disk: they are valid for one
 * exchange, and a restart should invalidate them rather than resurrect them.
 */
const challenges = new Map<string, { challenge: string; at: number }>()
const CHALLENGE_LIFE = 5 * 60 * 1000
const putChallenge = (challenge: string): string => {
  const key = randomBytes(16).toString('hex')
  for (const [k, v] of challenges) if (Date.now() - v.at > CHALLENGE_LIFE) challenges.delete(k)
  challenges.set(key, { challenge, at: Date.now() })
  return key
}
const takeChallenge = (key: string): string | null => {
  const hit = challenges.get(key)
  if (!hit) return null
  challenges.delete(key)
  return Date.now() - hit.at > CHALLENGE_LIFE ? null : hit.challenge
}

export async function registerOptions(rpID: string, rpName: string) {
  const s = load()
  const options = await generateRegistrationOptions({
    rpName, rpID,
    userID: USER_ID,
    userName: 'owner',
    userDisplayName: 'Fantasy companion',
    attestationType: 'none',
    // One passkey per device, and never a second on the same one.
    excludeCredentials: s.creds.map((c) => ({ id: c.id })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',   // Face ID where the device offers it
    },
  })
  return { options, key: putChallenge(options.challenge) }
}

export async function registerVerify(
  body: any, key: string, rpID: string, origin: string, label: string,
) {
  const expected = takeChallenge(key)
  if (!expected) return { ok: false as const, error: 'that enrolment expired — try again' }
  const v = await verifyRegistrationResponse({
    response: body,
    expectedChallenge: expected,
    expectedOrigin: origin,
    expectedRPID: rpID,
  })
  if (!v.verified || !v.registrationInfo) return { ok: false as const, error: 'could not verify' }
  const s = load()
  const info = v.registrationInfo
  s.creds.push({
    id: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
    counter: info.credential.counter,
    label,
    addedAt: Date.now(),
  })
  save(s)
  return { ok: true as const, session: newSession() }
}

export async function loginOptions(rpID: string) {
  const s = load()
  if (!s.creds.length) return null
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: s.creds.map((c) => ({ id: c.id })),
    userVerification: 'preferred',
  })
  return { options, key: putChallenge(options.challenge) }
}

export async function loginVerify(body: any, key: string, rpID: string, origin: string) {
  const expected = takeChallenge(key)
  if (!expected) return { ok: false as const, error: 'that sign-in expired — try again' }
  const s = load()
  const cred = s.creds.find((c) => c.id === body.id)
  if (!cred) return { ok: false as const, error: 'unknown passkey' }
  const v = await verifyAuthenticationResponse({
    response: body,
    expectedChallenge: expected,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: cred.id,
      publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
      counter: cred.counter,
    },
  })
  if (!v.verified) return { ok: false as const, error: 'that did not verify' }
  // The counter guards against a cloned authenticator replaying an assertion.
  cred.counter = v.authenticationInfo.newCounter
  save(s)
  return { ok: true as const, session: newSession() }
}

function newSession(): string {
  const s = load()
  const token = randomBytes(32).toString('base64url')
  s.sessions = [
    ...s.sessions.filter((x) => Date.now() - x.at < SESSION_LIFE),
    { token, at: Date.now() },
  ]
  save(s)
  return token
}

/** Constant time, to match how APP_TOKEN is checked. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function validSession(token: string): boolean {
  if (!token) return false
  return load().sessions.some(
    (x) => sameSecret(x.token, token) && Date.now() - x.at < SESSION_LIFE,
  )
}

export function signOutAll() {
  const s = load(); s.sessions = []; save(s)
}
