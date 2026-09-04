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
  /** Who his club faces this week, from the schedule. */
  opponent?: string | null
  /** What that defence concedes to his position — silent until games are played. */
  matchupNote?: string | null
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
  /** Everything the rules say needs you, unrationed by the alert budget. */
  needs: { rule: string; headline: string; detail: string; consequence: number
           deadline: number | null }[]
  /** Weeks ahead where byes bite, soonest first. */
  byes: { week: number; away: number; shortfalls: { slot: string; reason: string }[] }[] | null
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

/**
 * A league's own colour, everywhere it appears.
 *
 * Four leagues get named on half a dozen screens — tiles, the exposure list,
 * trade partners, news chips — and reading the label every time is work the
 * eye should not have to do. Derived from the id rather than configured, so a
 * new league gets one without being told, and stays the same colour for as
 * long as it keeps its id.
 */
const LEAGUE_HUES = [199, 152, 41, 320, 265, 12]
export function leagueHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return LEAGUE_HUES[h % LEAGUE_HUES.length]
}
/** The style object that carries it into CSS. */
export const leagueStyle = (id: string) =>
  ({ '--lg': `hsl(${leagueHue(id)} 70% 62%)` }) as React.CSSProperties

function LeagueCard({ t, onOpen, mark }: {
  t: Tile; onOpen: () => void
  mark?: { count: number; worst: number; first: string }
}) {
  const drafting = t.draft != null && t.draft.inMs > 0
  return (
    /*
     * A red dot, because everyone already knows what a red dot means. The card
     * says what the matter is and the pill says what to do about it; this only
     * has to catch the eye from across the page, and a tinted background asked
     * the reader to learn a new signal to do it.
     */
    <button className={`ck tap ${t.urgency}`} onClick={onOpen} style={leagueStyle(t.id)}>
      <div className="ckhead">
        {mark && <span className="ckdot-alert" aria-label="needs attention" />}
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

function Now({ tiles, onOpen, marks }: {
  tiles: Tile[]; onOpen: (id: string) => void
  marks?: Record<string, { count: number; worst: number; first: string }>
}) {
  /* Counted from what the tiles are actually marked with, so the heading
     cannot say "nothing needs you" over a card that says otherwise. */
  const need = tiles.filter(
    (t) => marks?.[t.id] || t.urgency === 'act' || t.urgency === 'soon',
  )
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
        {tiles.map((t) => (
          <LeagueCard key={t.id} t={t} mark={marks?.[t.id]} onOpen={() => onOpen(t.id)} />
        ))}
      </div>
    </>
  )
}

/* ----------------------------------------------------------------- league */

function League({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<Detail | null>(null)
  /* Which bye week is being inspected, if any. Clicking the same tile again
     clears it, so the roster returns to normal without hunting for a control. */
  const [byeWeek, setByeWeek] = useState<number | null>(null)
  useEffect(() => {
    setD(null)
    setByeWeek(null)
    fetch(`/api/cockpit/league/${id}`).then((r) => r.json()).then(setD).catch(() => setD(null))
  }, [id])

  if (!d) return <div className="ckempty">Reading the league…</div>

  const setRounds = (n: number) =>
    fetch(`/api/league/${d.id}/shape`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rounds: n }),
    }).then(() => fetch(`/api/cockpit/league/${d.id}`)).then((r) => r.json()).then(setD)

  /*
   * One count, from the thing the reader can actually see. The header was
   * counting failed checks while the callout listed rule findings, and the two
   * used different thresholds — so it said "1 thing to sort out" above an empty
   * space, which is worse than saying nothing.
   */
  const open = d.checks.filter((c) => !c.ok)
  const needs = d.needs ?? []
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
          : needs.length === 0 ? 'Nothing needs you'
          : needs.length === 1 ? 'One thing needs you'
          : `${needs.length} things need you`}
        sub={d.label + (d.msToDraft != null && d.msToDraft > 0 ? ` · drafts in ${inWords(d.msToDraft)}` : '')}
      />

      {/* The row stays — lineup, worst bye and when this was last seen are
          facts worth having at a glance. Only designations leave it, because
          the callout above now says that, and saying it twice in two voices
          split the reader between two accounts of one thing. */}
      <div className="ckchecks">
        {d.checks.filter((c) => !/designation/i.test(c.k)).map((c) => (
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

      {/*
        * Before a draft, opening the board is the whole reason to be here and
        * it gets the space. Afterwards the draft is history: a full-width
        * action for reading old news crowds out the thing that actually wants
        * doing this week, so it shrinks to a link in the header.
        */}
      {d.preDraft ? (
        <a className="ckbig-action" href={`/draft?league=${d.id}`}>
          Open draft companion
          <span className="ckbaz">the board, the verdict and the clock</span>
        </a>
      ) : d.drafts[0]?.key ? (
        <a className="cksmall-action" href={`/draft?review=${d.drafts[0].key}`}>
          Review this draft ›
        </a>
      ) : null}

      {/*
        * One box for everything that wants doing, or none at all.
        *
        * A designation, a ruled-out starter and points on the bench were three
        * separate treatments in three places — a tick row, a panel, and a tag
        * you had to notice. They are one question: is there anything to do
        * here? Asked once, at the top, in the only place a glance lands.
        */}
      {!!d.needs?.length && (
        <div className={`ckneeds ${d.needs.some((n) => n.consequence >= 80) ? 'urgent' : ''}`}>
          <div className="ckneedsh">
            {d.needs.length === 1 ? 'One thing needs you' : `${d.needs.length} things need you`}
          </div>
          {d.needs.map((n) => (
            <div className="ckneed" key={n.rule + n.headline}>
              <b>{n.headline}</b>
              <span>{n.detail}</span>
              {n.deadline && (
                <em>
                  by {new Date(n.deadline).toLocaleString(undefined,
                    { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                </em>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The full swap list sits below the callout when there is one, and at
          the top when the callout is empty but the lineup can still improve. */}
      {d.roster?.advice && d.roster.advice.swaps.length > 0 && (
        <Advice advice={d.roster.advice} />
      )}
      {d.byes && d.byes.length > 0 && (
        <>
          <div className="cksect">
            Byes ahead
            <span className="cksecthint">
              {byeWeek
                ? ` — showing who is away in week ${byeWeek}; tap again to clear`
                : ' — tap a week to see who is away'}
            </span>
          </div>
          <div className="ckbyes">
            {d.byes.slice(0, 6).map((b) => {
              /* Three names, then a count. A bye that empties six slots is one
                 fact — "this week is a write-off" — and listing all six reads
                 as six problems while making the tile unreadable. */
              const shown = b.shortfalls.slice(0, 3).map((s) => s.slot)
              const rest = b.shortfalls.length - shown.length
              const on = byeWeek === b.week
              /* Amber where the week is actually a problem — a slot that cannot
                 be filled, or enough men away that it will be. One player on a
                 bye is a fact; three, or a hole, is a week to plan for. */
              const rough = b.shortfalls.length > 0 || b.away > 2
              return (
                <button
                  className={`ckbye ${rough ? 'bad' : ''} ${on ? 'on' : ''}`}
                  key={b.week}
                  aria-pressed={on}
                  onClick={() => setByeWeek(on ? null : b.week)}
                >
                  <b>Week {b.week}</b>
                  <span>{b.away} away</span>
                  <em>
                    {b.shortfalls.length
                      ? `cannot fill ${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`
                      : 'still able to field a lineup'}
                  </em>
                </button>
              )
            })}
          </div>
        </>
      )}

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
              {d.roster?.advice && d.roster.advice.swaps.length === 0 && (
                <span className="ckoptimal"> · best lineup you can field</span>
              )}
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

      <div className="cksect">
        Roster
        {byeWeek != null && (
          <span className="cksecthint">
            {' — '}
            {[...lineup, ...bench].filter((p) => p.byeWeek === byeWeek).length} away in week {byeWeek}
          </span>
        )}
      </div>
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
            /* Dimmed rather than hidden when a bye week is being inspected:
               who is left matters as much as who is away. */
            <div
              className={`ckslot ${p.starter ? '' : 'bench'}` +
                (byeWeek == null ? '' : p.byeWeek === byeWeek ? ' away' : ' faded')}
              key={p.id}
            >
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
                  {p.team}{p.opponent ? ` vs ${p.opponent}` : ''} · bye {p.byeWeek ?? '—'}
                  {p.matchupNote && <span className="ckmatch">{p.matchupNote}</span>}
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
              <a className={`ck ${r.exact ? 'quiet' : 'knowing'}`} key={r.key} href={`/draft?review=${r.key}`}>
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

/**
 * One player's news, as a card.
 *
 * Which of your leagues he sits in is the first thing you need and was the
 * hardest thing to read — "Owns +2" in a column, when the leagues already have
 * names and colours everywhere else in the app.
 */
function NewsCard({ i, own }: { i: Item; own: boolean }) {
  const meta = (i.detail ?? '').split(' · ')
  return (
    <div className={`ck cknews ${own ? 'own' : ''}`}>
      <div className="ckhead">
        <span className="cknm sm">{i.headline}</span>
        <span className="cksp" />
        {i.practice && (
          <span className={`ckpill ${i.practice.severity === 'likely-out' ? 'act'
            : i.practice.severity === 'coin-flip' ? 'soon' : 'quiet'}`}>
            {i.practice.status}
          </span>
        )}
      </div>
      <div className="cknewsm">{meta[0]}{meta[1] ? ` · ${meta[1]}` : ''}</div>

      {/* The leagues, in their own colours — the thing you actually scan for. */}
      {!!i.chips.length && (
        <div className="cknewsl">
          {i.chips.map((c) => (
            <span key={c.leagueId} className={`cknewschip ${c.tone}`} style={leagueStyle(c.leagueId)}>
              {c.label}{c.note ? ` · ${c.note}` : ''}
            </span>
          ))}
        </div>
      )}


      {/* A headline without a link is text, not a dead anchor. href="#" shows
          a URL on hover and does nothing when clicked, which is the worst of
          both — it promises somewhere to go and then refuses. */}
      {i.why?.headline && (i.why.link
        ? <a className="cknewsw" href={i.why.link} target="_blank" rel="noreferrer">
            {i.why.headline} ›
          </a>
        : <span className="cknewsw plain">{i.why.headline}</span>
      )}
      {!i.why?.headline && i.because && <div className="cknewsw plain">{i.because}</div>}
    </div>
  )
}

/**
 * News, split by the only question that changes what you do about it: is he
 * mine?
 *
 * It was one table with columns for position, movement and ownership, which
 * asked the reader to decode "Owns +2" and re-derive the distinction for
 * themselves on every row. Your players and everybody else's are different
 * jobs — one is a lineup decision, the other is a shopping list — and they are
 * now two sections of cards in the app's own shape.
 */
function News({ data }: { data: { items: Item[]; watched: number; quiet: number; ignored: number } }) {
  const [all, setAll] = useState(false)
  /*
   * Ownership lives in the chip's note, not in whether there is a chip: a free
   * agent still carries one for every league he is free in. Splitting on the
   * chip's presence put all twenty-five under "yours", which is exactly the
   * thing this section exists to distinguish.
   */
  const owned = (i: Item) => i.chips.some((c) => /starting|yours|bench/i.test(c.note ?? ''))
  const mine = data.items.filter(owned)
  const others = data.items.filter((i) => !owned(i))
  const CAP = 6
  const shown = all ? others : others.slice(0, CAP)
  const roles = (data as any).roles

  return (
    <>
      <Head
        big={mine.length
          ? mine.length === 1
            ? 'One of your players is in the news'
            : `${mine.length} of your players are in the news`
          : 'None of your players are in the news'}
        sub={`${data.watched} of your players watched · ${data.ignored.toLocaleString()} others ignored`
          + ((data as any).practice?.note ? ` · practice report ${(data as any).practice.note}` : '')}
      />

      {!!mine.length && (
        <>
          <div className="cksect">
            Yours
            <span className="cksecthint"> — in a lineup or on a bench of yours</span>
          </div>
          <div className="ckgrid cknewsgrid">
            {mine.map((i) => <NewsCard key={i.id} i={i} own />)}
          </div>
        </>
      )}

      {!!shown.length && (
        <>
          <div className="cksect">
            Worth adding
            <span className="cksecthint"> — moving fastest, and free in at least one of your leagues</span>
          </div>
          <div className="ckgrid cknewsgrid">
            {shown.map((i) => <NewsCard key={i.id} i={i} own={false} />)}
          </div>
          {others.length > CAP && (
            <button className="cksmall-action" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${others.length}`} ›
            </button>
          )}
        </>
      )}

      {/* Roles change days before points do, so it leads the shopping list when
          there is anything to lead it with. Empty until games are played. */}
      {!!roles?.rows?.length && (
        <>
          <div className="cksect">
            Roles changing
            <span className="cksecthint"> — snap and target share, week over week</span>
          </div>
          <div className="ckgrid cknewsgrid">
            {roles.rows.slice(0, 6).map((r: any) => (
              <div className="ck cknews" key={r.name}>
                <div className="ckhead">
                  <span className="cknm sm">{r.name}</span>
                  <span className="cksp" />
                  <span className="ckpill quiet">{r.pos}</span>
                </div>
                <div className="cknewsm">
                  {r.team}
                  {r.snapTrend != null && ` · snaps ${r.snapTrend > 0 ? '+' : ''}${(r.snapTrend * 100).toFixed(0)}%`}
                  {r.targetTrend != null && ` · targets ${r.targetTrend > 0 ? '+' : ''}${(r.targetTrend * 100).toFixed(1)}%`}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/*
        * Around the league: the wire itself, unfiltered by whether it touches a
        * roster of yours. Dropped in the rewrite, which was a loss — the first
        * two sections answer "what should I do", and this one answers "what
        * happened", which is a different reason to open a news page.
        */}
      {!!(data as any).wire?.items?.length && (
        <>
          <div className="cksect">
            Around the league
            <span className="cksecthint">
              {' — '}{(data as any).wire.sources.join(', ')}, players of yours first
            </span>
          </div>
          <div className="ckwire">
            {((data as any).wire.items as WireItem[]).slice(0, 10).map((w) => (
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

      {!mine.length && !others.length && (
        <div className="ckempty">Nothing has moved since the last look.</div>
      )}
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

/**
 * How much of the season rides on one name.
 *
 * You own the same players in more than one league, so a single hamstring can
 * cost three teams at once. Nothing sold commercially can tell you this,
 * because nothing sold commercially sees all four leagues.
 */
function Exposure() {
  const [d, setD] = useState<any>(null)
  useEffect(() => {
    fetch('/api/cockpit/exposure').then((r) => r.json()).then(setD).catch(() => setD(null))
  }, [])
  if (!d?.shared?.length) return null
  const shown = d.shared.filter((e: any) => e.startingIn >= 1).slice(0, 6)
  if (!shown.length) return null
  return (
    <>
      <div className="cksect">
        Riding on one name
        <span className="cksecthint"> — the same player, more than one league</span>
      </div>
      {/* The ones where a designation costs more than one team, with the
          reason attached — a tag alone cannot tell you whether to worry. */}
      {d.atRisk?.map((e: any) => (
        <div className="ckriding" key={e.playerId}>
          <div className="ckridingh">
            <b>{e.name}</b>
            <InjuryTag status={e.injuryStatus} body={null} practice={e.practice}
                       severity={e.severity} why={e.why} />
            <span className="ckridingn">
              starts in {e.startingIn} · {e.projectedAcross.toFixed(1)} pts at stake
            </span>
          </div>
          {e.practice && (
            <div className="ckridingp">
              Practice: {e.practice}
              {e.severity === 'likely-out' && ' — most of the way to out'}
              {e.severity === 'likely-plays' && ' — a precaution'}
            </div>
          )}
          {e.why?.headline && (e.why.link
            ? <a className="ckridingw" href={e.why.link} target="_blank" rel="noreferrer">
                {e.why.headline} ›
              </a>
            : <span className="ckridingw plain">{e.why.headline}</span>
          )}
        </div>
      ))}
      <div className="ckexp">
        {shown.map((e: any) => (
          <div className="ckexprow" key={e.playerId}>
            <span className="ckexpn">
              {e.name}
              {e.injuryStatus && <InjuryTag status={e.injuryStatus} body={null} why={null} />}
            </span>
            <span className="ckexpl">
              {e.leagues.map((l: any) => (
                <span key={l.leagueId} className={l.starter ? 'on' : ''}
                      style={leagueStyle(l.leagueId)}>{l.label}</span>
              ))}
            </span>
            <span className="ckexpp">
              {e.startingIn > 0 ? `${e.projectedAcross.toFixed(1)} pts` : 'bench'}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * One league's trade partners.
 *
 * Not four trades — one need, and four managers who could fill it. Written as
 * four rows it repeated itself twice over: the same explanation under every
 * row, and the same two players of mine offered in every one of them, because
 * what I can spare does not change per partner. Said once at the top, the rows
 * carry only what actually differs — who, and what they would send back.
 *
 * The cards are the app's own: same shape as a league tile, same coloured left
 * edge, so the screen belongs to the same program as the one before it.
 */
function TradeLeague({ lg }: { lg: any }) {
  const fits = lg.fits ?? []
  const [open, setOpen] = useState(fits.length > 0)
  const need = fits[0]?.theyCanSpare.pos
  const spare = fits[0]?.youCanSpare

  return (
    <div className="cktl" style={leagueStyle(lg.leagueId)}>
      <button className="cktlh" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="cknm">{lg.label}</span>
        <span className="ckfmt">
          {lg.blocked ? 'unavailable' : fits.length ? `${fits.length} partners` : 'no fit'}
        </span>
        <span className="cksp" />
        <span className={`ckchev ${open ? 'open' : ''}`} aria-hidden="true">›</span>
      </button>

      {open && (
        <div className="cktlb">
          {lg.blocked && <p className="cktlnote">{lg.blocked}</p>}

          {!lg.blocked && !fits.length && (
            <p className="cktlnote">
              Nobody is deep where you are thin. That is a finding, not a gap — no trade
              here is obviously worth proposing.
            </p>
          )}

          {/* The half that is the same for every partner, said once. */}
          {!!fits.length && (
            <div className="cktlask">
              <span>
                You need a <b>{need}</b>, and can spare a <b>{spare.pos}</b>:
              </span>
              <span className="cktlspare">
                {spare.players.map((p: any) => (
                  <em key={p.name}>{p.name} <i>{p.projected?.toFixed(1) ?? '—'}</i></em>
                ))}
              </span>
            </div>
          )}

          {/* And the half that differs: who, and what comes back. */}
          <div className="ckgrid">
            {fits.map((f: any, i: number) => (
              <div className="ck cktcard" key={f.teamId}>
                <div className="ckhead">
                  <span className="cktseed">{i + 1}</span>
                  <span className="cknm sm">{f.manager}</span>
                  <span className="cksp" />
                  <span className="ckpill quiet">{f.theyCanSpare.pos}</span>
                </div>
                <div className="cktgets">
                  {f.theyCanSpare.players.map((p: any) => (
                    <span key={p.name}>
                      {p.name}<b>{p.projected?.toFixed(1) ?? '—'}</b>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Trades: the one question that needs every manager's roster rather than only
 * yours. Valuing an offer is solved everywhere; finding one is not, so this
 * finds and stops — it proposes a conversation, never a price.
 */
function Plan({ tiles }: { tiles: Tile[] }) {
  const [data, setData] = useState<any[] | null>(null)
  useEffect(() => {
    fetch('/api/cockpit/trades').then((r) => r.json()).then(setData).catch(() => setData([]))
  }, [])

  return (
    <>
      <Head big="Trades" sub="The only thing here that needs all four leagues at once" />
      {data === null && <div className="ckempty">Reading every roster…</div>}
      {data?.map((lg) => <TradeLeague key={lg.leagueId} lg={lg} />)}
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
            <a className={`ck ${d.excluded ? 'blocked' : 'quiet'}`} key={d.key} href={`/draft?review=${d.key}`}>
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

  const enrolled = state.count ?? state.enrolled.length
  return (
    <div className="cklock">
      <div className="cklockbox">
        <img className="cklockicon" src="/icon.svg" alt="" width="56" height="56" />
        <h1>Fantasy Companion</h1>
        <div className="cklocksub">Four leagues · one screen</div>

        {enrolled ? (
          <>
            <button className="cklockbtn" disabled={busy} onClick={unlock}>
              {busy ? 'Waiting for you…' : 'Unlock with Face ID'}
            </button>
            <div className="cklockfoot">
              {enrolled} device{enrolled === 1 ? '' : 's'} enrolled
            </div>
          </>
        ) : (
          /* The first visit on a new device. It is not an error, so it does not
             look like one — it is the one instruction that gets you in. */
          <div className="cklockcard">
            <div className="cklockcardh">First time on this device</div>
            <p>
              Open this address once with <code>?token=</code> and your token on the
              end, then add this device under <b>Set → Getting in</b>.
            </p>
            <p className="dim">The token is in your password manager.</p>
          </div>
        )}

        {err && (
          <div className="cklockcard err">
            <div className="cklockcardh">That did not work</div>
            <p>{err}</p>
          </div>
        )}
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
  const [marks, setMarks] = useState<Record<string, any>>({})
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
      fetch('/api/cockpit').then((r) => r.json())
        .then((d) => { setTiles(d.tiles); setMarks(d.marks ?? {}); setErr(null) })
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
              : <><Now tiles={tiles} onOpen={setOpenLeague} marks={marks} /><Exposure /></>)}
            {tab === 'news' && <NewsTab news={news} alerts={alerts} onRead={markRead} />}
            {tab === 'plan' && <Plan tiles={tiles} />}
            {tab === 'settings' && <Settings sources={sources} />}
          </div>
        )}
      </main>
      {/* A draft in progress follows you everywhere, so stepping out is safe. */}
      {live && (
        <a className="ckdraftbar" href={`/draft?league=${live.id}`}>
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
