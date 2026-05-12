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
	Pubkey           string    `json:"pubkey"`
	ArtistName       string    `json:"artist_name"`
	RequestID        *int      `json:"request_id,omitempty"`
	FeeModel         string    `json:"fee_model"`
	FeeValue         float64   `json:"fee_value"`
	Status           string    `json:"status"`
	Role             string    `json:"role"`
	Custody          string    `json:"custody"`
	ManagedBy        *string   `json:"managed_by,omitempty"`
	DerivationIndex  *int      `json:"derivation_index,omitempty"`
	OnboardedAt      time.Time `json:"onboarded_at"`
	// Phase G: how the artist works with their current label
	RelationshipType string `json:"relationship_type"` // 'self' | 'managed' | 'signed'
}

// AccessRequest represents a row from access_requests.
type AccessRequest struct {
	ID              int        `json:"id"`
	ArtistName      string     `json:"artist_name"`
	Email           string     `json:"email"`
	Npub            string     `json:"npub"`
	Description     string     `json:"description"`
	Links           string     `json:"links"`
	Status          string     `json:"status"`
	AdminNotes      *string    `json:"admin_notes,omitempty"`
	InviteCode      *string    `json:"invite_code,omitempty"`
	InviteUsed      bool       `json:"invite_used"`
	RequestedAt     time.Time  `json:"requested_at"`
	ReviewedAt      *time.Time `json:"reviewed_at,omitempty"`
	// Phase A access-control metadata
	RequestedRole   string  `json:"requested_role"`              // 'artist' | 'label' (what /join was filled out for)
	TargetRole      string  `json:"target_role"`                 // 'artist' | 'label' | 'operator' (what the code grants)
	TargetManagedBy *string `json:"target_managed_by,omitempty"` // pubkey of label whose roster the new artist joins
	IssuedBy        *string `json:"issued_by,omitempty"`         // pubkey of label/operator who generated/approved the code
	// Phase G: relationship type the invite carries — set on the artist's node_artists row at redeem time
	TargetRelationshipType string `json:"target_relationship_type"` // 'managed' (default Phase F) | 'signed' (Phase G label-rights)
}

// RedeemResult is what RedeemInviteCode returns to the API layer.
// For artist/label codes, NodeArtist is populated. For operator codes, NodeOperator is populated.
type RedeemResult struct {
	Role         string        `json:"role"` // 'artist' | 'label' | 'operator'
	NodeArtist   *NodeArtist   `json:"node_artist,omitempty"`
	NodeOperator *NodeOperator `json:"node_operator,omitempty"`
}

// NodeOperator represents a row from node_operators (mirror of NodeArtist for the operator branch).
type NodeOperator struct {
	Pubkey  string    `json:"pubkey"`
	Name    string    `json:"name"`
	AddedAt time.Time `json:"added_at"`
}

// SetupState represents the (single-row) setup_state table for first-run claims.
type SetupState struct {
	SetupToken  *string    `json:"setup_token,omitempty"`
	GeneratedAt time.Time  `json:"generated_at"`
	ClaimedAt   *time.Time `json:"claimed_at,omitempty"`
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
		       managed_by, derivation_index, onboarded_at,
		       COALESCE(relationship_type, 'managed')
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
			&a.DerivationIndex, &a.OnboardedAt, &a.RelationshipType); err != nil {
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
		       managed_by, derivation_index, onboarded_at,
		       COALESCE(relationship_type, 'managed')
		FROM node_artists WHERE pubkey = $1
	`, pubkey).Scan(&a.Pubkey, &a.ArtistName, &a.RequestID, &a.FeeModel,
		&a.FeeValue, &a.Status, &a.Role, &a.Custody, &a.ManagedBy,
		&a.DerivationIndex, &a.OnboardedAt, &a.RelationshipType)
	if err != nil {
		return nil, nil // not found
	}
	return &a, nil
}

// UpdateArtist updates status, fee_model, fee_value, relationship_type, and/or managed_by for an artist.
// Pass nil for fields you don't want to change.
func (s *AdminStore) UpdateArtist(
	ctx context.Context,
	pubkey string,
	status, feeModel *string,
	feeValue *float64,
	relationshipType *string,
	managedBy *string, // empty string clears (sets to NULL)
) error {
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
	if relationshipType != nil {
		parts = append(parts, fmt.Sprintf("relationship_type = $%d", argIdx))
		args = append(args, *relationshipType)
		argIdx++
	}
	if managedBy != nil {
		if *managedBy == "" {
			parts = append(parts, "managed_by = NULL")
		} else {
			parts = append(parts, fmt.Sprintf("managed_by = $%d", argIdx))
			args = append(args, *managedBy)
			argIdx++
		}
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
		       admin_notes, invite_code, invite_used, requested_at, reviewed_at,
		       COALESCE(requested_role, 'artist'), COALESCE(target_role, 'artist'),
		       target_managed_by, issued_by,
		       COALESCE(target_relationship_type, 'managed')
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
			&r.InviteCode, &r.InviteUsed, &r.RequestedAt, &r.ReviewedAt,
			&r.RequestedRole, &r.TargetRole, &r.TargetManagedBy, &r.IssuedBy,
			&r.TargetRelationshipType); err != nil {
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
		       admin_notes, invite_code, invite_used, requested_at, reviewed_at,
		       COALESCE(requested_role, 'artist'), COALESCE(target_role, 'artist'),
		       target_managed_by, issued_by,
		       COALESCE(target_relationship_type, 'managed')
		FROM access_requests WHERE id = $1
	`, id).Scan(&r.ID, &r.ArtistName, &r.Email, &r.Npub, &r.Description,
		&r.Links, &r.Status, &r.AdminNotes, &r.InviteCode, &r.InviteUsed,
		&r.RequestedAt, &r.ReviewedAt,
		&r.RequestedRole, &r.TargetRole, &r.TargetManagedBy, &r.IssuedBy,
		&r.TargetRelationshipType)
	if err != nil {
		return nil, nil // not found
	}
	return &r, nil
}

// GetInviteCode returns a single access_requests row by its invite_code.
// Used by the public check-invite endpoint to preview a code before redeem.
// Returns nil if the code doesn't exist or has been used.
func (s *AdminStore) GetInviteCode(ctx context.Context, code string) (*AccessRequest, error) {
	var r AccessRequest
	err := s.pool.QueryRow(ctx, `
		SELECT id, artist_name, COALESCE(email, ''), COALESCE(npub, ''),
		       COALESCE(description, ''), COALESCE(links, ''), status,
		       admin_notes, invite_code, invite_used, requested_at, reviewed_at,
		       COALESCE(requested_role, 'artist'), COALESCE(target_role, 'artist'),
		       target_managed_by, issued_by,
		       COALESCE(target_relationship_type, 'managed')
		FROM access_requests
		WHERE invite_code = $1 AND status = 'approved' AND invite_used = FALSE
	`, code).Scan(&r.ID, &r.ArtistName, &r.Email, &r.Npub, &r.Description,
		&r.Links, &r.Status, &r.AdminNotes, &r.InviteCode, &r.InviteUsed,
		&r.RequestedAt, &r.ReviewedAt,
		&r.RequestedRole, &r.TargetRole, &r.TargetManagedBy, &r.IssuedBy,
		&r.TargetRelationshipType)
	if err != nil {
		return nil, nil // not found / not redeemable
	}
	return &r, nil
}

// ApproveAccessRequest sets status='approved', generates an invite code, and records reviewed_at.
// targetRole defaults to the request's requested_role (or 'artist' if neither is set).
// targetManagedBy may be NULL for unmanaged artists, or a label pubkey for roster grants.
// targetRelationshipType is the Phase G recording-rights model ('self' | 'managed' | 'signed').
// issuedBy is the pubkey of the operator/label who approved (audit).
// Returns the generated invite code.
func (s *AdminStore) ApproveAccessRequest(
	ctx context.Context,
	id int,
	adminNotes string,
	targetRole string,
	targetManagedBy *string,
	targetRelationshipType string,
	issuedBy string,
) (string, error) {
	if targetRole == "" {
		targetRole = "artist"
	}
	if targetRelationshipType == "" {
		targetRelationshipType = "managed"
	}
	code, err := s.generateUniqueInviteCode(ctx)
	if err != nil {
		return "", err
	}

	tag, err := s.pool.Exec(ctx, `
		UPDATE access_requests
		SET status = 'approved', invite_code = $1, admin_notes = $2, reviewed_at = NOW(),
		    target_role = $3, target_managed_by = $4, issued_by = $5,
		    target_relationship_type = $6
		WHERE id = $7 AND status = 'pending'
	`, code, adminNotes, targetRole, targetManagedBy, nullableString(issuedBy),
		targetRelationshipType, id)
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
// requestedRole captures what the applicant asked for on /join ('artist' | 'label').
// targetRelationshipType seeds Phase G recording-rights mode ('managed' default).
func (s *AdminStore) CreateAccessRequest(
	ctx context.Context,
	requestedRole, artistName, email, npub, description, links, targetRelationshipType string,
) (int, error) {
	if requestedRole == "" {
		requestedRole = "artist"
	}
	if targetRelationshipType == "" {
		targetRelationshipType = "managed"
	}
	var id int
	err := s.pool.QueryRow(ctx, `
		INSERT INTO access_requests (artist_name, email, npub, description, links, status,
		                              requested_role, target_relationship_type)
		VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
		RETURNING id
	`, artistName, email, npub, description, links, requestedRole,
		targetRelationshipType).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("create request: %w", err)
	}
	return id, nil
}

// CreateOrphanInviteCode creates an unused invite code with no associated request.
// targetRole ∈ {'artist', 'label', 'operator'} (default 'artist').
// targetManagedBy is the label pubkey for roster invites; nil otherwise.
// targetRelationshipType is the Phase G recording-rights model ('self' | 'managed' | 'signed').
// Operator codes always carry 'self' (operators don't have a label relationship).
// issuedBy is the pubkey of the operator/label who generated the code (audit).
func (s *AdminStore) CreateOrphanInviteCode(
	ctx context.Context,
	targetRole string,
	targetManagedBy *string,
	targetRelationshipType string,
	issuedBy string,
) (string, error) {
	if targetRole == "" {
		targetRole = "artist"
	}
	if targetRelationshipType == "" {
		targetRelationshipType = "managed"
	}
	// Operator codes never carry target_managed_by — strip it. Operators have no label relationship.
	if targetRole == "operator" {
		targetManagedBy = nil
		targetRelationshipType = "self"
	}
	// Labels are 'self' by default — they don't sit under another label.
	if targetRole == "label" && targetManagedBy == nil {
		targetRelationshipType = "self"
	}
	code, err := s.generateUniqueInviteCode(ctx)
	if err != nil {
		return "", err
	}

	// Insert an "approved" placeholder request to hold the invite code
	_, err = s.pool.Exec(ctx, `
		INSERT INTO access_requests (artist_name, status, invite_code, reviewed_at,
		                              target_role, target_managed_by, issued_by,
		                              target_relationship_type)
		VALUES ('(direct invite)', 'approved', $1, NOW(), $2, $3, $4, $5)
	`, code, targetRole, targetManagedBy, nullableString(issuedBy), targetRelationshipType)
	if err != nil {
		return "", fmt.Errorf("create orphan invite: %w", err)
	}
	return code, nil
}

// ListInviteCodes returns unused invite codes from approved access requests.
func (s *AdminStore) ListInviteCodes(ctx context.Context) ([]map[string]interface{}, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, artist_name, invite_code, reviewed_at,
		       COALESCE(target_role, 'artist'), target_managed_by, issued_by,
		       COALESCE(target_relationship_type, 'managed')
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
		var artistName, code, targetRole, targetRelType string
		var reviewedAt time.Time
		var targetManagedBy, issuedBy *string
		if err := rows.Scan(&id, &artistName, &code, &reviewedAt,
			&targetRole, &targetManagedBy, &issuedBy, &targetRelType); err != nil {
			return nil, fmt.Errorf("scan invite: %w", err)
		}
		codes = append(codes, map[string]interface{}{
			"request_id":               id,
			"artist_name":              artistName,
			"invite_code":              code,
			"created_at":               reviewedAt,
			"target_role":              targetRole,
			"target_managed_by":        targetManagedBy,
			"issued_by":                issuedBy,
			"target_relationship_type": targetRelType,
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

// generateUniqueInviteCode generates a code and confirms it's not already in use.
// Retries up to 3x on collision (extremely unlikely with 48 bits of entropy but defensive).
func (s *AdminStore) generateUniqueInviteCode(ctx context.Context) (string, error) {
	for attempt := 0; attempt < 3; attempt++ {
		code, err := generateInviteCode()
		if err != nil {
			return "", err
		}
		var exists bool
		if err := s.pool.QueryRow(ctx,
			"SELECT EXISTS(SELECT 1 FROM access_requests WHERE invite_code = $1)", code,
		).Scan(&exists); err != nil {
			return "", fmt.Errorf("check invite collision: %w", err)
		}
		if !exists {
			return code, nil
		}
	}
	return "", fmt.Errorf("invite code collision: 3 attempts failed")
}

// nullableString returns a *string that's nil when the input is empty.
func nullableString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ===== RedeemInviteCode =====

// RedeemErr categorises redemption failures so callers can return appropriate HTTP statuses.
type RedeemErr struct {
	Code    string // "invalid_code" | "already_used" | "concurrent_redeem" | "already_managed_by_other"
	Message string
}

func (e *RedeemErr) Error() string { return e.Message }

// RedeemInviteCode atomically validates an invite code, marks it used, and inserts the
// appropriate row (node_artists for artist/label, node_operators for operator).
// pubkey is the verified caller (NIP-98). displayName is the artist_name / operator name.
//
// Returns:
//   - *RedeemResult with Role + populated NodeArtist or NodeOperator on success
//   - *RedeemErr with a Code categorising the failure on user-facing errors
//   - generic error on internal/unexpected failures
func (s *AdminStore) RedeemInviteCode(
	ctx context.Context,
	code, pubkey, displayName string,
) (*RedeemResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// 1. Read + lock the access_requests row
	var (
		reqID           int
		targetRole      string
		targetManagedBy *string
		targetRelType   string
		status          string
		inviteUsed      bool
	)
	err = tx.QueryRow(ctx, `
		SELECT id, COALESCE(target_role, 'artist'), target_managed_by,
		       COALESCE(target_relationship_type, 'managed'),
		       status, invite_used
		FROM access_requests
		WHERE invite_code = $1
		FOR UPDATE
	`, code).Scan(&reqID, &targetRole, &targetManagedBy, &targetRelType, &status, &inviteUsed)
	if err != nil {
		return nil, &RedeemErr{Code: "invalid_code", Message: "invite code not found"}
	}
	if status != "approved" {
		return nil, &RedeemErr{Code: "invalid_code", Message: "invite code not approved"}
	}
	if inviteUsed {
		return nil, &RedeemErr{Code: "already_used", Message: "invite code already used"}
	}

	// 2. Mark code used. Predicate guards against concurrent redeem winners.
	tag, err := tx.Exec(ctx, `
		UPDATE access_requests
		SET invite_used = TRUE, reviewed_at = COALESCE(reviewed_at, NOW())
		WHERE id = $1 AND invite_used = FALSE
	`, reqID)
	if err != nil {
		return nil, fmt.Errorf("mark used: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, &RedeemErr{Code: "concurrent_redeem", Message: "another session redeemed this code first"}
	}

	// 3. Branch on target_role: artist/label go to node_artists, operator to node_operators.
	result := &RedeemResult{Role: targetRole}

	if targetRole == "operator" {
		_, err := tx.Exec(ctx, `
			INSERT INTO node_operators (pubkey, name)
			VALUES ($1, $2)
			ON CONFLICT (pubkey) DO NOTHING
		`, pubkey, displayName)
		if err != nil {
			return nil, fmt.Errorf("insert operator: %w", err)
		}
		var op NodeOperator
		if err := tx.QueryRow(ctx,
			"SELECT pubkey, name, added_at FROM node_operators WHERE pubkey = $1", pubkey,
		).Scan(&op.Pubkey, &op.Name, &op.AddedAt); err != nil {
			return nil, fmt.Errorf("read operator: %w", err)
		}
		result.NodeOperator = &op
	} else {
		// artist or label
		// Check for existing row with conflicting managed_by
		var existingManagedBy *string
		var existingRole string
		err := tx.QueryRow(ctx,
			"SELECT COALESCE(role, 'artist'), managed_by FROM node_artists WHERE pubkey = $1",
			pubkey,
		).Scan(&existingRole, &existingManagedBy)
		exists := err == nil

		if exists && existingManagedBy != nil && targetManagedBy != nil &&
			*existingManagedBy != *targetManagedBy {
			return nil, &RedeemErr{
				Code:    "already_managed_by_other",
				Message: "this pubkey is already managed by a different label",
			}
		}

		// INSERT or UPDATE — preserve existing managed_by if set, only upgrade role artist→label.
		// relationship_type takes the invite's value on insert; on conflict (existing row), the
		// invite wins because Phase G allows roster moves (Magic→Sony) to flip the type.
		_, err = tx.Exec(ctx, `
			INSERT INTO node_artists (pubkey, artist_name, request_id, role, managed_by, status, relationship_type)
			VALUES ($1, $2, $3, $4, $5, 'active', $6)
			ON CONFLICT (pubkey) DO UPDATE
			SET managed_by = COALESCE(node_artists.managed_by, EXCLUDED.managed_by),
			    role = CASE
			      WHEN node_artists.role = 'artist' AND EXCLUDED.role = 'label' THEN 'label'
			      ELSE node_artists.role
			    END,
			    request_id = COALESCE(node_artists.request_id, EXCLUDED.request_id),
			    relationship_type = EXCLUDED.relationship_type
		`, pubkey, displayName, reqID, targetRole, targetManagedBy, targetRelType)
		if err != nil {
			return nil, fmt.Errorf("insert/update artist: %w", err)
		}

		var a NodeArtist
		err = tx.QueryRow(ctx, `
			SELECT pubkey, artist_name, request_id, fee_model, fee_value, status,
			       COALESCE(role, 'artist'), COALESCE(custody, 'self'),
			       managed_by, derivation_index, onboarded_at,
			       COALESCE(relationship_type, 'managed')
			FROM node_artists WHERE pubkey = $1
		`, pubkey).Scan(&a.Pubkey, &a.ArtistName, &a.RequestID, &a.FeeModel, &a.FeeValue,
			&a.Status, &a.Role, &a.Custody, &a.ManagedBy, &a.DerivationIndex, &a.OnboardedAt,
			&a.RelationshipType)
		if err != nil {
			return nil, fmt.Errorf("read artist: %w", err)
		}
		result.NodeArtist = &a
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return result, nil
}

// ===== Setup-token methods (first-run operator claim) =====

// HasOperators reports whether any operator is configured on this node.
func (s *AdminStore) HasOperators(ctx context.Context) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM node_operators)").Scan(&exists)
	return exists, err
}

// GenerateSetupToken creates a 32-byte hex setup token and stores it in setup_state.
// Overwrites any existing token. Returns the token.
func (s *AdminStore) GenerateSetupToken(ctx context.Context) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate setup token: %w", err)
	}
	token := hex.EncodeToString(b)
	_, err := s.pool.Exec(ctx, `
		UPDATE setup_state
		SET setup_token = $1, generated_at = NOW(), claimed_at = NULL
		WHERE id = 1
	`, token)
	if err != nil {
		return "", fmt.Errorf("store setup token: %w", err)
	}
	return token, nil
}

// GetSetupToken returns the current setup_token (or "" if none / already claimed).
func (s *AdminStore) GetSetupToken(ctx context.Context) (string, error) {
	var token *string
	err := s.pool.QueryRow(ctx, "SELECT setup_token FROM setup_state WHERE id = 1").Scan(&token)
	if err != nil {
		return "", err
	}
	if token == nil {
		return "", nil
	}
	return *token, nil
}

// ClearSetupToken removes the current setup token (called on successful claim or when an
// operator already exists so a stale token isn't usable).
func (s *AdminStore) ClearSetupToken(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE setup_state SET setup_token = NULL WHERE id = 1
	`)
	return err
}

// ClaimFirstOperator atomically claims the first operator slot using the setup token.
// Returns *RedeemErr with categorised codes for user-facing failures, or generic error otherwise.
func (s *AdminStore) ClaimFirstOperator(
	ctx context.Context,
	token, pubkey, name string,
) (*NodeOperator, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Lock setup_state row + verify token
	var stored *string
	err = tx.QueryRow(ctx,
		"SELECT setup_token FROM setup_state WHERE id = 1 FOR UPDATE",
	).Scan(&stored)
	if err != nil {
		return nil, fmt.Errorf("read setup_state: %w", err)
	}
	if stored == nil || *stored == "" {
		return nil, &RedeemErr{Code: "no_token", Message: "no setup token active (already claimed?)"}
	}
	if *stored != token {
		return nil, &RedeemErr{Code: "invalid_token", Message: "setup token does not match"}
	}

	// Confirm no operator exists yet (race guard)
	var hasOps bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM node_operators)").Scan(&hasOps); err != nil {
		return nil, fmt.Errorf("check operators: %w", err)
	}
	if hasOps {
		return nil, &RedeemErr{Code: "already_claimed", Message: "node already has an operator"}
	}

	// Insert operator
	if _, err := tx.Exec(ctx,
		"INSERT INTO node_operators (pubkey, name) VALUES ($1, $2)",
		pubkey, name,
	); err != nil {
		return nil, fmt.Errorf("insert operator: %w", err)
	}

	// Clear token
	if _, err := tx.Exec(ctx,
		"UPDATE setup_state SET setup_token = NULL, claimed_at = NOW() WHERE id = 1",
	); err != nil {
		return nil, fmt.Errorf("clear token: %w", err)
	}

	// Read back
	var op NodeOperator
	if err := tx.QueryRow(ctx,
		"SELECT pubkey, name, added_at FROM node_operators WHERE pubkey = $1", pubkey,
	).Scan(&op.Pubkey, &op.Name, &op.AddedAt); err != nil {
		return nil, fmt.Errorf("read operator: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return &op, nil
}
