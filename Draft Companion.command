#!/bin/bash
# Double-click launcher. Starts the companion and opens it in the browser.
cd "$(dirname "$0")" || exit 1

# Node lives in the home directory on this machine; there is no Homebrew.
export PATH="$HOME/.local/node/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Node is missing. Expected it at ~/.local/node/bin."
  echo "Press any key to close."; read -r -n 1; exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)…"
  npm install --silent || { echo "npm install failed."; read -r -n 1; exit 1; }
fi

# Build the UI if it is missing or older than the source.
NEEDS_BUILD=0
[ -d dist ] || NEEDS_BUILD=1
if [ -d dist ]; then
  if [ -n "$(find src/ui -newer dist/index.html -type f -print -quit 2>/dev/null)" ]; then
    NEEDS_BUILD=1
  fi
fi
if [ "$NEEDS_BUILD" = "1" ]; then
  echo "Building the interface…"
  npx vite build >/dev/null 2>&1 || { echo "Build failed."; read -r -n 1; exit 1; }
fi

PORT="${PORT:-4600}"

# If it is already running, just open it rather than starting a second copy.
if curl -s -o /dev/null "http://localhost:$PORT/api/leagues"; then
  echo "Already running — opening."
  open "http://localhost:$PORT"
  exit 0
fi

echo "Starting the draft companion on http://localhost:$PORT"
echo "Leave this window open. Close it to stop."
echo

npx tsx src/server/index.ts &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM

for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://localhost:$PORT/api/leagues" && break
  sleep 0.25
done

open "http://localhost:$PORT"
echo "Also reachable on this network at: http://$(ipconfig getifaddr en0 2>/dev/null || echo localhost):$PORT"
wait $SERVER_PID
