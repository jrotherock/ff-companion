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
}

interface DraftReview {
  picks: PickReview[]
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
        </div>
      ))}

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

interface TendencyReport {
  drafts: number
  picks: number
  avgCost: number
  tendencies: {
    id: string; headline: string; detail: string; strength: string; drafts: number
    tryNext: string | null
  }[]
  costByRound: { round: number; avgCost: number; worst: number; picks: number; points: number[] }[]
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
  const [data, setData] = useState<TendencyReport | null>(null)
  useEffect(() => {
    fetch('/api/tendencies')
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null))
  }, [])

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

      <p className="rcaveat" style={{ marginTop: 0 }}>{data.caveat}</p>

      {data.tendencies.map((t) => (
        <div className={`tend ${t.strength}`} key={t.id}>
          <div className="th">
            <span>{t.headline}</span>
            <span className={`ax ${t.strength === 'clear' ? 'need' : 'like'}`}>{t.strength}</span>
          </div>
          <p>{t.detail}</p>
          {t.tryNext && (
            <p className="trynext">
              <span className="h">Try next</span>
              {t.tryNext}
            </p>
          )}
        </div>
      ))}

      {data.counterfactual.length > 0 && (
        <>
          <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.375rem' }}>
            Your starters against taking the board every time
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
            What each opening shape cost you
          </div>
          {data.openerCost.map((o) => (
            <div className="rphase" key={o.shape}>
              <span className="mono rphasename">{o.shape}</span>
              <span className="csub mono">
                {o.drafts} draft{o.drafts === 1 ? '' : 's'} · {o.avgCost} avg cost
              </span>
            </div>
          ))}
        </>
      )}

      <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.375rem' }}>
        Cost by round · one dot per draft, bar is the average
      </div>
      <div className="rbars">
        {data.costByRound.map((r) => (
          <div className="rbar" key={r.round}>
            <span className="mono rbarrd">R{r.round}</span>
            <span className="dotlane">
              <span className="dotmean" style={{ left: `${(r.avgCost / maxCost) * 100}%` }} />
              {r.points.map((v, i) => (
                <span
                  key={i}
                  className={`dot ${v >= 1 ? 'bad' : ''}`}
                  style={{ left: `${(v / maxCost) * 100}%` }}
                  title={`${v}`}
                />
              ))}
            </span>
            <span className="mono rbarval">{r.avgCost ? r.avgCost.toFixed(1) : '·'}</span>
          </div>
        ))}
      </div>

      <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.375rem' }}>What you take, when</div>
      {data.positionByPhase.map((p) => (
        <div className="rphase" key={p.phase}>
          <span className="mono rphasename">{p.phase}</span>
          {Object.entries(p.counts)
            .sort((a, b) => b[1] - a[1])
            .map(([pos, n]) => (
              <span className="cstat" key={pos}>
                <Pos pos={pos} />
                <b>{n}</b>
              </span>
            ))}
        </div>
      ))}

      <div className="clabel" style={{ padding: '0.75rem 0.75rem 0.375rem' }}>Drafts included</div>
      {data.sources.map((s) => (
        <button className="rsource" key={s.key} onClick={() => onOpenDraft(s.key)}>
          <span className="nm">{s.label}</span>
          <span className="mono csub">
            {s.platform} · {s.mock ? 'mock' : 'real'} · {new Date(s.when).toLocaleDateString()}
          </span>
        </button>
      ))}
    </div>
  )
}
