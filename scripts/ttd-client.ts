/**
 * TapThatDraft client. Config POSTs mint a permanent UUID URL; the board itself
 * is a lazily-hydrated Livewire component, so its __lazyLoad call is replayed
 * to get the rendered table.
 */
import type { Pos } from '../src/kernel/types.js'

const BASE = 'https://subvertadown.com'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

export interface BoardRow {
  name: string
  pos: Pos
  posRank: number
  team: string
  adp: number | null
  value: number
  overall: number
}

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

const strip = (s: string) =>
  decode(s.replace(/<!--.*?-->/gs, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

export class Session {
  private cookies = new Map<string, string>()
  private token: string | null = null

  private jar(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private absorb(res: Response) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';')
      const idx = pair.indexOf('=')
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
    }
  }

  async ensureToken(): Promise<string> {
    if (this.token) return this.token
    const res = await fetch(`${BASE}/tap-that-draft`, {
      headers: { 'User-Agent': UA, Cookie: this.jar() },
    })
    this.absorb(res)
    const html = await res.text()
    this.token = /name="_token"\s+value="([^"]+)"/.exec(html)![1]
    return this.token
  }

  async submit(fields: Record<string, string | number>) {
    const body = new URLSearchParams(
      Object.entries(fields).map(([k, v]) => [k, String(v)]),
    ).toString()
    const res = await fetch(`${BASE}/draft`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Cookie: this.jar(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${BASE}/tap-that-draft`,
      },
      body,
      redirect: 'follow',
    })
    this.absorb(res)
    return { html: await res.text(), url: res.url }
  }

  async hydrate(pageUrl: string, doc: string): Promise<string> {
    const snapshot = decode(/wire:snapshot="(.*?)"\s+wire:effects/s.exec(doc)![1])
    const payload = /__lazyLoad\(&#039;([A-Za-z0-9+/=]+)&#039;\)/.exec(doc)![1]
    const res = await fetch(`${BASE}/livewire/update`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Cookie: this.jar(),
        'Content-Type': 'application/json',
        'X-Livewire': 'true',
        Referer: pageUrl,
      },
      body: JSON.stringify({
        _token: await this.ensureToken(),
        components: [
          { snapshot, updates: {}, calls: [{ path: '', method: '__lazyLoad', params: [payload] }] },
        ],
      }),
    })
    const data = (await res.json()) as any
    return data.components[0].effects.html
  }
}

export interface SpecialRow {
  rank: number
  name: string
  team: string | null
  pos: 'K' | 'DST'
}

/**
 * Kickers and defenses live in their own component and never appear on the main
 * board, which is why they were missing from every league's rankings. The list
 * is short by design — Subvertadown's view is that only these are worth having,
 * and past them the choice is noise.
 */
export function parseSpecialTeams(html: string): SpecialRow[] {
  const clean = html.replace(/<!--\[if (BLOCK|ENDBLOCK)\]><!\[endif\]-->/g, '')
  const out: SpecialRow[] = []

  const table = (label: string, pos: 'K' | 'DST') => {
    const i = clean.indexOf(`>${label}<`)
    if (i < 0) return
    const tb = clean.indexOf('<tbody', i)
    const end = clean.indexOf('</tbody>', tb)
    if (tb < 0 || end < 0) return
    for (const r of clean.slice(tb, end).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const tds = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) =>
        decode(t[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
      )
      const rank = Number(tds[0])
      if (!rank || !tds[1]) continue
      // Defenses render as "Texans - HOU"; kickers are just a name.
      const m = /^(.*?)\s*-\s*([A-Z]{2,3})$/.exec(tds[1])
      out.push({
        rank,
        name: m ? m[1].trim() : tds[1],
        team: m ? m[2] : null,
        pos,
      })
    }
  }
  table('Kicker', 'K')
  table('D/ST', 'DST')
  return out
}

export function parseBoard(html: string): BoardRow[] {
  const rows: BoardRow[] = []
  const re = /<tr[^>]*data-draft-player-row[^>]*>(.*?)<\/tr>/gs
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const body = m[1]
    const name = /<a[^>]*class="sub-link"[^>]*>\s*(.*?)\s*<\/a>/s.exec(body)
    const rank = /data-window-position-rank="([A-Z]+)(\d+)"/.exec(body)
    // The trailing number is depth-chart order within the team, not a bye week.
    const team = />([A-Z]{2,3})-\d+<\/span>/.exec(body)
    const adp = /(\w+) ADP: &lt;strong&gt;([\d.]+)&lt;\/strong&gt;/.exec(body)
    if (!name || !rank) continue

    let value: number | null = null
    const cells = [...body.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => strip(c[1]))
    for (let i = cells.length - 1; i >= 0; i--) {
      if (/^-?\d+\.\d+$/.test(cells[i])) {
        value = Number(cells[i])
        break
      }
    }
    if (value === null) continue

    rows.push({
      name: strip(name[1]),
      pos: rank[1] as Pos,
      posRank: Number(rank[2]),
      team: team ? team[1] : '',
      adp: adp ? Number(adp[2]) : null,
      value,
      overall: rows.length + 1,
    })
  }
  return rows
}

const BASE_SCORING = {
  rec_tds: 6, rec_yards: 0.1, rec_first_downs: 0,
  pass_tds: 4, pass_yards: 0.04, pass_completions: 0,
  rush_tds: 6, rush_yards: 0.1, rush_attempts: 0, rush_first_downs: 0,
  fumbles: -2,
}

export function fieldsFor(league: any, token: string, override: Record<string, string | number> = {}) {
  const s = league.starters
  const flex = { qb_wr_rb_te_count: 0, wr_rb_te_count: 0, wr_te_count: 0, wr_rb_count: 0 }
  for (const f of league.flex ?? []) {
    const set = new Set<string>(f.eligible)
    if (set.has('QB')) flex.qb_wr_rb_te_count += f.count
    else if (set.has('RB') && set.has('WR') && set.has('TE')) flex.wr_rb_te_count += f.count
    else if (set.has('WR') && set.has('TE')) flex.wr_te_count += f.count
    else if (set.has('RB') && set.has('WR')) flex.wr_rb_count += f.count
  }
  return {
    _token: token, user_id: '', mode: 'draft', is_auction: 0,
    team_count: league.teams, bench_count: league.benchSize, budget: 200,
    adp_platform: league.platform === 'sleeper' ? 'sleeper' : 'yahoo',
    qb_count: s.QB ?? 0, rb_count: s.RB ?? 0, wr_count: s.WR ?? 0, te_count: s.TE ?? 0,
    k_count: s.K ?? 0, dst_count: s.DST ?? 0,
    ...flex,
    ...BASE_SCORING,
    receptions: league.scoring.rec ?? 0,
    pass_ints: league.scoring.pass_int ?? -2,
    default_valuation: 'beer_plus',
    qb_max: 10, rb_max: 10, wr_max: 10, te_max: 10,
    qb_val_boost_percent: 0, rb_val_boost_percent: 0,
    wr_val_boost_percent: 0, te_val_boost_percent: 0,
    te_premium: 0, qb_streaming: 0,
    destination: 'draft_room',
    ...override,
  }
}

const shared = new Session()

export async function fetchBoard(
  league: any,
  override: Record<string, string | number> = {},
): Promise<BoardRow[]> {
  const token = await shared.ensureToken()
  const { html, url } = await shared.submit(fieldsFor(league, token, override))
  return parseBoard(await shared.hydrate(url, html))
}

export async function fetchBoardWithUrl(
  league: any,
  override: Record<string, string | number> = {},
): Promise<{ rows: BoardRow[]; special: SpecialRow[]; url: string }> {
  const token = await shared.ensureToken()
  const { html, url } = await shared.submit(fieldsFor(league, token, override))
  const rendered = await shared.hydrate(url, html)
  return { rows: parseBoard(rendered), special: parseSpecialTeams(rendered), url }
}
