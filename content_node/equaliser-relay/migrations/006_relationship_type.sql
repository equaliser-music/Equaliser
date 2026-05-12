-- Migration 006: Phase G — Rights-per-Recording (Label as Publisher)
-- Adds the relationship_type concept so labels and managers are distinct relationship
-- types, and a label_pubkey column on cached_tracks recording WHO SIGNED a given track.

-- node_artists.relationship_type: how the artist is working with their current label.
--   'self'    — independent, no current label (managed_by NULL).
--   'managed' — Phase F NIP-26 delegation: manager helps publish; artist owns recording rights.
--   'signed'  — Phase G: label owns recording rights, publishes under their own pubkey, money flows to label.
ALTER TABLE node_artists
    ADD COLUMN IF NOT EXISTS relationship_type TEXT DEFAULT 'managed'
        CHECK (relationship_type IN ('self', 'managed', 'signed'));

-- Backfill: artists without a managed_by become 'self'; rows with managed_by stay 'managed'
-- (preserves Phase F default behaviour for existing roster artists).
UPDATE node_artists
SET relationship_type = CASE
    WHEN managed_by IS NULL THEN 'self'
    ELSE 'managed'
END
WHERE relationship_type IS NULL OR relationship_type = 'managed';

-- cached_tracks.label_pubkey: the pubkey that actually signed the Kind 30050 event
-- (= event.pubkey at the relay level). NULL for self-published tracks where the
-- artist signed their own event. NON-NULL for both delegation-signed (Phase F)
-- and performer-tagged (Phase G) tracks — recording who-published consistently.
ALTER TABLE cached_tracks
    ADD COLUMN IF NOT EXISTS label_pubkey TEXT;

CREATE INDEX IF NOT EXISTS idx_cached_tracks_label
    ON cached_tracks(label_pubkey)
    WHERE label_pubkey IS NOT NULL;

-- access_requests.target_relationship_type: carry the chosen relationship type
-- through the invite-code lifecycle so the artist's node_artists row gets the
-- right value at redemption time.
ALTER TABLE access_requests
    ADD COLUMN IF NOT EXISTS target_relationship_type TEXT DEFAULT 'managed'
        CHECK (target_relationship_type IN ('self', 'managed', 'signed'));
