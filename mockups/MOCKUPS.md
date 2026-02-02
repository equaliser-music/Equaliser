# Equaliser Mockups

This folder contains UX prototypes and a development server for exploring the Equaliser platform design. These are for visual exploration and testing workflows - not production code.

> **Note:** Per [PROJECT_RULES.md](../PROJECT_RULES.md), mockups are separate from the production `content_node/` implementation.

## Quick Start

```bash
cd mockups/server
./start.sh
```

Server runs on **http://localhost:3001**

To stop:
```bash
./stop.sh
```

## URLs

### Fan-Facing Pages (Client)

| URL | Description |
|-----|-------------|
| http://localhost:3001/ | Home page |
| http://localhost:3001/client/home.html | Home page (explicit) |
| http://localhost:3001/client/artist.html | Artist profile page |

### Artist Dashboard (Content Node Admin)

| URL | Description |
|-----|-------------|
| http://localhost:3001/admin | Dashboard |
| http://localhost:3001/admin/dashboard.html | Dashboard (explicit) |
| http://localhost:3001/admin/upload.html | Upload page |
| http://localhost:3001/admin/song-uploader.html | Song uploader with FFmpeg processing |
| http://localhost:3001/admin/releases.html | Releases management |
| http://localhost:3001/admin/analytics.html | Analytics view |
| http://localhost:3001/admin/settings.html | Settings |

### Content

| URL | Description |
|-----|-------------|
| http://localhost:3001/content/... | Uploaded artist content (music, images) |

## Folder Structure

```
mockups/
├── MOCKUPS.md              # This file
├── server/                 # Node.js backend
│   ├── server.js           # Express server with upload API
│   ├── package.json        # Dependencies
│   ├── start.sh            # Start script
│   ├── stop.sh             # Stop script
│   ├── SERVER.md           # Server documentation
│   └── temp/               # Temporary upload storage
├── web_portal/             # Frontend mockup pages
│   ├── client/             # Fan-facing pages
│   │   ├── home.html
│   │   └── artist.html
│   └── content_node/       # Artist admin pages
│       ├── dashboard.html
│       ├── upload.html
│       ├── song-uploader.html
│       ├── releases.html
│       ├── analytics.html
│       └── settings.html
└── content/                # Uploaded content storage
    └── music/
        └── artists/        # Artist folders (per STRUCTURE.md)
```

## Server Features

The Node.js server provides:

- **Static file serving** for mockup pages
- **Upload API** (`POST /api/upload`) with:
  - WAV to MP3 conversion (320kbps via FFmpeg)
  - 30-second preview generation
  - Automatic folder structure creation per [STRUCTURE.md](content/STRUCTURE.md)
  - Metadata JSON generation
- **Content API** for listing artists and albums

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server health check |
| POST | `/api/upload` | Upload tracks, images, and metadata |
| GET | `/api/artists` | List all uploaded artists |
| GET | `/api/artist/:slug` | Get artist details with albums and tracks |
| GET | `/api/albums` | List all albums with track metadata |

## Requirements

- Node.js 18+
- FFmpeg (for audio processing)

### Installing FFmpeg (macOS)

```bash
brew install ffmpeg
```

## Content Structure

Uploaded content follows the structure defined in [content/STRUCTURE.md](content/STRUCTURE.md):

```
content/music/artists/{artist-slug}/
├── profile/
│   ├── avatar.jpg
│   ├── banner.jpg
│   └── bio.json
├── tracks/{track-id}/
│   ├── metadata.json
│   ├── preview.mp3      # 30-second clip
│   ├── full.mp3         # 320kbps
│   └── cover.jpg
├── albums/{album-id}/
│   ├── metadata.json
│   ├── cover.jpg
│   └── tracks.json
├── media/photos/
└── payments/
    └── lightning-address.json
```

## Relationship to Production

These mockups inform the design of the production system in `content_node/`:

| Mockup | Production Equivalent |
|--------|----------------------|
| `server/` upload API | `orchestrator/` (Python/FastAPI) |
| `web_portal/client/` | `client/` |
| `web_portal/content_node/` | `orchestrator/` admin pages |
| `content/` | IPFS storage |

The production system will use IPFS for content storage and NOSTR for metadata/discovery instead of local files and REST APIs.
