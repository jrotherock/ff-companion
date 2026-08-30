/**
 * Four leagues on one surface.
 *
 * A separate entry from the draft companion on purpose: the companion is used
 * at 10pm beside a live draft, and nothing built here should be able to break
 * it. The two meet at the league card, which is the way into a draft — there is
 * no separate "drafts" destination, because a league is a league whether it is
 * drafting or playing.
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './cockpit.css'

type Urgency = 'act' | 'soon' | 'watch' | 'quiet' | 'blocked'
type Verdict = 'act' | 'watch' | 'hold' | 'ignore'
type Tab = 'now' | 'news' | 'plan' | 'review' | 'settings'

interface Tile {
  id: string; label: string; platform: string; format: string; teams: number
  urgency: Urgency; why: string; action: string; freshMs: number | null
  draft: { at: string; inMs: number; slotSet: boolean; boardAgeMs: number | null } | null
  blocked: string | null; phase: string
}
interface Impact { leagueId: string; label: string; verdict: Verdict; note: string }
interface Item {
  id: string; kind: string; headline: string; detail: string; at: number
  playerId: string | null; tier: 1 | 2; impacts: Impact[]
}
interface Source {
  id: string; label: string; platform: string; feed: string; mySlot: number | null
  teams: number; rounds: number; draftTime: string | null; boardAt: string | null
  connected: boolean; note: string
}

const HOUR = 3600000, DAY = 24 * HOUR

function inWords(ms: number): string {
  if (ms <= 0) return 'now'
  if (ms < HOUR) return `${Math.round(ms / 60000)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${Math.round((ms % HOUR) / 60000)}m`
  const h = Math.round(ms / HOUR)
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
function agoWords(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < HOUR) return `${Math.round(ms / 60000)}m ago`
  if (ms < DAY) return `${Math.round(ms / HOUR)}h ago`
  return `${Math.round(ms / DAY)}d ago`
}
function freshWords(ms: number | null): string {
  if (ms == null) return 'no feed'
  if (ms < 60000) return 'fresh now'
  if (ms < HOUR) return `fresh ${Math.round(ms / 60000)}m`
  return `fresh ${Math.round(ms / HOUR)}h`
}

/* ------------------------------------------------------------------ shell */

const TABS: { id: Tab; label: string }[] = [
  { id: 'now', label: 'Now' }, { id: 'news', label: 'News' }, { id: 'plan', label: 'Plan' },
  { id: 'review', label: 'Review' }, { id: 'settings', label: 'Set' },
]

function Seg<T extends string>({ opts, on, set }: { opts: T[]; on: T; set: (v: T) => void }) {
  return (
    <div className="ckseg" role="tablist">
      {opts.map((o) => (
        <button key={o} role="tab" aria-selected={o === on}
          className={o === on ? 'on' : ''} onClick={() => set(o)}>{o}</button>
      ))}
    </div>
  )
}

function Head({ big, sub }: { big: string; sub: string }) {
  return (
    <header className="ckhdr">
      <div className="ckbig">{big}</div>
      <div className="cksub">{sub}</div>
    </header>
  )
}

/* -------------------------------------------------------------------- now */

function LeagueCard({ t }: { t: Tile }) {
  const drafting = t.draft != null && t.draft.inMs > 0
  return (
    <div className={`ck ${t.urgency}`}>
      <div className="ckhead">
        <span className="cknm">{t.label}</span>
        <span className="ckfmt">{t.format}</span>
      </div>
      <div className="ckwhy">{t.why}</div>
      <div className="ckfoot">
        <span className={`ckpill ${t.urgency}`}>{t.action}</span>
        {drafting && <span className="ckclock">{inWords(t.draft!.inMs)}</span>}
        <span className="cksp" />
        <span className="ckfresh">{t.blocked ?? freshWords(t.freshMs)}</span>
      </div>
      {/*
        * The way into a draft is the league's own card. A separate "drafts"
        * destination would split one thing in two and sit empty for fifty-one
        * weeks of the year.
        */}
      <a className="ckopen" href={`/?league=${t.id}`}>
        {drafting ? 'Open draft companion' : 'Open companion'} <span aria-hidden="true">›</span>
      </a>
    </div>
  )
}

function Now({ tiles }: { tiles: Tile[] }) {
  const need = tiles.filter((t) => t.urgency === 'act' || t.urgency === 'soon')
  const next = tiles.map((t) => t.draft).filter((d): d is NonNullable<Tile['draft']> => !!d && d.inMs > 0)
    .sort((a, b) => a.inMs - b.inMs)[0]
  return (
    <>
      <Head
        big={!need.length ? 'Nothing needs you' : need.length === 1 ? 'One needs you' : `${need.length} need you`}
        sub={next
          ? `Next draft in ${inWords(next.inMs)} · ${new Date(next.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
          : 'No drafts scheduled'}
      />
      <div className="ckgrid">{tiles.map((t) => <LeagueCard key={t.id} t={t} />)}</div>
    </>
  )
}

/* ------------------------------------------------------------------- news */

function News({ items, scanned, baseline }: { items: Item[]; scanned: number; baseline: number | null }) {
  const acts = items.filter((i) => i.impacts.some((m) => m.verdict === 'act')).length
  return (
    <>
      <Head
        big={acts ? `${acts} need action` : `${items.length} worth reading`}
        sub={baseline
          ? `${scanned.toLocaleString()} players compared against ${new Date(baseline).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })}`
          : 'No baseline yet — run npm run data:players to start the diff'}
      />
      <div className="ckgrid">
        {items.map((i) => (
          <div className={`ck ${i.impacts.some((m) => m.verdict === 'act') ? 'act' : i.tier === 1 ? 'watch' : 'quiet'}`} key={i.id}>
            <div className="ckhead">
              <span className="cknm sm">{i.headline}</span>
              {i.tier === 2 && <span className="ckfmt">market</span>}
            </div>
            <div className="ckwhy">{i.detail}</div>
            <div className="ckchips">
              {i.impacts.map((m) => (
                <span key={m.leagueId} className={`ckchip ${m.verdict}`} title={m.note}>
                  {m.label.replace(/Harker |Fantasy | League/g, '').slice(0, 12)}
                  {m.verdict !== 'ignore' && ` · ${m.verdict}`}
                </span>
              ))}
            </div>
          </div>
        ))}
        {!items.length && <div className="ckempty">Nothing has changed since the last snapshot.</div>}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------- plan */

function Placeholder({ title, why, needs }: { title: string; why: string; needs: string }) {
  return (
    <div className="ckph">
      <div className="ckphk">Not built yet</div>
      <div className="ckpht">{title}</div>
      <p>{why}</p>
      <p className="ckphn"><b>Waiting on:</b> {needs}</p>
    </div>
  )
}

function Plan({ tiles }: { tiles: Tile[] }) {
  const [on, setOn] = useState<'Trades' | 'Budgets' | 'Byes'>('Trades')
  return (
    <>
      <Head big="Plan" sub="Deliberate work — nothing here has a deadline tonight" />
      <Seg opts={['Trades', 'Budgets', 'Byes']} on={on} set={setOn} />
      {on === 'Trades' && (
        <Placeholder title="Trade finder" needs="rosters for every manager, which means the Yahoo API and a drafted Sleeper league"
          why="Which of forty-two managers across four leagues holds the surplus that matches your hole. Evaluation is solved elsewhere; discovery is not." />
      )}
      {on === 'Budgets' && (
        <Placeholder title="FAAB across four budgets" needs="a season in progress — budgets do not exist until leagues draft"
          why="Each platform shows one budget in isolation, so the pattern across four is invisible from inside any of them." />
      )}
      {on === 'Byes' && (
        <Placeholder title="Bye-week planner" needs="drafted rosters; the bye weeks themselves are already loaded for every player"
          why="One week where all four leagues hurt at once is worth seeing in August, not discovering on a Sunday morning." />
      )}
    </>
  )
}

/* ----------------------------------------------------------------- review */

function Review() {
  const [on, setOn] = useState<'Season' | 'Drafts'>('Drafts')
  const [drafts, setDrafts] = useState<any[] | null>(null)
  useEffect(() => { fetch('/api/drafts').then((r) => r.json()).then(setDrafts).catch(() => setDrafts([])) }, [])
  return (
    <>
      <Head big="Review" sub="What your own decisions cost, not a grade" />
      <Seg opts={['Season', 'Drafts']} on={on} set={setOn} />
      {on === 'Season' && (
        <Placeholder title="Did my start/sit calls beat the bench?" needs="week one — there is nothing to review until games are played"
          why="The same idea as draft Tendencies, one phase later: the gap between what you did and what was available, with the sample size stated honestly." />
      )}
      {on === 'Drafts' && (
        <div className="ckgrid">
          {(drafts ?? []).map((d) => (
            <a className={`ck ${d.excluded ? 'blocked' : 'quiet'}`} key={d.key} href={`/?review=${d.key}`}>
              <div className="ckhead">
                <span className="cknm sm">{d.leagueLabel}</span>
                <span className="ckfmt">{d.teams}tm · {d.rounds}rd</span>
              </div>
              <div className="ckwhy">
                {d.picks} picks · slot {d.mySlot ?? '—'} · {new Date(d.startedAt).toLocaleDateString()}
              </div>
              <div className="ckfoot">
                <span className={`ckpill ${d.excluded ? 'blocked' : 'quiet'}`}>{d.excluded ? 'Excluded' : 'Reviewable'}</span>
                <span className="cksp" />
                <span className="ckfresh">{d.platform}</span>
              </div>
            </a>
          ))}
          {drafts && !drafts.length && <div className="ckempty">No drafts recorded yet.</div>}
        </div>
      )}
    </>
  )
}

/* --------------------------------------------------------------- settings */

const RULES = [
  { on: true, n: 'A starter is ruled out', d: 'Status becomes Out, Doubtful or IR — fires immediately' },
  { on: true, n: 'A starter turns questionable', d: 'Only inside three hours of lock, otherwise a note' },
  { on: true, n: 'Waivers close with money unspent', d: 'Six hours before, and only if a target fits a hole' },
  { on: true, n: 'Guillotine survival risk', d: 'Projected bottom three, Sunday morning only' },
  { on: false, n: 'A trade opportunity appears', d: 'No deadline attached, so it cannot notify by our own rule' },
  { on: false, n: 'A trending player you do not own', d: 'Popularity is not a fact about your team' },
]

function Settings({ sources }: { sources: Source[] }) {
  const [on, setOn] = useState<'Rules' | 'Sources'>('Rules')
  const [rules, setRules] = useState(RULES)
  return (
    <>
      <Head big="Settings" sub="Every rule needs a fact, a deadline and a consequence" />
      <Seg opts={['Rules', 'Sources']} on={on} set={setOn} />
      {on === 'Rules' && (
        <>
          <div className="ckrules">
            {rules.map((r, i) => (
              <button className="ckrule" key={r.n} onClick={() =>
                setRules((rs) => rs.map((x, j) => (i === j ? { ...x, on: !x.on } : x)))}>
                <span>
                  <span className="ckrn">{r.n}</span>
                  <span className="ckrd">{r.d}</span>
                </span>
                <span className={`cktog ${r.on ? 'on' : ''}`} aria-pressed={r.on} />
              </button>
            ))}
          </div>
          <p className="cknote">
            <b>Freshness rule.</b> A source that cannot prove it is current never fires — it degrades
            to a note you find later. That one is not a toggle; it is the guarantee the others rest on.
          </p>
          <p className="cknote dim">Toggles are not yet persisted — nothing sends notifications until delivery is built.</p>
        </>
      )}
      {on === 'Sources' && (
        <div className="ckgrid">
          {sources.map((s) => (
            <div className={`ck ${s.connected ? 'quiet' : 'blocked'}`} key={s.id}>
              <div className="ckhead">
                <span className="cknm sm">{s.label}</span>
                <span className="ckfmt">{s.platform} · {s.feed}</span>
              </div>
              <div className="ckwhy">{s.note}</div>
              <div className="ckfoot">
                <span className={`ckpill ${s.connected ? 'quiet' : 'blocked'}`}>
                  {s.connected ? 'Connected' : 'Pending'}
                </span>
                <span className="cksp" />
                <span className="ckfresh">board {agoWords(s.boardAt)} · slot {s.mySlot ?? '—'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* -------------------------------------------------------------------- app */

function Cockpit() {
  const [tab, setTab] = useState<Tab>('now')
  const [tiles, setTiles] = useState<Tile[] | null>(null)
  const [news, setNews] = useState<{ items: Item[]; scanned: number; baseline: number | null } | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [, tick] = useState(0)

  useEffect(() => {
    const load = () => {
      fetch('/api/cockpit').then((r) => r.json()).then((d) => { setTiles(d.tiles); setErr(null) })
        .catch(() => setErr('The companion is not answering on :4600'))
      fetch('/api/cockpit/news').then((r) => r.json()).then(setNews).catch(() => {})
      fetch('/api/cockpit/sources').then((r) => r.json()).then((d) => setSources(d.sources)).catch(() => {})
    }
    load()
    const a = setInterval(load, 30000)
    const b = setInterval(() => tick((n) => n + 1), 1000)
    return () => { clearInterval(a); clearInterval(b) }
  }, [])

  const live = tiles?.find((t) => t.urgency === 'act' && t.draft && t.draft.inMs <= 0)

  return (
    <div className="ckapp">
      <nav className="cknav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}>{t.label}</button>
        ))}
      </nav>
      <main className="ckmain">
        {err && <div className="ckempty">{err}</div>}
        {!err && !tiles && <div className="ckempty">Reading four leagues…</div>}
        {!err && tiles && (
          <div className="ckwrap">
            {tab === 'now' && <Now tiles={tiles} />}
            {tab === 'news' && (news
              ? <News items={news.items} scanned={news.scanned} baseline={news.baseline} />
              : <div className="ckempty">Comparing snapshots…</div>)}
            {tab === 'plan' && <Plan tiles={tiles} />}
            {tab === 'review' && <Review />}
            {tab === 'settings' && <Settings sources={sources} />}
          </div>
        )}
      </main>
      {/* A draft in progress follows you everywhere, so stepping out is safe. */}
      {live && (
        <a className="ckdraftbar" href={`/?league=${live.id}`}>
          <span className="ckdot" />
          <span className="ckdtx"><b>{live.label}</b>Draft in progress</span>
          <span className="ckdgo">Resume</span>
        </a>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Cockpit /></StrictMode>)
