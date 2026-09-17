/**
 * How often a player carrying an injury designation actually plays.
 *
 * The practice report used to be read through three hand-set buckets: did not
 * practise meant likely out, limited meant a coin flip, full meant likely to
 * play. Measured against 2025, the first of those was wrong more often than
 * right — of questionable skill players who had played the week before and did
 * not practise, 19 of 34 took the field. The report does separate them; it
 * separates them far less sharply than the buckets claimed.
 *
 * So the buckets are replaced with counts: ten regular seasons of nflverse
 * injury reports matched against snap counts, kept by designation, practice,
 * body part and position, and read at the most specific level that has enough
 * cases to mean anything. Every rate travels with its count, so "played 56%"
 * can always be read as "19 of 34".
 */
import { existsSync, readFileSync } from 'node:fs'

export type Designation = 'Out' | 'Doubtful' | 'Questionable' | 'none'
export type PracticeKind = 'DNP' | 'Limited' | 'Full' | 'none'
export type PosGroup = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DL' | 'LB' | 'DB'

export interface Cell { played: number; listed: number }

export interface PlayRates {
  seasons: [number, number]
  population: string
  method: string
  /** After the game status is set: "Questionable|DNP", "Questionable|DNP|body:rib", "…|pos:WR". */
  designated: Record<string, Cell>
  /** Before it is, by practice alone: "DNP", "DNP|body:rib", "DNP|pos:WR". */
  byPractice: Record<string, Cell>
}

export interface Rate {
  rate: number
  played: number
  listed: number
  /** What the count is of, in words: "questionable after not practising, rib injuries". */
  basis: string
  /** The seasons counted, where the caller knows them. */
  seasons?: [number, number]
}

export function designationOf(report: string): Designation {
  const r = report.trim().toLowerCase()
  if (r === 'out') return 'Out'
  if (r === 'doubtful') return 'Doubtful'
  if (r === 'questionable') return 'Questionable'
  return 'none'
}

export function practiceOf(practice: string): PracticeKind {
  const p = practice.trim().toLowerCase()
  if (p.startsWith('did not')) return 'DNP'
  if (p.startsWith('limited')) return 'Limited'
  if (p.startsWith('full')) return 'Full'
  return 'none'
}

const POS: Record<string, PosGroup> = {
  QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE', K: 'K', PK: 'K',
  DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', EDGE: 'DL',
  OLB: 'LB', ILB: 'LB', MLB: 'LB', LB: 'LB',
  CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB', DB: 'DB', SAF: 'DB',
}
/** Fantasy and IDP positions only; linemen, punters and snappers are not anyone's decision. */
export const posGroupOf = (position: string | null | undefined): PosGroup | null =>
  POS[String(position ?? '').trim().toUpperCase()] ?? null

const BODY: Record<string, string> = {
  ribs: 'rib', hamstrings: 'hamstring', quad: 'quadriceps', quads: 'quadriceps',
  quadricep: 'quadriceps', calves: 'calf', toes: 'toe', fingers: 'finger',
  'achilles tendon': 'achilles', abdominal: 'abdomen', abs: 'abdomen',
  pec: 'pectoral', pectorals: 'pectoral', obliques: 'oblique', shins: 'shin',
}

/**
 * One body part from whatever the report wrote. "Knee, Ankle" is filed under
 * its first injury, sides are dropped, plurals folded — a rib and ribs are one
 * question — and the three non-injuries kept apart, since a veteran's rest day
 * and a family matter say nothing about a rib.
 */
export function bodyOf(injury: string | null | undefined): string | null {
  let s = String(injury ?? '').toLowerCase().split(/[,/;]/)[0]
  if (/resting|\brest\b/.test(s)) return 'rest'
  if (/personal/.test(s)) return 'personal'
  if (/not injury related/.test(s)) return 'not injury related'
  s = s.replace(/\b(left|right|lower|upper)\b/g, '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return BODY[s] ?? s
}

/**
 * A name two files will agree on. Snap counts and injury reports are kept by
 * different processes, and "Kenneth Murray, Jr." in one is "Kenneth Murray" in
 * the other.
 */
export function nameKey(name: string): string {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[.'’,]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ').trim()
}

export type Rec = Record<string, string>

const bump = (t: Record<string, Cell>, key: string, played: boolean) => {
  const c = (t[key] ??= { played: 0, listed: 0 })
  c.listed++
  if (played) c.played++
}

/** Who took a snap, by club and week, read from a season of nflverse snap counts. */
export interface SnapIndex {
  tookSnap: (name: string, team: string, week: number) => boolean
  /** Whether the club's game that week is in the file at all — a bye, or a week not played yet, is not. */
  clubPlayed: (team: string, week: number) => boolean
}

/*
 * The snap file spells the Rams "LA"; the player index and the leagues say
 * "LAR". Everything else agrees.
 */
const SNAP_CLUB: Record<string, string> = { LAR: 'LA', JAC: 'JAX' }
const snapClub = (team: string) => SNAP_CLUB[team.toUpperCase()] ?? team.toUpperCase()

export function snapIndex(snaps: Rec[]): SnapIndex {
  // By club and week — and, for the names the two files spell differently, by
  // first initial and surname.
  const exact = new Map<string, Set<string>>()
  const initials = new Map<string, Map<string, number>>()
  for (const s of snaps) {
    if (s.game_type !== 'REG') continue
    const snapsTaken = (Number(s.offense_snaps) || 0) + (Number(s.defense_snaps) || 0) + (Number(s.st_snaps) || 0)
    if (snapsTaken <= 0) continue
    const tw = `${snapClub(s.team)}|${Number(s.week)}`
    const key = nameKey(s.player)
    ;(exact.get(tw) ?? exact.set(tw, new Set()).get(tw)!).add(key)
    const parts = key.split(' ')
    const ini = `${parts[0]?.[0] ?? ''} ${parts[parts.length - 1] ?? ''}`
    const m = initials.get(tw) ?? initials.set(tw, new Map()).get(tw)!
    m.set(ini, (m.get(ini) ?? 0) + 1)
  }
  return {
    tookSnap: (name, team, week) => {
      const tw = `${snapClub(team)}|${week}`
      const key = nameKey(name)
      if (exact.get(tw)?.has(key)) return true
      const parts = key.split(' ')
      // Only an unambiguous initial-and-surname match counts: Mike and Michael
      // Onwenu are one man, Cam and Mike Jackson are two.
      return initials.get(tw)?.get(`${parts[0]?.[0] ?? ''} ${parts[parts.length - 1] ?? ''}`) === 1
    },
    clubPlayed: (team, week) => exact.has(`${snapClub(team)}|${week}`),
  }
}

/**
 * One season's reports against that season's snap counts, added into `into`.
 *
 * Only players who took a snap in their club's previous game are counted. The
 * designation is a question about a man who has been playing; a player in his
 * return window from injured reserve practises fully and sits, and a backup a
 * club keeps inactive is listed and scratched for reasons that are not his
 * body. Both were dragging "questionable after a full week" down to 69%.
 */
export function countSeason(injuries: Rec[], snaps: Rec[], into: Pick<PlayRates, 'designated' | 'byPractice'>): void {
  const { tookSnap, clubPlayed } = snapIndex(snaps)

  for (const r of injuries) {
    if (r.game_type !== 'REG') continue
    const pos = posGroupOf(r.position)
    if (!pos) continue
    const week = Number(r.week)
    if (!clubPlayed(r.team, week)) continue
    // The club's previous game, looking through one bye.
    const prior = clubPlayed(r.team, week - 1) ? week - 1 : clubPlayed(r.team, week - 2) ? week - 2 : null
    if (prior == null || !tookSnap(r.full_name, r.team, prior)) continue

    const designation = designationOf(r.report_status ?? '')
    const practice = practiceOf(r.practice_status ?? '')
    if (designation === 'none' && practice === 'none') continue
    const body = bodyOf(r.report_primary_injury || r.practice_primary_injury)
    const played = tookSnap(r.full_name, r.team, week)

    const d = `${designation}|${practice}`
    bump(into.designated, d, played)
    bump(into.designated, `${d}|pos:${pos}`, played)
    if (body) bump(into.designated, `${d}|body:${body}`, played)
    bump(into.byPractice, practice, played)
    bump(into.byPractice, `${practice}|pos:${pos}`, played)
    if (body) bump(into.byPractice, `${practice}|body:${body}`, played)
  }
}

/*
 * The fewest cases a body part or a position needs before it is preferred to
 * the broader count above it. Thirty is a convention, not a finding: below it
 * a single player's week moves the rate by more than three points.
 */
export const MIN_CASES = 30

const PRACTICE_WORDS: Record<PracticeKind, string> = {
  DNP: 'not practising', Limited: 'limited practice', Full: 'a full week of practice', none: 'no practice listed',
}
/*
 * A rest day is not an injury, and "players whose week ended at not
 * practising, rest injuries" said it was. The three non-injuries get their own
 * words.
 */
const BODY_WORDS: Record<string, string> = {
  rest: 'rest days', personal: 'personal matters', illness: 'illness', 'not injury related': 'absences not from injury',
}
const bodyWords = (body: string) => BODY_WORDS[body] ?? `${body} injuries`

const POS_WORDS: Record<PosGroup, string> = {
  QB: 'quarterbacks', RB: 'running backs', WR: 'receivers', TE: 'tight ends', K: 'kickers',
  DL: 'defensive linemen', LB: 'linebackers', DB: 'defensive backs',
}

/**
 * The rate for one player's report, from the most specific count that has
 * enough cases: his body part, then his position, then everyone.
 *
 * `designation: 'pending'` is the middle of the week, before the club has set
 * a game status. There is no history of mid-week reports to measure, so the
 * nearest honest count is used — how players whose week ended at this practice
 * status fared — and the basis says so.
 */
export function playRate(
  rates: Pick<PlayRates, 'designated' | 'byPractice'>,
  q: { designation: Designation | 'pending'; practice: PracticeKind; pos: PosGroup | null; body: string | null },
  min = MIN_CASES,
): Rate | null {
  const pending = q.designation === 'pending'
  const table = pending ? rates.byPractice : rates.designated
  const base = pending ? q.practice : `${q.designation}|${q.practice}`
  const said = pending
    ? `players whose week ended at ${PRACTICE_WORDS[q.practice]}`
    : q.designation === 'none'
      ? `players with no game status after ${PRACTICE_WORDS[q.practice]}`
      : `${q.designation.toLowerCase()} after ${PRACTICE_WORDS[q.practice]}`
  const tries: [string, string, number][] = []
  if (q.body) tries.push([`${base}|body:${q.body}`, `${said}, ${bodyWords(q.body)}`, min])
  if (q.pos) tries.push([`${base}|pos:${q.pos}`, `${said}, ${POS_WORDS[q.pos]}`, min])
  tries.push([base, said, 1])
  for (const [key, basis, need] of tries) {
    const c = table[key]
    if (c && c.listed >= need) return { rate: c.played / c.listed, played: c.played, listed: c.listed, basis }
  }
  return null
}

/*
 * The three words the rest of the app still speaks, now read off a measured
 * rate rather than set by hand. A quarter and three quarters: "likely" should
 * mean something clearly more than even, and between the two is a genuine
 * coin flip. Round numbers, because nothing here was fitted to choose them.
 */
export const LIKELY_OUT_BELOW = 0.25
export const LIKELY_PLAYS_FROM = 0.75

export function severityOfRate(rate: number): 'likely-out' | 'coin-flip' | 'likely-plays' {
  return rate < LIKELY_OUT_BELOW ? 'likely-out' : rate >= LIKELY_PLAYS_FROM ? 'likely-plays' : 'coin-flip'
}

let loaded: PlayRates | null | undefined
/** The committed measurement, read once. Missing is survivable: the app falls back to no rate. */
export function loadPlayRates(file = 'data/play-rates.json'): PlayRates | null {
  if (loaded !== undefined) return loaded
  try {
    loaded = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as PlayRates) : null
  } catch {
    loaded = null
  }
  return loaded
}
