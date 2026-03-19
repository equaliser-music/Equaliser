#!/usr/bin/env bash
# seed-user-cache.sh — Seed a standard relay with test fan data for user cache testing.
#
# Publishes Kind 0 (profile), Kind 3 (follow list), and Kind 1 (posts) for
# test fan users to a target standard relay, then registers each pubkey with
# the content node so the Equaliser Relay syncer picks them up.
#
# Usage:
#   ./tools/seed-user-cache.sh                          # Seed local standard relay + register locally
#   ./tools/seed-user-cache.sh --relay wss://relay1.equaliser.app --node https://test1.equaliser.app
#
# Requires:
#   - Target standard relay running and accessible
#   - Content node running (for user registration)
#   - Node.js with nostr-tools (npm install in tools/)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Defaults
RELAY_URL="ws://localhost:7700"
NODE_URL="http://localhost"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --relay)  RELAY_URL="$2"; shift 2 ;;
        --node)   NODE_URL="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: seed-user-cache.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --relay URL   Standard relay WebSocket URL (default: ws://localhost:7700)"
            echo "  --node URL    Content node base URL (default: http://localhost)"
            echo "  -h, --help    Show this help"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

echo "Seeding user cache test data..."
echo "  Standard relay: $RELAY_URL"
echo "  Content node:   $NODE_URL"
echo ""

RELAY_URL="$RELAY_URL" NODE_URL="$NODE_URL" node "$SCRIPT_DIR/seed-user-cache.mjs"
