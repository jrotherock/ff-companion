import type { Diff, Pick, PlayerId } from './types.js'
import { roundFor, slotFor } from './snake.js'

const key = (p: Pick) => `${p.overall}`

/**
 * Canonical draft state. Adapters push full snapshots; this diffs them.
 * Order-independent and idempotent, so a sensor that misses picks recovers
 * on its next poll with no reconciliation.
 */
export class DraftState {
  private picks = new Map<number, Pick>()
  private sources = new Map<number, string>()

  constructor(readonly teams: number) {}

  applySnapshot(incoming: Pick[], source = 'unknown'): Diff {
    const added: Pick[] = []
    const seen = new Set<number>()

    for (const raw of incoming) {
      const pick = this.normalise(raw)
      seen.add(pick.overall)
      const existing = this.picks.get(pick.overall)
      if (!existing) {
        this.picks.set(pick.overall, pick)
        this.sources.set(pick.overall, source)
        added.push(pick)
      } else if (existing.playerId !== pick.playerId) {
        // Manual entry is the human speaking; it outranks any automated feed.
        const owner = this.sources.get(pick.overall)
        if (source === 'manual' || owner !== 'manual') {
          this.picks.set(pick.overall, pick)
          this.sources.set(pick.overall, source)
          added.push(pick)
        }
      }
    }

    // A feed only retracts picks it owns, so a partial snapshot from one sensor
    // can never delete another sensor's picks.
    //
    // An empty snapshot retracts nothing at all. A sensor reporting no rows is
    // saying it cannot see the board — the tab closed, the draft room went away,
    // the page had not rendered yet — and that is not the same as saying the
    // board is empty. Without this, leaving the draft room at the end of a
    // Yahoo mock erased all 352 picks from the live session the moment the
    // extension pushed its last, empty capture: the log still held every pick,
    // so the draft was there on disk and gone from the screen, with no review.
    const removed: Pick[] = []
    if (!incoming.length) return { added, removed, changed: added.length > 0 }
    for (const [overall, pick] of this.picks) {
      if (seen.has(overall)) continue
      if (this.sources.get(overall) !== source) continue
      if (source === 'manual') continue
      this.picks.delete(overall)
      this.sources.delete(overall)
      removed.push(pick)
    }

    return { added, removed, changed: added.length > 0 || removed.length > 0 }
  }

  private normalise(p: Pick): Pick {
    const round = p.round || roundFor(p.overall, this.teams)
    const slot = p.slot || slotFor(p.overall, this.teams)
    return { ...p, round, slot, teamId: p.teamId || `slot-${slot}` }
  }

  /** Records one pick from the keyboard. Always available, never a mode. */
  recordManual(overall: number, playerId: PlayerId, teamId?: string): Diff {
    const slot = slotFor(overall, this.teams)
    return this.applySnapshot(
      [
        ...this.all().filter((p) => p.overall !== overall),
        { overall, round: roundFor(overall, this.teams), slot, teamId: teamId || `slot-${slot}`, playerId },
      ],
      'manual',
    )
  }

  undo(overall: number): boolean {
    const had = this.picks.delete(overall)
    this.sources.delete(overall)
    return had
  }

  all(): Pick[] {
    return [...this.picks.values()].sort((a, b) => a.overall - b.overall)
  }

  drafted(): Set<PlayerId> {
    return new Set([...this.picks.values()].map((p) => p.playerId))
  }

  bySlot(slot: number): Pick[] {
    return this.all().filter((p) => p.slot === slot)
  }

  /** Highest contiguous pick made, i.e. whose turn it is now. */
  /**
   * The pick the room is on.
   *
   * Picks are made in order, so a gap below the highest one seen is a capture
   * the sensor missed, not a pick still to come. Reading the first gap as the
   * present froze the board on the first miss: Yahoo rate-limited a mock into
   * ten holes, and the clock sat on pick 144 in round 8 while the draft ran on
   * to 236 and finished without it.
   */
  onTheClock(): number {
    return this.highest() + 1
  }

  /** Highest pick seen, 0 before any. */
  highest(): number {
    let max = 0
    for (const overall of this.picks.keys()) if (overall > max) max = overall
    return max
  }

  has(overall: number): boolean {
    return this.picks.has(overall)
  }

  count(): number {
    return this.picks.size
  }

  reset(): void {
    this.picks.clear()
    this.sources.clear()
  }
}
