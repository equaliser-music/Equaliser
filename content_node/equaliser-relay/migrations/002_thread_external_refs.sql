-- Equaliser Relay: Thread external reply tracking
-- Stores counts of non-Equaliser replies to threads (fetched on demand, not cached)

CREATE TABLE IF NOT EXISTS thread_external_refs (
    root_event_id TEXT PRIMARY KEY,
    external_reply_count INTEGER DEFAULT 0,
    checked_at TIMESTAMPTZ DEFAULT NOW()
);
