package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DelegationStore handles NIP-26 delegation request + grant lifecycle.
type DelegationStore struct {
	pool *pgxpool.Pool
}

func NewDelegationStore(pool *pgxpool.Pool) *DelegationStore {
	return &DelegationStore{pool: pool}
}

// ===== Types =====

// DelegationRequest is a row from delegation_requests.
type DelegationRequest struct {
	ID                    int        `json:"id"`
	LabelPubkey           string     `json:"label_pubkey"`
	ArtistPubkey          string     `json:"artist_pubkey"`
	RequestedKinds        string     `json:"requested_kinds"`
	RequestedDurationDays int        `json:"requested_duration_days"`
	Note                  *string    `json:"note,omitempty"`
	Status                string     `json:"status"`
	CreatedAt             time.Time  `json:"created_at"`
	RespondedAt           *time.Time `json:"responded_at,omitempty"`
}

// Delegation is a row from artist_delegations.
type Delegation struct {
	ID           int        `json:"id"`
	ArtistPubkey string     `json:"artist_pubkey"`
	LabelPubkey  string     `json:"label_pubkey"`
	Conditions   string     `json:"conditions"`
	Signature    string     `json:"signature"`
	RequestID    *int       `json:"request_id,omitempty"`
	GrantedAt    time.Time  `json:"granted_at"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
	RevokedAt    *time.Time `json:"revoked_at,omitempty"`
}

// ===== Requests =====

// CreateRequest inserts a new pending delegation request from a label to an artist.
// Returns the new request ID.
func (s *DelegationStore) CreateRequest(
	ctx context.Context,
	labelPubkey, artistPubkey, requestedKinds string,
	durationDays int,
	note string,
) (int, error) {
	if requestedKinds == "" {
		requestedKinds = "30050,5"
	}
	if durationDays <= 0 {
		durationDays = 365
	}
	var notePtr *string
	if note != "" {
		notePtr = &note
	}
	var id int
	err := s.pool.QueryRow(ctx, `
		INSERT INTO delegation_requests (label_pubkey, artist_pubkey, requested_kinds, requested_duration_days, note, status)
		VALUES ($1, $2, $3, $4, $5, 'pending')
		RETURNING id
	`, labelPubkey, artistPubkey, requestedKinds, durationDays, notePtr).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("create delegation request: %w", err)
	}
	return id, nil
}

// ListRequestsForArtist returns delegation requests where the artist is the recipient.
// status="" returns all statuses.
func (s *DelegationStore) ListRequestsForArtist(ctx context.Context, artist, status string) ([]DelegationRequest, error) {
	return s.listRequests(ctx, "artist_pubkey", artist, status)
}

// ListRequestsForLabel returns delegation requests where the label is the requester.
func (s *DelegationStore) ListRequestsForLabel(ctx context.Context, label, status string) ([]DelegationRequest, error) {
	return s.listRequests(ctx, "label_pubkey", label, status)
}

func (s *DelegationStore) listRequests(ctx context.Context, col, val, status string) ([]DelegationRequest, error) {
	q := `
		SELECT id, label_pubkey, artist_pubkey, requested_kinds, requested_duration_days,
		       note, status, created_at, responded_at
		FROM delegation_requests
		WHERE ` + col + ` = $1`
	args := []interface{}{val}
	if status != "" {
		q += " AND status = $2"
		args = append(args, status)
	}
	q += " ORDER BY created_at DESC"

	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list delegation requests: %w", err)
	}
	defer rows.Close()

	out := []DelegationRequest{}
	for rows.Next() {
		var r DelegationRequest
		if err := rows.Scan(&r.ID, &r.LabelPubkey, &r.ArtistPubkey, &r.RequestedKinds,
			&r.RequestedDurationDays, &r.Note, &r.Status, &r.CreatedAt, &r.RespondedAt); err != nil {
			return nil, fmt.Errorf("scan delegation request: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetRequest returns a single delegation request by ID.
func (s *DelegationStore) GetRequest(ctx context.Context, id int) (*DelegationRequest, error) {
	var r DelegationRequest
	err := s.pool.QueryRow(ctx, `
		SELECT id, label_pubkey, artist_pubkey, requested_kinds, requested_duration_days,
		       note, status, created_at, responded_at
		FROM delegation_requests WHERE id = $1
	`, id).Scan(&r.ID, &r.LabelPubkey, &r.ArtistPubkey, &r.RequestedKinds,
		&r.RequestedDurationDays, &r.Note, &r.Status, &r.CreatedAt, &r.RespondedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get delegation request: %w", err)
	}
	return &r, nil
}

// ===== Grant / Decline =====

// GrantDelegation atomically:
//   1. Verifies the conditions string + signature against the request's artist pubkey
//   2. Marks the request as granted
//   3. Inserts/updates the artist_delegations row
//
// Returns the granted delegation. The verification step prevents a malicious caller from
// granting on behalf of an artist they don't control.
func (s *DelegationStore) GrantDelegation(
	ctx context.Context,
	requestID int,
	conditions, signature string,
) (*Delegation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	// Lock + read the request
	var label, artist, status string
	var durationDays int
	err = tx.QueryRow(ctx, `
		SELECT label_pubkey, artist_pubkey, requested_duration_days, status
		FROM delegation_requests WHERE id = $1 FOR UPDATE
	`, requestID).Scan(&label, &artist, &durationDays, &status)
	if err == pgx.ErrNoRows {
		return nil, fmt.Errorf("request not found")
	}
	if err != nil {
		return nil, fmt.Errorf("read request: %w", err)
	}
	if status != "pending" {
		return nil, fmt.Errorf("request already %s", status)
	}

	// Verify the NIP-26 delegation signature
	if err := VerifyDelegationSignature(artist, label, conditions, signature); err != nil {
		return nil, fmt.Errorf("invalid delegation signature: %w", err)
	}

	// Parse expires_at from the conditions string (created_at<NNN)
	expires := parseExpiresAt(conditions)

	// Mark request granted
	_, err = tx.Exec(ctx, `
		UPDATE delegation_requests SET status = 'granted', responded_at = NOW() WHERE id = $1
	`, requestID)
	if err != nil {
		return nil, fmt.Errorf("mark granted: %w", err)
	}

	// Upsert delegation row
	_, err = tx.Exec(ctx, `
		INSERT INTO artist_delegations (artist_pubkey, label_pubkey, conditions, signature, request_id, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (artist_pubkey, label_pubkey) DO UPDATE
		SET conditions = EXCLUDED.conditions,
		    signature = EXCLUDED.signature,
		    request_id = EXCLUDED.request_id,
		    granted_at = NOW(),
		    expires_at = EXCLUDED.expires_at,
		    revoked_at = NULL
	`, artist, label, conditions, signature, requestID, expires)
	if err != nil {
		return nil, fmt.Errorf("upsert delegation: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	// Read back
	return s.GetActiveDelegation(ctx, artist, label)
}

// DeclineRequest marks a request declined. Caller must verify the artist identity at the API layer.
func (s *DelegationStore) DeclineRequest(ctx context.Context, requestID int) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE delegation_requests
		SET status = 'declined', responded_at = NOW()
		WHERE id = $1 AND status = 'pending'
	`, requestID)
	if err != nil {
		return fmt.Errorf("decline request: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("request not found or not pending")
	}
	return nil
}

// ===== Active delegations =====

// ListActiveDelegationsForLabel returns the label's active (non-revoked, non-expired) delegations.
func (s *DelegationStore) ListActiveDelegationsForLabel(ctx context.Context, label string) ([]Delegation, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, artist_pubkey, label_pubkey, conditions, signature, request_id, granted_at, expires_at, revoked_at
		FROM artist_delegations
		WHERE label_pubkey = $1
		  AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())
		ORDER BY granted_at DESC
	`, label)
	if err != nil {
		return nil, fmt.Errorf("list active delegations: %w", err)
	}
	defer rows.Close()

	out := []Delegation{}
	for rows.Next() {
		var d Delegation
		if err := rows.Scan(&d.ID, &d.ArtistPubkey, &d.LabelPubkey, &d.Conditions, &d.Signature,
			&d.RequestID, &d.GrantedAt, &d.ExpiresAt, &d.RevokedAt); err != nil {
			return nil, fmt.Errorf("scan delegation: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// GetActiveDelegation returns the active (non-revoked, non-expired) delegation for (artist, label),
// or nil if none.
func (s *DelegationStore) GetActiveDelegation(ctx context.Context, artist, label string) (*Delegation, error) {
	var d Delegation
	err := s.pool.QueryRow(ctx, `
		SELECT id, artist_pubkey, label_pubkey, conditions, signature, request_id, granted_at, expires_at, revoked_at
		FROM artist_delegations
		WHERE artist_pubkey = $1 AND label_pubkey = $2
		  AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())
	`, artist, label).Scan(&d.ID, &d.ArtistPubkey, &d.LabelPubkey, &d.Conditions, &d.Signature,
		&d.RequestID, &d.GrantedAt, &d.ExpiresAt, &d.RevokedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get active delegation: %w", err)
	}
	return &d, nil
}

// RevokeDelegation marks the delegation revoked.
func (s *DelegationStore) RevokeDelegation(ctx context.Context, artist, label string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE artist_delegations
		SET revoked_at = NOW()
		WHERE artist_pubkey = $1 AND label_pubkey = $2 AND revoked_at IS NULL
	`, artist, label)
	if err != nil {
		return fmt.Errorf("revoke: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("no active delegation found")
	}
	return nil
}

// ===== NIP-26 verification =====

// VerifyDelegationSignature checks that `signature` is a valid BIP-340 Schnorr signature
// of sha256("nostr:delegation:" + delegateePubkey + ":" + conditions) by delegatorPubkey.
func VerifyDelegationSignature(delegatorPubkey, delegateePubkey, conditions, signature string) error {
	canonical := "nostr:delegation:" + delegateePubkey + ":" + conditions
	digest := sha256.Sum256([]byte(canonical))

	pkBytes, err := hex.DecodeString(delegatorPubkey)
	if err != nil || len(pkBytes) != 32 {
		return fmt.Errorf("invalid delegator pubkey")
	}
	sigBytes, err := hex.DecodeString(signature)
	if err != nil || len(sigBytes) != 64 {
		return fmt.Errorf("invalid signature shape")
	}

	pubkey, err := btcec.ParsePubKey(append([]byte{0x02}, pkBytes...))
	if err != nil {
		return fmt.Errorf("parse pubkey: %w", err)
	}
	sig, err := schnorr.ParseSignature(sigBytes)
	if err != nil {
		return fmt.Errorf("parse sig: %w", err)
	}
	if !sig.Verify(digest[:], pubkey) {
		return fmt.Errorf("signature verification failed")
	}
	return nil
}

// ConditionsAllow checks whether a NIP-26 conditions string permits an event of the given
// kind at the given Unix timestamp. Used by the relay denorm parser AND by the orchestrator's
// publish endpoint.
//
// Supports kind=N (one of), created_at>X, created_at<Y. Multiple kind= clauses join via OR.
func ConditionsAllow(conditions string, eventKind int, eventCreatedAt int64) bool {
	if conditions == "" {
		return false
	}
	allowedKinds := map[int]bool{}
	var minTime, maxTime int64 = 0, 0

	for _, clause := range strings.Split(conditions, "&") {
		clause = strings.TrimSpace(clause)
		if clause == "" {
			continue
		}
		switch {
		case strings.HasPrefix(clause, "kind="):
			if k, err := strconv.Atoi(strings.TrimPrefix(clause, "kind=")); err == nil {
				allowedKinds[k] = true
			}
		case strings.HasPrefix(clause, "created_at>"):
			if t, err := strconv.ParseInt(strings.TrimPrefix(clause, "created_at>"), 10, 64); err == nil {
				if t > minTime {
					minTime = t
				}
			}
		case strings.HasPrefix(clause, "created_at<"):
			if t, err := strconv.ParseInt(strings.TrimPrefix(clause, "created_at<"), 10, 64); err == nil {
				if maxTime == 0 || t < maxTime {
					maxTime = t
				}
			}
		}
	}

	if len(allowedKinds) > 0 && !allowedKinds[eventKind] {
		return false
	}
	if minTime > 0 && eventCreatedAt <= minTime {
		return false
	}
	if maxTime > 0 && eventCreatedAt >= maxTime {
		return false
	}
	return true
}

// parseExpiresAt extracts the latest created_at< constraint from a conditions string,
// returns it as a *time.Time, or nil if no upper bound is set.
func parseExpiresAt(conditions string) *time.Time {
	for _, clause := range strings.Split(conditions, "&") {
		if strings.HasPrefix(clause, "created_at<") {
			if t, err := strconv.ParseInt(strings.TrimPrefix(clause, "created_at<"), 10, 64); err == nil {
				expires := time.Unix(t, 0)
				return &expires
			}
		}
	}
	return nil
}
