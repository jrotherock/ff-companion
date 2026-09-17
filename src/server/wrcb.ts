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
 * Only the prose is read here, not the chart. The chart is four PNG
 * screenshots of a spreadsheet — the numbers exist as pixels and nowhere else —
 * and an OCR pass whose misreadings would be silent has no business deciding a
 * lineup. The prose names six to ten receivers a week with a paragraph of
 * reasoning each, written by someone who looked at the chart. That is a
 * smaller claim honestly come by, and it lands on exactly the players a close
 * call is about.
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
  /** Why, in their words — the first paragraph or two, not the whole essay. */
  why: string
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
    const paras = [...seg.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    let current: Matchup | null = null
    for (const p of paras) {
      const inner = p[1].trim()
      const bold = /^<strong[^>]*>([\s\S]*)<\/strong>$/i.exec(inner)
      if (bold && /\bvs\.?\b/i.test(text(bold[1]))) {
        const pair = pairOf(bold[1])
        if (pair) {
          current = { ...pair, side, why: '' }
          out.push(current)
        }
        continue
      }
      if (!current) continue
      // An image on its own line is the player's row from the chart: a picture
      // of the numbers, which is no use in a sentence.
      const said = text(inner)
      if (!said || /^\s*$/.test(said)) continue
      if (current.why.length < 400) current.why = current.why ? `${current.why} ${said}` : said
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
