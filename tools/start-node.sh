#!/bin/bash
#
# start-node.sh - Start the Equaliser content node
#
# Usage:
#   ./start-node.sh           # Start with build
#   ./start-node.sh --no-build # Start without rebuilding
#   ./start-node.sh -d        # Start detached (background)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONTENT_NODE_DIR="$PROJECT_ROOT/content_node"

# Parse arguments
BUILD_FLAG="--build"
DETACH_FLAG=""

for arg in "$@"; do
    case $arg in
        --no-build)
            BUILD_FLAG=""
            ;;
        -d|--detach)
            DETACH_FLAG="-d"
            ;;
        -h|--help)
            echo "Start the Equaliser content node"
            echo ""
            echo "Usage:"
            echo "  $0              Start with build (foreground)"
            echo "  $0 -d           Start detached (background)"
            echo "  $0 --no-build   Start without rebuilding"
            echo "  $0 -d --no-build Start detached without rebuilding"
            echo ""
            echo "Services started:"
            echo "  - ipfs          IPFS node (ports 4001, 5001)"
            echo "  - nostr-relay   NOSTR relay"
            echo "  - orchestrator  FastAPI backend"
            echo "  - web           Nginx (port 80)"
            echo ""
            echo "Access:"
            echo "  http://localhost              Landing page"
            echo "  http://localhost/admin        Admin dashboard"
            echo "  http://localhost/api/health   API health check"
            exit 0
            ;;
    esac
done

cd "$CONTENT_NODE_DIR"

echo "Starting Equaliser content node..."
echo "Directory: $CONTENT_NODE_DIR"
echo ""

if [ -n "$BUILD_FLAG" ]; then
    echo "Building containers..."
fi

docker-compose up $BUILD_FLAG $DETACH_FLAG

if [ -n "$DETACH_FLAG" ]; then
    echo ""
    echo "Content node started in background."
    echo ""
    echo "View logs:     docker-compose -f $CONTENT_NODE_DIR/docker-compose.yml logs -f"
    echo "Stop:          docker-compose -f $CONTENT_NODE_DIR/docker-compose.yml down"
    echo ""
    echo "Access:"
    echo "  http://localhost              Landing page"
    echo "  http://localhost/admin        Admin dashboard"
    echo "  http://localhost/api/health   API health check"
fi
