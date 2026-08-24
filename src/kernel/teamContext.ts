/**
 * Team context — 2025 to 2026 scheme and personnel changes, hand-maintained.
 *
 * Only `contextNote` is wired into this app. `contextNudge` is deliberately
 * unused: its caps were calibrated against projected points, and this app's
 * board is ordered by BEER+ value, which is scarcity-adjusted and on a
 * different scale entirely. Multiplying one by a factor derived for the other
 * has no defensible magnitude. See the note in README.md.
 *
 * Original module header follows.
 *
 * Team context module — drop-in, dependency-free.
 *
 * Two exports that matter:
 *   contextNote()  — display only, all rounds, zero risk
 *   contextNudge() — within-tier tiebreaker, rounds 7+, capped at 2.5%
 *
 * See README.md for the simulation results behind these caps.
 * Do not raise MAX_NUDGE or lower NUDGE_START_ROUND.
 */

export const MAX_NUDGE = 0.025;        // 2.5% of projected points, hard ceiling
export const NUDGE_START_ROUND = 7;    // no adjustment before this round

export interface TeamContext {
  team: string;
  schemeChange: 'high' | 'med' | '';
  direction: 'pass' | 'run' | 'neutral' | '';
  posBoost: string[];
  posFade: string[];
  note: string;
}

export type ContextMap = Map<string, TeamContext>;

/** Minimal CSV parse. Handles quoted fields containing commas. */
function parseRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function loadTeamContext(csvText: string): ContextMap {
  const map: ContextMap = new Map();
  if (!csvText) return map;

  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return map;

  const header = parseRow(lines[0]);
  const col = (name: string) => header.indexOf(name);
  const iTeam = col('team');
  const iChange = col('scheme_change');
  const iDir = col('direction');
  const iBoost = col('pos_boost');
  const iFade = col('pos_fade');
  const iNote = col('note');
  if (iTeam < 0) return map;

  const split = (v: string) =>
    (v || '').split(';').map((s) => s.trim().toUpperCase()).filter(Boolean);

  for (let i = 1; i < lines.length; i++) {
    const f = parseRow(lines[i]);
    const team = (f[iTeam] || '').toUpperCase();
    if (!team) continue;
    map.set(team, {
      team,
      schemeChange: (f[iChange] || '') as TeamContext['schemeChange'],
      direction: (f[iDir] || '') as TeamContext['direction'],
      posBoost: split(f[iBoost]),
      posFade: split(f[iFade]),
      note: f[iNote] || '',
    });
  }
  return map;
}

/** Display string for the player detail panel. Empty string if no signal. */
export function contextNote(ctx: ContextMap, team: string): string {
  return ctx.get((team || '').toUpperCase())?.note ?? '';
}

/**
 * Multiplicative adjustment for within-tier ordering.
 * Returns a value in [-MAX_NUDGE, +MAX_NUDGE]. Returns 0 before round 7,
 * for unknown teams, and for teams with no recorded signal.
 *
 * Usage: projectedPoints * (1 + contextNudge(ctx, team, pos, round))
 * ONLY when sorting players already inside the same tier.
 */
export function contextNudge(
  ctx: ContextMap,
  team: string,
  pos: string,
  round: number,
): number {
  if (round < NUDGE_START_ROUND) return 0;

  const c = ctx.get((team || '').toUpperCase());
  if (!c) return 0;

  const p = (pos || '').toUpperCase();
  const matches = (tokens: string[]) =>
    tokens.some((t) => t === p || t.startsWith(p));

  let dir = 0;
  if (matches(c.posBoost)) dir += 1;
  if (matches(c.posFade)) dir -= 1;
  if (dir === 0) return 0;

  // Confidence scales with how much the offense actually changed.
  const confidence = c.schemeChange === 'high' ? 1.0
    : c.schemeChange === 'med' ? 0.5
    : 0;
  if (confidence === 0) return 0;

  const raw = dir * confidence * MAX_NUDGE;
  return Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, raw));
}

/**
 * Convenience: order players inside a single tier.
 * Callers must bucket by tier first — this must never reorder across tiers.
 */
export function sortWithinTier<T extends { team: string; pos: string; projPoints: number }>(
  tier: T[],
  ctx: ContextMap,
  round: number,
): T[] {
  return [...tier].sort((a, b) => {
    const av = a.projPoints * (1 + contextNudge(ctx, a.team, a.pos, round));
    const bv = b.projPoints * (1 + contextNudge(ctx, b.team, b.pos, round));
    return bv - av;
  });
}
