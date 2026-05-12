-- Migration 005: Label Multi-Artist Management via NIP-26 Delegation
-- Two tables:
--   delegation_requests — label asks artist for permission to publish on their behalf
--   artist_delegations  — granted delegations (cache; canonical source is the signed
--                         tag carried on each event)

-- Pending / completed delegation requests initiated by labels.
CREATE TABLE IF NOT EXISTS delegation_requests (
    id SERIAL PRIMARY KEY,
    label_pubkey            TEXT NOT NULL,
    artist_pubkey           TEXT NOT NULL,
    requested_kinds         TEXT NOT NULL DEFAULT '30050,5',  -- comma-separated kinds
    requested_duration_days INTEGER NOT NULL DEFAULT 365,
    note                    TEXT,
    status                  TEXT DEFAULT 'pending',           -- 'pending' | 'granted' | 'declined'
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    responded_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_delegation_requests_artist
    ON delegation_requests(artist_pubkey, status);
CREATE INDEX IF NOT EXISTS idx_delegation_requests_label
    ON delegation_requests(label_pubkey, status);

-- Granted delegations. (artist_pubkey, label_pubkey) is unique — one delegation per pair.
-- The conditions string + signature are the actual NIP-26 delegation token; events
-- signed by the label include them as a `["delegation", artist_pubkey, conditions, signature]` tag.
CREATE TABLE IF NOT EXISTS artist_delegations (
    id SERIAL PRIMARY KEY,
    artist_pubkey TEXT NOT NULL,                        -- delegator
    label_pubkey  TEXT NOT NULL,                        -- delegatee
    conditions    TEXT NOT NULL,                        -- NIP-26 conditions: kind=N&created_at>X&created_at<Y
    signature     TEXT NOT NULL,                        -- delegator's BIP-340 sig of sha256("nostr:delegation:<label>:<conditions>")
    request_id    INTEGER REFERENCES delegation_requests(id),
    granted_at    TIMESTAMPTZ DEFAULT NOW(),
    expires_at    TIMESTAMPTZ,                          -- parsed from conditions for cheap filtering
    revoked_at    TIMESTAMPTZ,                          -- set when artist revokes
    UNIQUE (artist_pubkey, label_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_delegations_label_active
    ON artist_delegations(label_pubkey)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_delegations_artist_active
    ON artist_delegations(artist_pubkey)
    WHERE revoked_at IS NULL;

-- Track who-published when an event was published via delegation.
-- Optional: cached_tracks already exists; this is a per-track signer record.
ALTER TABLE cached_tracks
    ADD COLUMN IF NOT EXISTS published_by TEXT;  -- pubkey of the label that signed (when delegation tag present)

CREATE INDEX IF NOT EXISTS idx_cached_tracks_published_by
    ON cached_tracks(published_by) WHERE published_by IS NOT NULL;
