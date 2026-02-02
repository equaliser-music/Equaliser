# Artist Package Format

The Artist Package is a portable format for importing and exporting artist content. It supports:

- **Testing**: Bulk import demo content after container reset
- **Backup**: Full artist catalog export including releases
- **Migration**: Move an artist between content nodes
- **Onboarding**: Import existing catalogs when an artist joins

## Package Structure

```
{artist-slug}.artist-package/
├── manifest.json           # Package metadata
├── identity/
│   ├── backup.json        # OPTIONAL: Equaliser identity backup (nsec/npub)
│   └── profile.json       # Profile data for Kind 0 event
├── media/
│   ├── avatar.jpg         # Profile picture
│   └── banner.jpg         # Banner image
└── releases/
    └── {release-slug}/
        ├── metadata.json   # Release metadata (maps to Kind 30050)
        ├── audio.mp3       # Original audio file (mp3, wav, flac)
        └── cover.jpg       # Cover art image
```

## File Specifications

### manifest.json

Package metadata and import instructions.

```json
{
  "format": "equaliser-artist-package",
  "version": "1.0",
  "created_at": "2025-01-29T12:00:00Z",
  "artist": {
    "name": "Shibuya Crossings",
    "slug": "shibuya-crossings"
  },
  "contents": {
    "has_identity": true,
    "has_media": true,
    "release_count": 10
  },
  "source": {
    "type": "export",
    "node_url": "https://artist.example.com",
    "exported_at": "2025-01-29T12:00:00Z"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `format` | Yes | Must be `equaliser-artist-package` |
| `version` | Yes | Package format version (`1.0`) |
| `created_at` | Yes | ISO 8601 timestamp |
| `artist.name` | Yes | Display name |
| `artist.slug` | Yes | URL-safe identifier |
| `contents.has_identity` | Yes | Whether `identity/backup.json` is included |
| `contents.has_media` | Yes | Whether avatar/banner images are included |
| `contents.release_count` | Yes | Number of releases in package |
| `source` | No | Origin information (for exports) |

### identity/backup.json

Standard Equaliser identity backup file. Same format as onboarding backup.

```json
{
  "version": 1,
  "created": "2025-01-29T12:00:00Z",
  "keys": {
    "nsec": "nsec1...",
    "npub": "npub1...",
    "privateKeyHex": "abc123...",
    "publicKeyHex": "def456..."
  },
  "profile": {
    "name": "Shibuya Crossings",
    "bio": "Electronic and alternative sounds...",
    "location": "Tokyo, Japan",
    "genres": ["Electronic", "Alternative", "Indie"]
  }
}
```

**Important**: This file contains the private key. It should only be included when:
- Exporting for backup/migration (user explicitly requests)
- The user understands the security implications

For testing imports, this file can be omitted and new keys will be generated.

### identity/profile.json

Profile data used to construct the Kind 0 NOSTR event. This is the public profile information without keys.

```json
{
  "name": "Shibuya Crossings",
  "about": "Electronic and alternative sounds with introspective songwriting.",
  "picture": null,
  "banner": null,
  "website": "https://shibuyacrossings.com",
  "nip05": "shibuya@example.com",
  "lud16": "shibuya@getalby.com",
  "equaliser": {
    "location": "Tokyo, Japan",
    "genres": ["Electronic", "Alternative", "Indie"],
    "joinedDate": "2025-01-16"
  }
}
```

Note: `picture` and `banner` are set to `null` in the package. The import tool uploads the images from `media/` to IPFS and populates these URLs.

### releases/{slug}/metadata.json

Release metadata that maps to a Kind 30050 NOSTR event.

```json
{
  "id": "at-eight-in-a-spanish-bar",
  "title": "At Eight in a Spanish Bar",
  "artist": "Shibuya Crossings",
  "album": "DOYA (Depend On Your Alter Ego)",
  "album_id": "doya-depend-on-your-alter-ego-2011",
  "track_number": 1,
  "duration": null,
  "genre": "Electronic",
  "price_sats": 210,
  "release_date": "2011-03-24",
  "release_type": "album",
  "tags": ["electronic", "atmospheric", "evening"],
  "audio_file": "audio.mp3",
  "cover_file": "cover.jpg"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique release identifier (becomes d-tag) |
| `title` | Yes | Track title |
| `artist` | Yes | Artist name |
| `album` | No | Album name |
| `album_id` | No | Album identifier |
| `track_number` | No | Position in album |
| `duration` | No | Duration in seconds (calculated during import if null) |
| `genre` | No | Primary genre |
| `price_sats` | Yes | Price in satoshis |
| `release_date` | No | Original release date |
| `release_type` | No | `single`, `album`, or `ep` |
| `tags` | No | Array of tags |
| `audio_file` | Yes | Filename of audio in this folder |
| `cover_file` | No | Filename of cover art in this folder |

## Import Modes

### 1. Fresh Import (Testing)

For testing with demo content. Generates new identity.

```bash
./tools/import-artist.sh shibuya-crossings.artist-package
```

- Generates new NOSTR keys
- Uploads media to IPFS
- Publishes Kind 0 profile
- Imports releases as drafts
- Outputs new identity backup for session login

### 2. Restore Import (Backup)

Restores an artist with their original identity.

```bash
./tools/import-artist.sh shibuya-crossings.artist-package --restore
```

- Uses keys from `identity/backup.json`
- Same npub as original
- Requires backup.json to be present

### 3. Dry Run

Preview what would be imported without making changes.

```bash
./tools/import-artist.sh shibuya-crossings.artist-package --dry-run
```

## Export

Export an existing artist from a content node.

```bash
./tools/export-artist.sh --npub npub1... --output ./backups/
```

Options:
- `--include-keys`: Include identity backup (nsec) in export
- `--releases-only`: Export releases without profile/media

## Tools

| Tool | Description |
|------|-------------|
| `tools/import-artist.sh` | Import an artist package into content node |
| `tools/export-artist.sh` | Export artist from content node to package |
| `tools/convert-mockup.sh` | Convert mockups/content artist to package format |

## Security Considerations

1. **Private keys**: The `identity/backup.json` file contains the nsec (private key). Handle with care.
2. **Package integrity**: Consider adding checksums for media files in future versions.
3. **Storage**: Don't commit packages with real keys to version control.

## Compatibility

- Package format version `1.0`
- Requires Equaliser content node with:
  - `/api/tracks/upload` endpoint
  - `/api/tracks/cover-art` endpoint
  - `/api/drafts` endpoints
  - NOSTR relay at `/relay`
