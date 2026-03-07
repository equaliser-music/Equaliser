#!/bin/bash
#
# nostr-browse.sh - Browse the Equaliser Relay database (PostgreSQL)
#
# Usage:
#   ./nostr-browse.sh                    # Show all events summary
#   ./nostr-browse.sh kinds              # List event kinds with counts
#   ./nostr-browse.sh authors            # List authors (npubs) with event counts
#   ./nostr-browse.sh kind <number>      # Show events of specific kind
#   ./nostr-browse.sh author <hex>       # Show events by author
#   ./nostr-browse.sh event <id>         # Show specific event by ID
#   ./nostr-browse.sh recent [limit]     # Show recent events (default: 10)
#   ./nostr-browse.sh profile <hex>      # Show parsed profile (Kind 0)
#   ./nostr-browse.sh denorm             # Show denormalised table counts
#

set -e

CONTAINER="equaliser-postgres"
DB_USER="equaliser"
DB_NAME="equaliser"

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: Container '${CONTAINER}' is not running"
    echo "Start it with: cd content_node && docker compose up -d"
    exit 1
fi

# Helper to run psql query
query() {
    docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "$1"
}

# Helper for formatted psql output
query_formatted() {
    docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "$1"
}

# Show usage
usage() {
    echo "NOSTR Relay Browser (Equaliser Relay / PostgreSQL)"
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
    echo "  $0 denorm             Show denormalised table counts"
    echo ""
    echo "Event Kinds:"
    echo "  0     - Profile metadata"
    echo "  1     - Text note"
    echo "  3     - Contact list"
    echo "  4     - DM (NIP-04)"
    echo "  5     - Deletion"
    echo "  6     - Repost"
    echo "  7     - Reaction"
    echo "  30050 - Equaliser track"
    echo "  30051 - Equaliser album"
}

# Summary of all events
summary() {
    echo "=== Equaliser Relay Summary ==="
    echo ""

    total=$(query "SELECT COUNT(*) FROM raw_events;")
    echo "Total events: $total"
    echo ""

    echo "Events by kind:"
    query "SELECT kind, COUNT(*) as count FROM raw_events GROUP BY kind ORDER BY count DESC;" | \
        while IFS='|' read -r kind count; do
            case $kind in
                0) name="Profile" ;;
                1) name="Note" ;;
                3) name="Contacts" ;;
                4) name="DM" ;;
                5) name="Deletion" ;;
                6) name="Repost" ;;
                7) name="Reaction" ;;
                10002) name="Relay list" ;;
                24242) name="Blossom auth" ;;
                30001) name="Playlist" ;;
                30050) name="Track" ;;
                30051) name="Album" ;;
                *) name="" ;;
            esac
            printf "  Kind %6s: %4s events  %s\n" "$kind" "$count" "$name"
        done
    echo ""

    authors=$(query "SELECT COUNT(DISTINCT pubkey) FROM raw_events;")
    echo "Unique authors: $authors"
    echo ""

    tags=$(query "SELECT COUNT(*) FROM event_tags;")
    echo "Total indexed tags: $tags"
}

# List event kinds
list_kinds() {
    echo "=== Event Kinds ==="
    echo ""
    query "SELECT kind, COUNT(*) as count FROM raw_events GROUP BY kind ORDER BY kind;" | \
        while IFS='|' read -r kind count; do
            case $kind in
                0) name="Profile metadata" ;;
                1) name="Text note" ;;
                3) name="Contact list" ;;
                4) name="DM (NIP-04)" ;;
                5) name="Deletion" ;;
                6) name="Repost" ;;
                7) name="Reaction" ;;
                10002) name="Relay list (NIP-65)" ;;
                24242) name="Blossom auth (BUD-03)" ;;
                30001) name="Playlist (NIP-51)" ;;
                30050) name="Equaliser track" ;;
                30051) name="Equaliser album" ;;
                *) name="(unknown)" ;;
            esac
            printf "Kind %6s: %4s events - %s\n" "$kind" "$count" "$name"
        done
}

# List authors
list_authors() {
    echo "=== Authors ==="
    echo ""
    query "SELECT re.pubkey, COUNT(*) as count, ca.display_name
           FROM raw_events re
           LEFT JOIN cached_artists ca ON ca.pubkey = re.pubkey
           GROUP BY re.pubkey, ca.display_name
           ORDER BY count DESC;" | \
        while IFS='|' read -r author count name; do
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

    query "SELECT id, pubkey, created_at, substring(content, 1, 100)
           FROM raw_events WHERE kind=$kind ORDER BY created_at DESC LIMIT 20;" | \
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

    query "SELECT id, kind, created_at, substring(content, 1, 100)
           FROM raw_events WHERE pubkey='$author' ORDER BY created_at DESC LIMIT 20;" | \
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

    result=$(query "SELECT id, kind, pubkey, created_at, content FROM raw_events WHERE id='$id';")

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

    echo ""
    echo "Tags:"
    query "SELECT tag_name, tag_value FROM event_tags WHERE event_id='$id' ORDER BY tag_index;" | \
        while IFS='|' read -r name value; do
            printf "  [%s] %s\n" "$name" "$value"
        done
}

# Show recent events
show_recent() {
    limit=${1:-10}
    echo "=== Recent Events (last $limit) ==="
    echo ""

    query "SELECT id, kind, pubkey, created_at, substring(content, 1, 80)
           FROM raw_events ORDER BY created_at DESC LIMIT $limit;" | \
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

    # Check cached_artists first
    cached=$(query "SELECT display_name, about, picture_url, website, nip05, lud16 FROM cached_artists WHERE pubkey='$author';")
    if [ -n "$cached" ]; then
        echo "Cached profile:"
        echo "$cached" | while IFS='|' read -r name about picture website nip05 lud16; do
            [ -n "$name" ] && echo "  Name: $name"
            [ -n "$about" ] && echo "  About: $about"
            [ -n "$picture" ] && echo "  Picture: $picture"
            [ -n "$website" ] && echo "  Website: $website"
            [ -n "$nip05" ] && echo "  NIP-05: $nip05"
            [ -n "$lud16" ] && echo "  LUD-16: $lud16"
        done
        echo ""
    fi

    # Show raw Kind 0 content
    content=$(query "SELECT content FROM raw_events WHERE kind=0 AND pubkey='$author' ORDER BY created_at DESC LIMIT 1;")
    if [ -z "$content" ]; then
        echo "Profile not found in raw events"
        exit 1
    fi

    echo "Raw profile content:"
    echo "$content" | python3 -m json.tool 2>/dev/null || echo "$content"
}

# Show denormalised table counts
show_denorm() {
    echo "=== Denormalised Tables ==="
    echo ""

    artists=$(query "SELECT COUNT(*) FROM cached_artists;")
    tracks=$(query "SELECT COUNT(*) FROM cached_tracks;")
    albums=$(query "SELECT COUNT(*) FROM cached_albums;")
    users=$(query "SELECT COUNT(*) FROM registered_users;" 2>/dev/null || echo "0")

    printf "  cached_artists: %s\n" "$artists"
    printf "  cached_tracks:  %s\n" "$tracks"
    printf "  cached_albums:  %s\n" "$albums"
    printf "  registered_users: %s\n" "$users"
    echo ""

    if [ "$tracks" != "0" ]; then
        echo "Tracks:"
        query "SELECT artist_pubkey, d_tag, title, album FROM cached_tracks ORDER BY created_at DESC LIMIT 20;" | \
            while IFS='|' read -r pubkey dtag title album; do
                printf "  %s - %s" "${pubkey:0:16}..." "$title"
                [ -n "$album" ] && printf " (album: %s)" "$album"
                echo ""
            done
    fi
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
    "denorm")
        show_denorm
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
