#!/usr/bin/env bash
# seed-social.sh — Seed the NOSTR relay with social content for testing.
#
# Publishes feed posts, replies, community threads, DMs, and reactions
# from all test users and artists. Covers 30 days of simulated activity.
#
# Usage:
#   ./tools/seed-social.sh                                    # Seed the local relay
#   ./tools/seed-social.sh --node https://test1.equaliser.app # Seed a VPS relay
#
# Requires:
#   - Content node running
#   - Node.js with nostr-tools (npm install in tools/)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Default to local
NODE_URL="http://localhost"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --node)  NODE_URL="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: seed-social.sh [OPTIONS]"
            echo "  --node URL   Content node base URL (default: http://localhost)"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Convert https to wss, http to ws for relay URL
if [[ "$NODE_URL" == https://* ]]; then
    RELAY_URL="wss://${NODE_URL#https://}/relay"
else
    RELAY_URL="ws://${NODE_URL#http://}/relay"
fi

echo "Seeding social content..."
echo "  Node: $NODE_URL"
echo "  Relay: $RELAY_URL"
echo ""

RELAY_URL="$RELAY_URL" node "$SCRIPT_DIR/seed-social.mjs"
