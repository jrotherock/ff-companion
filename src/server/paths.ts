import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where mutable state lives.
 *
 * Local runs keep it in the repo, where it has always been. A container keeps
 * it on a mounted volume, because a deploy replaces the filesystem and
 * everything here is state that cannot be recovered by rebuilding: the Yahoo
 * captures that only arrive when a page is open, the push subscriptions, the
 * snapshots the diffing sensor needs to know what changed, and the draft
 * archive.
 */
export const STATE_DIR = process.env.STATE_DIR ?? 'fixtures'

/** Resolve a state file, creating the directory the first time. */
export function statePath(name: string): string {
  try { mkdirSync(STATE_DIR, { recursive: true }) } catch { /* already there */ }
  return join(STATE_DIR, name)
}
