-- Equaliser Relay: Role-based access control
-- Adds role columns to node_artists and creates node_operators table.

-----------------------------------------------------------
-- Extend node_artists with role and management columns
-----------------------------------------------------------

ALTER TABLE node_artists ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'artist';
-- Values: 'artist', 'label'

ALTER TABLE node_artists ADD COLUMN IF NOT EXISTS custody TEXT DEFAULT 'self';
-- Values: 'self' (artist holds own key), 'label' (label holds derived key)

ALTER TABLE node_artists ADD COLUMN IF NOT EXISTS managed_by TEXT;
-- For label-managed artists: label's pubkey. NULL for self-managed.

ALTER TABLE node_artists ADD COLUMN IF NOT EXISTS derivation_index INTEGER;
-- BIP-32 account index: m/44'/1237'/{index}'/0/0. NULL for self-managed.

CREATE INDEX IF NOT EXISTS idx_node_artists_role ON node_artists(role);
CREATE INDEX IF NOT EXISTS idx_node_artists_managed_by ON node_artists(managed_by);

-----------------------------------------------------------
-- Node operators table
-----------------------------------------------------------

CREATE TABLE IF NOT EXISTS node_operators (
    pubkey TEXT PRIMARY KEY,
    name TEXT,
    added_at TIMESTAMPTZ DEFAULT NOW()
);
