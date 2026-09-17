/**
 * Which FantasyPros pages the weekly consensus is read from.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAGES } from './weeklyRanks.js'

test('a position that never catches a pass is asked for the plain page', () => {
  /*
   * There is no PPR variant of a quarterback, kicker or defence ranking. The
   * prefixed URL is a redirect to the preseason draft cheatsheet, which the
   * week check refuses — correctly, and silently — so for the first two weeks
   * of the season no quarterback had a consensus rank at all, and a coin flip
   * between Jordan Love and Bo Nix was settled on the matchup rank alone.
   *
   * The list looks untidy with three plain slugs among three prefixed ones,
   * which is exactly why it is pinned: making it consistent breaks it.
   */
  const slug = Object.fromEntries(PAGES)
  for (const pos of ['QB', 'K', 'DST']) {
    assert.doesNotMatch(slug[pos], /ppr/, `${pos} has no per-reception page`)
  }
  for (const pos of ['RB', 'WR', 'TE']) {
    assert.match(slug[pos], /^half-point-ppr-/, `${pos} is scored per reception`)
  }
})
