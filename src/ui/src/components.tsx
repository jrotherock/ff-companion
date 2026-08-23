import { useState, type ReactElement } from 'react'
import type { Brief, Card, Explanation, Flags, Pick3, View } from './api'

export const Pos = ({ pos, rank }: { pos: string | null; rank?: number }) =>
  pos ? (
    <span className={`pos ${pos}`}>
      {pos}
      {rank ?? ''}
    </span>
  ) : null

export function Tags({ flags }: { flags: Flags }) {
  if (!flags?.tags?.length) return null
  return (
    <>
      {flags.tags.map((t) => (
        <span key={t} className={`ax ${t}`}>
          {t === 'like' ? `♥ #${flags.likeRank}` : t === 'avoid' ? '⊘ avoid' : '◎ target'}
        </span>
      ))}
    </>
  )
}

const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`)

const survColor = (s: number | null) =>
  s == null ? 'var(--dim)' : s < 0.3 ? 'var(--red)' : s > 0.7 ? 'var(--green)' : 'var(--amber)'

/** The three-up verdict. Collapses to one card only when every axis agrees. */
export function Verdict({
  view,
  selected,
  compare,
  onSelect,
  onDraft,
}: {
  view: View
  selected: string | null
  compare: string | null
  onSelect: (id: string, asCompare?: boolean) => void
  onDraft: (id: string) => void
}) {
  const { verdict, clock } = view
  if (!verdict.picks.length) return null

  const label: Record<string, string> = {
    clear: `Clear · ${verdict.gap.toFixed(1)} ahead`,
    close: `Too close to call · ${verdict.gap.toFixed(2)} apart`,
    split: `Split — the three measures disagree`,
  }

  const chosen = verdict.picks.find((p) => p.playerId === selected) ?? null
  const chosenCompare = verdict.picks.find((p) => p.playerId === compare) ?? null

  return (
    <div className="verdict">
      <div className="vhead">
        <span className="vlabel">
          {clock.onMyClock ? 'On your clock' : `Next turn at ${clock.nextPick ?? '—'}`}
        </span>
        <span className={`conf ${verdict.confidence}`}>{label[verdict.confidence]}</span>
      </div>

      {verdict.unanimous ? (
        <button className="solo" onClick={() => onDraft(verdict.picks[0].playerId)}>
          <span className="nm">{verdict.picks[0].name}</span>
          <span className="vnums">
            <span className="vnum">
              <span className="k">VONA</span>
              <span className="v" style={{ color: 'var(--green)' }}>
                +{verdict.picks[0].vona.toFixed(2)}
              </span>
            </span>
            <span className="vnum">
              <span className="k">Survive</span>
              <span className="v" style={{ color: survColor(verdict.picks[0].survival) }}>
                {pct(verdict.picks[0].survival)}
              </span>
            </span>
          </span>
          <span className="btn primary">DRAFT ⏎</span>
        </button>
      ) : (
        <div className="threeup">
          {verdict.picks.map((p, i) => (
            <button
              key={p.playerId}
              className={`vc ${selected === p.playerId ? 'sel' : ''} ${
                compare === p.playerId ? 'cmp' : ''
              }`}
              onClick={(e) => onSelect(p.playerId, e.shiftKey)}
            >
              <span className="rk">{i + 1}{selected === p.playerId ? ' · SELECTED' : ''}</span>
              <span className="nm">{p.name}</span>
              <span className="sub">
                {p.pos}
                {p.posRank} · {p.team} · BYE {p.byeWeek ?? '—'}
              </span>
              <span className="vnums">
                <span className="vnum">
                  <span className="k">VONA</span>
                  <span className="v" style={{ color: 'var(--green)' }}>
                    +{p.vona.toFixed(2)}
                  </span>
                </span>
                <span className="vnum">
                  <span className="k">Surv</span>
                  <span className="v" style={{ color: survColor(p.survival) }}>
                    {pct(p.survival)}
                  </span>
                </span>
              </span>
              <span className="axrow">
                {p.axes.map((a) => (
                  <span key={a} className={`ax ${a}`}>
                    {a}
                  </span>
                ))}
                <Tags flags={p.flags} />
              </span>
            </button>
          ))}
        </div>
      )}

      {(chosen?.explain || chosenCompare?.explain) && (
        <div className={`whywrap ${chosen?.explain && chosenCompare?.explain ? 'two' : ''}`}>
          {chosen?.explain && (
            <Why
              explain={chosen.explain}
              onDraft={() => onDraft(chosen.playerId)}
              onClose={() => onSelect(chosen.playerId)}
            />
          )}
          {chosenCompare?.explain && (
            <Why
              explain={chosenCompare.explain}
              onDraft={() => onDraft(chosenCompare.playerId)}
              onClose={() => onSelect(chosenCompare.playerId, true)}
            />
          )}
        </div>
      )}
      {verdict.modelConflict && (
        <div className="alert note" style={{ marginTop: 7 }}>
          <div className="h">Models disagree</div>
          {verdict.modelConflict}
        </div>
      )}
    </div>
  )
}

export function Why({
  explain,
  onDraft,
  onClose,
}: {
  explain: Explanation
  onDraft: () => void
  onClose?: () => void
}) {
  const mark = { good: '+', bad: '−', neutral: '·' }
  return (
    <div className="why">
      <div className="whyhead">
        <span>WHY {explain.name.toUpperCase()}</span>
        <span className={`stamp ${explain.verdict}`} style={{ marginLeft: 'auto' }}>
          {explain.verdict}
        </span>
        {onClose && (
          <button className="closex" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
      </div>
      <div style={{ padding: '7px 10px', fontSize: 12.5, color: 'var(--muted)' }}>
        {explain.headline}
      </div>
      {explain.bullets.map((b, i) => (
        <div key={i} className={`bl ${b.tone}`}>
          <span className="mk">{mark[b.tone]}</span>
          <span>{b.text}</span>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 7, padding: '8px 10px' }}>
        <button className="btn primary" onClick={onDraft}>
          DRAFT {explain.name.split(' ').pop()?.toUpperCase()} ⏎
        </button>
        <span className="hint" style={{ alignSelf: 'center' }}>
          ESC or ✕ to close · SHIFT-click a second player to compare
        </span>
      </div>
    </div>
  )
}

export function Board({
  cards,
  selected,
  compare,
  onSelect,
  hideAvoids,
  positions,
}: {
  cards: Card[]
  selected: string | null
  compare: string | null
  onSelect: (id: string, asCompare?: boolean) => void
  hideAvoids: boolean
  /** Empty means no filter — show everything. */
  positions: Set<string>
}) {
  let shown = hideAvoids ? cards.filter((c) => !c.flags.tags.includes('avoid')) : cards
  if (positions.size) shown = shown.filter((c) => c.pos && positions.has(c.pos))
  if (!shown.length) return <div className="empty">nothing available</div>

  let lastTier: number | null = null
  const out: ReactElement[] = []

  shown.forEach((c, i) => {
    // Tier boundaries come from value gaps, so a rule marks a real cliff.
    const prev = shown[i - 1]
    if (prev && prev.adjustedValue - c.adjustedValue >= 0.6) {
      lastTier = (lastTier ?? 1) + 1
      out.push(
        <div className="tierrule" key={`t${i}`}>
          TIER {lastTier}
        </div>,
      )
    }
    out.push(
      <button
        key={c.playerId}
        className={`row ${selected === c.playerId ? 'sel' : ''} ${
          compare === c.playerId ? 'cmp' : ''
        } ${c.flags.tags.includes('avoid') ? 'dim' : ''}`}
        onClick={(e) => onSelect(c.playerId, e.shiftKey)}
      >
        <span className="rk">{i + 1}</span>
        <span>
          <span className="nm">
            {c.name}
            <Tags flags={c.flags} />
          </span>
          <span className="tm">
            {c.team} · BYE {c.byeWeek ?? '—'} · {c.adjustedValue.toFixed(1)}
          </span>
        </span>
        <Pos pos={c.pos} rank={c.posRank} />
        <span className="mono adp" style={{ fontSize: 11.5 }}>
          {Math.round(c.adp)}
        </span>
        <span className="mono" style={{ fontSize: 11.5, color: survColor(c.survival) }}>
          {c.survival == null ? '—' : Math.round(c.survival * 100)}
        </span>
      </button>,
    )
  })

  return (
    <>
      <div className="row head">
        <span>#</span>
        <span>PLAYER</span>
        <span>POS</span>
        <span className="adp">ADP</span>
        <span>S%</span>
      </div>
      {out}
    </>
  )
}

export function Tiers({
  view,
  selected,
  onSelect,
}: {
  view: View
  selected: string | null
  onSelect: (id: string) => void
}) {
  const positions = [...new Set(view.board.map((c) => c.pos).filter(Boolean))] as string[]
  const order = ['RB', 'WR', 'TE', 'QB', 'LB', 'DL', 'DB', 'K', 'DST']
  positions.sort((a, b) => order.indexOf(a) - order.indexOf(b))

  const takenRecently = view.picks.slice(-14).reverse()
  const openBy = new Map(view.needs.map((n) => [n.pos, n.openStarters]))

  return (
    <div className="tiergrid">
      {positions.slice(0, 8).map((pos) => {
        const avail = view.board.filter((c) => c.pos === pos).slice(0, 5)
        const gone = takenRecently.filter((p) => p.player.pos === pos).slice(0, 2)
        return (
          <div className="col" key={pos}>
            <div className="colhead">
              <Pos pos={pos} />
              <span>{(openBy.get(pos) ?? 0).toFixed(1)} OPEN</span>
            </div>
            {gone.map((g) => (
              <div className="tcard gone" key={g.overall}>
                <div className="nm">{g.player.name}</div>
                <div className="sub">
                  {g.overall} · {g.by}
                </div>
              </div>
            ))}
            {avail.map((c, i) => {
              const prev = avail[i - 1]
              const cliff = prev && prev.adjustedValue - c.adjustedValue >= 0.6
              return (
                <div key={c.playerId}>
                  {cliff && <div className="cliff">TIER BREAK</div>}
                  <button
                    className={`tcard ${selected === c.playerId ? 'sel' : ''}`}
                    onClick={() => onSelect(c.playerId)}
                  >
                    <div className="nm">{c.name}</div>
                    <div className="sub">
                      {c.pos}
                      {c.posRank} · {c.survival == null ? '—' : Math.round(c.survival * 100) + '%'} ·{' '}
                      {c.adjustedValue.toFixed(1)}
                    </div>
                  </button>
                </div>
              )
            })}
            {!avail.length && <div className="empty">none left</div>}
          </div>
        )
      })}
    </div>
  )
}

export function Drafted({ view, mode }: { view: View; mode: 'feed' | 'grid' }) {
  if (!view.picks.length) return <div className="empty">no picks yet</div>

  if (mode === 'feed') {
    return (
      <>
        {[...view.picks].reverse().map((p) => (
          <div className={`fitem p-${p.player.pos ?? 'NA'} ${p.mine ? 'mine' : ''}`} key={p.overall}>
            <span className="ov">{p.overall}</span>
            <span>
              <span className="nm">{p.player.name}</span>
              <span className="by">
                {p.player.team} · {p.by} {p.mine && <span className="youtag">YOU</span>}
              </span>
            </span>
            <Pos pos={p.player.pos} />
          </div>
        ))}
      </>
    )
  }

  const { teams, rounds, mySlot } = view.league
  const byRound = new Map<number, Map<number, (typeof view.picks)[number]>>()
  for (const p of view.picks) {
    if (!byRound.has(p.round)) byRound.set(p.round, new Map())
    byRound.get(p.round)!.set(p.slot, p)
  }
  const maxRound = Math.min(rounds, Math.max(view.clock.round, 1) + 1)

  return (
    <div className="gridwrap">
      <table className="gtable">
        <thead>
          <tr>
            <th />
            {Array.from({ length: teams }, (_, i) => (
              <th key={i} className={i + 1 === mySlot ? 'me' : ''}>
                {i + 1}
                {i + 1 === mySlot ? ' · YOU' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: maxRound }, (_, r) => (
            <tr key={r}>
              <td className="rlabel">R{r + 1}</td>
              {Array.from({ length: teams }, (_, s) => {
                const cell = byRound.get(r + 1)?.get(s + 1)
                const isNow =
                  !cell &&
                  view.clock.round === r + 1 &&
                  view.clock.currentPick ===
                    (r % 2 === 0 ? r * teams + s + 1 : r * teams + (teams - s))
                if (isNow) return <td key={s}><div className="cell now">NOW</div></td>
                if (!cell) return <td key={s}><div className="cell empty" /></td>
                return (
                  <td key={s}>
                    <div
                      className={`cell p-${cell.player.pos ?? 'NA'} ${cell.mine ? 'me' : ''}`}
                    >
                      <div className="n">{cell.player.name.split(' ').slice(-1)[0]}</div>
                      <div className="o">
                        {cell.overall} · {cell.player.pos}
                      </div>
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Roster({ view }: { view: View }) {
  return (
    <div className="roster">
      {view.roster.slots.map((s, i) => (
        <div className={`rslot ${s.player ? '' : 'open'}`} key={i}>
          <div className="s">{s.name}</div>
          <div className="p">{s.player ? s.player.name.split(' ').slice(-1)[0] : 'open'}</div>
        </div>
      ))}
      {view.roster.bench.map((b, i) => (
        <div className="rslot" key={`b${i}`}>
          <div className="s">BN</div>
          <div className="p">{b.name.split(' ').slice(-1)[0]}</div>
        </div>
      ))}
    </div>
  )
}

export function Alerts({ view }: { view: View }) {
  const items: { tone: string; head: string; body: string }[] = []

  if (view.run) {
    items.push({
      tone: 'warn',
      head: `Run · ${view.run.pos} ×${view.run.count} of 6`,
      body: `${view.run.count} of the last six picks were ${view.run.pos}.`,
    })
  }
  for (const s of view.strategy) {
    items.push({ tone: s.severity === 'warn' ? 'warn' : 'info', head: s.label, body: s.message })
  }
  for (const t of view.tierBreaks.slice(0, 2)) {
    items.push({
      tone: 'info',
      head: `Last of tier · ${t.pos}`,
      body: `${t.player.name} is one of ${t.remaining} left in tier ${t.tier}.`,
    })
  }
  for (const c of view.roster.byeConflicts.slice(0, 1)) {
    items.push({
      tone: 'note',
      head: `Bye stack · week ${c.week}`,
      body: `${c.players.map((p) => p.name).join(' and ')} already share week ${c.week}.`,
    })
  }
  if (view.goneSinceLastTurn.count > 0 && view.goneSinceLastTurn.since != null) {
    items.push({
      tone: 'note',
      head: 'Since your last turn',
      body: `${view.goneSinceLastTurn.count} players gone since pick ${view.goneSinceLastTurn.since}.`,
    })
  }

  if (!items.length) return null
  return (
    <div className="alerts">
      {items.slice(0, 4).map((a, i) => (
        <div className={`alert ${a.tone}`} key={i}>
          <div className="h">{a.head}</div>
          {a.body}
        </div>
      ))}
    </div>
  )
}

export function SlotGate({
  view,
  onPick,
}: {
  view: View
  onPick: (slot: number) => void
}) {
  return (
    <div className="gate">
      <h2>Which slot are you?</h2>
      <p>
        {view.league.label} · {view.league.teams} teams. Yahoo randomises the order about thirty
        minutes before the draft, so set this the moment you know it — almost every number in here
        depends on it.
      </p>
      <div className="slots">
        {Array.from({ length: view.league.teams }, (_, i) => (
          <button className="slotbtn" key={i} onClick={() => onPick(i + 1)}>
            {i + 1}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Draft source. A mock and the real draft differ only by id, so switching is a
 * field rather than a config edit — and the real id is remembered so switching
 * back is one click.
 */
export function Source({
  view,
  onSet,
  onClose,
}: {
  view: View
  onSet: (draftId: string | null, isMock: boolean) => void
  onClose: () => void
}) {
  const { feed, draftId, configuredDraftId, isMock } = view.league
  const [value, setValue] = useState(draftId ?? '')

  if (feed !== 'sleeper') {
    return (
      <div className="settings">
        <div className="panelhead">Draft source · {view.league.label}</div>
        <p className="note">
          This league feeds from the Yahoo browser sensor — there is no id to set. Open a Yahoo
          draft room, mock or real, and it appears in the league list on its own within a few
          seconds. Manual entry works regardless.
        </p>
        <div className="srow">
          <button className="btn" onClick={onClose}>
            CLOSE
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="settings">
      <div className="panelhead">Draft source · {view.league.label}</div>
      <p className="note">
        Paste the whole Sleeper draft URL — or just the id — to rehearse against a mock, then
        restore the real draft when you are done. Each draft keeps its own pick log, so switching
        never loses anything. Sleeper has no way to list your mocks, so this is the one number the
        app cannot find for itself.
      </p>
      <div className="srow">
        <input
          className="field"
          value={value}
          placeholder="paste the Sleeper draft URL or id"
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn primary" onClick={() => onSet(value.trim() || null, true)}>
          USE AS MOCK
        </button>
      </div>
      <div className="srow">
        <button
          className="btn"
          onClick={() => onSet(configuredDraftId, false)}
          disabled={!configuredDraftId}
        >
          RESTORE REAL DRAFT
        </button>
        <span className="note" style={{ margin: 0 }}>
          {isMock ? 'currently on a mock' : 'currently on the real draft'} ·{' '}
          <code>{draftId ?? 'none'}</code>
        </span>
      </div>
      <div className="srow">
        <button className="btn" onClick={onClose}>
          CLOSE
        </button>
      </div>
    </div>
  )
}

/**
 * End of draft. Nothing here is a decision any more, so it answers the
 * questions you actually have once it is over: what did I end up with, did I
 * take anyone I meant to avoid, and who is worth a waiver claim.
 */
export function Complete({ view }: { view: View }) {
  const s = view.summary
  if (!s) return null
  const order = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST', 'LB', 'DL', 'DB']
  const counts = Object.entries(s.byPos).sort(
    (a, b) => order.indexOf(a[0]) - order.indexOf(b[0]),
  )

  return (
    <div className="complete">
      <div className="chead">
        <span className="ctitle">Draft complete</span>
        <span className="csub mono">
          {view.clock.totalPicks} picks · {view.league.teams} teams · {view.league.rounds} rounds
        </span>
      </div>

      <div className="crow">
        {counts.map(([pos, n]) => (
          <span key={pos} className="cstat">
            <Pos pos={pos} />
            <b>{n}</b>
          </span>
        ))}
      </div>

      {view.roster.byeConflicts.length > 0 && (
        <div className="alert note">
          <div className="h">Bye weeks to plan around</div>
          {view.roster.byeConflicts
            .map((c) => `week ${c.week}: ${c.players.map((p) => p.name).join(', ')}`)
            .join(' · ')}
        </div>
      )}

      {s.avoids.length > 0 && (
        <div className="alert warn">
          <div className="h">You drafted {s.avoids.length} from your do-not-draft list</div>
          {s.avoids.map((p) => p.name).join(', ')}
        </div>
      )}

      <div className="csection">
        <div className="clabel">Best still on the board — waiver targets</div>
        {s.bestAvailable.map((p) => (
          <div className="cwaiver" key={p.id}>
            <Pos pos={p.pos} />
            <span className="nm">{p.name}</span>
            <span className="mono csub">
              {p.team} · bye {p.byeWeek ?? '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export const briefName = (b: Brief) => b.name
export type { Pick3 }
