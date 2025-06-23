#!/bin/bash

# Test script for CDP Bridge functionality
# Starts the server, runs tests, then stops the server

set -e

echo "🚀 Starting browser-go server..."

# Start server in background
pnpm start &
SERVER_PID=$!

# Function to cleanup on exit
cleanup() {
    echo "🛑 Stopping server (PID: $SERVER_PID)..."
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
    echo "✅ Server stopped"
}

# Set trap to cleanup on script exit
trap cleanup EXIT

# Wait for server to start
echo "⏳ Waiting for server to start..."
sleep 3

# Check if server is running
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "❌ Server failed to start"
    exit 1
fi

echo "✅ Server started (PID: $SERVER_PID)"
echo ""

# Run the bridge tests
echo "🧪 Running CDP Bridge tests..."
pnpm run test:bridge

echo ""
echo "🎉 All tests completed!"