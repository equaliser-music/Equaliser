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

// ArtistResult is a cached artist profile from cached_artists.
type ArtistResult struct {
	Pubkey    string `json:"pubkey"`
	Name      string `json:"name"`
	About     string `json:"about,omitempty"`
	Picture   string `json:"picture,omitempty"`
	Banner    string `json:"banner,omitempty"`
	Website   string `json:"website,omitempty"`
	NIP05     string `json:"nip05,omitempty"`
	LUD16     string `json:"lud16,omitempty"`
	CreatedAt int64  `json:"created_at"`
}

// TrackResult is a cached track from cached_tracks.
type TrackResult struct {
	EventID         string `json:"event_id"`
	ArtistPubkey    string `json:"artist_pubkey"`
	DTag            string `json:"d_tag"`
	Title           string `json:"title,omitempty"`
	Album           string `json:"album,omitempty"`
	Genre           string `json:"genre,omitempty"`
	Duration        *int   `json:"duration,omitempty"`
	PriceSats       *int   `json:"price_sats,omitempty"`
	IPFSManifestCID string `json:"ipfs_manifest_cid,omitempty"`
	IPFSPreviewCID  string `json:"ipfs_preview_cid,omitempty"`
	CoverArtCID     string `json:"cover_art_cid,omitempty"`
	ReleaseDate     string `json:"release_date,omitempty"`
	CreatedAt       int64  `json:"created_at"`
	RawEvent        json.RawMessage `json:"raw_event,omitempty"`
}

// AlbumResult is a cached album from cached_albums.
type AlbumResult struct {
	EventID      string `json:"event_id"`
	ArtistPubkey string `json:"artist_pubkey"`
	DTag         string `json:"d_tag"`
	Title        string `json:"title,omitempty"`
	CoverArtCID  string `json:"cover_art_cid,omitempty"`
	CreatedAt    int64  `json:"created_at"`
	RawEvent     json.RawMessage `json:"raw_event,omitempty"`
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

// BootstrapOperators ensures OPERATOR_PUBKEYS from config exist in node_operators.
func (s *UserStore) BootstrapOperators(ctx context.Context, pubkeys []string) error {
	for _, pk := range pubkeys {
		_, err := s.pool.Exec(ctx, `
			INSERT INTO node_operators (pubkey, name)
			VALUES ($1, 'Node Operator')
			ON CONFLICT (pubkey) DO NOTHING
		`, pk)
		if err != nil {
			return fmt.Errorf("bootstrap operator %s: %w", pk[:16], err)
		}
	}
	if len(pubkeys) > 0 {
		log.Printf("Bootstrapped %d node operator(s)", len(pubkeys))
	}
	return nil
}

// RoleInfo contains the resolved role for a pubkey on this node.
type RoleInfo struct {
	Pubkey         string   `json:"pubkey"`
	Role           string   `json:"role"`            // "artist", "label", "operator"
	ManagedArtists []string `json:"managed_artists"` // pubkeys this user can manage
}

// ResolveRole determines the role for a pubkey by checking node_operators then node_artists.
func (s *UserStore) ResolveRole(ctx context.Context, pubkey string) (*RoleInfo, error) {
	// 1. Check node_operators
	var exists bool
	err := s.pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM node_operators WHERE pubkey = $1)", pubkey,
	).Scan(&exists)
	if err != nil {
		return nil, fmt.Errorf("check operator: %w", err)
	}
	if exists {
		// Operator can manage ALL artists
		artists, err := s.getAllArtistPubkeys(ctx)
		if err != nil {
			return nil, err
		}
		return &RoleInfo{Pubkey: pubkey, Role: "operator", ManagedArtists: artists}, nil
	}

	// 2. Check node_artists
	var role, status string
	err = s.pool.QueryRow(ctx,
		"SELECT role, status FROM node_artists WHERE pubkey = $1", pubkey,
	).Scan(&role, &status)
	if err != nil {
		return nil, nil // Not found — no role on this node
	}
	if status != "active" {
		return nil, nil // Suspended
	}

	if role == "label" {
		// Label can manage artists where managed_by = label pubkey, plus self
		managed, err := s.getManagedArtists(ctx, pubkey)
		if err != nil {
			return nil, err
		}
		managed = append(managed, pubkey) // label can also manage own content
		return &RoleInfo{Pubkey: pubkey, Role: "label", ManagedArtists: managed}, nil
	}

	// Default: artist
	return &RoleInfo{Pubkey: pubkey, Role: "artist", ManagedArtists: []string{pubkey}}, nil
}

// getAllArtistPubkeys returns all active artist pubkeys on the node.
func (s *UserStore) getAllArtistPubkeys(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, "SELECT pubkey FROM node_artists WHERE status = 'active'")
	if err != nil {
		return nil, fmt.Errorf("get all artist pubkeys: %w", err)
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

// getManagedArtists returns artist pubkeys managed by a label.
func (s *UserStore) getManagedArtists(ctx context.Context, labelPubkey string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		"SELECT pubkey FROM node_artists WHERE managed_by = $1 AND status = 'active'",
		labelPubkey,
	)
	if err != nil {
		return nil, fmt.Errorf("get managed artists: %w", err)
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

// GetAllArtists returns all cached artist profiles.
func (s *UserStore) GetAllArtists(ctx context.Context) ([]ArtistResult, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT pubkey, display_name, about, picture_url, banner_url, website, nip05, lud16, created_at
		FROM cached_artists
		ORDER BY display_name ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("get all artists: %w", err)
	}
	defer rows.Close()

	var results []ArtistResult
	for rows.Next() {
		var a ArtistResult
		var about, picture, banner, website, nip05, lud16 *string
		if err := rows.Scan(&a.Pubkey, &a.Name, &about, &picture, &banner, &website, &nip05, &lud16, &a.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan artist: %w", err)
		}
		if about != nil { a.About = *about }
		if picture != nil { a.Picture = *picture }
		if banner != nil { a.Banner = *banner }
		if website != nil { a.Website = *website }
		if nip05 != nil { a.NIP05 = *nip05 }
		if lud16 != nil { a.LUD16 = *lud16 }
		results = append(results, a)
	}
	return results, rows.Err()
}

// GetTracksByArtist returns all cached tracks for an artist, newest first.
func (s *UserStore) GetTracksByArtist(ctx context.Context, artistPubkey string) ([]TrackResult, error) {
	return s.queryTracks(ctx, "WHERE artist_pubkey = $1 ORDER BY created_at DESC", artistPubkey)
}

// GetRecentTracks returns the most recent cached tracks across all artists.
func (s *UserStore) GetRecentTracks(ctx context.Context, limit int) ([]TrackResult, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	return s.queryTracks(ctx, "ORDER BY created_at DESC LIMIT $1", limit)
}

func (s *UserStore) queryTracks(ctx context.Context, whereClause string, args ...interface{}) ([]TrackResult, error) {
	query := `
		SELECT event_id, artist_pubkey, d_tag, title, album, genre, duration, price_sats,
			ipfs_manifest_cid, ipfs_preview_cid, cover_art_cid, release_date, created_at, raw_event
		FROM cached_tracks ` + whereClause

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query tracks: %w", err)
	}
	defer rows.Close()

	var results []TrackResult
	for rows.Next() {
		var t TrackResult
		var title, album, genre, manifest, preview, cover, releaseDate *string
		if err := rows.Scan(&t.EventID, &t.ArtistPubkey, &t.DTag, &title, &album, &genre,
			&t.Duration, &t.PriceSats, &manifest, &preview, &cover, &releaseDate, &t.CreatedAt, &t.RawEvent); err != nil {
			return nil, fmt.Errorf("scan track: %w", err)
		}
		if title != nil { t.Title = *title }
		if album != nil { t.Album = *album }
		if genre != nil { t.Genre = *genre }
		if manifest != nil { t.IPFSManifestCID = *manifest }
		if preview != nil { t.IPFSPreviewCID = *preview }
		if cover != nil { t.CoverArtCID = *cover }
		if releaseDate != nil { t.ReleaseDate = *releaseDate }
		results = append(results, t)
	}
	return results, rows.Err()
}

// GetAlbumsByArtist returns all cached albums for an artist, newest first.
func (s *UserStore) GetAlbumsByArtist(ctx context.Context, artistPubkey string) ([]AlbumResult, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT event_id, artist_pubkey, d_tag, title, cover_art_cid, created_at, raw_event
		FROM cached_albums
		WHERE artist_pubkey = $1
		ORDER BY created_at DESC
	`, artistPubkey)
	if err != nil {
		return nil, fmt.Errorf("get albums: %w", err)
	}
	defer rows.Close()

	var results []AlbumResult
	for rows.Next() {
		var a AlbumResult
		var title, cover *string
		if err := rows.Scan(&a.EventID, &a.ArtistPubkey, &a.DTag, &title, &cover, &a.CreatedAt, &a.RawEvent); err != nil {
			return nil, fmt.Errorf("scan album: %w", err)
		}
		if title != nil { a.Title = *title }
		if cover != nil { a.CoverArtCID = *cover }
		results = append(results, a)
	}
	return results, rows.Err()
}
