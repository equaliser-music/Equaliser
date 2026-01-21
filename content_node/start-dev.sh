#!/bin/bash

# Equaliser Content Node - Development Server
# This script starts the local NOSTR relay and serves the orchestrator tools

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$SCRIPT_DIR/nostr-relay"
ORCHESTRATOR_DIR="$SCRIPT_DIR/orchestrator"
PORT=${1:-8000}

echo "=================================="
echo "  Equaliser Content Node Dev"
echo "=================================="
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "Error: Docker is not running. Please start Docker first."
    exit 1
fi

# Start the NOSTR relay
echo "Starting NOSTR relay..."
cd "$RELAY_DIR"

if docker-compose ps | grep -q "Up"; then
    echo "  Relay already running"
else
    docker-compose up -d
    echo "  Waiting for relay to start..."
    sleep 3
fi

# Check relay health
if curl -s -H "Accept: application/nostr+json" http://localhost:8080 > /dev/null 2>&1; then
    echo "  Relay is healthy at ws://localhost:8080"
else
    echo "  Warning: Relay may not be ready yet. Check with: docker-compose logs"
fi

echo ""

# Start the HTTP server for orchestrator
cd "$ORCHESTRATOR_DIR"
echo "Starting orchestrator server on port $PORT..."
echo ""
echo "=================================="
echo "  Open in browser:"
echo "  http://localhost:$PORT/onboarding.html"
echo "=================================="
echo ""
echo "Press Ctrl+C to stop"
echo ""

python3 -m http.server $PORT
