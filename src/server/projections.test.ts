/**
 * The weekly projection table, and what happens when Sleeper does not answer.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DIR = mkdtempSync(join(tmpdir(), 'ff-proj-'))
process.env.STATE_DIR = DIR
const { weeklyProjections } = await import('./projections.js')
const CACHE = join(DIR, 'projections.json')

const realFetch = globalThis.fetch
function sleeper(body: unknown, status = 200) {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { get calls() { return calls } }
}
beforeEach(() => { rmSync(CACHE, { force: true }); globalThis.fetch = realFetch })

test('a week is read once and then served from the cache for the hour', async () => {
  const s = sleeper([{ player_id: '1', stats: { pts_half_ppr: 12.5 } }])
  assert.equal((await weeklyProjections('2026', 2)).pts.get('1'), 12.5)
  assert.equal((await weeklyProjections('2026', 2)).pts.get('1'), 12.5)
  assert.equal(s.calls, 1)
})

test('an empty answer is not cached, so the next request asks again', async () => {
  /*
   * An empty table sat in the cache for an hour and every comparison in the
   * app read nought: no trade fits anywhere, no waiver targets, nobody
   * projected in the Sleeper matchup.
   */
  const s = sleeper([])
  assert.equal((await weeklyProjections('2026', 2)).pts.size, 0)
  assert.equal(existsSync(CACHE), false, 'nothing written')
  await weeklyProjections('2026', 2)
  assert.equal(s.calls, 2, 'asked again rather than serving the empty table')
})

test('a failed read keeps the last good table for the week, however old', async () => {
  writeFileSync(CACHE, JSON.stringify({ at: 0, week: 2, season: '2026', pts: { 1: 9 }, stats: {} }))
  sleeper({ error: 'busy' }, 503)
  const p = await weeklyProjections('2026', 2)
  assert.equal(p.pts.get('1'), 9)
  assert.equal(p.at, 0, 'and says how old it is')
  assert.equal(JSON.parse(readFileSync(CACHE, 'utf8')).pts['1'], 9, 'the good table is not overwritten')
})

test('last week\'s table is never served as this week\'s', async () => {
  writeFileSync(CACHE, JSON.stringify({ at: Date.now(), week: 1, season: '2026', pts: { 1: 9 }, stats: {} }))
  sleeper([])
  assert.equal((await weeklyProjections('2026', 2)).pts.size, 0)
})
