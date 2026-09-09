import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import webpush from 'web-push'
import type { Alert } from './alerts.js'
import { statePath } from './paths.js'
import { deliveryFor } from './priority.js'

/**
 * Getting an alert to a phone.
 *
 * Two channels, tiered by consequence rather than by preference. Web push
 * carries everything: no third party, nothing spoofable, and it opens the
 * league's own app when tapped. It is also, on iOS, quietly fragile — it stops
 * if the page leaves the Home Screen, and says nothing when it does. So the
 * alerts whose loss cannot be undone go out over a second channel as well.
 *
 * Belt and braces only where a miss is unrecoverable; everywhere else one
 * channel, because two notifications for one fact is how a channel gets muted.
 */

const STORE = statePath('push.json')
/** At or above this, send over every channel available. */
const BOTH_CHANNELS = 80

interface Store {
  vapid?: { publicKey: string; privateKey: string }
  subs: webpush.PushSubscription[]
  pushover?: { token: string; user: string }
}

const load = (): Store => {
  if (!existsSync(STORE)) return { subs: [] }
  try { return JSON.parse(readFileSync(STORE, 'utf8')) as Store } catch { return { subs: [] } }
}
const save = (s: Store) => writeFileSync(STORE, JSON.stringify(s, null, 1))

/** Generated once and kept, because rotating them silently unsubscribes every device. */
export function vapidKeys(): { publicKey: string; privateKey: string } {
  const s = load()
  if (!s.vapid) { s.vapid = webpush.generateVAPIDKeys(); save(s) }
  return s.vapid!
}

export function subscribe(sub: webpush.PushSubscription) {
  const s = load()
  if (!s.subs.some((x) => x.endpoint === sub.endpoint)) { s.subs.push(sub); save(s) }
  return s.subs.length
}

export const subscriberCount = () => load().subs.length
export const pushoverConfigured = () => !!load().pushover?.token

export function configurePushover(token: string, user: string) {
  const s = load(); s.pushover = { token, user }; save(s)
}

async function sendWebPush(a: Alert): Promise<{ ok: number; gone: number }> {
  const s = load()
  if (!s.subs.length) return { ok: 0, gone: 0 }
  const keys = vapidKeys()
  /*
   * The push services want a way to contact whoever runs this if it
   * misbehaves. It is not a secret, but it is personal, so it comes from the
   * environment rather than being baked into a public repository.
   */
  const contact = process.env.CONTACT_EMAIL ?? 'nobody@example.com'
  webpush.setVapidDetails(`mailto:${contact}`, keys.publicKey, keys.privateKey)
  const d = deliveryFor(a)
  let ok = 0
  const dead: string[] = []
  await Promise.all(s.subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        sub,
        JSON.stringify({
          title: a.headline, body: a.detail, url: a.link, tag: a.id,
          // The worker cannot see the consequence, so what to do about it
          // travels with the message.
          requireInteraction: d.requireInteraction,
          level: d.level,
        }),
        /*
         * Urgency is a header rather than payload: the push service reads it
         * without being able to read the message, and decides whether to wake a
         * sleeping phone now or hold it with the rest.
         */
        { urgency: d.urgency },
      )
      ok++
    } catch (e: any) {
      // 404 and 410 mean the browser dropped the subscription — the quiet iOS
      // failure this whole tier exists to survive. Prune rather than retry.
      if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(sub.endpoint)
    }
  }))
  if (dead.length) { s.subs = s.subs.filter((x) => !dead.includes(x.endpoint)); save(s) }
  return { ok, gone: dead.length }
}

async function sendPushover(a: Alert): Promise<boolean> {
  const cfg = load().pushover
  if (!cfg) return false
  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: cfg.token, user: cfg.user,
        title: a.headline, message: a.detail,
        ...(a.link ? { url: a.link, url_title: 'Open the league' } : {}),
        // Was pinned at 1 — "bypass quiet hours" — for everything that reached
        // this channel, which is the same flattening the web push had.
        priority: String(deliveryFor(a).pushoverPriority),
      }),
    })
    return res.ok
  } catch { return false }
}

export async function deliver(
  a: Alert,
): Promise<{ web: number; pushover: boolean; pruned: number; level: string }> {
  const web = await sendWebPush(a)
  const pushover = a.consequence >= BOTH_CHANNELS ? await sendPushover(a) : false
  return { web: web.ok, pushover, pruned: web.gone, level: deliveryFor(a).level }
}
