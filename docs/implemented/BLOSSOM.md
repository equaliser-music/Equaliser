# Blossom Integration

Blossom is integrated as a hash-addressed HTTP file storage server within the content node. It preserves original audio files and serves images, complementing IPFS which handles HLS-encoded audio streams.

## Architecture

```
Content Node Docker Stack
├── orchestrator     (FastAPI - manages uploads, creates NOSTR events)
├── blossom          (Hash-addressed blob storage for originals + images)
├── ipfs             (HLS segments + legacy content)
├── nostr-relay      (Event storage)
└── web/nginx        (Reverse proxy, serves /blossom/ and /ipfs/)
```

### What Goes Where

| Content Type | Primary Storage | Secondary | Why |
|--------------|----------------|-----------|-----|
| Original audio (mp3/wav/flac) | Blossom | - | Preserved for export/download packages |
| HLS segments (encrypted) | IPFS | - | Content-addressed streaming, cross-pinning |
| Cover art / album art | Blossom | IPFS | Fast HTTP serving, IPFS as fallback |
| Profile images | IPFS (for now) | - | TODO: migrate to Blossom primary |

## Node Identity

Each content node has its own NOSTR keypair, used for authenticating uploads to the Blossom server (BUD-03 protocol).

**File:** `content_node/orchestrator/api/services/node_identity.py`

On first startup:
1. Generates a secp256k1 keypair
2. Saves to `/data/node_identity.json` (persistent Docker volume)
3. Subsequent starts load the existing key

The node identity is separate from artist identities. It's used only for server-side operations like Blossom uploads.

### Key Functions

- `get_node_pubkey()` - Returns the node's hex public key
- `get_node_privkey()` - Returns the node's hex private key
- `sign_node_event(event)` - Signs a NOSTR event with the node key

## Blossom Server

### Docker Service

Runs as `equaliser-blossom` in the Docker Compose stack using `ghcr.io/hzrd149/blossom-server:master`.

Data is stored in the `blossom-data` Docker volume at `/app/data/blobs`.

### Configuration

**File:** `content_node/config/blossom/config.yml`

Key settings:
- **Storage rules**: Must explicitly allow MIME types (`audio/*`, `image/*`, `application/octet-stream`)
- **Upload auth**: Requires BUD-03 NOSTR authentication (Kind 24242 events)
- **Reads**: Anonymous (no auth required for GET requests)

### Nginx Proxy

The `/blossom/` location in nginx proxies to the Blossom server with aggressive caching headers:

```
Cache-Control: public, max-age=31536000, immutable
```

Hash-addressed content is safe to cache forever since the URL changes if the content changes.

## Upload Flow

### Track Upload

When an artist uploads a track via `/api/tracks/upload`:

1. **Blossom upload** - Original audio file uploaded to Blossom, returns SHA-256 hash
2. **HLS encoding** - FFmpeg encodes to HLS segments (full + 30s preview)
3. **IPFS upload** - HLS directories uploaded to IPFS, returns CIDs
4. **Draft creation** - SQLite draft record stores all references:
   - `blossom_audio_hash` - SHA-256 of original on Blossom
   - `ipfs_manifest_cid` - IPFS CID of full HLS directory
   - `ipfs_preview_cid` - IPFS CID of preview HLS directory
   - `original_filename` - Preserved for export packages

Blossom upload failure is **non-fatal** - the track is still usable for streaming via IPFS. The original just won't be available for export packages.

### Cover Art Upload

Via `/api/tracks/cover-art`:

1. Upload to Blossom (primary) - returns SHA-256 hash
2. Upload to IPFS (secondary) - returns CID
3. Returns both references for use in NOSTR events

### NOSTR Event Tags

Kind 30050 track events include optional Blossom tags:

```json
["blossom_audio_hash", "abc123..."]
["blossom_cover_hash", "def456..."]
["blossom_cover_url", "https://equaliser.app/blossom/def456..."]
```

The `blossom_cover_url` tag contains an **absolute URL** to the cover art on the origin node's Blossom server. This is generated at release time using the `PUBLIC_BASE_URL` environment variable on the orchestrator. It enables peer nodes to load cover art directly from the origin without mirroring Blossom data.

These are non-breaking additions - existing consumers ignore unknown tags.

## BUD-03 Authentication

Blossom uses NOSTR-based authentication for uploads. The flow:

1. Compute SHA-256 of the file to upload
2. Create a Kind 24242 NOSTR event with:
   - `t` tag: "upload"
   - `x` tag: file SHA-256 hash
   - `expiration` tag: current time + 5 minutes
3. Sign the event with the node's private key
4. Base64-encode the signed event
5. Send as HTTP header: `Authorization: Nostr <base64-encoded-event>`

**Implementation:** `content_node/orchestrator/api/services/blossom.py`

## Blossom Client API

The `blossom.py` service provides:

| Function | Description |
|----------|-------------|
| `upload_to_blossom(file_path)` | Upload file, returns SHA-256 hash |
| `check_blob_exists(sha256)` | HEAD request to check if blob exists |
| `download_from_blossom(sha256, output_path)` | Download blob to disk |
| `get_blob_url(sha256, ext)` | Construct Blossom URL — absolute (with `PUBLIC_BASE_URL`) or relative |

## Database Schema

The `drafts` table includes Blossom columns:

| Column | Type | Description |
|--------|------|-------------|
| `blossom_audio_hash` | TEXT | SHA-256 of original audio on Blossom |
| `blossom_cover_hash` | TEXT | SHA-256 of cover art on Blossom |
| `original_filename` | TEXT | Original upload filename |

## Troubleshooting

### Common Issues

**401 Unauthorized on upload:**
- Check the `X-Reason` response header for the actual error
- Common cause: storage rules don't allow the MIME type
- Verify `config.yml` has rules for `audio/*`, `image/*`, etc.

**"Server does not accept [mime-type] blobs":**
- The `storage.rules` array in `config.yml` must include the MIME type
- Both `storage.rules` and `upload.rules` must allow it

**Blossom container not starting:**
- Check healthcheck: `wget -q --spider http://localhost:3000`
- Verify config file is mounted correctly at `/app/config.yml`

### Verifying Blossom is Working

```bash
# Check Blossom is responding (via nginx proxy)
curl -s http://localhost/blossom/ | head

# Check a specific blob exists
curl -I http://localhost/blossom/<sha256-hash>

# View orchestrator logs for upload details
docker compose -f content_node/docker-compose.yml logs orchestrator | grep -i blossom
```

## Disaster Recovery

If a content node is lost, Blossom data can be rebuilt:

1. **NOSTR events survive** on relays (distributed by design)
2. **IPFS content survives** if cross-pinned by other nodes
3. Fresh node can:
   - Query relays for artist events
   - Extract `blossom_audio_hash` tags
   - Re-fetch originals from IPFS or other Blossom servers
   - Re-upload to local Blossom

This is currently a manual process. Automated tooling is planned for a future phase.

## Cross-Node Cover Art

When multiple content nodes peer-sync via the Equaliser Relay network, cover art needs to work across nodes without mirroring Blossom data. This is handled by a three-tier URL strategy:

### URL Priority (client-side)

1. **`blossom_cover_url`** — Absolute URL (e.g. `https://equaliser.app/blossom/{hash}`). Works cross-node. Generated at release time using `PUBLIC_BASE_URL`.
2. **`blossom_cover_hash`** — Relative URL (`/blossom/{hash}`). Works on the origin node only.
3. **`cover_art_cid`** — IPFS URL (`/ipfs/{cid}`). Resilient fallback via content-addressed network.

### Client Implementation

All cover art `<img>` tags include a `data-fallback` attribute with the IPFS URL when available. The `onerror` handler tries the IPFS fallback before hiding the image:

```html
<img src="https://origin.example/blossom/abc123"
     data-fallback="/ipfs/QmXyz..."
     onerror="if(this.dataset.fallback){this.onerror=null;this.src=this.dataset.fallback}else{this.style.display='none'}">
```

### Orchestrator Configuration

Set `PUBLIC_BASE_URL` on the orchestrator to enable absolute Blossom URLs:

```yaml
# docker-compose.override.yml
orchestrator:
  environment:
    - PUBLIC_BASE_URL=https://equaliser.app
```

When set, `get_blob_url()` returns absolute URLs. When empty (local dev), returns relative `/blossom/{hash}` paths.

### Package Import

The `/api/releases/import` endpoint uploads cover art to both Blossom (primary) and IPFS (fallback), ensuring the `cover_art_cid` tag is always populated for cross-node resilience.

## Future Work

- **Profile images on Blossom**: Migrate avatar/banner uploads to Blossom primary
- **Automated disaster recovery**: Script to rebuild Blossom from NOSTR + IPFS
- **Federation**: Mutual Blossom mirroring between artist content nodes
