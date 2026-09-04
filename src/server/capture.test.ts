import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const STATE = mkdtempSync(join(tmpdir(), 'ff-capture-'))
process.env.STATE_DIR = STATE
const { PlayerIndex } = await import('../kernel/match.js')
const { record, rosterFor } = await import('./yahooRoster.js')

const { players } = JSON.parse(readFileSync('data/players.json', 'utf8')) as any
const index = new PlayerIndex(players)
const row = (name: string, pos: string, team: string) =>
  ({ name, pos, team, slot: pos, projected: 10, bench: false })

test('an empty push cannot erase a roster that is already there', () => {
  /*
   * A capture with nobody in it overwrote a real thirteen-man roster, and the
   * league then reported "0 rostered, 0 starting" — which reads as a lineup
   * you failed to set rather than as a sensor that sent nothing.
   */
  const real = [row('Bo Nix', 'QB', 'DEN'), row('Derrick Henry', 'RB', 'BAL')]
  record(index, { yahooLeagueId: 'T1', teamId: '1', players: real })
  assert.equal(rosterFor('T1')?.players.length, 2)

  record(index, { yahooLeagueId: 'T1', teamId: '1', players: [] })
  assert.equal(rosterFor('T1')?.players.length, 2, 'the real roster must survive')
})

test('an empty capture reads as no capture, not as an empty team', () => {
  writeFileSync(join(STATE, 'yahoo-rosters.json'), JSON.stringify({
    T2: { yahooLeagueId: 'T2', teamId: '1', at: Date.now(), players: [], starters: [], unmatched: [] },
  }))
  assert.equal(rosterFor('T2'), null)
})
