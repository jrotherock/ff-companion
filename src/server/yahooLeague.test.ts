import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'ff-league-'))
const { record, forLeague, squadsFor } = await import('./yahooLeague.js')

const squad = (teamId: string, manager: string) => ({
  teamId, manager,
  players: [{ id: `${teamId}-p`, name: `${manager}'s man`, pos: 'RB', projected: 10 }],
})

test('a league nobody has read is absent, not a league with no players in it', () => {
  assert.equal(forLeague('L0'), null)
  assert.equal(squadsFor('L0', '1'), null)
})

test('each part survives a poll that fetched a different one', () => {
  /*
   * Rosters change slowly, transactions constantly, scores weekly, so the four
   * arrive on different schedules. A poll for one must not blank the rest.
   */
  record({ yahooLeagueId: 'L1', myTeamId: '1', squads: [squad('1', 'Me'), squad('2', 'Rival')] })
  record({ yahooLeagueId: 'L1', transactions: [
    { id: 't', at: 5, type: 'add', manager: 'Rival', added: [], dropped: [] }] })
  record({ yahooLeagueId: 'L1', weeks: [{ week: 1, teams: [{ teamId: '1', points: 100 }] }] })

  const wide = forLeague('L1')!
  assert.equal(wide.squads.length, 2, 'the rosters are still there')
  assert.equal(wide.transactions.length, 1)
  assert.equal(wide.weeks.length, 1)
  assert.equal(wide.myTeamId, '1', 'and so is who I am')
})

test('my squad is separated from everybody else\'s', () => {
  const s = squadsFor('L1', '1')!
  assert.equal(s.mine.manager, 'Me')
  assert.deepEqual(s.others.map((o) => o.manager), ['Rival'])
})

test('without knowing which team is mine there is nothing to compare', () => {
  record({ yahooLeagueId: 'L2', squads: [squad('7', 'Someone')] })
  assert.equal(squadsFor('L2', '99'), null, 'guessing which team is mine is worse than saying nothing')
})
