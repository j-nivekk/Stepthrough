#!/usr/bin/env bash

set -e

echo "🔎 Setting up Stepthrough..."

echo "📦 Installing backend dependencies (uv)..."
cd backend
uv sync
cd ..

echo "📦 Installing frontend dependencies (npm)..."
cd frontend
npm install
cd ..

echo "✅ Setup complete! You can now run the app using ./start.sh"
