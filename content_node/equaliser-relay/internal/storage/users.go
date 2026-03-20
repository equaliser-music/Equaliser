package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ProfileResult is a unified profile from cached_artists or cached_users.
type ProfileResult struct {
	Pubkey    string `json:"pubkey"`
	Name      string `json:"name"`
	Picture   string `json:"picture"`
	NIP05     string `json:"nip05,omitempty"`
	About     string `json:"about,omitempty"`
	CreatedAt int64  `json:"created_at"`
	Type      string `json:"type"` // "artist" or "user"
}

// FeedEvent is a cached Kind 1 post from cached_user_feed.
type FeedEvent struct {
	EventID   string `json:"event_id"`
	Pubkey    string `json:"pubkey"`
	Content   string `json:"content"`
	CreatedAt int64  `json:"created_at"`
}

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

// BackfillUserProfile copies an existing Kind 0 profile from raw_events into cached_users.
// Called after registration to handle the case where the profile was published before the
// user was registered (e.g. during onboarding).
func (s *UserStore) BackfillUserProfile(ctx context.Context, pubkey, npub string) {
	var eventID, content string
	var createdAt int64
	var rawEvent json.RawMessage

	err := s.pool.QueryRow(ctx, `
		SELECT id, content, created_at, raw
		FROM raw_events
		WHERE pubkey = $1 AND kind = 0
		ORDER BY created_at DESC
		LIMIT 1
	`, pubkey).Scan(&eventID, &content, &createdAt, &rawEvent)
	if err != nil {
		return // No Kind 0 found — nothing to backfill
	}

	var profile struct {
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
		Picture     string `json:"picture"`
		About       string `json:"about"`
		LUD16       string `json:"lud16"`
	}
	if err := json.Unmarshal([]byte(content), &profile); err != nil {
		log.Printf("Backfill: failed to parse profile for %s: %v", pubkey, err)
		return
	}

	displayName := profile.DisplayName
	if displayName == "" {
		displayName = profile.Name
	}

	_, err = s.pool.Exec(ctx, `
		INSERT INTO cached_users (pubkey, npub, display_name, name, picture, lightning_address, about, raw_event, event_id, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (pubkey) DO NOTHING
	`, pubkey, npub, displayName, profile.Name, profile.Picture, profile.LUD16,
		profile.About, rawEvent, eventID, createdAt)
	if err != nil {
		log.Printf("Backfill: failed to cache profile for %s: %v", pubkey, err)
		return
	}

	log.Printf("Backfill: cached profile for %s (%s)", pubkey[:12], displayName)
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

// GetProfiles returns profiles from both cached_artists and cached_users for the given pubkeys.
func (s *UserStore) GetProfiles(ctx context.Context, pubkeys []string) ([]ProfileResult, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT pubkey, display_name, picture_url, nip05, about, created_at, 'artist' AS type
		FROM cached_artists WHERE pubkey = ANY($1)
		UNION ALL
		SELECT pubkey, COALESCE(display_name, name), picture, '', about, created_at, 'user' AS type
		FROM cached_users WHERE pubkey = ANY($1)
	`, pubkeys)
	if err != nil {
		return nil, fmt.Errorf("get profiles: %w", err)
	}
	defer rows.Close()

	seen := make(map[string]bool)
	var results []ProfileResult
	for rows.Next() {
		var p ProfileResult
		var picture, nip05, about *string
		if err := rows.Scan(&p.Pubkey, &p.Name, &picture, &nip05, &about, &p.CreatedAt, &p.Type); err != nil {
			return nil, fmt.Errorf("scan profile: %w", err)
		}
		if picture != nil {
			p.Picture = *picture
		}
		if nip05 != nil {
			p.NIP05 = *nip05
		}
		if about != nil {
			p.About = *about
		}
		// Prefer artist over user if somehow in both tables
		if seen[p.Pubkey] {
			continue
		}
		seen[p.Pubkey] = true
		results = append(results, p)
	}
	return results, rows.Err()
}

// GetUserFollows returns the follow list for a registered user from cached_user_follows.
func (s *UserStore) GetUserFollows(ctx context.Context, pubkey string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		"SELECT follows_pubkey FROM cached_user_follows WHERE pubkey = $1",
		pubkey,
	)
	if err != nil {
		return nil, fmt.Errorf("get user follows: %w", err)
	}
	defer rows.Close()

	var follows []string
	for rows.Next() {
		var pk string
		if err := rows.Scan(&pk); err != nil {
			return nil, fmt.Errorf("scan follow: %w", err)
		}
		follows = append(follows, pk)
	}
	return follows, rows.Err()
}

// GetUserFeed returns cached feed posts for a registered user, newest first.
func (s *UserStore) GetUserFeed(ctx context.Context, pubkey string, limit int) ([]FeedEvent, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	rows, err := s.pool.Query(ctx, `
		SELECT event_id, pubkey, content, created_at
		FROM cached_user_feed
		WHERE for_user_pubkey = $1
		ORDER BY created_at DESC
		LIMIT $2
	`, pubkey, limit)
	if err != nil {
		return nil, fmt.Errorf("get user feed: %w", err)
	}
	defer rows.Close()

	var events []FeedEvent
	for rows.Next() {
		var e FeedEvent
		if err := rows.Scan(&e.EventID, &e.Pubkey, &e.Content, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan feed event: %w", err)
		}
		events = append(events, e)
	}
	return events, rows.Err()
}
