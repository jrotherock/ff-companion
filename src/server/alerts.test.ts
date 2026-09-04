import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { admitBatch, rank, markSent, spent, setBudget, ALWAYS } from './alerts.js'

const STORE = 'fixtures/alerts.json'
const a = (id: string, consequence: number, deadline: number | null = null) => ({
  id, leagueId: 'l', rule: 'r', headline: id, detail: '', consequence, deadline, link: null,
})

beforeEach(() => { writeFileSync(STORE, JSON.stringify({ sent: [], budget: 20 })) })

test('a season-ending consequence is never rationed', () => {
  setBudget(0)
  const { send } = admitBatch([a('out', 90), a('minor', 20)])
  assert.deepEqual(send.map((x) => x.id), ['out'])
})

test('spends the budget on the most costly to miss', () => {
  setBudget(2)
  const { send, held } = admitBatch([a('low', 10), a('mid', 60), a('high', 70)])
  assert.deepEqual(send.map((x) => x.id), ['high', 'mid'])
  assert.equal(held[0].why, 'budget')
})

test('says the same thing once', () => {
  const one = a('dup', 50)
  assert.equal(admitBatch([one]).send.length, 1)
  markSent(one)
  const { send, held } = admitBatch([one])
  assert.equal(send.length, 0)
  assert.equal(held[0].why, 'duplicate')
})

test('drops what can no longer be acted on', () => {
  const { send, held } = admitBatch([a('gone', 60, Date.now() - 1000)])
  assert.equal(send.length, 0)
  assert.equal(held[0].why, 'expired')
})

test('the week rolls rather than resetting', () => {
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
  writeFileSync(STORE, JSON.stringify({
    sent: [{ id: 'old', at: eightDaysAgo, consequence: 50, rule: 'r' }], budget: 1,
  }))
  assert.equal(spent().length, 0, 'a send from last week should not count against this one')
  assert.equal(admitBatch([a('fresh', 50)]).send.length, 1)
})

test('ties break toward the sooner deadline', () => {
  const soon = a('soon', 50, Date.now() + 1000)
  const later = a('later', 50, Date.now() + 90000)
  assert.deepEqual(rank([later, soon]).map((x) => x.id), ['soon', 'later'])
})

test('the always-fire floor is below a ruled-out starter and above a nudge', () => {
  assert.ok(ALWAYS > 70 && ALWAYS <= 90)
})
