import { test } from 'node:test'
import assert from 'node:assert/strict'
import { survivalAlert, MORNING } from './survival.js'
import type { Chop } from './yahooLeague.js'

const chop = (place: number, of = 17, cushion = 12.5): Chop => ({
  week: 3, place, of, projected: 120, points: 0, fromChop: 0, cushion,
  onTheBlock: place === of,
  bottom: [
    { teamId: 'a', name: 'Fifteenth', manager: 'A', mine: place === of - 2, projected: 110, points: 0, faab: 100 },
    { teamId: 'b', name: 'Sixteenth', manager: 'B', mine: place === of - 1, projected: 105, points: 0, faab: 100 },
    { teamId: 'c', name: 'Last', manager: 'C', mine: place === of, projected: 100, points: 0, faab: 100 },
  ],
  faab: 100, at: 0,
})
const L = { id: 'yahoo-guillotine', label: 'Harker Experi(Mental) League' }
// Sunday 27 September 2026, 1:00 pm Eastern.
const ONE_PM_SUNDAY = Date.UTC(2026, 8, 27, 17, 0)

test('bottom three on a Sunday morning is an alert', () => {
  const a = survivalAlert(chop(15), L, null, ONE_PM_SUNDAY - 3 * 3600_000, ONE_PM_SUNDAY)!
  assert.equal(a.rule, 'guillotine-risk')
  assert.match(a.headline, /projected 15th of 17, 12\.5 clear of the chop/)
  assert.equal(a.deadline, ONE_PM_SUNDAY)
})

test('on the block is louder than merely near it', () => {
  const block = survivalAlert(chop(17, 17, -4), L, null, ONE_PM_SUNDAY - 3600_000, ONE_PM_SUNDAY)!
  const near = survivalAlert(chop(15), L, null, ONE_PM_SUNDAY - 3600_000, ONE_PM_SUNDAY)!
  assert.ok(block.consequence > near.consequence)
  assert.match(block.headline, /projected lowest — 4\.0 behind/)
  assert.match(block.detail, /Sixteenth is next lowest/)
})

test('safely clear is not an alert', () => {
  assert.equal(survivalAlert(chop(14), L, null, ONE_PM_SUNDAY - 3600_000, ONE_PM_SUNDAY), null)
})

test('not on a Tuesday, and not before the morning starts', () => {
  const tuesday = Date.UTC(2026, 8, 22, 17, 0)
  assert.equal(survivalAlert(chop(16), L, null, tuesday - 3600_000, tuesday), null, 'Thursday-to-Monday games are not Sunday')
  assert.equal(survivalAlert(chop(16), L, null, ONE_PM_SUNDAY - MORNING - 60_000, ONE_PM_SUNDAY), null, 'Saturday night')
})

test('the wait for Sunday night football is not the morning', () => {
  const snf = Date.UTC(2026, 8, 28, 0, 20) // 8:20 pm Eastern, Sunday
  assert.equal(survivalAlert(chop(16), L, null, snf - 3600_000, snf), null)
})

test('one alert a week per league, whatever the tick', () => {
  const a = survivalAlert(chop(16), L, null, ONE_PM_SUNDAY - 5 * 3600_000, ONE_PM_SUNDAY)!
  const b = survivalAlert(chop(16), L, null, ONE_PM_SUNDAY - 3600_000, ONE_PM_SUNDAY)!
  assert.equal(a.id, b.id)
})

test('nothing read, nothing said', () => {
  assert.equal(survivalAlert(null, L, null, ONE_PM_SUNDAY - 3600_000, ONE_PM_SUNDAY), null)
})
