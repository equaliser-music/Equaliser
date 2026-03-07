-- Equaliser Relay: Initial Schema
-- Full schema from day one — all tables from DATABASE.md

-----------------------------------------------------------
-- Raw Event Storage
-----------------------------------------------------------

CREATE TABLE IF NOT EXISTS raw_events (
    id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    kind INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    content TEXT NOT NULL,
    sig TEXT NOT NULL,
    raw JSONB NOT NULL,
    first_seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_events_pubkey ON raw_events(pubkey);
CREATE INDEX IF NOT EXISTS idx_raw_events_kind ON raw_events(kind);
CREATE INDEX IF NOT EXISTS idx_raw_events_created_at ON raw_events(created_at);
CREATE INDEX IF NOT EXISTS idx_raw_events_kind_pubkey ON raw_events(kind, pubkey);

CREATE TABLE IF NOT EXISTS event_tags (
    event_id TEXT NOT NULL REFERENCES raw_events(id) ON DELETE CASCADE,
    tag_name TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    tag_index INTEGER NOT NULL,
    PRIMARY KEY (event_id, tag_name, tag_index)
);

CREATE INDEX IF NOT EXISTS idx_event_tags_lookup ON event_tags(tag_name, tag_value);

-----------------------------------------------------------
-- Cache Tables (denormalised from events)
-----------------------------------------------------------

CREATE TABLE IF NOT EXISTS cached_artists (
    pubkey TEXT PRIMARY KEY,
    display_name TEXT,
    about TEXT,
    picture_url TEXT,
    banner_url TEXT,
    website TEXT,
    nip05 TEXT,
    lud16 TEXT,
    equaliser_metadata JSONB,
    raw_event JSONB NOT NULL,
    event_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cached_tracks (
    event_id TEXT PRIMARY KEY,
    artist_pubkey TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS cached_albums (
    event_id TEXT PRIMARY KEY,
    artist_pubkey TEXT NOT NULL,
    d_tag TEXT NOT NULL,
    title TEXT,
    cover_art_cid TEXT,
    raw_event JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(artist_pubkey, d_tag)
);

-----------------------------------------------------------
-- Relay Operational Tables
-----------------------------------------------------------

CREATE TABLE IF NOT EXISTS event_log (
    id SERIAL PRIMARY KEY,
    relay_url TEXT NOT NULL,
    event_kind INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    action TEXT NOT NULL,
    logged_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS peer_relays (
    url TEXT PRIMARY KEY,
    status TEXT DEFAULT 'disconnected',
    last_event_at BIGINT,
    last_connected_at TIMESTAMPTZ,
    last_error TEXT,
    event_count BIGINT DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    auto_discovered BOOLEAN DEFAULT FALSE,
    enabled BOOLEAN DEFAULT TRUE,
    added_at TIMESTAMPTZ DEFAULT NOW()
);

-----------------------------------------------------------
-- User Cache Tables
-----------------------------------------------------------

CREATE TABLE IF NOT EXISTS registered_users (
    pubkey TEXT PRIMARY KEY,
    npub TEXT NOT NULL,
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    enabled BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS cached_users (
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

CREATE TABLE IF NOT EXISTS cached_user_follows (
    pubkey TEXT NOT NULL REFERENCES registered_users(pubkey),
    follows_pubkey TEXT NOT NULL,
    relay_hint TEXT,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (pubkey, follows_pubkey)
);

CREATE TABLE IF NOT EXISTS cached_user_feed (
    event_id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    for_user_pubkey TEXT NOT NULL REFERENCES registered_users(pubkey),
    content TEXT,
    created_at BIGINT NOT NULL,
    cached_at TIMESTAMPTZ DEFAULT NOW(),
    relay_source TEXT
);

CREATE TABLE IF NOT EXISTS cached_user_playlists (
    event_id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL REFERENCES registered_users(pubkey),
    playlist_id TEXT NOT NULL,
    name TEXT,
    track_refs JSONB,
    raw_event JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    cached_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pubkey, playlist_id)
);

-----------------------------------------------------------
-- Access Control Tables
-----------------------------------------------------------

CREATE TABLE IF NOT EXISTS access_requests (
    id SERIAL PRIMARY KEY,
    artist_name TEXT NOT NULL,
    email TEXT,
    npub TEXT,
    description TEXT,
    links TEXT,
    status TEXT DEFAULT 'pending',
    admin_notes TEXT,
    invite_code TEXT UNIQUE,
    invite_used BOOLEAN DEFAULT FALSE,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS node_artists (
    pubkey TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    request_id INTEGER REFERENCES access_requests(id),
    fee_model TEXT DEFAULT 'free',
    fee_value NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'active',
    onboarded_at TIMESTAMPTZ DEFAULT NOW()
);

-----------------------------------------------------------
-- Cluster Tables
-----------------------------------------------------------

CREATE TABLE IF NOT EXISTS cluster_pin_requests (
    id SERIAL PRIMARY KEY,
    direction TEXT NOT NULL,
    remote_node_url TEXT NOT NULL,
    cid TEXT NOT NULL,
    artist_pubkey TEXT,
    content_type TEXT,
    status TEXT DEFAULT 'pending',
    storage_bytes BIGINT,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-----------------------------------------------------------
-- Blossom Tables
-----------------------------------------------------------

CREATE TABLE IF NOT EXISTS blossom_servers (
    url TEXT PRIMARY KEY,
    enabled BOOLEAN DEFAULT TRUE,
    auth_token TEXT,
    mirror_policy TEXT DEFAULT 'all',
    last_sync_at TIMESTAMPTZ,
    synced_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    added_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blossom_mirrors (
    id SERIAL PRIMARY KEY,
    blossom_url TEXT REFERENCES blossom_servers(url),
    ipfs_cid TEXT NOT NULL,
    blossom_hash TEXT,
    content_type TEXT,
    status TEXT DEFAULT 'pending',
    mirrored_at TIMESTAMPTZ,
    UNIQUE(blossom_url, ipfs_cid)
);
