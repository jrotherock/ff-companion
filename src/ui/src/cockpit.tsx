/**
 * Four leagues on one surface, sorted by whether they need you.
 *
 * Deliberately a separate entry from the draft companion rather than a panel
 * inside it: the companion is used at 10pm beside a live draft, and nothing
 * built this week should be able to break that.
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './cockpit.css'

type Urgency = 'act' | 'soon' | 'watch' | 'quiet' | 'blocked'

interface Tile {
  id: string
  label: string
  platform: string
  format: string
  teams: number
  urgency: Urgency
  why: string
  action: string
  freshMs: number | null
  draft: { at: string; inMs: number; slotSet: boolean; boardAgeMs: number | null } | null
  blocked: string | null
  phase: string
}

const HOUR = 3600000
const DAY = 24 * HOUR

function inWords(ms: number): string {
  if (ms <= 0) return 'now'
  if (ms < HOUR) return `${Math.round(ms / 60000)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${Math.round((ms % HOUR) / 60000)}m`
  // Round to the hour first, then split — rounding the remainder separately
  // produced "4d 24h", which is a real number of hours and a wrong way to say it.
  const hours = Math.round(ms / HOUR)
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function freshWords(ms: number | null): string {
  if (ms == null) return 'no feed'
  if (ms < 60000) return 'fresh now'
  if (ms < HOUR) return `fresh ${Math.round(ms / 60000)}m`
  return `fresh ${Math.round(ms / HOUR)}h`
}

/** The count is the answer; the cards are the detail. */
function headline(tiles: Tile[]): { big: string; sub: string } {
  const need = tiles.filter((t) => t.urgency === 'act' || t.urgency === 'soon')
  const next = tiles
    .map((t) => t.draft)
    .filter((d): d is NonNullable<Tile['draft']> => d != null && d.inMs > 0)
    .sort((a, b) => a.inMs - b.inMs)[0]
  const sub = next
    ? `Next draft in ${inWords(next.inMs)} · ${new Date(next.at).toLocaleString(undefined, {
        weekday: 'short', hour: 'numeric', minute: '2-digit',
      })}`
    : 'No drafts scheduled'
  if (!need.length) return { big: 'Nothing needs you', sub }
  return { big: need.length === 1 ? 'One needs you' : `${need.length} need you`, sub }
}

function Card({ t }: { t: Tile }) {
  return (
    <a className={`ck ${t.urgency}`} href={`/?league=${t.id}`}>
      <div className="ckhead">
        <span className="cknm">{t.label}</span>
        <span className="ckfmt">{t.format}</span>
      </div>
      <div className="ckwhy">{t.why}</div>
      <div className="ckfoot">
        <span className={`ckpill ${t.urgency}`}>{t.action}</span>
        {t.draft && t.draft.inMs > 0 && <span className="ckclock">{inWords(t.draft.inMs)}</span>}
        <span className="cksp" />
        <span className="ckfresh">{t.blocked ? t.blocked : freshWords(t.freshMs)}</span>
      </div>
    </a>
  )
}

function Cockpit() {
  const [tiles, setTiles] = useState<Tile[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [, tick] = useState(0)

  useEffect(() => {
    const load = () =>
      fetch('/api/cockpit')
        .then((r) => r.json())
        .then((d) => { setTiles(d.tiles); setErr(null) })
        .catch(() => setErr('The companion is not answering on :4600'))
    load()
    const a = setInterval(load, 30000)
    // A countdown that only moves when the data reloads reads as broken.
    const b = setInterval(() => tick((n) => n + 1), 1000)
    return () => { clearInterval(a); clearInterval(b) }
  }, [])

  if (err) return <div className="ckempty">{err}</div>
  if (!tiles) return <div className="ckempty">Reading four leagues…</div>

  const { big, sub } = headline(tiles)
  return (
    <div className="ckwrap">
      <header className="ckhdr">
        <div className="ckbig">{big}</div>
        <div className="cksub">{sub}</div>
      </header>
      <div className="ckgrid">
        {tiles.map((t) => <Card key={t.id} t={t} />)}
      </div>
      <footer className="ckftr">
        <a href="/">Draft companion</a>
        <span className="cksp" />
        <span>{tiles.length} leagues · refreshed every 30s</span>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><Cockpit /></StrictMode>,
)
