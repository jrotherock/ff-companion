import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kickoffAt } from './lock.js'

// Friday 4 September 2026, 09:00 local — the day this was written.
const FRI = new Date(2026, 8, 4, 9, 0, 0)

test('reads the printed kickoff into the coming week', () => {
  const sun = kickoffAt('Sun 1:25 pm', FRI)!
  const d = new Date(sun)
  assert.equal(d.getDay(), 0)
  assert.equal(d.getHours(), 13)
  assert.equal(d.getMinutes(), 25)
  assert.equal(d.getDate(), 6, 'the Sunday two days out, not next week')
})

test('morning games are not read as evening ones', () => {
  const d = new Date(kickoffAt('Sun 10:00 am', FRI)!)
  assert.equal(d.getHours(), 10)
})

test('a weekday already past today rolls to next week', () => {
  // Thursday 17:00 asked on a Friday morning is seven days out, not yesterday.
  const d = new Date(kickoffAt('Thu 5:20 pm', FRI)!)
  assert.equal(d.getDay(), 4)
  assert.ok(d.getTime() > FRI.getTime())
})

test('unknown kickoffs yield no deadline rather than a guessed one', () => {
  assert.equal(kickoffAt('whenever', FRI), null)
})
