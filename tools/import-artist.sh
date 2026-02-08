#!/bin/bash
#
# Import content into the Equaliser content node
#
# Supports two formats:
#   .eqpkg.zip      - Release package (audio + manifest, via API)
#   .artist-package  - Legacy artist package (identity + profile + releases)
#
# Usage:
#   ./tools/import-artist.sh <package-path> [options]
#
# Examples:
#   ./tools/import-artist.sh ./packages/release.eqpkg.zip
#   ./tools/import-artist.sh ./packages/release.eqpkg.zip --restore backup.json
#   ./tools/import-artist.sh ./packages/artist.artist-package
#   ./tools/import-artist.sh ./packages/artist.artist-package --restore
#
# Options:
#   --restore [file]  Use existing identity. For .eqpkg.zip, provide backup file path.
#   --dry-run         Preview import without making changes
#   --base-url URL    Content node URL (default: http://localhost)
#   --skip-profile    Skip profile creation
#   -h, --help        Show this help message
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
DRY_RUN=false
RESTORE_MODE=false
SKIP_PROFILE=false
PACKAGE_PATH=""
RESTORE_BACKUP_FILE=""

# Generated identity (for fresh imports)
GENERATED_NSEC=""
GENERATED_NPUB=""
GENERATED_PRIVKEY_HEX=""
GENERATED_PUBKEY_HEX=""

# Import result (for .eqpkg.zip)
IMPORT_ARTIST_NAME=""

show_help() {
    echo "Import content into the Equaliser content node"
    echo ""
    echo "Usage:"
    echo "  $0 <package-path> [options]"
    echo ""
    echo "Formats:"
    echo "  .eqpkg.zip      Release package (audio + metadata)"
    echo "  .artist-package  Legacy package (identity + profile + releases)"
    echo ""
    echo "Options:"
    echo "  --restore [file]  Use existing identity from backup file"
    echo "  --dry-run         Preview import without making changes"
    echo "  --base-url URL    Content node URL (default: http://localhost)"
    echo "  --skip-profile    Skip profile creation"
    echo "  -h, --help        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 ./packages/release.eqpkg.zip"
    echo "  $0 ./packages/release.eqpkg.zip --restore backup.json"
    echo "  $0 ./packages/artist.artist-package"
    echo "  $0 ./packages/artist.artist-package --restore"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        --restore)
            RESTORE_MODE=true
            # Check if next arg is a backup file path (JSON, not a flag)
            if [[ $# -gt 1 && ! "$2" =~ ^-- && "$2" == *.json ]]; then
                RESTORE_BACKUP_FILE="$2"
                shift
            fi
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --base-url)
            BASE_URL="$2"
            shift 2
            ;;
        --skip-profile)
            SKIP_PROFILE=true
            shift
            ;;
        *)
            PACKAGE_PATH="$1"
            shift
            ;;
    esac
done

# Validate arguments
if [[ -z "$PACKAGE_PATH" ]]; then
    echo -e "${RED}Error: Please specify a package path${NC}"
    show_help
    exit 1
fi

# Detect package type
IS_EQPKG=false
if [[ "$PACKAGE_PATH" == *.eqpkg.zip || "$PACKAGE_PATH" == *.zip ]]; then
    IS_EQPKG=true
    if [[ ! -f "$PACKAGE_PATH" ]]; then
        echo -e "${RED}Error: Package file not found: $PACKAGE_PATH${NC}"
        exit 1
    fi
elif [[ ! -d "$PACKAGE_PATH" ]]; then
    echo -e "${RED}Error: Package not found: $PACKAGE_PATH${NC}"
    exit 1
fi

# Check dependencies
check_deps() {
    local missing=()
    command -v jq &> /dev/null || missing+=("jq")
    command -v curl &> /dev/null || missing+=("curl")

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo -e "${RED}Error: Missing dependencies: ${missing[*]}${NC}"
        echo "Install with: brew install ${missing[*]}"
        exit 1
    fi
}

# Check content node is running
check_node() {
    echo -e "${BLUE}Checking content node...${NC}"
    if ! curl -s "$BASE_URL/api/health" > /dev/null 2>&1; then
        # Try the tracks endpoint as fallback
        if ! curl -s "$BASE_URL/api/tracks/" > /dev/null 2>&1; then
            echo -e "${RED}Error: Content node not responding at $BASE_URL${NC}"
            echo "Start it with: ./tools/start-node.sh -d"
            exit 1
        fi
    fi
    echo -e "${GREEN}  ✓ Content node is running${NC}"
}

# Generate new NOSTR identity using Python (nostr-tools equivalent)
generate_identity() {
    echo -e "${BLUE}Generating new NOSTR identity...${NC}"

    # Use Python with secp256k1 to generate keys
    local result=$(python3 << 'PYTHON'
import secrets
import hashlib

try:
    # Try using coincurve (faster, C-based)
    from coincurve import PrivateKey
    privkey_bytes = secrets.token_bytes(32)
    privkey = PrivateKey(privkey_bytes)
    pubkey_bytes = privkey.public_key.format(compressed=True)[1:]  # Remove prefix byte
    privkey_hex = privkey_bytes.hex()
    pubkey_hex = pubkey_bytes.hex()
except ImportError:
    # Fallback: use ecdsa library
    try:
        from ecdsa import SigningKey, SECP256k1
        sk = SigningKey.generate(curve=SECP256k1)
        vk = sk.get_verifying_key()
        privkey_hex = sk.to_string().hex()
        # Get x-coordinate only (32 bytes) for NOSTR pubkey
        pubkey_hex = vk.to_string()[:32].hex()
    except ImportError:
        # Last resort: generate random bytes (won't work for signing, but OK for testing)
        import sys
        print("ERROR: No crypto library available. Install: pip install coincurve", file=sys.stderr)
        sys.exit(1)

# Bech32 encoding for nsec/npub
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

def bech32_create_checksum(hrp, data):
    values = bech32_hrp_expand(hrp) + data
    polymod = bech32_polymod(values + [0, 0, 0, 0, 0, 0]) ^ 1
    return [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]

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

def bech32_encode(hrp, data):
    combined = data + bech32_create_checksum(hrp, data)
    return hrp + "1" + "".join([CHARSET[d] for d in combined])

def hex_to_bech32(hrp, hex_str):
    data = bytes.fromhex(hex_str)
    converted = convertbits(list(data), 8, 5)
    return bech32_encode(hrp, converted)

nsec = hex_to_bech32("nsec", privkey_hex)
npub = hex_to_bech32("npub", pubkey_hex)

print(f"{nsec}|{npub}|{privkey_hex}|{pubkey_hex}")
PYTHON
    )

    if [[ -z "$result" || "$result" == *"ERROR"* ]]; then
        echo -e "${RED}Error: Failed to generate identity${NC}"
        echo "Install crypto library: pip install coincurve"
        exit 1
    fi

    IFS='|' read -r GENERATED_NSEC GENERATED_NPUB GENERATED_PRIVKEY_HEX GENERATED_PUBKEY_HEX <<< "$result"

    echo -e "${GREEN}  ✓ Generated new identity${NC}"
    echo -e "    npub: ${CYAN}$GENERATED_NPUB${NC}"
}

# Load identity from backup.json
load_identity() {
    local backup_file=""

    if [[ -n "$RESTORE_BACKUP_FILE" ]]; then
        # Explicit backup file path (for .eqpkg.zip imports)
        backup_file="$RESTORE_BACKUP_FILE"
    else
        # Legacy: look inside the package directory
        backup_file="$PACKAGE_PATH/identity/backup.json"
    fi

    if [[ ! -f "$backup_file" ]]; then
        echo -e "${RED}Error: Backup file not found: $backup_file${NC}"
        if [[ "$IS_EQPKG" == "true" ]]; then
            echo "For .eqpkg.zip imports, provide a backup file:"
            echo "  $0 package.eqpkg.zip --restore backup.json"
        fi
        exit 1
    fi

    echo -e "${BLUE}Loading identity from backup...${NC}"

    GENERATED_NSEC=$(jq -r '.keys.nsec' "$backup_file")
    GENERATED_NPUB=$(jq -r '.keys.npub' "$backup_file")
    GENERATED_PRIVKEY_HEX=$(jq -r '.keys.privateKeyHex' "$backup_file")
    GENERATED_PUBKEY_HEX=$(jq -r '.keys.publicKeyHex' "$backup_file")

    if [[ -z "$GENERATED_NSEC" || "$GENERATED_NSEC" == "null" ]]; then
        echo -e "${RED}Error: Invalid backup file - missing keys${NC}"
        exit 1
    fi

    echo -e "${GREEN}  ✓ Loaded identity from backup${NC}"
    echo -e "    npub: ${CYAN}$GENERATED_NPUB${NC}"
}

# Upload image to IPFS via orchestrator
upload_image() {
    local image_path="$1"
    local image_name=$(basename "$image_path")

    if [[ ! -f "$image_path" ]]; then
        echo ""
        return
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "[dry-run] Would upload: $image_name"
        return
    fi

    local response=$(curl -s -X POST "$BASE_URL/api/tracks/cover-art" \
        -F "file=@$image_path")

    local cid=$(echo "$response" | jq -r '.cid // empty')

    if [[ -z "$cid" ]]; then
        echo -e "${YELLOW}Warning: Failed to upload $image_name${NC}"
        echo ""
        return
    fi

    echo "$cid"
}

# Create and publish Kind 0 profile event
publish_profile() {
    local profile_file="$PACKAGE_PATH/identity/profile.json"

    if [[ ! -f "$profile_file" ]]; then
        echo -e "${YELLOW}Warning: No profile.json found, skipping profile${NC}"
        return
    fi

    echo -e "${BLUE}Publishing profile...${NC}"

    # Upload avatar and banner
    local avatar_cid=""
    local banner_cid=""

    if [[ -f "$PACKAGE_PATH/media/avatar.jpg" ]]; then
        echo -e "  Uploading avatar..."
        avatar_cid=$(upload_image "$PACKAGE_PATH/media/avatar.jpg")
        [[ -n "$avatar_cid" ]] && echo -e "${GREEN}    ✓ Avatar CID: $avatar_cid${NC}"
    fi

    if [[ -f "$PACKAGE_PATH/media/banner.jpg" ]]; then
        echo -e "  Uploading banner..."
        banner_cid=$(upload_image "$PACKAGE_PATH/media/banner.jpg")
        [[ -n "$banner_cid" ]] && echo -e "${GREEN}    ✓ Banner CID: $banner_cid${NC}"
    fi

    # Build profile content with IPFS URLs
    local picture_url=""
    local banner_url=""
    [[ -n "$avatar_cid" ]] && picture_url="$BASE_URL/ipfs/$avatar_cid"
    [[ -n "$banner_cid" ]] && banner_url="$BASE_URL/ipfs/$banner_cid"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}  [dry-run] Would publish Kind 0 profile${NC}"
        return
    fi

    # Use Python to create and sign the Kind 0 event
    python3 << PYTHON
import json
import time
import hashlib
import sys

try:
    from coincurve import PrivateKey
    HAS_COINCURVE = True
except ImportError:
    HAS_COINCURVE = False
    try:
        from ecdsa import SigningKey, SECP256k1
        from ecdsa.util import sigencode_string_canonize
    except ImportError:
        print("ERROR: No crypto library. Install: pip install coincurve", file=sys.stderr)
        sys.exit(1)

import websocket

# Load profile
with open("$profile_file", "r") as f:
    profile = json.load(f)

# Add IPFS URLs
picture_url = "$picture_url"
banner_url = "$banner_url"
if picture_url:
    profile["picture"] = picture_url
if banner_url:
    profile["banner"] = banner_url

# Create Kind 0 event
pubkey = "$GENERATED_PUBKEY_HEX"
privkey_hex = "$GENERATED_PRIVKEY_HEX"
created_at = int(time.time())

event = {
    "kind": 0,
    "pubkey": pubkey,
    "created_at": created_at,
    "tags": [],
    "content": json.dumps(profile)
}

# Calculate event ID
serialized = json.dumps([
    0,
    event["pubkey"],
    event["created_at"],
    event["kind"],
    event["tags"],
    event["content"]
], separators=(',', ':'))

event_id = hashlib.sha256(serialized.encode()).hexdigest()
event["id"] = event_id

# Sign the event
privkey_bytes = bytes.fromhex(privkey_hex)
id_bytes = bytes.fromhex(event_id)

if HAS_COINCURVE:
    pk = PrivateKey(privkey_bytes)
    sig = pk.sign_schnorr(id_bytes)
    event["sig"] = sig.hex()
else:
    # ECDSA fallback (not Schnorr, but works for some relays)
    sk = SigningKey.from_string(privkey_bytes, curve=SECP256k1)
    sig = sk.sign_deterministic(id_bytes, sigencode=sigencode_string_canonize)
    event["sig"] = sig.hex()

# Publish to relay
relay_url = "$RELAY_URL"
try:
    ws = websocket.create_connection(relay_url, timeout=10)
    message = json.dumps(["EVENT", event])
    ws.send(message)
    response = ws.recv()
    ws.close()
    result = json.loads(response)
    if result[0] == "OK" and result[2]:
        print(f"SUCCESS: Profile published, event ID: {event_id[:16]}...")
    else:
        print(f"WARNING: Relay response: {result}")
except Exception as e:
    print(f"ERROR: Failed to publish profile: {e}", file=sys.stderr)
PYTHON
}

# Import a single release as draft (legacy .artist-package format)
import_release() {
    local release_dir="$1"
    local release_slug=$(basename "$release_dir")

    echo -e "  ${CYAN}$release_slug${NC}"

    local metadata_file="$release_dir/metadata.json"
    if [[ ! -f "$metadata_file" ]]; then
        echo -e "    ${RED}✗ No metadata.json${NC}"
        return 1
    fi

    # Read metadata
    local title=$(jq -r '.title' "$metadata_file")
    local artist=$(jq -r '.artist' "$metadata_file")
    local album=$(jq -r '.album // empty' "$metadata_file")
    local genre=$(jq -r '.genre // empty' "$metadata_file")
    local price_amount=$(jq -r '.price_amount // 0.05' "$metadata_file")
    local price_currency=$(jq -r '.price_currency // "USD"' "$metadata_file")
    local release_date=$(jq -r '.release_date // empty' "$metadata_file")
    local release_type=$(jq -r '.release_type // "single"' "$metadata_file")
    local audio_file=$(jq -r '.audio_file' "$metadata_file")
    local cover_file=$(jq -r '.cover_file // empty' "$metadata_file")

    local audio_path="$release_dir/$audio_file"
    if [[ ! -f "$audio_path" ]]; then
        echo -e "    ${RED}✗ Audio file not found: $audio_file${NC}"
        return 1
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "    ${YELLOW}[dry-run] Would upload: $title${NC}"
        return 0
    fi

    # Upload cover art first if present
    local cover_cid=""
    if [[ -n "$cover_file" && -f "$release_dir/$cover_file" ]]; then
        cover_cid=$(upload_image "$release_dir/$cover_file")
    fi

    # Determine mime type based on extension
    local mime_type="audio/mpeg"
    case "$audio_filename" in
        *.wav) mime_type="audio/wav" ;;
        *.flac) mime_type="audio/flac" ;;
        *.ogg) mime_type="audio/ogg" ;;
        *.m4a) mime_type="audio/mp4" ;;
    esac

    # Build form data for upload
    local form_args=(
        -F "file=@$audio_path;type=$mime_type"
        -F "title=$title"
        -F "artist=$artist"
        -F "price_amount=$price_amount"
        -F "price_currency=$price_currency"
        -F "artist_pubkey=$GENERATED_PUBKEY_HEX"
    )

    [[ -n "$album" ]] && form_args+=(-F "album=$album")
    [[ -n "$genre" ]] && form_args+=(-F "genre=$genre")
    [[ -n "$release_date" ]] && form_args+=(-F "release_date=$release_date")
    [[ -n "$release_type" ]] && form_args+=(-F "release_type=$release_type")
    [[ -n "$cover_cid" ]] && form_args+=(-F "cover_art_cid=$cover_cid")

    # Upload track
    local response=$(curl -s -X POST "$BASE_URL/api/tracks/upload" "${form_args[@]}")
    local track_id=$(echo "$response" | jq -r '.track_id // empty')
    local status=$(echo "$response" | jq -r '.status // empty')

    if [[ -z "$track_id" ]]; then
        echo -e "    ${RED}✗ Upload failed: $(echo "$response" | jq -r '.detail // "Unknown error"')${NC}"
        return 1
    fi

    echo -e "    ${GREEN}✓ Upload started: $track_id${NC}"

    # Poll for completion
    local max_attempts=60
    local attempt=0
    while [[ $attempt -lt $max_attempts ]]; do
        sleep 2
        local status_response=$(curl -s "$BASE_URL/api/tracks/status/$track_id")
        status=$(echo "$status_response" | jq -r '.status')
        local progress=$(echo "$status_response" | jq -r '.progress')
        local message=$(echo "$status_response" | jq -r '.message')

        if [[ "$status" == "complete" ]]; then
            echo -e "    ${GREEN}✓ Processing complete - saved as draft${NC}"
            return 0
        elif [[ "$status" == "error" ]]; then
            echo -e "    ${RED}✗ Processing failed: $message${NC}"
            return 1
        fi

        ((attempt++))
    done

    echo -e "    ${YELLOW}⚠ Processing timeout - check status manually${NC}"
    return 1
}

# Save generated identity backup (legacy format)
save_identity_backup() {
    local manifest_file="$PACKAGE_PATH/manifest.json"
    local artist_name=$(jq -r '.artist.name' "$manifest_file")
    local artist_slug=$(jq -r '.artist.slug' "$manifest_file")

    # Load profile for backup
    local profile_file="$PACKAGE_PATH/identity/profile.json"
    local bio=""
    local location=""
    local genres="[]"

    if [[ -f "$profile_file" ]]; then
        bio=$(jq -r '.about // ""' "$profile_file")
        location=$(jq -r '.equaliser.location // ""' "$profile_file")
        genres=$(jq -c '.equaliser.genres // []' "$profile_file")
    fi

    mkdir -p "$PROJECT_ROOT/packages"
    local backup_file="$PROJECT_ROOT/packages/equaliser-backup-${artist_slug}-$(date +%s).json"

    cat > "$backup_file" << EOF
{
  "version": 1,
  "created": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "keys": {
    "nsec": "$GENERATED_NSEC",
    "npub": "$GENERATED_NPUB",
    "privateKeyHex": "$GENERATED_PRIVKEY_HEX",
    "publicKeyHex": "$GENERATED_PUBKEY_HEX"
  },
  "profile": {
    "name": "$artist_name",
    "bio": "$bio",
    "location": "$location",
    "genres": $genres
  }
}
EOF

    echo -e "${GREEN}Identity backup saved: $backup_file${NC}"
    echo ""
    echo -e "To login to the dashboard:"
    echo -e "  1. Go to ${CYAN}$BASE_URL/admin/login.html${NC}"
    echo -e "  2. Click 'Load Backup File' and select: ${CYAN}$backup_file${NC}"
}

# Import .eqpkg.zip release package via API
import_eqpkg() {
    local pkg_path="$1"

    echo -e "${BLUE}Importing release package...${NC}"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}  [dry-run] Would import: $(basename "$pkg_path")${NC}"
        return 0
    fi

    # Ensure filename ends with .eqpkg.zip for the API
    local filename=$(basename "$pkg_path")
    local curl_filename="$filename"
    if [[ "$filename" != *.eqpkg.zip ]]; then
        curl_filename="${filename%.zip}.eqpkg.zip"
    fi

    echo -e "  Uploading and processing (this may take a few minutes)..."

    local response=$(curl -s --max-time 600 -w "\n%{http_code}" -X POST \
        "$BASE_URL/api/releases/import" \
        -F "file=@$pkg_path;filename=$curl_filename" \
        -F "pubkey=$GENERATED_PUBKEY_HEX")

    # Split response body and HTTP status
    local http_code=$(echo "$response" | tail -1)
    local body=$(echo "$response" | sed '$d')

    if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
        local track_count=$(echo "$body" | jq -r '.track_count // 0')
        local album=$(echo "$body" | jq -r '.album // "Unknown"')
        local artist=$(echo "$body" | jq -r '.artist // "Unknown"')

        echo -e "  ${GREEN}✓ Imported $track_count track(s)${NC}"
        echo -e "    Album: ${CYAN}$album${NC}"
        echo -e "    Artist: ${CYAN}$artist${NC}"

        IMPORT_ARTIST_NAME="$artist"
        return 0
    else
        local detail=$(echo "$body" | jq -r '.detail // "Unknown error"')
        echo -e "  ${RED}✗ Import failed ($http_code): $detail${NC}"
        return 1
    fi
}

# Main flow for .eqpkg.zip packages
main_eqpkg() {
    echo -e "Package: ${CYAN}$(basename "$PACKAGE_PATH")${NC}"
    echo -e "Format:  .eqpkg.zip (release package)"
    echo -e "Mode:    $(if [[ "$RESTORE_MODE" == "true" ]]; then echo "Restore identity"; else echo "Fresh identity"; fi)"
    [[ "$DRY_RUN" == "true" ]] && echo -e "${YELLOW}DRY RUN - no changes will be made${NC}"
    echo ""

    if [[ "$DRY_RUN" != "true" ]]; then
        check_node
        echo ""
    fi

    # Setup identity
    if [[ "$RESTORE_MODE" == "true" ]]; then
        load_identity
    else
        generate_identity
    fi
    echo ""

    # Import releases via API
    if ! import_eqpkg "$PACKAGE_PATH"; then
        echo -e "${RED}Import failed${NC}"
        exit 1
    fi
    echo ""

    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Import complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    # Save identity backup for login
    if [[ "$DRY_RUN" != "true" && "$RESTORE_MODE" != "true" ]]; then
        local artist_name="${IMPORT_ARTIST_NAME:-unknown-artist}"
        local artist_slug=$(echo "$artist_name" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')

        mkdir -p "$PROJECT_ROOT/packages"
        local backup_file="$PROJECT_ROOT/packages/equaliser-backup-${artist_slug}-$(date +%s).json"

        cat > "$backup_file" << EOF
{
  "version": 1,
  "created": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "keys": {
    "nsec": "$GENERATED_NSEC",
    "npub": "$GENERATED_NPUB",
    "privateKeyHex": "$GENERATED_PRIVKEY_HEX",
    "publicKeyHex": "$GENERATED_PUBKEY_HEX"
  },
  "profile": {
    "name": "$artist_name",
    "bio": "",
    "location": "",
    "genres": []
  }
}
EOF

        echo -e "${GREEN}Identity backup saved: $backup_file${NC}"
        echo ""
        echo -e "To login to the dashboard:"
        echo -e "  1. Go to ${CYAN}$BASE_URL/admin/login.html${NC}"
        echo -e "  2. Click 'Load Backup File' and select: ${CYAN}$backup_file${NC}"
    fi
}

# Main execution
main() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}Equaliser Artist Package Importer${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""

    check_deps

    # Branch based on package type
    if [[ "$IS_EQPKG" == "true" ]]; then
        main_eqpkg
        return
    fi

    # --- Legacy .artist-package flow ---

    # Validate package
    local manifest_file="$PACKAGE_PATH/manifest.json"
    if [[ ! -f "$manifest_file" ]]; then
        echo -e "${RED}Error: Invalid package - no manifest.json${NC}"
        exit 1
    fi

    local format=$(jq -r '.format' "$manifest_file")
    if [[ "$format" != "equaliser-artist-package" ]]; then
        echo -e "${RED}Error: Invalid package format: $format${NC}"
        exit 1
    fi

    local artist_name=$(jq -r '.artist.name' "$manifest_file")
    local artist_slug=$(jq -r '.artist.slug' "$manifest_file")
    local release_count=$(jq -r '.contents.release_count' "$manifest_file")
    local has_identity=$(jq -r '.contents.has_identity' "$manifest_file")

    echo -e "Package: ${CYAN}$artist_name${NC} ($artist_slug)"
    echo -e "Releases: $release_count"
    echo -e "Mode: $(if [[ "$RESTORE_MODE" == "true" ]]; then echo "Restore"; else echo "Fresh import"; fi)"
    [[ "$DRY_RUN" == "true" ]] && echo -e "${YELLOW}DRY RUN - no changes will be made${NC}"
    echo ""

    if [[ "$DRY_RUN" != "true" ]]; then
        check_node
        echo ""
    fi

    # Setup identity
    if [[ "$RESTORE_MODE" == "true" ]]; then
        load_identity
    else
        generate_identity
    fi
    echo ""

    # Publish profile
    if [[ "$SKIP_PROFILE" != "true" ]]; then
        publish_profile
        echo ""
    fi

    # Import releases
    echo -e "${BLUE}Importing releases as drafts...${NC}"
    local success_count=0
    local fail_count=0

    for release_dir in "$PACKAGE_PATH/releases"/*/; do
        [[ -d "$release_dir" ]] || continue
        if import_release "$release_dir"; then
            ((success_count++))
        else
            ((fail_count++))
        fi
    done

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Import complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "Results:"
    echo -e "  ${GREEN}✓ Successful: $success_count${NC}"
    [[ $fail_count -gt 0 ]] && echo -e "  ${RED}✗ Failed: $fail_count${NC}"
    echo ""

    # Save identity backup for login
    if [[ "$DRY_RUN" != "true" && "$RESTORE_MODE" != "true" ]]; then
        save_identity_backup
    fi
}

main
