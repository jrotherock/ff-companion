import type { Pick } from '../kernel/types.js'

export interface AdapterHealth {
  name: string
  ok: boolean
  lastUpdate: number | null
  lastError: string | null
  detail?: string
}

/**
 * Sensors emit full pick snapshots and hold no logic. The kernel diffs, so a
 * sensor that drops offline recovers by itself on its next successful poll.
 */
export interface Adapter {
  readonly name: string
  start(onSnapshot: (picks: Pick[], source: string) => void): Promise<void>
  stop(): void
  health(): AdapterHealth
  /** Draft slot -> manager name, when the feed knows them. */
  teamNames?(): Record<number, string>
  /** How many picks the platform reports, or null if it has not answered. */
  feedCount?(): number | null
}
