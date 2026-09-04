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
interface Why { note: string | null; headline: string | null; link: string | null }
interface MatchupPlayer {
  id: string; name: string; pos: string | null; team: string | null
  projected: number | null; injuryStatus: string | null; injuryBody: string | null
  /** What they have actually scored. Null until the week is under way. */
  points: number | null
  why?: Why | null
}
type Group = 'needs' | 'opening' | 'rising' | 'knowing'
interface Chip { leagueId: string; label: string; note: string; tone: 'act' | 'watch' | 'hold' | 'free' }
interface Item {
  id: string; group: Group; headline: string; detail: string; at: number
  playerId: string | null; chips: Chip[]; weight: number; because?: string | null
  practice?: { status: string; severity: string; report: string } | null
  why?: { note: string | null; headline: string | null; link: string | null } | null
}
interface WireItem {
  id: string; title: string; summary: string; at: number; source: string; link: string
  mentions: { id: string; name: string; leagues: string[] }[]
}
interface Check { k: string; ok: boolean; v: string }
interface RosterPlayer {
  id: string; name: string; pos: string | null; team: string | null; byeWeek: number | null
  injuryStatus: string | null; injuryBody: string | null; starter: boolean
  practice: string | null
  severity: 'likely-out' | 'coin-flip' | 'likely-plays' | 'unknown' | null
  why?: Why | null
  projected?: number | null
}
interface Detail {
  id: string; label: string; platform: string; teams: number; rounds: number
  starters: Record<string, number>; flex: { name: string; count: number }[]; benchSize: number
  draftTime: string | null; mySlot: number | null; feed: string
  preDraft: boolean; msToDraft: number | null; checks: Check[]
  roster: {
    players: RosterPlayer[]; starters: string[]; capturedAt?: number
    advice?: {
      gain: number
      swaps: {
        in: { id: string; name: string; pos: string | null; projected: number | null }
        out: { id: string; name: string; pos: string | null; projected: number | null
               injuryStatus: string | null } | null
        slot: string; gain: number; reason: 'points' | 'out' | 'empty'
      }[]
    } | null
    projectedTotal?: number; week?: number; projectionSource?: string
    projectionCoverage?: { counted: number; of: number }
  } | null
  connected: boolean; blocked: string | null
  matchup: {
    week: number; opponent: string; started: boolean
    live: { mine: number; theirs: number }
    projected: { mine: number; theirs: number }
    projectionsAt: number
    mine: MatchupPlayer[]
    theirs: MatchupPlayer[]
  } | null
  drafts: { key: string; picks: number; at: number; mySlot: number | null
            teams: number; rounds: number; exact: boolean }[]
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

  const setRounds = (n: number) =>
    fetch(`/api/league/${d.id}/shape`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rounds: n }),
    }).then(() => fetch(`/api/cockpit/league/${d.id}`)).then((r) => r.json()).then(setD)

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
          // After a draft the checks describe the lineup, so the count means
          // something again rather than asserting there is nothing to decide.
          : !d.roster ? 'No roster yet'
          : !lineup.length ? 'Lineup not set'
          : open.length === 0 ? 'Nothing needs you'
          : open.length === 1 ? 'One thing to sort out'
          : `${open.length} things to sort out`}
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

      {/*
        * The round count decides whether kicker and defence get forced at the
        * end, so it has to be correctable without a restart — and it has to
        * show the value it holds. A row of fixed choices could not: this league
        * runs twenty-one rounds, the buttons offered thirteen to seventeen,
        * nothing highlighted, and the row read as though it said seventeen.
        * A stepper is right at any length and states the number outright.
        */}
      {d.preDraft && (
      <div className="ckshape">
        <span>
          <span className="ckrn">Draft length</span>
          <span className="ckrd">
            {slots.length} starting slots · {Math.max(0, d.rounds - slots.length)} bench
          </span>
        </span>
        <span className="ckstep">
          <button aria-label="One round fewer" disabled={d.rounds <= slots.length}
            onClick={() => setRounds(d.rounds - 1)}>−</button>
          <b>{d.rounds}</b>
          <button aria-label="One round more" onClick={() => setRounds(d.rounds + 1)}>+</button>
        </span>
      </div>
      )}

      {/* Before a draft this opens the board; afterwards there is no board to
          open, so it offers the review of what was taken instead. */}
      <a className="ckbig-action" href={d.preDraft ? `/?league=${d.id}` : `/?review=${d.drafts[0]?.key ?? ''}`}>
        {d.preDraft ? 'Open draft companion' : 'Review this draft'}
        <span className="ckbaz">the board, the verdict and the clock</span>
      </a>

      {d.roster?.advice && <Advice advice={d.roster.advice} />}

      {d.matchup && (
        <>
          <div className="cksect">
            Week {d.matchup.week} · {d.matchup.opponent}
            <span className="cksecthint">
              {/* Whose numbers these are, said outright. The label read
                  "Sleeper projections" on every league, including the three
                  that take their numbers from Yahoo. */}
              {d.matchup.started
                ? ' — live'
                : ` — ${d.roster?.projectionSource ?? 'projected'} projections${
                    d.roster?.projectionSource === 'Sleeper' ? ', half PPR' : ''}`}
            </span>
          </div>
          <div className="ckvs">
            <div className="ckvshead">
              <span>
                <span className={`ckvsn ${d.matchup.projected.mine >= d.matchup.projected.theirs ? 'up' : ''}`}>
                  {(d.matchup.started ? d.matchup.live.mine : d.matchup.projected.mine).toFixed(1)}
                </span>
                <span className="ckvslb">you</span>
              </span>
              <span className="ckvsm">
                {d.matchup.started ? 'live' : 'projected'}
                <em>
                  {d.matchup.projected.mine > d.matchup.projected.theirs ? '+' : ''}
                  {(d.matchup.projected.mine - d.matchup.projected.theirs).toFixed(1)}
                </em>
              </span>
              <span className="r">
                <span className={`ckvsn ${d.matchup.projected.theirs > d.matchup.projected.mine ? 'up' : ''}`}>
                  {(d.matchup.started ? d.matchup.live.theirs : d.matchup.projected.theirs).toFixed(1)}
                </span>
                <span className="ckvslb">{d.matchup.opponent}</span>
              </span>
            </div>
            {d.matchup.mine.map((p, i) => {
              const q = d.matchup!.theirs[i]
              /* Once the games start the row is about what happened, not what
                 was expected — so it compares on whichever the week is on. */
              const shown = (x: MatchupPlayer | undefined) =>
                d.matchup!.started ? (x?.points ?? null) : (x?.projected ?? null)
              const mineWins = (shown(p) ?? 0) >= (shown(q) ?? 0)
              const gap = Math.abs((shown(p) ?? 0) - (shown(q) ?? 0))
              return (
                <div className="ckvsrow" key={p?.id ?? i}>
                  <span className={`ckvsp ${mineWins ? 'win' : ''}`}>
                    <em>{shown(p) != null ? shown(p)!.toFixed(1) : '—'}</em>
                    <span>{p?.name ?? '—'}</span>
                    {p?.injuryStatus && (
                      <InjuryTag status={p.injuryStatus} body={p.injuryBody} why={p.why} />
                    )}
                  </span>
                  {/* Where the week is actually decided: the widest slot. */}
                  <span className={`ckvsgap ${gap >= 5 ? 'big' : ''}`}>{gap >= 5 ? (mineWins ? '\u25c0' : '\u25b6') : '\u00b7'}</span>
                  <span className={`ckvsp r ${!mineWins ? 'win' : ''}`}>
                    {q?.injuryStatus && (
                      <InjuryTag status={q.injuryStatus} body={q.injuryBody} why={q.why} />
                    )}
                    <span>{q?.name ?? '—'}</span>
                    <em>{shown(q) != null ? shown(q)!.toFixed(1) : '—'}</em>
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/*
        * Projected points without an opponent. Yahoo will not say who you are
        * playing, so there is no head-to-head — but the total is still the
        * number you are trying to make large, and it belongs on the screen.
        */}
      {!d.matchup && d.roster?.projectedTotal != null && (
        <>
          <div className="cksect">
            Week {d.roster.week} · projected
            <span className="cksecthint">
              {` — ${d.roster.projectionSource}'s own projections`}
              {d.roster.projectionCoverage &&
                d.roster.projectionCoverage.counted < d.roster.projectionCoverage.of &&
                `, ${d.roster.projectionCoverage.counted} of ${d.roster.projectionCoverage.of} players read`}
            </span>
          </div>
          <div className="ckvs">
            <div className="ckvshead">
              <span>
                <span className="ckvsn up">{d.roster.projectedTotal.toFixed(1)}</span>
                <span className="ckvslb">your starters</span>
              </span>
              <span className="ckvsm">
                bench
                <em>
                  {bench.reduce((a, p) => a + (p.projected ?? 0), 0).toFixed(1)}
                </em>
              </span>
              <span className="r">
                <span className="ckvsn">{lineup.filter((p) => p.projected != null).length}/{lineup.length}</span>
                <span className="ckvslb">starters read</span>
              </span>
            </div>
          </div>
        </>
      )}

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
                  {p.injuryStatus && (
                    <InjuryTag status={p.injuryStatus} body={p.injuryBody} practice={p.practice}
                               severity={p.severity} why={p.why} />
                  )}
                </span>
                <span className="ckproj">{p.projected != null ? p.projected.toFixed(1) : '—'}</span>
              <span className="cksd">
                  {p.team} · bye {p.byeWeek ?? '—'}
                  {/* The tag says questionable; this says what the week looked like. */}
                  {p.practice && <span className={`ckprac ${p.severity ?? ''}`}> · {p.practice.replace(/ i?n Practice$/i, '')}</span>}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {d.preDraft && !!d.drafts.length && (
        <>
          <div className="cksect">
            Past drafts
            {d.drafts.some((r) => !r.exact) && (
              <span className="cksecthint"> — mocks are matched by shape; Yahoo never says which league you launched from</span>
            )}
          </div>
          <div className="ckgrid">
            {d.drafts.map((r) => (
              <a className={`ck ${r.exact ? 'quiet' : 'knowing'}`} key={r.key} href={`/?review=${r.key}`}>
                <div className="ckhead">
                  <span className="cknm sm">{new Date(r.at).toLocaleDateString()}</span>
                  <span className="ckfmt">{r.teams}tm · {r.rounds}rd</span>
                </div>
                <div className="ckwhy">
                  {r.picks} picks · slot {r.mySlot ?? '—'}{r.exact ? '' : ' · mock'}
                </div>
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
  { id: 'knowing', label: 'Worth knowing', blurb: 'Yours, but nothing to do yet' },
  { id: 'rising', label: 'Rising', blurb: 'Promoted, or the market is moving on him' },
]

/**
 * A designation with what is known behind it. The native tooltip said
 * "Undisclosed", which is the body part and not the story — this carries
 * Sleeper's note where it exists, the headline that names the player, and a way
 * out to the news when neither does.
 */
function InjuryTag({ status, body, practice, severity, why }: {
  status: string; body?: string | null; practice?: string | null
  severity?: string | null; why?: Why | null
}) {
  return (
    <span className="ckinjwrap">
      <span className={`ckinj ${severity ?? 'coin-flip'}`}>
        {status === 'Questionable' ? 'Q' : status}
      </span>
      <span className="ckinjcard">
        <span className="ckics">{status}{body ? ` · ${body}` : ''}</span>
        {practice && <span className="ckicp">{practice.replace(/ i?n Practice$/i, '')}</span>}
        {why?.note && <span className="ckicn">{why.note}</span>}
        {why?.headline && <span className="ckich">{why.headline}</span>}
        {!why?.headline && !why?.note && <span className="ckicn dim">No note published</span>}
        {why?.link && (
          <a className="ckicl" href={why.link} target="_blank" rel="noreferrer noopener">
            {why.headline ? 'Read it ›' : 'Search the news ›'}
          </a>
        )}
      </span>
    </span>
  )
}

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
        <span className="ckrn2">
          {i.headline.replace(/ is being picked up| moves to first on the depth chart/, '')}
          {/* The practice week, where the report has one — the tag alone
              cannot separate a precaution from a problem. */}
          {i.practice && (
            <span className={`ckprac ${i.practice.severity}`} title={i.practice.status}>
              {' '}{i.practice.status.replace(/ i?n Practice$/i, '')
                .replace('Did Not Participate', 'DNP')
                .replace('Limited Participation', 'limited')
                .replace('Full Participation', 'full')}
            </span>
          )}
        </span>
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
        sub={`${data.watched} of your players watched · ${data.ignored.toLocaleString()} others ignored`
          + ((data as any).practice?.note ? ` · practice report ${(data as any).practice.note}` : '')}
      />

      {/*
        * Your own players first, market second. The group order lived in a
        * constant that nothing rendered — the real order was this sequence of
        * blocks, and "worth knowing" sat last, below the trending table and the
        * wire. Three edits to the constant changed nothing on screen.
        */}
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

      {!!knowing.length && (
        <>
          <div className="ckgroup"><span>Worth knowing</span><em>Yours, but nothing to do</em></div>
          <div className="ckrisebox">
            {knowing.map((i) => (
              <div className="ckrise" key={i.id}>
                <span>
                  <span className="ckrn2">{i.headline}</span>
                  {/* A tag with no explanation sends you to another tab, which
                      is the tab this was built to replace. */}
                  {(i.why?.note || i.why?.headline) && (
                    <span className="ckwhy2">{i.why.headline ?? i.why.note}</span>
                  )}
                </span>
                <span className="ckrm">{i.detail.split(' · ')[0]}</span>
                <span className="ckrd2">
                  {i.why?.link && (
                    <a href={i.why.link} target="_blank" rel="noreferrer noopener" className="ckmore">
                      {i.why.headline ? 'read' : 'search'}
                    </a>
                  )}
                </span>
                <span className="ckrf no">{i.chips[0]?.label ?? ''}</span>
              </div>
            ))}
          </div>
        </>
      )}


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

/**
 * The one thing a lineup screen owes you: whether to change anything. Silence
 * here has to mean "your lineup is right", so the settled case is stated
 * outright rather than left as an empty space you cannot tell from a bug.
 */
function Advice({ advice }: { advice: NonNullable<Detail['roster']>['advice'] }) {
  if (!advice) return null
  if (!advice.swaps.length) {
    return (
      <div className="ckadv set">
        <span className="ckadvi">✓</span>
        <span>
          <b>Your lineup is the best you can field.</b>
          <em>Every bench player projects below the starter he would replace.</em>
        </span>
      </div>
    )
  }
  return (
    <div className="ckadv">
      <div className="ckadvh">
        Start/sit · <b>+{advice.gain.toFixed(1)}</b> on the table
      </div>
      {advice.swaps.map((s) => (
        <div className="ckadvr" key={s.in.id}>
          <span className="ckadvin">
            <em>+{s.gain.toFixed(1)}</em>
            <b>{s.in.name}</b>
            <span className="ckadvs">into {s.slot}</span>
          </span>
          {s.out && (
            <span className="ckadvout">
              for <b>{s.out.name}</b>
              {s.reason === 'out'
                ? <span className="ckadvwhy out">ruled {(s.out.injuryStatus ?? 'out').toLowerCase()}</span>
                : <span className="ckadvwhy">{(s.out.projected ?? 0).toFixed(1)}</span>}
            </span>
          )}
        </div>
      ))}
    </div>
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


/**
 * The way in.
 *
 * A passkey is bound to this origin and to the phone holding it, so Face ID
 * replaces a token sitting in a bookmarked URL — which was the weakest part of
 * guarding this at all. The token survives for two jobs it is actually good at:
 * enrolling a new device, and getting the browser extension through, since an
 * extension cannot perform WebAuthn.
 *
 * There is no username and no password. One user means a username identifies
 * nobody, and a password is a memorised secret that can be weak, reused or
 * phished — every failure a passkey exists to remove.
 */
function Lock({ onIn }: { onIn: () => void }) {
  const [state, setState] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/auth/passkey/state').then((r) => r.json()).then(setState).catch(() => {})
  }, [])

  async function unlock() {
    setBusy(true); setErr('')
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser')
      const opts = await fetch('/api/auth/passkey/login-options').then((r) => r.json())
      const cred = await startAuthentication({ optionsJSON: opts })
      const out = await fetch('/api/auth/passkey/login-verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cred),
      }).then((r) => r.json())
      if (out.ok) onIn(); else setErr(out.error ?? 'that did not verify')
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally { setBusy(false) }
  }

  if (!state) return <div className="ckempty">…</div>
  return (
    <div className="cklock">
      <div className="cklockbox">
        <h1>Fantasy Companion</h1>
        {state.enrolled.length ? (
          <>
            <button className="cklockbtn" disabled={busy} onClick={unlock}>
              {busy ? 'Waiting for you…' : 'Unlock with Face ID'}
            </button>
            <p className="cklockp">
              {state.enrolled.length} device{state.enrolled.length === 1 ? '' : 's'} enrolled.
            </p>
          </>
        ) : (
          <p className="cklockp">
            No passkey yet. Open this once with your token on the end of the address,
            then add this device from Settings.
          </p>
        )}
        {err && <p className="cklockp err">{err}</p>}
      </div>
    </div>
  )
}

/** Adds this device, once you are already in. */
function AddPasskey() {
  const [state, setState] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState('')
  const refresh = () =>
    fetch('/api/auth/passkey/state').then((r) => r.json()).then(setState).catch(() => {})
  useEffect(() => { refresh() }, [])

  async function add() {
    setBusy(true); setSaid('')
    try {
      const { startRegistration } = await import('@simplewebauthn/browser')
      const opts = await fetch('/api/auth/passkey/register-options').then((r) => r.json())
      if (opts.error) { setSaid(opts.error); return }
      const credential = await startRegistration({ optionsJSON: opts })
      const label = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone'
        : /Mac/.test(navigator.userAgent) ? 'Mac' : 'this device'
      const out = await fetch('/api/auth/passkey/register-verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential, label }),
      }).then((r) => r.json())
      setSaid(out.ok ? 'This device can now unlock with Face ID.' : (out.error ?? 'failed'))
      refresh()
    } catch (e: any) { setSaid(e?.message ?? String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="ckpush">
      <div className="ckpushh">Getting in</div>
      <div className="ckpushrow">
        <span>
          <span className="ckrn">Passkeys</span>
          <span className="ckrd">
            {state?.enrolled?.length
              ? state.enrolled.map((e: any) => e.label).join(', ')
              : 'none yet — the token is the only way in'}
          </span>
        </span>
        <button className="ckbtn" disabled={busy} onClick={add}>
          {busy ? 'Waiting…' : 'Add this device'}
        </button>
      </div>
      {said && <p className="cknote">{said}</p>}
      <p className="cknote dim">
        Keep the token in your password manager. It enrols a new device if you lose this
        one, and it is the only thing the browser extension can present — extensions
        cannot use Face ID.
      </p>
    </div>
  )
}

/**
 * Turning notifications on, and proving they arrive.
 *
 * The chain has four links — a service worker, a permission grant, a
 * subscription the server keeps, and a push service that will drop it without
 * telling anyone — so each one reports its own state rather than being inferred
 * from the last. A test send is the only way to know the whole thing works
 * before it matters on a Sunday.
 */
function PushSetup() {
  const [state, setState] = useState<any>(null)
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'default')
  const [busy, setBusy] = useState('')
  const [said, setSaid] = useState('')

  const refresh = () => fetch('/api/push/key').then((r) => r.json()).then(setState).catch(() => {})
  useEffect(() => { refresh() }, [])

  const standalone = typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches ||
     (window.navigator as any).standalone === true)
  const iOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)

  async function enable() {
    setBusy('enable'); setSaid('')
    try {
      const reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const p = await Notification.requestPermission()
      setPerm(p)
      if (p !== 'granted') { setSaid('Permission refused — nothing can be delivered.'); return }
      const { key } = await fetch('/api/push/key').then((r) => r.json())
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'))
      const bytes = new Uint8Array([...raw].map((c) => c.charCodeAt(0)))
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: bytes,
      })
      await fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub),
      })
      setSaid('This device is subscribed.')
      refresh()
    } catch (e: any) {
      setSaid(`Could not subscribe: ${e?.message ?? e}`)
    } finally { setBusy('') }
  }

  async function test() {
    setBusy('test'); setSaid('')
    const r = await fetch('/api/push/test', { method: 'POST' }).then((x) => x.json())
    setSaid(r.web > 0
      ? `Sent to ${r.web} device${r.web === 1 ? '' : 's'}. If nothing arrived, the subscription is stale.`
      : 'Nothing to send to — no device is subscribed yet.')
    setBusy(''); refresh()
  }

  return (
    <div className="ckpush">
      <div className="ckpushh">Delivery</div>
      {iOS && !standalone && (
        <p className="cknote warn">
          <b>Add this to your Home Screen first.</b> iOS delivers web push only to an
          installed app — Share, then Add to Home Screen, then open it from there and
          turn notifications on. In Safari alone the button below cannot work.
        </p>
      )}
      <div className="ckpushrow">
        <span>
          <span className="ckrn">This device</span>
          <span className="ckrd">
            {perm === 'granted' ? 'permission granted' : perm === 'denied'
              ? 'permission refused — reset it in site settings' : 'not yet asked'}
            {state ? ` · ${state.subscribers} subscribed` : ''}
          </span>
        </span>
        <button className="ckbtn" disabled={busy === 'enable'} onClick={enable}>
          {busy === 'enable' ? 'Working…' : 'Turn on'}
        </button>
      </div>
      <div className="ckpushrow">
        <span>
          <span className="ckrn">Alert budget</span>
          <span className="ckrd">
            {state ? `${state.spentThisWeek} sent in the last seven days of ${state.budget}` : '—'}
            {' · a ruled-out starter is never rationed'}
          </span>
        </span>
        <button className="ckbtn" disabled={busy === 'test'} onClick={test}>
          {busy === 'test' ? 'Sending…' : 'Send a test'}
        </button>
      </div>
      {said && <p className="cknote">{said}</p>}
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
          <AddPasskey />
          <PushSetup />
        </>
      )}
      {on === 'Display' && <Display />}
      {on === 'Review' && <Review />}
      {on === 'Sources' && (
        <div className="ckgrid">
          <div className="ck quiet">
            <div className="ckhead"><span className="cknm sm">Injury practice report</span>
              <span className="ckfmt">nflverse</span></div>
            <div className="ckwhy">
              Whether a player practised, which is what separates a precaution from a problem —
              questionable after a full week means something very different to questionable
              having not practised at all.
            </div>
            <div className="ckfoot">
              <span className="ckpill blocked">Not published yet</span>
              <span className="cksp" />
              <span className="ckfresh">the {new Date().getFullYear()} report starts in week one</span>
            </div>
          </div>
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

  /*
   * Notice when the page you are running is older than the one on disk. Nothing
   * reloads by itself — doing that mid-draft would be worse than being stale —
   * but a banner beats hunting a bug that is really a cached tab.
   */
  const [stale, setStale] = useState(false)
  useEffect(() => {
    const mine = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))
      .map((el) => el.src)
      .find((v) => /assets\/cockpit-/.test(v))
    if (!mine) return
    /*
     * Reload rather than ask. The banner was the polite version and it failed
     * twice for the same reason — a tab opened before the banner existed has no
     * banner, so the one case that needed telling was the one case that could
     * not be told. The cockpit is read-only, so losing the page costs nothing;
     * a live draft is the exception and is left alone, because a page that
     * refreshes itself on the clock is worse than one that is out of date.
     */
    const check = () =>
      fetch('/api/build')
        .then((r) => r.json())
        .then((d) => {
          if (!d.entry || mine.endsWith(d.entry)) return
          const drafting = document.querySelector('.ckdraftbar') != null
          if (drafting) { setStale(true); return }
          location.reload()
        })
        .catch(() => {})
    check()
    const t = setInterval(check, 30000)
    return () => clearInterval(t)
  }, [])

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
      {stale && (
        <button className="ckstale" onClick={() => location.reload()}>
          A newer build is on disk — this tab is running an older one. Reload
        </button>
      )}
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

/**
 * Locked only where there is something to lock. Running on this Mac there is no
 * token set and nothing to defend against, so the gate never appears.
 */
function Root() {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    fetch('/api/auth/passkey/state')
      .then((r) => r.json())
      .then((s) => setOpen(!s.needsToken))
      .catch(() => setOpen(true))
  }, [])
  if (open === null) return <div className="ckempty">…</div>
  return open ? <Cockpit /> : <Lock onIn={() => setOpen(true)} />
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
