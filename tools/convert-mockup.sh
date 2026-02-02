#!/bin/bash
#
# Convert mockups/content artist folder to Equaliser Artist Package format
#
# Usage:
#   ./tools/convert-mockup.sh <artist-slug>
#   ./tools/convert-mockup.sh shibuya-crossings
#   ./tools/convert-mockup.sh --all
#
# Options:
#   --all       Convert all artists in mockups/content/music/artists/
#   --output    Output directory (default: ./packages/)
#   -h, --help  Show this help message

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

MOCKUPS_DIR="$PROJECT_ROOT/mockups/content/music/artists"
OUTPUT_DIR="$PROJECT_ROOT/packages"

# Parse arguments
ARTIST_SLUG=""
CONVERT_ALL=false

show_help() {
    echo "Convert mockups/content artist to Equaliser Artist Package format"
    echo ""
    echo "Usage:"
    echo "  $0 <artist-slug>     Convert a specific artist"
    echo "  $0 --all             Convert all artists"
    echo ""
    echo "Options:"
    echo "  --output <dir>       Output directory (default: ./packages/)"
    echo "  -h, --help           Show this help message"
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

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Convert a single artist
convert_artist() {
    local slug="$1"
    local source_dir="$MOCKUPS_DIR/$slug"
    local package_dir="$OUTPUT_DIR/$slug.artist-package"

    echo -e "${BLUE}Converting: $slug${NC}"

    # Check source exists
    if [[ ! -d "$source_dir" ]]; then
        echo -e "${RED}  Error: Artist not found: $source_dir${NC}"
        return 1
    fi

    # Remove existing package if present
    if [[ -d "$package_dir" ]]; then
        echo -e "${YELLOW}  Removing existing package...${NC}"
        rm -rf "$package_dir"
    fi

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
        echo -e "${GREEN}  Creating profile.json...${NC}"
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
        echo -e "${YELLOW}  Warning: No bio.json found, creating minimal profile${NC}"
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
        echo -e "${GREEN}  Copied avatar.jpg${NC}"
    fi
    if [[ -f "$source_dir/profile/banner.jpg" ]]; then
        cp "$source_dir/profile/banner.jpg" "$package_dir/media/"
        has_media=true
        echo -e "${GREEN}  Copied banner.jpg${NC}"
    fi

    # Build album lookup file from albums/ folder
    local albums_dir="$source_dir/albums"
    local album_lookup_file=$(mktemp)
    if [[ -d "$albums_dir" ]]; then
        for album_dir in "$albums_dir"/*/; do
            [[ -d "$album_dir" ]] || continue
            local album_metadata="$album_dir/metadata.json"
            if [[ -f "$album_metadata" ]]; then
                # Write albumId=title pairs to temp file
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

            if [[ ! -f "$track_metadata" ]]; then
                echo -e "${YELLOW}  Skipping $track_slug: no metadata.json${NC}"
                continue
            fi

            # Create release directory
            local release_dir="$package_dir/releases/$track_slug"
            mkdir -p "$release_dir"

            # Find audio file (prefer full.mp3, then any audio file)
            local audio_file=""
            local audio_filename=""
            if [[ -f "$track_dir/full.mp3" ]]; then
                audio_file="$track_dir/full.mp3"
                audio_filename="audio.mp3"
            elif [[ -f "$track_dir/full.wav" ]]; then
                audio_file="$track_dir/full.wav"
                audio_filename="audio.wav"
            elif [[ -f "$track_dir/full.flac" ]]; then
                audio_file="$track_dir/full.flac"
                audio_filename="audio.flac"
            fi

            if [[ -z "$audio_file" ]]; then
                echo -e "${YELLOW}  Skipping $track_slug: no audio file${NC}"
                continue
            fi

            # Copy audio file
            cp "$audio_file" "$release_dir/$audio_filename"

            # Find and copy cover art
            local cover_filename=""
            if [[ -f "$track_dir/cover.jpg" ]]; then
                cp "$track_dir/cover.jpg" "$release_dir/cover.jpg"
                cover_filename="cover.jpg"
            elif [[ -f "$track_dir/cover.png" ]]; then
                cp "$track_dir/cover.png" "$release_dir/cover.png"
                cover_filename="cover.png"
            fi

            # Look up album name from albumId using the lookup file
            local track_album_id=$(jq -r '.albumId // empty' "$track_metadata")
            local album_name=""
            if [[ -n "$track_album_id" && -f "$album_lookup_file" ]]; then
                album_name=$(grep "^${track_album_id}=" "$album_lookup_file" | cut -d'=' -f2-)
            fi

            # Convert metadata.json to release format
            jq --arg audio "$audio_filename" --arg cover "$cover_filename" --arg album_name "$album_name" '{
                id: .trackId,
                title: .title,
                artist: .artist,
                album: (if $album_name != "" then $album_name else (.album // null) end),
                album_id: (.albumId // null),
                track_number: (.trackNumber // null),
                duration: (.duration // null),
                genre: (.genre // null),
                price_sats: (.priceSats // 100),
                release_date: (.releaseDate // null),
                release_type: (if .albumId then "album" else "single" end),
                tags: (.tags // []),
                audio_file: $audio,
                cover_file: (if $cover != "" then $cover else null end)
            }' "$track_metadata" > "$release_dir/metadata.json"

            ((release_count++))
            echo -e "${GREEN}  Converted release: $track_slug${NC}"
        done
    fi

    # Clean up temp file
    [[ -f "$album_lookup_file" ]] && rm -f "$album_lookup_file"

    # Create manifest.json
    echo -e "${GREEN}  Creating manifest.json...${NC}"
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

    echo -e "${GREEN}  ✓ Package created: $package_dir${NC}"
    echo -e "    Releases: $release_count"
    echo ""
}

# Main execution
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Equaliser Artist Package Converter${NC}"
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
echo "  2. Import a package: ./tools/import-artist.sh $OUTPUT_DIR/<artist>.artist-package"
