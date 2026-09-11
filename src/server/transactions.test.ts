import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notable, activity, type Move, type Lens } from './transactions.js'

const P = (id: string, pos: string) => ({ id, name: id, pos })
const move = (over: Partial<Move>): Move => ({
  id: 'm', at: 1_000, type: 'add/drop', manager: 'Rival',
  added: [], dropped: [], ...over,
})

const lens = (over: Partial<Lens> = {}): Lens => ({
  mine: new Set(['Mine']),
  holes: ['RB'],
  value: (id) => ({ Good: 14, Scrub: 1, Mine: 11 } as Record<string, number>)[id] ?? null,
  ...over,
})

test('a dropped scrub is not news, however recently it happened', () => {
  const out = notable([move({ dropped: [P('Scrub', 'WR')] })], lens())
  assert.equal(out.length, 0, 'somebody dropped somebody is true four times an hour')
})

test('a dropped player worth having is, and more so at a position I need', () => {
  const away = notable([move({ dropped: [P('Good', 'WR')] })], lens())[0]
  const wanted = notable([move({ dropped: [P('Good', 'RB')] })], lens())[0]
  assert.equal(away.kind, 'dropped-worth-having')
  assert.ok(wanted.consequence > away.consequence, 'a free upgrade at a hole outranks one elsewhere')
  assert.match(wanted.headline, /you are thin at RB/)
})

test('a rival filling my hole is worth knowing and not worth waking up for', () => {
  const out = notable([move({ added: [P('Anyone', 'RB')] })], lens())
  assert.equal(out[0].kind, 'rival-filling-my-hole')
  assert.ok(out[0].consequence < 30, 'it narrows the pool rather than opening one')
})

test('a player I hold being dropped elsewhere is flagged whatever he is worth', () => {
  // Cheap to say and it changes what my own man is worth.
  const out = notable([move({ dropped: [P('Mine', 'TE')] })], lens())
  assert.equal(out[0].kind, 'touched-mine')
})

test('the feed is ordered by what matters, not by the clock', () => {
  const out = notable([
    move({ id: 'late', at: 9_000, added: [P('Anyone', 'RB')] }),
    move({ id: 'early', at: 1_000, dropped: [P('Good', 'RB')] }),
  ], lens())
  assert.equal(out[0].move.id, 'early',
    'a starting back hitting waivers outranks a defence stream from an hour later')
})

test('activity counts who would actually answer a trade offer', () => {
  const a = activity([
    move({ manager: 'Busy', at: 10 }), move({ manager: 'Busy', at: 20 }),
    move({ manager: 'Asleep', at: 5 }),
  ], 8)
  assert.equal(a.get('Busy'), 2)
  assert.equal(a.get('Asleep'), undefined, 'before the window is not activity')
})
