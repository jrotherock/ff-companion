/**
 * General football news, which no amount of diffing a player map will produce.
 *
 * The structured feeds answer "what changed about a player". They cannot answer
 * "a team just set its fifty-three and three of your targets were cut", which
 * is the kind of thing a person actually reads on a Sunday. That needs prose,
 * and prose means someone else's newsroom.
 *
 * Treated as untrusted text throughout: shown with its source and time, matched
 * to your players only by name, and never allowed to move a number or fire a
 * notification.
 */
import type { Player, PlayerId } from '../kernel/types.js'

const FEEDS = [
  { id: 'pft', name: 'Pro Football Talk', url: 'https://profootballtalk.nbcsports.com/feed/' },
]

/**
 * Newsrooms write "Cowboys", the player map says "DAL". Without the bridge a
 * headline about a club can never be matched to a player on it, which is most
 * of what makes the wire useful.
 */
export const CLUB: Record<string, string> = {
  ARI: 'Cardinals', ATL: 'Falcons', BAL: 'Ravens', BUF: 'Bills', CAR: 'Panthers',
  CHI: 'Bears', CIN: 'Bengals', CLE: 'Browns', DAL: 'Cowboys', DEN: 'Broncos',
  DET: 'Lions', GB: 'Packers', HOU: 'Texans', IND: 'Colts', JAX: 'Jaguars',
  KC: 'Chiefs', LAC: 'Chargers', LAR: 'Rams', LV: 'Raiders', MIA: 'Dolphins',
  MIN: 'Vikings', NE: 'Patriots', NO: 'Saints', NYG: 'Giants', NYJ: 'Jets',
  PHI: 'Eagles', PIT: 'Steelers', SEA: 'Seahawks', SF: '49ers', TB: 'Buccaneers',
  TEN: 'Titans', WAS: 'Commanders',
}

export interface WireItem {
  id: string
  title: string
  summary: string
  at: number
  source: string
  link: string
  /** Your players named in the headline, which is what makes it worth showing. */
  mentions: { id: PlayerId; name: string; leagues: string[] }[]
}

function field(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  if (!m) return ''
  return m[1]
    .replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&#8217;/g, '’').replace(/&quot;/g, '"')
    .trim()
}

export async function fetchWire(opts: {
  players: Map<PlayerId, Player>
  /** leagueId -> the players you hold there. */
  rosters: { leagueId: string; label: string; mine: Set<PlayerId> }[]
  limit?: number
}): Promise<{ items: WireItem[]; sources: string[]; failed: string[] }> {
  const items: WireItem[] = []
  const sources: string[] = []
  const failed: string[] = []

  // Index by surname so a headline can be matched without a full-name parse.
  const byName: { id: PlayerId; name: string; last: string }[] = []
  for (const [id, p] of opts.players) {
    if (!p.team || !['QB', 'RB', 'WR', 'TE'].includes(p.pos)) continue
    byName.push({ id, name: p.name, last: p.name.split(' ').slice(-1)[0] })
  }

  for (const f of FEEDS) {
    try {
      const res = await fetch(f.url, {
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 (fantasy cockpit, personal use)' },
      })
      if (!res.ok) { failed.push(f.name); continue }
      const xml = await res.text()
      sources.push(f.name)
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const block = m[1]
        const title = field(block, 'title')
        if (!title) continue
        const when = Date.parse(field(block, 'pubDate'))
        const hay = `${title} ${field(block, 'description')}`
        const mentions: WireItem['mentions'] = []
        for (const p of byName) {
          // Full name first, then surname — a surname alone is too loose to
          // trust on its own, so it only counts when the first name is there.
          if (!hay.includes(p.name)) continue
          const leagues = opts.rosters.filter((r) => r.mine.has(p.id)).map((r) => r.leagueId)
          mentions.push({ id: p.id, name: p.name, leagues })
        }
        items.push({
          id: `w-${f.id}-${field(block, 'guid') || title.slice(0, 40)}`,
          title,
          summary: field(block, 'description').slice(0, 220),
          at: Number.isFinite(when) ? when : Date.now(),
          source: f.name,
          link: field(block, 'link'),
          mentions,
        })
      }
    } catch {
      failed.push(f.name)
    }
  }

  // Anything naming one of your players leads; the rest stays in date order.
  items.sort((a, b) => {
    const am = a.mentions.some((x) => x.leagues.length) ? 2 : a.mentions.length ? 1 : 0
    const bm = b.mentions.some((x) => x.leagues.length) ? 2 : b.mentions.length ? 1 : 0
    return bm - am || b.at - a.at
  })
  return { items: items.slice(0, opts.limit ?? 30), sources, failed }
}
