import type { Adapter, AdapterHealth } from './types.js'
import type { Pick, Pos } from '../kernel/types.js'
import type { PlayerIndex } from '../kernel/match.js'
import { slotFor } from '../kernel/snake.js'

/** One row as scraped from Yahoo's draft results page. */
export interface YahooRow {
  round: number
  pickInRound: number
  name: string
  team: string
  pos: string
  manager: string
}

const POS_ALIAS: Record<string, Pos> = { DEF: 'DST', D: 'DST', DST: 'DST' }

/**
 * Receives snapshots pushed by the browser extension rather than polling. The
 * extension fetches Yahoo's server-rendered draft results page from a Yahoo
 * tab, so it inherits the live session and never touches the draft room.
 */
export class YahooExtAdapter implements Adapter {
  readonly name = 'yahoo-ext'
  private lastUpdate: number | null = null
  private lastError: string | null = null
  private unresolved: string[] = []
  private count = 0
  private emit: ((picks: Pick[], source: string) => void) | null = null
  private names: Record<number, string> = {}

  teamNames(): Record<number, string> {
    return this.names
  }

  constructor(
    private readonly teams: number,
    private readonly index: PlayerIndex,
  ) {}

  async start(onSnapshot: (picks: Pick[], source: string) => void): Promise<void> {
    this.emit = onSnapshot
  }

  stop(): void {
    this.emit = null
  }

  /** Called by the HTTP endpoint the extension posts to. */
  /** Distinguishes "connected, nothing drafted yet" from "no sensor". */
  private everContacted = false
  /** Set when the sensor reaches us but cannot read Yahoo. */
  private sensorError: string | null = null

  /**
   * The sensor reports its own failures. Without this the server sees silence
   * and cannot tell a blocked fetch from a quiet draft — it would keep showing
   * the last good board as though nothing were wrong.
   */
  reportError(message: string): void {
    this.everContacted = true
    this.sensorError = message
    this.lastError = message
  }

  ingest(rows: YahooRow[]): { accepted: number; unresolved: string[] } {
    this.everContacted = true
    this.sensorError = null
    const picks: Pick[] = []
    const unresolved: string[] = []

    for (const row of rows) {
      const pos = (POS_ALIAS[row.pos?.toUpperCase()] ?? row.pos?.toUpperCase()) as Pos
      const player = this.index.resolve({ name: row.name, pos, team: row.team })
      if (!player) {
        unresolved.push(`${row.name} (${row.pos} ${row.team})`)
        continue
      }
      const overall = (row.round - 1) * this.teams + row.pickInRound
      if (row.manager) this.names[slotFor(overall, this.teams)] = row.manager
      picks.push({
        overall,
        round: row.round,
        slot: slotFor(overall, this.teams),
        teamId: row.manager || `slot-${slotFor(overall, this.teams)}`,
        playerId: player.id,
      })
    }

    this.count = picks.length
    this.unresolved = unresolved
    this.lastUpdate = Date.now()
    this.lastError = unresolved.length ? `${unresolved.length} unresolved` : null
    this.emit?.(picks, this.name)
    return { accepted: picks.length, unresolved }
  }

  health(): AdapterHealth {
    return {
      name: this.name,
      ok: this.sensorError === null && this.lastUpdate !== null && this.unresolved.length === 0,
      lastUpdate: this.lastUpdate,
      lastError: this.lastError,
      detail: this.sensorError
        ? `cannot read Yahoo — ${this.count} picks are stale`
        : this.everContacted
          ? this.count > 0
            ? `${this.count} picks`
            : 'connected, no picks yet'
          : 'no sensor',
    }
  }
}
