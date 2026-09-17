/**
 * Reading the WR/CB column.
 *
 * The markup here is copied from the real article, traps included: body copy
 * with a bolded phrase in it, a paragraph holding nothing but a screenshot,
 * a curly apostrophe left as an entity, and a week whose corner is linked
 * where last week's was not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMatchups, pairOf, findArticle, text } from './wrcb.js'

const ARTICLE = `
<h2><span id="Week_1_WRCB_Matchup_Upgrades">Week 1 WR/CB Matchup Upgrades</span></h2>
<p><strong><a class="rbPlayer nfl" href="/nfl/player/23170/Wan'Dale+Robinson">Wan&#8217;Dale Robinson</a> vs. Jarvis Brownlee Jr.</strong></p>
<p><strong>Robinson vs. zone coverage</strong> was a mismatch all year, and after Brian Daboll became the Titans&#8217; offensive coordinator he signed a <strong>beefy contract</strong>.</p>
<p><a href="/x.png" class="glightbox"><img src="/x.png" alt=""></a></p>
<p><strong><a class="rbPlayer nfl" href="/p/2">Parker Washington</a> vs. <a class="rbPlayer nfl" href="/p/3">Myles Harden</a></strong></p>
<p>Washington led the Jaguars&#8217; pass catchers in yards.</p>
<h2><span id="Week_1_WRCB_Matchup_Downgrades">Week 1 WR/CB Matchup Downgrades</span></h2>
<p><strong><a class="rbPlayer nfl" href="/p/4">DJ Moore</a> vs. Derek Stingley Jr.</strong></p>
<p>Moore&#8217;s usage changed with the Bears in 2025.</p>
<h2><span id="More_Fantasy_Football_Analysis">More Fantasy Football Analysis</span></h2>
<p><strong><a href="/p/9">Somebody Else</a> vs. Another Corner</strong></p>
<p>This sits under a different heading and is not a matchup.</p>
`

test('reads both sides of the column, and which way each one cuts', () => {
  const got = parseMatchups(ARTICLE)
  assert.equal(got.length, 3)
  assert.deepEqual(got.map((m) => [m.receiver, m.corner, m.side]), [
    ['Wan’Dale Robinson', 'Jarvis Brownlee Jr.', 'upgrade'],
    ['Parker Washington', 'Myles Harden', 'upgrade'],
    ['DJ Moore', 'Derek Stingley Jr.', 'downgrade'],
  ])
})

test('a pair under a later heading is not swallowed', () => {
  /*
   * "More Fantasy Football Analysis" is a list of links to other columns, and
   * some of them are headed like a matchup. Reading to the end of the article
   * instead of to the next heading put a promo for another writer's piece in
   * the lineup advice.
   */
  const got = parseMatchups(ARTICLE)
  assert.ok(!got.some((m) => m.receiver === 'Somebody Else'), 'stops at the next heading')
})

test('a bolded phrase in body copy is not a new matchup', () => {
  /*
   * "Robinson vs. zone coverage" is bold, mid-paragraph, and says "vs" — which
   * is every signal a heading has except the one that counts, that a heading is
   * the whole of its paragraph. Searching for bold anywhere inside a paragraph
   * turned a sentence about coverage shells into a matchup against a
   * cornerback named Zone Coverage.
   */
  const got = parseMatchups(ARTICLE)
  assert.equal(got.length, 3, 'three matchups, not four')
  assert.ok(!got.some((m) => /zone coverage/i.test(m.corner)), 'no corner called Zone Coverage')
  assert.match(got[0].why, /beefy contract/, 'the paragraph stays with its matchup')
})

test('the screenshot between paragraphs says nothing', () => {
  /*
   * Each entry carries the player's row from the chart as an image, in a
   * paragraph of its own. It holds the numbers and they are pixels, so there
   * is no sentence to take from it — and appending what it strips down to left
   * the rationale trailing whitespace where the picture had been.
   */
  const got = parseMatchups(ARTICLE)
  assert.equal(
    got[0].why,
    'Robinson vs. zone coverage was a mismatch all year, and after Brian Daboll ' +
    'became the Titans’ offensive coordinator he signed a beefy contract.',
  )
  assert.equal(got[1].why, 'Washington led the Jaguars’ pass catchers in yards.')
})

test('entities come back as the letters they stand for', () => {
  // A name carrying &#8217; matches nothing in the player index.
  assert.equal(text('Wan&#8217;Dale Robinson'), 'Wan’Dale Robinson')
  assert.equal(text('Ja&#x27;Marr &amp; Tee'), "Ja'Marr & Tee")
})

test('the corner is found whether or not he is linked', () => {
  // Some weeks he is in their player database and some weeks he is not, so
  // the link cannot be what tells the two men apart — the "vs." can.
  assert.deepEqual(pairOf('<a href="/p/2">Parker Washington</a> vs. <a href="/p/3">Myles Harden</a>'),
    { receiver: 'Parker Washington', corner: 'Myles Harden' })
  assert.deepEqual(pairOf('Parker Washington vs Myles Harden'),
    { receiver: 'Parker Washington', corner: 'Myles Harden' })
})

const posts = (titles: string[]) => ({
  ok: true,
  json: async () => titles.map((t, i) => ({ link: `https://x/${i}`, title: { rendered: t } })),
}) as unknown as Response

test('finds this week and refuses last week', async () => {
  /*
   * The search returns the column for every week it has ever run, newest
   * first, and the URL carries an opaque post id so it cannot be built. Taking
   * the first result would have read week one's matchups all season.
   */
  const get = async () => posts([
    'WR/CB Matchups to Upgrade and Downgrade - Fantasy Football Week 2 (2026)',
    'WR/CB Matchups to Upgrade and Downgrade - Fantasy Football Week 1 (2026)',
  ])
  assert.equal(await findArticle(2026, 1, get as any), 'https://x/1')
  assert.equal(await findArticle(2026, 2, get as any), 'https://x/0')
})

test('last season\'s week two is not this season\'s', async () => {
  const get = async () => posts(['WR/CB Matchups to Upgrade and Downgrade - Fantasy Football Week 2 (2025)'])
  assert.equal(await findArticle(2026, 2, get as any), null)
})

test('a different column that mentions the week is not the column', async () => {
  // Their search matches loosely: "Wide Receiver Matchups to Target" comes
  // back for the same query and is a different article entirely.
  const get = async () => posts(['Wide Receiver Matchups to Target For Week 2 (2026)'])
  assert.equal(await findArticle(2026, 2, get as any), null)
})
