import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brokenLineup, brokenWhy, type Slotted } from './opponent.js'

const p = (
  name: string, injuryStatus: string | null, projected: number | null,
  game: Slotted['game'] = 'pre',
): Slotted => ({ id: name, name, pos: 'WR', injuryStatus, projected, game })

test('a lineup with nobody ruled out is not broken', () => {
  assert.equal(brokenLineup([p('Fit', null, 12), p('Also Fit', 'Q', 9)]), null,
    'questionable is not out, and treating it as out would cry wolf every week')
})

test('the hole is measured by what the site still has him down for', () => {
  const b = brokenLineup([p('Fit', null, 12), p('Hurt', 'Out', 11.8), p('Also Hurt', 'IR', 4)])!
  assert.equal(b.slots.length, 2)
  assert.equal(b.points, 15.8)
  assert.equal(b.slots[0].name, 'Hurt', 'worst hole first, because that is the one that decides it')
})

test('a slot he can still fill is not the same as one he cannot', () => {
  const before = brokenLineup([p('Hurt', 'Out', 11.8, 'pre')])!
  assert.equal(before.fixable, 1)
  const after = brokenLineup([p('Hurt', 'Out', 11.8, 'done')])!
  assert.equal(after.fixable, 0)
  assert.match(brokenWhy(after, false), /too late for him to change it/)
  assert.doesNotMatch(brokenWhy(before, false), /too late/)
})

test('the same reading is phrased as a job on my side and as news on his', () => {
  const b = brokenLineup([p('Hurt', 'Out', 11.8)])!
  assert.match(brokenWhy(b, true), /is out and is in your lineup/)
  assert.match(brokenWhy(b, false), /Your opponent is starting Hurt/)
  assert.match(brokenWhy(b, false), /11\.8 projected points in slots that cannot score them/)
})

test('doubtful counts, because the rest of the app already treats it as out', () => {
  // The two halves disagreed once: the feed called Brock Bowers out while the
  // optimiser had him starting for 11.5.
  assert.ok(brokenLineup([p('Bowers', 'Doubtful', 11.5)]))
})
