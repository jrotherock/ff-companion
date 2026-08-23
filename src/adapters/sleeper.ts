import type { Adapter, AdapterHealth } from './types.js'
import type { Pick } from '../kernel/types.js'

/**
 * Sleeper's draft picks endpoint is public and unauthenticated. Sleeper asks
 * for under 1000 calls/min; a 2s poll is two orders of magnitude inside that.
 */
export class SleeperAdapter implements Adapter {
  readonly name = 'sleeper'
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private lastUpdate: number | null = null
  private lastError: string | null = null
  private picks = 0

  private names: Record<number, string> = {}
  private userNames = new Map<string, string>()
  private orderLoaded = false
  /** What the platform itself says, so local state can be checked against it. */
  private remoteCount: number | null = null

  /** Picks the platform reports, or null if it has never answered. */
  feedCount(): number | null {
    return this.remoteCount
  }

  /**
   * Picks arrive in bursts — a run of autopicks lands in a second, then nothing
   * for a minute. A fixed interval is either too slow during a burst or wasteful
   * between them, so the poll tightens right after a change and relaxes when the
   * board is quiet. Sleeper allows 1000 calls/min; even the fast rate is well
   * inside that.
   */
  private static readonly FAST_MS = 400
  private static readonly BASE_MS = 1000
  private static readonly IDLE_MS = 3000
  /** Polls at the fast rate after a change before easing off. */
  private static readonly BURST_POLLS = 12

  private burst = 0
  private quiet = 0

  constructor(
    private readonly draftId: string,
    private readonly leagueId?: string,
  ) {}

  /** Manager display names, so drafted picks read as people not slot numbers. */
  private async loadUsers(): Promise<void> {
    if (!this.leagueId || this.userNames.size) return
    try {
      const res = await fetch(`https://api.sleeper.app/v1/league/${this.leagueId}/users`)
      if (!res.ok) return
      for (const u of (await res.json()) as any[]) {
        this.userNames.set(String(u.user_id), u.metadata?.team_name || u.display_name || 'Manager')
      }
    } catch {
      // Names are cosmetic; never let this break the pick feed.
    }
  }

  /**
   * `draft_order` maps each manager to a slot and fills in the moment the draft
   * opens. Reading it means slot names are right from the first pick rather than
   * appearing one at a time as picks arrive.
   */
  private async loadOrder(): Promise<void> {
    if (this.orderLoaded) return
    try {
      const res = await fetch(`https://api.sleeper.app/v1/draft/${this.draftId}`)
      if (!res.ok) return
      const draft = (await res.json()) as any
      if (!draft?.draft_order) return
      for (const [userId, slot] of Object.entries(draft.draft_order)) {
        const name = this.userNames.get(String(userId))
        if (name) this.names[Number(slot)] = name
      }
      this.orderLoaded = Object.keys(draft.draft_order).length > 0
    } catch {
      // Same: cosmetic.
    }
  }

  teamNames(): Record<number, string> {
    return this.names
  }

  async start(onSnapshot: (picks: Pick[], source: string) => void): Promise<void> {
    const poll = async () => {
      try {
        const res = await fetch(`https://api.sleeper.app/v1/draft/${this.draftId}/picks`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const raw = (await res.json()) as any[]
        for (const p of raw) {
          const n = this.userNames.get(String(p.picked_by))
          if (n && p.draft_slot) this.names[p.draft_slot] = n
        }
        const picks: Pick[] = raw.map((p) => ({
          overall: p.pick_no,
          round: p.round,
          slot: p.draft_slot,
          teamId: String(p.picked_by ?? p.roster_id ?? p.draft_slot),
          playerId: String(p.player_id),
        }))
        this.remoteCount = picks.length
        const changed = picks.length !== this.picks
        this.picks = picks.length
        this.lastUpdate = Date.now()
        this.lastError = null
        if (changed) {
          this.burst = SleeperAdapter.BURST_POLLS
          this.quiet = 0
        } else {
          if (this.burst > 0) this.burst--
          this.quiet++
        }
        onSnapshot(picks, this.name)
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    const schedule = () => {
      const delay =
        this.burst > 0
          ? SleeperAdapter.FAST_MS
          : this.quiet > 40
            ? SleeperAdapter.IDLE_MS
            : SleeperAdapter.BASE_MS
      this.timer = setTimeout(async () => {
        await poll()
        if (!this.stopped) {
          if (!this.orderLoaded) await this.loadOrder()
          schedule()
        }
      }, delay)
    }

    await this.loadUsers()
    await this.loadOrder()
    await poll()
    schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  health(): AdapterHealth {
    return {
      name: this.name,
      ok: this.lastError === null && this.lastUpdate !== null,
      lastUpdate: this.lastUpdate,
      lastError: this.lastError,
      detail: `${this.picks} picks`,
    }
  }
}
