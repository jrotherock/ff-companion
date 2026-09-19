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

test('a drop somebody has since claimed is a door that has shut', () => {
  /*
   * The first real Yahoo feed read back "Victor dropped Devin Bush" as news in
   * the league where the reader had picked Bush up the next morning.
   */
  const out = notable([move({ dropped: [P('Good', 'RB')] })], lens({ taken: new Set(['Good']) }))
  assert.deepEqual(out, [])
})

test('a guillotine release is not a judgement, but a good man released is news', () => {
  /*
   * Five "Tina dropped Brock Bowers, who is on your roster elsewhere" lines
   * were the chop emptying Tina's team, not Tina deciding anything.
   */
  const chop = lens({ chopped: new Set(['16']) })
  const out = notable([
    move({ teamId: '16', manager: 'Tina', dropped: [P('Mine', 'TE'), P('Good', 'RB'), P('Scrub', 'WR')] }),
  ], chop)
  assert.deepEqual(out.map((n) => n.player.id), ['Good', 'Mine'],
    'both are free again and worth having; the scrub is not, and nobody is "yours elsewhere"')
  assert.ok(out.every((n) => n.kind === 'dropped-worth-having'))
  assert.match(out[0].headline, /Good was released when Tina was chopped/)
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
