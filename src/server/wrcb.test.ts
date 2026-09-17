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
import {
  parseMatchups, pairOf, findArticle, text, consistent, chartRowsFromText, likeliest, validateChart,
} from './wrcb.js'

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
})

test('the verdict is kept and the reasoning is left on their page', () => {
  /*
   * Each entry's reasoning is several paragraphs of RotoBaller's own analysis,
   * theirs to publish and one click away. Taking a copy also meant deciding
   * where one entry's prose ended, which in week two came down to a length cap
   * standing between Michael Pittman's write-up and a subscription promo that
   * sat inside the same section.
   */
  const got = parseMatchups(ARTICLE)
  assert.ok(got.length)
  for (const m of got) assert.deepEqual(Object.keys(m).sort(), ['corner', 'receiver', 'side'])
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

/* ---------------------------------------------------------------- the chart */

test('a row survives its own rounding', () => {
  // Week two as printed: 20.30 - 18.74 is 1.56 exactly, and 17.22 - 16.63 is
  // 0.59 against a printed 0.60 \u2014 three values rounded separately.
  assert.ok(consistent({ offence: 20.30, defence: 18.74, score: 1.56 }))
  assert.ok(consistent({ offence: 17.22, defence: 16.63, score: 0.60 }))
})

test('a misread digit does not', () => {
  // Chris Olave's 23.30 read as 28.30 would make a +10 matchup a +15 one.
  assert.ok(!consistent({ offence: 28.30, defence: 13.18, score: 10.12 }))
  // A slip in the tenths is enough to be caught.
  assert.ok(!consistent({ offence: 23.30, defence: 13.18, score: 10.21 }))
})

test('a row comes in with the marks the chart printed on it', () => {
  const [r] = chartRowsFromText('Romeo Doubs|NE|21|0.39|1.73|18.34|Joey Porter Jr.|PIT|8|0.09|0.47|20.94|-2.59|j')
  assert.deepEqual(r, {
    receiver: 'Romeo Doubs', team: 'NE', offence: 18.34, corner: 'Joey Porter Jr.', cornerTeam: 'PIT',
    defence: 20.94, score: -2.59, slot: false, receiverHurt: false, cornerHurt: true, safety: false,
  })
})

test('a line with a field missing is refused rather than shifted', () => {
  // One column short and every number after it would be read from its
  // neighbour: the allowed yards per route taken for the defence score.
  assert.throws(
    () => chartRowsFromText('Romeo Doubs|NE|21|0.39|1.73|18.34|Joey Porter Jr.|PIT|8|0.09|20.94|-2.59|j'),
    /expected 14 fields/,
  )
})

test('a receiver listed twice is read against the corner expected to play', () => {
  const rows = chartRowsFromText([
    'Romeo Doubs|NE|21|0.39|1.73|18.34|Joey Porter Jr.|PIT|8|0.09|0.47|20.94|-2.59|j',
    'Romeo Doubs|NE|21|0.39|1.73|18.34|Asante Samuel Jr.|PIT|5|0.23|0.82|16.72|1.63|',
  ].join('\n'))
  assert.equal(likeliest(rows)!.corner, 'Asante Samuel Jr.', 'not the injured Porter')
})

test('and where both corners are healthy, the chart\'s own first choice', () => {
  const rows = chartRowsFromText([
    'Adonai Mitchell|NYJ|25|0.33|1.70|18.05|Carrington Valentine|GB|8|0.19|0.71|16.48|1.58|',
    'Adonai Mitchell|NYJ|25|0.33|1.70|18.05|Brandon Cisse|GB|4|0.23|0.81|16.48|1.58|',
  ].join('\n'))
  assert.equal(likeliest(rows)!.corner, 'Carrington Valentine')
})

/* ------------------------------------------------ a chart arriving over the wire */

const LINK = 'https://www.rotoballer.com/wr-cb-matchups-for-fantasy-football-sleepers-targets-for-week-2-2026/1931598'
const olave = (over: Record<string, unknown> = {}) => ({
  receiver: 'Chris Olave', team: 'NO', offence: 23.30, corner: 'Marlon Humphrey', cornerTeam: 'BLT',
  defence: 13.18, score: 10.12, slot: false, receiverHurt: false, cornerHurt: false, safety: false, ...over,
})
const nacua = () => ({
  receiver: 'Puka Nacua', team: 'LA', offence: 30.34, corner: 'Greg Newsome II', cornerTeam: 'NYG',
  defence: 13.45, score: 16.89, slot: false, receiverHurt: false, cornerHurt: false, safety: false,
})

test('a chart that checks out comes through whole', () => {
  const got = validateChart({ season: 2026, week: 2, link: LINK, rows: [olave(), nacua()] })
  assert.ok(got.ok)
  if (got.ok) assert.equal(got.chart.rows.length, 2)
})

test('one row that fails its own arithmetic refuses the whole chart', () => {
  /*
   * Not the good row published and the bad one dropped: a chart with a
   * receiver quietly missing looks complete from every screen that reads it.
   */
  const got = validateChart({ season: 2026, week: 2, link: LINK, rows: [olave({ offence: 28.30 }), nacua()] })
  assert.equal(got.ok, false)
  if (!got.ok) assert.match(got.errors[0], /Chris Olave/)
})

test('a link that is not a RotoBaller page never becomes an href', () => {
  // It is rendered as a link on every row the chart tags.
  for (const link of [
    'javascript:alert(1)',
    'https://evil.example/wr-cb',
    'http://www.rotoballer.com/wr-cb',
    'https://www.rotoballer.com.evil.example/wr-cb',
  ]) {
    assert.equal(validateChart({ season: 2026, week: 2, link, rows: [olave()] }).ok, false, link)
  }
  assert.ok(validateChart({ season: 2026, week: 2, link: null, rows: [olave()] }).ok, 'no link at all is fine')
})

test('a name that is not a name is refused', () => {
  assert.equal(validateChart({ season: 2026, week: 2, link: LINK,
    rows: [olave({ receiver: '<img src=x onerror=alert(1)>' })] }).ok, false)
  // The marks names really carry are not refused along with it.
  for (const receiver of ["Ja'Marr Chase", 'D.J. Reed', 'Amon-Ra St. Brown', "Tre' Harris", 'Luther Burden III']) {
    assert.ok(validateChart({ season: 2026, week: 2, link: LINK, rows: [olave({ receiver })] }).ok, receiver)
  }
})

test('the season and week are what they claim, since they name the file', () => {
  for (const [season, week] of [[2026, 0], [2026, 23], [2026, 2.5], ['2026', 2], [1999, 2]]) {
    assert.equal(validateChart({ season, week, link: LINK, rows: [olave()] }).ok, false, `${season} ${week}`)
  }
})

test('nothing the chart did not print rides along', () => {
  const got = validateChart({ season: 2026, week: 2, link: LINK, rows: [olave({ note: 'anything', admin: true })] })
  assert.ok(got.ok)
  if (got.ok) assert.deepEqual(Object.keys(got.chart.rows[0]).sort(),
    ['corner', 'cornerHurt', 'cornerTeam', 'defence', 'offence', 'receiver', 'receiverHurt', 'safety', 'score', 'slot', 'team'])
})
