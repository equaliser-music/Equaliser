# Content Structure Documentation

## Overview
This document defines the folder structure and organization for artist content in the Equaliser platform.

## Artist Folder Structure

```
content/music/artists/
  └── {artist-name}/
      ├── profile/
      │   ├── avatar.jpg
      │   ├── banner.jpg
      │   └── bio.json
      ├── tracks/
      │   └── {track-id}/
      │       ├── metadata.json
      │       ├── preview.mp3
      │       ├── full.mp3
      │       └── cover.jpg
      ├── albums/
      │   └── {album-id}/
      │       ├── metadata.json
      │       ├── cover.jpg
      │       └── tracks.json
      ├── media/
      │   ├── photos/
      │   └── videos/
      └── payments/
          └── lightning-address.json
```

## Folder Descriptions

### `profile/`
Artist identity and branding materials.

- **avatar.jpg** - Profile picture (recommended: 400x400px)
- **banner.jpg** - Header/banner image (recommended: 1920x480px)
- **bio.json** - Artist biography and metadata

**bio.json structure:**
```json
{
  "name": "Artist Name",
  "bio": "Artist biography text",
  "genres": ["Electronic", "House"],
  "location": "City, Country",
  "socialLinks": {
    "website": "https://...",
    "twitter": "https://...",
    "instagram": "https://..."
  },
  "joinedDate": "2024-01-15"
}
```

### `tracks/`
Individual music tracks with preview and full versions.

Each track is stored in a folder named by its unique track ID (e.g., `midnight-dreams-001`).

- **metadata.json** - Track information
- **preview.mp3** - 30-second preview (free access)
- **full.mp3** - Complete track (requires payment)
- **cover.jpg** - Track/single artwork (recommended: 1000x1000px)

**metadata.json structure:**
```json
{
  "trackId": "midnight-dreams-001",
  "title": "Midnight Dreams",
  "artist": "DJ Nova",
  "duration": 225,
  "bpm": 128,
  "key": "Am",
  "genre": "House",
  "priceSats": 100,
  "releaseDate": "2024-01-10",
  "isrc": "US-XXX-XX-XXXXX",
  "previewStart": 60,
  "previewDuration": 30,
  "fileFormat": "mp3",
  "bitrate": 320,
  "tags": ["electronic", "dance", "nighttime"]
}
```

### `albums/`
Album collections that reference individual tracks.

Each album is stored in a folder named by its unique album ID.

- **metadata.json** - Album information
- **cover.jpg** - Album artwork (recommended: 1000x1000px)
- **tracks.json** - List of track IDs included in the album

**metadata.json structure:**
```json
{
  "albumId": "nocturnal-journey-2024",
  "title": "Nocturnal Journey",
  "artist": "DJ Nova",
  "releaseDate": "2024-01-15",
  "totalTracks": 10,
  "genre": "House",
  "description": "A journey through the night...",
  "priceSats": 900
}
```

**tracks.json structure:**
```json
{
  "tracks": [
    {
      "trackNumber": 1,
      "trackId": "midnight-dreams-001"
    },
    {
      "trackNumber": 2,
      "trackId": "sunrise-horizon-002"
    }
  ]
}
```

### `media/`
Additional promotional and visual content.

- **photos/** - Press photos, promotional images
- **videos/** - Music videos, behind-the-scenes content

### `payments/`
Bitcoin/Lightning Network payment information for direct artist support.

**lightning-address.json structure:**
```json
{
  "lightningAddress": "artist@getalby.com",
  "lnurlPay": "LNURL...",
  "nodePublicKey": "02...",
  "description": "Support DJ Nova directly",
  "minSats": 1,
  "maxSats": 1000000
}
```

## Naming Conventions

### Artist Folders
- Use lowercase with hyphens for spaces
- Example: `dj-nova`, `the-synthmasters`, `luna-waves`

### Track IDs
- Format: `{track-name}-{number}`
- Use lowercase with hyphens
- Example: `midnight-dreams-001`, `electric-pulse-002`

### Album IDs
- Format: `{album-name}-{year}`
- Use lowercase with hyphens
- Example: `nocturnal-journey-2024`, `summer-collection-2024`

## Key Features Supported

### Decentralized Content
- All content stored in structured folders
- JSON metadata for easy parsing
- Self-contained artist directories

### Free Preview Model
- 30-second preview files (`preview.mp3`) are freely accessible
- Full tracks (`full.mp3`) require payment
- Preview start time configurable in metadata

### Direct Artist Payment
- Lightning Network integration via `payments/` folder
- Pricing in satoshis (Bitcoin's smallest unit)
- No intermediaries - direct support to artists

### Flexible Organization
- Tracks can exist independently or as part of albums
- Albums reference tracks by ID
- Easy to add new tracks or albums without restructuring

## Future Considerations

- **Licensing**: Add `license.json` for track usage rights
- **Collaborations**: Support multiple artists per track
- **Remixes**: Link remixes to original tracks
- **Analytics**: Track play counts and revenue (privacy-preserving)
- **IPFS/Decentralized Storage**: Content addressing for true decentralization
