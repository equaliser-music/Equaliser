#!/bin/bash
#
# Convert mockups/content artist folders to .eqpkg.zip release packages
#
# Creates .eqpkg.zip files from mockup artist data (audio, metadata, cover art).
# Also outputs profile data separately for identity setup.
#
# Usage:
#   ./tools/convert-mockup.sh <artist-slug>
#   ./tools/convert-mockup.sh shibuya-crossings
#   ./tools/convert-mockup.sh --all
#
# Options:
#   --all           Convert all artists in mockups/content/music/artists/
#   --output DIR    Output directory (default: ./packages/)
#   --legacy        Also create legacy .artist-package directory
#   -h, --help      Show this help message
#
# Output:
#   packages/<slug>.eqpkg.zip              Release package (audio + manifest)
#   packages/<slug>.artist-package/        Legacy format (if --legacy)

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

MOCKUPS_DIR="$PROJECT_ROOT/mockups/content/music/artists"
OUTPUT_DIR="$PROJECT_ROOT/packages"

# Parse arguments
ARTIST_SLUG=""
CONVERT_ALL=false
LEGACY_MODE=false

show_help() {
    echo "Convert mockups/content artist to .eqpkg.zip release packages"
    echo ""
    echo "Usage:"
    echo "  $0 <artist-slug>     Convert a specific artist"
    echo "  $0 --all             Convert all artists"
    echo ""
    echo "Options:"
    echo "  --output <dir>       Output directory (default: ./packages/)"
    echo "  --legacy             Also create legacy .artist-package format"
    echo "  -h, --help           Show this help message"
    echo ""
    echo "Output:"
    echo "  <slug>.eqpkg.zip              Release package (for import)"
    echo "  <slug>.artist-package/        Legacy format (with --legacy)"
    echo ""
    echo "Examples:"
    echo "  $0 shibuya-crossings"
    echo "  $0 --all --output ./my-packages/"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        --all)
            CONVERT_ALL=true
            shift
            ;;
        --output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --legacy)
            LEGACY_MODE=true
            shift
            ;;
        *)
            ARTIST_SLUG="$1"
            shift
            ;;
    esac
done

# Validate arguments
if [[ "$CONVERT_ALL" == "false" && -z "$ARTIST_SLUG" ]]; then
    echo -e "${RED}Error: Please specify an artist slug or use --all${NC}"
    show_help
    exit 1
fi

# Check mockups directory exists
if [[ ! -d "$MOCKUPS_DIR" ]]; then
    echo -e "${RED}Error: Mockups directory not found: $MOCKUPS_DIR${NC}"
    exit 1
fi

# Check for required tools
command -v jq &> /dev/null || { echo -e "${RED}Error: jq required. Install with: brew install jq${NC}"; exit 1; }
command -v python3 &> /dev/null || { echo -e "${RED}Error: python3 required${NC}"; exit 1; }

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Compute SHA-256 of a file
compute_sha256() {
    python3 -c "import hashlib; f=open('$1','rb'); print(hashlib.sha256(f.read()).hexdigest()); f.close()"
}

# Make a safe filename
safe_filename() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-_.'
}

# Convert a single artist to .eqpkg.zip
convert_artist() {
    local slug="$1"
    local source_dir="$MOCKUPS_DIR/$slug"
    local eqpkg_file="$OUTPUT_DIR/$slug.eqpkg.zip"

    echo -e "${BLUE}Converting: $slug${NC}"

    # Check source exists
    if [[ ! -d "$source_dir" ]]; then
        echo -e "${RED}  Error: Artist not found: $source_dir${NC}"
        return 1
    fi

    # Read bio.json for profile/artist data
    local bio_file="$source_dir/profile/bio.json"
    local artist_name=""
    local genre=""

    if [[ -f "$bio_file" ]]; then
        artist_name=$(jq -r '.name // empty' "$bio_file")
        genre=$(jq -r '.genres[0] // empty' "$bio_file")
    fi
    [[ -z "$artist_name" ]] && artist_name="$slug"

    # Build album lookup from albums/ folder
    local albums_dir="$source_dir/albums"
    local album_lookup_file=$(mktemp)
    if [[ -d "$albums_dir" ]]; then
        for album_dir in "$albums_dir"/*/; do
            [[ -d "$album_dir" ]] || continue
            local album_metadata="$album_dir/metadata.json"
            if [[ -f "$album_metadata" ]]; then
                jq -r 'select(.albumId and .title) | "\(.albumId)=\(.title)"' "$album_metadata" >> "$album_lookup_file"
            fi
        done
    fi

    # Collect tracks and group by album
    local tracks_dir="$source_dir/tracks"
    local temp_dir=$(mktemp -d)
    local track_count=0

    # Track data as JSON for manifest building
    local tracks_json="[]"

    if [[ -d "$tracks_dir" ]]; then
        for track_dir in "$tracks_dir"/*/; do
            [[ -d "$track_dir" ]] || continue

            local track_slug=$(basename "$track_dir")
            local track_metadata="$track_dir/metadata.json"

            if [[ ! -f "$track_metadata" ]]; then
                echo -e "${YELLOW}  Skipping $track_slug: no metadata.json${NC}"
                continue
            fi

            # Find audio file
            local audio_file=""
            local audio_ext=""
            if [[ -f "$track_dir/full.mp3" ]]; then
                audio_file="$track_dir/full.mp3"
                audio_ext=".mp3"
            elif [[ -f "$track_dir/full.wav" ]]; then
                audio_file="$track_dir/full.wav"
                audio_ext=".wav"
            elif [[ -f "$track_dir/full.flac" ]]; then
                audio_file="$track_dir/full.flac"
                audio_ext=".flac"
            fi

            if [[ -z "$audio_file" ]]; then
                echo -e "${YELLOW}  Skipping $track_slug: no audio file${NC}"
                continue
            fi

            # Read track metadata
            local title=$(jq -r '.title // "Untitled"' "$track_metadata")
            local track_artist=$(jq -r '.artist // empty' "$track_metadata")
            [[ -z "$track_artist" ]] && track_artist="$artist_name"
            local track_album_id=$(jq -r '.albumId // empty' "$track_metadata")
            local track_number=$(jq -r '.trackNumber // empty' "$track_metadata")
            local duration=$(jq -r '.duration // 0' "$track_metadata")
            local track_genre=$(jq -r '.genre // empty' "$track_metadata")
            local price_amount=$(jq -r '.priceAmount // 0.05' "$track_metadata")
            local price_currency=$(jq -r '.priceCurrency // "USD"' "$track_metadata")

            # Look up album name
            local album_name=""
            if [[ -n "$track_album_id" && -f "$album_lookup_file" ]]; then
                album_name=$(grep "^${track_album_id}=" "$album_lookup_file" | cut -d'=' -f2- || true)
            fi

            # Determine track number
            ((track_count++))
            [[ -z "$track_number" || "$track_number" == "null" ]] && track_number=$track_count

            # Safe filename for inside the zip
            local safe_title=$(safe_filename "$title")
            local pkg_filename=$(printf "%02d-%s%s" "$track_number" "$safe_title" "$audio_ext")

            # Copy audio to temp dir
            mkdir -p "$temp_dir/tracks"
            cp "$audio_file" "$temp_dir/tracks/$pkg_filename"

            # Compute SHA-256
            local sha256=$(compute_sha256 "$audio_file")

            # Build track JSON entry
            local original_filename="$(basename "$audio_file")"
            tracks_json=$(echo "$tracks_json" | jq \
                --arg title "$title" \
                --arg track_number "$track_number" \
                --argjson duration "$duration" \
                --arg price_amount "$price_amount" \
                --arg price_currency "$price_currency" \
                --arg track_genre "$track_genre" \
                --arg filename "tracks/$pkg_filename" \
                --arg sha256 "$sha256" \
                --arg original_filename "$original_filename" \
                '. + [{
                    title: $title,
                    track_number: ($track_number | tonumber),
                    duration: $duration,
                    price_amount: ($price_amount | tonumber),
                    price_currency: $price_currency,
                    genre: $track_genre,
                    audio: {
                        filename: $filename,
                        sha256: $sha256,
                        original_filename: $original_filename
                    }
                }]')

            echo -e "${GREEN}  Added: $title${NC}"
        done
    fi

    # Clean up temp files
    [[ -f "$album_lookup_file" ]] && rm -f "$album_lookup_file"

    if [[ $track_count -eq 0 ]]; then
        echo -e "${RED}  Error: No tracks found${NC}"
        rm -rf "$temp_dir"
        return 1
    fi

    # Handle cover art - look for album cover or first track cover
    local cover_file=""
    local cover_ext=""
    if [[ -d "$albums_dir" ]]; then
        for album_dir in "$albums_dir"/*/; do
            [[ -d "$album_dir" ]] || continue
            if [[ -f "$album_dir/cover.jpg" ]]; then
                cover_file="$album_dir/cover.jpg"
                cover_ext=".jpg"
                break
            elif [[ -f "$album_dir/cover.png" ]]; then
                cover_file="$album_dir/cover.png"
                cover_ext=".png"
                break
            fi
        done
    fi

    # Fallback: check track directories for cover
    if [[ -z "$cover_file" && -d "$tracks_dir" ]]; then
        for track_dir in "$tracks_dir"/*/; do
            [[ -d "$track_dir" ]] || continue
            if [[ -f "$track_dir/cover.jpg" ]]; then
                cover_file="$track_dir/cover.jpg"
                cover_ext=".jpg"
                break
            elif [[ -f "$track_dir/cover.png" ]]; then
                cover_file="$track_dir/cover.png"
                cover_ext=".png"
                break
            fi
        done
    fi

    # Determine release info from first track or album
    local release_title="$artist_name"
    local release_type="album"
    local first_album=$(echo "$tracks_json" | jq -r '.[0].title // empty')

    # Use album name if available (from album lookup)
    if [[ -n "$album_name" ]]; then
        release_title="$album_name"
    fi

    # Build manifest.json
    local cover_art_json="null"
    if [[ -n "$cover_file" ]]; then
        local cover_sha256=$(compute_sha256 "$cover_file")
        cover_art_json=$(jq -n \
            --arg filename "cover${cover_ext}" \
            --arg sha256 "$cover_sha256" \
            '{filename: $filename, sha256: $sha256}')
        cp "$cover_file" "$temp_dir/cover${cover_ext}"
    fi

    local manifest=$(jq -n \
        --arg format_version "1.0" \
        --arg created_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --arg title "$release_title" \
        --arg artist "$artist_name" \
        --arg release_type "$release_type" \
        --arg genre "$genre" \
        --argjson tracks "$tracks_json" \
        --argjson cover_art "$cover_art_json" \
        '{
            format_version: $format_version,
            created_at: $created_at,
            release: {
                title: $title,
                artist: $artist,
                release_type: $release_type,
                genre: $genre,
                release_date: ""
            },
            tracks: $tracks
        } | if $cover_art != null then .release.cover_art = $cover_art else . end')

    echo "$manifest" | jq '.' > "$temp_dir/manifest.json"

    # Remove existing package
    [[ -f "$eqpkg_file" ]] && rm -f "$eqpkg_file"

    # Create .eqpkg.zip
    echo -e "${GREEN}  Creating $slug.eqpkg.zip...${NC}"
    (cd "$temp_dir" && zip -r "$eqpkg_file" manifest.json tracks/ $(ls cover.* 2>/dev/null || true)) > /dev/null 2>&1

    # Clean up
    rm -rf "$temp_dir"

    local file_size=$(ls -lh "$eqpkg_file" | awk '{print $5}')
    echo -e "${GREEN}  ✓ Package created: $eqpkg_file ($file_size)${NC}"
    echo -e "    Tracks: $track_count"
    echo ""

    # Create legacy .artist-package if requested
    if [[ "$LEGACY_MODE" == "true" ]]; then
        convert_artist_legacy "$slug"
    fi
}

# Legacy .artist-package conversion (unchanged from original)
convert_artist_legacy() {
    local slug="$1"
    local source_dir="$MOCKUPS_DIR/$slug"
    local package_dir="$OUTPUT_DIR/$slug.artist-package"

    echo -e "${BLUE}  Creating legacy .artist-package...${NC}"

    # Remove existing package if present
    [[ -d "$package_dir" ]] && rm -rf "$package_dir"

    # Create package structure
    mkdir -p "$package_dir/identity"
    mkdir -p "$package_dir/media"
    mkdir -p "$package_dir/releases"

    # Read bio.json for profile data
    local bio_file="$source_dir/profile/bio.json"
    local artist_name=""

    if [[ -f "$bio_file" ]]; then
        artist_name=$(jq -r '.name // empty' "$bio_file")

        # Create profile.json
        jq '{
            name: .name,
            about: .bio,
            picture: null,
            banner: null,
            website: .socialLinks.website,
            nip05: null,
            lud16: null,
            equaliser: {
                location: .location,
                genres: .genres,
                joinedDate: .joinedDate
            }
        }' "$bio_file" > "$package_dir/identity/profile.json"
    else
        artist_name="$slug"
        cat > "$package_dir/identity/profile.json" << EOF
{
  "name": "$slug",
  "about": null,
  "picture": null,
  "banner": null,
  "website": null,
  "nip05": null,
  "lud16": null,
  "equaliser": {
    "location": null,
    "genres": [],
    "joinedDate": null
  }
}
EOF
    fi

    # Copy media files
    local has_media=false
    if [[ -f "$source_dir/profile/avatar.jpg" ]]; then
        cp "$source_dir/profile/avatar.jpg" "$package_dir/media/"
        has_media=true
    fi
    if [[ -f "$source_dir/profile/banner.jpg" ]]; then
        cp "$source_dir/profile/banner.jpg" "$package_dir/media/"
        has_media=true
    fi

    # Build album lookup
    local albums_dir="$source_dir/albums"
    local album_lookup_file=$(mktemp)
    if [[ -d "$albums_dir" ]]; then
        for album_dir in "$albums_dir"/*/; do
            [[ -d "$album_dir" ]] || continue
            local album_metadata="$album_dir/metadata.json"
            if [[ -f "$album_metadata" ]]; then
                jq -r 'select(.albumId and .title) | "\(.albumId)=\(.title)"' "$album_metadata" >> "$album_lookup_file"
            fi
        done
    fi

    # Convert tracks to releases
    local release_count=0
    local tracks_dir="$source_dir/tracks"

    if [[ -d "$tracks_dir" ]]; then
        for track_dir in "$tracks_dir"/*/; do
            [[ -d "$track_dir" ]] || continue

            local track_slug=$(basename "$track_dir")
            local track_metadata="$track_dir/metadata.json"

            [[ ! -f "$track_metadata" ]] && continue

            local release_dir="$package_dir/releases/$track_slug"
            mkdir -p "$release_dir"

            # Find and copy audio file
            local audio_file="" audio_filename=""
            if [[ -f "$track_dir/full.mp3" ]]; then
                audio_file="$track_dir/full.mp3"; audio_filename="audio.mp3"
            elif [[ -f "$track_dir/full.wav" ]]; then
                audio_file="$track_dir/full.wav"; audio_filename="audio.wav"
            elif [[ -f "$track_dir/full.flac" ]]; then
                audio_file="$track_dir/full.flac"; audio_filename="audio.flac"
            fi

            [[ -z "$audio_file" ]] && continue

            cp "$audio_file" "$release_dir/$audio_filename"

            # Copy cover art
            local cover_filename=""
            if [[ -f "$track_dir/cover.jpg" ]]; then
                cp "$track_dir/cover.jpg" "$release_dir/"; cover_filename="cover.jpg"
            elif [[ -f "$track_dir/cover.png" ]]; then
                cp "$track_dir/cover.png" "$release_dir/"; cover_filename="cover.png"
            fi

            # Look up album name
            local track_album_id=$(jq -r '.albumId // empty' "$track_metadata")
            local album_name=""
            if [[ -n "$track_album_id" && -f "$album_lookup_file" ]]; then
                album_name=$(grep "^${track_album_id}=" "$album_lookup_file" | cut -d'=' -f2- || true)
            fi

            # Convert metadata
            jq --arg audio "$audio_filename" --arg cover "$cover_filename" --arg album_name "$album_name" '{
                id: .trackId,
                title: .title,
                artist: .artist,
                album: (if $album_name != "" then $album_name else (.album // null) end),
                album_id: (.albumId // null),
                track_number: (.trackNumber // null),
                duration: (.duration // null),
                genre: (.genre // null),
                price_amount: (.priceAmount // 0.05),
                price_currency: (.priceCurrency // "USD"),
                release_date: (.releaseDate // null),
                release_type: (if .albumId then "album" else "single" end),
                tags: (.tags // []),
                audio_file: $audio,
                cover_file: (if $cover != "" then $cover else null end)
            }' "$track_metadata" > "$release_dir/metadata.json"

            ((release_count++))
        done
    fi

    [[ -f "$album_lookup_file" ]] && rm -f "$album_lookup_file"

    # Create manifest.json
    cat > "$package_dir/manifest.json" << EOF
{
  "format": "equaliser-artist-package",
  "version": "1.0",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "artist": {
    "name": "$artist_name",
    "slug": "$slug"
  },
  "contents": {
    "has_identity": false,
    "has_media": $has_media,
    "release_count": $release_count
  },
  "source": {
    "type": "mockup-conversion",
    "source_path": "mockups/content/music/artists/$slug"
  }
}
EOF

    echo -e "${GREEN}  ✓ Legacy package: $package_dir ($release_count releases)${NC}"
}

# Main execution
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Equaliser Package Converter${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

if [[ "$CONVERT_ALL" == "true" ]]; then
    echo -e "Converting all artists from: $MOCKUPS_DIR"
    echo -e "Output directory: $OUTPUT_DIR"
    echo ""

    for artist_dir in "$MOCKUPS_DIR"/*/; do
        [[ -d "$artist_dir" ]] || continue
        slug=$(basename "$artist_dir")
        # Skip hidden directories
        [[ "$slug" == .* ]] && continue
        convert_artist "$slug"
    done
else
    echo -e "Converting artist: $ARTIST_SLUG"
    echo -e "Output directory: $OUTPUT_DIR"
    echo ""
    convert_artist "$ARTIST_SLUG"
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Conversion complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Packages created in: $OUTPUT_DIR"
echo ""
echo "Next steps:"
echo "  1. Start the content node: ./tools/start-node.sh -d"
echo "  2. Import a package: ./tools/import-artist.sh $OUTPUT_DIR/<artist>.eqpkg.zip"
[[ "$LEGACY_MODE" == "true" ]] && echo "  2. (Legacy) Import: ./tools/import-artist.sh $OUTPUT_DIR/<artist>.artist-package"
