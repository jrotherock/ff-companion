import { useEffect, useState } from 'react'
import { Pos } from './components'

/**
 * Two post-draft screens.
 *
 * Review looks at one draft and scores each of your picks against the board as
 * it stood at that moment. Tendencies looks across every draft and reports only
 * what repeats, because one draft cannot tell a habit from a one-off.
 */

interface PickReview {
  overall: number
  round: number
  taken: { id: string; name: string; pos: string | null; value: number }
  bestNeeded: { name: string; pos: string | null; value: number } | null
  cost: number
  verdict: 'best' | 'fine' | 'costly' | 'offboard'
  notes: string[]
  hindsight: { thenGap: number; nowGap: number; vindicated: boolean; note: string } | null
}

interface Counterfactual {
  totalValue: number
  actualValue: number
  gain: number
  roster: { pos: string; name: string; value: number }[]
  swaps: { round: number; tookInstead: string; wouldHaveTaken: string; gain: number }[]
}

interface DraftReview {
  picks: PickReview[]
  counterfactual: Counterfactual
  totalCost: number
  costEarly: number
  costLate: number
  structure: {
    unfilledStarters: { pos: string; count: number }[]
    byeConflicts: { week: number; players: string[] }[]
    positionCounts: Record<string, number>
    shortfalls: string[]
  }
  preference: { likesTaken: number; likeCost: number; avoidsTaken: { name: string; overall: number }[] }
  summary: string[]
}

export interface DraftRecord {
  key: string
  leagueLabel: string
  platform: string
  mock: boolean
  picks: number
  complete: boolean
  mySlot: number | null
  updatedAt: number
  teams: number
  rounds: number
}

export function Review({ draftKey, onClose }: { draftKey: string; onClose: () => void }) {
  const [data, setData] = useState<{ draft: DraftRecord; review: DraftReview } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null)
    setError(null)
    fetch(`/api/drafts/${draftKey}/review`)
      .then((r) => r.json())
      .then((j) => (j.error ? setError(j.error) : setData(j)))
      .catch(() => setError('could not load the review'))
  }, [draftKey])

  if (error) return <div className="settings"><p className="note">{error}</p><button className="btn" onClick={onClose}>CLOSE</button></div>
  if (!data) return <div className="empty">reading the draft…</div>

  const { review, draft } = data
  const scored = review.picks.filter((p) => p.verdict !== 'offboard').length

  return (
    <div className="reviewscreen">
      <div className="rhead">
        <span className="ctitle">Review</span>
        <span className="csub mono">
          {draft.leagueLabel} · {draft.mock ? 'mock' : 'real'} · slot {draft.mySlot} ·{' '}
          {new Date(draft.updatedAt).toLocaleDateString()}
        </span>
        <button className="chip" onClick={onClose}>CLOSE</button>
      </div>

      <div className="rsummary">
        {review.summary.map((s, i) => (
          <p key={i}>{s}</p>
        ))}
      </div>

      <div className="rstats">
        <span className="cstat"><span className="k">COST</span><b>{review.totalCost}</b></span>
        <span className="cstat"><span className="k">EARLY</span><b>{review.costEarly}</b></span>
        <span className="cstat"><span className="k">LATE</span><b>{review.costLate}</b></span>
        <span className="cstat"><span className="k">SCORED</span><b>{scored}</b></span>
      </div>

      <div className="clabel" style={{ padding: '0 0.75rem' }}>Every pick, against the board at the time</div>
      {review.picks.map((p) => (
        <div className={`rpick ${p.verdict}`} key={p.overall}>
          <span className="mono rrd">R{p.round}</span>
          <Pos pos={p.taken.pos} />
          <span className="nm">{p.taken.name}</span>
          <span className={`rverdict ${p.verdict}`}>
            {p.verdict === 'offboard' ? 'not ranked' : p.verdict}
            {p.cost > 0.05 ? ` −${p.cost.toFixed(1)}` : ''}
          </span>
          {p.notes.length > 0 && <span className="rnote">{p.notes[0]}</span>}
          {p.hindsight && (
            <span className={`rnote hind ${p.hindsight.vindicated ? 'good' : ''}`}>
              {p.hindsight.vindicated ? '↩ ' : '· '}
              {p.hindsight.note}
            </span>
          )}
        </div>
      ))}

      {review.counterfactual && review.counterfactual.swaps.length > 0 && (
        <>
          <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.375rem' }}>
            The team you would have had · taking the best fit every time
          </div>
          <div className="cfteam">
            <div className="cfcol">
              <div className="cfcolhead">
                Yours <b>{review.counterfactual.actualValue}</b>
              </div>
              {review.picks
                .filter((p) => p.verdict !== 'offboard')
                .map((p) => (
                  <div className="cfline" key={p.overall}>
                    <Pos pos={p.taken.pos} />
                    <span className="nm">{p.taken.name}</span>
                  </div>
                ))}
            </div>
            <div className="cfcol alt">
              <div className="cfcolhead">
                Board's <b>{review.counterfactual.totalValue}</b>
              </div>
              {review.counterfactual.roster.map((r, i) => (
                <div className="cfline" key={i}>
                  <Pos pos={r.pos} />
                  <span className="nm">{r.name}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="clabel" style={{ padding: '0.625rem 0.75rem 0.375rem' }}>
            The swaps that made the difference
          </div>
          {review.counterfactual.swaps.slice(0, 5).map((sw, i) => (
            <div className="swap" key={i}>
              <span className="mono rrd">R{sw.round}</span>
              <span className="swapfrom">{sw.tookInstead}</span>
              <span className="swaparrow">→</span>
              <span className="swapto">{sw.wouldHaveTaken}</span>
              <span className="swapgain">+{sw.gain}</span>
            </div>
          ))}
        </>
      )}

      {(review.structure.shortfalls.length > 0 || review.structure.byeConflicts.length > 0) && (
        <>
          <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.25rem' }}>Structure</div>
          {review.structure.shortfalls.length > 0 && (
            <div className="alert warn" style={{ margin: '0 0.75rem 0.375rem' }}>
              <div className="h">Short at</div>
              {review.structure.shortfalls.join(', ')}
            </div>
          )}
          {review.structure.byeConflicts.map((c) => (
            <div className="alert note" style={{ margin: '0 0.75rem 0.375rem' }} key={c.week}>
              <div className="h">Week {c.week} bye · {c.players.length} players</div>
              {c.players.join(', ')}
            </div>
          ))}
        </>
      )}

      <p className="rcaveat">
        Scored against your own board, not against what actually happened. If the board was wrong
        about a player this will confidently say you were wrong to disagree with it — it measures
        consistency with your strategy, which is the part you control.
      </p>
    </div>
  )
}

interface PlaybookItem {
  id: string
  action: string
  when: string
  because: string
  check: string
  worth: number
  strength: string
}

interface Segment {
  id: string
  label: string
  kind: 'all' | 'platform' | 'league'
  drafts: number
  report: TendencyReport
}

interface Segmented {
  segments: Segment[]
  universal: { id: string; action: string; seenIn: string[] }[]
  sources: { key: string; label: string; platform: string; mock: boolean; when: number }[]
  /** Everything on record, excluded ones included, so they can be restored. */
  allDrafts: {
    key: string
    leagueLabel: string
    platform: string
    updatedAt: number
    excluded?: boolean
    excludedReason?: string
  }[]
}

interface TendencyReport {
  playbook: PlaybookItem[]
  headline: string
  drafts: number
  picks: number
  avgCost: number
  tendencies: {
    id: string; headline: string; detail: string; strength: string; drafts: number
    tryNext: string | null
  }[]
  costByRound: {
    round: number; avgCost: number; worst: number; picks: number; points: number[]
    worstPick: { name: string; instead: string; cost: number; vindicated: boolean } | null
  }[]
  positionRounds: {
    pos: string; rounds: number[]; median: number
    boardMedian: number | null; drift: number | null; verdict: string
  }[]
  counterfactual: { label: string; actual: number; ideal: number; gain: number }[]
  openerCost: { shape: string; drafts: number; avgCost: number }[]
  positionByPhase: { phase: string; counts: Record<string, number> }[]
  caveat: string
  sources: { key: string; label: string; platform: string; mock: boolean; when: number }[]
}

export function Tendencies({
  onClose,
  onOpenDraft,
}: {
  onClose: () => void
  onOpenDraft: (key: string) => void
}) {
  const [all, setAll] = useState<Segmented | null>(null)
  const [segId, setSegId] = useState('all')
  const [showDetail, setShowDetail] = useState(false)
  useEffect(() => {
    fetch('/api/tendencies')
      .then((r) => r.json())
      .then(setAll)
      .catch(() => setAll(null))
  }, [])

  if (!all) return <div className="empty">reading your drafts…</div>
  const segment = all.segments.find((s) => s.id === segId) ?? all.segments[0]
  const data = segment ? { ...segment.report, sources: all.sources } : null

  if (!data) return <div className="empty">reading your drafts…</div>
  if (!data.drafts) {
    return (
      <div className="settings">
        <div className="panelhead">Tendencies</div>
        <p className="note">
          Nothing to compare yet. Finish a draft or a mock with your slot set and it will be
          recorded automatically — patterns need a few before they mean anything.
        </p>
        <button className="btn" onClick={onClose}>CLOSE</button>
      </div>
    )
  }

  // Scale to the worst single pick, not the worst average, or outliers vanish.
  const maxCost = Math.max(...data.costByRound.flatMap((r) => r.points), 0.5)

  return (
    <div className="reviewscreen">
      <div className="rhead">
        <span className="ctitle">Tendencies</span>
        <span className="csub mono">
          {data.drafts} drafts · {data.picks} picks · {data.avgCost} avg cost per draft
        </span>
        <button className="chip" onClick={onClose}>CLOSE</button>
      </div>

      {all.segments.length > 1 && (
        <div className="filters segbar">
          {all.segments.map((s) => (
            <button
              key={s.id}
              className={`chip ${s.id === segId ? 'on' : ''}`}
              onClick={() => setSegId(s.id)}
              title={`${s.drafts} draft${s.drafts === 1 ? '' : 's'}`}
            >
              {s.label} <span style={{ opacity: 0.55 }}>{s.drafts}</span>
            </button>
          ))}
        </div>
      )}

      <p className="headline">{data.headline}</p>

      {segId === 'all' && all.universal.length > 0 && (
        <div className="universal">
          <span className="h">Holds in more than one league</span>
          <ul>
            {all.universal.map((u) => (
              <li key={u.id}>
                {u.action} <span className="csub">· {u.seenIn.join(', ')}</span>
              </li>
            ))}
          </ul>
          <p className="csub" style={{ margin: '0.25rem 0 0' }}>
            Advice that survives a different league and a different platform is about how you draft.
            Anything appearing in only one is about that league.
          </p>
        </div>
      )}

      {data.playbook.length > 0 && (
        <>
          <div className="clabel" style={{ padding: '0.25rem 0.75rem 0.375rem' }}>
            Before your next mock
          </div>
          {data.playbook.map((p, i) => (
            <div className={`play ${i === 0 ? 'focus' : ''}`} key={p.id}>
              <div className="playhead">
                <span className="playnum">{i + 1}</span>
                <span className="playaction">{p.action}</span>
                {i === 0 && <span className="ax need">focus</span>}
              </div>
              <div className="playrow">
                <span className="k">When</span>
                <span>{p.when}</span>
              </div>
              <div className="playrow">
                <span className="k">Because</span>
                <span>{p.because}</span>
              </div>
              <div className="playrow">
                <span className="k">You'll know</span>
                <span>{p.check}</span>
              </div>
            </div>
          ))}
        </>
      )}

      <button className="detailtoggle" onClick={() => setShowDetail((v) => !v)}>
        {showDetail ? '▾ hide the numbers' : '▸ show the numbers behind this'}
      </button>

      {showDetail && (
      <>
      <p className="rcaveat" style={{ marginTop: 0 }}>
        <b>Cost</b> is value forgone: at each of your picks, the best available player who fitted an
        open starting slot, minus the one you took, in the board's own units. Zero means you took
        the best fit available. It measures agreement with your board, not whether the board was
        right.
      </p>
      <p className="rcaveat" style={{ marginTop: 0 }}>{data.caveat}</p>

      {data.counterfactual.length > 0 && (
        <>
          <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.375rem' }}>
            Your starters against taking the board every time
          </div>
          <div className="legend">
            <span className="lgd"><span className="swatch actual" /> what you drafted</span>
            <span className="lgd"><span className="swatch ideal" /> best available that fitted</span>
          </div>
          {data.counterfactual.map((c, i) => {
            const max = Math.max(...data.counterfactual.map((x) => Math.max(x.actual, x.ideal)), 1)
            return (
              <div className="cfrow" key={i}>
                <span className="cfname">{c.label}</span>
                <span className="cfbars">
                  <span className="cfbar actual" style={{ width: `${(c.actual / max) * 100}%` }}>
                    <b>{c.actual}</b>
                  </span>
                  <span className="cfbar ideal" style={{ width: `${(c.ideal / max) * 100}%` }}>
                    <b>{c.ideal}</b>
                  </span>
                </span>
                <span className={`cfgain ${c.gain > 0 ? 'lost' : 'even'}`}>
                  {c.gain > 0 ? `−${c.gain}` : 'even'}
                </span>
              </div>
            )
          })}
          <p className="rcaveat">
            The other eleven teams are held fixed, so this is a floor on the difference rather than a
            simulation of the alternate draft — a different pick of yours changes what reaches them.
          </p>
        </>
      )}

      {data.openerCost.length > 1 && (
        <>
          <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.375rem' }}>
            Opening shape · cost per pick over rounds 3–8
          </div>
          {data.openerCost.map((o) => (
            <div className="rphase" key={o.shape}>
              <span className="mono rphasename">{o.shape}</span>
              <span className="csub mono">
                {o.drafts} draft{o.drafts === 1 ? '' : 's'} · {o.avgCost} per pick
              </span>
            </div>
          ))}
        </>
      )}

      <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.375rem' }}>
        Where the value goes · worst decision in each round, named
      </div>
      <div className="chart">
        {data.costByRound.map((r) => (
          <div className="crow" key={r.round}>
            <span className="mono crd">R{r.round}</span>
            <span className="ctrack">
              <span
                className={`cfill ${r.avgCost >= 1 ? 'bad' : r.avgCost >= 0.4 ? 'mid' : 'ok'}`}
                style={{ width: `${Math.max((r.avgCost / maxCost) * 100, r.avgCost > 0 ? 2 : 0)}%` }}
              />
            </span>
            <span className="mono cval">{r.avgCost ? r.avgCost.toFixed(1) : '—'}</span>
            <span className={`cwho ${r.worstPick?.vindicated ? 'vindicated' : ''}`}>
              {r.worstPick
                ? r.worstPick.vindicated
                  ? `${r.worstPick.name} over ${r.worstPick.instead} — board came round`
                  : `${r.worstPick.name} over ${r.worstPick.instead}`
                : r.avgCost === 0
                  ? 'clean'
                  : ''}
            </span>
          </div>
        ))}
      </div>

      <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.375rem' }}>
        When you take each position
      </div>
      <div className="legend">
        <span className="lgd"><span className="tick static" /> one pick</span>
        <span className="lgd"><span className="median static" /> you, typically</span>
        <span className="lgd"><span className="boardmark static" /> the board</span>
        <span className="lgdnote">a gap between the two marks is the thing to change</span>
      </div>
      <div className="chart">
        {data.positionRounds.map((p) => {
          const maxRound = Math.max(...data.positionRounds.flatMap((x) => x.rounds), 15)
          return (
            <div className="crow" key={p.pos}>
              <span className="cpos"><Pos pos={p.pos} /></span>
              <span className="ctrack timeline">
                {p.rounds.map((rd, i) => (
                  <span
                    key={i}
                    className="tick"
                    style={{ left: `${((rd - 1) / (maxRound - 1)) * 100}%` }}
                    title={`round ${rd}`}
                  />
                ))}
                <span
                  className="median"
                  style={{ left: `${((p.median - 1) / (maxRound - 1)) * 100}%` }}
                />
                {p.boardMedian != null && (
                  <span
                    className="boardmark"
                    style={{ left: `${((p.boardMedian - 1) / (maxRound - 1)) * 100}%` }}
                    title={`the board would take ${p.pos} around round ${p.boardMedian}`}
                  />
                )}
              </span>
              <span className="mono cval">R{p.median}</span>
              <span className={`cwho ${p.drift != null && Math.abs(p.drift) >= 2 ? 'drift' : ''}`}>
                {p.verdict}
              </span>
            </div>
          )
        })}
        <div className="crow axis">
          <span className="cpos" />
          <span className="ctrack">
            {[1, 5, 10, 15].map((r) => (
              <span key={r} className="axislabel" style={{ left: `${((r - 1) / 14) * 100}%` }}>
                R{r}
              </span>
            ))}
          </span>
          <span className="cval" />
          <span className="cwho" />
        </div>
      </div>

      <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.375rem' }}>Drafts included</div>
      {(all.allDrafts ?? data.sources).map((s: any) => (
        <div className={`rsource ${s.excluded ? 'off' : ''}`} key={s.key}>
          <button className="rsourcename" onClick={() => onOpenDraft(s.key)}>
            <span className="nm">{s.leagueLabel ?? s.label}</span>
            <span className="mono csub">
              {s.platform} · {new Date(s.updatedAt ?? s.when).toLocaleDateString()}
              {s.excluded ? ` · excluded: ${s.excludedReason ?? ''}` : ''}
            </span>
          </button>
          <button
            className="chip"
            onClick={async () => {
              await fetch(`/api/drafts/${s.key}/exclude`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  excluded: !s.excluded,
                  reason: 'not my decisions — autodrafted',
                }),
              })
              const r = await fetch('/api/tendencies').then((x) => x.json())
              setAll(r)
            }}
          >
            {s.excluded ? 'INCLUDE' : 'EXCLUDE'}
          </button>
        </div>
      ))}
      </>
      )}
    </div>
  )
}
