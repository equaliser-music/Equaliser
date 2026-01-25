# Orchestrator API

The orchestrator is a FastAPI backend that coordinates content processing between the artist dashboard, IPFS, and NOSTR relay.

## Overview

The orchestrator handles:
- Track uploads and HLS encoding
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
| `price_sats` | integer | No | Price per stream in satoshis (default: 100) |
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

### Track Status

```
GET /api/tracks/status/{track_id}
```

**Response:**

```json
{
  "track_id": "uuid",
  "status": "encoding|uploading|publishing|complete|error",
  "progress": 0-100,
  "message": "Current processing step",
  "result": {
    "track_id": "uuid",
    "title": "Track Title",
    "artist": "Artist Name",
    "duration": 245,
    "ipfs_manifest_cid": "Qm...",
    "ipfs_preview_cid": "Qm...",
    "nostr_event_id": "hex..."
  }
}
```

### List Tracks

```
GET /api/tracks/
```

Returns all successfully processed tracks from the in-memory cache.

## Processing Pipeline

When a track is uploaded, the orchestrator:

1. **Save** - Stores the uploaded file temporarily
2. **Analyze** - Gets audio duration using FFprobe
3. **Encode** - Converts to HLS format using FFmpeg:
   - Full track: All segments in `/hls/` directory
   - Preview: First 30 seconds in `/preview/` directory
4. **Upload** - Uploads both directories to IPFS
5. **Publish** - Creates and publishes NOSTR Kind 30050 event (if private key provided)

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
    ["price_sats", "100"],
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
│   │   └── tracks.py        # Track upload endpoints
│   └── services/
│       ├── hls.py           # FFmpeg encoding
│       ├── ipfs.py          # IPFS uploads
│       └── nostr.py         # NOSTR events
├── upload.html              # Track upload UI
├── profile.html             # Profile editor
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

## Future Enhancements

The following features are planned but not yet implemented:

- **AES-256 Encryption**: Encrypt HLS segments (except 30s preview)
- **Key Storage**: SQLite database for encryption keys
- **Payment Integration**: Strike API for receiving payments
- **Key Distribution**: NIP-44 encrypted keys sent after payment verification
- **Cover Art Upload**: Associate artwork with tracks

See [Technical Specification](./Technical%20Specification.md) sections 4.3-4.4 for the complete design.

## References

- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [FFmpeg HLS Muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2)
- [IPFS HTTP API](https://docs.ipfs.tech/reference/kubo/rpc/)
- [NOSTR Protocol](https://github.com/nostr-protocol/nips)
- [Technical Specification](./Technical%20Specification.md)
