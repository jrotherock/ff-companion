/**
 * The designation is the one field in the player map that goes stale within
 * hours, and it is the field the whole start/sit screen reads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import type { Player, PlayerId } from '../kernel/types.js'
import { refreshAvailability } from './availability.js'
import { statePath } from './paths.js'

const SNAP = statePath('player-snapshot.json')

const player = (o: Partial<Player> & { id: string }): Player => ({
  name: o.id, pos: 'WR', team: 'LAR', byeWeek: null, ids: {}, ...o,
} as Player)

/**
 * The poller's snapshot is the source now — the same file it diffs for news,
 * so the alerts cannot be reading an older Sleeper than the news feed is.
 * `s` is the season status and `i` the game-day designation, as the poller
 * stores them.
 */
const withSnapshot = (players: Record<string, unknown>, run: () => Promise<void>) => {
  const had = existsSync(SNAP) ? readFileSync(SNAP, 'utf8') : null
  mkdirSync('fixtures', { recursive: true })
  writeFileSync(SNAP, JSON.stringify({ at: Date.now(), players }))
  return run().finally(() => {
    if (had != null) writeFileSync(SNAP, had)
    else rmSync(SNAP, { force: true })
  })
}

test('a designation that has cleared is cleared on the board', () =>
  withSnapshot(
    { '9493': { s: 'Active', i: null } },
    async () => {
      const players = new Map<PlayerId, Player>([
        ['9493', player({ id: '9493', name: 'Puka Nacua', injuryStatus: 'Questionable', injuryBody: 'Undisclosed' })],
      ])
      const out = await refreshAvailability(players)
      assert.equal(players.get('9493')!.injuryStatus, null)
      assert.equal(players.get('9493')!.injuryBody, null)
      assert.deepEqual(out.changed, [{ name: 'Puka Nacua', from: 'Questionable', to: null }])
    },
  ))

test('an empty string is a cleared designation, not a blank one', () =>
  withSnapshot(
    { '1': { s: 'Active', i: '' } },
    async () => {
      const players = new Map<PlayerId, Player>([['1', player({ id: '1', injuryStatus: 'Questionable' })]])
      await refreshAvailability(players)
      assert.equal(players.get('1')!.injuryStatus, null, 'must not leave a tag with no letters in it')
    },
  ))

test('an unchanged designation is not reported as a change', () =>
  withSnapshot(
    { '2': { s: 'Active', i: 'Out' } },
    async () => {
      const players = new Map<PlayerId, Player>([
        ['2', player({ id: '2', injuryStatus: 'Out', injuryBody: 'Knee' })],
      ])
      const out = await refreshAvailability(players)
      assert.equal(out.changed.length, 0)
      assert.equal(players.get('2')!.injuryBody, 'Knee', 'a standing designation keeps its detail')
    },
  ))

test('a designation the news feed already has reaches the alerts too', () =>
  withSnapshot(
    // Exactly what the poller held while the board still showed him clear.
    { '11604': { s: 'Active', i: 'Doubtful' } },
    async () => {
      const players = new Map<PlayerId, Player>([
        ['11604', player({ id: '11604', name: 'Brock Bowers', pos: 'TE', injuryStatus: null })],
      ])
      const out = await refreshAvailability(players)
      assert.equal(players.get('11604')!.injuryStatus, 'Doubtful')
      assert.deepEqual(out.changed, [{ name: 'Brock Bowers', from: null, to: 'Doubtful' }])
    },
  ))
