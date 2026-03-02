# Artist Package Format

Equaliser supports two package formats for importing and exporting artist content:

| Format | Extension | Use Case |
|--------|-----------|----------|
| **Release Package** | `.eqpkg.zip` | Signed release export/import with original audio |
| **Legacy Package** | `.artist-package/` | Full artist setup (identity + profile + releases) |

## Release Package (.eqpkg.zip)

The primary format for exporting and importing releases. Contains original audio files, metadata manifest, and a cryptographic signature proving the package was created by the artist.

### Structure

```
my-release.eqpkg.zip
├── manifest.json       # Release metadata + track list + file hashes
├── signature.json      # Signed NOSTR event covering manifest hash
├── cover.jpg           # Cover art (optional)
└── tracks/
    ├── 01-track-name.mp3
    └── 02-track-name.mp3
```

### manifest.json

Contains release metadata, track list with per-track metadata, and SHA-256 hashes of audio files for integrity verification.

```json
{
  "format_version": "1.0",
  "created_at": "2026-02-07T12:00:00Z",
  "release": {
    "title": "Neon Dreams",
    "artist": "Shibuya Crossings",
    "release_type": "album",
    "genre": "Electronic",
    "release_date": "2025-06-15",
    "cover_art": {
      "filename": "cover.jpg",
      "sha256": "abc123..."
    }
  },
  "tracks": [
    {
      "title": "At Eight in a Spanish Bar",
      "track_number": 1,
      "duration": 245,
      "price_amount": 0.05,
      "price_currency": "USD",
      "genre": "Electronic",
      "audio": {
        "filename": "tracks/01-at-eight-in-a-spanish-bar.mp3",
        "sha256": "def456...",
        "original_filename": "full.mp3"
      }
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `format_version` | Yes | Package format version (`1.0`) |
| `created_at` | Yes | ISO 8601 creation timestamp |
| `release.title` | Yes | Release/album title |
| `release.artist` | Yes | Artist name |
| `release.release_type` | Yes | `single`, `album`, or `ep` |
| `release.genre` | No | Primary genre |
| `release.release_date` | No | Original release date |
| `release.cover_art` | No | Cover art filename and SHA-256 |
| `tracks[].title` | Yes | Track title |
| `tracks[].track_number` | Yes | Position in release |
| `tracks[].duration` | No | Duration in seconds |
| `tracks[].price_amount` | Yes | Price per stream |
| `tracks[].price_currency` | Yes | ISO 4217 code (USD, GBP, EUR, JPY) or SAT |
| `tracks[].audio.filename` | Yes | Path to audio file within the zip |
| `tracks[].audio.sha256` | Yes | SHA-256 hash for integrity verification |

### signature.json

Contains a signed NOSTR event where `content` is the SHA-256 of `manifest.json`. This proves the package was created by the artist (verifiable with their public key). **No private keys are included.**

```json
{
  "event": {
    "kind": 1,
    "pubkey": "hex-pubkey...",
    "created_at": 1707300000,
    "tags": [
      ["t", "eqpkg"],
      ["format_version", "1.0"],
      ["album", "Neon Dreams"]
    ],
    "content": "sha256-of-manifest-json...",
    "id": "event-id...",
    "sig": "schnorr-signature..."
  },
  "manifest_sha256": "sha256-of-manifest-json..."
}
```

### Export

Export releases from the admin UI or CLI:

**Admin UI:** Click the export button on a release card in `/admin/releases.html`. The browser handles signing via the session.

**CLI:**
```bash
# Export a specific album
./tools/export-artist.sh --npub npub1abc... --album "Neon Dreams"

# Export all albums
./tools/export-artist.sh --npub npub1abc... --all-albums

# Export with identity backup
./tools/export-artist.sh --npub npub1abc... --all-albums --include-keys
```

The CLI prompts for the artist's nsec to sign the package.

### Import

Import `.eqpkg.zip` packages via the admin UI or CLI:

**Admin UI:** Click "Import Package" in `/admin/releases.html` and drop a `.eqpkg.zip` file.

**CLI:**
```bash
# Fresh import (generates new identity)
./tools/import-artist.sh ./packages/neon-dreams.eqpkg.zip

# Import with existing identity
./tools/import-artist.sh ./packages/neon-dreams.eqpkg.zip --restore backup.json
```

Import process:
1. Extracts zip (with path traversal protection)
2. Validates manifest structure
3. Verifies signature (optional - warns on mismatch)
4. For each track: uploads to Blossom → HLS encodes → uploads to IPFS → creates draft
5. Returns list of created draft IDs

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/releases/export-prepare` | POST | Build manifest, return unsigned event for signing |
| `/api/releases/export-download` | POST | Build and download .eqpkg.zip with signed event |
| `/api/releases/import` | POST | Extract .eqpkg.zip, create drafts |

### Requirements

Export requires tracks to have `blossom_audio_hash` set (original audio preserved on Blossom). Tracks uploaded before Blossom integration won't have this - re-upload them to enable export.

---

## Legacy Package (.artist-package)

The original format for full artist setup including identity, profile, and releases. Still supported for backward compatibility and test data setup.

### Structure

```
{artist-slug}.artist-package/
├── manifest.json           # Package metadata
├── identity/
│   ├── backup.json        # OPTIONAL: Identity backup (nsec/npub)
│   └── profile.json       # Profile data for Kind 0 event
├── media/
│   ├── avatar.jpg         # Profile picture
│   └── banner.jpg         # Banner image
└── releases/
    └── {release-slug}/
        ├── metadata.json   # Release metadata
        ├── audio.mp3       # Original audio file
        └── cover.jpg       # Cover art
```

### Import Modes

**Fresh Import** (testing):
```bash
./tools/import-artist.sh ./packages/artist.artist-package
```
Generates new identity, publishes profile, imports releases as drafts.

**Restore Import** (backup):
```bash
./tools/import-artist.sh ./packages/artist.artist-package --restore
```
Uses keys from `identity/backup.json`.

**Dry Run:**
```bash
./tools/import-artist.sh ./packages/artist.artist-package --dry-run
```

### Creating from Mockups

Convert mockup content to packages:

```bash
# Create .eqpkg.zip packages
./tools/convert-mockup.sh --all

# Create both formats
./tools/convert-mockup.sh --all --legacy
```

---

## Tools

| Tool | Description |
|------|-------------|
| `tools/import-artist.sh` | Import `.eqpkg.zip` or `.artist-package` into content node |
| `tools/export-artist.sh` | Export releases as signed `.eqpkg.zip` packages |
| `tools/convert-mockup.sh` | Convert mockup artist data to `.eqpkg.zip` (or legacy) |

## Security

1. **No private keys in .eqpkg.zip**: Packages contain a signature (public verification) but never the nsec
2. **SHA-256 integrity**: Audio file hashes in the manifest are verified during import
3. **Path traversal protection**: Zip extraction validates all paths stay within the target directory
4. **Identity backups**: Only `.artist-package` format supports including keys, and only when explicitly requested

## Compatibility

- `.eqpkg.zip` format version `1.0`
- Requires Equaliser content node with:
  - Blossom server (for original audio storage)
  - `/api/releases/export-prepare` endpoint
  - `/api/releases/export-download` endpoint
  - `/api/releases/import` endpoint
  - `/api/tracks/upload` endpoint (for legacy format)
  - NOSTR relay at `/relay`
