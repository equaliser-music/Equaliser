# Orchestrator API

The orchestrator is a FastAPI backend that coordinates content processing between the artist dashboard, IPFS, and NOSTR relay.

## Overview

The orchestrator handles:
- Track uploads and HLS encoding
- Draft management (SQLite database)
- IPFS content management
- NOSTR event creation and publishing
- (Future) Payment processing and key distribution

## Container Details

| Setting | Value |
|---------|-------|
| Image | Custom (Python 3.11 + FFmpeg) |
| Container Name | `equaliser-orchestrator` |
| Internal Port | 8000 |
| Build Context | `./orchestrator/api` |
| Database | SQLite at `/data/drafts.db` |

## API Endpoints

### Health Check

```
GET /health
```

Returns `{"status": "healthy"}` when the service is running.

### Track Upload

```
POST /api/tracks/upload
Content-Type: multipart/form-data
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | Audio file (MP3, WAV, FLAC, AAC) |
| `title` | string | Yes | Track title |
| `artist` | string | Yes | Artist name |
| `artist_pubkey` | string | Yes | Artist's NOSTR public key (hex) |
| `album` | string | No | Album name |
| `genre` | string | No | Genre |
| `release_date` | string | No | Release date (YYYY-MM-DD) |
| `price_amount` | float | No | Price per stream (default: 0.05) |
| `price_currency` | string | No | ISO 4217 currency code or SAT (default: USD) |
| `artist_privkey` | string | No | Private key for server-side NOSTR signing |

**Response:**

```json
{
  "track_id": "uuid",
  "status": "pending",
  "progress": 0,
  "message": "Upload received, queued for processing"
}
```

The upload is processed asynchronously. Poll the status endpoint to track progress.

When processing completes, the track is saved as a **draft** in the database (not published to NOSTR). Use the Drafts API to manage and release drafts.

### Track Status

```
GET /api/tracks/status/{track_id}
```

**Response:**

```json
{
  "track_id": "uuid",
  "status": "encoding|uploading|saving|complete|error",
  "progress": 0-100,
  "message": "Current processing step",
  "result": {
    "track_id": "uuid",
    "draft_id": "uuid",
    "title": "Track Title",
    "artist": "Artist Name",
    "duration": 245,
    "ipfs_manifest_cid": "Qm...",
    "ipfs_preview_cid": "Qm...",
    "status": "draft"
  }
}
```

### List Tracks

```
GET /api/tracks/
```

Returns all successfully processed tracks from the in-memory cache.

### Publish Signed Event

```
POST /api/tracks/publish
Content-Type: application/json
```

Publishes a pre-signed NOSTR event to the relay. Used for client-side signing (non-custodial).

**Request Body:**

```json
{
  "signed_event": {
    "id": "hex...",
    "pubkey": "hex...",
    "created_at": 1706000000,
    "kind": 30050,
    "tags": [...],
    "content": "",
    "sig": "hex..."
  },
  "draft_id": "uuid"  // Optional: updates draft status to 'released'
}
```

**Response:**

```json
{
  "event_id": "hex...",
  "success": true
}
```

### Cover Art Upload

```
POST /api/tracks/cover-art
Content-Type: multipart/form-data
```

Uploads an image file to IPFS and returns the CID. Used by the profile page for avatar and banner images.

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | Image file (JPG, PNG, GIF, WebP) |

**Response:**

```json
{
  "cid": "Qm...",
  "url": "https://ipfs.io/ipfs/Qm..."
}
```

## Draft Management API

Tracks are saved as drafts after upload. Artists can edit metadata and release when ready.

### List Drafts

```
GET /api/drafts?pubkey={hex}&status={draft|released}
```

Returns drafts for the specified artist.

**Response:**

```json
{
  "drafts": [
    {
      "id": "uuid",
      "artist_pubkey": "hex...",
      "title": "Track Title",
      "artist_name": "Artist Name",
      "album": "Album Name",
      "genre": "Electronic",
      "price_amount": 0.05,
      "price_currency": "USD",
      "release_date": "2026-01-25",
      "release_type": "single",
      "cover_art_cid": "Qm...",
      "ipfs_manifest_cid": "Qm...",
      "ipfs_preview_cid": "Qm...",
      "duration": 245,
      "status": "draft",
      "created_at": "2026-01-25T12:00:00Z",
      "updated_at": "2026-01-25T12:00:00Z"
    }
  ],
  "count": 1
}
```

### Get Draft

```
GET /api/drafts/{id}?pubkey={hex}
```

Returns a single draft by ID.

### Update Draft

```
PATCH /api/drafts/{id}?pubkey={hex}
Content-Type: application/json
```

Updates draft metadata. Only the owner (matching pubkey) can update.

**Request Body:**

```json
{
  "title": "New Title",
  "artist_name": "Artist Name",
  "album": "Album Name",
  "genre": "Rock",
  "price_amount": 0.06,
  "price_currency": "USD",
  "release_date": "2026-02-01",
  "release_type": "album",
  "cover_art_cid": "Qm..."
}
```

### Delete Draft

```
DELETE /api/drafts/{id}?pubkey={hex}
```

Deletes a draft. Only drafts (not released tracks) can be deleted.

### Prepare Release

```
POST /api/drafts/{id}/release?pubkey={hex}
```

Generates an unsigned NOSTR event for the draft. The client signs this event and submits it via `/api/tracks/publish`.

**Response:**

```json
{
  "draft_id": "uuid",
  "unsigned_event": {
    "kind": 30050,
    "pubkey": "hex...",
    "created_at": 1706000000,
    "tags": [...],
    "content": ""
  }
}
```

### Release Album

```
POST /api/drafts/release-album
Content-Type: application/json
```

Prepares all drafts in an album for release.

**Request Body:**

```json
{
  "album": "Album Name",
  "pubkey": "hex..."
}
```

**Response:**

```json
{
  "tracks": [
    {
      "draft_id": "uuid",
      "unsigned_event": {...}
    }
  ],
  "count": 5
}
```

## Processing Pipeline

When a track is uploaded, the orchestrator:

1. **Save** - Stores the uploaded file temporarily
2. **Analyze** - Gets audio duration using FFprobe
3. **Encode** - Converts to HLS format using FFmpeg:
   - Full track: All segments in `/hls/` directory
   - Preview: First 30 seconds in `/preview/` directory
4. **Upload** - Uploads both directories to IPFS
5. **Save Draft** - Stores metadata in SQLite database as a draft

When an artist releases a track:

1. **Prepare** - Generate unsigned NOSTR Kind 30050 event from draft
2. **Sign** - Client signs the event (browser-side, non-custodial)
3. **Publish** - Submit signed event to NOSTR relay
4. **Update** - Mark draft as 'released' in database

### HLS Encoding

Audio is encoded to AAC at 128kbps with 6-second segments:

```
input.mp3 → playlist.m3u8 + segment_000.ts, segment_001.ts, ...
```

The preview contains only the first 30 seconds (unencrypted, free to stream).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IPFS_API_URL` | `http://ipfs:5001` | IPFS node API endpoint |
| `NOSTR_RELAY_URL` | `ws://nostr-relay:8080` | NOSTR relay WebSocket endpoint |
| `DATABASE_PATH` | `/data/drafts.db` | SQLite database path for drafts |

## NOSTR Event Format

Track metadata is published as Kind 30050 (parameterized replaceable event):

```json
{
  "kind": 30050,
  "pubkey": "<artist-pubkey>",
  "created_at": 1706000000,
  "content": "",
  "tags": [
    ["d", "<track-id>"],
    ["app", "Equaliser"],
    ["title", "Track Title"],
    ["artist", "Artist Name"],
    ["duration", "245"],
    ["ipfs_manifest_cid", "Qm..."],
    ["ipfs_preview_cid", "Qm..."],
    ["price", "0.05"],
    ["price_currency", "USD"],
    ["album", "Album Name"],
    ["genre", "Electronic"],
    ["release_date", "2026-01-24"]
  ]
}
```

## File Structure

```
orchestrator/
├── api/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── main.py              # FastAPI app
│   ├── routers/
│   │   ├── tracks.py        # Track upload endpoints
│   │   └── drafts.py        # Draft management endpoints
│   └── services/
│       ├── database.py      # SQLite draft storage
│       ├── hls.py           # FFmpeg encoding
│       ├── ipfs.py          # IPFS uploads
│       └── nostr.py         # NOSTR events
├── login.html               # Login gateway
├── dashboard.html           # Artist home page
├── upload.html              # Track upload UI (saves as drafts)
├── releases.html            # View drafts and released tracks
├── edit-release.html        # Edit draft or release metadata
├── profile.html             # Profile editor
├── settings.html            # Relay configuration
├── onboarding.html          # New artist setup
└── js/
    ├── session.js           # Session management
    └── admin-sidebar.js     # Sidebar component
```

## Development

### Building

```bash
cd content_node
docker-compose build orchestrator
```

### Logs

```bash
docker-compose logs -f orchestrator
```

### Testing the API

```bash
# Health check
curl http://localhost/api/health

# Upload a track (example)
curl -X POST http://localhost/api/tracks/upload \
  -F "file=@track.mp3" \
  -F "title=My Track" \
  -F "artist=My Artist" \
  -F "artist_pubkey=<hex-pubkey>"

# Check status
curl http://localhost/api/tracks/status/<track-id>
```

## Draft Workflow

The draft system allows artists to review and edit tracks before publishing to NOSTR:

1. **Upload**: Artist uploads audio files via `/admin/upload.html`
2. **Process**: Orchestrator encodes to HLS, uploads to IPFS
3. **Draft**: Track metadata saved to SQLite database (not yet on NOSTR)
4. **Review**: Artist views drafts on `/admin/releases.html` (Drafts tab)
5. **Edit**: Artist can modify metadata via `/admin/edit-release.html`
6. **Release**: Artist clicks "Release" button, signs NOSTR event in browser
7. **Publish**: Signed event sent to relay, draft marked as 'released'

### Database Schema

```sql
CREATE TABLE draft_tracks (
    id TEXT PRIMARY KEY,
    artist_pubkey TEXT NOT NULL,
    title TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    album TEXT,
    genre TEXT,
    price_amount REAL NOT NULL DEFAULT 0.05,
    price_currency TEXT NOT NULL DEFAULT 'USD',
    release_date TEXT,
    release_type TEXT DEFAULT 'single',
    track_number INTEGER,
    cover_art_cid TEXT,
    ipfs_manifest_cid TEXT NOT NULL,
    ipfs_preview_cid TEXT NOT NULL,
    duration INTEGER NOT NULL,
    status TEXT DEFAULT 'draft',
    nostr_event_id TEXT,
    nostr_d_tag TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    released_at TEXT
);
```

## Future Enhancements

The following features are planned but not yet implemented:

- **AES-256 Encryption**: Encrypt HLS segments (except 30s preview)
- **Key Storage**: Encryption keys in database
- **Payment Integration**: Strike API for receiving payments
- **Key Distribution**: NIP-44 encrypted keys sent after payment verification
- **Track Cover Art**: Associate artwork with track uploads (profile images already supported)

See [Technical Specification](./Technical%20Specification.md) sections 4.3-4.4 for the complete design.

## References

- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [FFmpeg HLS Muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2)
- [IPFS HTTP API](https://docs.ipfs.tech/reference/kubo/rpc/)
- [NOSTR Protocol](https://github.com/nostr-protocol/nips)
- [Technical Specification](./Technical%20Specification.md)
