#!/bin/sh
# Run the app against a Yahoo recording instead of Yahoo, on port 4601.
#
#   sh scripts/replay-local.sh [fixtures/yahoo-recording-<date>.json]
#
# The Yahoo token lives only on Railway, so a local run cannot call Yahoo;
# this replays answers recorded through the deployed server instead. It runs
# on a copy of the local state, so the replayed rosters never land in the
# stores your own local server and the extension keep.
set -e
cd "$(dirname "$0")/.."
PATH="$HOME/.local/node/bin:$PATH"
REC="${1:-$(ls -t fixtures/yahoo-recording-*.json 2>/dev/null | head -1)}"
if [ -z "$REC" ]; then echo "no recording in fixtures/ — record one first" >&2; exit 1; fi
STATE="${TMPDIR:-/tmp}/ff-replay-state"
rm -rf "$STATE"
cp -R fixtures "$STATE"
echo "replaying $REC on a copy of the local state in $STATE"
STATE_DIR="$STATE" YAHOO_REPLAY="$PWD/$REC" PORT="${PORT:-4601}" \
  exec npx tsx --env-file-if-exists=.env src/server/index.ts
