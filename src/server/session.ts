import { readFileSync } from 'node:fs'
import { DraftState } from '../kernel/state.js'
import { PlayerIndex } from '../kernel/match.js'
import { applyAdjustments, type AdjustmentData, type AdjustedRanking } from '../kernel/adjust.js'
import { buildRoster, byeConflicts, needs } from '../kernel/roster.js'
import { detectRun, estimateAdpStdev, recommend, survival, tierBreaks } from '../kernel/value.js'
import { myPicks, nextPickFor, picksBetween } from '../kernel/snake.js'
import { blendedSurvival, opponentSurvival, upcomingDemand } from '../kernel/opponents.js'
import { PreferenceIndex, evaluateStrategy, type Preferences, type Rule } from '../kernel/preferences.js'
import { explainPick, type Explanation } from '../kernel/explain.js'
import { backfieldByAdp, classify } from '../kernel/archetypes.js'
import { loadTeamContext, contextNote, type ContextMap } from '../kernel/teamContext.js'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { DraftLog } from './store.js'
import type { LeagueConfig, Pick, Player, PlayerId, Pos, Ranking } from '../kernel/types.js'
import type { Adapter } from '../adapters/types.js'

export class LeagueSession {
  readonly state: DraftState
  readonly index: PlayerIndex
  readonly players: Map<PlayerId, Player>
  private readonly rankings: Ranking[]
  private readonly adjustments: AdjustmentData | null
  private log: DraftLog
  private logKey = ''
  adapters: Adapter[] = []
  adjustmentsEnabled = false
  private prefs: PreferenceIndex
  private teamContext: ContextMap
  private preferences: Preferences | null = null

  constructor(
    readonly league: LeagueConfig,
    players: Player[],
    adjustments: AdjustmentData | null,
  ) {
    this.index = new PlayerIndex(players)
    this.players = new Map(players.map((p) => [p.id, p]))
    this.adjustments = adjustments
    this.state = new DraftState(league.teams)

    const raw = JSON.parse(
      readFileSync(`data/rankings-${league.id}.json`, 'utf8'),
    ) as { rankings: Ranking[] }
    this.rankings = raw.rankings.map((r) => ({
      ...r,
      adpStdev: r.adpStdev || estimateAdpStdev(r.adp),
    }))

    // Scheme context is shared across leagues and never league-specific.
    this.teamContext = existsSync('data/team-context.csv')
      ? loadTeamContext(readFileSync('data/team-context.csv', 'utf8'))
      : loadTeamContext('')

    this.preferences = this.loadPreferences()
    this.prefs = new PreferenceIndex(this.preferences, (n) => this.index.resolve({ name: n })?.id ?? null)

    this.log = new DraftLog(this.logPath(league.draftId))
    this.logKey = league.draftId ?? league.id
    this.replayLog()
  }

  /**
   * One log per draft, not per league. A mock and the real draft are different
   * events, and sharing a file meant a manual correction entered during a mock
   * outranked the real draft's feed for ever — manual entry beats a sensor by
   * design, which is right within a draft and wrong across two.
   */
  private logPath(draftId?: string | null): string {
    return draftId
      ? `fixtures/log-${this.league.id}-${draftId}.jsonl`
      : `fixtures/log-${this.league.id}.jsonl`
  }

  private replayLog(): void {
    const { picks, slot } = this.log.replay()
    this.state.reset()
    if (picks.length) this.state.applySnapshot(picks, 'manual')
    this.league.mySlot = slot
  }

  /**
   * Rebuilds anything that depends on the league's shape. Called when a sensor
   * shows the configured team count is wrong — every pick's overall number is
   * derived from it, so the log has to be replayed against the new geometry.
   */
  retune(): void {
    for (const a of this.adapters) a.stop()
    this.adapters = []
    this.state.reset()
    this.replayLog()
  }

  /** Swaps to another draft's log, keeping both intact. */
  useDraft(draftId: string | null): void {
    const key = draftId ?? this.league.id
    if (key === this.logKey) return
    this.log = new DraftLog(this.logPath(draftId))
    this.logKey = key
    this.replayLog()
  }

  /**
   * Preferences are two files: the likes/avoids captured from the platform, and
   * hand-written strategy rules that outlive any one season's lists.
   */
  private loadPreferences(): Preferences | null {
    const listPath = `data/preferences/${this.league.id}.json`
    const rulePath = `data/preferences/${this.league.id}.rules.json`
    const lists = existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8')) : null
    const rules = existsSync(rulePath) ? JSON.parse(readFileSync(rulePath, 'utf8')) : null
    if (!lists && !rules) return null
    return {
      leagueId: this.league.id,
      likes: lists?.likes ?? [],
      avoids: lists?.avoids ?? [],
      rules: (rules?.rules ?? []) as Rule[],
      source: lists?.source,
      fetchedAt: lists?.fetchedAt,
    }
  }

  /** Ingests likes/avoids scraped from the platform, resolving names to ids. */
  setPreferences(data: { likes?: any[]; avoids?: any[]; source?: string }): void {
    const toIds = (rows: any[] = []) =>
      rows
        .map((r) =>
          typeof r === 'string'
            ? this.index.resolve({ name: r })?.id
            : this.index.resolve({ name: r.name, pos: r.pos, team: r.team })?.id,
        )
        .filter(Boolean) as string[]

    const payload = {
      likes: toIds(data.likes),
      avoids: toIds(data.avoids),
      source: data.source ?? 'manual',
      fetchedAt: new Date().toISOString(),
    }
    mkdirSync('data/preferences', { recursive: true })
    writeFileSync(`data/preferences/${this.league.id}.json`, JSON.stringify(payload, null, 1))
    // Scheme context is shared across leagues and never league-specific.
    this.teamContext = existsSync('data/team-context.csv')
      ? loadTeamContext(readFileSync('data/team-context.csv', 'utf8'))
      : loadTeamContext('')

    this.preferences = this.loadPreferences()
    this.prefs = new PreferenceIndex(this.preferences, (n) => this.index.resolve({ name: n })?.id ?? null)
  }

  /**
   * Handcuffs and late fliers mostly have no ranking — that is what makes them
   * late fliers. They are added to the pool at a floor value so they can be seen
   * and drafted, without ever outranking a player the board actually rates.
   */
  private lateFliers(): AdjustedRanking[] {
    const rule = (this.preferences?.rules ?? []).find((r: any) => r.kind === 'lateTargets') as any
    if (!rule) return []
    const ranked = new Set(this.rankings.map((r) => r.playerId))
    const drafted = this.state.drafted()
    const out: AdjustedRanking[] = []
    let n = 0
    for (const p of this.players.values()) {
      if (ranked.has(p.id) || drafted.has(p.id)) continue
      const isBackup = p.pos === 'RB' && (p.depthOrder ?? 0) === 2
      const shortlist: string[] = rule.rookieShortlist ?? []
      const isRookieWR = shortlist.length
        ? shortlist.some((n) => n.toLowerCase() === p.name.toLowerCase())
        : p.pos === 'WR' && p.yearsExp === 0
      if (!isBackup && !isRookieWR) continue
      out.push({
        playerId: p.id,
        myRank: this.rankings.length + ++n,
        tier: 0,
        value: -4,
        adjustedValue: -4,
        adjustmentDelta: 0,
        adjustmentDetail: [],
        posRank: 99,
        adp: this.league.teams * this.league.rounds,
        adpStdev: this.league.teams,
      } as AdjustedRanking)
    }
    return out
  }

  /** Ranked pool ids, used to bias manual search toward draftable players. */
  private rankedIds(): Set<PlayerId> {
    return new Set(this.rankings.map((r) => r.playerId))
  }

  onSnapshot = (picks: Pick[], source: string): boolean => {
    const diff = this.state.applySnapshot(picks, source)
    for (const p of diff.added) this.log.append({ t: 'pick', at: Date.now(), source, pick: p })
    return diff.changed
  }

  setSlot(slot: number | null): void {
    this.league.mySlot = slot
    // Clearing is a decision too. Only logging the set meant a cleared slot
    // reverted on the next restart.
    this.log.append({ t: 'slot', at: Date.now(), slot })
  }

  manualPick(overall: number, playerId: PlayerId): boolean {
    const diff = this.state.recordManual(overall, playerId)
    for (const p of diff.added) this.log.append({ t: 'pick', at: Date.now(), source: 'manual', pick: p })
    return diff.changed
  }

  undo(overall: number): boolean {
    const ok = this.state.undo(overall)
    if (ok) this.log.append({ t: 'undo', at: Date.now(), overall })
    return ok
  }

  reset(): void {
    this.state.reset()
    this.log.append({ t: 'reset', at: Date.now() })
  }

  /**
   * Drafted players stay in the results, marked taken, so "wait, is Bowers
   * gone?" is answerable without hunting the board.
   */
  search(query: string, limit = 8) {
    const ranked = this.rankedIds()
    const drafted = this.state.drafted()
    const takenBy = new Map(this.state.all().map((p) => [p.playerId, p]))
    return this.index
      .search(query, limit * 3)
      .sort((a, b) => {
        const t = Number(drafted.has(a.id)) - Number(drafted.has(b.id))
        if (t !== 0) return t
        return Number(ranked.has(b.id)) - Number(ranked.has(a.id))
      })
      .slice(0, limit)
      .map((p) => {
        const pick = takenBy.get(p.id)
        return {
          ...p,
          ranked: ranked.has(p.id),
          taken: Boolean(pick),
          takenAt: pick?.overall ?? null,
          takenBy: pick ? this.teamName(pick.slot) : null,
        }
      })
  }

  /**
   * Everything worth knowing about a player already on my roster. The strip has
   * room for a surname and nothing else, which is ambiguous the moment two of
   * them share one — this is what the hover card fills in.
   */
  private rosterDetail(id: PlayerId, myIds: PlayerId[]) {
    const p = this.players.get(id)
    const rank = this.rankings.find((r) => r.playerId === id)
    const pick = this.state.all().find((x) => x.playerId === id)
    const arch = classify(p, this.players, myIds, backfieldByAdp(this.rankings, this.players))
    return {
      ...this.playerBrief(id),
      yearsExp: p?.yearsExp ?? null,
      depthOrder: p?.depthOrder ?? null,
      posRank: rank?.posRank ?? null,
      value: rank?.value ?? null,
      adp: rank?.adp ?? null,
      tier: rank?.tier ?? null,
      pickedAt: pick ? { overall: pick.overall, round: pick.round, slot: pick.slot } : null,
      flags: this.prefs.flags(id),
      archetype: arch.label || null,
    }
  }

  /** Preference tags for a player, for the post-draft review. */
  flagsFor(id: PlayerId) {
    return this.prefs.flags(id)
  }

  /** Manager name for a slot, from whichever feed knows it. */
  teamName(slot: number): string {
    for (const a of this.adapters) {
      const n = a.teamNames?.()[slot]
      if (n) return n
    }
    return slot === this.league.mySlot ? 'You' : `Slot ${slot}`
  }

  private pool(): AdjustedRanking[] {
    const drafted = this.state.drafted()
    const adjusted = applyAdjustments(
      this.rankings,
      this.players,
      this.league,
      this.adjustments,
      this.adjustmentsEnabled,
    )
    return [...adjusted.filter((r) => !drafted.has(r.playerId)), ...this.lateFliers()]
  }

  /** Why this player, in a few bullets — for the click-to-explain panel. */
  explain(playerId: PlayerId): Explanation | null {
    const league = this.league
    const pool = this.pool()
    const current = this.state.onTheClock()
    const slot = league.mySlot
    const nextTurn = slot != null ? nextPickFor(slot, league.teams, league.rounds, current) : null
    const valueOf = (id: PlayerId) => this.rankings.find((r) => r.playerId === id)?.value ?? 0
    const myIds = slot != null ? this.state.bySlot(slot).map((p) => p.playerId) : []
    const roster = buildRoster(league, myIds, this.players, valueOf)
    const opponent =
      slot != null && nextTurn != null
        ? opponentSurvival({
            league, pool, players: this.players, picks: this.state.all(),
            from: current, to: nextTurn, valueOf,
          })
        : null
    return explainPick(
      { league, pool, players: this.players, roster, currentPick: current,
        opponentSurvival: opponent, flagsFor: (id) => this.prefs.flags(id),
        teamNoteFor: (team: string) => contextNote(this.teamContext, team) },
      playerId,
    )
  }

  view() {
    const league = this.league
    const pool = this.pool()
    const current = this.state.onTheClock()
    const slot = league.mySlot
    const next = slot != null ? nextPickFor(slot, league.teams, league.rounds, current - 1) : null
    // Survival is measured to my *next* turn, never the pick I am sitting on.
    const nextTurn = slot != null ? nextPickFor(slot, league.teams, league.rounds, current) : null
    const myIds = slot != null ? this.state.bySlot(slot).map((p) => p.playerId) : []

    const valueOf = (id: PlayerId) =>
      this.rankings.find((r) => r.playerId === id)?.value ?? 0
    const roster = buildRoster(league, myIds, this.players, valueOf)

    const picksLeft =
      slot != null ? myPicks(slot, league.teams, league.rounds).filter((p) => p >= current).length : 0

    const recentPositions = this.state
      .all()
      .slice(-6)
      .map((p) => this.players.get(p.playerId)?.pos)
      .filter(Boolean) as Pos[]

    const totalPicks = league.teams * league.rounds
    // A finished draft has no clock, no survival and no next pick — leaving the
    // value engine running past the end produced VONA 0.00 and 100% survival
    // for everyone, which reads as broken rather than done.
    const complete = this.state.count() >= totalPicks
    const onMyClock = !complete && next === current

    // Waiting on your own pick is the only latency that is felt, so tell the
    // sensors to work harder as the turn comes round and ease off after.
    const until = next != null ? picksBetween(current - 1, next) : Infinity
    const urgent = !complete && (onMyClock || until <= 2)
    for (const a of this.adapters) a.setUrgent?.(urgent)

    // Startable depth left at each position, which is what a run actually eats.
    const poolByPos = new Map<Pos, number>()
    for (const r of pool.slice(0, 40)) {
      const p = this.players.get(r.playerId)?.pos
      if (p) poolByPos.set(p, (poolByPos.get(p) ?? 0) + 1)
    }

    // The pick my previous turn was made at, so the board can say what has gone
    // since I last chose.
    const myPickNumbers = slot != null ? myPicks(slot, league.teams, league.rounds) : []
    const lastTurn = myPickNumbers.filter((p) => p < current).pop() ?? null
    const goneSinceLastTurn = lastTurn == null ? [] : this.state.all().filter((p) => p.overall > lastTurn)

    const opponent =
      slot != null && nextTurn != null
        ? opponentSurvival({
            league, pool, players: this.players, picks: this.state.all(),
            from: current, to: nextTurn, valueOf,
          })
        : null

    const demand =
      slot != null && nextTurn != null
        ? upcomingDemand({
            league, pool, players: this.players, picks: this.state.all(),
            from: current, to: nextTurn, valueOf,
          })
        : []

    return {
      league: {
        id: league.id,
        label: league.label,
        platform: league.platform,
        teams: league.teams,
        rounds: league.rounds,
        mySlot: slot,
        draftTime: league.draftTime ?? null,
        adjustments: league.adjustments.map((a) => ({ id: a.id, label: a.label, note: a.note })),
        adjustmentsEnabled: this.adjustmentsEnabled,
        benchSize: league.benchSize,
        feed: league.feed,
        draftId: league.draftId ?? null,
        configuredDraftId: (league as any).configuredDraftId ?? null,
        isMock: Boolean((league as any).isMock),
      },
      clock: {
        currentPick: complete ? totalPicks : current,
        round: complete ? league.rounds : Math.floor((current - 1) / league.teams) + 1,
        nextPick: complete ? null : next,
        picksUntilMyTurn: complete || next == null ? null : picksBetween(current - 1, next),
        onMyClock,
        picksLeft: complete ? 0 : picksLeft,
        complete,
        totalPicks,
      },
      // Sorted by value, not by ingestion order. Kickers, defenses and IDP are
      // appended to the rankings file after the main board, so an unsorted slice
      // hid them completely — the guillotine league would be told to draft a
      // linebacker while showing none.
      board: [...pool]
        .sort((a, b) => b.adjustedValue - a.adjustedValue)
        .slice(0, 80)
        .map((r) => this.card(r, nextTurn, opponent, myIds, backfieldByAdp(pool, this.players))),
      verdict: complete
        ? { picks: [], gap: 0, unanimous: false, confidence: 'clear' as const, modelConflict: null }
        : (() => {
        const lateRule = (this.preferences?.rules ?? []).find(
          (r: any) => r.kind === 'lateTargets',
        ) as any
        const v = recommend({
          league, pool, players: this.players, roster,
          currentPick: current, opponentSurvival: opponent, limit: 3,
          myIds,
          lateTargets: lateRule
            ? {
                prefer: lateRule.prefer,
                reserveLastRounds: lateRule.reserveLastRounds,
                topRookies: lateRule.topRookies,
                rookiePositions: lateRule.rookiePositions,
                rookieShortlist: lateRule.rookieShortlist,
                includeUnownedBackups: lateRule.includeUnownedBackups,
                topBackups: lateRule.topBackups,
              }
            : null,
        })
        // Preference is shown alongside the recommendation, never folded into
        // it: the model says what a player is worth, you decide if you want him.
        const explainCtx = {
          league, pool, players: this.players, roster, currentPick: current,
          opponentSurvival: opponent, flagsFor: (id: PlayerId) => this.prefs.flags(id),
          teamNoteFor: (team: string) => contextNote(this.teamContext, team),
        }
        return {
          ...v,
          picks: v.picks.map((p) => ({
            ...p,
            flags: this.prefs.flags(p.playerId),
            archetype: (() => {
              const a = classify(
                this.players.get(p.playerId),
                this.players,
                myIds,
                backfieldByAdp(pool, this.players),
              )
              return a.label ? { label: a.label, mine: Boolean(a.behind?.mine) } : null
            })(),
            explain: explainPick(explainCtx, p.playerId),
          })),
        }
      })(),
      /** Only meaningful once the draft is over; used for the wrap-up screen. */
      summary: complete
        ? {
            byPos: (() => {
              const counts: Record<string, number> = {}
              for (const id of myIds) {
                const pos = this.players.get(id)?.pos
                if (pos) counts[pos] = (counts[pos] ?? 0) + 1
              }
              return counts
            })(),
            likes: myIds.filter((id) => this.prefs.flags(id).tags.includes('like')).length,
            avoids: myIds
              .filter((id) => this.prefs.flags(id).tags.includes('avoid'))
              .map((id) => this.playerBrief(id)),
            bestAvailable: pool
              .slice()
              .sort((a, b) => b.adjustedValue - a.adjustedValue)
              .slice(0, 5)
              .map((r) => this.playerBrief(r.playerId)),
          }
        : null,
      upcomingDemand: demand,
      strategy: evaluateStrategy(
        this.preferences,
        roster,
        Math.floor((current - 1) / league.teams) + 1,
        league,
        poolByPos,
      ),
      preferences: {
        loaded: this.preferences != null,
        likes: this.preferences?.likes.length ?? 0,
        avoids: this.preferences?.avoids.length ?? 0,
        rules: (this.preferences?.rules ?? []).map((r) => ({
          id: r.id, label: r.label, note: r.note,
        })),
      },
      goneSinceLastTurn: {
        since: lastTurn,
        count: goneSinceLastTurn.length,
        picks: goneSinceLastTurn.map((p) => ({
          overall: p.overall,
          player: this.playerBrief(p.playerId),
          by: this.teamName(p.slot),
        })),
      },
      roster: {
        slots: roster.slots.map((s) => ({
          name: s.name,
          eligible: s.eligible,
          player: s.filled ? this.rosterDetail(s.filled, myIds) : null,
        })),
        bench: roster.bench.map((id) => this.rosterDetail(id, myIds)),
        byeConflicts: byeConflicts(roster, this.players).map((c) => ({
          week: c.week,
          players: c.playerIds.map((id) => this.playerBrief(id)),
        })),
      },
      needs: needs(roster, league, picksLeft),
      tierBreaks: tierBreaks(pool, this.players)
        .slice(0, 4)
        .map((t) => ({ ...t, player: this.playerBrief(t.playerId) })),
      run: detectRun(recentPositions),
      picks: this.state.all().map((p) => ({
        ...p,
        player: this.playerBrief(p.playerId),
        by: this.teamName(p.slot),
        mine: slot != null && p.slot === slot,
      })),
      /*
       * Local state disagreeing with the platform is the one thing that must
       * never pass quietly: it means the board is showing a draft that is not
       * happening. Usually stale state from a rehearsal that was never cleared.
       */
      stale: (() => {
        /*
         * Only worth raising when the sensor is genuinely healthy. A blocked or
         * stale feed reports zero, and the warning then advises clearing a
         * perfectly good draft — which is exactly what happened to a 180-pick
         * mock. A broken sensor is the disconnect banner's job, not this one.
         */
        const healthy = this.adapters.filter((a) => {
          const h = a.health()
          return h.ok && h.lastUpdate != null && Date.now() - h.lastUpdate < 30000
        })
        if (!healthy.length) return null
        const feed = healthy
          .map((a) => a.feedCount?.() ?? null)
          .find((n) => n !== null && n !== undefined)
        if (feed == null) return null
        const local = this.state.count()
        // A couple of picks of lag is normal between poll and push.
        if (local <= feed + 2) return null
        return { localPicks: local, feedPicks: feed }
      })(),
      teamNames: Object.fromEntries(
        Array.from({ length: league.teams }, (_, i) => [i + 1, this.teamName(i + 1)]),
      ),
      health: this.adapters.map((a) => a.health()),
    }
  }

  private card(
    r: AdjustedRanking,
    next: number | null,
    opponent: Map<PlayerId, number> | null,
    myIdsForCards: PlayerId[] = [],
    backfieldForCards?: Map<string, PlayerId[]>,
  ) {
    const p = this.players.get(r.playerId)
    return {
      playerId: r.playerId,
      name: p?.name ?? r.playerId,
      pos: p?.pos ?? null,
      team: p?.team ?? null,
      byeWeek: p?.byeWeek ?? null,
      value: r.value,
      adjustedValue: r.adjustedValue,
      adjustmentDelta: r.adjustmentDelta,
      adjustmentDetail: r.adjustmentDetail,
      posRank: r.posRank,
      adp: r.adp,
      adpDelta: r.adp - r.myRank,
      flags: this.prefs.flags(r.playerId),
      archetype: (() => {
        const a = classify(this.players.get(r.playerId), this.players, myIdsForCards, backfieldForCards)
        return a.label ? { label: a.label, mine: Boolean(a.behind?.mine), kinds: a.kinds } : null
      })(),
      teamNote: contextNote(this.teamContext, this.players.get(r.playerId)?.team ?? ''),
      survival: next != null ? blendedSurvival(r, next, opponent) : null,
      survivalAdp: next != null ? survival(r.adp, next, r.adpStdev) : null,
      survivalOpponent: opponent?.get(r.playerId) ?? null,
    }
  }

  private playerBrief(id: PlayerId) {
    const p = this.players.get(id)
    return p
      ? { id, name: p.name, pos: p.pos, team: p.team, byeWeek: p.byeWeek }
      : { id, name: id, pos: null, team: null, byeWeek: null }
  }
}
