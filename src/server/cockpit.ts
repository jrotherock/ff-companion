/**
 * The cockpit: four leagues on one surface, sorted by whether they need you.
 *
 * The draft companion answers "who do I take" for one league at a time. This
 * answers the question that only exists when you hold several — "which of these
 * needs me right now, and which can I leave alone" — which no platform can
 * answer, because each of them knows about exactly one of your leagues.
 */
import { readFileSync, statSync, existsSync } from 'node:fs'
import type { LeagueConfig, Player, PlayerId } from '../kernel/types.js'
import { rosterFor } from './yahooRoster.js'
import { weekGames } from './schedule.js'
import { weeklyProjections, projFor } from './projections.js'

/** Ordered worst-first: the tile at the top is the one to open. */
export type Urgency = 'act' | 'soon' | 'watch' | 'quiet' | 'blocked'

export interface Tile {
  id: string
  label: string
  platform: string
  format: string
  teams: number
  urgency: Urgency
  /** The single sentence worth reading on the card. */
  why: string
  /** Short verb for the pill. */
  action: string
  /** Milliseconds since this league's data was last known good, or null. */
  freshMs: number | null
  /** Set while the league is still counting down to its draft. */
  draft: { at: string; inMs: number; slotSet: boolean; boardAgeMs: number | null } | null
  /** Why this league cannot report yet, when it cannot. */
  blocked: string | null
  phase: 'pre-draft' | 'drafting' | 'live' | 'in-season' | 'complete'
  /**
   * Where the week stands while it is being played.
   *
   * The sentence already says it — "Trailing 6.6" — but five cards of prose
   * all read the same from across the room, which is the one thing a home
   * screen has to get right. The margin is carried as a number so the card can
   * colour it rather than parse its own sentence back out.
   *
   * `theirs` is null in a league that states no opponent, and then there is no
   * margin to show: a total is not a scoreline.
   */
  score: {
    mine: number; theirs: number | null; margin: number | null
    /**
     * What is left of the week, as a sentence that stands on its own.
     *
     * The tile's prose leads with the margin — "Trailing 6.8 · 1 playing" —
     * which is right while the margin is written only once. A card that also
     * shows it in large type would be saying the same number twice, and
     * wrapping to a second line to do it. So the half that is not the number
     * travels separately.
     */
    note: string
    /**
     * How the men who have finished did against what they were projected.
     *
     * A live total on its own says nothing: four points is either a disaster
     * or a man who has touched the ball twice. Comparing it to the week's
     * projection is worse, because it compares four to a hundred. The only
     * honest reading is over the players who are actually done, where both
     * numbers are known and nothing has to be estimated.
     *
     * Null until somebody has finished, or where no projection survives to
     * measure them against.
     */
    pace: { done: number; of: number; got: number; due: number } | null
  } | null
}

const HOUR = 3600000
const DAY = 24 * HOUR

function boardAge(leagueId: string): number | null {
  const p = `data/rankings-${leagueId}.json`
  if (!existsSync(p)) return null
  try {
    const { fetchedAt } = JSON.parse(readFileSync(p, 'utf8')) as { fetchedAt?: string }
    return fetchedAt ? Date.now() - new Date(fetchedAt).getTime() : Date.now() - statSync(p).mtimeMs
  } catch {
    return null
  }
}

export function humanIn(ms: number): string {
  if (ms < 0) return 'now'
  if (ms < HOUR) return `${Math.round(ms / 60000)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${Math.round((ms % HOUR) / 60000)}m`
  return `${Math.round(ms / DAY)}d`
}

/**
 * Sleeper serves rosters to anyone holding the league id, so this needs no
 * credentials. Before a draft the rosters exist but hold no players, which is
 * reported as such rather than dressed up as an empty lineup.
 */
/**
 * Everyone's roster, not just yours — which is what makes a free agent
 * knowable. Without it the app cannot tell an opportunity from a fact.
 */
export async function sleeperLeagueRosters(
  leagueKey: string,
  userId: string,
): Promise<{ mine: PlayerId[]; starters: PlayerId[]; taken: Set<PlayerId>; owners: Map<PlayerId, string> } | null> {
  try {
    const res = await fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`)
    if (!res.ok) return null
    const rosters = (await res.json()) as any[]
    const taken = new Set<PlayerId>()
    const owners = new Map<PlayerId, string>()
    let mine: PlayerId[] = []
    let starters: PlayerId[] = []
    for (const r of rosters) {
      for (const id of r.players ?? []) {
        if (!id) continue
        taken.add(id)
        owners.set(id, String(r.owner_id ?? r.roster_id))
      }
      if (r.owner_id === userId) {
        mine = (r.players ?? []).filter(Boolean)
        starters = (r.starters ?? []).filter((p: string) => p && p !== '0')
      }
    }
    return { mine, starters, taken, owners }
  } catch {
    return null
  }
}

/**
 * This week's matchup, with both lineups.
 *
 * Sleeper serves no projections, so nothing here invents a score. What it can
 * say is which side the board rates higher, which is a real comparison as long
 * as it is labelled as one — value over replacement, not points.
 */
export async function sleeperMatchup(
  leagueKey: string,
  userId: string,
  week: number,
): Promise<{
  week: number
  mine: PlayerId[]
  theirs: PlayerId[]
  opponent: string
  livePoints: { mine: number; theirs: number }
  /** Per-player points, so a row can show what a man actually scored. */
  scored: Record<string, number>
} | null> {
  try {
    const [rosters, users, board] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/users`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/matchups/${week}`).then((r) => r.json()),
    ])
    if (!Array.isArray(board) || !board.length) return null
    const me = (rosters as any[]).find((r) => r.owner_id === userId)
    if (!me) return null
    const mineEntry = board.find((b: any) => b.roster_id === me.roster_id)
    if (!mineEntry) return null
    const theirEntry = board.find(
      (b: any) => b.matchup_id === mineEntry.matchup_id && b.roster_id !== me.roster_id,
    )
    const theirRoster = theirEntry
      ? (rosters as any[]).find((r) => r.roster_id === theirEntry.roster_id)
      : null
    const owner = theirRoster
      ? (users as any[]).find((u) => u.user_id === theirRoster.owner_id)
      : null
    return {
      week,
      mine: (mineEntry.starters ?? []).filter((p: string) => p && p !== '0'),
      theirs: (theirEntry?.starters ?? []).filter((p: string) => p && p !== '0'),
      opponent: owner?.metadata?.team_name || owner?.display_name || 'your opponent',
      livePoints: { mine: mineEntry.points ?? 0, theirs: theirEntry?.points ?? 0 },
      scored: {
        ...(mineEntry.players_points ?? {}),
        ...(theirEntry?.players_points ?? {}),
      },
    }
  } catch {
    return null
  }
}

export async function sleeperRoster(
  leagueKey: string,
  userId: string,
): Promise<{ players: PlayerId[]; starters: PlayerId[]; ok: boolean } | null> {
  try {
    const res = await fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`)
    if (!res.ok) return null
    const rosters = (await res.json()) as any[]
    const mine = rosters.find((r) => r.owner_id === userId)
    if (!mine) return null
    return {
      players: (mine.players ?? []).filter(Boolean),
      starters: (mine.starters ?? []).filter((p: string) => p && p !== '0'),
      ok: true,
    }
  } catch {
    return null
  }
}

function formatOf(l: LeagueConfig): string {
  const rec = l.scoring?.rec ?? 0
  const ppr = rec >= 1 ? 'PPR' : rec > 0 ? `${rec} PPR` : 'Standard'
  const idp = ['DB', 'DL', 'LB'].some((p) => (l.starters as any)[p])
  const wr = (l.starters as any).WR ?? 0
  const bits = [ppr]
  if (l.teams >= 16) bits.push('Guillotine')
  if (idp) bits.push('IDP')
  if (wr >= 3) bits.push('3 WR')
  return bits.join(' · ')
}

const RANK: Record<Urgency, number> = { act: 0, soon: 1, watch: 2, blocked: 3, quiet: 4 }

/**
 * A league is urgent when something will go wrong if you do not act, and the
 * clock decides how loudly. A draft counting down outranks everything else,
 * because it is the only deadline in fantasy football you cannot recover from.
 */
/**
 * Starters carrying something, worst first.
 *
 * This existed for Sleeper leagues and not for Yahoo ones, so a Yahoo tile read
 * "Nothing to do · 15 rostered, 9 starting" beside a red dot for a doubtful
 * tight end — the dot said one thing and the sentence under it said the
 * opposite, and the sentence is the part people read.
 */
const DESIGNATION_RANK: Record<string, number> = {
  OUT: 5, IR: 5, PUP: 5, NFI: 5, SUSPENDED: 5, DOUBTFUL: 4, QUESTIONABLE: 2,
}
export function shakyStarters(
  starters: PlayerId[],
  players: Map<PlayerId, Player>,
): Player[] {
  return starters
    .map((id) => players.get(id))
    .filter((p): p is Player => !!p)
    .filter((p) => {
      const st = p.injuryStatus ?? p.status ?? ''
      return !!st && st !== 'Active'
    })
    .sort((a, b) => {
      const r = (p: Player) =>
        DESIGNATION_RANK[String(p.injuryStatus ?? p.status ?? '').toUpperCase()] ?? 3
      return r(b) - r(a)
    })
}

/** How a hurt starter reads on a tile, for either platform. */
export function shakyWhy(shaky: Player[]): { urgency: Urgency; action: string; why: string } {
  const worst = shaky[0]
  const tag = String(worst.injuryStatus ?? worst.status ?? '').toLowerCase()
  const body = worst.injuryBody ? ` (${worst.injuryBody.toLowerCase()})` : ''
  return {
    urgency: 'watch',
    action: shaky.length === 1 ? 'Watch one starter' : `Watch ${shaky.length} starters`,
    why:
      shaky.length === 1
        ? `${worst.name} is ${tag}${body} and is in your lineup.`
        : `${worst.name} is ${tag}${body}, and ${shaky.length - 1} more are carrying designations.`,
  }
}

/** About how long a game runs, for deciding whether a starter is done. */
const GAME_MS = 3.25 * HOUR

/**
 * Where one club's game stands, which is as close as the schedule can get to
 * "is this man on the field right now".
 *
 * Kept in one place because two screens ask it — the tile, to count what is
 * still to come, and the roster, to mark the rows worth watching. Two
 * definitions of "playing" that drifted apart would be a quiet way to have a
 * card disagree with the list underneath it.
 *
 * Null means no fixture is known for the club, which is not the same as a
 * game that has not started: a bye, a club the schedule spells differently, a
 * week that has not been published.
 */
export function gamePhase(
  kickoff: number | null | undefined,
  now: number,
): 'pre' | 'playing' | 'done' | null {
  if (kickoff == null) return null
  if (now < kickoff) return 'pre'
  return now < kickoff + GAME_MS ? 'playing' : 'done'
}

/**
 * Where a week actually stands, for a tile.
 *
 * Once the ball is in the air, "lineup set, nobody flagged" is a sentence about
 * a decision you can no longer make. The tile went on saying it all Sunday —
 * and "watch one starter" after his kickoff is worse than silence, because it
 * asks for something that is no longer possible.
 */
export function weekState(
  starters: PlayerId[],
  players: Map<PlayerId, Player>,
  kickoffs: Map<string, number>,
  now: number,
): { started: boolean; toPlay: number; playing: number; done: number } {
  let toPlay = 0, playing = 0, done = 0
  for (const id of starters) {
    const team = players.get(id)?.team
    const ph = gamePhase(team ? kickoffs.get(team) : undefined, now)
    // A club with no fixture is still to play, not finished: counting it as
    // done would call a week over while a starter had never taken the field.
    if (ph === 'playing') playing++
    else if (ph === 'done') done++
    else toPlay++
  }
  return { started: playing + done > 0, toPlay, playing, done }
}

/**
 * Actual against projected, over the starters whose games have finished.
 *
 * Anyone still to play is simply not in it, and anyone mid-game is left out
 * too: his final is not known, and folding a part-played score into the
 * comparison would report a man as behind pace for being at half time.
 */
export function paceOf(
  starters: PlayerId[],
  players: Map<PlayerId, Player>,
  kickoffs: Map<string, number>,
  now: number,
  points: (id: PlayerId) => number | null,
  projected: (id: PlayerId) => number | null,
): { done: number; of: number; got: number; due: number } | null {
  let done = 0, got = 0, due = 0
  for (const id of starters) {
    const team = players.get(id)?.team
    if (gamePhase(team ? kickoffs.get(team) : undefined, now) !== 'done') continue
    const p = points(id)
    const q = projected(id)
    if (p == null || q == null) continue
    done++; got += p; due += q
  }
  // No baseline, no reading: a man "ahead of pace" of nought is arithmetic.
  return done && due > 0
    ? { done, of: starters.length, got: Number(got.toFixed(2)), due: Number(due.toFixed(2)) }
    : null
}

/** "every starter is done" -> "Every starter is done." */
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`

/**
 * Whether a capture contains a score at all, or was taken before the games.
 *
 * Yahoo prints nought rather than a dash for a team whose players have not
 * played, so the totals on a Friday capture read 0–0 and are indistinguishable
 * from a genuine goalless start. The capture's own timestamp settles it: a
 * reading taken before the first of your starters kicked off is not a score,
 * whatever number it carries.
 */
export function scoreRead(
  at: number,
  starters: PlayerId[],
  players: Map<PlayerId, Player>,
  kickoffs: Map<string, number>,
): boolean {
  let first = Infinity
  for (const id of starters) {
    const team = players.get(id)?.team
    const k = team ? kickoffs.get(team) : undefined
    if (k != null && k < first) first = k
  }
  return first !== Infinity && at >= first
}

/**
 * How a live week reads on a tile: the margin, and how much is left.
 *
 * `theirs` may be null when the opponent's side was never captured — Yahoo's
 * totals come off whichever page the sensor last saw. A margin needs both
 * halves, so with only one this reports the total and says nothing about who
 * is ahead, rather than inventing a scoreline out of half of it.
 */
export function liveWhy(
  mine: number,
  theirs: number | null,
  st: { toPlay: number; playing: number; done: number },
): { urgency: Urgency; action: string; why: string; remaining: string } {
  const left = st.toPlay + st.playing
  const remaining =
    left === 0 ? 'every starter is done'
    : st.playing > 0 && st.toPlay > 0 ? `${st.playing} playing, ${st.toPlay} still to come`
    : st.playing > 0 ? `${st.playing} still playing`
    : `${st.toPlay} still to play`

  if (theirs == null) {
    return {
      urgency: left === 0 ? 'quiet' : 'watch',
      action: left === 0 ? 'Week done' : 'Live',
      why: `${mine.toFixed(1)} so far · ${remaining}.`,
      remaining,
    }
  }
  const margin = mine - theirs
  if (left === 0) {
    return {
      urgency: 'quiet',
      action: margin >= 0 ? 'Won' : 'Lost',
      why: `${mine.toFixed(1)} to ${theirs.toFixed(1)} — ${remaining}.`,
      remaining,
    }
  }
  // Close and still running is the only live state worth catching the eye.
  const side = margin >= 0 ? `Up ${margin.toFixed(1)}` : `Trailing ${Math.abs(margin).toFixed(1)}`
  return {
    urgency: Math.abs(margin) < 15 ? 'watch' : 'quiet',
    action: 'Live',
    why: `${side} · ${remaining}.`,
    remaining,
  }
}

export async function buildTiles(
  leagues: LeagueConfig[],
  opts: { sleeperUserId: string; now?: number; players: Map<PlayerId, Player> },
): Promise<Tile[]> {
  const now = opts.now ?? Date.now()
  const tiles: Tile[] = []
  /*
   * Kickoff per club, once. Every tile needs it to say whether a week is under
   * way, and it is the same answer for all of them.
   */
  const kickoffs = new Map<string, number>()
  let week = 1
  try {
    const season = new Date(now).getFullYear()
    const st = await fetch('https://api.sleeper.app/v1/state/nfl').then((r) => r.json()).catch(() => null)
    week = Number((st as any)?.display_week ?? (st as any)?.week ?? 1)
    const { games } = await weekGames(season, week)
    for (const g of games) {
      const at = Date.parse(`${g.kickoff.replace(' ', 'T')}:00-04:00`)
      if (!Number.isFinite(at)) continue
      kickoffs.set(g.home, at)
      kickoffs.set(g.away, at)
    }
  } catch {
    // No schedule means no live phase, which is the state it was in before.
  }

  for (const l of leagues) {
    if ((l as any).detected) continue
    const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
    const inMs = draftAt == null ? null : draftAt - now
    const age = boardAge(l.id)
    const preDraft = inMs != null && inMs > 0

    let urgency: Urgency = 'quiet'
    let why = ''
    let action = 'Nothing to do'
    let freshMs: number | null = null
    let blocked: string | null = null
    let phase: Tile['phase'] = preDraft ? 'pre-draft' : 'in-season'
    let score: Tile['score'] = null

    if (preDraft) {
      const problems: string[] = []
      /*
       * An unset slot is only a problem once it could have been set. Yahoo
       * randomises the order about half an hour before the draft, so warning
       * about it nine days out is a false alarm — and a tile that cries wolf in
       * August is one that gets ignored in September. Sleeper publishes the
       * order as soon as it exists, so there it counts from a day out.
       */
      const slotKnowableIn = l.platform === 'yahoo' ? HOUR : DAY
      if (l.mySlot == null && inMs < slotKnowableIn) {
        problems.push(
          l.platform === 'yahoo'
            ? 'slot is not set and Yahoo has revealed it by now'
            : 'slot is not set',
        )
      }
      if (age != null && age > 2 * DAY && inMs < 2 * DAY) {
        problems.push(`board is ${Math.round(age / DAY)} days old`)
      }
      const near = inMs < 12 * HOUR
      urgency = near ? (problems.length ? 'act' : 'soon') : problems.length ? 'watch' : 'quiet'
      action = near ? 'Open companion' : problems.length ? 'Get ready' : 'Waiting'
      /*
       * With nothing to fix, say what is actually true rather than claiming
       * everything is set — three of these leagues have no slot yet and will
       * not have one until the night, so "slot set" would be a lie told to
       * reassure, which is the same failure as a false alarm wearing a smile.
       */
      const quietWhy =
        l.mySlot == null && l.platform === 'yahoo'
          ? `Drafts in ${humanIn(inMs)}. Yahoo reveals your slot about half an hour before.`
          : l.mySlot == null
            ? `Drafts in ${humanIn(inMs)}. Slot not published yet.`
            : `Drafts in ${humanIn(inMs)}. Slot ${l.mySlot}, board fresh — nothing to do yet.`
      why = problems.length
        ? `Drafts in ${humanIn(inMs)}. ${problems[0][0].toUpperCase()}${problems[0].slice(1)}.`
        : quietWhy
    }

    if (l.feed === 'sleeper') {
      const roster = await sleeperRoster(l.leagueKey, opts.sleeperUserId)
      if (roster) {
        freshMs = 0
        if (!preDraft && roster.players.length === 0) {
          urgency = 'watch'
          action = 'Undrafted'
          why = 'Roster is empty — this league has not drafted.'
        } else if (!preDraft) {
          const filled = roster.starters.length
          /*
           * A lineup being set is not the same as it being sound. Naming the
           * starter who may not play is the only thing on this card you can
           * act on, and "lineup set" hid it behind a reassurance.
           */
          const shaky = shakyStarters(roster.starters, opts.players)
          if (!filled) {
            urgency = 'act'
            action = 'Set lineup'
            why = `No starters set · ${roster.players.length} players rostered.`
          } else if (shaky.length) {
            const w = shakyWhy(shaky)
            urgency = w.urgency
            action = w.action
            why = w.why
          } else {
            urgency = 'quiet'
            action = 'Nothing to do'
            why = `Lineup set · ${roster.players.length} players rostered, nobody flagged.`
          }
          /*
           * Once the ball is in the air the week is the story, and everything
           * above is about a decision that has closed.
           */
          const st = weekState(roster.starters, opts.players, kickoffs, now)
          if (st.started) {
            const m = await sleeperMatchup(l.leagueKey, opts.sleeperUserId, week)
            const mine = m?.livePoints.mine ?? 0
            const theirs = m?.livePoints.theirs ?? 0
            const live = liveWhy(mine, theirs, st)
            phase = 'live'
            urgency = live.urgency
            action = live.action
            why = live.why
            /*
             * Scored through the league's own rules, the same call the league
             * page makes, so a tile and the page beneath it cannot disagree
             * about what a linebacker was worth.
             */
            const proj = await weeklyProjections(
              String(new Date(now).getFullYear()), week).catch(() => null)
            score = {
              mine, theirs, margin: mine - theirs, note: sentence(live.remaining),
              pace: paceOf(
                roster.starters, opts.players, kickoffs, now,
                (id) => m?.scored[id] ?? null,
                (id) => proj
                  ? projFor(proj, id, opts.players.get(id)?.pos, l as any)
                  : null,
              ),
            }
          }
        }
      } else {
        blocked = 'Sleeper did not answer'
        urgency = 'blocked'
        action = 'Unavailable'
        why = 'Could not read your roster just now.'
      }
    } else {
      /*
       * No Yahoo API, and none assumed. The browser sensor captures your roster
       * whenever you visit your own team page, so this is stale-but-real rather
       * than absent — and the age is reported rather than hidden, because a
       * roster from three days ago is worth having and worth doubting.
       */
      /*
       * A draft is only in progress while it is actually running. The banner
       * used to ask whether the draft time had passed and the tile was urgent,
       * which is also true of a league that drafted yesterday and has not been
       * captured since — so an eighteen-hour-old draft offered to resume.
       *
       * Started, recently, and no roster to show for it yet: that is drafting.
       * Once picks land the roster fills and it stops.
       */
      const sinceStart = draftAt != null ? Date.now() - draftAt : null
      const cap = rosterFor(String(l.leagueKey).split('.').pop() ?? '')
      if (sinceStart != null && sinceStart > 0 && sinceStart < 5 * HOUR &&
          !(cap && cap.starters.length)) {
        phase = 'drafting'
      }
      if (cap) {
        freshMs = Date.now() - cap.at
        const old = freshMs > 3 * DAY
        if (!preDraft) {
          const filled = cap.starters.length
          urgency = old ? 'watch' : filled ? 'quiet' : 'act'
          action = old ? 'Roster is stale' : filled ? 'Nothing to do' : 'Set lineup'
          why = old
            ? `Last seen ${Math.round(freshMs / DAY)} days ago — open your Yahoo team to refresh it.`
            : `${cap.players.length} rostered, ${filled} starting.`
          const shaky = shakyStarters(cap.starters, opts.players)
          if (!old && filled && shaky.length) {
            const w = shakyWhy(shaky)
            urgency = w.urgency
            action = w.action
            why = w.why
          }
          const st = weekState(cap.starters, opts.players, kickoffs, now)
          if (st.started) {
            /*
             * Yahoo's own totals rather than a sum of the rows: it is the only
             * way to have the opponent's at all, and it is the figure the site
             * itself shows, so the two cannot drift apart.
             *
             * The sensor reads them off the same page it reads the roster
             * from, so a live total is only as fresh as the last poll — which
             * is why the age still gets said.
             */
            const mine = cap.totals?.mine ?? 0
            const theirs = cap.totals?.theirs ?? null
            /*
             * Only claim a score that has actually been read. The tile said
             * "live · 0.0 so far" against a capture taken before kickoff,
             * which reads as a team that has scored nothing rather than as a
             * score nobody has looked at.
             */
            const seenSince =
              cap.totals != null && scoreRead(cap.at, cap.starters, opts.players, kickoffs)
            const live = seenSince ? liveWhy(mine, theirs, st) : null
            phase = 'live'
            if (live) {
              urgency = live.urgency
              action = live.action
              why = live.why
              score = {
                mine, theirs,
                margin: theirs == null ? null : mine - theirs,
                note: sentence(live.remaining),
                // Yahoo's own numbers on both sides of the comparison, which
                // is what the league page uses as well.
                pace: paceOf(
                  cap.starters, opts.players, kickoffs, now,
                  (id) => cap.live?.[id] ?? null,
                  (id) => cap.projected?.[id] ?? null,
                ),
              }
            } else {
              urgency = 'watch'
              action = 'Live'
              const left = st.toPlay + st.playing
              why = `Games under way · ${left} of ${st.toPlay + st.playing + st.done} starters still to finish · no score read yet.`
            }
          }
        }
      } else {
        blocked = 'Open your Yahoo team once to capture the roster'
        if (!preDraft) {
          urgency = 'blocked'
          action = 'Not captured'
          why = 'The sensor reads your roster when you visit your Yahoo team page.'
        }
      }
    }

    tiles.push({
      id: l.id,
      label: l.label,
      platform: l.platform,
      format: formatOf(l),
      teams: l.teams,
      urgency,
      why,
      action,
      freshMs,
      draft:
        draftAt != null && inMs != null
          ? { at: l.draftTime!, inMs, slotSet: l.mySlot != null, boardAgeMs: age }
          : null,
      blocked,
      phase,
      score,
    })
  }

  return tiles.sort((a, b) => {
    const r = RANK[a.urgency] - RANK[b.urgency]
    if (r !== 0) return r
    // Within a band the nearer deadline leads; leagues with no clock sink.
    const ax = a.draft?.inMs ?? Infinity
    const bx = b.draft?.inMs ?? Infinity
    return ax - bx
  })
}

/**
 * Waiver settings and what the manager has left to spend.
 *
 * Sleeper reports the waiver day as a bare number with no documented mapping,
 * so it is passed through rather than interpreted here — the caller surfaces
 * the resolved date so a wrong assumption is visible rather than silently
 * firing alerts on the wrong evening all season.
 */
export async function sleeperWaivers(
  leagueKey: string,
  userId: string,
): Promise<{ budget: number | null; spent: number; dayOfWeek: number | null } | null> {
  try {
    const [league, rosters] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`).then((r) => r.json()),
    ])
    const mine = (rosters as any[]).find((r) => r.owner_id === userId)
    // No roster means the balance is unknown, and unknown must not read as a
    // full untouched budget — that is what fires "waivers close with money
    // unspent" for a team nobody could see.
    if (!mine) return null
    return {
      budget: league?.settings?.waiver_budget ?? null,
      spent: mine.settings?.waiver_budget_used ?? 0,
      dayOfWeek: league?.settings?.waiver_day_of_week ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Every manager's roster, which is what a trade search needs and what a single
 * team view never has. Sleeper hands this over; Yahoo does not without an API
 * grant, so those leagues cannot answer the question at all.
 */
export async function sleeperAllSquads(
  leagueKey: string,
  userId: string,
): Promise<{ mine: any; others: any[] } | null> {
  try {
    const [rosters, users] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/users`).then((r) => r.json()),
    ])
    if (!Array.isArray(rosters)) return null
    const nameOf = (ownerId: string) => {
      const u = (users as any[]).find((x) => x.user_id === ownerId)
      return u?.metadata?.team_name || u?.display_name || 'a manager'
    }
    const all = (rosters as any[]).map((r) => ({
      teamId: String(r.roster_id),
      manager: nameOf(r.owner_id),
      ownerId: r.owner_id,
      playerIds: (r.players ?? []) as string[],
    }))
    const mine = all.find((r) => r.ownerId === userId)
    if (!mine) return null
    return { mine, others: all.filter((r) => r !== mine) }
  } catch {
    return null
  }
}
