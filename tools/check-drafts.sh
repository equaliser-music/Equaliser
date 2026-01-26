#!/bin/bash
#
# check-drafts.sh - Inspect the draft database
#
# Usage:
#   ./tools/check-drafts.sh              # List all drafts
#   ./tools/check-drafts.sh duplicates   # Find potential duplicates
#   ./tools/check-drafts.sh album "Name" # List drafts for specific album
#   ./tools/check-drafts.sh delete ID    # Delete a specific draft by ID
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONTENT_NODE_DIR="$PROJECT_ROOT/content_node"

cd "$CONTENT_NODE_DIR"

# Check if orchestrator container is running
if ! docker compose ps orchestrator | grep -q "running"; then
    echo "Error: orchestrator container is not running"
    echo "Start it with: ./tools/start-node.sh"
    exit 1
fi

case "${1:-list}" in
    list)
        echo "=== All Drafts ==="
        docker compose exec orchestrator sqlite3 -header -column /data/drafts.db \
            "SELECT id, title, album, status, track_number, datetime(created_at) as created FROM draft_tracks ORDER BY album, track_number;"
        ;;

    count)
        echo "=== Draft Counts by Album ==="
        docker compose exec orchestrator sqlite3 -header -column /data/drafts.db \
            "SELECT album, status, COUNT(*) as count FROM draft_tracks GROUP BY album, status ORDER BY album;"
        ;;

    duplicates)
        echo "=== Potential Duplicates (same title + album) ==="
        docker compose exec orchestrator sqlite3 -header -column /data/drafts.db \
            "SELECT title, album, COUNT(*) as count, GROUP_CONCAT(id) as ids
             FROM draft_tracks
             GROUP BY title, album
             HAVING COUNT(*) > 1
             ORDER BY count DESC;"
        ;;

    album)
        if [ -z "$2" ]; then
            echo "Usage: $0 album \"Album Name\""
            exit 1
        fi
        echo "=== Drafts for album: $2 ==="
        docker compose exec orchestrator sqlite3 -header -column /data/drafts.db \
            "SELECT id, title, track_number, status, datetime(created_at) as created
             FROM draft_tracks
             WHERE album = '$2'
             ORDER BY track_number, created_at;"
        ;;

    delete)
        if [ -z "$2" ]; then
            echo "Usage: $0 delete <draft_id>"
            exit 1
        fi
        echo "Deleting draft: $2"
        docker compose exec orchestrator sqlite3 /data/drafts.db \
            "DELETE FROM draft_tracks WHERE id = '$2';"
        echo "Done. Verify with: $0 list"
        ;;

    delete-duplicates)
        echo "=== Deleting duplicate drafts (keeping oldest of each title+album) ==="
        docker compose exec orchestrator sqlite3 /data/drafts.db \
            "DELETE FROM draft_tracks
             WHERE id NOT IN (
                 SELECT MIN(id)
                 FROM draft_tracks
                 GROUP BY title, album
             );"
        echo "Done. Remaining drafts:"
        docker compose exec orchestrator sqlite3 -header -column /data/drafts.db \
            "SELECT album, COUNT(*) as count FROM draft_tracks GROUP BY album;"
        ;;

    *)
        echo "Usage: $0 [list|count|duplicates|album \"Name\"|delete ID|delete-duplicates]"
        echo ""
        echo "Commands:"
        echo "  list              - List all drafts"
        echo "  count             - Show counts by album"
        echo "  duplicates        - Find potential duplicate tracks"
        echo "  album \"Name\"      - List drafts for specific album"
        echo "  delete ID         - Delete a specific draft"
        echo "  delete-duplicates - Remove duplicate tracks (keeps oldest)"
        exit 1
        ;;
esac
