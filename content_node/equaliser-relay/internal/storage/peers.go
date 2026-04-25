package storage

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PeerRelayInfo is the externally exposed shape of a peer_relays row.
// Used by the operator admin UI to display peer sync state.
type PeerRelayInfo struct {
	URL             string     `json:"url"`
	Status          string     `json:"status"`
	Enabled         bool       `json:"enabled"`
	AutoDiscovered  bool       `json:"auto_discovered"`
	EventCount      int64      `json:"event_count"`
	ErrorCount      int64      `json:"error_count"`
	LastError       *string    `json:"last_error,omitempty"`
	LastConnectedAt *time.Time `json:"last_connected_at,omitempty"`
	LastEventAt     *int64     `json:"last_event_at,omitempty"`
	AddedAt         time.Time  `json:"added_at"`
}

// PeerStore handles CRUD operations on the peer_relays table.
type PeerStore struct {
	pool *pgxpool.Pool
}

// NewPeerStore creates a new PeerStore.
func NewPeerStore(pool *pgxpool.Pool) *PeerStore {
	return &PeerStore{pool: pool}
}

// UpsertPeer inserts a peer relay URL if it doesn't already exist.
// Does not overwrite existing state (status, counters, etc.).
func (s *PeerStore) UpsertPeer(ctx context.Context, url string, autoDiscovered bool) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO peer_relays (url, auto_discovered)
		VALUES ($1, $2)
		ON CONFLICT (url) DO NOTHING
	`, url, autoDiscovered)
	return err
}

// UpdateConnected marks a peer as connected, resets error count.
func (s *PeerStore) UpdateConnected(ctx context.Context, url string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE peer_relays
		SET status = 'connected', last_connected_at = NOW(), error_count = 0
		WHERE url = $1
	`, url)
	return err
}

// UpdateDisconnected marks a peer as disconnected.
func (s *PeerStore) UpdateDisconnected(ctx context.Context, url string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE peer_relays SET status = 'disconnected' WHERE url = $1
	`, url)
	return err
}

// UpdateError records an error for a peer.
func (s *PeerStore) UpdateError(ctx context.Context, url string, errMsg string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE peer_relays
		SET status = 'error', error_count = error_count + 1, last_error = $2
		WHERE url = $1
	`, url, errMsg)
	return err
}

// RecordEvent increments event_count and updates last_event_at.
func (s *PeerStore) RecordEvent(ctx context.Context, url string, createdAt int64) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE peer_relays
		SET event_count = event_count + 1, last_event_at = GREATEST(last_event_at, $2)
		WHERE url = $1
	`, url, createdAt)
	return err
}

// GetLastEventAt returns the last_event_at timestamp for a peer.
// Returns 0 if no events have been received.
func (s *PeerStore) GetLastEventAt(ctx context.Context, url string) (int64, error) {
	var lastEventAt *int64
	err := s.pool.QueryRow(ctx,
		"SELECT last_event_at FROM peer_relays WHERE url = $1",
		url,
	).Scan(&lastEventAt)
	if err == pgx.ErrNoRows || lastEventAt == nil {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return *lastEventAt, nil
}

// ListPeers returns full state for all peer relays, ordered by added_at desc.
// Used by the operator admin UI to display sync status.
func (s *PeerStore) ListPeers(ctx context.Context) ([]PeerRelayInfo, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT url, status, enabled, auto_discovered,
		       event_count, error_count, last_error,
		       last_connected_at, last_event_at, added_at
		FROM peer_relays
		ORDER BY added_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	peers := []PeerRelayInfo{}
	for rows.Next() {
		var p PeerRelayInfo
		if err := rows.Scan(
			&p.URL, &p.Status, &p.Enabled, &p.AutoDiscovered,
			&p.EventCount, &p.ErrorCount, &p.LastError,
			&p.LastConnectedAt, &p.LastEventAt, &p.AddedAt,
		); err != nil {
			return nil, err
		}
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

// GetEnabledPeers returns all enabled peer relay URLs.
func (s *PeerStore) GetEnabledPeers(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		"SELECT url FROM peer_relays WHERE enabled = TRUE",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var urls []string
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			return nil, err
		}
		urls = append(urls, url)
	}
	return urls, rows.Err()
}
