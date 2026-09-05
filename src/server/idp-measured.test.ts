/**
 * `data/idp-measured.json` pins the IDP board to an order measured under this
 * league's own scoring. It is hand-curated, and a wrong id fails silently: the
 * defender simply never appears, which is exactly how an unsigned Bobby Wagner
 * went missing from the board while sitting at LB5 on the likes list.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import type { Player } from '../kernel/types.js'

const FILE = 'data/idp-measured.json'

const load = () => {
  const { players } = JSON.parse(readFileSync('data/players.json', 'utf8')) as { players: Player[] }
  const measured = JSON.parse(readFileSync(FILE, 'utf8')) as {
    positions: Record<string, { posRank: number; playerId: string; name: string }[]>
  }
  return { byId: new Map(players.map((p) => [p.id, p])), measured }
}

test('every measured defender is in the player map at the position he is ranked under', {
  skip: existsSync(FILE) ? false : 'no measured IDP file',
}, () => {
  const { byId, measured } = load()
  for (const [pos, rows] of Object.entries(measured.positions)) {
    for (const row of rows) {
      const p = byId.get(row.playerId)
      assert.ok(p, `${row.name} (${row.playerId}) is ranked ${pos}${row.posRank} but is not in the player map`)
      assert.equal(p.pos, pos, `${row.name} is ${p.pos} in the player map, ranked under ${pos}`)
    }
  }
})

test('no defender is ranked twice, and each position numbers from one without a gap', {
  skip: existsSync(FILE) ? false : 'no measured IDP file',
}, () => {
  const { measured } = load()
  const seen = new Map<string, string>()
  for (const [pos, rows] of Object.entries(measured.positions)) {
    rows.forEach((row, i) => {
      const before = seen.get(row.playerId)
      assert.equal(before, undefined, `${row.name} is ranked in both ${before} and ${pos}`)
      seen.set(row.playerId, pos)
      assert.equal(row.posRank, i + 1, `${pos} ranks jump at ${row.name}: ${row.posRank} where ${i + 1} was due`)
    })
  }
})

test('an unsigned veteran is kept, since the consensus board is what omits him', {
  skip: existsSync(FILE) ? false : 'no measured IDP file',
}, () => {
  const { byId, measured } = load()
  const unsigned = Object.values(measured.positions)
    .flat()
    .filter((r) => byId.get(r.playerId)?.team === 'FA')
  for (const r of unsigned) {
    const p = byId.get(r.playerId)!
    // No club means no bye week; anything reading one must cope with null.
    assert.equal(p.byeWeek, null, `${p.name} has no club but carries bye week ${p.byeWeek}`)
  }
})
