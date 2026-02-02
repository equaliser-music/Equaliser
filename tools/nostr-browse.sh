#!/bin/bash
#
# nostr-browse.sh - Browse the local NOSTR relay database
#
# Usage:
#   ./nostr-browse.sh                    # Show all events summary
#   ./nostr-browse.sh kinds              # List event kinds with counts
#   ./nostr-browse.sh authors            # List authors (npubs) with event counts
#   ./nostr-browse.sh kind <number>      # Show events of specific kind
#   ./nostr-browse.sh author <npub|hex>  # Show events by author
#   ./nostr-browse.sh event <id>         # Show specific event by ID
#   ./nostr-browse.sh recent [limit]     # Show recent events (default: 10)
#   ./nostr-browse.sh profile <npub|hex> # Show parsed profile (Kind 0)
#

set -e

CONTAINER="equaliser-nostr-relay"
DB_PATH="/usr/src/app/db/nostr.db"

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: Container '${CONTAINER}' is not running"
    echo "Start it with: cd content_node && docker-compose up -d"
    exit 1
fi

# Helper to run sqlite query
query() {
    docker exec "$CONTAINER" sqlite3 "$DB_PATH" "$1"
}

# Convert hex pubkey to npub (requires external tool or just display hex)
hex_to_npub() {
    # For now, just return hex - npub conversion requires bech32 encoding
    echo "$1"
}

# Show usage
usage() {
    echo "NOSTR Relay Browser"
    echo ""
    echo "Usage:"
    echo "  $0                    Show summary of all events"
    echo "  $0 kinds              List event kinds with counts"
    echo "  $0 authors            List authors with event counts"
    echo "  $0 kind <number>      Show events of specific kind"
    echo "  $0 author <hex>       Show events by author (hex pubkey)"
    echo "  $0 event <id>         Show specific event by ID"
    echo "  $0 recent [limit]     Show recent events (default: 10)"
    echo "  $0 profile <hex>      Show parsed profile (Kind 0)"
    echo ""
    echo "Event Kinds:"
    echo "  0     - Profile metadata"
    echo "  1     - Text note"
    echo "  3     - Contact list"
    echo "  7     - Reaction"
    echo "  30050 - Equaliser track"
    echo "  30051 - Equaliser album"
    echo "  30052 - Encrypted decryption key"
    echo "  30053 - Payment receipt"
}

# Summary of all events
summary() {
    echo "=== NOSTR Relay Summary ==="
    echo ""

    total=$(query "SELECT COUNT(*) FROM event;")
    echo "Total events: $total"
    echo ""

    echo "Events by kind:"
    query "SELECT kind, COUNT(*) as count FROM event GROUP BY kind ORDER BY count DESC;" | \
        while IFS='|' read -r kind count; do
            case $kind in
                0) name="Profile" ;;
                1) name="Note" ;;
                3) name="Contacts" ;;
                7) name="Reaction" ;;
                30050) name="Track" ;;
                30051) name="Album" ;;
                30052) name="DecryptKey" ;;
                30053) name="Receipt" ;;
                *) name="" ;;
            esac
            printf "  Kind %6s: %4s events  %s\n" "$kind" "$count" "$name"
        done
    echo ""

    authors=$(query "SELECT COUNT(DISTINCT author) FROM event;")
    echo "Unique authors: $authors"
}

# List event kinds
list_kinds() {
    echo "=== Event Kinds ==="
    echo ""
    query "SELECT kind, COUNT(*) as count FROM event GROUP BY kind ORDER BY kind;" | \
        while IFS='|' read -r kind count; do
            case $kind in
                0) name="Profile metadata" ;;
                1) name="Text note" ;;
                3) name="Contact list" ;;
                7) name="Reaction" ;;
                10002) name="Relay list (NIP-65)" ;;
                30050) name="Equaliser track" ;;
                30051) name="Equaliser album" ;;
                30052) name="Encrypted decryption key" ;;
                30053) name="Payment receipt" ;;
                *) name="(unknown)" ;;
            esac
            printf "Kind %6s: %4s events - %s\n" "$kind" "$count" "$name"
        done
}

# List authors
list_authors() {
    echo "=== Authors ==="
    echo ""
    query "SELECT author, COUNT(*) as count FROM event GROUP BY author ORDER BY count DESC;" | \
        while IFS='|' read -r author count; do
            # Get profile name if available
            name=$(query "SELECT json_extract(content, '\$.name') FROM event WHERE kind=0 AND author='$author' LIMIT 1;" 2>/dev/null || echo "")
            if [ -n "$name" ]; then
                printf "%s (%s events) - %s\n" "$author" "$count" "$name"
            else
                printf "%s (%s events)\n" "$author" "$count"
            fi
        done
}

# Show events by kind
show_kind() {
    kind=$1
    echo "=== Events of Kind $kind ==="
    echo ""

    query "SELECT id, author, created_at, substr(content, 1, 100) FROM event WHERE kind=$kind ORDER BY created_at DESC LIMIT 20;" | \
        while IFS='|' read -r id author created content; do
            date=$(date -r "$created" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "$created")
            echo "ID: $id"
            echo "Author: $author"
            echo "Created: $date"
            echo "Content: ${content}..."
            echo "---"
        done
}

# Show events by author
show_author() {
    author=$1
    echo "=== Events by $author ==="
    echo ""

    query "SELECT id, kind, created_at, substr(content, 1, 100) FROM event WHERE author='$author' ORDER BY created_at DESC LIMIT 20;" | \
        while IFS='|' read -r id kind created content; do
            date=$(date -r "$created" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "$created")
            echo "ID: $id"
            echo "Kind: $kind"
            echo "Created: $date"
            echo "Content: ${content}..."
            echo "---"
        done
}

# Show specific event
show_event() {
    id=$1
    echo "=== Event $id ==="
    echo ""

    result=$(query "SELECT id, kind, author, created_at, content FROM event WHERE id='$id';")

    if [ -z "$result" ]; then
        echo "Event not found"
        exit 1
    fi

    echo "$result" | while IFS='|' read -r id kind author created content; do
        date=$(date -r "$created" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "$created")
        echo "ID: $id"
        echo "Kind: $kind"
        echo "Author: $author"
        echo "Created: $date"
        echo ""
        echo "Content:"
        echo "$content" | python3 -m json.tool 2>/dev/null || echo "$content"
    done
}

# Show recent events
show_recent() {
    limit=${1:-10}
    echo "=== Recent Events (last $limit) ==="
    echo ""

    query "SELECT id, kind, author, created_at, substr(content, 1, 80) FROM event ORDER BY created_at DESC LIMIT $limit;" | \
        while IFS='|' read -r id kind author created content; do
            date=$(date -r "$created" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "$created")
            printf "[%s] Kind %s by %s...\n" "$date" "$kind" "${author:0:16}"
            echo "  ${content}..."
            echo ""
        done
}

# Show profile
show_profile() {
    author=$1
    echo "=== Profile for $author ==="
    echo ""

    content=$(query "SELECT content FROM event WHERE kind=0 AND author='$author' ORDER BY created_at DESC LIMIT 1;")

    if [ -z "$content" ]; then
        echo "Profile not found"
        exit 1
    fi

    echo "$content" | python3 -m json.tool 2>/dev/null || echo "$content"
}

# Main
case "${1:-}" in
    "")
        summary
        ;;
    "kinds")
        list_kinds
        ;;
    "authors")
        list_authors
        ;;
    "kind")
        if [ -z "${2:-}" ]; then
            echo "Error: Please specify a kind number"
            exit 1
        fi
        show_kind "$2"
        ;;
    "author")
        if [ -z "${2:-}" ]; then
            echo "Error: Please specify an author (hex pubkey)"
            exit 1
        fi
        show_author "$2"
        ;;
    "event")
        if [ -z "${2:-}" ]; then
            echo "Error: Please specify an event ID"
            exit 1
        fi
        show_event "$2"
        ;;
    "recent")
        show_recent "${2:-10}"
        ;;
    "profile")
        if [ -z "${2:-}" ]; then
            echo "Error: Please specify an author (hex pubkey)"
            exit 1
        fi
        show_profile "$2"
        ;;
    "help"|"-h"|"--help")
        usage
        ;;
    *)
        echo "Unknown command: $1"
        echo ""
        usage
        exit 1
        ;;
esac
