package storage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// AdminStore handles label and operator management queries.
type AdminStore struct {
	pool *pgxpool.Pool
}

// NewAdminStore creates a new AdminStore.
func NewAdminStore(pool *pgxpool.Pool) *AdminStore {
	return &AdminStore{pool: pool}
}

// NodeArtist represents a row from node_artists.
type NodeArtist struct {
	Pubkey          string     `json:"pubkey"`
	ArtistName      string     `json:"artist_name"`
	RequestID       *int       `json:"request_id,omitempty"`
	FeeModel        string     `json:"fee_model"`
	FeeValue        float64    `json:"fee_value"`
	Status          string     `json:"status"`
	Role            string     `json:"role"`
	Custody         string     `json:"custody"`
	ManagedBy       *string    `json:"managed_by,omitempty"`
	DerivationIndex *int       `json:"derivation_index,omitempty"`
	OnboardedAt     time.Time  `json:"onboarded_at"`
}

// AccessRequest represents a row from access_requests.
type AccessRequest struct {
	ID           int        `json:"id"`
	ArtistName   string     `json:"artist_name"`
	Email        string     `json:"email"`
	Npub         string     `json:"npub"`
	Description  string     `json:"description"`
	Links        string     `json:"links"`
	Status       string     `json:"status"`
	AdminNotes   *string    `json:"admin_notes,omitempty"`
	InviteCode   *string    `json:"invite_code,omitempty"`
	InviteUsed   bool       `json:"invite_used"`
	RequestedAt  time.Time  `json:"requested_at"`
	ReviewedAt   *time.Time `json:"reviewed_at,omitempty"`
}

// RegisteredUser represents a row from registered_users.
type RegisteredUser struct {
	Pubkey       string    `json:"pubkey"`
	Npub         string    `json:"npub"`
	Enabled      bool      `json:"enabled"`
	RegisteredAt time.Time `json:"registered_at"`
	LastSeen     time.Time `json:"last_seen"`
}

// ListArtists returns artists, optionally filtered by managed_by and/or role.
func (s *AdminStore) ListArtists(ctx context.Context, managedBy, role string) ([]NodeArtist, error) {
	query := `
		SELECT pubkey, artist_name, request_id, fee_model, fee_value, status,
		       COALESCE(role, 'artist'), COALESCE(custody, 'self'),
		       managed_by, derivation_index, onboarded_at
		FROM node_artists
		WHERE 1=1`
	args := []interface{}{}
	argIdx := 1

	if managedBy != "" {
		query += fmt.Sprintf(" AND managed_by = $%d", argIdx)
		args = append(args, managedBy)
		argIdx++
	}
	if role != "" {
		query += fmt.Sprintf(" AND COALESCE(role, 'artist') = $%d", argIdx)
		args = append(args, role)
	}
	query += " ORDER BY onboarded_at DESC"

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list artists: %w", err)
	}
	defer rows.Close()

	var artists []NodeArtist
	for rows.Next() {
		var a NodeArtist
		if err := rows.Scan(&a.Pubkey, &a.ArtistName, &a.RequestID, &a.FeeModel,
			&a.FeeValue, &a.Status, &a.Role, &a.Custody, &a.ManagedBy,
			&a.DerivationIndex, &a.OnboardedAt); err != nil {
			return nil, fmt.Errorf("scan artist: %w", err)
		}
		artists = append(artists, a)
	}
	return artists, rows.Err()
}

// GetArtist returns a single artist by pubkey.
func (s *AdminStore) GetArtist(ctx context.Context, pubkey string) (*NodeArtist, error) {
	var a NodeArtist
	err := s.pool.QueryRow(ctx, `
		SELECT pubkey, artist_name, request_id, fee_model, fee_value, status,
		       COALESCE(role, 'artist'), COALESCE(custody, 'self'),
		       managed_by, derivation_index, onboarded_at
		FROM node_artists WHERE pubkey = $1
	`, pubkey).Scan(&a.Pubkey, &a.ArtistName, &a.RequestID, &a.FeeModel,
		&a.FeeValue, &a.Status, &a.Role, &a.Custody, &a.ManagedBy,
		&a.DerivationIndex, &a.OnboardedAt)
	if err != nil {
		return nil, nil // not found
	}
	return &a, nil
}

// UpdateArtist updates status, fee_model, and/or fee_value for an artist.
// Pass nil for fields you don't want to change.
func (s *AdminStore) UpdateArtist(ctx context.Context, pubkey string, status, feeModel *string, feeValue *float64) error {
	query := "UPDATE node_artists SET "
	args := []interface{}{}
	parts := []string{}
	argIdx := 1

	if status != nil {
		parts = append(parts, fmt.Sprintf("status = $%d", argIdx))
		args = append(args, *status)
		argIdx++
	}
	if feeModel != nil {
		parts = append(parts, fmt.Sprintf("fee_model = $%d", argIdx))
		args = append(args, *feeModel)
		argIdx++
	}
	if feeValue != nil {
		parts = append(parts, fmt.Sprintf("fee_value = $%d", argIdx))
		args = append(args, *feeValue)
		argIdx++
	}

	if len(parts) == 0 {
		return nil // no changes
	}

	query += parts[0]
	for i := 1; i < len(parts); i++ {
		query += ", " + parts[i]
	}
	query += fmt.Sprintf(" WHERE pubkey = $%d", argIdx)
	args = append(args, pubkey)

	tag, err := s.pool.Exec(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("update artist: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("artist not found")
	}
	return nil
}

// ListAccessRequests returns access requests, optionally filtered by status.
func (s *AdminStore) ListAccessRequests(ctx context.Context, status string) ([]AccessRequest, error) {
	query := `
		SELECT id, artist_name, COALESCE(email, ''), COALESCE(npub, ''),
		       COALESCE(description, ''), COALESCE(links, ''), status,
		       admin_notes, invite_code, invite_used, requested_at, reviewed_at
		FROM access_requests
		WHERE 1=1`
	args := []interface{}{}

	if status != "" {
		query += " AND status = $1"
		args = append(args, status)
	}
	query += " ORDER BY requested_at DESC"

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list access requests: %w", err)
	}
	defer rows.Close()

	var requests []AccessRequest
	for rows.Next() {
		var r AccessRequest
		if err := rows.Scan(&r.ID, &r.ArtistName, &r.Email, &r.Npub,
			&r.Description, &r.Links, &r.Status, &r.AdminNotes,
			&r.InviteCode, &r.InviteUsed, &r.RequestedAt, &r.ReviewedAt); err != nil {
			return nil, fmt.Errorf("scan request: %w", err)
		}
		requests = append(requests, r)
	}
	return requests, rows.Err()
}

// GetAccessRequest returns a single access request by ID.
func (s *AdminStore) GetAccessRequest(ctx context.Context, id int) (*AccessRequest, error) {
	var r AccessRequest
	err := s.pool.QueryRow(ctx, `
		SELECT id, artist_name, COALESCE(email, ''), COALESCE(npub, ''),
		       COALESCE(description, ''), COALESCE(links, ''), status,
		       admin_notes, invite_code, invite_used, requested_at, reviewed_at
		FROM access_requests WHERE id = $1
	`, id).Scan(&r.ID, &r.ArtistName, &r.Email, &r.Npub, &r.Description,
		&r.Links, &r.Status, &r.AdminNotes, &r.InviteCode, &r.InviteUsed,
		&r.RequestedAt, &r.ReviewedAt)
	if err != nil {
		return nil, nil // not found
	}
	return &r, nil
}

// ApproveAccessRequest sets status='approved', generates an invite code, and records reviewed_at.
// Returns the generated invite code.
func (s *AdminStore) ApproveAccessRequest(ctx context.Context, id int, adminNotes string) (string, error) {
	code, err := generateInviteCode()
	if err != nil {
		return "", err
	}

	tag, err := s.pool.Exec(ctx, `
		UPDATE access_requests
		SET status = 'approved', invite_code = $1, admin_notes = $2, reviewed_at = NOW()
		WHERE id = $3 AND status = 'pending'
	`, code, adminNotes, id)
	if err != nil {
		return "", fmt.Errorf("approve request: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return "", fmt.Errorf("request not found or not pending")
	}
	return code, nil
}

// DeclineAccessRequest sets status='declined' and records reviewed_at.
func (s *AdminStore) DeclineAccessRequest(ctx context.Context, id int, adminNotes string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE access_requests
		SET status = 'declined', admin_notes = $1, reviewed_at = NOW()
		WHERE id = $2 AND status = 'pending'
	`, adminNotes, id)
	if err != nil {
		return fmt.Errorf("decline request: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("request not found or not pending")
	}
	return nil
}

// CreateAccessRequest inserts a new pending access request and returns its ID.
func (s *AdminStore) CreateAccessRequest(ctx context.Context, artistName, email, npub, description, links string) (int, error) {
	var id int
	err := s.pool.QueryRow(ctx, `
		INSERT INTO access_requests (artist_name, email, npub, description, links, status)
		VALUES ($1, $2, $3, $4, $5, 'pending')
		RETURNING id
	`, artistName, email, npub, description, links).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("create request: %w", err)
	}
	return id, nil
}

// CreateOrphanInviteCode creates an unused invite code with no associated request.
// Useful for direct-invite flows where the operator generates codes without an upfront request.
func (s *AdminStore) CreateOrphanInviteCode(ctx context.Context) (string, error) {
	code, err := generateInviteCode()
	if err != nil {
		return "", err
	}

	// Insert an "approved" placeholder request to hold the invite code
	_, err = s.pool.Exec(ctx, `
		INSERT INTO access_requests (artist_name, status, invite_code, reviewed_at)
		VALUES ('(direct invite)', 'approved', $1, NOW())
	`, code)
	if err != nil {
		return "", fmt.Errorf("create orphan invite: %w", err)
	}
	return code, nil
}

// ListInviteCodes returns unused invite codes from approved access requests.
func (s *AdminStore) ListInviteCodes(ctx context.Context) ([]map[string]interface{}, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, artist_name, invite_code, reviewed_at
		FROM access_requests
		WHERE status = 'approved' AND invite_code IS NOT NULL AND invite_used = FALSE
		ORDER BY reviewed_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list invite codes: %w", err)
	}
	defer rows.Close()

	var codes []map[string]interface{}
	for rows.Next() {
		var id int
		var artistName, code string
		var reviewedAt time.Time
		if err := rows.Scan(&id, &artistName, &code, &reviewedAt); err != nil {
			return nil, fmt.Errorf("scan invite: %w", err)
		}
		codes = append(codes, map[string]interface{}{
			"request_id":   id,
			"artist_name":  artistName,
			"invite_code":  code,
			"created_at":   reviewedAt,
		})
	}
	return codes, rows.Err()
}

// ListRegisteredUsers returns registered users with pagination.
func (s *AdminStore) ListRegisteredUsers(ctx context.Context, limit, offset int) ([]RegisteredUser, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}

	var total int
	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*) FROM registered_users").Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count registered users: %w", err)
	}

	rows, err := s.pool.Query(ctx, `
		SELECT pubkey, npub, enabled, registered_at, last_seen
		FROM registered_users
		ORDER BY last_seen DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list registered users: %w", err)
	}
	defer rows.Close()

	var users []RegisteredUser
	for rows.Next() {
		var u RegisteredUser
		if err := rows.Scan(&u.Pubkey, &u.Npub, &u.Enabled, &u.RegisteredAt, &u.LastSeen); err != nil {
			return nil, 0, fmt.Errorf("scan user: %w", err)
		}
		users = append(users, u)
	}
	return users, total, rows.Err()
}

// NodeStats returns counts for the operator overview.
func (s *AdminStore) NodeStats(ctx context.Context) (map[string]int, error) {
	stats := make(map[string]int)

	queries := map[string]string{
		"artist_count":      "SELECT COUNT(*) FROM node_artists WHERE COALESCE(role, 'artist') = 'artist'",
		"label_count":       "SELECT COUNT(*) FROM node_artists WHERE role = 'label'",
		"operator_count":    "SELECT COUNT(*) FROM node_operators",
		"user_count":        "SELECT COUNT(*) FROM registered_users",
		"pending_requests":  "SELECT COUNT(*) FROM access_requests WHERE status = 'pending'",
		"event_count":       "SELECT COUNT(*) FROM raw_events",
		"release_count":     "SELECT COUNT(*) FROM cached_tracks",
	}

	for name, q := range queries {
		var n int
		if err := s.pool.QueryRow(ctx, q).Scan(&n); err != nil {
			return nil, fmt.Errorf("stat %s: %w", name, err)
		}
		stats[name] = n
	}
	return stats, nil
}

// generateInviteCode creates a 12-char random hex code.
func generateInviteCode() (string, error) {
	b := make([]byte, 6) // 6 bytes = 12 hex chars
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate invite code: %w", err)
	}
	return hex.EncodeToString(b), nil
}
