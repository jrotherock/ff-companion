import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Pick } from '../kernel/types.js'

type Entry =
  | { t: 'pick'; at: number; source: string; pick: Pick }
  | { t: 'undo'; at: number; overall: number }
  | { t: 'slot'; at: number; slot: number | null }
  | { t: 'reset'; at: number }

/**
 * Append-only log so a crashed or restarted process replays instantly instead
 * of waiting on the next adapter poll.
 */
export class DraftLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
  }

  append(entry: Entry): void {
    appendFileSync(this.path, JSON.stringify(entry) + '\n')
  }

  read(): Entry[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Entry]
        } catch {
          // A torn final line from a hard kill must not block recovery.
          return []
        }
      })
  }

  /** Replays the log into the picks and slot it implies. */
  replay(): { picks: Pick[]; slot: number | null } {
    const byOverall = new Map<number, Pick>()
    let slot: number | null = null
    for (const e of this.read()) {
      if (e.t === 'pick') byOverall.set(e.pick.overall, e.pick)
      else if (e.t === 'undo') byOverall.delete(e.overall)
      // A cleared slot has to be recorded too, or the old one comes back on the
      // next restart and every survival number is silently wrong again.
      else if (e.t === 'slot') slot = e.slot
      else if (e.t === 'reset') byOverall.clear()
    }
    return { picks: [...byOverall.values()].sort((a, b) => a.overall - b.overall), slot }
  }
}
