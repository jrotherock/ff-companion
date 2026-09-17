import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { statePath } from './paths.js'

/**
 * Which receivers the week's coverage matchup favours, and which it does not.
 *
 * RotoBaller publishes a weekly WR/CB column: a chart of every receiver against
 * the cornerback projected to cover him, scored on targets, yards and fantasy
 * points per route run for the receiver against the same allowed by the corner.
 * It is the best free answer to a question the app cannot currently ask — the
 * one thing a projection, a consensus rank and a defence-versus-position rank
 * all miss, which is *who* is going to be standing across from him.
 *
 * Only the verdicts are read — who, against whom, and which way — not the chart
 * and not the reasoning. The chart is four PNG screenshots of a spreadsheet:
 * the numbers exist as pixels and nowhere else, and an OCR pass whose
 * misreadings would be silent has no business deciding a lineup. The reasoning
 * is several paragraphs of RotoBaller's own analysis per receiver, theirs to
 * publish and one click away. Copying it in also meant deciding where each
 * entry's prose ended, and in week two a subscription promo sat inside the
 * downgrades section with only a length cap keeping it out of the last
 * receiver's write-up. A verdict and a link has no such edge.
 *
 * Nothing here decides anything on its own: it is one more voice in a split
 * call, and it says who said it.
 */

/** Rate-limited to nothing in particular, but their server, so: not often. */
const MAX_AGE = 6 * 3600000
/** How long to remember that this week's column is not up yet. */
const MISSING_AGE = 60 * 60000
/*
 * A browser's user agent. Asked for as a plain script the article body comes
 * back as navigation furniture and nothing else, which reads as a page that
 * failed to load rather than a page that refused.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

export interface Matchup {
  /** The receiver, as the column spells him. */
  receiver: string
  /** The cornerback projected to cover him. */
  corner: string
  /** Which way it cuts. */
  side: 'upgrade' | 'downgrade'
}

export interface WrCb {
  season: number
  week: number
  matchups: Matchup[]
  /** Where it came from, so the UI can credit it and you can go and read it. */
  link: string | null
  note: string
}

/**
 * Tags out, entities in. Numeric entities are handled generally rather than by
 * a list: the column is full of names like Wan'Dale and Ja'Marr, and a curly
 * apostrophe left as &#8217; would fail every match against a player index.
 */
export function text(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The slice of the article between one section heading and the next. */
function section(html: string, id: RegExp): string {
  const m = id.exec(html)
  if (!m) return ''
  const from = m.index
  const next = /<h[12][\s>]/i.exec(html.slice(from + m[0].length))
  return next ? html.slice(from, from + m[0].length + next.index) : html.slice(from)
}

/**
 * The receiver and corner out of one heading paragraph.
 *
 * The receiver is usually a link into their player database and the corner is
 * usually plain text, which is tempting to lean on and wrong to: some weeks
 * the corner is linked too, and some weeks the receiver is not. Splitting on
 * the "vs." that is always between them holds either way.
 */
export function pairOf(heading: string): { receiver: string; corner: string } | null {
  const said = text(heading)
  const m = /^(.+?)\s+vs\.?\s+(.+?)$/i.exec(said)
  if (!m) return null
  const receiver = m[1].trim()
  const corner = m[2].trim().replace(/[,:;]$/, '')
  if (!receiver || !corner) return null
  return { receiver, corner }
}

/**
 * Every named matchup in the column.
 *
 * A heading is a paragraph whose whole content is bold and which says "vs" —
 * bold alone would pick up every emphasised phrase in the body copy, and "vs"
 * alone would pick up a sentence about last week's game.
 */
export function parseMatchups(html: string): Matchup[] {
  const out: Matchup[] = []
  for (const side of ['upgrade', 'downgrade'] as const) {
    const word = side === 'upgrade' ? 'Upgrades' : 'Downgrades'
    const seg = section(html, new RegExp(`id="Week_\\d+_WRCB_Matchup_${word}"`, 'i'))
    if (!seg) continue
    for (const p of seg.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      const bold = /^<strong[^>]*>([\s\S]*)<\/strong>$/i.exec(p[1].trim())
      if (!bold || !/\bvs\.?\b/i.test(text(bold[1]))) continue
      const pair = pairOf(bold[1])
      if (pair) out.push({ ...pair, side })
    }
  }
  return out
}

/**
 * This week's column, if it has run yet.
 *
 * The article URL ends in an opaque post id, so it cannot be built from the
 * week — it has to be found. WordPress's own index answers that directly,
 * which beats scraping a listing page that is mostly advertising.
 */
export async function findArticle(
  season: number,
  week: number,
  get: typeof fetch = fetch,
): Promise<string | null> {
  const q = 'https://www.rotoballer.com/wp-json/wp/v2/posts' +
    '?search=WR%2FCB%20Matchups&per_page=10&_fields=link,title'
  const res = await get(q, { headers: { 'user-agent': UA } })
  if (!res.ok) return null
  const posts = (await res.json()) as { link?: string; title?: { rendered?: string } }[]
  if (!Array.isArray(posts)) return null
  /*
   * Matched on the title rather than the slug. Both carry the week and the
   * season, but the slug has said "sleepers-targets" some weeks and not
   * others, and a column that renames its own URL should not go unread.
   */
  const want = new RegExp(`WR/CB Matchups\\b[\\s\\S]*\\bWeek ${week}\\b[\\s\\S]*\\(${season}\\)`, 'i')
  for (const p of posts) {
    const title = text(p.title?.rendered ?? '')
    if (p.link && want.test(title)) return p.link
  }
  return null
}

/**
 * One receiver's row from the WR/CB chart.
 *
 * The per-route rates behind each adjusted score are left on the chart: the
 * score is the decision and the two adjusted numbers are its explanation, and
 * copying their spreadsheet in full is not what this is for.
 */
export interface ChartRow {
  receiver: string
  team: string
  /** The receiver's adjusted offence score. */
  offence: number
  /** The cornerback projected to cover him. */
  corner: string
  cornerTeam: string
  /** The corner's adjusted defence score. */
  defence: number
  /** Offence minus defence. Positive favours the receiver. */
  score: number
  /** Printed bold: the receiver works from the slot. */
  slot: boolean
  /** Printed in red. */
  receiverHurt: boolean
  cornerHurt: boolean
  /** Printed magenta: a safety by roster, covering the slot. */
  safety: boolean
}

export interface Chart {
  season: number
  week: number
  link: string | null
  rows: ChartRow[]
}

/**
 * Whether a row's numbers agree with each other.
 *
 * The chart prints the score as offence minus defence, and every value is
 * rounded to the hundredth on its own — so an honest row can miss by up to a
 * hundredth and a half, and in week two the worst of 99 missed by exactly one.
 * A misread tenths or units digit anywhere in the three breaks the equation.
 * That is what makes a transcription of four screenshots something to check
 * row by row rather than take on faith: a slip in the last digit can still
 * hide inside the rounding, and changes nothing a lineup turns on.
 */
export function consistent(r: Pick<ChartRow, 'offence' | 'defence' | 'score'>): boolean {
  return Math.abs(r.offence - r.defence - r.score) <= 0.0151
}

/**
 * Rows read off the chart, one per line: receiver, team, the three rates,
 * offence, corner, corner's team, the three allowed rates, defence, score, and
 * flags — s slot, i receiver hurt, j corner hurt, m safety in the slot.
 */
export function chartRowsFromText(text: string): ChartRow[] {
  const out: ChartRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const f = line.split('|')
    if (f.length !== 14) throw new Error(`expected 14 fields, found ${f.length}: ${line}`)
    const num = (i: number) => {
      const v = Number(f[i])
      if (!Number.isFinite(v)) throw new Error(`field ${i + 1} is not a number: ${line}`)
      return v
    }
    const flags = f[13]
    out.push({
      receiver: f[0].trim(), team: f[1].trim(), offence: num(5),
      corner: f[6].trim(), cornerTeam: f[7].trim(), defence: num(11), score: num(12),
      slot: flags.includes('s'), receiverHurt: flags.includes('i'),
      cornerHurt: flags.includes('j'), safety: flags.includes('m'),
    })
  }
  return out
}

/**
 * The row to believe for a receiver the chart lists more than once.
 *
 * Week two listed Romeo Doubs against both Joey Porter Jr. and Asante Samuel
 * Jr., with Porter marked injured: the chart hedging on who plays. The corner
 * expected to be on the field is the matchup to read, and where both are, the
 * chart's own first choice.
 */
export function likeliest(rows: ChartRow[]): ChartRow | null {
  return rows.find((r) => !r.cornerHurt) ?? rows[0] ?? null
}

/**
 * The week's chart, if one has been read in.
 *
 * Nothing is fetched here. The chart is four screenshots, and turning pixels
 * into rows happens elsewhere and arrives as a file in the state directory —
 * never the repository, since the same chart is sold as a premium tool. What
 * this does is refuse any row whose numbers disagree with each other, whoever
 * wrote it down.
 */
export function chartFor(season: number, week: number): { chart: Chart | null; note: string } {
  const file = statePath(`wrcb-chart-${season}-${week}.json`)
  if (!existsSync(file)) return { chart: null, note: `no WR/CB chart read in for week ${week}` }
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as Chart
    const all = Array.isArray(c.rows) ? c.rows : []
    const rows = all.filter(consistent)
    const refused = all.length - rows.length
    return {
      chart: { season, week, link: c.link ?? null, rows },
      note: `${rows.length} rows from RotoBaller's chart${refused ? `, ${refused} refused as inconsistent` : ''}`,
    }
  } catch (e) {
    return { chart: null, note: `the week ${week} chart file is unreadable: ${(e as Error).message}` }
  }
}

export async function wrcbFor(
  season: number,
  week: number,
  get: typeof fetch = fetch,
): Promise<WrCb> {
  const cache = statePath(`wrcb-${season}-${week}.json`)
  if (existsSync(cache)) {
    try {
      const c = JSON.parse(readFileSync(cache, 'utf8')) as WrCb & { at: number; missing?: boolean }
      if (Date.now() - c.at < (c.missing ? MISSING_AGE : MAX_AGE)) return c
    } catch { /* fall through and refetch */ }
  }
  const miss = (note: string): WrCb => {
    const v = { season, week, matchups: [], link: null, note }
    try { writeFileSync(cache, JSON.stringify({ ...v, at: Date.now(), missing: true })) } catch { /* cache is a nicety */ }
    return v
  }
  try {
    const link = await findArticle(season, week, get)
    if (!link) return miss(`no WR/CB column for week ${week} yet`)
    const res = await get(link, { headers: { 'user-agent': UA } })
    if (!res.ok) return miss(`RotoBaller answered ${res.status}`)
    const matchups = parseMatchups(await res.text())
    /*
     * An empty parse is reported as a miss rather than as a column with
     * nothing in it. The two look identical from the outside and only one of
     * them means the page has been rebuilt under us.
     */
    if (!matchups.length) return miss('found the column but read nothing from it')
    const v: WrCb = { season, week, matchups, link, note: `${matchups.length} from RotoBaller` }
    try { writeFileSync(cache, JSON.stringify({ ...v, at: Date.now() })) } catch { /* cache is a nicety */ }
    return v
  } catch (e) {
    return miss(`could not reach RotoBaller: ${(e as Error).message}`)
  }
}
