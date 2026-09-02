#!/usr/bin/env bash
# Run the companion detached, so it outlives the terminal that started it.
#
# Both apps are one process on one URL: / is the draft companion, /cockpit is
# the four-league view. Restarting replaces whatever is already on the port.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/node/bin:$PATH"

pkill -f "tsx src/server" 2>/dev/null || true
sleep 1
nohup npx tsx src/server/index.ts > /tmp/ff-companion.log 2>&1 &
disown

for _ in $(seq 1 20); do
  if curl -s -m 2 -o /dev/null http://localhost:4600/api/leagues; then
    echo "companion   http://localhost:4600"
    echo "cockpit     http://localhost:4600/cockpit"
    echo "log         /tmp/ff-companion.log"
    exit 0
  fi
  sleep 1
done
echo "did not come up — see /tmp/ff-companion.log" >&2
tail -5 /tmp/ff-companion.log >&2
exit 1
