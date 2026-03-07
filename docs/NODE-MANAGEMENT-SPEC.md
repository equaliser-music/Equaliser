# Equaliser: Node Management, Equaliser Relay & Access Control

**Date:** March 2026
**Status:** Implementation Specification
**Context:** Extends the content node architecture with the Equaliser Relay, node administration, and gated artist access

---

## 1. Overview

The content node currently operates as an open system — anyone can access the onboarding page and publish to the local relay. This specification introduces:

1. **Equaliser Relay** — A custom NOSTR relay (Go) combining NIP-01 WebSocket protocol, built-in peer syncer, PostgreSQL storage with full tag indexing, and REST API for web client reads
2. **Cache API** — REST endpoints on the Equaliser Relay at `/api/catalogue/*` serving cached data to the web client for fast, predictable responses
3. **Node Management Console** — Admin dashboard for monitoring and controlling node operations
4. **Access Control** — Gated onboarding requiring admin approval before artists can use the node

These components support the evolution from single-artist nodes to multi-tenant hosting where node operators can provide managed infrastructure to artists.

---

## 2. Equaliser Relay

### 2.1 Purpose

A custom NOSTR relay purpose-built for Equaliser. Externally, it speaks standard NIP-01 WebSocket protocol — any NOSTR client can connect. Internally, it uses PostgreSQL with full tag indexing, denormalised schemas for fast queries, a built-in peer syncer for external relay subscriptions, and a REST API for the web client.

This replaces nostr-rs-relay in the Docker stack, adding PostgreSQL storage, full tag indexing, and a four-tier REST API: `/api/catalogue/*` (public reads), `/api/access/*` (public access control), `/api/internal/*` (orchestrator-to-relay, Docker network only), and `/api/admin/*` (password authenticated) — all proxied by nginx except `/api/internal/*`. The relay is the sole owner of PostgreSQL — the orchestrator accesses all data through the relay's REST API. See [EQUALISER_RELAY.md](EQUALISER_RELAY.md) for the full specification.

### 2.2 Architecture

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

### 2.3 Behaviour

**Subscriptions (built-in peer syncer):**
- Maintains persistent WebSocket connections to configured external relays
- Subscribes to Equaliser events: `{"kinds": [0, 30050, 30051, 30052, 30053], "#app": ["Equaliser"]}`
- Subscribes to Kind 10002 (relay list) events from known artist pubkeys to discover new relays organically
- Subscribes to registered fan/listener pubkeys for user data caching (Kind 0, 3, 30001) — see [EQUALISER_RELAY.md](EQUALISER_RELAY.md) for details on user subscriptions, feed thresholds, and artist auto-discovery from follow lists

**Event Processing:**
- Validates event signatures before writing
- For replaceable events (Kind 0, parameterised replaceable 30000+ range), applies highest `created_at` wins rule
- Deduplicates by event ID across relays
- Events written to raw storage AND parsed into denormalised tables in a single transaction — no sync lag

**Event Acceptance Policy:**
- Events with `["app", "Equaliser"]` tag → stored in optimised schema + raw event table
- Events without the tag → configurable per-node: `equaliser_only` (reject), `open` (accept to raw-only), or `hybrid`
- Replaces the cleanup-relay.sh approach — filtering happens at ingestion

**Resilience:**
- Automatic reconnection with exponential backoff on disconnection
- On reconnect, performs catch-up query using `since:` filter from last known event timestamp for that relay
- Periodic full sync (configurable, default every 60 minutes) as safety net
- Logs connection status, event counts, and errors for the management console

**Relay List Management:**
- Initial relay list configured via `PEER_RELAYS` environment variable
- Watches for Kind 10002 events from indexed artists and adds new relays automatically
- Admin can add/remove relays via the management console
- Each relay tracked with: URL, connection status, last event timestamp, event count, error count

**Outbound Publishing:**
- When the orchestrator publishes an event to the local relay, the peer syncer forwards it to configured external relays for federation

### 2.4 Docker Compose Addition

```yaml
equaliser-relay:
  build: ./equaliser-relay
  environment:
    - DATABASE_URL=postgresql://equaliser:${DB_PASSWORD}@postgres:5432/equaliser
    - PEER_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
    - SYNC_INTERVAL=3600
    - USER_FEED_DAYS=30
    - USER_FEED_LIMIT=500
    - EVENT_POLICY=equaliser_only
    - REST_API_PORT=8008
    - WS_PORT=8080
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

## 3. Cache Database Schema

### 3.1 Core Tables

```sql
-- Cached artist profiles (Kind 0)
CREATE TABLE cached_artists (
    pubkey TEXT PRIMARY KEY,
    display_name TEXT,
    about TEXT,
    picture_url TEXT,
    banner_url TEXT,
    website TEXT,
    nip05 TEXT,
    lud16 TEXT,
    equaliser_metadata JSONB,  -- genres, location, etc.
    raw_event JSONB NOT NULL,
    event_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cached tracks (Kind 30050)
CREATE TABLE cached_tracks (
    event_id TEXT PRIMARY KEY,
    artist_pubkey TEXT NOT NULL,            -- no FK: tracks may arrive before artist profile
    d_tag TEXT NOT NULL,
    title TEXT,
    album TEXT,
    genre TEXT,
    duration INTEGER,
    price_sats INTEGER,
    ipfs_manifest_cid TEXT,
    ipfs_preview_cid TEXT,
    cover_art_cid TEXT,
    release_date TEXT,
    raw_event JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(artist_pubkey, d_tag)
);

-- Cached albums (Kind 30051)
CREATE TABLE cached_albums (
    event_id TEXT PRIMARY KEY,
    artist_pubkey TEXT NOT NULL,            -- no FK: albums may arrive before artist profile
    d_tag TEXT NOT NULL,
    title TEXT,
    cover_art_cid TEXT,
    raw_event JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(artist_pubkey, d_tag)
);

-- Peer relay tracking
CREATE TABLE peer_relays (
    url TEXT PRIMARY KEY,
    status TEXT DEFAULT 'disconnected',  -- connected, disconnected, error
    last_event_at BIGINT,
    last_connected_at TIMESTAMPTZ,
    last_error TEXT,
    event_count BIGINT DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    auto_discovered BOOLEAN DEFAULT FALSE,
    enabled BOOLEAN DEFAULT TRUE,
    added_at TIMESTAMPTZ DEFAULT NOW()
);

-- Event log for debugging and monitoring
CREATE TABLE event_log (
    id SERIAL PRIMARY KEY,
    relay_url TEXT NOT NULL,
    event_kind INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    action TEXT NOT NULL,  -- inserted, updated, duplicate, invalid
    logged_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.2 User Cache Tables

Fan/listener data cached by the Equaliser Relay when users authenticate through the node. This is purely metadata caching (profiles, follows, playlists, feeds) — distinct from file hosting. See [DATABASE.md](DATABASE.md) for full schema.

- `registered_users` — pubkeys that have authenticated (orchestrator calls relay API to register, relay owns the table)
- `cached_users` — parsed fan profiles (Kind 0)
- `cached_user_follows` — follow list per user (Kind 3)
- `cached_user_feed` — notes from followed pubkeys (Kind 1), subject to feed thresholds
- `cached_user_playlists` — Equaliser playlists (Kind 30001)

---

## 4. Relay API Endpoints

The relay serves four tiers of REST endpoints with different access controls:

### 4.1 Public Endpoints — `/api/catalogue/*` (proxied by nginx, rate limited, same-origin CORS)

Read-only endpoints for this node's own client. The catalogue API is a performance cache for the local client — not a public API for other nodes or third-party clients. Each node builds its own cache from NOSTR events; other nodes should use the WebSocket relay for data access. nginx enforces same-origin CORS (`Access-Control-Allow-Origin` set to the node's own domain) and rate limiting.

```
GET /api/catalogue/artists
  - Returns list of all cached artists
  - Query params: ?genre=Electronic&limit=20&offset=0
  - Response: array of artist profiles with track counts

GET /api/catalogue/artists/{npub}
  - Returns single artist profile with full metadata
  - Response: artist profile + track listing

GET /api/catalogue/artists/{npub}/tracks
  - Returns all tracks for an artist
  - Query params: ?album=&sort=newest&limit=50
  - Response: array of track metadata

GET /api/catalogue/tracks/{event_id}
  - Returns single track metadata
  - Response: track metadata with artist info

GET /api/catalogue/tracks
  - Returns tracks across all artists
  - Query params: ?genre=&sort=newest&limit=50
  - Response: array of track metadata with artist info

GET /api/catalogue/search
  - Search across artists and tracks
  - Query params: ?q=search+term&type=artist|track|all
  - Response: matched artists and tracks

GET /api/catalogue/users/me?pubkey={hex}
  - Cached profile for authenticated user

GET /api/catalogue/users/{pubkey}/feed?limit=50&offset=0
  - Cached feed events from followed pubkeys

GET /api/catalogue/users/{pubkey}/playlists
  - User's cached Equaliser playlists (Kind 30001)
```

### 4.2 Internal Endpoints — `/api/internal/*` (Docker network only, NOT proxied by nginx)

Orchestrator-to-relay calls. Only reachable on the Docker internal network — nginx never routes these paths, so they are not accessible from the public internet. The orchestrator calls `http://equaliser-relay:8008/api/internal/*` directly.

```
POST /api/internal/users/register
  - Register authenticated fan pubkey for data caching
  - Body: {"pubkey": "hex..."}
  - Called by orchestrator after fan authenticates via NIP-07/NIP-46

POST /api/internal/access/validate
  - Validate an invite code
  - Body: {"code": "EQ-a8f3b2c1"}
  - Called by orchestrator during onboarding flow

POST /api/internal/access/onboard
  - Record successful artist onboarding
  - Body: {"pubkey": "hex...", "artist_name": "...", "invite_code": "EQ-..."}
  - Called by orchestrator after onboarding completes

GET  /api/internal/access/check?pubkey={hex}
  - Check if pubkey is approved on this node
  - Called by orchestrator to gate access
```

### 4.3 Admin Endpoints — `/api/admin/*` (password authenticated via `ADMIN_PASSWORD`)

Node management endpoints for the admin console. Proxied by nginx, authenticated via `ADMIN_PASSWORD` env var.

```
GET  /api/admin/sync/status         - Relay status, peer connections, event counts
GET  /api/admin/sync/relays         - List all tracked relays with status
POST /api/admin/sync/relays         - Add a relay to the sync list
DELETE /api/admin/sync/relays/{url} - Remove a relay
POST /api/admin/sync/force          - Trigger a full resync
GET  /api/admin/sync/log            - Recent sync activity log

GET    /api/admin/users                    - List all registered users with cache stats
GET    /api/admin/users/{pubkey}           - View single user's cached data summary
PUT    /api/admin/users/{pubkey}           - Enable/disable syncing for a user
DELETE /api/admin/users/{pubkey}           - Deregister user and purge cached data
POST   /api/admin/users/{pubkey}/resync    - Force resync user data
PUT    /api/admin/settings/user-cache      - Update global user cache settings
```

---

## 5. Access Control & Gated Onboarding

### 5.1 Purpose

Close the currently open onboarding flow. Artists must request access and be approved by the node admin before they can onboard and use the node.

### 5.2 Artist Request Flow

```
Artist visits node portal
        │
        ▼
┌─────────────────┐
│  Public Request  │  No authentication needed
│  Form           │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Request stored  │  Status: pending
│  in database     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Admin reviews   │  Via management console
│  in queue        │
└────────┬────────┘
         │
    ┌────┴─────┐
    ▼          ▼
┌────────┐ ┌────────┐
│Approved│ │Declined│
└───┬────┘ └───┬────┘
    │          │
    ▼          ▼
 Invite     Notification
 code       (optional)
 generated
    │
    ▼
 Artist uses code
 to access onboarding
```

### 5.3 Database Tables

```sql
-- Artist access requests
CREATE TABLE access_requests (
    id SERIAL PRIMARY KEY,
    artist_name TEXT NOT NULL,
    email TEXT,
    npub TEXT,                        -- If they already have a NOSTR identity
    description TEXT,                 -- What they do, why they want to join
    links TEXT,                       -- Existing music links, social profiles
    status TEXT DEFAULT 'pending',    -- pending, approved, declined
    admin_notes TEXT,                 -- Internal notes from admin
    invite_code TEXT UNIQUE,          -- Generated on approval
    invite_used BOOLEAN DEFAULT FALSE,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
);

-- Node artists (approved and onboarded)
CREATE TABLE node_artists (
    pubkey TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    request_id INTEGER REFERENCES access_requests(id),
    fee_model TEXT DEFAULT 'free',    -- free, percentage, flat_rate
    fee_value NUMERIC DEFAULT 0,      -- percentage (e.g. 5.0) or sats amount
    status TEXT DEFAULT 'active',     -- active, suspended, migrated
    onboarded_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 5.4 Request Form Page

A new public page at `/join`. No NOSTR keys or authentication needed — this is a public-facing request form.

#### Fields

| Field | Required | Description |
|-------|----------|-------------|
| Artist/project name | Yes | Name of the artist or project |
| Description | Yes | Brief description of their music |
| Links | No (encouraged) | Existing work — Bandcamp, SoundCloud, YouTube, personal site |
| Email | No | For notification when request is reviewed |
| Existing npub | No | If they already have a NOSTR identity |

On submission, the form posts to `POST /api/access/request` (served by the Equaliser Relay, proxied by nginx) and displays a confirmation message explaining that the node admin will review their request.

### 5.5 Invite Code Flow

On approval, the system generates a unique invite code (e.g. `EQ-a8f3b2c1`). The admin can share this with the artist however they choose — email, DM, etc.

The existing onboarding page (`/admin/onboarding.html`) is modified to require an invite code at the start. The orchestrator validates the code by calling `POST /api/internal/access/validate` on the relay (Docker network only, not publicly accessible). If valid, the artist proceeds through the existing onboarding flow (key generation, backup download, profile setup, relay publishing). On successful onboarding, the orchestrator calls `POST /api/internal/access/onboard` to mark the invite as used and add the artist to `node_artists`.

### 5.6 Node Info

The public endpoint `GET /api/access/node-info` (served by the Equaliser Relay, proxied by nginx) returns basic information about the node:

- Node name and description
- Number of hosted artists
- Fee model (if applicable)

This allows prospective artists to understand what the node offers before requesting access.

### 5.7 Integration with Existing Onboarding

The access control system wraps the existing onboarding flow:

1. **Before access control:** Artist visits `/admin/onboarding.html` and proceeds directly to key generation
2. **With access control:** Artist visits `/join`, submits request, receives invite code, enters code at `/admin/onboarding.html`, then proceeds to key generation

The existing onboarding steps (key generation, backup download, profile setup, relay publishing) remain unchanged. See [ONBOARDING.md](implemented/ONBOARDING.md) for the full onboarding flow.

### 5.8 API Endpoints

All access control endpoints are served by the Equaliser Relay (which owns the PostgreSQL `access_requests` and `node_artists` tables). The orchestrator calls the internal endpoints during the onboarding flow.

```
# Public — served by relay (proxied by nginx, rate limited)
POST /api/access/request            - Submit a join request
GET  /api/access/node-info          - Public node info (name, description, hosted artist count, fee model)

# Internal (Docker network only, NOT proxied by nginx)
POST /api/internal/access/validate  - Validate an invite code (called by orchestrator during onboarding)
POST /api/internal/access/onboard   - Record successful onboarding (called by orchestrator)
GET  /api/internal/access/check     - Check if pubkey is approved (called by orchestrator)

# Admin (password authenticated)
GET    /api/admin/requests           - List all access requests (filterable by status)
GET    /api/admin/requests/{id}      - View single request
POST   /api/admin/requests/{id}/approve  - Approve request, generates invite code
POST   /api/admin/requests/{id}/decline  - Decline request with optional reason
GET    /api/admin/artists            - List all onboarded artists on this node
PUT    /api/admin/artists/{pubkey}   - Update artist settings (fee model, status)
DELETE /api/admin/artists/{pubkey}   - Remove artist from node
```

---

## 6. Node Management Console

### 6.1 Purpose

Web-based admin dashboard for node operators to monitor and control all node operations. Served from `/admin/console` (distinct from artist admin pages at `/admin`).

### 6.2 Dashboard Sections

**Overview**
- Node status: all services health (IPFS, Equaliser Relay, orchestrator, postgres)
- Quick stats: hosted artists count, total tracks, total storage used
- Recent activity: latest requests, new events synced, errors

**Sync Manager**
- Relay list with live connection status (connected/disconnected/error)
- Per-relay stats: event count, last event time, error count
- Controls: add relay, remove relay, enable/disable relay, force resync
- Sync log: recent event activity with kind, source relay, action taken
- See [EQUALISER_RELAY.md](EQUALISER_RELAY.md) for the relay's peer syncer architecture and configuration

**Artist Management**
- Pending access requests queue with approve/decline actions (see Section 5 above)
- Onboarded artists list with status, track count, storage usage
- Per-artist detail: fee model, published events, IPFS storage used
- Invite code management: active codes, generate manual codes

**User Management**

Manage fan/listener data caching. User caching is purely metadata — NOSTR event data (profiles, follow lists, playlists, feeds). This is distinct from file hosting (IPFS/Blossom) which consumes real storage.

- **Global toggle** — enable/disable user caching entirely if the node is resource-constrained
- **Registered users list** — all authenticated pubkeys with last seen time, event counts, cache size
- **Per-user enable/disable** — suspend syncing for individual users without removing their registration
- **Feed threshold settings** — configure global time window (days) and event count cap
- **Force resync** — trigger an immediate full resync for a specific user
- **Remove user** — deregister a pubkey and purge their cached data
- See [EQUALISER_RELAY.md](EQUALISER_RELAY.md) for how user subscriptions work and [DATABASE.md](DATABASE.md) for user cache tables

**IPFS & Storage**
- Local IPFS node stats: storage used, peer count, pin count
- Cluster requests — outbound: CIDs requested for pinning on other nodes, status per node
- Cluster requests — inbound: requests from other nodes to pin content, approve/decline
- Storage breakdown by artist

**Blossom Mirroring**
- Configured Blossom servers with sync status
- Per-server: last sync, content count, error status
- Mirroring policy config: all content, own artists only, by play count threshold
- Manual mirror trigger

**Node Settings**
- Node identity: name, description, public-facing info
- Fee model defaults for new artists
- Equaliser Relay configuration
- Backup and export tools

### 6.3 Authentication

The management console requires admin authentication — separate from artist session management. For MVP this can be a simple password or API key set via environment variable (`ADMIN_PASSWORD`). The admin authenticates and receives a session token or JWT for subsequent requests.

All `/api/admin/*` endpoints require this authentication.

### 6.4 Tech Stack

- React SPA served as static files from `/admin/console`
- Communicates with `/api/admin/*` endpoints
- WebSocket connection to Equaliser Relay for real-time status updates (peer relay connections, incoming events)
- Consistent with existing admin pages (profile editor, settings) in style

---

## 7. IPFS Cluster & Blossom Integration

### 7.1 IPFS Cluster Requests

Node operators can request other Equaliser nodes to pin their content for redundancy, and receive similar requests from others.

**Outbound (requesting pins):**
- Admin selects content (by artist, album, or individual tracks) to request pinning
- System sends pin request to target nodes via their API
- Tracks pin status: requested, accepted, pinned, declined, failed

**Inbound (receiving requests):**
- Other nodes request this node to pin their content
- Requests appear in management console for review
- Admin can approve (auto-pin the CIDs) or decline
- Can set auto-approve policies: always approve from known nodes, approve under storage threshold

**Database:**

```sql
CREATE TABLE cluster_pin_requests (
    id SERIAL PRIMARY KEY,
    direction TEXT NOT NULL,           -- inbound, outbound
    remote_node_url TEXT NOT NULL,
    cid TEXT NOT NULL,
    artist_pubkey TEXT,
    content_type TEXT,                 -- track, album, cover_art
    status TEXT DEFAULT 'pending',     -- pending, accepted, pinned, declined, failed
    storage_bytes BIGINT,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
```

### 7.2 Blossom Mirroring

Blossom provides fast HTTP-based content serving as a complement to IPFS. Content is mirrored to configured Blossom servers for performance.

**Configuration:**

```sql
CREATE TABLE blossom_servers (
    url TEXT PRIMARY KEY,
    enabled BOOLEAN DEFAULT TRUE,
    auth_token TEXT,
    mirror_policy TEXT DEFAULT 'all',  -- all, own_artists, manual
    last_sync_at TIMESTAMPTZ,
    synced_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    added_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE blossom_mirrors (
    id SERIAL PRIMARY KEY,
    blossom_url TEXT REFERENCES blossom_servers(url),
    ipfs_cid TEXT NOT NULL,
    blossom_hash TEXT,                -- Blossom's content hash
    content_type TEXT,
    status TEXT DEFAULT 'pending',    -- pending, synced, failed
    mirrored_at TIMESTAMPTZ,
    UNIQUE(blossom_url, ipfs_cid)
);
```

---

## 8. Multi-Tenant Hosting Model

### 8.1 Fee Models

Node operators can configure how they charge hosted artists:

| Model | Description | Example |
|-------|-------------|---------|
| `free` | No charge, community/grant-funded | Community nodes |
| `percentage` | Percentage of streaming revenue | 5-10% of each payment |
| `flat_rate` | Fixed monthly fee in sats | 5,000 sats/month |

Fee model is set per-artist in `node_artists` table, with a node-wide default in settings.

### 8.2 Payment Splits

When a Strike webhook confirms payment for a stream on a hosted artist's content:

1. Orchestrator looks up the artist in `node_artists`
2. If `fee_model` is `percentage`, calculates the split
3. Artist portion forwarded to artist's Strike/Lightning address
4. Operator portion held or forwarded to operator's address
5. Both amounts logged for transparency

This is a future implementation — for MVP, the fee model is recorded but payment splits are not yet automated.

### 8.3 Artist Portability

Critical design principle: artists can always leave. Since their identity is their NOSTR keypair and content is on IPFS with publicly known CIDs, migration means:

1. Artist stands up own node or joins another node
2. Republishes their Kind 0 and Kind 30050 events (already signed with their keys)
3. New node pins their IPFS content
4. Old node can optionally unpin to free storage

The tooling should make this exit path explicit — a "migrate" or "export" option in the artist admin panel that packages everything needed. See [ARTIST_PACKAGE.md](ARTIST_PACKAGE.md) for the existing export format.

---

## 9. Implementation Priority

### Phase A: Access Control

**Goal:** Close the open onboarding door.

**Depends on Phase B.0** — the access control endpoints (`/api/access/*`, `/api/internal/access/*`, `/api/admin/requests/*`) are served by the Equaliser Relay, which owns the PostgreSQL tables. Build the core relay first, then add access control.

1. Add `access_requests` and `node_artists` tables to PostgreSQL schema (created as part of Phase B.0)
2. Add access control endpoints to the relay: `POST /api/access/request`, `GET /api/access/node-info`, internal validation/onboarding, admin approval
3. Create access request form page at `/join`
4. Modify onboarding page to require invite code (orchestrator calls relay's `/api/internal/access/validate`)
5. Create minimal admin page to view and approve/decline requests

### Phase B: Equaliser Relay

**Goal:** Fast, reliable data for the web client via a purpose-built custom relay.

**Language:** Go. Best fit for concurrent WebSocket connections (goroutines), single binary deployment, excellent PostgreSQL (`pgx`) and WebSocket (`nhooyr/websocket`) libraries.

**Phase B.0 — Core relay (drop-in replacement):**
1. Set up PostgreSQL as a new service in Docker Compose
2. Create full database schema from day one: `raw_events` + `event_tags` + denormalised cache tables (`cached_artists`, `cached_tracks`, `cached_albums`)
3. Build NIP-01 WebSocket relay with PostgreSQL backend and full tag indexing
4. Events parsed into denormalised tables on arrival (best-effort — raw event always stored even if parse fails, failures logged to `event_log`)
5. No FK constraints on denormalised tables — tracks/albums may arrive before artist profiles
6. Deploy as drop-in replacement for nostr-rs-relay (no peer syncing, no REST API yet)
7. Relay is sole owner of PostgreSQL — orchestrator does NOT connect directly

**Phase B.1 — Peer syncing:**
8. Add peer syncer — persistent WebSocket connections to configured external relays
9. Inbound subscriptions + outbound publishing for federation

**Phase B.2 — REST API + client migration:**
10. Serve REST API at `/api/catalogue/*` on port 8008
11. Add nginx route for `/api/catalogue/` → relay
12. Add `catalogue-api.js` client module
13. Migrate admin pages and public client reads to REST API

See [EQUALISER_RELAY.md](EQUALISER_RELAY.md) for the full relay specification and migration path.

### Phase B.3: User Cache Integration

**Goal:** Cache fan/listener data for fast client reads.

1. Add user cache tables to PostgreSQL schema
2. Add user subscription logic to Equaliser Relay's peer syncer (Kind 0, 3, 30001, feed Kind 1)
3. Implement `POST /api/internal/users/register` endpoint on the relay (Docker network only, called by orchestrator when a fan authenticates)
4. User data read endpoints served by relay's REST API at `/api/catalogue/users/*`
5. Add user management controls to admin console

### Phase C: Node Management Console

**Goal:** Admin visibility and control.

1. Build React dashboard shell at `/admin/console`
2. Implement admin authentication
3. Dashboard: node health overview
4. Sync manager: relay status and controls
5. Artist management: request queue, artist list
6. IPFS storage overview

### Phase D: Cluster & Blossom

**Goal:** Content redundancy and fast serving.

1. IPFS cluster pin request workflow
2. Blossom server configuration and mirroring
3. Storage management and policies

### Phase E: Multi-Tenant Hosting

**Goal:** Fee models and payment splits.

1. Fee model configuration in management console
2. Payment split logic in orchestrator
3. Artist portability / export tooling
4. Public node directory listing

---

## 10. Documents to Create or Update

| Document | Action | Description |
|----------|--------|-------------|
| `CONTENT_NODE.md` | **Update** | Add Equaliser Relay and postgres services to architecture, services table, Docker Compose, and URL routing. Add `/join` and `/admin/console` routes. |
| `equaliser-technical-specification.md` | **Update** | Add Section 4.6 (Equaliser Relay), Section 4.7 (Cache API), Section 4.8 (Node Management Console), Section 4.9 (Access Control). Update architecture diagram. |
| `equaliser-node-setup-notes.md` | **Update** | Add Equaliser Relay container setup, PostgreSQL setup, and environment variables. Update Docker Compose examples. |
| `EQUALISER_RELAY.md` | **Exists** | Full specification for the custom relay. Authoritative source for relay architecture. |
| ~~`NODE_ADMIN.md`~~ | **Merged** | Node management console documentation folded into this spec (Section 6). |
| ~~`ACCESS_CONTROL.md`~~ | **Merged** | Access control documentation folded into this spec (Sections 5, 8). |
| `DATABASE.md` | **Create** | Full database schema reference covering cache tables, access control tables, cluster/blossom tables, and node configuration. |
| `equaliser-domain-mapping-notes.md` | **Update** | Add routes for `/join`, `/admin/console`, and any new API paths to reverse proxy configuration. |

---

## References

- [Primal Caching Server](https://github.com/PrimalHQ/primal-server) — Reference architecture for relay syncing and cached API
- [Equaliser Technical Specification](./equaliser-technical-specification.md) — Core platform specification
- [Equaliser Content Node](./CONTENT_NODE.md) — Current content node documentation
- [Equaliser Node Setup Notes](./equaliser-node-setup-notes.md) — Docker and relay setup notes
- [NOSTR Protocol NIPs](https://github.com/nostr-protocol/nips) — NIP-01, NIP-05, NIP-44, NIP-65 (Kind 10002)
