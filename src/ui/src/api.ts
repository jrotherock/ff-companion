import { useCallback, useEffect, useRef, useState } from 'react'

export interface Flags {
  tags: ('like' | 'avoid' | 'target' | 'strategy')[]
  likeRank: number | null
  notes: string[]
}

export interface Card {
  playerId: string
  name: string
  pos: string | null
  team: string | null
  byeWeek: number | null
  value: number
  adjustedValue: number
  adjustmentDelta: number
  adjustmentDetail: string[]
  posRank: number
  adp: number
  adpDelta: number
  teamNote: string
  survival: number | null
  survivalAdp: number | null
  survivalOpponent: number | null
  flags: Flags
  archetype: { label: string; mine: boolean; kinds: string[] } | null
  /** Qualified as a late-window handcuff or rookie, so it leads the board. */
  lateTarget?: boolean
}

export interface Bullet {
  kind: string
  tone: 'good' | 'bad' | 'neutral'
  text: string
}

export interface Explanation {
  playerId: string
  name: string
  pos: string
  posRank: number
  team: string | null
  byeWeek: number | null
  headline: string
  verdict: 'take' | 'consider' | 'wait' | 'avoid'
  bullets: Bullet[]
  teamNote: string
}

export interface Pick3 {
  playerId: string
  name: string
  pos: string
  posRank: number
  team: string | null
  byeWeek: number | null
  adjustedValue: number
  adp: number
  survival: number
  vona: number
  axes: string[]
  flags: Flags
  explain: Explanation | null
}

export interface View {
  league: {
    id: string
    label: string
    platform: string
    teams: number
    rounds: number
    mySlot: number | null
    draftTime: string | null
    adjustments: { id: string; label: string; note: string }[]
    adjustmentsEnabled: boolean
    benchSize: number
    feed: string
    draftId: string | null
    configuredDraftId: string | null
    isMock: boolean
  }
  clock: {
    currentPick: number
    round: number
    nextPick: number | null
    picksUntilMyTurn: number | null
    onMyClock: boolean
    picksLeft: number
    complete: boolean
    totalPicks: number
  }
  board: Card[]
  verdict: {
    picks: Pick3[]
    gap: number
    unanimous: boolean
    confidence: 'clear' | 'close' | 'split'
    modelConflict: string | null
  }
  summary: {
    byPos: Record<string, number>
    likes: number
    avoids: Brief[]
    bestAvailable: Brief[]
  } | null
  upcomingDemand: { pos: string; demand: number }[]
  goneSinceLastTurn: {
    since: number | null
    count: number
    picks: { overall: number; player: Brief; by: string }[]
  }
  roster: {
    slots: { name: string; eligible: string[]; player: Brief | null }[]
    bench: Brief[]
    byeConflicts: { week: number; players: Brief[] }[]
  }
  needs: { pos: string; openStarters: number; urgency: number }[]
  strategy: { ruleId: string; label: string; severity: 'info' | 'warn'; message: string }[]
  preferences: { loaded: boolean; likes: number; avoids: number; rules: any[] }
  tierBreaks: { pos: string; tier: number; remaining: number; player: Brief }[]
  run: { pos: string; count: number } | null
  picks: {
    overall: number
    round: number
    slot: number
    by: string
    mine: boolean
    player: Brief
  }[]
  stale: { localPicks: number; feedPicks: number } | null
  teamNames: Record<string, string>
  health: {
    name: string
    ok: boolean
    lastUpdate: number | null
    lastError: string | null
    detail?: string
  }[]
}

export interface Brief {
  id: string
  name: string
  pos: string | null
  team: string | null
  byeWeek: number | null
}

export interface SearchHit extends Brief {
  ranked: boolean
  taken: boolean
  takenAt: number | null
  takenBy: string | null
}

const api = (path: string) => `/api${path}`

/**
 * Re-read periodically rather than once at mount: a mock started mid-session
 * adds a league, and having to reload the page to see it is exactly the wrong
 * thing to discover minutes before a draft.
 */
export function useLeagues() {
  const [leagues, setLeagues] = useState<
    {
      id: string
      label: string
      platform: string
      teams: number
      mySlot: number | null
      live?: boolean
      picks?: number
    }[]
  >([])
  useEffect(() => {
    let stopped = false
    const load = () =>
      fetch(api('/leagues'))
        .then((r) => r.json())
        .then((l) => {
          if (!stopped) setLeagues(l)
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 15000)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [])
  return leagues
}

/**
 * State arrives over a WebSocket push. The socket is a convenience, never a
 * dependency: an initial fetch seeds the view and a reconnect loop backfills, so
 * a dropped connection degrades to stale data rather than an empty screen.
 */
export function useView(leagueId: string | null) {
  const [view, setView] = useState<View | null>(null)
  const [connected, setConnected] = useState(false)
  /** When state last actually arrived, however it arrived. */
  const [lastViewAt, setLastViewAt] = useState<number | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const refresh = useCallback(() => {
    if (!leagueId) return Promise.resolve(false)
    return fetch(api(`/league/${leagueId}`))
      .then((r) => r.json())
      .then((v) => {
        setView(v)
        setLastViewAt(Date.now())
        return true
      })
      .catch(() => false)
  }, [leagueId])

  useEffect(() => {
    setView(null)
    refresh()
  }, [leagueId, refresh])

  useEffect(() => {
    if (!leagueId) return
    let closed = false
    let attempt = 0
    let retry: ReturnType<typeof setTimeout>

    const connect = () => {
      if (closed) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws
      ws.onopen = () => {
        attempt = 0
        setConnected(true)
        // Do not wait on the next heartbeat: the socket may have been down
        // through several picks, so pull current state immediately.
        refresh()
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'view' && msg.leagueId === leagueId) {
            setView(msg.view)
            setLastViewAt(Date.now())
          }
        } catch {
          // A malformed frame must not take the screen down.
        }
      }
      ws.onclose = () => {
        setConnected(false)
        // Keep trying for ever, but ease off so a stopped server is not hammered.
        attempt++
        const wait = Math.min(1500 * attempt, 10000)
        if (!closed) retry = setTimeout(connect, wait)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      wsRef.current?.close()
    }
  }, [leagueId, refresh])

  return { view, connected, lastViewAt, refresh }
}

export function useCommands(leagueId: string | null, refresh: () => void) {
  const send = useCallback(
    async (action: string, body: unknown) => {
      if (!leagueId) return null
      const res = await fetch(api(`/league/${leagueId}/${action}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      refresh()
      return json
    },
    [leagueId, refresh],
  )

  return {
    pick: (overall: number, playerId: string) => send('pick', { overall, playerId }),
    undo: (overall: number) => send('undo', { overall }),
    setSlot: (slot: number | null) => send('slot', { slot }),
    setAdjustments: (enabled: boolean) => send('adjustments', { enabled }),
    setSource: (draftId: string | null, isMock: boolean) => send('source', { draftId, isMock }),
    reset: () => send('reset', {}),
  }
}

export async function search(leagueId: string, q: string): Promise<SearchHit[]> {
  if (!q.trim()) return []
  const res = await fetch(api(`/league/${leagueId}/search?q=${encodeURIComponent(q)}`))
  return res.ok ? res.json() : []
}

export async function explain(leagueId: string, playerId: string): Promise<Explanation | null> {
  const res = await fetch(api(`/league/${leagueId}/explain?playerId=${playerId}`))
  return res.ok ? res.json() : null
}
