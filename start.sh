#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

PORT="${PORT:-3080}"
EXISTING_PIDS=$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$EXISTING_PIDS" ]; then
  echo "Stopping existing server on port ${PORT} (PID: ${EXISTING_PIDS})..."
  kill $EXISTING_PIDS 2>/dev/null || true
  sleep 0.5
fi

echo "Starting AGY Web Console Server..."
exec node server.js
