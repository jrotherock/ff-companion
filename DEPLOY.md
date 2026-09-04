# Putting the companion on Railway

The reason to host this is uptime, not features. This MacBook sleeps after a
minute idle — the log shows it dozing every fifteen minutes — so the poller
works while you are sitting at it and stops the moment you walk away, which is
exactly when an alert would matter.

Hosting does **not** improve Yahoo freshness. Three of the four leagues have no
API access, so their data still arrives through the Chrome extension when you
open a Yahoo page, wherever the server runs.

## In Railway

1. **New project → Deploy from GitHub repo** → this repository.
   The build is already described in `railway.json`; nixpacks will run
   `npm ci && npm run build` and start with `npm start`.

2. **Add a volume.** Service → Settings → Volumes → mount at **`/app/state`**.
   Without this every deploy wipes the Yahoo captures, the push subscriptions,
   the passkeys, and the snapshots the sensor diffs against to know what
   changed. None of it can be recovered by rebuilding.

3. **Variables** (Service → Variables):

   | Name | Value |
   |---|---|
   | `APP_TOKEN` | a long random string — `openssl rand -hex 24` |
   | `STATE_DIR` | `/app/state` |

   Leave `PORT` alone; Railway sets it. `SLEEPER_USER` is already the default.

4. **Generate a domain** (Settings → Networking → Generate Domain). Note it.

## On your phone, once

1. Open `https://<your-domain>/cockpit?token=<APP_TOKEN>`. That is the only
   time the token goes in a URL — it sets a cookie and drops out of the address.
2. Share → **Add to Home Screen**. iOS delivers web push only to an installed
   app; in Safari alone the notification button cannot work.
3. Open it from the Home Screen → Settings → **Add this device**. Face ID from
   then on.
4. Settings → **Turn on** notifications, then **Send a test** to prove the whole
   chain before it matters on a Sunday.

## In the extension

Click the extension icon → set **Companion** to `https://<your-domain>` and paste
the token. An extension cannot use Face ID — WebAuthn is not available to it —
so the token is how it gets through. That is the job the token keeps.

## Keep the token

In your password manager. It enrols a new device if you lose your phone, and it
is the break-glass route if every passkey is gone. There is no username and no
password: one user means a username identifies nobody, and a password is a
memorised secret that can be weak, reused or phished — every failure a passkey
removes.

## Checking it

`https://<your-domain>/api/health` needs no credentials and reports whether the
poller is running. Railway's healthcheck uses the same path.
