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

const CACHE = statePath('availability.json')

const player = (o: Partial<Player> & { id: string }): Player => ({
  name: o.id, pos: 'WR', team: 'LAR', byeWeek: null, ids: {}, ...o,
} as Player)

const withCache = (by: Record<string, unknown>, run: () => Promise<void>) => {
  const had = existsSync(CACHE) ? readFileSync(CACHE, 'utf8') : null
  mkdirSync('fixtures', { recursive: true })
  // Fresh, so the refresh reads it rather than reaching for the network.
  writeFileSync(CACHE, JSON.stringify({ at: Date.now(), by }))
  return run().finally(() => {
    if (had != null) writeFileSync(CACHE, had)
    else rmSync(CACHE, { force: true })
  })
}

test('a designation that has cleared is cleared on the board', () =>
  withCache(
    { '9493': { status: 'Active', injuryStatus: null, injuryBody: null, injuryNotes: null } },
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
  withCache(
    { '1': { status: 'Active', injuryStatus: '', injuryBody: '', injuryNotes: null } },
    async () => {
      const players = new Map<PlayerId, Player>([['1', player({ id: '1', injuryStatus: 'Questionable' })]])
      await refreshAvailability(players)
      assert.equal(players.get('1')!.injuryStatus, null, 'must not leave a tag with no letters in it')
    },
  ))

test('an unchanged designation is not reported as a change', () =>
  withCache(
    { '2': { status: 'Active', injuryStatus: 'Out', injuryBody: 'Knee', injuryNotes: null } },
    async () => {
      const players = new Map<PlayerId, Player>([
        ['2', player({ id: '2', injuryStatus: 'Out', injuryBody: 'Knee' })],
      ])
      const out = await refreshAvailability(players)
      assert.equal(out.changed.length, 0)
    },
  ))
