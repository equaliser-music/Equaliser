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
│  │  (kubo)  │  │  (Rust/Go)       │  │ (FastAPI)  │ │
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

**Supported NIPs (minimum):**
- NIP-01 — Basic protocol (REQ/EVENT/CLOSE/EOSE)
- NIP-11 — Relay information document
- NIP-42 — Authentication (optional, for admin operations)

**Event acceptance policy:**
- Events with `["app", "Equaliser"]` tag → stored in optimised schema + raw event table
- Events without the tag → optionally accepted into a raw-only table (for NOSTR interop) or rejected
- Configurable per-node: open (accept all), filtered (Equaliser only), or hybrid

### 2. Optimised Storage (PostgreSQL)

Events are stored twice:

1. **Raw events table** — every accepted event as JSONB, for NOSTR protocol compliance (serving `REQ` subscriptions)
2. **Denormalised tables** — parsed into Equaliser-specific schemas for fast REST API queries

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

Served by the relay process directly:

```
GET /api/artists                    - List all cached artists
GET /api/artists/{npub}             - Single artist profile
GET /api/artists/{npub}/tracks      - Artist's tracks
GET /api/tracks/{event_id}          - Single track
GET /api/tracks                     - Tracks across all artists
GET /api/search                     - Search artists and tracks
GET /api/users/me?pubkey={hex}      - Cached user profile
GET /api/users/{pubkey}/feed        - User's cached feed
GET /api/users/{pubkey}/playlists   - User's playlists
```

The orchestrator handles track uploads, draft management, and IPFS. The relay handles all read-side data serving.

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

This means relay-side filtering on `#app`, `#content-type`, `#board` works correctly. The client-side filtering workarounds documented in [NOSTR.md](NOSTR.md) become unnecessary.

---

## Event Flow

### Inbound (from external clients or peer relays)

```
Client/Peer → WebSocket EVENT
    → Signature validation
    → Replaceable event rules (highest created_at wins)
    → Deduplication (by event ID)
    → Write to raw_events table
    → Parse into denormalised table (if Equaliser-tagged)
    → Notify active WebSocket subscriptions
```

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
    - PEER_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
    - SYNC_INTERVAL=3600
    - USER_FEED_DAYS=30
    - USER_FEED_LIMIT=500
    - EVENT_POLICY=equaliser_only    # or: open, hybrid
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

## Language Choice

| Option | Pros | Cons |
|--------|------|------|
| **Rust** | Best performance, memory safety, existing relay ecosystem (nostr-rs-relay, strfry is C++) | Steeper learning curve, slower iteration |
| **Go** | Fast enough, excellent WebSocket libraries, quick to build, easy deployment | Not as fast as Rust for pure throughput |
| **Python (async)** | Consistent with orchestrator, fastest to prototype | Performance ceiling at high scale |

Recommendation: **Go** for the sweet spot of performance, development speed, and operational simplicity. Rust if performance profiling later shows Go is the bottleneck.

Python is viable for an initial prototype to validate the architecture before rewriting in Go/Rust.

---

## Migration Path

This doesn't need to be built all at once. A phased approach:

### Phase 1: Core relay + storage
- Build minimal NIP-01 relay with PostgreSQL storage
- Full tag indexing via `event_tags` table
- Event acceptance policy (Equaliser-only / open / hybrid)
- Replaces nostr-rs-relay in the Docker stack

### Phase 2: Peer syncing
- Add peer syncer — persistent WebSocket connections to external relays
- Inbound: subscribe to Equaliser-tagged events and registered user data
- Outbound: forward locally published events for federation
- Auto-reconnection with exponential backoff

### Phase 3: REST API + denormalised schemas
- Add denormalised tables (artists, tracks, albums, users)
- Parse events into denormalised tables on arrival
- Serve REST API endpoints for the web client
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

## References

- [DATABASE.md](DATABASE.md) — Cache database schema (reused as-is)
- [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) — Node management specification
- [NOSTR.md](NOSTR.md) — NOSTR protocol usage and relay configuration
- [Primal Caching Server](https://github.com/PrimalHQ/primal-server) — Similar architecture (custom relay as cache)
- [strfry](https://github.com/hoytech/strfry) — High-performance C++ relay (reference for design)
- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) — Basic NOSTR protocol
