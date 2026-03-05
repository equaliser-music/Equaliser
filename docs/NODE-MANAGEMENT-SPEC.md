# Equaliser: Node Management, Relay Syncing & Access Control

**Date:** March 2026  
**Status:** Implementation Specification  
**Context:** Extends the content node architecture with relay syncing, cached API, node administration, and gated artist access

---

## 1. Overview

The content node currently operates as an open system — anyone can access the onboarding page and publish to the local relay. This specification introduces:

1. **Relay Syncer** — A background process that subscribes to external NOSTR relays and builds a local cache of Equaliser events
2. **Cache API** — FastAPI endpoints serving cached data to the web client for fast, predictable responses
3. **Node Management Console** — Admin dashboard for monitoring and controlling node operations
4. **Access Control** — Gated onboarding requiring admin approval before artists can use the node

These components support the evolution from single-artist nodes to multi-tenant hosting where node operators can provide managed infrastructure to artists.

---

## 2. Relay Syncer

### 2.1 Purpose

A standalone async Python process that maintains persistent WebSocket connections to a configurable list of NOSTR relays, ingests Equaliser-tagged events, and writes them to a shared PostgreSQL database. This follows the same architectural pattern as Primal's caching server — background ingestion with a separate read API.

### 2.2 Architecture

The syncer runs as its own Docker container (`relay-syncer`) alongside the existing stack. It shares the PostgreSQL database with the FastAPI orchestrator but operates independently — either can be restarted without affecting the other.

```
┌─────────────────────────────────────────────────┐
│              Docker Compose Stack                │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  IPFS    │  │  NOSTR   │  │ Orchestrator │  │
│  │  (kubo)  │  │  Relay   │  │  (FastAPI)   │  │
│  └──────────┘  └──────────┘  └──────┬───────┘  │
│                                      │ reads    │
│  ┌──────────────┐  ┌────────────────┴───────┐  │
│  │ Relay Syncer │  │     PostgreSQL         │  │
│  │  (Python)    ├──┤  (shared database)     │  │
│  │              │  │                        │  │
│  └──────────────┘  └────────────────────────┘  │
│        │ writes                                  │
│        │                                         │
└────────┼─────────────────────────────────────────┘
         │ WebSocket subscriptions
         ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  Local   │  │  Damus   │  │  nos.lol │
   │  Relay   │  │  Relay   │  │  Relay   │  ...
   └──────────┘  └──────────┘  └──────────┘
```

### 2.3 Behaviour

**Subscriptions:**
- Connects to each relay in its configured list
- Subscribes to Equaliser events: `{"kinds": [0, 30050, 30051, 30052, 30053], "#app": ["Equaliser"]}`
- Also subscribes to Kind 10002 (relay list) events from known artist pubkeys to discover new relays organically

**Event Processing:**
- Validates event signatures before writing to cache
- For replaceable events (Kind 0, parameterised replaceable 30000+ range), applies highest `created_at` wins rule
- Deduplicates by event ID across relays

**Resilience:**
- Automatic reconnection with exponential backoff on disconnection
- On reconnect, performs catch-up query using `since:` filter from last known event timestamp for that relay
- Periodic full sync (configurable, default every 60 minutes) as safety net
- Logs connection status, event counts, and errors for the management console

**Relay List Management:**
- Initial relay list configured via environment variable or config file
- Syncer watches for Kind 10002 events from indexed artists and adds new relays automatically
- Admin can add/remove relays via the management console
- Each relay tracked with: URL, connection status, last event timestamp, event count, error count

### 2.4 Docker Compose Addition

```yaml
  relay-syncer:
    build: ./relay-syncer
    environment:
      - DATABASE_URL=postgresql://equaliser:${DB_PASSWORD}@postgres:5432/equaliser
      - RELAY_LIST=ws://nostr-relay:8008,wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
      - SYNC_INTERVAL=3600
    depends_on:
      - postgres
      - nostr-relay
    restart: unless-stopped

  postgres:
    image: postgres:15
    environment:
      - POSTGRES_USER=equaliser
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=equaliser
    volumes:
      - postgres-data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
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
    artist_pubkey TEXT NOT NULL REFERENCES cached_artists(pubkey),
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
    artist_pubkey TEXT NOT NULL REFERENCES cached_artists(pubkey),
    d_tag TEXT NOT NULL,
    title TEXT,
    cover_art_cid TEXT,
    raw_event JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(artist_pubkey, d_tag)
);

-- Relay tracking
CREATE TABLE syncer_relays (
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

-- Sync log for debugging and monitoring
CREATE TABLE sync_log (
    id SERIAL PRIMARY KEY,
    relay_url TEXT NOT NULL,
    event_kind INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    action TEXT NOT NULL,  -- inserted, updated, duplicate, invalid
    logged_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 4. Cache API Endpoints

### 4.1 Public Endpoints (for web client)

These are added to the existing FastAPI orchestrator, reading from the cache database.

```
GET /api/artists
  - Returns list of all cached artists
  - Query params: ?genre=Electronic&limit=20&offset=0
  - Response: array of artist profiles with track counts

GET /api/artists/{npub}
  - Returns single artist profile with full metadata
  - Response: artist profile + track listing

GET /api/artists/{npub}/tracks
  - Returns all tracks for an artist
  - Query params: ?album=&sort=newest&limit=50
  - Response: array of track metadata

GET /api/tracks/{event_id}
  - Returns single track metadata
  - Response: track metadata with artist info

GET /api/tracks
  - Returns tracks across all artists
  - Query params: ?genre=&sort=newest&limit=50
  - Response: array of track metadata with artist info

GET /api/search
  - Search across artists and tracks
  - Query params: ?q=search+term&type=artist|track|all
  - Response: matched artists and tracks
```

### 4.2 Admin Endpoints (authenticated, for management console)

```
GET  /api/admin/sync/status         - Syncer status, relay connections, event counts
GET  /api/admin/sync/relays         - List all tracked relays with status
POST /api/admin/sync/relays         - Add a relay to the sync list
DELETE /api/admin/sync/relays/{url} - Remove a relay
POST /api/admin/sync/force          - Trigger a full resync
GET  /api/admin/sync/log            - Recent sync activity log
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

A new public page at `/request` (or `/join`). Simple form with fields:

- Artist/project name (required)
- Brief description of your music (required)
- Links to existing work — Bandcamp, SoundCloud, YouTube, personal site (optional but encouraged)
- Email address for notification (optional)
- Existing npub if they already have a NOSTR identity (optional)

No NOSTR keys or authentication needed — this is a public-facing request form.

On submission, the form posts to `POST /api/access/request` and displays a confirmation message explaining that the node admin will review their request.

### 5.5 Invite Code Flow

On approval, the system generates a unique invite code (e.g. `EQ-a8f3b2c1`). The admin can share this with the artist however they choose — email, DM, etc.

The existing onboarding page (`/admin/onboarding.html`) is modified to require an invite code at the start. The code is validated against `POST /api/access/validate-code`. If valid, the artist proceeds through the existing onboarding flow. On successful onboarding (keys generated, profile published), the invite is marked as used and the artist is added to `node_artists`.

### 5.6 API Endpoints

```
# Public
POST /api/access/request            - Submit a join request
POST /api/access/validate-code      - Validate an invite code
GET  /api/access/node-info          - Public node info (name, description, hosted artist count, fee model)

# Admin (authenticated)
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
- Node status: all services health (IPFS, NOSTR relay, orchestrator, syncer, postgres)
- Quick stats: hosted artists count, total tracks, total storage used
- Recent activity: latest requests, new events synced, errors

**Sync Manager**
- Relay list with live connection status (connected/disconnected/error)
- Per-relay stats: event count, last event time, error count
- Controls: add relay, remove relay, enable/disable relay, force resync
- Sync log: recent event activity with kind, source relay, action taken

**Artist Management**
- Pending access requests queue with approve/decline actions
- Onboarded artists list with status, track count, storage usage
- Per-artist detail: fee model, published events, IPFS storage used
- Invite code management: active codes, generate manual codes

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
- Relay syncer configuration
- Backup and export tools

### 6.3 Authentication

The management console requires admin authentication — separate from artist session management. For MVP this can be a simple password or API key set via environment variable (`ADMIN_PASSWORD`). The admin authenticates and receives a session token or JWT for subsequent requests.

All `/api/admin/*` endpoints require this authentication.

### 6.4 Tech Stack

- React SPA served as static files from `/admin/console`
- Communicates with `/api/admin/*` endpoints
- WebSocket connection to orchestrator for real-time status updates (relay connections, incoming requests)
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

The tooling should make this exit path explicit — a "migrate" or "export" option in the artist admin panel that packages everything needed.

---

## 9. Implementation Priority

### Phase A: Access Control (Immediate)

**Goal:** Close the open onboarding door.

1. Create access request form page at `/join` or `/request`
2. Add `access_requests` table to database
3. Add `POST /api/access/request` endpoint
4. Modify onboarding page to require invite code
5. Add `POST /api/access/validate-code` endpoint
6. Create minimal admin page to view and approve/decline requests

This can be done with the existing stack — no new services needed. The admin approval page can be a simple authenticated page initially.

### Phase B: Relay Syncer & Cache API

**Goal:** Fast, reliable data for the web client.

1. Set up PostgreSQL as a new service in Docker Compose
2. Create cache database schema
3. Build relay syncer as standalone Python process
4. Add syncer as new Docker container
5. Add cache API endpoints to orchestrator
6. Update web client to use cache API instead of direct relay queries

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
| `CONTENT_NODE.md` | **Update** | Add relay-syncer and postgres services to architecture, services table, Docker Compose, and URL routing. Add `/join` and `/admin/console` routes. |
| `equaliser-technical-specification.md` | **Update** | Add Section 4.6 (Relay Syncer), Section 4.7 (Cache API), Section 4.8 (Node Management Console), Section 4.9 (Access Control). Update architecture diagram. |
| `equaliser-node-setup-notes.md` | **Update** | Add relay-syncer container setup, PostgreSQL setup, and environment variables. Update Docker Compose examples. |
| `RELAY_SYNCER.md` | **Create** | Dedicated documentation for the relay syncer process: configuration, relay management, sync behaviour, troubleshooting. |
| `NODE_ADMIN.md` | **Create** | Documentation for the node management console: features, authentication, API reference for admin endpoints. |
| `ACCESS_CONTROL.md` | **Create** | Documentation for the access request and invite code system: request form, approval workflow, invite codes, integration with onboarding. |
| `DATABASE.md` | **Create** | Full database schema reference covering cache tables, access control tables, cluster/blossom tables, and node configuration. |
| `equaliser-domain-mapping-notes.md` | **Update** | Add routes for `/join`, `/admin/console`, and any new API paths to reverse proxy configuration. |

---

## References

- [Primal Caching Server](https://github.com/PrimalHQ/primal-server) — Reference architecture for relay syncing and cached API
- [Equaliser Technical Specification](./equaliser-technical-specification.md) — Core platform specification
- [Equaliser Content Node](./CONTENT_NODE.md) — Current content node documentation
- [Equaliser Node Setup Notes](./equaliser-node-setup-notes.md) — Docker and relay setup notes
- [NOSTR Protocol NIPs](https://github.com/nostr-protocol/nips) — NIP-01, NIP-05, NIP-44, NIP-65 (Kind 10002)
