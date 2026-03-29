#!/usr/bin/env bash

set -euo pipefail

echo "🚀 Starting Stepthrough..."

ensure_port_available() {
  local label="$1"
  local port="$2"

  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "$label port $port is already in use. Stop the existing process and try again."
    exit 1
  fi
}

ensure_port_available "Backend" 8000
ensure_port_available "Frontend" 5173

# Start backend in the background
echo "Starting backend (FastAPI on port 8000)..."
(cd backend && uv run uvicorn app.main:app --reload) &
BACKEND_PID=$!

# Start frontend in the foreground
echo "Starting frontend (Vite on port 5173)..."
(cd frontend && npm run dev) &
FRONTEND_PID=$!

# Ensure background processes are cleaned up when this script exits
trap 'echo "Stopping Stepthrough..."; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null' EXIT

wait_for_url() {
  local label="$1"
  local url="$2"
  local pid="$3"

  until curl --silent --output /dev/null --fail "$url"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$label stopped before becoming ready."
      return 1
    fi
    sleep 0.5
  done
}

echo "Waiting for backend health check..."
wait_for_url "Backend" "http://127.0.0.1:8000/health" "$BACKEND_PID"

echo "Waiting for frontend dev server..."
wait_for_url "Frontend" "http://localhost:5173/" "$FRONTEND_PID"

echo "✅ Both servers are ready. Press Ctrl+C to stop."
wait
