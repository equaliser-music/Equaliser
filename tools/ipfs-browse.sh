#!/bin/bash
#
# ipfs-browse.sh - Browse the Equaliser IPFS node
#
# Usage:
#   ./ipfs-browse.sh                     # Show node status and root directories
#   ./ipfs-browse.sh ls [path]           # List directory (default: /music)
#   ./ipfs-browse.sh info <CID>          # Get info about a CID
#   ./ipfs-browse.sh cat <CID>           # Display file contents
#   ./ipfs-browse.sh pins                # List pinned content
#   ./ipfs-browse.sh peers               # Show connected peers
#   ./ipfs-browse.sh stats               # Show bandwidth and repo stats
#   ./ipfs-browse.sh search <pattern>    # Search for files matching pattern
#

set -e

CONTAINER="equaliser-ipfs"

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: Container '${CONTAINER}' is not running"
    echo "Start it with: cd content_node && docker-compose up -d"
    exit 1
fi

# Helper to run ipfs command
ipfs_cmd() {
    docker exec "$CONTAINER" ipfs "$@"
}

# Show usage
usage() {
    echo "IPFS Node Browser"
    echo ""
    echo "Usage:"
    echo "  $0                     Show node status and root directories"
    echo "  $0 ls [path]           List MFS directory (default: /)"
    echo "  $0 info <CID>          Get info about a CID"
    echo "  $0 cat <CID>           Display file contents (text only)"
    echo "  $0 pins                List pinned content"
    echo "  $0 peers               Show connected peers"
    echo "  $0 stats               Show bandwidth and repo stats"
    echo "  $0 search <pattern>    Search MFS for files matching pattern"
    echo "  $0 gateway <CID>       Show gateway URL for CID"
    echo ""
    echo "MFS Paths:"
    echo "  /music/artists         Artist content directories"
    echo "  /music/labels          Label content directories"
}

# Show node status
status() {
    echo "=== IPFS Node Status ==="
    echo ""

    # Node identity
    echo "Node Identity:"
    ipfs_cmd id --format="  ID: <id>\n  Agent: <agentVersion>\n"

    # Peer count
    peer_count=$(ipfs_cmd swarm peers 2>/dev/null | wc -l)
    echo "  Connected peers: $peer_count"
    echo ""

    # Repo stats
    echo "Repository:"
    ipfs_cmd repo stat 2>/dev/null | sed 's/^/  /'
    echo ""

    # MFS root listing
    echo "MFS Root (/):"
    ipfs_cmd files ls / 2>/dev/null | sed 's/^/  /' || echo "  (empty)"
    echo ""

    # Music directory
    echo "Music Directory (/music):"
    ipfs_cmd files ls /music 2>/dev/null | sed 's/^/  /' || echo "  (not created)"
}

# List MFS directory
list_dir() {
    path="${1:-/}"
    echo "=== Directory: $path ==="
    echo ""

    # Check if path exists
    if ! ipfs_cmd files stat "$path" >/dev/null 2>&1; then
        echo "Path not found: $path"
        exit 1
    fi

    # Get directory info
    stat_output=$(ipfs_cmd files stat "$path" 2>/dev/null)
    echo "Stats:"
    echo "$stat_output" | sed 's/^/  /'
    echo ""

    # List contents with details
    echo "Contents:"
    ipfs_cmd files ls -l "$path" 2>/dev/null | while read -r line; do
        # Parse the line (format: name size type)
        echo "  $line"
    done

    if [ -z "$(ipfs_cmd files ls "$path" 2>/dev/null)" ]; then
        echo "  (empty directory)"
    fi
}

# Get info about a CID
show_info() {
    cid=$1
    echo "=== CID Info: $cid ==="
    echo ""

    # Block stat
    echo "Block Stats:"
    ipfs_cmd block stat "$cid" 2>/dev/null | sed 's/^/  /' || echo "  (not found locally)"
    echo ""

    # Object stats
    echo "Object Stats:"
    ipfs_cmd object stat "$cid" 2>/dev/null | sed 's/^/  /' || echo "  (not found)"
    echo ""

    # File type
    echo "Type:"
    file_type=$(ipfs_cmd files stat --format='<type>' "/ipfs/$cid" 2>/dev/null || echo "unknown")
    echo "  $file_type"
    echo ""

    # Gateway URL
    echo "Gateway URLs:"
    echo "  Local:  http://localhost/ipfs/$cid"
    echo "  Public: https://ipfs.io/ipfs/$cid"
}

# Display file contents
cat_file() {
    cid=$1
    echo "=== File Contents: $cid ==="
    echo ""

    # Check size first
    size=$(ipfs_cmd block stat "$cid" 2>/dev/null | grep "Size:" | awk '{print $2}')

    if [ -z "$size" ]; then
        echo "CID not found locally"
        exit 1
    fi

    if [ "$size" -gt 10000 ]; then
        echo "File is large ($size bytes). Showing first 1000 bytes..."
        echo ""
        ipfs_cmd cat "$cid" 2>/dev/null | head -c 1000
        echo ""
        echo "..."
    else
        ipfs_cmd cat "$cid" 2>/dev/null
    fi
}

# List pinned content
list_pins() {
    echo "=== Pinned Content ==="
    echo ""

    # Count pins by type
    echo "Pin Summary:"
    direct=$(ipfs_cmd pin ls --type=direct 2>/dev/null | wc -l)
    recursive=$(ipfs_cmd pin ls --type=recursive 2>/dev/null | wc -l)
    indirect=$(ipfs_cmd pin ls --type=indirect 2>/dev/null | wc -l)
    echo "  Direct: $direct"
    echo "  Recursive: $recursive"
    echo "  Indirect: $indirect"
    echo ""

    echo "Recursive Pins (with sizes):"
    ipfs_cmd pin ls --type=recursive 2>/dev/null | head -20 | while read -r cid type; do
        size=$(ipfs_cmd object stat "$cid" 2>/dev/null | grep "CumulativeSize:" | awk '{print $2}')
        if [ -n "$size" ]; then
            # Convert to human-readable
            if [ "$size" -gt 1048576 ]; then
                hr_size="$(echo "scale=1; $size/1048576" | bc)MB"
            elif [ "$size" -gt 1024 ]; then
                hr_size="$(echo "scale=1; $size/1024" | bc)KB"
            else
                hr_size="${size}B"
            fi
            echo "  $cid ($hr_size)"
        else
            echo "  $cid"
        fi
    done

    total_pins=$((direct + recursive))
    if [ "$total_pins" -gt 20 ]; then
        echo "  ... and $((total_pins - 20)) more"
    fi
}

# Show connected peers
show_peers() {
    echo "=== Connected Peers ==="
    echo ""

    peers=$(ipfs_cmd swarm peers 2>/dev/null)
    count=$(echo "$peers" | grep -c "." || echo "0")

    echo "Connected peers: $count"
    echo ""

    if [ "$count" -gt 0 ]; then
        echo "Peer Addresses (first 20):"
        echo "$peers" | head -20 | while read -r peer; do
            echo "  $peer"
        done

        if [ "$count" -gt 20 ]; then
            echo "  ... and $((count - 20)) more"
        fi
    fi
}

# Show stats
show_stats() {
    echo "=== IPFS Statistics ==="
    echo ""

    echo "Bandwidth:"
    ipfs_cmd stats bw 2>/dev/null | sed 's/^/  /'
    echo ""

    echo "Repository:"
    ipfs_cmd repo stat 2>/dev/null | sed 's/^/  /'
    echo ""

    echo "Bitswap:"
    ipfs_cmd stats bitswap 2>/dev/null | head -10 | sed 's/^/  /'
}

# Search MFS for files
search_files() {
    pattern=$1
    echo "=== Searching for: $pattern ==="
    echo ""

    # Recursive search through MFS
    search_dir() {
        local dir=$1
        local depth=$2

        if [ "$depth" -gt 5 ]; then
            return
        fi

        ipfs_cmd files ls "$dir" 2>/dev/null | while read -r name; do
            full_path="$dir/$name"
            # Remove double slashes
            full_path=$(echo "$full_path" | sed 's#//#/#g')

            if echo "$name" | grep -qi "$pattern"; then
                echo "  $full_path"
            fi

            # Check if directory and recurse
            file_type=$(ipfs_cmd files stat --format='<type>' "$full_path" 2>/dev/null)
            if [ "$file_type" = "directory" ]; then
                search_dir "$full_path" $((depth + 1))
            fi
        done
    }

    search_dir "/" 0

    echo ""
    echo "Search complete."
}

# Show gateway URL
show_gateway() {
    cid=$1
    echo "=== Gateway URLs for $cid ==="
    echo ""
    echo "Local gateway:"
    echo "  http://localhost/ipfs/$cid"
    echo ""
    echo "Public gateways:"
    echo "  https://ipfs.io/ipfs/$cid"
    echo "  https://dweb.link/ipfs/$cid"
    echo "  https://cloudflare-ipfs.com/ipfs/$cid"
    echo "  https://gateway.pinata.cloud/ipfs/$cid"
}

# Main
case "${1:-}" in
    "")
        status
        ;;
    "ls")
        list_dir "${2:-/}"
        ;;
    "info")
        if [ -z "${2:-}" ]; then
            echo "Error: Please specify a CID"
            exit 1
        fi
        show_info "$2"
        ;;
    "cat")
        if [ -z "${2:-}" ]; then
            echo "Error: Please specify a CID"
            exit 1
        fi
        cat_file "$2"
        ;;
    "pins")
        list_pins
        ;;
    "peers")
        show_peers
        ;;
    "stats")
        show_stats
        ;;
    "search")
        if [ -z "${2:-}" ]; then
            echo "Error: Please specify a search pattern"
            exit 1
        fi
        search_files "$2"
        ;;
    "gateway")
        if [ -z "${2:-}" ]; then
            echo "Error: Please specify a CID"
            exit 1
        fi
        show_gateway "$2"
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
