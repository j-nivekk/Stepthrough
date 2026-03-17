#!/bin/bash

# Exit on error
set -e

# Trap exit signal to kill background processes
trap "kill 0" EXIT

echo "🚀 Starting Stepthrough..."

# Start backend
echo "🐍 Starting backend..."
cd backend
uv run uvicorn app.main:app --reload &
BACKEND_PID=$!
cd ..

# Start frontend
echo "📦 Starting frontend..."
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo "✨ Stepthrough is running!"
echo "   Backend: http://127.0.0.1:8000"
echo "   Frontend: http://127.0.0.1:5173"
echo "   Press Ctrl+C to stop."

# Wait for both processes
wait
