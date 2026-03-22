# Content Node (Artist Admin + Backend)

Docker Compose stack: orchestrator (FastAPI), Equaliser Relay (Go), IPFS (Kubo), Blossom, nostr-rs-relay (standard relay), PostgreSQL, nginx.

## Docker Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| orchestrator | FastAPI (Python) | 8000 | Track upload, HLS encoding, IPFS/Blossom coordination, draft management |
| equaliser-relay | Custom Go binary | 8080 (WS), 8008 (REST) | NOSTR relay with PostgreSQL storage, full tag indexing, peer syncer, cache REST API |
| ipfs | ipfs/kubo | 5001 (API), 8080 (gateway) | Content-addressed storage for HLS streams and cover art |
| blossom | hzrd149/blossom-server | 3000 | Original audio + image storage by SHA-256 hash. BUD-03 auth |
| nostr-rs-relay | scsibug/nostr-rs-relay | 7700→8080 | Open standard NOSTR relay for user data caching (syncer pulls from this) |
| postgres | postgres:15-alpine | 5432 | PostgreSQL database owned by Equaliser Relay |
| web | nginx:alpine | 80 | Reverse proxy routing to all services + static file serving |

## Orchestrator API (orchestrator/api/)

### Core (`main.py`)
FastAPI app. CORS allow-all (dev). Initialises database + node identity on startup. Mounts 3 routers: tracks, drafts, packages.

### Services (orchestrator/api/services/)

| Module | Purpose | Integrations |
|--------|---------|--------------|
| `node_identity.py` | Persistent secp256k1 keypair for BUD-03 auth. Loads/generates from `/data/node_identity.json` | Blossom (signs Kind 24242 upload auth events) |
| `database.py` | SQLite CRUD for `draft_tracks` table. Fields: metadata, IPFS CIDs, Blossom hashes, NOSTR event status | Local SQLite file |
| `ipfs.py` | IPFS HTTP API client. `upload_file`, `upload_directory`, `pin_cid`, `unpin_cid`, `announce_to_dht` | IPFS API (port 5001) |
| `nostr.py` | Event creation + WebSocket publishing. Kind 30050 (tracks), Kind 30051 (releases). `create_track_event()`, `sign_event()`, `publish_event()`, `fetch_track_events()` | NOSTR relay (WebSocket) |
| `hls.py` | FFmpeg/ffprobe wrapper. `encode_to_hls()` produces full + 30s preview manifests. `get_audio_duration()` | FFmpeg binary in container |
| `blossom.py` | Blossom client with BUD-03 auth. `upload_to_blossom()`, `check_blob_exists()`, `download_from_blossom()`, `delete_from_blossom()`. Deduplication via HEAD check before upload | Blossom (port 3000) |
| `blossom_cleanup.py` | Periodic orphan blob cleanup. Scans Blossom SQLite for blobs with no owners, deletes files + DB records. Runs every 5 min (configurable via `BLOSSOM_CLEANUP_INTERVAL`) | Blossom data volume (`/blossom-data`) |

### API Endpoints (orchestrator/api/routers/)

**tracks.py** — Upload and publish:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/tracks/upload` | Upload audio → background: Blossom original → HLS encode → IPFS → draft |
| POST | `/api/tracks/duplicate` | Duplicate draft with independent IPFS CIDs (shared Blossom hash). Background: Blossom download → HLS encode → IPFS → new draft |
| GET | `/api/tracks/status/{track_id}` | Poll upload/duplicate progress |
| GET | `/api/tracks/` | List completed uploads |
| POST | `/api/tracks/publish` | Publish pre-signed Kind 30050 to relay, delete draft |
| POST | `/api/tracks/cover-art` | Upload cover to Blossom (primary) + IPFS (fallback). Absolute Blossom URL via `PUBLIC_BASE_URL` |
| POST | `/api/tracks/cleanup` | Unpin IPFS CIDs + delete Blossom blobs for deleted releases. Best-effort, client determines shared-reference safety |

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

**uploads.py** — Image uploads:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/upload/image` | Upload image to Blossom. Returns `{ blossom_hash, blossom_url }`. Absolute URL when `PUBLIC_BASE_URL` is set. Used by client settings (avatar/banner) and social feed image attach. |

**users.py** — User registration:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/users/register` | Proxy user pubkey registration to relay internal API (for data caching) |

**main.py** — Config and health:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check for container orchestration |
| GET | `/api/config` | Client-facing config: returns `{ standard_relays, public_base_url }` from env vars. Client uses `standard_relays` as default outbound publishing relays. Must match `STANDARD_RELAYS` on the Equaliser relay service. |

## Admin Pages (orchestrator/*.html)

All pages use shared `js/session.js` and `js/admin-sidebar.js`.

| Page | Purpose |
|------|---------|
| `login.html` | nsec / NIP-07 extension login. Session in sessionStorage |
| `onboarding.html` | First-time setup: generate identity, upload avatar/banner, publish Kind 0 |
| `dashboard.html` | Home: recent releases (Kind 30050), profile (Kind 0), track count |
| `releases.html` | Drafts + released tracks. Upload, edit, release, export. Release announcement modal (post Kind 1 to social feed after releasing) |
| `edit-release.html` | Edit metadata for draft or released track. Cover art upload. Add existing tracks (duplicated with independent IPFS CIDs) or upload new tracks directly into a release. Delete released tracks (Kind 5 + storage cleanup). Release announcement modal |
| `profile.html` | Edit Kind 0 profile (name, bio, avatar, banner via Blossom, socials). `ensureAbsoluteBlossomUrl()` converts relative Blossom URLs to absolute on save |
| `upload.html` | Standalone track upload form |
| `settings.html` | Placeholder for future settings (artist settings — listeners use client `/settings.html`) |

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
| `web/nginx.conf` | Proxy routes: `/api/cache/` → relay REST API, `/api/` → orchestrator, `/relay` → relay WebSocket, `/ipfs/` → IPFS gateway, `/blossom/` → Blossom, `/admin/` → orchestrator static, `/` → client |

## Key Data Flows

**Upload → Draft**: Audio file → Blossom (original) → FFmpeg (HLS) → IPFS (streaming) → SQLite (draft)

**Draft → Release**: Draft metadata → unsigned Kind 30050 → browser signs → publish to relay → delete draft

**Export**: Manifest + Blossom audio → signed `.eqpkg.zip`

**Import**: `.eqpkg.zip` → validate → Blossom upload → HLS encode → IPFS → drafts

**Delete**: Browser signs Kind 5 → publish to relay → `POST /api/tracks/cleanup` (unpin IPFS, delete Blossom) → orphan cleanup removes files from disk

## NOSTR Event Kinds

| Kind | Purpose | Tags |
|------|---------|------|
| 0 | Artist profile | `app`, `user-type` (`"artist"` for artists, omitted for listeners) |
| 30050 | Track metadata (replaceable) | `d`, `app`, `title`, `artist`, `duration`, `ipfs_manifest_cid`, `ipfs_preview_cid`, `price`, `price_currency`, `album`, `genre`, `cover_art_cid`, `blossom_audio_hash`, `blossom_cover_hash`, `blossom_cover_url`, `track_number` |
| 30051 | Release metadata (album grouping) | `d`, `app`, `title`, `artist`, `release_type` |
| 5 | Deletion (NIP-09) | `app`, `e` (event IDs to delete) |
| 24242 | Blossom auth (BUD-03) | `t` (upload/delete), `x` (file hash), `expiration` |

## Key Design Patterns

- **Client-side signing**: Server returns unsigned events; browser signs (non-custodial)
- **Draft → Release workflow**: SQLite for drafts, NOSTR relay becomes source of truth after publish
- **Dual storage**: Blossom for originals (disaster recovery), IPFS for streaming (content-addressed)
- **Storage ownership**: Each release owns its own IPFS CIDs (unique HLS encode). Blossom hashes may be shared across releases (content-addressed dedup). Deletion checks for shared Blossom references before removing.
- **Node identity**: Persistent keypair for server-side Blossom auth (artists don't sign Blossom uploads)
