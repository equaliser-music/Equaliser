# Equaliser Relay

**Status:** Specification

---

## Motivation

A music platform relay has requirements that generic NOSTR relays (like nostr-rs-relay) cannot meet:

- **Full tag indexing** — Equaliser uses multi-character tags (`app`, `content-type`, `board`) extensively. Generic relays only index single-letter tags, forcing client-side filtering after broad fetches. This is the single biggest source of workarounds in the codebase.
- **Denormalised schemas** — fast queries for artists, tracks, albums, and user data require purpose-built tables, not raw event storage.
- **Peer syncing** — subscribing to external relays, ingesting events from the wider NOSTR network, and publishing outbound for federation.
- **REST API** — the web client needs fast, structured read endpoints (artist catalogues, track listings, search) alongside the WebSocket protocol.
- **Scalable storage** — PostgreSQL from the start, not SQLite with a migration path.

The Equaliser Relay is a single service purpose-built around these requirements — a NOSTR relay that is also the cache, the sync engine, and the API server.

---

## Design Principle

**Externally: good NOSTR citizen.** Speaks NIP-01 WebSocket protocol. Any standard NOSTR client can connect, subscribe, and read events. Publishes outbound to configured peer relays for federation and discoverability.

**Internally: optimised for Equaliser.** PostgreSQL backend with denormalised schemas for tracks, artists, albums, users, and playlists. Full multi-char tag indexing. REST API for the web client. Built-in peer syncing for external relay subscriptions.

The wider NOSTR network is supported — but never at the cost of app user experience and performance.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                Docker Compose Stack                   │
│                                                       │
│  ┌──────────┐  ┌───────────────────┐  ┌───────────┐ │
│  │  IPFS    │  │  Equaliser Relay  │  │Orchestrator│ │
│  │  (kubo)  │  │  (Go)            │  │ (FastAPI)  │ │
│  │          │  │                   │  │            │ │
│  │          │  │  ┌─────────────┐  │  │            │ │
│  │          │  │  │ WebSocket   │  │  │            │ │
│  │          │  │  │ (NIP-01)    │  │  │            │ │
│  │          │  │  ├─────────────┤  │  │            │ │
│  │          │  │  │ REST API    │◄─┼──┤  reads     │ │
│  │          │  │  ├─────────────┤  │  │            │ │
│  │          │  │  │ Peer Syncer │  │  │            │ │
│  │          │  │  ├─────────────┤  │  │            │ │
│  │          │  │  │ PostgreSQL  │  │  │            │ │
│  │          │  │  │  (storage)  │  │  │            │ │
│  │          │  │  └─────────────┘  │  │            │ │
│  └──────────┘  └───────────────────┘  └───────────┘ │
│                        │                              │
└────────────────────────┼──────────────────────────────┘
                         │ WebSocket (outbound subscriptions + publishing)
                         ▼
                  ┌──────────┐  ┌──────────┐
                  │  Damus   │  │  nos.lol │  ...
                  │  Relay   │  │  Relay   │
                  └──────────┘  └──────────┘
```

### Replaces nostr-rs-relay

The Equaliser Relay replaces nostr-rs-relay in the Docker Compose stack. It speaks the same NIP-01 WebSocket protocol but adds PostgreSQL storage, full tag indexing, peer syncing, denormalised schemas, and a REST API.

The orchestrator remains for track uploads, HLS encoding, IPFS management, and draft workflow. It reads from the relay's database for any data it needs.

---

## Components

### 1. WebSocket Layer (NIP-01)

Standard NOSTR relay protocol. Accepts `REQ`, `EVENT`, `CLOSE` messages.

**Key difference from generic relays:**
- Indexes ALL tags, not just single-letter ones
- `#app`, `#content-type`, `#board` filters work natively in subscription queries
- No client-side filtering workarounds needed

**Supported NIPs:** `[1, 9, 11, 45]`
- NIP-01 — Basic protocol (REQ/EVENT/CLOSE/EOSE/OK/NOTICE), replaceable events, parameterised replaceable events
- NIP-09 — Event deletion (Kind 5 delete requests — relay deletes referenced events from storage)
- NIP-11 — Relay information document (served at WebSocket URL via HTTP GET with `Accept: application/nostr+json`)
- NIP-45 — Event counts (COUNT verb — efficient with PostgreSQL `COUNT(*)`)

Social NIPs (NIP-04 DMs, NIP-10 threading, NIP-25 reactions) work automatically via NIP-01 event storage and tag filtering — no relay-side code needed. They are not listed in `supported_nips` because they are client-side conventions, not relay behaviours.

**NIP-11 relay information document:**

```json
{
  "name": "${RELAY_NAME}",
  "description": "${RELAY_DESCRIPTION}",
  "supported_nips": [1, 9, 11, 45],
  "software": "equaliser-relay",
  "version": "0.1.0",
  "limitation": {
    "max_message_length": 65536,
    "max_subscriptions": 20,
    "max_filters": 10,
    "max_event_tags": 2000,
    "auth_required": false
  }
}
```

`RELAY_NAME` and `RELAY_DESCRIPTION` are configurable via environment variables (shared with `/api/access/node-info`).

**Event acceptance policy:**
- Events with `["app", "Equaliser"]` tag → stored in optimised schema + raw event table
- Events without the tag → optionally accepted into a raw-only table (for NOSTR interop) or rejected
- Configurable per-node: open (accept all), filtered (Equaliser only), or hybrid

### 2. Optimised Storage (PostgreSQL)

Events are stored in three layers:

1. **`raw_events` table** — every accepted event with top-level fields extracted for `REQ` filtering, plus full event as JSONB for verbatim serving
2. **`event_tags` table** — normalised tag index enabling relay-side filtering on any tag name (including multi-char tags)
3. **Denormalised tables** — parsed into Equaliser-specific schemas for fast REST API queries

See [DATABASE.md](DATABASE.md) for the full `raw_events` and `event_tags` schemas.

The denormalised tables are the same schemas already specified in [DATABASE.md](DATABASE.md):

**Artist data:**
- `cached_artists` (Kind 0) — parsed profiles
- `cached_tracks` (Kind 30050) — track metadata with IPFS CIDs
- `cached_albums` (Kind 30051) — album metadata

**User data:**
- `registered_users` — authenticated fan pubkeys
- `cached_users` (Kind 0) — parsed fan profiles
- `cached_user_follows` (Kind 3) — follow lists
- `cached_user_feed` (Kind 1) — feed events with thresholds
- `cached_user_playlists` (Kind 30001) — playlists

**Operational:**
- `peer_relays` — tracked relay connections
- `event_log` — processing log

When an event arrives (from WebSocket or peer sync), it's written to raw storage AND parsed into the appropriate denormalised table in a single transaction. No sync lag.

### 3. REST API

The relay serves four tiers of REST endpoints, each with different access controls:

**Public — `/api/catalogue/*`** (proxied by nginx, rate limited, GET only, same-origin CORS)

Read-only endpoints for this node's own client. The data is publicly available via the WebSocket relay, but the catalogue API exists purely as a performance cache for the local client — not as a public API for other nodes or third-party clients. Each node builds its own cache from NOSTR events. nginx enforces same-origin CORS (`Access-Control-Allow-Origin` set to the node's own domain) and rate limiting.

```
GET /api/catalogue/artists                    - List all cached artists
GET /api/catalogue/artists/{npub}             - Single artist profile
GET /api/catalogue/artists/{npub}/tracks      - Artist's tracks
GET /api/catalogue/tracks/{event_id}          - Single track
GET /api/catalogue/tracks                     - Tracks across all artists
GET /api/catalogue/search                     - Search artists and tracks
GET /api/catalogue/users/me?pubkey={hex}      - Cached user profile
GET /api/catalogue/users/{pubkey}/feed        - User's cached feed
GET /api/catalogue/users/{pubkey}/playlists   - User's playlists
```

**Public — `/api/access/*`** (proxied by nginx, rate limited)

Access control endpoints for artist onboarding. These read/write the `access_requests` and `node_artists` tables in PostgreSQL, so they are served by the relay (the sole PostgreSQL owner). See [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) Section 5.

```
POST /api/access/request                      - Submit a join request (public form)
GET  /api/access/node-info                    - Public node info (name, description, artist count, fee model)
```

**Internal — `/api/internal/*`** (Docker network only, NOT proxied by nginx)

Orchestrator-to-relay calls. Only reachable on the Docker internal network — nginx never routes these paths, so they are not accessible from the public internet. The orchestrator calls `http://equaliser-relay:8008/api/internal/*` directly.

```
POST /api/internal/users/register             - Register fan pubkey for data caching
POST /api/internal/access/validate            - Validate an invite code
POST /api/internal/access/onboard             - Record successful artist onboarding
GET  /api/internal/access/check?pubkey={hex}  - Check if pubkey is approved on this node
```

**Admin — `/api/admin/*`** (password authenticated via `ADMIN_PASSWORD` env var)

Node management endpoints for the admin console. See [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) Section 4.

The orchestrator handles track uploads, draft management, and IPFS at `/api/*`. The relay handles all read-side data serving at `/api/catalogue/*`. No routing ambiguity in nginx.

**Orchestrator data access:** The orchestrator does NOT connect to PostgreSQL directly. All data access goes through the relay's REST API (`/api/internal/*` for writes, `/api/catalogue/*` for reads). The relay is the sole owner of PostgreSQL.

### 4. Peer Syncer

The peer syncer is a built-in component that handles all external relay communication:

- Maintains persistent WebSocket connections to configured external relays
- Subscribes to Equaliser-tagged events
- Subscribes to registered user pubkeys for data caching
- Auto-discovers relays via Kind 10002 events
- Automatic reconnection with exponential backoff
- Periodic full sync as safety net

Also handles **outbound publishing** — when the orchestrator publishes an event to the local relay, the peer syncer forwards it to configured external relays for federation.

**Cross-node caching:** Events arriving from other Equaliser nodes (peer relays) follow the exact same path as locally-created events — signature validation, deduplication, raw storage, and denormalised parsing. There is no distinction between "local event" and "remote event" in the storage layer. This means an artist's catalogue published on Node A is automatically available as structured, queryable data on Node B the moment it syncs — no separate cache-building step. The relay's peer subscriptions (Equaliser-tagged events from configured relays) ensure that content from across the network is ingested, indexed, and immediately servable via both WebSocket and REST API.

---

## Tag Indexing

The core advantage. All tags are indexed in PostgreSQL using a normalised tag table:

```sql
CREATE TABLE event_tags (
    event_id TEXT NOT NULL REFERENCES raw_events(id),
    tag_name TEXT NOT NULL,        -- 'app', 'content-type', 'e', 'p', 'd', etc.
    tag_value TEXT NOT NULL,
    tag_index INTEGER NOT NULL,    -- position in the tag array
    PRIMARY KEY (event_id, tag_name, tag_index)
);

CREATE INDEX idx_event_tags_lookup ON event_tags(tag_name, tag_value);
```

This means relay-side filtering on `#app`, `#content-type`, `#board` works correctly. The client-side filtering workarounds become unnecessary.

---

## Event Flow

### Inbound (from external clients or peer relays)

```
Client/Peer → WebSocket EVENT
    → Validate event ID (SHA-256 of serialised event matches id field)
    → Validate Schnorr signature
    → Event acceptance policy check (Equaliser-only / open / hybrid)
    → Deduplication (by event ID — if exists, return OK duplicate)
    → Replaceable event check (see below)
    → Write to raw_events + event_tags (single transaction)
    → Parse into denormalised table (best-effort, if Equaliser-tagged)
    → Log parse errors to event_log (action: 'parse_error') if parsing fails
    → Notify active WebSocket subscriptions
    → Return OK to client
```

**Replaceable events:** For replaceable (Kind 0, 3, 10000-19999) and parameterised replaceable (Kind 30000-39999) events, the relay keeps only the latest version. On receiving a newer event (higher `created_at`, same pubkey+kind or pubkey+kind+d-tag): DELETE old row from `raw_events` (tags cascade via `ON DELETE CASCADE`), INSERT new event, UPDATE denormalised table. If the incoming event is older than the stored one, reject it with OK false. All within a single transaction.

**NIP-09 event deletion:** When a Kind 5 event arrives, the relay deletes the referenced events (listed in `e` tags) from `raw_events`, `event_tags`, and the corresponding denormalised tables. Only the event author can delete their own events (pubkey must match). The Kind 5 event itself is stored so deletion is replayed on peer sync.

**Parse failure handling:** Raw event storage is the source of truth for NOSTR protocol compliance. If denormalised parsing fails (malformed content, unexpected tags), the raw event is still stored and servable via WebSocket subscriptions — it just won't appear in the REST API until the parse issue is resolved. Denormalised tables can be rebuilt from `raw_events` at any time.

### Outbound (from orchestrator publishing)

```
Orchestrator publishes event (track release, profile update)
    → Written to local relay via WebSocket
    → Peer syncer forwards to configured external relays
    → Event available on NOSTR network
```

### User registration

```
Fan authenticates → Orchestrator writes to registered_users
    → Relay detects new registration
    → Subscribes to user's events on peer relays (Kind 0, 3, 30001)
    → Subscribes to feed (Kind 1 from follow list)
    → Data flows in and is parsed into denormalised tables
```

---

## Docker Configuration

```yaml
equaliser-relay:
  build: ./equaliser-relay
  environment:
    - DATABASE_URL=postgresql://equaliser:${DB_PASSWORD}@postgres:5432/equaliser
    - WS_PORT=8080
    - REST_API_PORT=8008
    - RELAY_NAME=Equaliser Relay
    - RELAY_DESCRIPTION=Equaliser content node relay
    - EVENT_POLICY=equaliser_only    # or: open, hybrid
    - PEER_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
    - SYNC_INTERVAL=3600
    - USER_FEED_DAYS=30
    - USER_FEED_LIMIT=500
  depends_on:
    - postgres
  ports:
    - "8080:8080"     # WebSocket (proxied by nginx)
    - "8008:8008"     # REST API (proxied by nginx)
  restart: unless-stopped

postgres:
  image: postgres:15
  environment:
    - POSTGRES_USER=equaliser
    - POSTGRES_PASSWORD=${DB_PASSWORD}
    - POSTGRES_DB=equaliser
  volumes:
    - postgres-data:/var/lib/postgresql/data
```

---

## Language Choice

**Go.** Best fit for a long-lived WebSocket server with concurrent connections. Goroutines handle concurrent peer syncer connections and client subscriptions naturally. Fast compilation, single binary deployment, tiny Docker image, excellent WebSocket (`nhooyr/websocket`) and PostgreSQL (`pgx`) libraries.

Alternatives considered:
- **Rust** — better raw performance but slower development iteration. Overkill for single-node traffic levels.
- **Python (async)** — consistent with orchestrator but lower performance ceiling for concurrent WebSocket handling.

---

## Project Structure

```
content_node/equaliser-relay/
├── Dockerfile
├── go.mod                          # module: equaliser-relay
├── go.sum
├── cmd/
│   └── relay/
│       └── main.go                 # entry point, wires everything up
├── internal/
│   ├── config/
│   │   └── config.go              # env var parsing (DATABASE_URL, ports, limits, etc.)
│   ├── storage/
│   │   ├── postgres.go            # connection pool, migrations
│   │   ├── events.go              # raw_events + event_tags CRUD, replaceable logic, deletion
│   │   └── denorm.go              # denormalised table parsing/upserts
│   ├── relay/
│   │   ├── handler.go             # WebSocket connection handler
│   │   ├── subscription.go        # REQ subscription management
│   │   └── filter.go              # NIP-01 filter matching + SQL query building
│   └── nostr/
│       ├── event.go               # event struct, ID validation, signature verification
│       └── nip01.go               # protocol message parsing (REQ, EVENT, CLOSE, COUNT)
└── migrations/
    └── 001_initial.sql            # full schema (raw_events, event_tags, all denorm + operational tables)
```

Directories added in later phases:
- `internal/api/` — REST API handlers (Phase B.2)
- `internal/syncer/` — peer syncer (Phase B.1)

---

## Environment Variables

```
# Required
DATABASE_URL              # PostgreSQL connection string
WS_PORT=8080              # WebSocket listener port
REST_API_PORT=8008        # REST API listener port

# Relay identity (used by NIP-11 and /api/access/node-info)
RELAY_NAME=Equaliser Relay
RELAY_DESCRIPTION=Equaliser content node relay

# Event policy
EVENT_POLICY=equaliser_only   # equaliser_only | open | hybrid

# Peer syncing (Phase B.1)
PEER_RELAYS=                  # comma-separated WebSocket URLs
SYNC_INTERVAL=3600            # seconds between full syncs

# User caching (Phase B.3)
USER_FEED_DAYS=30             # max age of feed events to cache
USER_FEED_LIMIT=500           # max feed events per user

# Admin (Phase C)
ADMIN_PASSWORD=               # password for /api/admin/* endpoints
```

---

## Migration Path

This doesn't need to be built all at once. A phased approach:

### Phase 1: Core relay + storage
- Build NIP-01 relay in Go with PostgreSQL storage
- Full schema from day one: `raw_events`, `event_tags`, plus denormalised tables (`cached_artists`, `cached_tracks`, `cached_albums`)
- Events parsed into denormalised tables on arrival (best-effort — raw event always stored even if parse fails)
- Event acceptance policy (Equaliser-only / open / hybrid)
- No peer syncing — drop-in replacement for nostr-rs-relay
- Replaces nostr-rs-relay in the Docker stack

### Phase 2: Peer syncing
- Add peer syncer — persistent WebSocket connections to external relays
- Inbound: subscribe to Equaliser-tagged events and registered user data
- Outbound: forward locally published events for federation
- Auto-reconnection with exponential backoff

### Phase 3: REST API + client migration
- Serve REST API at `/api/catalogue/*` for the web client
- Add `catalogue-api.js` client module
- Migrate admin pages and public client reads to REST API
- Orchestrator focuses purely on uploads/drafts/IPFS

### Phase 4: Optimise
- Connection pooling, query optimisation, caching hot paths
- Benchmark and tune for target load

---

## What Stays the Same

- **Orchestrator** — still handles track uploads, HLS encoding, IPFS, draft management, Blossom uploads
- **IPFS** — unchanged
- **Blossom** — unchanged
- **nginx** — routes `/relay` to the new relay's WebSocket port, `/api/artists` etc. to its REST port
- **NOSTR protocol** — fully compatible, any client can connect
- **Database schema** — the denormalised tables are identical to what's already specified
- **Web client** — no changes needed if REST API endpoints stay the same

---

## Design Advantages

- **Full tag indexing** — `#app`, `#content-type`, `#board` filters work natively in relay subscriptions. No client-side filtering workarounds needed.
- **Zero sync lag** — events are parsed into denormalised tables on arrival, in the same transaction as raw storage.
- **Single data path** — every event (local or from peer relays) follows the same path: validate → store → parse → notify. No duplicate data stores.
- **Event acceptance policy** — spam handled at ingestion rather than periodic cleanup scripts.
- **One service** — WebSocket, REST API, peer syncing, and storage in a single process. Simpler to deploy, monitor, and debug.

---

## Migration from nostr-rs-relay

This section covers the practical migration from nostr-rs-relay to the Equaliser Relay — infrastructure changes, data migration, client updates, and rollback strategy. It complements the high-level [Migration Path](#migration-path) above with concrete details.

### Docker Compose Changes

**Before (nostr-rs-relay):**

| Service | Image | Port | Volume |
|---------|-------|------|--------|
| `nostr-relay` | `scsibug/nostr-rs-relay:latest` | 8080 | `nostr-data` (SQLite) |
| `orchestrator` | Custom (FastAPI) | 8000 | `drafts-data` (SQLite) |
| `ipfs` | `ipfs/kubo:latest` | 4001, 5001 | `ipfs-data` |
| `blossom` | `ghcr.io/hzrd149/blossom-server:master` | 3000 | `blossom-data` |
| `web` (nginx) | `nginx:alpine` | 80 | — |

**After (Equaliser Relay):**

| Service | Image | Port | Volume |
|---------|-------|------|--------|
| `equaliser-relay` | Custom (Go) | 8080 (WS), 8008 (REST) | — |
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

The current nostr-rs-relay `config.toml` restricts accepted event kinds via an allowlist. The Equaliser Relay handles this differently — it filters by `["app", "Equaliser"]` tag via its `EVENT_POLICY` setting rather than by kind.

### nginx Routing Changes

**After migration:**

```
/relay                    → equaliser-relay:8080    (WebSocket — unchanged behaviour)
/api/catalogue/*          → equaliser-relay:8008    (public reads, rate limited)
/api/access/*             → equaliser-relay:8008    (public access control, rate limited)
/api/admin/*              → equaliser-relay:8008    (password authenticated)
/api/*                    → orchestrator:8000       (Everything else — uploads, drafts, releases)
/blossom/*                → blossom:3000
/ipfs/*                   → ipfs:8080
/admin/*                  → static files
/                         → static files
```

**Not proxied by nginx:** `/api/internal/*` is only accessible on the Docker internal network. The orchestrator calls `http://equaliser-relay:8008/api/internal/*` directly for user registration, access control validation, etc. This prevents external actors from hitting internal write endpoints.

### Data Migration

#### Option A: Event replay (recommended for production)

Export all events from nostr-rs-relay's SQLite and replay them into the Equaliser Relay via WebSocket:

1. Start Equaliser Relay alongside nostr-rs-relay temporarily
2. Read events from SQLite: `SELECT id, raw_event FROM event ORDER BY created_at`
3. Send each event as `["EVENT", event_json]` to Equaliser Relay's WebSocket
4. Relay validates, deduplicates, stores in PostgreSQL, parses into denormalised tables
5. Verify counts match, then remove nostr-rs-relay

#### Option B: Fresh start (recommended for dev/test)

1. Export artist content as `.eqpkg.zip` packages (backup)
2. Remove nostr-rs-relay and `nostr-data` volume
3. Start Equaliser Relay with fresh PostgreSQL
4. Re-import packages via `import-artist.sh`
5. Re-publish profiles via admin UI

#### Option C: Peer syncer recovery (supplement only)

If events were published to external relays, the peer syncer will re-ingest them automatically. Start Equaliser Relay with `PEER_RELAYS` configured and events flow in. However, local-only events (playlists, DMs) are NOT recoverable this way. Best used alongside Option A, not as a replacement.

### Orchestrator Changes

| Variable | Before | After |
|----------|--------|-------|
| `NOSTR_RELAY_URL` | `ws://nostr-relay:8080` | `ws://equaliser-relay:8080` |

**File:** `content_node/orchestrator/api/services/nostr.py`

The orchestrator's relay interaction code (`publish_event`, `publish_signed_event`, `fetch_track_events`) uses the WebSocket NIP-01 protocol — unchanged, since the Equaliser Relay speaks the same protocol.

**What stays on the orchestrator:**
- Track upload, HLS encoding, IPFS/Blossom storage (`/api/tracks/upload`, `/api/tracks/publish`)
- Cover art upload (`/api/tracks/cover-art`)
- Draft management (`/api/drafts/*`) in SQLite
- Package export/import (`/api/releases/*`)
- User registration (`/api/users/register`) — orchestrator authenticates the fan, then calls relay's `/api/internal/users/register` to record the pubkey

**What moves to the relay:**
- Read-side data serving: artist profiles, track listings, search, user feeds, playlists — all served by the relay's REST API at `/api/catalogue/*`
- Access control: join requests and node info — served by the relay at `/api/access/*` (these read/write `access_requests` and `node_artists` in PostgreSQL)

**No shared database access:** The orchestrator does NOT connect to PostgreSQL directly. The relay is the sole owner of the database. All orchestrator data access goes through the relay's REST API — reads via `/api/catalogue/*`, writes via `/api/internal/*` (Docker network only). This keeps a clean service boundary — one database owner, no shared schema coupling.

### Client Changes — Admin Pages

**Directory:** `content_node/orchestrator/`

| Page | Current | After |
|------|---------|-------|
| `dashboard.html` | WebSocket `{kinds:[0], authors:[pk]}` | `fetch('/api/catalogue/artists/{npub}')` |
| `dashboard.html` | WebSocket `{kinds:[30050], authors:[pk]}` | `fetch('/api/catalogue/artists/{npub}/tracks')` |
| `releases.html` | WebSocket `{kinds:[30050], authors:[pk]}` | `fetch('/api/catalogue/artists/{npub}/tracks')` |
| `profile.html` | Profile fetch via WebSocket | `fetch('/api/catalogue/artists/{npub}')` |

Pages unchanged: `upload.html`, `edit-release.html`, `login.html`, `onboarding.html`, `settings.html` (use orchestrator APIs, not relay).

Migration approach: replace the WebSocket promise wrappers with `fetch()` calls. The REST API returns structured JSON, so client-side tag parsing simplifies to direct property access.

### Client Changes — Public App

**Directory:** `client/`

#### Reads that migrate to REST API

| Page | Current WebSocket query | New REST call |
|------|------------------------|---------------|
| `home.js` | `{kinds:[30050], limit:500}` | `GET /api/catalogue/tracks` |
| `home.js` | `{kinds:[0], authors:pubkeys}` | `GET /api/catalogue/artists` |
| `artist.js` | `{kinds:[0], authors:[pk]}` | `GET /api/catalogue/artists/{npub}` |
| `artist.js` | `{kinds:[30050], authors:[pk]}` | `GET /api/catalogue/artists/{npub}/tracks` |
| `library.js` | `{kinds:[30001], authors:[pk]}` | `GET /api/catalogue/users/{pubkey}/playlists` |

#### WebSocket queries that stay (but benefit from full tag indexing)

| Query | Before | After |
|-------|--------|-------|
| Feed posts | `{kinds:[1], limit:50}` + client-side `app`/`content-type` filter | `{kinds:[1], '#app':['Equaliser'], '#content-type':['post'], limit:50}` |
| Community threads | `{kinds:[1], limit:500}` + client-side filter | `{kinds:[1], '#app':['Equaliser'], '#content-type':['thread'], '#board':['general'], limit:100}` |
| Thread replies | `{kinds:[1], '#e':[id], limit:500}` + client-side `app` filter | `{kinds:[1], '#e':[id], '#app':['Equaliser'], limit:500}` |
| Reactions/DMs/Contacts | No change (already use single-letter tags) |

**Client-side filtering removed:** The broad-fetch-then-filter pattern in `nostr-social.js` becomes unnecessary. Files affected: `js/nostr-social.js`, `js/pages/social.js`, `js/pages/home.js`, `js/pages/thread.js`, `js/pages/user.js`, `js/pages/artist.js`.

**New module `client/js/catalogue-api.js`:** REST API wrapper (`CatalogueAPI.getArtists()`, `.getArtistTracks(npub)`, `.search(query)`, etc.) calling `/api/catalogue/*` for structured data reads.

**Publishing stays the same:** `NostrSocial.publishEvent()` sends signed events via WebSocket. The peer syncer handles federation. Auto-tagging `['app', 'Equaliser']` unchanged.

### Phased Rollout

Aligned with the [Migration Path](#migration-path) phases above, with verification checklists.

**Phase 1 — Drop-in replacement:** Swap nostr-rs-relay for Equaliser Relay. WebSocket on port 8080, same NIP-01 protocol. No client changes. Verify: all admin/client pages load, track upload-publish flow works, social features work, external clients can connect via `/relay`.

**Phase 2 — Peer syncing:** Configure `PEER_RELAYS`. Verify: local events appear on external relays, external events appear locally, reconnection works after network interruption.

**Phase 3 — REST API + client migration:** Relay serves REST API at `/api/catalogue/*` on port 8008. Add nginx route for `/api/catalogue/` prefix. Add `catalogue-api.js` client module. Migrate admin pages and public client reads to REST API. Update WebSocket queries to use multi-char tag filters. Remove client-side filtering workarounds. Verify: REST API returns correct data, performance improvement measurable.

**Phase 4 — Optimise:** Connection pooling, query optimisation, persistent WebSocket connections, cache hot paths. Benchmark and tune.

### Rollback Strategy

- Keep nostr-rs-relay Docker image reference in a comment for quick rollback
- PostgreSQL events can be exported and replayed to nostr-rs-relay if needed
- Client REST API wrapper (`catalogue-api.js`) can fall back to WebSocket queries if REST API is unavailable
- Phase 1 is fully reversible — just swap the Docker Compose service back

---

## Testing & Verification

Three layers of testing, each building confidence that the relay is a valid drop-in replacement.

### A) Go Unit Tests

Run during build (`go test ./...`). Cover the core relay logic without requiring the full Docker stack.

- **Event parsing:** Validate event ID (SHA-256 of serialised event), verify Schnorr signature, reject malformed events
- **Replaceable event logic:** Higher `created_at` wins for same pubkey+kind (Kind 0/3/10000-19999), same pubkey+kind+d-tag (Kind 30000-39999). Older events rejected.
- **NIP-01 filter matching:** Filter by kinds, authors, IDs, tags (including multi-char), since/until, limit. Verify SQL query generation.
- **NIP-09 deletion:** Kind 5 events delete referenced events. Only author can delete own events.
- **NIP-45 COUNT:** Returns correct counts for filters.
- **Denormalised parsing:** Kind 0 → `cached_artists`, Kind 30050 → `cached_tracks`, Kind 30051 → `cached_albums`. Parse failure doesn't block raw storage.
- **Event acceptance policy:** Equaliser-tagged events accepted in all modes. Untagged events accepted/rejected per policy.
- Use `testcontainers-go` for PostgreSQL — real database, no mocks.

### B) Integration Test Script

Run after `start-node.sh` with the relay running in Docker. Exercises the WebSocket protocol end-to-end.

- Send events via WebSocket, query them back via `REQ`, verify responses match
- Test replaceable event replacement (send older then newer Kind 0, verify only newest returned)
- Test NIP-09 deletion (send event, send Kind 5, verify event gone)
- Test deduplication (send same event twice, verify single storage)
- Test event acceptance policy (send untagged event, verify behaviour per `EVENT_POLICY`)
- Test multi-char tag filtering (`#app`, `#content-type`, `#board` in `REQ` filters)
- Verify denormalised tables populated correctly (query PostgreSQL via `docker exec`)
- Test NIP-11 (HTTP GET to relay URL with correct Accept header)
- Test NIP-45 COUNT responses

### C) Drop-in Smoke Test

The definitive verification that the relay is a valid replacement for nostr-rs-relay.

1. Reset node, import test data with current nostr-rs-relay (`reset-node.sh --force`, `import-artist.sh`)
2. Note event counts and verify all UI flows work (baseline)
3. Swap to Equaliser Relay, replay events from nostr-rs-relay SQLite export
4. Run through every UI flow:
   - **Onboarding:** Key generation, backup, profile setup, relay publish
   - **Profile:** Edit, save, verify profile loads on dashboard
   - **Upload:** Track upload, HLS encoding, draft creation
   - **Release:** Publish draft to relay, verify on releases page
   - **Dashboard:** Artist profile, track list, stats
   - **Social:** Feed posts, thread replies, reactions, DMs
   - **Client app:** Home page, artist pages, track playback
5. Verify event counts match between old and new relay
6. Verify external NOSTR clients can connect via `/relay` WebSocket

---

## References

- [DATABASE.md](DATABASE.md) — Full database schema (raw events, tags, denormalised tables, operational tables)
- [CONTENT_NODE.md](CONTENT_NODE.md) — Content node architecture
- [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) — Node management specification
- [Primal Caching Server](https://github.com/PrimalHQ/primal-server) — Similar architecture (custom relay as cache)
- [strfry](https://github.com/hoytech/strfry) — High-performance C++ relay (reference for design)
- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) — Basic NOSTR protocol
