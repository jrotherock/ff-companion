import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import type { LeagueConfig, Ranking } from '../kernel/types.js'
import { statePath } from './paths.js'

/**
 * A draft is only replayable if the board it was drafted against is kept with
 * it. Rankings are refetched through the preseason, so evaluating an August
 * mock against a September board would score every decision against players
 * nobody could have seen — confidently and wrongly.
 *
 * So each draft gets a manifest entry and a frozen copy of its rankings.
 */

const DIR = statePath('drafts')
const MANIFEST = `${DIR}/manifest.json`

export interface DraftRecord {
  /** Stable key: one per actual draft, never reused. */
  key: string
  leagueId: string
  leagueLabel: string
  platform: string
  /** Platform draft id where there is one; Yahoo leagues use the league id. */
  draftId: string | null
  mock: boolean
  teams: number
  rounds: number
  mySlot: number | null
  startedAt: number
  updatedAt: number
  picks: number
  complete: boolean
  /** Rankings frozen at the moment the draft was first seen. */
  rankingsFile: string
  /**
   * Kept but not analysed. Autodraft turns picks into someone else's decisions,
   * and the whole review rests on every pick being a choice — one autodrafted
   * draft can hand the playbook a recommendation built on a pick you never made.
   */
  excluded?: boolean
  excludedReason?: string
}

type Manifest = Record<string, DraftRecord>

function load(): Manifest {
  if (!existsSync(MANIFEST)) return {}
  try {
    return JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest
  } catch {
    return {}
  }
}

function save(m: Manifest): void {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(MANIFEST, JSON.stringify(m, null, 1) + '\n')
}

/** One key per draft. Yahoo has no draft id, so its league id serves. */
export function draftKey(league: LeagueConfig): string {
  const id = league.draftId ?? (league as any).leagueId ?? league.id
  return `${league.id}-${id}`
}

/**
 * Records the draft if new, and freezes its rankings. Safe to call on every
 * update — only the counters move after the first time.
 */
export function record(
  league: LeagueConfig,
  opts: { picks: number; complete: boolean; mock: boolean },
): DraftRecord {
  const m = load()
  const key = draftKey(league)
  const now = Date.now()
  const existing = m[key]

  if (!existing) {
    mkdirSync(DIR, { recursive: true })
    const source = `data/rankings-${league.id}.json`
    const frozen = `${DIR}/rankings-${key}.json`
    if (existsSync(source) && !existsSync(frozen)) {
      writeFileSync(frozen, readFileSync(source, 'utf8'))
    }
    m[key] = {
      key,
      leagueId: league.id,
      leagueLabel: league.label,
      platform: league.platform,
      draftId: league.draftId ?? null,
      mock: opts.mock,
      teams: league.teams,
      rounds: league.rounds,
      mySlot: league.mySlot,
      startedAt: now,
      updatedAt: now,
      picks: opts.picks,
      complete: opts.complete,
      rankingsFile: frozen,
    }
  } else {
    existing.updatedAt = now
    existing.picks = opts.picks
    existing.complete = opts.complete
    existing.mySlot = league.mySlot
    // Team count can be corrected mid-draft once the sensor sees a full round.
    existing.teams = league.teams
    existing.rounds = league.rounds
  }
  save(m)
  return m[key]
}

export function list(): DraftRecord[] {
  return Object.values(load()).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function get(key: string): DraftRecord | null {
  return load()[key] ?? null
}

/** The board as it stood for this draft, not as it stands now. */
export function rankingsFor(rec: DraftRecord): Ranking[] {
  const path = existsSync(rec.rankingsFile)
    ? rec.rankingsFile
    : `data/rankings-${rec.leagueId}.json`
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, 'utf8')) as { rankings: Ranking[] }).rankings
}

/** Picks out of a draft's own log, in order. */
export function picksFor(rec: DraftRecord): { overall: number; playerId: string; slot: number; round: number; at: number }[] {
  const candidates = [
    `fixtures/log-${rec.leagueId}-${rec.draftId}.jsonl`,
    `fixtures/log-${rec.leagueId}.jsonl`,
  ]
  const path = candidates.find((p) => existsSync(p))
  if (!path) return []

  const byOverall = new Map<number, any>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e.t === 'pick') byOverall.set(e.pick.overall, { ...e.pick, at: e.at })
      else if (e.t === 'undo') byOverall.delete(e.overall)
      else if (e.t === 'reset') byOverall.clear()
    } catch {
      // A torn final line is expected if the process died mid-write.
    }
  }
  return [...byOverall.values()].sort((a, b) => a.overall - b.overall)
}

/** Drafts with enough picks to be worth analysing. */
export function analysable(minPicks = 20): DraftRecord[] {
  return list().filter((r) => r.picks >= minPicks && r.mySlot != null && !r.excluded)
}

/** Marks a draft as not reflecting your decisions, or restores it. */
export function setExcluded(key: string, excluded: boolean, reason?: string): DraftRecord | null {
  const m = load()
  const rec = m[key]
  if (!rec) return null
  rec.excluded = excluded
  rec.excludedReason = excluded ? reason || 'not my decisions' : undefined
  save(m)
  return rec
}

export function orphanLogs(): string[] {
  if (!existsSync('fixtures')) return []
  const known = new Set(list().flatMap((r) => [`log-${r.leagueId}-${r.draftId}.jsonl`]))
  return readdirSync('fixtures').filter((f) => f.startsWith('log-') && !known.has(f))
}
