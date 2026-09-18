import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitCsvLine } from './nflverseCsv.js'
import { describe as say, type Allowed } from './dvp.js'
import { snapShares } from './usage.js'

test('a quoted comma does not shift every column after it', () => {
  // These tables run to a hundred and fifty columns. A naive split would read
  // a target share out of the wrong field and never look wrong enough to spot.
  assert.deepEqual(
    splitCsvLine('1,"Smith, Jr.",WR,0.25'),
    ['1', 'Smith, Jr.', 'WR', '0.25'],
  )
})

test('an escaped quote survives', () => {
  assert.deepEqual(splitCsvLine('a,"he said ""hi""",b'), ['a', 'he said "hi"', 'b'])
})

test('empty fields are kept, so column positions hold', () => {
  assert.deepEqual(splitCsvLine('a,,c,'), ['a', '', 'c', ''])
})

const allowed = (o: Partial<Allowed>): Allowed =>
  ({ team: 'CIN', pos: 'TE', perGame: 20, games: 17, rank: 1, of: 32, ...o })

test('a soft matchup is named, and so is a hard one', () => {
  assert.match(say(allowed({ rank: 1 }))!, /soft matchup.*CIN.*1st most to TEs/)
  assert.match(say(allowed({ rank: 32 }))!, /hard matchup.*1st least to TEs/)
})

test('the middle of the league says nothing, because there is nothing to say', () => {
  assert.equal(say(allowed({ rank: 16 })), null)
})

test('too few games means silence rather than a guessed adjective', () => {
  // Before any football is played there is no basis for a description, and an
  // invented one would read exactly like a real one.
  assert.equal(say(allowed({ rank: 1, games: 1 })), null)
  assert.equal(say(undefined), null)
})

test('ordinals read correctly where English is awkward', () => {
  const at = (rank: number) => say(allowed({ rank, of: 32 }))
  assert.match(at(2)!, /2nd most/)
  assert.match(at(3)!, /3rd most/)
  assert.match(at(1)!, /1st most/)
  // 11th, not 11st — the case a naive suffix table gets wrong.
  const hard = say(allowed({ rank: 22, of: 32 }))
  assert.match(hard!, /11th least/)
})

/* ------------------------------------------------- a defender's snap share */

const snapTable = (rows: string[][]) => ({
  head: ['player', 'team', 'position', 'week', 'game_type', 'defense_pct'],
  rows,
  col: (n: string) => ['player', 'team', 'position', 'week', 'game_type', 'defense_pct'].indexOf(n),
})
const asIs = (name: string) => name

test('a defender\'s role is the share of snaps he took, over the weeks he played', () => {
  const { roles } = snapShares(snapTable([
    ['Nate Landman', 'LA', 'LB', '1', 'REG', '0.9'],
    ['Nate Landman', 'LA', 'LB', '2', 'REG', '0.8'],
  ]), asIs)
  const r = roles.get('Nate Landman')!
  assert.equal(r.weeks, 2)
  assert.ok(Math.abs(r.share - 0.85) < 1e-9, `mean of 0.9 and 0.8, got ${r.share}`)
})

test('a week he never took the field is not a week of a smaller role', () => {
  /*
   * Counting it as zero would read an inactive week as a man losing his job,
   * and drag a full-time linebacker's share down by a quarter for missing one.
   */
  const { roles } = snapShares(snapTable([
    ['Nate Landman', 'LA', 'LB', '1', 'REG', '0.9'],
    ['Nate Landman', 'LA', 'LB', '2', 'REG', '0'],
  ]), asIs)
  assert.deepEqual(roles.get('Nate Landman'), { share: 0.9, weeks: 1 })
})

test('only the last few weeks count, and only the regular season', () => {
  const rows: string[][] = []
  for (let w = 1; w <= 8; w++) rows.push(['Nate Landman', 'LA', 'LB', String(w), 'REG', w <= 4 ? '0.4' : '0.9'])
  rows.push(['Nate Landman', 'LA', 'LB', '9', 'POST', '0.1'])
  const { roles, through } = snapShares(snapTable(rows), asIs)
  assert.equal(through, 8)
  assert.deepEqual(roles.get('Nate Landman'), { share: 0.9, weeks: 4 }, 'weeks 5 to 8, not the old role')
})
