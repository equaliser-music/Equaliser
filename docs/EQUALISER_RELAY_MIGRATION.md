# Equaliser Relay — Migration Plan

**Companion to:** [EQUALISER_RELAY.md](EQUALISER_RELAY.md)

---

## Overview

This document covers the practical migration from nostr-rs-relay to the Equaliser Relay. It maps infrastructure changes, client-side updates, data migration, and a phased rollout strategy aligned with the four phases in [EQUALISER_RELAY.md](EQUALISER_RELAY.md).

---

## 1. Infrastructure Changes

### Docker Compose

**Current services:**

| Service | Image | Port | Volume |
|---------|-------|------|--------|
| `nostr-relay` | `scsibug/nostr-rs-relay:latest` | 8080 | `nostr-data` (SQLite) |
| `orchestrator` | Custom (FastAPI) | 8000 | `drafts-data` (SQLite) |
| `ipfs` | `ipfs/kubo:latest` | 4001, 5001 | `ipfs-data` |
| `blossom` | `ghcr.io/hzrd149/blossom-server:master` | 3000 | `blossom-data` |
| `web` (nginx) | `nginx:alpine` | 80 | — |

**After migration:**

| Service | Image | Port | Volume |
|---------|-------|------|--------|
| `equaliser-relay` | Custom (Go/Rust) | 8080 (WS), 8008 (REST) | — |
| `postgres` | `postgres:15` | 5432 | `postgres-data` |
| `orchestrator` | Custom (FastAPI) | 8000 | `drafts-data` (SQLite) |
| `ipfs` | `ipfs/kubo:latest` | 4001, 5001 | `ipfs-data` |
| `blossom` | `ghcr.io/hzrd149/blossom-server:master` | 3000 | `blossom-data` |
| `web` (nginx) | `nginx:alpine` | 80 | — |

**Key differences:**
- `nostr-relay` + `nostr-data` volume removed
- `equaliser-relay` + `postgres` + `postgres-data` volume added
- Orchestrator `depends_on` updated: `nostr-relay` → `equaliser-relay`
- Orchestrator env: `NOSTR_RELAY_URL=ws://equaliser-relay:8080`

### Event Kind Allowlist

The current nostr-rs-relay `config.toml` restricts accepted event kinds:

```
event_kind_allowlist = [0, 1, 3, 4, 5, 6, 7, 10002, 24242, 30001, 30050, 30051]
```

The Equaliser Relay's event acceptance policy (`EVENT_POLICY`) handles this differently — it filters by `["app", "Equaliser"]` tag rather than by kind. However, the same kinds should be supported. The `equaliser_only` policy rejects events without the app tag; the `open` and `hybrid` policies accept broader kinds for NOSTR interop.

### nginx Routing

**Current routing** (`content_node/web/nginx.conf`):

```
/relay      → nostr-relay:8080    (WebSocket proxy)
/api/*      → orchestrator:8000   (REST API)
/blossom/*  → blossom:3000        (Binary storage)
/ipfs/*     → ipfs:8080           (Content gateway)
/admin/*    → static files        (Admin dashboard)
/           → static files        (Client SPA)
```

**After migration:**

```
/relay                    → equaliser-relay:8080    (WebSocket proxy — unchanged behaviour)
/api/artists/*            → equaliser-relay:8008    (REST API — NEW)
/api/tracks               → equaliser-relay:8008    (REST API — NEW, GET only)
/api/tracks/{id}          → equaliser-relay:8008    (REST API — NEW, GET only)
/api/search               → equaliser-relay:8008    (REST API — NEW)
/api/users/*/feed         → equaliser-relay:8008    (REST API — NEW)
/api/users/*/playlists    → equaliser-relay:8008    (REST API — NEW)
/api/*                    → orchestrator:8000       (Everything else — uploads, drafts, releases, user registration)
/blossom/*                → blossom:3000
/ipfs/*                   → ipfs:8080
/admin/*                  → static files
/                         → static files
```

nginx processes `location` blocks by specificity — exact and prefix matches before regex. The relay REST API routes are more specific than the catch-all `/api/` block, so they take precedence.

**Note on `/api/tracks` conflict:** The orchestrator has `POST /api/tracks/upload` and `POST /api/tracks/publish`. The relay serves `GET /api/tracks` and `GET /api/tracks/{event_id}`. This is resolvable by:
- Routing `/api/tracks/upload` and `/api/tracks/publish` explicitly to orchestrator
- Routing `GET /api/tracks` to relay
- Or: relay REST API uses a different prefix like `/api/cache/` (simpler but less clean)

---

## 2. Data Migration

nostr-rs-relay stores events in a SQLite database at the `nostr-data` Docker volume. When switching to PostgreSQL, existing events need to be migrated.

### Option A: Event replay (recommended for production)

Export all events from nostr-rs-relay's SQLite and replay them into the Equaliser Relay via WebSocket:

```
1. Start Equaliser Relay alongside nostr-rs-relay (temporarily)
2. Read events from SQLite (SELECT id, raw_event FROM event ORDER BY created_at)
3. For each event, send ["EVENT", event_json] to Equaliser Relay's WebSocket
4. Relay validates, deduplicates, stores in PostgreSQL, parses into denormalised tables
5. Verify counts match
6. Remove nostr-rs-relay
```

This preserves all event history and lets the Equaliser Relay's ingestion pipeline process each event normally.

### Option B: Fresh start (recommended for dev/test)

For development nodes or nodes with test data:

```
1. Export artist content as .eqpkg.zip packages (backup)
2. Remove nostr-rs-relay and nostr-data volume
3. Start Equaliser Relay with fresh PostgreSQL
4. Re-import packages via import-artist.sh
5. Re-publish profiles via admin UI
```

### Option C: Peer syncer recovery

If events were published to external relays (damus, nos.lol), the peer syncer will re-ingest them:

```
1. Start Equaliser Relay with PEER_RELAYS configured
2. Peer syncer subscribes to Equaliser-tagged events on external relays
3. Events flow in and populate the database
4. Local-only events (playlists, DMs) are NOT recoverable this way
```

Best used as a supplement to Option A, not a replacement.

---

## 3. Orchestrator Changes

### Connection Config

| Variable | Before | After |
|----------|--------|-------|
| `NOSTR_RELAY_URL` | `ws://nostr-relay:8080` | `ws://equaliser-relay:8080` |

**File:** `content_node/orchestrator/api/services/nostr.py`

The orchestrator's relay interaction code (`publish_event`, `publish_signed_event`, `fetch_track_events`) uses the WebSocket NIP-01 protocol. This is unchanged — the Equaliser Relay speaks the same protocol.

### What stays on the orchestrator

- `POST /api/tracks/upload` — audio upload, HLS encoding, IPFS/Blossom storage
- `POST /api/tracks/publish` — publish signed events to relay
- `POST /api/tracks/cover-art` — cover art upload
- `GET/POST /api/drafts/*` — draft management (SQLite)
- `POST /api/releases/export-*` — package export
- `POST /api/releases/import` — package import
- `POST /api/users/register` — user registration (writes to `registered_users` in PostgreSQL)

### What moves to the relay

- Read-side data serving: artist profiles, track listings, search, user feeds, playlists
- These are served by the relay's REST API, not the orchestrator

### Shared database access

The orchestrator needs read access to the relay's PostgreSQL for user registration (checking `registered_users`). Either:
- Orchestrator connects to PostgreSQL directly (same `DATABASE_URL`)
- Orchestrator calls relay's REST API to check user status

---

## 4. Client Changes — Admin Pages

**Directory:** `content_node/orchestrator/`

These are artist-facing admin pages. Currently they use per-query WebSocket connections to the local relay.

### Pages that change

| Page | Current | After |
|------|---------|-------|
| `dashboard.html` | `fetchProfile()` — WebSocket `{kinds:[0], authors:[pk]}` | `fetch('/api/artists/{npub}')` |
| `dashboard.html` | `fetchReleases()` — WebSocket `{kinds:[30050], authors:[pk]}` | `fetch('/api/artists/{npub}/tracks')` |
| `releases.html` | `loadReleasedFromNostr()` — WebSocket `{kinds:[30050], authors:[pk]}` | `fetch('/api/artists/{npub}/tracks')` |
| `profile.html` | Profile fetch — WebSocket `{kinds:[0], authors:[pk]}` | `fetch('/api/artists/{npub}')` |

### Pages unchanged

| Page | Reason |
|------|--------|
| `upload.html` | Uses orchestrator REST API (`/api/tracks/upload`) |
| `edit-release.html` | Uses orchestrator REST API (`/api/drafts/*`) |
| `login.html` | No relay interaction |
| `onboarding.html` | Publishes via orchestrator API |
| `settings.html` | No relay interaction |
| `js/session.js` | Signing logic unchanged |

### Migration approach

These pages are simple — replace the 30-line WebSocket promise wrappers with `fetch()` calls. The REST API returns structured JSON instead of raw NOSTR events, so the client-side tag parsing (`parseTrackEvent()`) simplifies to direct property access.

---

## 5. Client Changes — Public App

**Directory:** `client/`

This is the larger migration. The public app uses pure NOSTR WebSocket with no REST API calls, extensive client-side filtering, and multi-relay queries.

### Key modules

| Module | Purpose | Changes |
|--------|---------|---------|
| `js/nostr-social.js` | Core relay communication, client-side filtering | Major — add REST API methods, remove client-side multi-char tag filtering |
| `js/nostr-playlists.js` | Playlist CRUD via NOSTR | Moderate — playlist reads via REST API |
| `js/nostr-dm.js` | NIP-04 encrypted DMs | Minimal — DMs use single-letter `p` tag, already relay-indexed |
| `js/session.js` | Auth, signing, auto-tagging | None |
| `js/player.js` | HLS audio playback | None |
| `js/router.js` | SPA routing | None |
| `js/sidebar.js` | Navigation sidebar | None |

### Reads that migrate to REST API

| Page | Current WebSocket query | New REST call |
|------|------------------------|---------------|
| `home.js` | `{kinds:[30050], limit:500}` | `GET /api/tracks` |
| `home.js` | `{kinds:[0], authors:pubkeys}` | `GET /api/artists` |
| `artist.js` | `{kinds:[0], authors:[pk]}` | `GET /api/artists/{npub}` |
| `artist.js` | `{kinds:[30050], authors:[pk]}` | `GET /api/artists/{npub}/tracks` |
| `user.js` | `{kinds:[0], authors:[pk]}` | `GET /api/artists/{npub}` or `GET /api/users/me?pubkey={hex}` |
| `library.js` | `{kinds:[30001], authors:[pk]}` | `GET /api/users/{pubkey}/playlists` |

### Reads that stay on WebSocket (improved)

These queries benefit from full tag indexing but stay on WebSocket for real-time or multi-relay needs:

| Query | Before | After |
|-------|--------|-------|
| Feed posts | `{kinds:[1], limit:50}` + client-side `app` + `content-type` filter | `{kinds:[1], '#app':['Equaliser'], '#content-type':['post'], limit:50}` |
| Community threads | `{kinds:[1], limit:500}` + client-side `content-type` + `board` filter | `{kinds:[1], '#app':['Equaliser'], '#content-type':['thread'], '#board':['general'], limit:100}` |
| Thread replies | `{kinds:[1], '#e':[id], limit:500}` + client-side `app` filter | `{kinds:[1], '#e':[id], '#app':['Equaliser'], limit:500}` |
| Reactions | `{kinds:[7,6], '#e':noteIds}` | No change (already uses single-letter `e` tag) |
| DMs | `{kinds:[4], '#p':[pk]}` | No change (already uses single-letter `p` tag) |
| Contact list | `{kinds:[3], authors:[pk]}` | No change |

### Client-side filtering removed

The following client-side filtering patterns become unnecessary:

```javascript
// BEFORE: Fetch broadly, filter client-side
const allNotes = await fetchNotes({ kinds: [1], limit: 500 });
const threads = allNotes.filter(ev =>
    ev.tags.some(t => t[0] === 'app' && t[1] === 'Equaliser') &&
    ev.tags.some(t => t[0] === 'content-type' && t[1] === 'thread') &&
    ev.tags.some(t => t[0] === 'board' && t[1] === board)
);

// AFTER: Relay filters for us
const threads = await fetchNotes({
    kinds: [1],
    '#app': ['Equaliser'],
    '#content-type': ['thread'],
    '#board': [board],
    limit: 100
});
```

**Files affected:**
- `js/nostr-social.js` — `fetchCommunityThreads()`, `fetchCommunityReplies()`, `fetchNotes()` filtering logic
- `js/pages/social.js` — feed and community filtering
- `js/pages/home.js` — feed filtering
- `js/pages/thread.js` — reply filtering
- `js/pages/user.js` — post filtering
- `js/pages/artist.js` — feed filtering

### New module: `client/js/nostr-api.js`

A REST API wrapper for structured data reads:

```javascript
const EqualiserAPI = {
    async getArtists() { /* GET /api/artists */ },
    async getArtist(npub) { /* GET /api/artists/{npub} */ },
    async getArtistTracks(npub) { /* GET /api/artists/{npub}/tracks */ },
    async getTrack(eventId) { /* GET /api/tracks/{eventId} */ },
    async getTracks(params) { /* GET /api/tracks */ },
    async search(query) { /* GET /api/search?q={query} */ },
    async getUserFeed(pubkey) { /* GET /api/users/{pubkey}/feed */ },
    async getUserPlaylists(pubkey) { /* GET /api/users/{pubkey}/playlists */ },
};
```

### Publishing stays the same

- `NostrSocial.publishEvent()` — sends signed events to all configured relays via WebSocket
- `SessionManager.signEvent()` — client-side Schnorr signing unchanged
- Auto-tagging `['app', 'Equaliser']` unchanged
- The peer syncer handles federation (forwarding to external relays), but the client can still publish to external relays directly for redundancy

---

## 6. Phased Rollout

Aligned with [EQUALISER_RELAY.md](EQUALISER_RELAY.md) migration phases.

### Phase 1: Core relay + storage (drop-in replacement)

**Goal:** Swap nostr-rs-relay for Equaliser Relay with zero client changes.

**Infrastructure:**
- Replace `nostr-relay` service with `equaliser-relay` + `postgres` in Docker Compose
- WebSocket on port 8080, same NIP-01 protocol
- Migrate events from SQLite to PostgreSQL (see Data Migration above)
- Update orchestrator `NOSTR_RELAY_URL` env var

**Client:**
- No changes required — existing WebSocket queries work identically
- Full tag indexing available but not yet used by client code

**Verification:**
- All admin pages load correctly (dashboard, releases, profile)
- All client pages load correctly (home, artist, social, community, messages)
- Track upload → publish → appears in dashboard
- Social posts, threads, DMs all work
- External NOSTR clients can connect via `/relay`

### Phase 2: Peer syncing

**Goal:** Content federation with external relays.

**Infrastructure:**
- Configure `PEER_RELAYS` env var with external relay URLs
- Peer syncer subscribes to Equaliser-tagged events on external relays
- Orchestrator publishes to local relay; peer syncer forwards to external relays

**Client:**
- No changes required
- Events from other Equaliser nodes begin appearing in queries

**Verification:**
- Events published locally appear on configured external relays
- Events from external relays appear in local queries
- Reconnection works after network interruption

### Phase 3: REST API + client migration

**Goal:** Structured data serving + simplified client code.

**Infrastructure:**
- Relay serves REST API on port 8008
- nginx routes added for relay REST API paths
- Denormalised tables populated on event arrival

**Client:**
- Add `client/js/nostr-api.js` REST API wrapper
- Migrate admin pages (dashboard, releases) to REST API
- Migrate public client structured reads (tracks, artists, playlists) to REST API
- Update WebSocket queries to use `#app`, `#content-type`, `#board` filters
- Remove client-side filtering workarounds from `nostr-social.js`

**Verification:**
- REST API returns correct data for all endpoints
- Admin pages work with REST API
- Client pages work with mixed REST API + improved WebSocket
- Performance improvement measurable (fewer events transferred, no client-side filtering)

### Phase 4: Optimise

**Goal:** Production-ready performance.

- Connection pooling for PostgreSQL
- Query optimisation for denormalised tables
- Persistent WebSocket connections (replace per-query pattern) for real-time updates
- Cache hot paths (frequently accessed artists, popular tracks)
- Benchmark and tune for target load

---

## 7. Rollback Strategy

- Keep nostr-rs-relay Docker image reference in a comment for quick rollback
- PostgreSQL events can be exported and replayed to nostr-rs-relay if needed
- Client REST API wrapper (`nostr-api.js`) can fall back to WebSocket queries if REST API is unavailable
- Phase 1 is fully reversible — just swap the Docker Compose service back

---

## References

- [EQUALISER_RELAY.md](EQUALISER_RELAY.md) — Relay specification
- [DATABASE.md](DATABASE.md) — Database schema (denormalised tables)
- [CONTENT_NODE.md](CONTENT_NODE.md) — Content node architecture
- [NOSTR.md](NOSTR.md) — NOSTR protocol usage and relay configuration
