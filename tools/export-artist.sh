#!/bin/bash
#
# Export an artist from the content node to an Equaliser Artist Package
#
# Usage:
#   ./tools/export-artist.sh --npub npub1...
#   ./tools/export-artist.sh --npub npub1... --include-keys
#   ./tools/export-artist.sh --npub npub1... --output ./backups/
#
# Options:
#   --npub          Artist's npub (required)
#   --include-keys  Include identity backup (nsec) - requires manual input
#   --output        Output directory (default: ./packages/)
#   --releases-only Export releases without profile/media
#   --base-url      Content node URL (default: http://localhost)
#   -h, --help      Show this help message
#
# Requirements:
#   - Content node running (./tools/start-node.sh)
#   - jq installed
#   - curl installed

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Use venv if available
VENV_PATH="$PROJECT_ROOT/.venv"
if [[ -d "$VENV_PATH" ]]; then
    export PATH="$VENV_PATH/bin:$PATH"
fi

# Default settings
BASE_URL="http://localhost"
RELAY_URL="ws://localhost/relay"
OUTPUT_DIR="$PROJECT_ROOT/packages"
NPUB=""
INCLUDE_KEYS=false
RELEASES_ONLY=false

show_help() {
    echo "Export an artist from the content node to an Artist Package"
    echo ""
    echo "Usage:"
    echo "  $0 --npub npub1... [options]"
    echo ""
    echo "Options:"
    echo "  --npub NPUB       Artist's npub (required)"
    echo "  --include-keys    Include identity backup (will prompt for nsec)"
    echo "  --output DIR      Output directory (default: ./packages/)"
    echo "  --releases-only   Export releases without profile/media"
    echo "  --base-url URL    Content node URL (default: http://localhost)"
    echo "  -h, --help        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 --npub npub1abc..."
    echo "  $0 --npub npub1abc... --include-keys --output ./backups/"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        --npub)
            NPUB="$2"
            shift 2
            ;;
        --include-keys)
            INCLUDE_KEYS=true
            shift
            ;;
        --output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --releases-only)
            RELEASES_ONLY=true
            shift
            ;;
        --base-url)
            BASE_URL="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            show_help
            exit 1
            ;;
    esac
done

# Validate arguments
if [[ -z "$NPUB" ]]; then
    echo -e "${RED}Error: --npub is required${NC}"
    show_help
    exit 1
fi

if [[ ! "$NPUB" =~ ^npub1 ]]; then
    echo -e "${RED}Error: Invalid npub format (should start with npub1)${NC}"
    exit 1
fi

# Check dependencies
check_deps() {
    local missing=()
    command -v jq &> /dev/null || missing+=("jq")
    command -v curl &> /dev/null || missing+=("curl")
    command -v python3 &> /dev/null || missing+=("python3")

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo -e "${RED}Error: Missing dependencies: ${missing[*]}${NC}"
        exit 1
    fi
}

# Convert npub to hex pubkey
npub_to_hex() {
    local npub="$1"
    python3 << PYTHON
# Bech32 decoding
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

def bech32_polymod(values):
    GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            chk ^= GEN[i] if ((b >> i) & 1) else 0
    return chk

def bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]

def bech32_verify_checksum(hrp, data):
    return bech32_polymod(bech32_hrp_expand(hrp) + data) == 1

def bech32_decode(bech):
    if bech.lower() != bech and bech.upper() != bech:
        return None, None
    bech = bech.lower()
    pos = bech.rfind("1")
    if pos < 1 or pos + 7 > len(bech):
        return None, None
    hrp = bech[:pos]
    data = [CHARSET.find(x) for x in bech[pos+1:]]
    if -1 in data:
        return None, None
    if not bech32_verify_checksum(hrp, data):
        return None, None
    return hrp, data[:-6]

def convertbits(data, frombits, tobits, pad=True):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        return None
    return ret

hrp, data = bech32_decode("$npub")
if hrp == "npub":
    decoded = convertbits(data, 5, 8, False)
    if decoded:
        print(bytes(decoded).hex())
PYTHON
}

# Query NOSTR relay for events
query_relay() {
    local filter="$1"
    python3 << PYTHON
import json
import websocket

relay_url = "$RELAY_URL"
filter_json = '''$filter'''
filter_obj = json.loads(filter_json)

try:
    ws = websocket.create_connection(relay_url, timeout=10)
    sub_id = "export-query"
    ws.send(json.dumps(["REQ", sub_id, filter_obj]))

    events = []
    while True:
        response = ws.recv()
        msg = json.loads(response)
        if msg[0] == "EVENT":
            events.append(msg[2])
        elif msg[0] == "EOSE":
            break

    ws.close()
    print(json.dumps(events))
except Exception as e:
    print(json.dumps([]))
PYTHON
}

# Download file from IPFS
download_ipfs() {
    local cid="$1"
    local output_path="$2"

    # Extract CID from URL if needed
    if [[ "$cid" == *"/ipfs/"* ]]; then
        cid="${cid##*/ipfs/}"
    fi

    curl -s -o "$output_path" "$BASE_URL/ipfs/$cid" 2>/dev/null
    [[ -f "$output_path" && -s "$output_path" ]]
}

# Main execution
main() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}Equaliser Artist Package Exporter${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""

    check_deps

    # Convert npub to hex
    echo -e "${BLUE}Looking up artist...${NC}"
    local pubkey_hex=$(npub_to_hex "$NPUB")

    if [[ -z "$pubkey_hex" ]]; then
        echo -e "${RED}Error: Failed to decode npub${NC}"
        exit 1
    fi

    echo -e "  npub: ${CYAN}$NPUB${NC}"
    echo -e "  pubkey: $pubkey_hex"
    echo ""

    # Query for Kind 0 (profile)
    echo -e "${BLUE}Fetching profile...${NC}"
    local profile_events=$(query_relay "{\"kinds\":[0],\"authors\":[\"$pubkey_hex\"],\"limit\":1}")
    local profile_event=$(echo "$profile_events" | jq '.[0] // empty')

    if [[ -z "$profile_event" || "$profile_event" == "null" ]]; then
        echo -e "${YELLOW}Warning: No profile found for this npub${NC}"
        local artist_name="unknown-artist"
        local artist_slug="unknown-artist"
    else
        local profile_content=$(echo "$profile_event" | jq -r '.content')
        artist_name=$(echo "$profile_content" | jq -r '.name // "unknown"')
        artist_slug=$(echo "$artist_name" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')
        echo -e "  ${GREEN}✓ Found profile: $artist_name${NC}"
    fi

    # Query for Kind 30050 (tracks)
    echo -e "${BLUE}Fetching releases...${NC}"
    local track_events=$(query_relay "{\"kinds\":[30050],\"authors\":[\"$pubkey_hex\"]}")
    local track_count=$(echo "$track_events" | jq 'length')
    echo -e "  ${GREEN}✓ Found $track_count releases${NC}"
    echo ""

    # Create package directory
    local package_dir="$OUTPUT_DIR/$artist_slug.artist-package"
    echo -e "${BLUE}Creating package: $package_dir${NC}"

    rm -rf "$package_dir"
    mkdir -p "$package_dir/identity"
    mkdir -p "$package_dir/media"
    mkdir -p "$package_dir/releases"

    # Export profile
    if [[ "$RELEASES_ONLY" != "true" && -n "$profile_event" && "$profile_event" != "null" ]]; then
        echo -e "  Exporting profile..."

        # Parse profile content
        local profile_json=$(echo "$profile_event" | jq -r '.content')

        # Download avatar if present
        local picture_url=$(echo "$profile_json" | jq -r '.picture // empty')
        if [[ -n "$picture_url" && "$picture_url" != "null" ]]; then
            echo -e "    Downloading avatar..."
            if download_ipfs "$picture_url" "$package_dir/media/avatar.jpg"; then
                echo -e "    ${GREEN}✓ Avatar saved${NC}"
            fi
        fi

        # Download banner if present
        local banner_url=$(echo "$profile_json" | jq -r '.banner // empty')
        if [[ -n "$banner_url" && "$banner_url" != "null" ]]; then
            echo -e "    Downloading banner..."
            if download_ipfs "$banner_url" "$package_dir/media/banner.jpg"; then
                echo -e "    ${GREEN}✓ Banner saved${NC}"
            fi
        fi

        # Create profile.json (without picture/banner URLs - will be re-uploaded on import)
        echo "$profile_json" | jq '{
            name: .name,
            about: .about,
            picture: null,
            banner: null,
            website: .website,
            nip05: .nip05,
            lud16: .lud16,
            equaliser: .equaliser
        }' > "$package_dir/identity/profile.json"
        echo -e "    ${GREEN}✓ Profile saved${NC}"
    fi

    # Export releases
    echo -e "  Exporting releases..."
    echo "$track_events" | jq -c '.[]' | while read -r event; do
        local content=$(echo "$event" | jq -r '.content')
        local tags=$(echo "$event" | jq -c '.tags')

        # Extract d-tag (release ID)
        local d_tag=$(echo "$tags" | jq -r '.[] | select(.[0]=="d") | .[1]' | head -1)
        [[ -z "$d_tag" || "$d_tag" == "null" ]] && d_tag="release-$(echo "$event" | jq -r '.id[:8]')"

        local release_dir="$package_dir/releases/$d_tag"
        mkdir -p "$release_dir"

        # Parse content
        local title=$(echo "$content" | jq -r '.title // "Untitled"')
        echo -e "    ${CYAN}$title${NC}"

        # Extract metadata from content and tags
        local manifest_cid=$(echo "$tags" | jq -r '.[] | select(.[0]=="manifest") | .[1]' | head -1)
        local preview_cid=$(echo "$tags" | jq -r '.[] | select(.[0]=="preview") | .[1]' | head -1)
        local price=$(echo "$tags" | jq -r '.[] | select(.[0]=="price") | .[1]' | head -1)
        local cover_cid=$(echo "$content" | jq -r '.cover // empty')

        # Download cover art if present
        local cover_file=""
        if [[ -n "$cover_cid" && "$cover_cid" != "null" ]]; then
            if download_ipfs "$cover_cid" "$release_dir/cover.jpg"; then
                cover_file="cover.jpg"
            fi
        fi

        # Create release metadata
        # Note: We can't export the original audio file as it's HLS-encoded on IPFS
        # The metadata references the IPFS CIDs for the encoded content
        cat > "$release_dir/metadata.json" << EOF
{
  "id": "$d_tag",
  "title": $(echo "$content" | jq '.title'),
  "artist": $(echo "$content" | jq '.artist // "$artist_name"'),
  "album": $(echo "$content" | jq '.album // null'),
  "album_id": $(echo "$content" | jq '.albumId // null'),
  "track_number": $(echo "$content" | jq '.trackNumber // null'),
  "duration": $(echo "$content" | jq '.duration // null'),
  "genre": $(echo "$content" | jq '.genre // null'),
  "price_sats": ${price:-100},
  "release_date": $(echo "$content" | jq '.releaseDate // null'),
  "release_type": $(echo "$content" | jq '.releaseType // "single"'),
  "tags": $(echo "$content" | jq '.tags // []'),
  "audio_file": null,
  "cover_file": $(if [[ -n "$cover_file" ]]; then echo "\"$cover_file\""; else echo "null"; fi),
  "_ipfs": {
    "manifest_cid": "$manifest_cid",
    "preview_cid": "$preview_cid"
  },
  "_note": "Audio file not included - content is HLS-encoded on IPFS. Use CIDs for playback."
}
EOF

        echo -e "      ${GREEN}✓ Metadata saved${NC}"
    done

    # Handle --include-keys
    local has_identity=false
    if [[ "$INCLUDE_KEYS" == "true" ]]; then
        echo ""
        echo -e "${YELLOW}Including identity backup${NC}"
        echo -e "Enter the nsec for this artist (will be saved to backup.json):"
        echo -e "${RED}WARNING: This is sensitive data. Only include for backup/migration purposes.${NC}"
        read -s -p "nsec: " nsec_input
        echo ""

        if [[ -n "$nsec_input" && "$nsec_input" =~ ^nsec1 ]]; then
            # Decode nsec to get private key hex
            local privkey_hex=$(python3 << PYTHON
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

def bech32_polymod(values):
    GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            chk ^= GEN[i] if ((b >> i) & 1) else 0
    return chk

def bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]

def bech32_verify_checksum(hrp, data):
    return bech32_polymod(bech32_hrp_expand(hrp) + data) == 1

def bech32_decode(bech):
    bech = bech.lower()
    pos = bech.rfind("1")
    hrp = bech[:pos]
    data = [CHARSET.find(x) for x in bech[pos+1:]]
    if not bech32_verify_checksum(hrp, data):
        return None, None
    return hrp, data[:-6]

def convertbits(data, frombits, tobits, pad=True):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (tobits - bits)) & maxv)
    return ret

hrp, data = bech32_decode("$nsec_input")
if hrp == "nsec":
    decoded = convertbits(data, 5, 8, False)
    if decoded:
        print(bytes(decoded).hex())
PYTHON
)

            if [[ -n "$privkey_hex" ]]; then
                # Get profile data for backup
                local profile_data=$(cat "$package_dir/identity/profile.json" 2>/dev/null || echo '{}')
                local bio=$(echo "$profile_data" | jq -r '.about // ""')
                local location=$(echo "$profile_data" | jq -r '.equaliser.location // ""')
                local genres=$(echo "$profile_data" | jq -c '.equaliser.genres // []')

                cat > "$package_dir/identity/backup.json" << EOF
{
  "version": 1,
  "created": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "keys": {
    "nsec": "$nsec_input",
    "npub": "$NPUB",
    "privateKeyHex": "$privkey_hex",
    "publicKeyHex": "$pubkey_hex"
  },
  "profile": {
    "name": "$artist_name",
    "bio": "$bio",
    "location": "$location",
    "genres": $genres
  }
}
EOF
                has_identity=true
                echo -e "${GREEN}✓ Identity backup saved${NC}"
            else
                echo -e "${RED}Failed to decode nsec${NC}"
            fi
        else
            echo -e "${YELLOW}Invalid or empty nsec - skipping identity backup${NC}"
        fi
    fi

    # Create manifest.json
    local has_media=false
    [[ -f "$package_dir/media/avatar.jpg" || -f "$package_dir/media/banner.jpg" ]] && has_media=true

    cat > "$package_dir/manifest.json" << EOF
{
  "format": "equaliser-artist-package",
  "version": "1.0",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "artist": {
    "name": "$artist_name",
    "slug": "$artist_slug"
  },
  "contents": {
    "has_identity": $has_identity,
    "has_media": $has_media,
    "release_count": $track_count
  },
  "source": {
    "type": "export",
    "node_url": "$BASE_URL",
    "exported_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  }
}
EOF

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Export complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "Package created: ${CYAN}$package_dir${NC}"
    echo ""
    echo -e "Contents:"
    echo -e "  Profile: $(if [[ -f "$package_dir/identity/profile.json" ]]; then echo "✓"; else echo "✗"; fi)"
    echo -e "  Identity: $(if [[ "$has_identity" == "true" ]]; then echo "✓"; else echo "✗"; fi)"
    echo -e "  Avatar: $(if [[ -f "$package_dir/media/avatar.jpg" ]]; then echo "✓"; else echo "✗"; fi)"
    echo -e "  Banner: $(if [[ -f "$package_dir/media/banner.jpg" ]]; then echo "✓"; else echo "✗"; fi)"
    echo -e "  Releases: $track_count"
    echo ""
    echo -e "${YELLOW}Note: Audio files are not included in exports.${NC}"
    echo -e "Releases contain IPFS CIDs for HLS-encoded streams."
    echo -e "For full backup, ensure IPFS content is pinned elsewhere."
}

main
