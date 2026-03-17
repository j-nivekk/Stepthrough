#!/bin/bash

# Exit on error
set -e

echo "🚀 Setting up Stepthrough..."

# Check for prerequisites
check_tool() {
    if ! command -v "$1" &> /dev/null; then
        echo "❌ Error: $1 is not installed."
        if [ "$1" == "uv" ]; then
            echo "   Please install uv: https://github.com/astral-sh/uv"
        elif [ "$1" == "ffmpeg" ]; then
            echo "   Please install FFmpeg: https://ffmpeg.org/download.html"
        fi
        exit 1
    fi
}

check_tool "node"
check_tool "npm"
check_tool "uv"
check_tool "ffmpeg"

echo "✅ All prerequisites found."

# Frontend setup
echo "📦 Installing frontend dependencies..."
cd frontend
npm install
cd ..

# Backend setup
echo "🐍 Installing backend dependencies..."
cd backend
uv sync
cd ..

echo "✨ Setup complete! Run ./start.sh to begin."
