import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitCsvLine } from './nflverseCsv.js'
import { describe as say, type Allowed } from './dvp.js'

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
