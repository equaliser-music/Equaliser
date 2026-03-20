#!/usr/bin/env bash
# seed-release-drafts.sh — Publish artist profiles and release all draft tracks.
#
# Usage:
#   ./tools/seed-release-drafts.sh                                    # Local
#   ./tools/seed-release-drafts.sh --node https://test1.equaliser.app # VPS

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

NODE_URL="http://localhost"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --node)  NODE_URL="$2"; shift 2 ;;
        -h|--help) echo "Usage: seed-release-drafts.sh [--node URL]"; exit 0 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [[ "$NODE_URL" == https://* ]]; then
    RELAY_URL="wss://${NODE_URL#https://}/relay"
else
    RELAY_URL="ws://${NODE_URL#http://}/relay"
fi

echo "Publishing profiles + releasing drafts..."
echo "  Node: $NODE_URL"
echo "  Relay: $RELAY_URL"
echo ""

RELAY_URL="$RELAY_URL" NODE_URL="$NODE_URL" node "$SCRIPT_DIR/seed-release-drafts.mjs"
