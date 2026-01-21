#!/bin/bash

# Equaliser Content Node - Stop Development Server
# This script stops the local NOSTR relay

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$SCRIPT_DIR/nostr-relay"

echo "=================================="
echo "  Stopping Equaliser Content Node"
echo "=================================="
echo ""

# Stop the NOSTR relay
echo "Stopping NOSTR relay..."
cd "$RELAY_DIR"

if docker-compose ps | grep -q "Up"; then
    docker-compose down
    echo "  Relay stopped"
else
    echo "  Relay was not running"
fi

echo ""
echo "Done."
