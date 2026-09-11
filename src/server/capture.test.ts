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

test('the scoreline survives a push that could not read one', () => {
  /*
   * The two halves of a capture arrive on different schedules: the roster is
   * pushed whenever you open the page, the scoreline only while games are on.
   * A push carrying no totals is a page that could not state them, not a
   * matchup that has been called off.
   */
  const totals = {
    teamName: 'Gibbs Bowers the Ball', opponentName: 'Main Character Kyle',
    mine: 4.1, theirs: 12, projectedMine: 103.89, projectedTheirs: 107.67,
  }
  record(index, {
    yahooLeagueId: 'T3', teamId: '5', players: [row('Bo Nix', 'QB', 'DEN')], totals,
  })
  assert.deepEqual(rosterFor('T3')?.totals, totals)

  record(index, { yahooLeagueId: 'T3', teamId: '5', players: [row('Bo Nix', 'QB', 'DEN')] })
  assert.deepEqual(rosterFor('T3')?.totals, totals, 'a silent push must not erase the score')
})

test('a point on a row is a point scored, and a dash is not nought', () => {
  /*
   * Yahoo prints an en dash until a player's game starts, which the parser
   * reports as null. Storing that as nought would make a man who has not
   * played indistinguishable from one who played and did nothing.
   */
  record(index, {
    yahooLeagueId: 'T4', teamId: '5',
    players: [
      { ...row('A.J. Brown', 'WR', 'PHI'), points: 4.1 },
      { ...row('Bo Nix', 'QB', 'DEN'), points: null },
    ],
  })
  const live = rosterFor('T4')?.live ?? {}
  assert.equal(Object.values(live).length, 1, 'only the man who has played is in it')
  assert.equal(Object.values(live)[0], 4.1)
})

test('a projection of nought does not erase one that means something', () => {
  /*
   * Yahoo drops a man's projection to 0.00 while his game runs and puts it
   * back afterwards. Taken at face value it wiped a receiver's 11.81 the
   * moment he took the field and left his 4.10 with nothing to be measured
   * against — which is the whole of "how is this week going".
   */
  const real = { ...row('A.J. Brown', 'WR', 'PHI'), projected: 11.81 }
  record(index, { yahooLeagueId: 'T5', teamId: '5', players: [real] })
  const id = Object.keys(rosterFor('T5')!.projected!)[0]
  assert.equal(rosterFor('T5')!.projected![id], 11.81)

  record(index, {
    yahooLeagueId: 'T5', teamId: '5',
    players: [{ ...row('A.J. Brown', 'WR', 'PHI'), projected: 0 }],
  })
  assert.equal(rosterFor('T5')!.projected![id], 11.81, 'the real number survives')

  // A genuine revision still lands.
  record(index, {
    yahooLeagueId: 'T5', teamId: '5',
    players: [{ ...row('A.J. Brown', 'WR', 'PHI'), projected: 9.4 }],
  })
  assert.equal(rosterFor('T5')!.projected![id], 9.4, 'but a real revision is not blocked')
})

test('an opponent lineup is stamped when it is read, and only then', () => {
  /*
   * A full opponent roster can sit in the store for days after the last page
   * that could supply one. It is the input to a claim that another manager has
   * left a ruled-out player in his lineup, so its age has to be knowable.
   */
  record(index, { yahooLeagueId: 'T6', teamId: '5', players: [row('Bo Nix', 'QB', 'DEN')] })
  assert.equal(rosterFor('T6')?.opponentAt, null, 'nobody has read his side')

  const before = Date.now()
  record(index, {
    yahooLeagueId: 'T6', teamId: '5', players: [row('Bo Nix', 'QB', 'DEN')],
    matchup: {
      mine: [row('Bo Nix', 'QB', 'DEN')],
      opponent: [row('Derrick Henry', 'RB', 'BAL')],
      teamName: 'Me', opponentName: 'Them',
    },
  })
  const stamped = rosterFor('T6')!.opponentAt!
  assert.ok(stamped >= before, 'stamped at the moment it was read')

  // A later push with no matchup keeps the lineup and its original age.
  record(index, { yahooLeagueId: 'T6', teamId: '5', players: [row('Bo Nix', 'QB', 'DEN')] })
  assert.equal(rosterFor('T6')!.opponentAt, stamped, 'kept, and not quietly refreshed')
  assert.equal(rosterFor('T6')!.opponent?.players.length, 1)
})
