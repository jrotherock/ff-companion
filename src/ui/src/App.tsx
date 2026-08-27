import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  explain as fetchExplain,
  search as doSearch,
  useCommands,
  useLeagues,
  useView,
  type Explanation,
  type SearchHit,
} from './api'
import { Alerts, Board, Complete, Drafted, Pos, Roster, SlotGate, Source, Tiers, Verdict, Why } from './components'
import { Hud, hudSupported, useHud } from './hud'
import { Review, Tendencies } from './review'

type Panel = 'board' | 'tiers' | 'drafted'

/** True on an external monitor, where nothing needs to be hidden behind tabs. */
function useWide() {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1180px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1180px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

/**
 * Reading this at arm's length at 10pm is the actual use case, so text size and
 * ground are the reader's call, not mine. Both persist.
 */
const SCALES = [1, 1.15, 1.3, 1.5]

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

  const bigger = () => setScale((s) => SCALES[Math.min(SCALES.indexOf(s) + 1, SCALES.length - 1)] ?? 1)
  const smaller = () => setScale((s) => SCALES[Math.max(SCALES.indexOf(s) - 1, 0)] ?? 1)
  return { scale, setScale, theme, setTheme, bigger, smaller }
}

const ago = (ts: number | null) => (ts == null ? '—' : `${Math.max(0, Math.round((Date.now() - ts) / 1000))}s`)

export default function App() {
  const leagues = useLeagues()
  const [leagueId, setLeagueId] = useState<string | null>(null)
  useEffect(() => {
    if (!leagueId && leagues.length) setLeagueId(leagues[0].id)
  }, [leagues, leagueId])

  const { view, connected, lastViewAt, refresh } = useView(leagueId)
  const [retrying, setRetrying] = useState(false)
  const cmd = useCommands(leagueId, refresh)
  const wide = useWide()
  const display = useDisplay()
  const hud = useHud()

  const [panel, setPanel] = useState<Panel>('board')
  const [draftedMode, setDraftedMode] = useState<'feed' | 'grid'>('feed')
  /** Wide shows three columns; the grid needs the whole width to be readable. */
  const [wideGrid, setWideGrid] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [compare, setCompare] = useState<string | null>(null)
  const [boardExplain, setBoardExplain] = useState<Explanation | null>(null)
  const [compareExplain, setCompareExplain] = useState<Explanation | null>(null)
  const [hideAvoids, setHideAvoids] = useState(false)
  const [posFilter, setPosFilter] = useState<Set<string>>(new Set())
  const [showSource, setShowSource] = useState(false)
  /** Post-draft screens: one draft, or the pattern across all of them. */
  const [reviewKey, setReviewKey] = useState<string | null>(null)
  const [showTendencies, setShowTendencies] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [hitIdx, setHitIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Ticks the clock so "seconds since update" stays honest without polling.
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  /*
   * Recording a pick by hand outranks any sensor, by design — that is how you
   * correct a feed that is wrong. So it must not be offered while a sensor is
   * healthy, or one stray click writes a pick you never made and the feed can
   * never take it back. The entry bar stays available regardless.
   */
  const manualLive = !(view?.health ?? []).some(
    (h) => h.ok && h.lastUpdate != null && Date.now() - h.lastUpdate < 20000,
  )

  const verdictIds = useMemo(
    () => new Set(view?.verdict.picks.map((p) => p.playerId) ?? []),
    [view],
  )

  const clearSelection = useCallback(() => {
    setSelected(null)
    setCompare(null)
    setBoardExplain(null)
    setCompareExplain(null)
  }, [])

  const select = useCallback(
    async (id: string, asCompare = false) => {
      if (!leagueId) return

      // Clicking the same card again always closes it. The old version left the
      // fetched panel behind, so it looked stuck.
      if (!asCompare && id === selected) {
        clearSelection()
        return
      }
      if (asCompare && id === compare) {
        setCompare(null)
        setCompareExplain(null)
        return
      }

      if (asCompare) {
        setCompare(id)
        setCompareExplain(verdictIds.has(id) ? null : await fetchExplain(leagueId, id))
        return
      }
      setSelected(id)
      setBoardExplain(verdictIds.has(id) ? null : await fetchExplain(leagueId, id))
    },
    [leagueId, verdictIds, selected, compare, clearSelection],
  )

  const draft = useCallback(
    async (playerId: string) => {
      if (!view) return
      await cmd.pick(view.clock.currentPick, playerId)
      clearSelection()
      setQuery('')
      setHits([])
    },
    [cmd, view, clearSelection],
  )

  // Manual entry is always live — never behind a mode.
  useEffect(() => {
    if (!leagueId) return
    let stale = false
    const t = setTimeout(async () => {
      const r = await doSearch(leagueId, query)
      if (!stale) {
        setHits(r)
        setHitIdx(0)
      }
    }, 90)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [query, leagueId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement === inputRef.current
      if (e.key === 'Escape') {
        clearSelection()
        if (typing) inputRef.current?.blur()
        return
      }
      if (e.key === '/' && !typing) {
        e.preventDefault()
        inputRef.current?.focus()
        return
      }
      if (typing) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setHitIdx((i) => Math.min(i + 1, hits.length - 1))
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setHitIdx((i) => Math.max(i - 1, 0))
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          const hit = hits[hitIdx]
          if (hit && !hit.taken) draft(hit.id)
        }
        return
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        display.bigger()
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        display.smaller()
      }
      // Single letters filter the board by position; same key clears it.
      const POS_KEYS: Record<string, string> = {
        q: 'QB', r: 'RB', w: 'WR', t: 'TE', k: 'K', d: 'DST', l: 'LB',
      }
      const posKey = POS_KEYS[e.key.toLowerCase()]
      if (posKey) {
        setPanel('board')
        setPosFilter((cur) => (cur.has(posKey) && cur.size === 1 ? new Set() : new Set([posKey])))
        return
      }
      if (e.key === '1') setPanel('board')
      if (e.key === '2') setPanel('tiers')
      if (e.key === '3') {
        setPanel('drafted')
        if (wide) setWideGrid((v) => !v)
      }
      if (e.key === 'Enter' && selected && manualLive) draft(selected)
      if (e.key === 'Backspace' && view?.picks.length) {
        e.preventDefault()
        cmd.undo(view.picks[view.picks.length - 1].overall)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hits, hitIdx, draft, selected, view, cmd, display, clearSelection, manualLive, wide])

  if (!leagues.length) {
    return <div className="empty">no leagues loaded — is the server running on :4600?</div>
  }
  if (!view) return <div className="empty">loading {leagueId}…</div>

  // A frozen page is indistinguishable from a quiet draft, which is the danger.
  // The server heartbeats every five seconds, so past ten the screen is stale.
  const frozen = !connected || (lastViewAt != null && Date.now() - lastViewAt > 10000)

  const disconnected = frozen ? (
    <div className="discon">
      <div className="h">
        {connected ? 'Not receiving updates' : 'Disconnected from the companion'}
      </div>
      <p>
        {connected
          ? `Last update ${Math.round((Date.now() - (lastViewAt ?? 0)) / 1000)}s ago. Everything on this screen may be out of date.`
          : 'Reconnecting automatically. Everything on this screen is frozen at the last update. If this persists, the companion has stopped — restart it and press retry.'}
      </p>
      <button
        className="btn primary"
        onClick={async () => {
          setRetrying(true)
          await refresh()
          setRetrying(false)
        }}
      >
        {retrying ? 'RETRYING…' : 'RETRY NOW'}
      </button>
    </div>
  ) : null

  const health = view.health.map((h) => {
    const secs = h.lastUpdate ? (Date.now() - h.lastUpdate) / 1000 : Infinity
    const cls = !h.lastUpdate ? 'down' : secs > 20 ? 'stale' : h.ok ? 'ok' : 'stale'
    return { ...h, cls, label: `${h.name.toUpperCase()} ${h.lastUpdate ? ago(h.lastUpdate) : 'no data'}` }
  })

  const status = (
    <div className="statusbar">
      <select
        className="leaguepick"
        value={leagueId ?? ''}
        onChange={(e) => {
          setLeagueId(e.target.value)
          setSelected(null)
          setBoardExplain(null)
        }}
      >
        {leagues.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
      <button
        className="chip"
        onClick={() => setShowSource((v) => !v)}
        title="Draft source — point at a mock or the real draft"
      >
        {view?.league.isMock ? 'MOCK' : 'SOURCE'}
      </button>
      <button
        className={`chip ${showTendencies ? 'on' : ''}`}
        onClick={() => {
          setShowTendencies((v) => !v)
          setReviewKey(null)
        }}
        title="What you do repeatedly, across every draft recorded"
      >
        TENDENCIES
      </button>
      {hudSupported() && (
        <button
          className={`chip ${hud.open ? 'on' : ''}`}
          onClick={hud.toggle}
          title="Float the decision over the draft room, always on top"
        >
          {hud.open ? 'HUD ON' : 'HUD'}
        </button>
      )}
      <span className="displayctl">
        <button className="chip" onClick={display.smaller} title="Smaller text (-)" aria-label="Smaller text">
          A−
        </button>
        <button className="chip" onClick={display.bigger} title="Bigger text (+)" aria-label="Bigger text">
          A+
        </button>
        <button
          className="chip"
          onClick={() => display.setTheme(display.theme === 'dark' ? 'light' : 'dark')}
          title="Switch between the dark and light ground"
        >
          {display.theme === 'dark' ? 'LIGHT' : 'DARK'}
        </button>
      </span>
      {health.map((h) => (
        <span className={`feed ${h.cls}`} key={h.name}>
          <i />
          {h.label}
        </span>
      ))}
      <span className={`feed ${connected ? 'ok' : 'down'}`}>
        <i />
        {connected ? 'LIVE' : 'RECONNECTING'}
      </span>
      <span className="spacer" />
      <span>
        RD {view.clock.round} ·{' '}
        <button
          className="slotedit"
          onClick={() => cmd.setSlot(null)}
          title="Change your draft slot — Yahoo randomises the order about 30 minutes before"
        >
          SLOT {view.league.mySlot ?? '—'}
        </button>
        {view.clock.nextPick != null && !view.clock.onMyClock
          ? ` · NEXT ${view.clock.nextPick} (${view.clock.picksUntilMyTurn} away)`
          : ''}
      </span>
      <span className={`clockpill ${view.clock.onMyClock ? '' : 'waiting'}`}>
        {view.clock.complete
          ? 'DRAFT COMPLETE'
          : `PICK ${view.clock.currentPick}${view.clock.onMyClock ? ' — YOU' : ''}`}
      </span>
    </div>
  )

  if (reviewKey) {
    return (
      <div className={`app ${frozen ? 'frozen' : ''}`}>
        {status}
        <div className="panel">
          <Review draftKey={reviewKey} onClose={() => setReviewKey(null)} />
        </div>
      </div>
    )
  }

  if (showTendencies) {
    return (
      <div className={`app ${frozen ? 'frozen' : ''}`}>
        {status}
        <div className="panel">
          <Tendencies
            onClose={() => setShowTendencies(false)}
            onOpenDraft={(k) => {
              setShowTendencies(false)
              setReviewKey(k)
            }}
          />
        </div>
      </div>
    )
  }

  if (showSource) {
    return (
      <div className={`app ${frozen ? 'frozen' : ''}`}>
        {status}
        {disconnected}
        <Source
          view={view}
          onSet={(id, isMock) => {
            cmd.setSource(id, isMock)
            setShowSource(false)
          }}
          onClose={() => setShowSource(false)}
        />
      </div>
    )
  }

  if (view.league.mySlot == null) {
    return (
      <div className={`app ${frozen ? 'frozen' : ''}`}>
        {status}
        {disconnected}
        <SlotGate view={view} onPick={(s) => cmd.setSlot(s)} />
      </div>
    )
  }

  const avoidsInBoard = view.board.filter((c) => c.flags.tags.includes('avoid')).length

  // Only offer positions this league actually rosters, in draft-order priority.
  const ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST', 'LB', 'DL', 'DB']
  const leaguePositions = [...new Set(view.board.map((c) => c.pos).filter(Boolean) as string[])].sort(
    (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b),
  )
  const togglePos = (p: string) =>
    setPosFilter((cur) => {
      const next = new Set(cur)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const panelBody =
    panel === 'board' ? (
      <>
        <div className="filters posfilters">
          <button
            className={`chip ${posFilter.size === 0 ? 'on' : ''}`}
            onClick={() => setPosFilter(new Set())}
          >
            ALL
          </button>
          {leaguePositions.map((p) => (
            <button
              key={p}
              className={`chip pos-chip ${p} ${posFilter.has(p) ? 'on' : ''}`}
              onClick={() => togglePos(p)}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="filters">
          <button className={`chip ${hideAvoids ? 'on' : ''}`} onClick={() => setHideAvoids((v) => !v)}>
            HIDE AVOIDS <span style={{ opacity: 0.55 }}>{hideAvoids ? 'ON' : 'OFF'}</span>
          </button>
          <button
            className={`chip ${view.league.adjustmentsEnabled ? 'on' : ''}`}
            onClick={() => cmd.setAdjustments(!view.league.adjustmentsEnabled)}
            title={view.league.adjustments.map((a) => a.note).join('\n\n')}
          >
            SCORING ADJ{' '}
            <span style={{ opacity: 0.55 }}>{view.league.adjustmentsEnabled ? 'ON' : 'OFF'}</span>
          </button>
          <span className="hint" style={{ marginLeft: 'auto' }}>
            {avoidsInBoard} AVOIDS SHOWN
          </span>
        </div>
        <Board
          cards={view.board}
          selected={selected}
          compare={compare}
          onSelect={select}
          hideAvoids={hideAvoids}
          positions={posFilter}
        />
      </>
    ) : panel === 'tiers' ? (
      <Tiers view={view} selected={selected} onSelect={select} />
    ) : (
      <>
        <div className="filters">
          <button className={`chip ${draftedMode === 'feed' ? 'on' : ''}`} onClick={() => setDraftedMode('feed')}>
            FEED
          </button>
          <button className={`chip ${draftedMode === 'grid' ? 'on' : ''}`} onClick={() => setDraftedMode('grid')}>
            GRID
          </button>
          <span className="hint" style={{ marginLeft: 'auto' }}>
            {view.picks.length} OF {view.league.teams * view.league.rounds} PICKS
          </span>
        </div>
        <Drafted view={view} mode={draftedMode} />
      </>
    )

  return (
    <div className={`app ${frozen ? 'frozen' : ''}`}>
      <Hud container={hud.container}>
        <div className="hudbar">
          <span className={`clockpill ${view.clock.onMyClock ? '' : 'waiting'}`}>
            {view.clock.complete
              ? 'DONE'
              : `PICK ${view.clock.currentPick}${view.clock.onMyClock ? ' — YOU' : ''}`}
          </span>
          <span className="mono hudmeta">
            RD {view.clock.round}
            {view.clock.nextPick != null && !view.clock.onMyClock
              ? ` · NEXT ${view.clock.nextPick} (${view.clock.picksUntilMyTurn} away)`
              : ''}
          </span>
          {frozen && <span className="hudstale">STALE</span>}
        </div>
        {view.clock.complete ? (
          <Complete view={view} />
        ) : (
          <Verdict
            view={view}
            selected={selected}
            compare={compare}
            onSelect={select}
            onDraft={draft}
            manualLive={manualLive}
          />
        )}
        <Alerts view={view} />
      </Hud>
      {status}
      {disconnected}
      {/*
        * A full board is the correct pre-draft state, but it looks like
        * activity. Say plainly that nothing has happened yet.
        */}
      {!view.clock.complete && view.picks.length === 0 && (
        <div className="notstarted">
          <span className="h">Not started</span>
          <span>
            No picks yet — everyone is still on the board.
            {view.league.draftTime
              ? ` ${view.league.platform === 'yahoo' ? 'Yahoo' : 'Sleeper'} has this draft at ${new Date(
                  view.league.draftTime,
                ).toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}.`
              : ''}
          </span>
        </div>
      )}
      {view.stale && (
        <div className="stalewarn">
          <div className="h">Local state does not match {view.league.platform}</div>
          <p>
            This board shows {view.stale.localPicks} picks but {view.league.platform} reports{' '}
            {view.stale.feedPicks}. Almost always left over from a rehearsal. Clear it before you
            trust anything on this screen.
          </p>
          <button className="btn primary" onClick={() => cmd.reset()}>
            CLEAR LOCAL PICKS
          </button>
        </div>
      )}
      {view.clock.complete ? (
        <Complete
          view={view}
          onReview={() =>
            fetch('/api/drafts')
              .then((r) => r.json())
              .then((all) => {
                const mine = all.find((d: any) => d.leagueId === view.league.id)
                if (mine) setReviewKey(mine.key)
              })
          }
        />
      ) : (
        <Verdict
          view={view}
          selected={selected}
          compare={compare}
          onSelect={select}
          onDraft={draft}
          manualLive={manualLive}
        />
      )}
      {(boardExplain || compareExplain) && (
        <div className={`whywrap ${boardExplain && compareExplain ? 'two' : ''}`}>
          {boardExplain && (
            <Why
              explain={boardExplain}
              onDraft={() => draft(boardExplain.playerId)}
              onClose={clearSelection}
              manualLive={manualLive}
            />
          )}
          {compareExplain && (
            <Why
              explain={compareExplain}
              onDraft={() => draft(compareExplain.playerId)}
              onClose={() => {
                setCompare(null)
                setCompareExplain(null)
              }}
              manualLive={manualLive}
            />
          )}
        </div>
      )}

      {wide ? (
        wideGrid ? (
          <div className="panel">
            <div className="filters">
              <button className="chip" onClick={() => setWideGrid(false)}>
                ← FEED
              </button>
              <span className="hint" style={{ marginLeft: 'auto' }}>
                {view.picks.length} OF {view.clock.totalPicks} PICKS
              </span>
            </div>
            <Drafted view={view} mode="grid" />
          </div>
        ) : (
          <div className="wide">
            <div>
              <div className="panelhead">Tiers</div>
              <Tiers view={view} selected={selected} onSelect={select} />
            </div>
            <div>
              <div className="panelhead">Available</div>
              {panelBody}
            </div>
            <div>
              <div className="panelhead">
                <span>Alerts &amp; drafted</span>
                <button className="chip" onClick={() => setWideGrid(true)}>
                  GRID
                </button>
              </div>
              <Alerts view={view} />
              <Drafted view={view} mode="feed" />
            </div>
          </div>
        )
      ) : (
        <>
          <div className="tabs">
            {(['board', 'tiers', 'drafted'] as Panel[]).map((p, i) => (
              <button key={p} className={`tab ${panel === p ? 'on' : ''}`} onClick={() => setPanel(p)}>
                {p}
                <span className="kbd">{i + 1}</span>
              </button>
            ))}
          </div>
          <div className="panel">{panelBody}</div>
          <Alerts view={view} />
        </>
      )}
      <Roster view={view} />

      <div className="entrywrap" hidden={view.clock.complete}>
        <div className="entry">
          <span className="mono" style={{ color: 'var(--dim)' }}>
            {view.clock.currentPick} ›
          </span>
          <input
            ref={inputRef}
            className="field"
            value={query}
            placeholder="type a name to record the pick…"
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <span className="hint">⏎ CONFIRM · ⌫ UNDO · / SEARCH</span>
        </div>
        {hits.map((h, i) => (
          <button
            key={h.id}
            className={`ta ${i === hitIdx ? 'on' : ''} ${h.taken ? 'taken' : ''}`}
            onClick={() => !h.taken && draft(h.id)}
            disabled={h.taken}
          >
            <Pos pos={h.pos} />
            <span className="nm">{h.name}</span>
            <span className="meta">
              {h.taken
                ? `TAKEN @${h.takenAt} · ${h.takenBy}`
                : `${h.team} · ${h.ranked ? 'RANKED' : 'UNRANKED'}`}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
