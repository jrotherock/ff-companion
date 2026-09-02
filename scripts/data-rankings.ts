/**
 * Boards, then defence, in that order, for the leagues you name.
 *
 * Chaining the two with `&&` inside an npm script looked fine and quietly
 * broke: npm appends `-- <args>` to the end of the whole string, so a league
 * filter reached the IDP script and the board fetch refreshed everything. This
 * forwards the same arguments to both, which is what a caller expects.
 *
 * The order is not cosmetic. The board fetch overwrites each rankings file
 * wholesale, so running it without the IDP step afterwards strips every
 * defensive player off the leagues that roster them.
 */
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
for (const script of ['scripts/fetch-rankings.ts', 'scripts/fetch-idp.ts']) {
  const run = spawnSync('npx', ['tsx', script, ...args], { stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
