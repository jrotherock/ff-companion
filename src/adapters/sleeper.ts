import type { Adapter, AdapterHealth } from './types.js'
import type { Pick } from '../kernel/types.js'

/**
 * Sleeper's draft picks endpoint is public and unauthenticated. Sleeper asks
 * for under 1000 calls/min; a 2s poll is two orders of magnitude inside that.
 */
export class SleeperAdapter implements Adapter {
  readonly name = 'sleeper'
  private timer: NodeJS.Timeout | null = null
  private lastUpdate: number | null = null
  private lastError: string | null = null
  private picks = 0

  private names: Record<number, string> = {}
  private userNames = new Map<string, string>()

  constructor(
    private readonly draftId: string,
    private readonly leagueId?: string,
    private readonly intervalMs = 2000,
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
        this.picks = picks.length
        this.lastUpdate = Date.now()
        this.lastError = null
        onSnapshot(picks, this.name)
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    await this.loadUsers()
    await poll()
    this.timer = setInterval(poll, this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
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
