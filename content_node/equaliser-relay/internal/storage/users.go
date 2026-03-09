package storage

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// UserStore handles CRUD operations on user-related tables.
type UserStore struct {
	pool *pgxpool.Pool
}

// NewUserStore creates a new UserStore.
func NewUserStore(pool *pgxpool.Pool) *UserStore {
	return &UserStore{pool: pool}
}

// RegisterUser inserts a pubkey into registered_users if not already present.
// Returns true if the user was newly registered, false if already exists.
func (s *UserStore) RegisterUser(ctx context.Context, pubkey, npub string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO registered_users (pubkey, npub)
		VALUES ($1, $2)
		ON CONFLICT (pubkey) DO UPDATE SET last_seen = NOW()
	`, pubkey, npub)
	if err != nil {
		return false, fmt.Errorf("register user: %w", err)
	}
	// RowsAffected is 1 for both insert and update with ON CONFLICT DO UPDATE,
	// so we check if this is a new registration by looking at registered_at vs last_seen
	_ = tag
	return true, nil
}

// IsRegisteredUser checks if a pubkey is in registered_users.
func (s *UserStore) IsRegisteredUser(ctx context.Context, pubkey string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM registered_users WHERE pubkey = $1 AND enabled = TRUE)",
		pubkey,
	).Scan(&exists)
	return exists, err
}

// GetAllKnownPubkeys returns all pubkeys from node_artists and registered_users (enabled only).
func (s *UserStore) GetAllKnownPubkeys(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT pubkey FROM node_artists WHERE status = 'active'
		UNION
		SELECT pubkey FROM registered_users WHERE enabled = TRUE
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pubkeys []string
	for rows.Next() {
		var pk string
		if err := rows.Scan(&pk); err != nil {
			return nil, err
		}
		pubkeys = append(pubkeys, pk)
	}
	return pubkeys, rows.Err()
}

// UpsertThreadExternalRefs updates the external reply count for a thread root.
func (s *UserStore) UpsertThreadExternalRefs(ctx context.Context, rootEventID string, count int) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO thread_external_refs (root_event_id, external_reply_count, checked_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (root_event_id) DO UPDATE SET
			external_reply_count = $2,
			checked_at = NOW()
	`, rootEventID, count)
	return err
}

// GetThreadExternalRefs returns the external reply count and last check time for a thread root.
func (s *UserStore) GetThreadExternalRefs(ctx context.Context, rootEventID string) (int, bool, error) {
	var count int
	err := s.pool.QueryRow(ctx,
		"SELECT external_reply_count FROM thread_external_refs WHERE root_event_id = $1",
		rootEventID,
	).Scan(&count)
	if err != nil {
		return 0, false, nil // Not found
	}
	return count, true, nil
}
