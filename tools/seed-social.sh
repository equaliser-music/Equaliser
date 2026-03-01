#!/usr/bin/env bash
# seed-social.sh — Seed the NOSTR relay with social content for testing.
#
# Publishes feed posts, replies, community threads, DMs, and reactions
# from all users in packages/users/ and artists in packages/artists/.
#
# Usage:
#   ./tools/seed-social.sh     # Seed the local relay with social content
#
# Requires:
#   - Content node running (./tools/start-node.sh -d)
#   - Node.js with nostr-tools (npm install in tools/)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Seeding social content..."
node "$SCRIPT_DIR/seed-social.mjs"
