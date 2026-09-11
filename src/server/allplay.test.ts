import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allPlay, luck, actualFrom, type WeekScores } from './allplay.js'

/*
 * Four teams, two weeks. A scores well and keeps drawing the best team; D
 * scores badly and keeps drawing worse. That is the whole point of the
 * measure, so it is what the fixture is built to show.
 */
const weeks: WeekScores[] = [
  { week: 1, teams: [
    { teamId: 'A', points: 120 }, { teamId: 'B', points: 130 },
    { teamId: 'C', points: 80 }, { teamId: 'D', points: 90 },
  ] },
  { week: 2, teams: [
    { teamId: 'A', points: 110 }, { teamId: 'B', points: 115 },
    { teamId: 'C', points: 70 }, { teamId: 'D', points: 75 },
  ] },
]
// A always plays B, C always plays D.
const draw = (_w: number, id: string) =>
  ({ A: 'B', B: 'A', C: 'D', D: 'C' } as Record<string, string>)[id] ?? null

test('all-play scores every team against every other, not against its draw', () => {
  const t = allPlay(weeks)
  const by = Object.fromEntries(t.map((x) => [x.teamId, x]))
  // A beats C and D twice each and loses to B twice: 4-2.
  assert.deepEqual(
    [by.A.wins, by.A.losses, by.A.ties], [4, 2, 0],
    'second best in the league, both weeks',
  )
  assert.deepEqual([by.B.wins, by.B.losses, by.B.ties], [6, 0, 0], 'best, both weeks')
  assert.deepEqual([by.C.wins, by.C.losses, by.C.ties], [0, 6, 0], 'worst, both weeks')
})

test('the luckiest and unluckiest teams are the ends of the table', () => {
  const deserved = allPlay(weeks)
  const actual = actualFrom(weeks, draw)
  const out = luck(actual, deserved)

  const a = out.find((x) => x.teamId === 'A')!
  const d = out.find((x) => x.teamId === 'D')!
  // A is the second best team and 0-2, because it drew the best one twice.
  assert.deepEqual([a.actual.wins, a.actual.losses], [0, 2])
  assert.ok(a.games! < 0, 'the second best side in the league has nothing to show for it')
  // D is the second worst and 2-0, because it drew the worst one twice.
  assert.deepEqual([d.actual.wins, d.actual.losses], [2, 0])
  assert.ok(d.games! > 0, 'and the second worst is unbeaten')
  assert.equal(out[0].teamId, 'D', 'ordered by how flattering the record is')
  assert.equal(out[out.length - 1].teamId, 'A')
})

test('a tie is half a win rather than nothing at all', () => {
  const level: WeekScores[] = [
    { week: 1, teams: [{ teamId: 'A', points: 100 }, { teamId: 'B', points: 100 }] },
  ]
  const t = allPlay(level)
  assert.deepEqual([t[0].wins, t[0].losses, t[0].ties], [0, 0, 1])
  assert.equal(t[0].pct, 0.5, 'level with the league is a rate of one half, not of nought')
})

test('before anybody has played there is no rate to report', () => {
  assert.deepEqual(allPlay([]), [])
  const none = actualFrom([], draw)
  assert.deepEqual(none, [])
})
