# Content Node (Artist Admin + Backend)

Docker Compose stack: orchestrator (FastAPI), IPFS (Kubo), NOSTR relay (nostr-rs-relay), Blossom, nginx.

## Docker Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| orchestrator | FastAPI (Python) | 8000 | Track upload, HLS encoding, IPFS/Blossom coordination, draft management |
| ipfs | ipfs/kubo | 5001 (API), 8080 (gateway) | Content-addressed storage for HLS streams and cover art |
| nostr-relay | scsibug/nostr-rs-relay | 8080 | Event storage (Kind 0 profiles, Kind 30050 tracks, Kind 1 posts, etc.) |
| blossom | hzrd149/blossom-server | 3000 | Original audio + image storage by SHA-256 hash. BUD-03 auth |
| web | nginx:alpine | 80 | Reverse proxy routing to all services + static file serving |

## Orchestrator API (orchestrator/api/)

### Core (`main.py`)
FastAPI app. CORS allow-all (dev). Initialises database + node identity on startup. Mounts 3 routers: tracks, drafts, packages.

### Services (orchestrator/api/services/)

| Module | Purpose | Integrations |
|--------|---------|--------------|
| `node_identity.py` | Persistent secp256k1 keypair for BUD-03 auth. Loads/generates from `/data/node_identity.json` | Blossom (signs Kind 24242 upload auth events) |
| `database.py` | SQLite CRUD for `draft_tracks` table. Fields: metadata, IPFS CIDs, Blossom hashes, NOSTR event status | Local SQLite file |
| `ipfs.py` | IPFS HTTP API client. `upload_file`, `upload_directory`, `pin_cid`, `announce_to_dht` | IPFS API (port 5001) |
| `nostr.py` | Event creation + WebSocket publishing. Kind 30050 (tracks), Kind 30051 (releases). `create_track_event()`, `sign_event()`, `publish_event()`, `fetch_track_events()` | NOSTR relay (WebSocket) |
| `hls.py` | FFmpeg/ffprobe wrapper. `encode_to_hls()` produces full + 30s preview manifests. `get_audio_duration()` | FFmpeg binary in container |
| `blossom.py` | Blossom client with BUD-03 auth. `upload_to_blossom()`, `check_blob_exists()`, `download_from_blossom()`. Deduplication via HEAD check before upload | Blossom (port 3000) |

### API Endpoints (orchestrator/api/routers/)

**tracks.py** — Upload and publish:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/tracks/upload` | Upload audio → background: Blossom original → HLS encode → IPFS → draft |
| POST | `/api/tracks/duplicate` | Duplicate draft with independent IPFS CIDs (shared Blossom hash). Background: Blossom download → HLS encode → IPFS → new draft |
| GET | `/api/tracks/status/{track_id}` | Poll upload/duplicate progress |
| GET | `/api/tracks/` | List completed uploads |
| POST | `/api/tracks/publish` | Publish pre-signed Kind 30050 to relay, delete draft |
| POST | `/api/tracks/cover-art` | Upload cover to Blossom (primary) + IPFS (fallback) |

**drafts.py** — Draft management:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/drafts` | List drafts (filter by pubkey, status, album) |
| GET | `/api/drafts/{id}` | Get single draft |
| PATCH | `/api/drafts/{id}` | Update metadata |
| DELETE | `/api/drafts/{id}` | Delete draft |
| POST | `/api/drafts/{id}/release` | Get unsigned Kind 30050 for client signing |
| POST | `/api/drafts/release-album` | Batch: unsigned events for all album tracks |
| POST | `/api/drafts/{id}/mark-released` | Delete draft after NOSTR publication |

**packages.py** — `.eqpkg.zip` export/import:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/releases/export-prepare` | Build manifest, return unsigned event for signing |
| POST | `/api/releases/export-download` | Download ZIP (manifest + signature + audio from Blossom) |
| POST | `/api/releases/import` | Import ZIP → Blossom upload → HLS encode → IPFS → drafts |

## Admin Pages (orchestrator/*.html)

All pages use shared `js/session.js` and `js/admin-sidebar.js`.

| Page | Purpose |
|------|---------|
| `login.html` | nsec / NIP-07 extension login. Session in sessionStorage |
| `onboarding.html` | First-time setup: generate identity, upload avatar/banner, publish Kind 0 |
| `dashboard.html` | Home: recent releases (Kind 30050), profile (Kind 0), track count |
| `releases.html` | Drafts + released tracks. Upload, edit, release, export |
| `edit-release.html` | Edit metadata for draft or released track. Cover art upload. Add existing tracks (duplicated with independent IPFS CIDs) or upload new tracks directly into a release |
| `profile.html` | Edit Kind 0 profile (name, bio, avatar, banner, socials) |
| `upload.html` | Standalone track upload form |
| `settings.html` | Placeholder for future settings |

## Shared JS (orchestrator/js/)

| Module | Purpose | Used By |
|--------|---------|---------|
| `session.js` | Session management. nsec or NIP-07 login. 30-min idle timeout, multi-tab logout sync. `signEvent()` auto-adds `["app", "Equaliser"]` tag | All admin pages |
| `admin-sidebar.js` | Navigation sidebar component. Logo, profile card, nav menu, session info, logout | All admin pages |

## Config Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Service definitions, volumes, networking |
| `config/blossom/config.yml` | Blossom rules: audio/* + image/* allowed, BUD-03 auth, local file storage |
| `ipfs/configure-gateway.sh` | Startup script: path-style URLs, API on 0.0.0.0 |
| `web/nginx.conf` | Proxy routes: `/api/` → orchestrator, `/relay` → nostr, `/ipfs/` → IPFS gateway, `/blossom/` → Blossom, `/admin/` → orchestrator static, `/` → client |

## Key Data Flows

**Upload → Draft**: Audio file → Blossom (original) → FFmpeg (HLS) → IPFS (streaming) → SQLite (draft)

**Draft → Release**: Draft metadata → unsigned Kind 30050 → browser signs → publish to relay → delete draft

**Export**: Manifest + Blossom audio → signed `.eqpkg.zip`

**Import**: `.eqpkg.zip` → validate → Blossom upload → HLS encode → IPFS → drafts

## NOSTR Event Kinds

| Kind | Purpose | Tags |
|------|---------|------|
| 0 | Artist profile | `app`, `user-type` (`"artist"` for artists, omitted for listeners) |
| 30050 | Track metadata (replaceable) | `d`, `app`, `title`, `artist`, `duration`, `ipfs_manifest_cid`, `ipfs_preview_cid`, `price`, `price_currency`, `album`, `genre`, `cover_art_cid`, `blossom_audio_hash`, `blossom_cover_hash`, `blossom_cover_url`, `track_number` |
| 30051 | Release metadata (album grouping) | `d`, `app`, `title`, `artist`, `release_type` |
| 24242 | Blossom auth (BUD-03) | `t` (upload/delete), `x` (file hash), `expiration` |

## Key Design Patterns

- **Client-side signing**: Server returns unsigned events; browser signs (non-custodial)
- **Draft → Release workflow**: SQLite for drafts, NOSTR relay becomes source of truth after publish
- **Dual storage**: Blossom for originals (disaster recovery), IPFS for streaming (content-addressed)
- **Storage ownership**: Each release owns its own IPFS CIDs (unique HLS encode). Blossom hashes may be shared across releases (content-addressed dedup). Deletion checks for shared Blossom references before removing.
- **Node identity**: Persistent keypair for server-side Blossom auth (artists don't sign Blossom uploads)
