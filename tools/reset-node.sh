#!/bin/bash
#
# reset-node.sh - Reset the Equaliser content node to a fresh state
#
# This script wipes all data and recreates the environment:
# - Stops all containers
# - Removes Docker volumes (IPFS data, NOSTR relay data, Blossom blobs, uploads)
# - Rebuilds and starts containers with fresh volumes
#
# WARNING: This is destructive! All uploaded tracks, NOSTR events,
# and artist profiles will be permanently deleted.
#
# Usage:
#   ./reset-node.sh           # Interactive mode (asks for confirmation)
#   ./reset-node.sh --force   # Skip confirmation prompt
#   ./reset-node.sh -d        # Start detached after reset
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONTENT_NODE_DIR="$PROJECT_ROOT/content_node"

# Parse arguments
FORCE=false
DETACH_FLAG=""

for arg in "$@"; do
    case $arg in
        --force|-f)
            FORCE=true
            ;;
        -d|--detach)
            DETACH_FLAG="-d"
            ;;
        -h|--help)
            echo "Reset the Equaliser content node to a fresh state"
            echo ""
            echo "WARNING: This permanently deletes all data!"
            echo ""
            echo "Usage:"
            echo "  $0              Interactive mode (asks for confirmation)"
            echo "  $0 --force      Skip confirmation prompt"
            echo "  $0 -d           Start detached (background) after reset"
            echo "  $0 --force -d   Force reset and start detached"
            echo ""
            echo "What gets wiped:"
            echo "  - All IPFS content (HLS segments, cover art)"
            echo "  - All Blossom blobs (original audio files, images)"
            echo "  - All NOSTR events (track metadata, artist profiles)"
            echo "  - Draft database and upload processing queue"
            echo ""
            echo "After reset, you'll need to:"
            echo "  1. Create a new artist profile at /admin/onboarding.html"
            echo "  2. Re-upload any tracks at /admin/upload.html"
            exit 0
            ;;
    esac
done

cd "$CONTENT_NODE_DIR"

echo ""
echo "=========================================="
echo "  Equaliser Content Node Reset"
echo "=========================================="
echo ""
echo "WARNING: This will permanently delete:"
echo "  - All IPFS content (HLS segments, cover art)"
echo "  - All Blossom blobs (original audio files, images)"
echo "  - All NOSTR events (metadata, profiles)"
echo "  - Draft database and upload history"
echo ""

if [ "$FORCE" = false ]; then
    read -p "Are you sure you want to continue? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi
fi

echo ""
echo "Stopping containers and removing volumes..."
docker compose down -v

echo ""
echo "Rebuilding and starting containers..."
docker compose up -d --build

echo ""
echo "Waiting for services to be ready..."
sleep 5

# Check health
if curl -s http://localhost/api/health | grep -q "healthy"; then
    echo ""
    echo "=========================================="
    echo "  Reset Complete!"
    echo "=========================================="
    echo ""
    echo "All services are running with fresh data."
    echo ""
    echo "Next steps:"
    echo "  1. http://localhost/admin/onboarding.html  - Create artist profile"
    echo "  2. http://localhost/admin/upload.html      - Upload tracks"
    echo "  3. http://localhost/admin/releases.html    - View releases"
    echo ""

    if [ -z "$DETACH_FLAG" ]; then
        echo "Showing logs (Ctrl+C to exit)..."
        echo ""
        docker compose logs -f
    fi
else
    echo ""
    echo "Warning: Health check failed. Check container logs:"
    echo "  docker compose logs"
    exit 1
fi
