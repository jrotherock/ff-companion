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
type Tab = 'now' | 'news' | 'plan' | 'settings'

interface Tile {
  id: string; label: string; platform: string; format: string; teams: number
  urgency: Urgency; why: string; action: string; freshMs: number | null
  draft: { at: string; inMs: number; slotSet: boolean; boardAgeMs: number | null } | null
  blocked: string | null; phase: string
}
type Group = 'needs' | 'opening' | 'rising' | 'knowing'
interface Chip { leagueId: string; label: string; note: string; tone: 'act' | 'watch' | 'hold' | 'free' }
interface Item {
  id: string; group: Group; headline: string; detail: string; at: number
  playerId: string | null; chips: Chip[]; weight: number; because?: string | null
}
interface WireItem {
  id: string; title: string; summary: string; at: number; source: string; link: string
  mentions: { id: string; name: string; leagues: string[] }[]
}
interface Check { k: string; ok: boolean; v: string }
interface RosterPlayer {
  id: string; name: string; pos: string | null; team: string | null; byeWeek: number | null
  injuryStatus: string | null; injuryBody: string | null; starter: boolean
}
interface Detail {
  id: string; label: string; platform: string; teams: number; rounds: number
  starters: Record<string, number>; flex: { name: string; count: number }[]; benchSize: number
  draftTime: string | null; mySlot: number | null; feed: string
  preDraft: boolean; msToDraft: number | null; checks: Check[]
  roster: { players: RosterPlayer[]; starters: string[] } | null
  connected: boolean; blocked: string | null
  drafts: { key: string; picks: number; at: number; mySlot: number | null }[]
}

interface Note {
  id: string; at: number; title: string; body: string
  deadline: string | null; leagues: string[]; rule: string; read: boolean
}
interface Ev {
  id: string; at: number; kind: string; name: string; pos: string; team: string
  from: string; to: string; body: string | null; worse: boolean
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

/*
 * Four destinations, not five. Byes and budgets are facts about one league and
 * belong on its screen; only trades are genuinely cross-league. Review is
 * opened a handful of times a season, so it sits under Settings rather than
 * holding a fifth of the bar.
 */
const TABS: { id: Tab; label: string }[] = [
  { id: 'now', label: 'Now' }, { id: 'news', label: 'News' },
  { id: 'plan', label: 'Trades' }, { id: 'settings', label: 'Set' },
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

function LeagueCard({ t, onOpen }: { t: Tile; onOpen: () => void }) {
  const drafting = t.draft != null && t.draft.inMs > 0
  return (
    <button className={`ck tap ${t.urgency}`} onClick={onOpen}>
      <div className="ckhead">
        <span className="cknm">{t.label}</span>
        <span className="ckfmt">{t.format}</span>
        <span className="cksp" />
        <span className="ckchev" aria-hidden="true">›</span>
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
    </button>
  )
}

function Now({ tiles, onOpen }: { tiles: Tile[]; onOpen: (id: string) => void }) {
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
      <div className="ckgrid">
        {tiles.map((t) => <LeagueCard key={t.id} t={t} onOpen={() => onOpen(t.id)} />)}
      </div>
    </>
  )
}

/* ----------------------------------------------------------------- league */

function League({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<Detail | null>(null)
  useEffect(() => {
    setD(null)
    fetch(`/api/cockpit/league/${id}`).then((r) => r.json()).then(setD).catch(() => setD(null))
  }, [id])

  if (!d) return <div className="ckempty">Reading the league…</div>

  const open = d.checks.filter((c) => !c.ok)
  const lineup = d.roster?.players.filter((p) => p.starter) ?? []
  const bench = d.roster?.players.filter((p) => !p.starter) ?? []
  const slots = [
    ...Object.entries(d.starters).flatMap(([pos, n]) => Array.from({ length: n }, () => pos)),
    ...d.flex.flatMap((f) => Array.from({ length: f.count }, () => f.name)),
  ]

  return (
    <>
      {/* Back lives in the context line rather than a row of its own. */}
      <div className="ckcrumb">
        <button onClick={onBack}>‹ Home</button>
        <span className="cksep">·</span>
        <span>{d.teams} teams · {d.rounds} rounds</span>
        <span className="cksp" />
        <span>{d.connected ? 'connected' : 'no feed'}</span>
      </div>
      <Head
        big={d.preDraft
          ? open.length ? `${open.length} to sort out` : 'Ready to draft'
          : d.roster && !lineup.length ? 'Lineup not set' : 'Nothing to decide'}
        sub={d.label + (d.msToDraft != null && d.msToDraft > 0 ? ` · drafts in ${inWords(d.msToDraft)}` : '')}
      />

      <div className="ckchecks">
        {d.checks.map((c) => (
          <div className={`ckchk ${c.ok ? 'ok' : 'no'}`} key={c.k}>
            <span className="ckck">{c.ok ? '✓' : '·'}</span>
            <span className="ckckk">{c.k}</span>
            <span className="ckckv">{c.v}</span>
          </div>
        ))}
      </div>

      <a className="ckbig-action" href={`/?league=${d.id}`}>
        {d.preDraft ? 'Open draft companion' : 'Open companion'}
        <span className="ckbaz">the board, the verdict and the clock</span>
      </a>

      <div className="cksect">Roster</div>
      {!d.connected && <div className="ckph"><div className="ckphk">No feed</div><p>{d.blocked}</p></div>}
      {d.connected && !d.roster?.players.length && (
        <div className="ckph">
          <div className="ckphk">Empty</div>
          <div className="ckpht">{slots.length} starting slots, {d.benchSize} bench</div>
          <p>Nothing rostered — this league drafts {d.draftTime ? new Date(d.draftTime).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }) : 'soon'}.</p>
          <p className="ckphn"><b>Slots:</b> {slots.join(' · ')}</p>
        </div>
      )}
      {d.connected && !!d.roster?.players.length && (
        <div className="ckroster">
          {[...lineup, ...bench].map((p) => (
            <div className={`ckslot ${p.starter ? '' : 'bench'}`} key={p.id}>
              <span className={`ckpos ${p.pos ?? ''}`}>{p.starter ? p.pos : 'BN'}</span>
              <span>
                <span className="cksn">{p.name}
                  {p.injuryStatus && <span className="ckinj" title={p.injuryBody ?? ''}>{p.injuryStatus === 'Questionable' ? 'Q' : p.injuryStatus}</span>}
                </span>
                <span className="cksd">{p.team} · bye {p.byeWeek ?? '—'}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {!!d.drafts.length && (
        <>
          <div className="cksect">Past drafts</div>
          <div className="ckgrid">
            {d.drafts.map((r) => (
              <a className="ck quiet" key={r.key} href={`/?review=${r.key}`}>
                <div className="ckhead"><span className="cknm sm">{new Date(r.at).toLocaleDateString()}</span></div>
                <div className="ckwhy">{r.picks} picks · slot {r.mySlot ?? '—'}</div>
              </a>
            ))}
          </div>
        </>
      )}
    </>
  )
}

/* ---------------------------------------------------------- notifications */

function Alerts({ data, onRead }: {
  data: { notes: Note[]; events: Ev[]; lastPollAt: number | null; lastPollOk: boolean; lastPollError: string | null }
  onRead: () => void
}) {
  const unread = data.notes.filter((n) => !n.read)
  return (
    <>
      <Head
        big={unread.length ? `${unread.length} to see` : data.notes.length ? 'All caught up' : 'Nothing has woken you'}
        sub={data.lastPollAt
          ? `Checked ${agoWords(new Date(data.lastPollAt).toISOString())}${data.lastPollOk ? '' : ' · last check failed'}`
          : 'First check has not run yet'}
      />
      {!data.lastPollOk && data.lastPollError && (
        <p className="cknote dim">The last check failed: {data.lastPollError}</p>
      )}
      {!!unread.length && (
        <button className="ckreadall" onClick={onRead}>Mark all read</button>
      )}
      <div className="ckgrid">
        {data.notes.map((n) => (
          <div className={`ck ${n.read ? 'blocked' : 'act'}`} key={n.id}>
            <div className="ckhead"><span className="cknm sm">{n.title}</span></div>
            <div className="ckwhy">{n.body}</div>
            <div className="ckfoot">
              <span className={`ckpill ${n.read ? 'blocked' : 'act'}`}>{n.rule}</span>
              <span className="cksp" />
              <span className="ckfresh">{agoWords(new Date(n.at).toISOString())}</span>
            </div>
          </div>
        ))}
        {!data.notes.length && (
          <div className="ckph">
            <div className="ckphk">Working as intended</div>
            <div className="ckpht">Nothing has met the bar</div>
            <p>A notification needs a fact that changed, a consequence on a roster you hold, and a
              deadline. Most weeks nothing qualifies — and a tool willing to stay quiet is the only
              kind worth trusting when it does speak.</p>
          </div>
        )}
      </div>
      <div className="cksect">Everything that changed</div>
      <div className="ckroster">
        {data.events.map((e) => (
          <div className="ckslot" key={e.id}>
            <span className={`ckpos ${e.pos}`}>{e.pos}</span>
            <span>
              <span className="cksn">{e.name} <span className="ckdim">{e.from} → {e.to}</span></span>
              <span className="cksd">{e.team}{e.body ? ` · ${e.body}` : ''} · {agoWords(new Date(e.at).toISOString())}</span>
            </span>
          </div>
        ))}
        {!data.events.length && <div className="ckempty">Nothing has changed since the first snapshot.</div>}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------- news */

const GROUPS: { id: Group; label: string; blurb: string }[] = [
  { id: 'needs', label: 'Needs you', blurb: 'Your player got worse' },
  { id: 'opening', label: 'An opening', blurb: "Someone else's starter is out and the replacement is free" },
  { id: 'rising', label: 'Rising', blurb: 'Promoted, or the market is moving on him' },
  { id: 'knowing', label: 'Worth knowing', blurb: 'Yours, but nothing to do' },
]

function Chips({ chips }: { chips: Chip[] }) {
  if (!chips.length) return null
  return (
    <div className="ckchips">
      {chips.map((c) => (
        <span key={c.leagueId} className={`ckchip ${c.tone}`}>{c.label} · {c.note}</span>
      ))}
    </div>
  )
}

/*
 * Form carries priority, not just grouping. A card is for something that needs
 * a decision; twenty-three cards saying "is being picked up" is a wall whatever
 * heading sits above it. The market is scannable data, so it gets rows.
 */
function RisingRow({ i }: { i: Item }) {
  const free = i.chips.filter((c) => c.tone === 'free').length
  const move = /\+([\d,]+) since/.exec(i.detail)?.[1] ?? null
  const meta = i.detail.replace(/ · \+[\d,]+ since the last check/, '')
  return (
    <div className="ckrise">
      <span>
        <span className="ckrn2">{i.headline.replace(/ is being picked up| moves to first on the depth chart/, '')}</span>
        {/* The number is the alarm; this is the reason for it. */}
        {i.because && <span className="ckwhy2">{i.because}</span>}
      </span>
      <span className="ckrm">{meta.split(' · ')[0]}</span>
      <span className="ckrd2">{move ? `+${move}` : '—'}</span>
      <span className={`ckrf ${free ? 'yes' : 'no'}`}>{free ? `free ×${free}` : 'taken'}</span>
    </div>
  )
}

function News({ data }: { data: { items: Item[]; watched: number; quiet: number; ignored: number } }) {
  const [all, setAll] = useState(false)
  const need = data.items.filter((i) => i.group === 'needs' || i.group === 'opening')
  const rising = data.items.filter((i) => i.group === 'rising')
  const knowing = data.items.filter((i) => i.group === 'knowing')
  const RISE_CAP = 6
  const shown = all ? rising : rising.slice(0, RISE_CAP)

  return (
    <>
      <Head
        big={need.length ? (need.length === 1 ? 'One needs a decision' : `${need.length} need a decision`) : 'Nothing needs a decision'}
        sub={`${data.watched} of your players watched · ${data.ignored.toLocaleString()} others ignored`}
      />

      {/* Decisions get cards. Nothing else does. */}
      {GROUPS.filter((g) => g.id === 'needs' || g.id === 'opening').map((g) => {
        const rows = data.items.filter((i) => i.group === g.id)
        if (!rows.length) return null
        return (
          <div key={g.id}>
            <div className="ckgroup"><span>{g.label}</span><em>{g.blurb}</em></div>
            <div className="ckgrid">
              {rows.map((i) => (
                <div className={`ck ${i.group}`} key={i.id}>
                  <div className="ckhead"><span className="cknm sm">{i.headline}</span></div>
                  <div className="ckwhy">{i.detail}</div>
                  <Chips chips={i.chips} />
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {!!rising.length && (
        <>
          <div className="ckgroup"><span>Rising</span><em>Fastest-moving first, not most-added</em></div>
          <div className="ckrisebox">
            <div className="ckrise head"><span>Player</span><span>Pos</span><span>24h</span><span>You</span></div>
            {shown.map((i) => <RisingRow key={i.id} i={i} />)}
          </div>
          {rising.length > RISE_CAP && (
            <button className="ckmore" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show ${rising.length - RISE_CAP} more`}
            </button>
          )}
        </>
      )}

      {!!(data as any).wire?.items?.length && (
        <>
          <div className="ckgroup">
            <span>Around the league</span>
            <em>{(data as any).wire.sources.join(', ')} · yours first</em>
          </div>
          <div className="ckwire">
            {((data as any).wire.items as WireItem[]).slice(0, 8).map((w) => (
              <a className={`ckw ${w.mentions.some((m) => m.leagues.length) ? 'mine' : ''}`}
                 key={w.id} href={w.link} target="_blank" rel="noreferrer noopener">
                <span className="ckwt">{w.title}</span>
                {!!w.mentions.length && (
                  <span className="ckwm">
                    {w.mentions.slice(0, 3).map((m) => m.name).join(' · ')}
                    {w.mentions.some((x) => x.leagues.length) ? ' — yours' : ''}
                  </span>
                )}
                <span className="ckws">{w.source} · {agoWords(new Date(w.at).toISOString())}</span>
              </a>
            ))}
          </div>
        </>
      )}

      {!!knowing.length && (
        <>
          <div className="ckgroup"><span>Worth knowing</span><em>Yours, but nothing to do</em></div>
          <div className="ckrisebox">
            {knowing.map((i) => (
              <div className="ckrise" key={i.id}>
                <span className="ckrn2">{i.headline}</span>
                <span className="ckrm">{i.detail.split(' · ')[0]}</span>
                <span className="ckrd2">—</span>
                <span className="ckrf no">{i.chips[0]?.label ?? ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="ckquiet">
        {data.quiet} of your players unchanged · {data.ignored.toLocaleString()} others not watched
      </div>
    </>
  )
}

function NewsTab({ news, alerts, onRead }: { news: any; alerts: any; onRead: () => void }) {
  const [on, setOn] = useState<'News' | 'Alerts'>('News')
  return (
    <>
      <Seg opts={['News', 'Alerts']} on={on} set={setOn} />
      {on === 'News' && (news
        ? <News data={news} />
        : <div className="ckempty">Comparing snapshots…</div>)}
      {on === 'Alerts' && (alerts
        ? <Alerts data={alerts} onRead={onRead} />
        : <div className="ckempty">Reading the log…</div>)}
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
  return (
    <>
      <Head big="Trades" sub="The only thing here that needs all four leagues at once" />
      <Placeholder title="Trade finder"
        needs="every manager's roster — the Yahoo API, and a drafted Sleeper league"
        why="Which of forty-two managers across four leagues holds the surplus that matches your hole. Evaluating an offer is solved elsewhere; finding one is not." />
      <p className="cknote dim">
        Bye weeks and FAAB moved to each league's own screen, where they belong — both are
        facts about one league, and only trades need all four at once.
      </p>
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

/*
 * Text size and theme, shared with the draft companion through the same
 * localStorage keys — one setting for one person, not two apps disagreeing
 * about how large the type should be.
 */
const SCALES = [0.9, 1, 1.1, 1.25, 1.4]

function useDisplay() {
  const [scale, setScale] = useState(() => Number(localStorage.getItem('ui-scale')) || 1)
  const [theme, setTheme] = useState(() => localStorage.getItem('ui-theme') || 'dark')
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(scale))
    localStorage.setItem('ui-scale', String(scale))
  }, [scale])
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('ui-theme', theme)
  }, [theme])
  return { scale, setScale, theme, setTheme }
}

function Display() {
  const { scale, setScale, theme, setTheme } = useDisplay()
  return (
    <div className="ckdisp">
      <div className="ckdrow">
        <span>
          <span className="ckrn">Text size</span>
          <span className="ckrd">Applies to the draft companion too</span>
        </span>
        <span className="cksizes">
          {SCALES.map((v) => (
            <button key={v} className={v === scale ? 'on' : ''} onClick={() => setScale(v)}>
              {Math.round(v * 100)}%
            </button>
          ))}
        </span>
      </div>
      <div className="ckdrow">
        <span>
          <span className="ckrn">Theme</span>
          <span className="ckrd">Dark is built for a draft room at 10pm</span>
        </span>
        <span className="cksizes">
          {['dark', 'light'].map((t) => (
            <button key={t} className={t === theme ? 'on' : ''} onClick={() => setTheme(t)}>{t}</button>
          ))}
        </span>
      </div>
    </div>
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
  const [on, setOn] = useState<'Rules' | 'Display' | 'Sources' | 'Review'>('Rules')
  const [rules, setRules] = useState(RULES)
  return (
    <>
      <Head big="Settings" sub="Every rule needs a fact, a deadline and a consequence" />
      <Seg opts={['Rules', 'Display', 'Sources', 'Review']} on={on} set={setOn} />
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
      {on === 'Display' && <Display />}
      {on === 'Review' && <Review />}
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
  // Read once at mount so the whole app is sized correctly from the first
  // paint, rather than only after Settings has been opened.
  useEffect(() => {
    const sc = Number(localStorage.getItem('ui-scale')) || 1
    document.documentElement.style.setProperty('--ui-scale', String(sc))
    document.documentElement.setAttribute('data-theme', localStorage.getItem('ui-theme') || 'dark')
  }, [])
  const [tab, setTab] = useState<Tab>('now')
  const [openLeague, setOpenLeague] = useState<string | null>(null)
  const [tiles, setTiles] = useState<Tile[] | null>(null)
  const [news, setNews] = useState<{ items: Item[]; scanned: number; baseline: number | null } | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [alerts, setAlerts] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [, tick] = useState(0)

  useEffect(() => {
    const load = () => {
      fetch('/api/cockpit').then((r) => r.json()).then((d) => { setTiles(d.tiles); setErr(null) })
        .catch(() => setErr('The companion is not answering on :4600'))
      fetch('/api/cockpit/news').then((r) => r.json()).then(setNews).catch(() => {})
      fetch('/api/cockpit/sources').then((r) => r.json()).then((d) => setSources(d.sources)).catch(() => {})
      fetch('/api/cockpit/notifications').then((r) => r.json()).then(setAlerts).catch(() => {})
    }
    load()
    const a = setInterval(load, 30000)
    const b = setInterval(() => tick((n) => n + 1), 1000)
    return () => { clearInterval(a); clearInterval(b) }
  }, [])

  const markRead = () =>
    fetch('/api/cockpit/notifications', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ readAll: true }),
    }).then(() => fetch('/api/cockpit/notifications')).then((r) => r.json()).then(setAlerts)

  const unread = alerts?.unread ?? 0
  const live = tiles?.find((t) => t.urgency === 'act' && t.draft && t.draft.inMs <= 0)

  return (
    <div className="ckapp">
      <nav className="cknav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''}
            onClick={() => { setTab(t.id); if (t.id !== 'now') setOpenLeague(null) }}
            aria-current={tab === t.id ? 'page' : undefined}>
            {t.label}
            {t.id === 'news' && unread > 0 && <span className="ckbadge">{unread}</span>}
          </button>
        ))}
      </nav>
      <main className="ckmain">
        {err && <div className="ckempty">{err}</div>}
        {!err && !tiles && <div className="ckempty">Reading four leagues…</div>}
        {!err && tiles && (
          <div className="ckwrap">
            {tab === 'now' && (openLeague
              ? <League id={openLeague} onBack={() => setOpenLeague(null)} />
              : <Now tiles={tiles} onOpen={setOpenLeague} />)}
            {tab === 'news' && <NewsTab news={news} alerts={alerts} onRead={markRead} />}
            {tab === 'plan' && <Plan tiles={tiles} />}
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
