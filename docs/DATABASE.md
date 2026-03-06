# Database Schema Reference

**Status:** Specification
**Spec Reference:** [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) Sections 3, 5, 7

---

## Overview

The Equaliser content node uses two database systems:

| Database | Engine | Purpose |
|----------|--------|---------|
| Drafts | SQLite | Track drafts and upload metadata (existing) |
| Cache | PostgreSQL | Equaliser Relay event storage and cache, access control, cluster/blossom state |

The SQLite database is used by the orchestrator for track uploads and draft management. The PostgreSQL database is owned by the Equaliser Relay, which writes events on ingestion and serves cached data via its REST API. The orchestrator reads from PostgreSQL for access control and cluster state.

---

## SQLite: Drafts Database

**Location:** `/data/drafts.db` (inside orchestrator container)
**Documentation:** [ORCHESTRATOR.md](ORCHESTRATOR.md)

### draft_tracks

Stores track metadata from upload through release.

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
    status TEXT DEFAULT 'draft',       -- draft, released
    nostr_event_id TEXT,
    nostr_d_tag TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    released_at TEXT
);
```

---

## PostgreSQL: Cache Database

**Connection:** `postgresql://equaliser:${DB_PASSWORD}@postgres:5432/equaliser`
**Owned by:** Equaliser Relay (primary reader/writer). Orchestrator reads access control and cluster tables.

---

### Cache Tables

These tables are populated by the Equaliser Relay when events arrive via WebSocket or peer sync. Events are parsed into denormalised tables in a single transaction on arrival — no sync lag.

#### cached_artists

Parsed artist profiles from Kind 0 events.

```sql
CREATE TABLE cached_artists (
    pubkey TEXT PRIMARY KEY,
    display_name TEXT,
    about TEXT,
    picture_url TEXT,
    banner_url TEXT,
    website TEXT,
    nip05 TEXT,
    lud16 TEXT,
    equaliser_metadata JSONB,      -- genres, location, etc.
    raw_event JSONB NOT NULL,
    event_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### cached_tracks

Parsed track metadata from Kind 30050 events.

```sql
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
```

#### cached_albums

Parsed album metadata from Kind 30051 events.

```sql
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
```

---

### User Cache Tables

These tables support fan/listener data caching. The orchestrator writes to `registered_users` when a fan authenticates; the Equaliser Relay detects new registrations and subscribes to their data on peer relays, populating the remaining user cache tables. See [EQUALISER_RELAY.md](EQUALISER_RELAY.md) for subscription details.

#### registered_users

Registry of pubkeys that have authenticated through the node.

```sql
CREATE TABLE registered_users (
    pubkey TEXT PRIMARY KEY,
    npub TEXT NOT NULL,
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    enabled BOOLEAN DEFAULT TRUE              -- admin can disable syncing per user
);
```

#### cached_users

Parsed fan profiles from Kind 0 events.

```sql
CREATE TABLE cached_users (
    pubkey TEXT PRIMARY KEY,
    npub TEXT NOT NULL,
    display_name TEXT,
    name TEXT,
    picture TEXT,
    lightning_address TEXT,
    about TEXT,
    raw_event JSONB NOT NULL,
    event_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    cached_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### cached_user_follows

Follow list per user from Kind 3 events — one row per followed pubkey.

```sql
CREATE TABLE cached_user_follows (
    pubkey TEXT NOT NULL REFERENCES registered_users(pubkey),
    follows_pubkey TEXT NOT NULL,
    relay_hint TEXT,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (pubkey, follows_pubkey)
);
```

#### cached_user_feed

Notes from a user's follow list (Kind 1), subject to feed thresholds (`USER_FEED_DAYS`, `USER_FEED_LIMIT`).

```sql
CREATE TABLE cached_user_feed (
    event_id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,                      -- author pubkey
    for_user_pubkey TEXT NOT NULL REFERENCES registered_users(pubkey),
    content TEXT,
    created_at BIGINT NOT NULL,
    cached_at TIMESTAMPTZ DEFAULT NOW(),
    relay_source TEXT
);
```

#### cached_user_playlists

Equaliser playlists (Kind 30001) belonging to registered users.

```sql
CREATE TABLE cached_user_playlists (
    event_id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL REFERENCES registered_users(pubkey),
    playlist_id TEXT NOT NULL,                 -- d tag
    name TEXT,
    track_refs JSONB,                          -- ordered list of track event IDs
    raw_event JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    cached_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pubkey, playlist_id)
);
```

---

### Relay Operational Tables

Used by the Equaliser Relay for peer connection management and event processing logging.

#### peer_relays

Tracks peer relay connections and sync state.

```sql
CREATE TABLE peer_relays (
    url TEXT PRIMARY KEY,
    status TEXT DEFAULT 'disconnected',    -- connected, disconnected, error
    last_event_at BIGINT,
    last_connected_at TIMESTAMPTZ,
    last_error TEXT,
    event_count BIGINT DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    auto_discovered BOOLEAN DEFAULT FALSE,
    enabled BOOLEAN DEFAULT TRUE,
    added_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### event_log

Debug and monitoring log for event processing.

```sql
CREATE TABLE event_log (
    id SERIAL PRIMARY KEY,
    relay_url TEXT NOT NULL,
    event_kind INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    action TEXT NOT NULL,                  -- inserted, updated, duplicate, invalid
    logged_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### Access Control Tables

Used by the access request and invite code system. See [ACCESS_CONTROL.md](ACCESS_CONTROL.md).

#### access_requests

Artist access requests and their review status.

```sql
CREATE TABLE access_requests (
    id SERIAL PRIMARY KEY,
    artist_name TEXT NOT NULL,
    email TEXT,
    npub TEXT,
    description TEXT,
    links TEXT,
    status TEXT DEFAULT 'pending',         -- pending, approved, declined
    admin_notes TEXT,
    invite_code TEXT UNIQUE,
    invite_used BOOLEAN DEFAULT FALSE,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
);
```

#### node_artists

Approved and onboarded artists on this node.

```sql
CREATE TABLE node_artists (
    pubkey TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    request_id INTEGER REFERENCES access_requests(id),
    fee_model TEXT DEFAULT 'free',         -- free, percentage, flat_rate
    fee_value NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'active',          -- active, suspended, migrated
    onboarded_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### Cluster Tables

Used for cross-node IPFS pinning. See [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) Section 7.

#### cluster_pin_requests

Tracks inbound and outbound pin requests between nodes.

```sql
CREATE TABLE cluster_pin_requests (
    id SERIAL PRIMARY KEY,
    direction TEXT NOT NULL,               -- inbound, outbound
    remote_node_url TEXT NOT NULL,
    cid TEXT NOT NULL,
    artist_pubkey TEXT,
    content_type TEXT,                     -- track, album, cover_art
    status TEXT DEFAULT 'pending',         -- pending, accepted, pinned, declined, failed
    storage_bytes BIGINT,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
```

---

### Blossom Tables

Used for Blossom server mirroring configuration. See [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) Section 7.

#### blossom_servers

Configured Blossom servers for content mirroring.

```sql
CREATE TABLE blossom_servers (
    url TEXT PRIMARY KEY,
    enabled BOOLEAN DEFAULT TRUE,
    auth_token TEXT,
    mirror_policy TEXT DEFAULT 'all',      -- all, own_artists, manual
    last_sync_at TIMESTAMPTZ,
    synced_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    added_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### blossom_mirrors

Individual content items mirrored to Blossom servers.

```sql
CREATE TABLE blossom_mirrors (
    id SERIAL PRIMARY KEY,
    blossom_url TEXT REFERENCES blossom_servers(url),
    ipfs_cid TEXT NOT NULL,
    blossom_hash TEXT,
    content_type TEXT,
    status TEXT DEFAULT 'pending',         -- pending, synced, failed
    mirrored_at TIMESTAMPTZ,
    UNIQUE(blossom_url, ipfs_cid)
);
```

---

## Migration Notes

The existing SQLite database continues to serve draft management. The PostgreSQL database is additive — it doesn't replace SQLite but serves a different purpose (Equaliser Relay event storage and cache, access control, cluster state).

- **SQLite:** Accessed directly by the orchestrator at `/data/drafts.db`
- **PostgreSQL:** Owned by the Equaliser Relay, which manages all event data reads and writes. The orchestrator may read PostgreSQL directly for access control and cluster state tables.

---

## References

- [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) — Full specification (Sections 3, 5, 7)
- [ORCHESTRATOR.md](ORCHESTRATOR.md) — Orchestrator API and SQLite drafts schema
- [EQUALISER_RELAY.md](EQUALISER_RELAY.md) — Equaliser Relay architecture
- [ACCESS_CONTROL.md](ACCESS_CONTROL.md) — Access request and invite code system
- [BLOSSOM.md](BLOSSOM.md) — Blossom integration
