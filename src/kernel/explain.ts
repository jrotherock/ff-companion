import type { LeagueConfig, Player, PlayerId, Pos, Roster } from './types.js'
import type { AdjustedRanking } from './adjust.js'
import type { PlayerFlags } from './preferences.js'
import { assignTiers, expectedBestAt, survival } from './value.js'
import { blendedSurvival } from './opponents.js'
import { nextPickFor } from './snake.js'
import { backfieldByAdp, classify } from './archetypes.js'

/**
 * A short, scannable case for or against one player. Written to be read in a
 * couple of seconds under a draft clock, so bullets are concrete, capped, and
 * ordered by how much they should move the decision.
 */

export type BulletKind =
  | 'value'
  | 'timing'
  | 'need'
  | 'market'
  | 'preference'
  | 'risk'
  | 'strategy'

export interface ExplainBullet {
  kind: BulletKind
  tone: 'good' | 'bad' | 'neutral'
  text: string
}

export interface Explanation {
  playerId: PlayerId
  name: string
  pos: Pos
  posRank: number
  team: string | null
  byeWeek: number | null
  headline: string
  verdict: 'take' | 'consider' | 'wait' | 'avoid'
  bullets: ExplainBullet[]
  /** 2025->2026 scheme change for this player's team, if any. */
  teamNote: string
}

export interface ExplainContext {
  /** Scheme note for the player's team, if there is one. */
  teamNoteFor?: (team: string) => string
  league: LeagueConfig
  pool: AdjustedRanking[]
  players: Map<PlayerId, Player>
  roster: Roster
  currentPick: number
  opponentSurvival: Map<PlayerId, number> | null
  flagsFor: (id: PlayerId) => PlayerFlags
  /** My roster, so a handcuff to one of my own backs can be named. */
  myIds?: PlayerId[]
}

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}

export function explainPick(ctx: ExplainContext, playerId: PlayerId): Explanation | null {
  const { league, pool, players, roster, currentPick, opponentSurvival: opp } = ctx
  const r = pool.find((x) => x.playerId === playerId)
  const player = players.get(playerId)
  if (!r || !player) return null

  const slot = league.mySlot
  const next = slot != null ? nextPickFor(slot, league.teams, league.rounds, currentPick) : null
  const pos = player.pos
  const bullets: ExplainBullet[] = []
  /** Value over the next player at this position — what the verdict ranks by. */
  let vona = 0

  // --- value ---
  const ranked = [...pool].sort((a, b) => b.adjustedValue - a.adjustedValue)
  const overallIdx = ranked.findIndex((x) => x.playerId === playerId) + 1
  const atPos = ranked.filter((x) => players.get(x.playerId)?.pos === pos)
  const posIdx = atPos.findIndex((x) => x.playerId === playerId) + 1

  bullets.push({
    kind: 'value',
    tone: overallIdx <= 3 ? 'good' : 'neutral',
    text:
      overallIdx === 1
        ? `Best player available — ${pos}${r.posRank}, value ${r.adjustedValue.toFixed(1)}`
        : `${ordinal(overallIdx)} best available, ${ordinal(posIdx)} at ${pos} — value ${r.adjustedValue.toFixed(1)}`,
  })

  // --- tier position ---
  const tiers = assignTiers(pool)
  const tier = tiers.get(playerId) ?? 0
  const sameTier = ranked.filter((x) => tiers.get(x.playerId) === tier)
  const sameTierPos = sameTier.filter((x) => players.get(x.playerId)?.pos === pos)
  if (sameTierPos.length === 1) {
    bullets.push({
      kind: 'timing',
      tone: 'good',
      text: `Last ${pos} in tier ${tier} — the next one is a real step down`,
    })
  } else if (sameTier.length <= 3) {
    bullets.push({
      kind: 'timing',
      tone: 'good',
      text: `Only ${sameTier.length} players left in tier ${tier}`,
    })
  }

  // --- survival to my next turn ---
  if (next != null) {
    const s = blendedSurvival(r, next, opp)
    const adpOnly = survival(r.adp, next, r.adpStdev)
    const oppOnly = opp?.get(playerId) ?? null
    const pct = Math.round(s * 100)

    bullets.push({
      kind: 'timing',
      tone: s < 0.3 ? 'good' : s > 0.7 ? 'bad' : 'neutral',
      text:
        s < 0.3
          ? `Only ${pct}% chance he lasts to your next pick at ${next} — now or never`
          : s > 0.7
            ? `${pct}% chance he is still there at ${next} — you can probably wait`
            : `Coin flip at ${pct}% to reach your next pick at ${next}`,
    })

    if (oppOnly != null && Math.abs(oppOnly - adpOnly) >= 0.35) {
      bullets.push({
        kind: 'timing',
        tone: 'neutral',
        text:
          oppOnly > adpOnly
            ? `ADP says he goes soon, but the teams ahead of you do not need ${pos} — he may slide`
            : `ADP says he is safe, but the teams ahead of you are hunting ${pos}`,
      })
    }

    // --- what you give up by waiting ---
    const expected = expectedBestAt(pool, pos, players, next, opp)
    vona = r.adjustedValue - expected
    if (Math.abs(vona) >= 0.2) {
      bullets.push({
        kind: 'value',
        tone: vona > 0 ? 'good' : 'bad',
        text:
          vona > 0
            ? `Worth ${vona.toFixed(1)} more than the ${pos} you would likely get at ${next}`
            : `The ${pos} available at ${next} should be about as good`,
      })
    }
  }

  // --- roster need ---
  const openHere = roster.slots.some((s) => !s.filled && s.eligible.includes(pos))
  const dedicated = roster.slots.some(
    (s) => !s.filled && s.eligible.length === 1 && s.eligible[0] === pos,
  )
  bullets.push({
    kind: 'need',
    tone: dedicated ? 'good' : openHere ? 'neutral' : 'bad',
    text: dedicated
      ? `Fills an open ${pos} starting slot`
      : openHere
        ? `Would go in your flex, not a dedicated ${pos} slot`
        : `You are already set at ${pos} — this is a bench pick`,
  })

  // --- market ---
  const delta = r.adp - r.myRank
  if (Math.abs(delta) >= 6) {
    bullets.push({
      kind: 'market',
      tone: delta > 0 ? 'good' : 'bad',
      text:
        delta > 0
          ? `Going ${Math.round(delta)} picks later than the room expects — value`
          : `${Math.round(-delta)} picks earlier than the room expects — a reach`,
    })
  }

  // --- bye clash ---
  if (player.byeWeek != null) {
    const clash = roster.slots
      .filter((s) => s.filled)
      .map((s) => players.get(s.filled!))
      .filter((p) => p && p.byeWeek === player.byeWeek) as Player[]
    if (clash.length >= 2) {
      bullets.push({
        kind: 'risk',
        tone: 'bad',
        text: `Week ${player.byeWeek} bye — already shared by ${clash.map((c) => c.name.split(' ').pop()).join(' and ')}`,
      })
    }
  }

  // --- late-round archetype ---
  const arch = classify(player, players, ctx.myIds ?? [], backfieldByAdp(pool, players))
  if (arch.label) {
    bullets.push({
      kind: 'need',
      tone: arch.behind?.mine ? 'good' : 'neutral',
      text: arch.behind?.mine
        ? `${arch.label} — insurance on a back you already own`
        : arch.kinds.includes('rookie')
          ? `${arch.label} — a late-round ticket rather than depth`
          : arch.label,
    })
  }

  // --- your own list ---
  const flags = ctx.flagsFor(playerId)
  if (flags.tags.includes('avoid')) {
    bullets.push({ kind: 'preference', tone: 'bad', text: 'On your do-not-draft list' })
  } else if (flags.likeRank != null) {
    bullets.push({
      kind: 'preference',
      tone: 'good',
      text: `Your own pre-draft rank #${flags.likeRank}`,
    })
  }
  if (flags.tags.includes('target')) {
    bullets.push({ kind: 'preference', tone: 'good', text: 'One of your late-round targets' })
  }

  // --- verdict ---
  const s = next != null ? blendedSurvival(r, next, opp) : 1
  let verdict: Explanation['verdict']
  if (flags.tags.includes('avoid')) verdict = 'avoid'
  // Same measure the recommendation ranks by, so the panel never contradicts
  // the card that opened it.
  else if (vona >= 0.5 && s < 0.5) verdict = 'take'
  else if (s > 0.7) verdict = 'wait'
  else verdict = 'consider'

  const headline =
    verdict === 'take'
      ? `Take him — he will not be there at ${next}`
      : verdict === 'wait'
        ? `You can wait — likely still available at ${next}`
        : verdict === 'avoid'
          ? 'You marked him do-not-draft'
          : vona > 0
            ? `Solid here — worth ${vona.toFixed(1)} over waiting`
            : 'Reasonable, but no better than what you would get next turn'

  const order: BulletKind[] = ['preference', 'timing', 'value', 'need', 'market', 'risk', 'strategy']
  bullets.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))

  return {
    playerId,
    name: player.name,
    pos,
    posRank: r.posRank,
    team: player.team,
    byeWeek: player.byeWeek,
    headline,
    verdict,
    // Five is the most that can be read at a glance under a clock.
    bullets: bullets.slice(0, 5),
    /*
     * Background rather than a reason, so it gets its own line instead of
     * competing for a bullet — the decision bullets always won, and the note
     * never appeared at all.
     */
    teamNote: ctx.teamNoteFor?.(player.team ?? '') ?? '',
  }
}
