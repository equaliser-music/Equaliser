-- Migration 004: Access Control (Phase A)
-- Adds invite-code metadata columns to access_requests and a setup_state table
-- for the first-run operator-claim flow. Additive only — existing rows fine.

-- access_requests metadata for the redemption flow:
-- - requested_role: what the applicant asked for on /join (artist | label)
-- - target_role:    what the code grants when redeemed (artist | label | operator)
-- - target_managed_by: pubkey of the label whose roster the redeemed artist joins (NULL for unmanaged)
-- - issued_by:      pubkey of the label/operator who generated/approved the code (audit)
ALTER TABLE access_requests
    ADD COLUMN IF NOT EXISTS requested_role TEXT DEFAULT 'artist',
    ADD COLUMN IF NOT EXISTS target_role TEXT DEFAULT 'artist',
    ADD COLUMN IF NOT EXISTS target_managed_by TEXT,
    ADD COLUMN IF NOT EXISTS issued_by TEXT;

CREATE INDEX IF NOT EXISTS idx_access_requests_invite_code
    ON access_requests(invite_code) WHERE invite_code IS NOT NULL;

-- setup_state: single-row table holding the first-run setup token.
-- Generated at relay startup when node_operators is empty; cleared on claim.
CREATE TABLE IF NOT EXISTS setup_state (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    setup_token TEXT,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    claimed_at TIMESTAMPTZ
);
INSERT INTO setup_state (id) VALUES (1) ON CONFLICT DO NOTHING;
