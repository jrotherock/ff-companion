/**
 * Ranking that nothing downstream can see is not a ranking. Every alert
 * carried a consequence and every one of them went out as the same flat push.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { levelFor, deliveryFor } from './priority.js'

const a = (rule: string, consequence: number) => ({ rule, consequence })

test('a starter who will not play knocks hard and stays on screen', () => {
  const d = deliveryFor(a('starter-out', 90))
  assert.equal(d.level, 'high')
  assert.equal(d.urgency, 'high')
  assert.equal(d.requireInteraction, true, 'a hole in the lineup must not fade unread')
  assert.equal(d.pushoverPriority, 1)
})

test('a role change is true, useful, and never worth interrupting a meal for', () => {
  const d = deliveryFor(a('role-changing', 70))
  assert.equal(d.level, 'low', 'the score alone would have made this normal')
  assert.equal(d.urgency, 'low')
  assert.equal(d.requireInteraction, false)
})

test('a missed draft cannot be undone, whatever it scores', () => {
  assert.equal(levelFor(a('draft-imminent', 40)), 'high')
})

test('an unlisted rule is ranked by its consequence alone', () => {
  assert.equal(levelFor(a('something-new', 95)), 'high')
  assert.equal(levelFor(a('something-new', 50)), 'normal')
  assert.equal(levelFor(a('something-new', 10)), 'low')
})

test('only the top tier holds the screen', () => {
  for (const c of [79, 50, 31]) {
    assert.equal(deliveryFor(a('x', c)).requireInteraction, false, `${c} should fade`)
  }
  assert.equal(deliveryFor(a('x', 80)).requireInteraction, true)
})

test('the low tier is quieter than silence is loud', () => {
  // Negative on Pushover means "no sound, no vibration" rather than "do not send".
  assert.equal(deliveryFor(a('roster-stale', 45)).pushoverPriority, -1)
})
