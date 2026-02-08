#!/bin/bash
#
# Export an artist's releases from the content node
#
# Creates .eqpkg.zip release packages using the export API.
# Requires the artist's nsec for signing the package.
#
# Usage:
#   ./tools/export-artist.sh --npub npub1... --album "Album Name"
#   ./tools/export-artist.sh --npub npub1... --all-albums
#   ./tools/export-artist.sh --npub npub1... --all-albums --include-keys
#
# Options:
#   --npub          Artist's npub (required)
#   --album NAME    Export a specific album/release
#   --all-albums    Export all albums
#   --source        Source: "draft" or "nostr" (default: draft)
#   --include-keys  Include identity backup (prompts for nsec)
#   --output        Output directory (default: ./packages/)
#   --base-url      Content node URL (default: http://localhost)
#   -h, --help      Show this help message
#
# Requirements:
#   - Content node running (./tools/start-node.sh)
#   - jq installed
#   - curl installed
#   - python3 with coincurve (for signing)

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
ALBUM_NAME=""
ALL_ALBUMS=false
INCLUDE_KEYS=false
SOURCE="draft"

show_help() {
    echo "Export an artist's releases from the content node"
    echo ""
    echo "Usage:"
    echo "  $0 --npub npub1... --album \"Album Name\""
    echo "  $0 --npub npub1... --all-albums"
    echo ""
    echo "Options:"
    echo "  --npub NPUB       Artist's npub (required)"
    echo "  --album NAME      Export a specific album/release"
    echo "  --all-albums      Export all albums"
    echo "  --source SOURCE   Source: draft or nostr (default: draft)"
    echo "  --include-keys    Include identity backup (prompts for nsec)"
    echo "  --output DIR      Output directory (default: ./packages/)"
    echo "  --base-url URL    Content node URL (default: http://localhost)"
    echo "  -h, --help        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 --npub npub1abc... --album \"Neon Dreams\""
    echo "  $0 --npub npub1abc... --all-albums --include-keys"
    echo "  $0 --npub npub1abc... --album \"Singles\" --source nostr"
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
        --album)
            ALBUM_NAME="$2"
            shift 2
            ;;
        --all-albums)
            ALL_ALBUMS=true
            shift
            ;;
        --source)
            SOURCE="$2"
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

if [[ -z "$ALBUM_NAME" && "$ALL_ALBUMS" == "false" ]]; then
    echo -e "${RED}Error: Specify --album NAME or --all-albums${NC}"
    show_help
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

# Sign a NOSTR event using Python
sign_event() {
    local event_json="$1"
    local privkey_hex="$2"

    python3 << PYTHON
import json
import hashlib
import sys

try:
    from coincurve import PrivateKey
except ImportError:
    print("ERROR: coincurve required for signing. Install: pip install coincurve", file=sys.stderr)
    sys.exit(1)

event = json.loads('''$event_json''')
privkey_hex = "$privkey_hex"

# Calculate event ID
serialized = json.dumps([
    0,
    event["pubkey"],
    event["created_at"],
    event["kind"],
    event["tags"],
    event["content"]
], separators=(',', ':'), ensure_ascii=False)

event_id = hashlib.sha256(serialized.encode()).hexdigest()
event["id"] = event_id

# Schnorr sign
pk = PrivateKey(bytes.fromhex(privkey_hex))
sig = pk.sign_schnorr(bytes.fromhex(event_id))
event["sig"] = sig.hex()

print(json.dumps(event))
PYTHON
}

# Decode nsec to hex private key
nsec_to_hex() {
    local nsec="$1"
    python3 << PYTHON
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

hrp, data = bech32_decode("$nsec")
if hrp == "nsec":
    decoded = convertbits(data, 5, 8, False)
    if decoded:
        print(bytes(decoded).hex())
PYTHON
}

# Get list of albums from drafts
get_draft_albums() {
    local pubkey="$1"
    local response=$(curl -s "$BASE_URL/api/drafts?pubkey=$pubkey")
    echo "$response" | jq -r '.drafts[].album // empty' | sort -u | grep -v '^$'
}

# Export a single album as .eqpkg.zip
export_album() {
    local album="$1"
    local pubkey_hex="$2"
    local privkey_hex="$3"

    echo -e "  ${CYAN}$album${NC}"

    # Step 1: Prepare export (get manifest + unsigned event)
    echo -e "    Preparing manifest..."
    local prepare_response=$(curl -s -w "\n%{http_code}" -X POST \
        "$BASE_URL/api/releases/export-prepare" \
        -H "Content-Type: application/json" \
        -d "{\"album\": \"$album\", \"pubkey\": \"$pubkey_hex\", \"source\": \"$SOURCE\"}")

    local http_code=$(echo "$prepare_response" | tail -1)
    local body=$(echo "$prepare_response" | sed '$d')

    if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
        local detail=$(echo "$body" | jq -r '.detail // "Unknown error"')
        echo -e "    ${RED}✗ Prepare failed ($http_code): $detail${NC}"
        return 1
    fi

    local manifest=$(echo "$body" | jq '.manifest')
    local unsigned_event=$(echo "$body" | jq '.unsigned_event')
    local track_count=$(echo "$manifest" | jq '.tracks | length')

    echo -e "    ${GREEN}✓ Manifest ready ($track_count tracks)${NC}"

    # Step 2: Sign the event
    echo -e "    Signing package..."
    local signed_event=$(sign_event "$unsigned_event" "$privkey_hex")

    if [[ -z "$signed_event" || "$signed_event" == "null" ]]; then
        echo -e "    ${RED}✗ Signing failed${NC}"
        return 1
    fi

    echo -e "    ${GREEN}✓ Event signed${NC}"

    # Step 3: Download the .eqpkg.zip
    echo -e "    Downloading package..."
    local download_body=$(jq -n --argjson manifest "$manifest" --argjson signed_event "$signed_event" \
        '{manifest: $manifest, signed_event: $signed_event}')

    local safe_name=$(echo "$album" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')
    local output_file="$OUTPUT_DIR/${safe_name}.eqpkg.zip"

    local dl_code=$(curl -s -w "%{http_code}" -o "$output_file" -X POST \
        "$BASE_URL/api/releases/export-download" \
        -H "Content-Type: application/json" \
        -d "$download_body")

    if [[ "$dl_code" -ge 200 && "$dl_code" -lt 300 ]]; then
        local file_size=$(ls -lh "$output_file" | awk '{print $5}')
        echo -e "    ${GREEN}✓ Saved: $output_file ($file_size)${NC}"
        return 0
    else
        echo -e "    ${RED}✗ Download failed ($dl_code)${NC}"
        rm -f "$output_file"
        return 1
    fi
}

# Main execution
main() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}Equaliser Release Package Exporter${NC}"
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

    # Prompt for nsec (required for signing packages)
    echo -e "${BLUE}Package signing requires the artist's nsec.${NC}"
    read -s -p "Enter nsec: " nsec_input
    echo ""

    if [[ -z "$nsec_input" || ! "$nsec_input" =~ ^nsec1 ]]; then
        echo -e "${RED}Error: Valid nsec required for signing export packages${NC}"
        exit 1
    fi

    local privkey_hex=$(nsec_to_hex "$nsec_input")
    if [[ -z "$privkey_hex" ]]; then
        echo -e "${RED}Error: Failed to decode nsec${NC}"
        exit 1
    fi

    echo -e "${GREEN}  ✓ Identity loaded${NC}"
    echo ""

    # Create output directory
    mkdir -p "$OUTPUT_DIR"

    # Determine which albums to export
    local albums=()

    if [[ "$ALL_ALBUMS" == "true" ]]; then
        echo -e "${BLUE}Finding albums...${NC}"
        while IFS= read -r album; do
            [[ -n "$album" ]] && albums+=("$album")
        done < <(get_draft_albums "$pubkey_hex")

        if [[ ${#albums[@]} -eq 0 ]]; then
            echo -e "${YELLOW}No albums found for this artist.${NC}"
            exit 0
        fi

        echo -e "  Found ${#albums[@]} album(s)"
        echo ""
    else
        albums=("$ALBUM_NAME")
    fi

    # Export each album
    echo -e "${BLUE}Exporting releases...${NC}"
    local success_count=0
    local fail_count=0

    for album in "${albums[@]}"; do
        if export_album "$album" "$pubkey_hex" "$privkey_hex"; then
            ((success_count++))
        else
            ((fail_count++))
        fi
    done

    echo ""

    # Handle --include-keys (save identity backup)
    if [[ "$INCLUDE_KEYS" == "true" ]]; then
        echo -e "${BLUE}Saving identity backup...${NC}"

        # Get artist name from profile
        local artist_name="unknown"
        local profile_response=$(curl -s "$BASE_URL/api/drafts?pubkey=$pubkey_hex&status=draft")
        artist_name=$(echo "$profile_response" | jq -r '.drafts[0].artist_name // "unknown"')
        local artist_slug=$(echo "$artist_name" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')

        local backup_file="$OUTPUT_DIR/equaliser-backup-${artist_slug}-$(date +%s).json"

        cat > "$backup_file" << EOF
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
    "name": "$artist_name"
  }
}
EOF

        echo -e "${GREEN}  ✓ Identity backup saved: $backup_file${NC}"
        echo ""
    fi

    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Export complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "Results:"
    echo -e "  ${GREEN}✓ Exported: $success_count${NC}"
    [[ $fail_count -gt 0 ]] && echo -e "  ${RED}✗ Failed: $fail_count${NC}"
    echo ""
    echo -e "Packages saved in: ${CYAN}$OUTPUT_DIR${NC}"
    echo ""
    echo -e "To import on another node:"
    echo -e "  ./tools/import-artist.sh $OUTPUT_DIR/<album>.eqpkg.zip"
}

main
