#!/usr/bin/env bash

set -e

echo "🚀 Starting Stepthrough..."

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

echo "✅ Both servers are running. Press Ctrl+C to stop."
wait
