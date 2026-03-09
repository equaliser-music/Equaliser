package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"equaliser-relay/internal/nostr"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EventStore handles all event CRUD operations against PostgreSQL.
type EventStore struct {
	pool *pgxpool.Pool
}

// NewEventStore creates a new EventStore.
func NewEventStore(pool *pgxpool.Pool) *EventStore {
	return &EventStore{pool: pool}
}

// Pool returns the underlying connection pool (for transactions).
func (s *EventStore) Pool() *pgxpool.Pool {
	return s.pool
}

// StoreEvent inserts an event into raw_events and its tags into event_tags.
// Must be called within a transaction. Returns false if the event already exists (dedup).
func (s *EventStore) StoreEvent(ctx context.Context, tx pgx.Tx, event *nostr.Event) (bool, error) {
	rawJSON, err := event.MarshalRaw()
	if err != nil {
		return false, fmt.Errorf("marshal event: %w", err)
	}

	// Insert into raw_events (ON CONFLICT = dedup, avoids separate EXISTS check)
	tag, err := tx.Exec(ctx, `
		INSERT INTO raw_events (id, pubkey, kind, created_at, content, sig, raw)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO NOTHING
	`, event.ID, event.PubKey, event.Kind, event.CreatedAt, event.Content, event.Sig, rawJSON)
	if err != nil {
		return false, fmt.Errorf("insert raw_event: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil // Duplicate
	}

	// Insert tags
	if len(event.Tags) > 0 {
		if err := s.storeTags(ctx, tx, event); err != nil {
			return false, fmt.Errorf("store tags: %w", err)
		}
	}

	return true, nil
}

// storeTags batch-inserts event tags into event_tags.
func (s *EventStore) storeTags(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	// Build batch insert
	rows := [][]interface{}{}
	for i, tag := range event.Tags {
		if len(tag) < 2 {
			continue // skip tags without a value
		}
		rows = append(rows, []interface{}{event.ID, tag[0], tag[1], i})
	}

	if len(rows) == 0 {
		return nil
	}

	_, err := tx.CopyFrom(
		ctx,
		pgx.Identifier{"event_tags"},
		[]string{"event_id", "tag_name", "tag_value", "tag_index"},
		pgx.CopyFromRows(rows),
	)
	return err
}

// EventExists checks if an event with the given ID already exists.
func (s *EventStore) EventExists(ctx context.Context, eventID string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM raw_events WHERE id = $1)", eventID).Scan(&exists)
	return exists, err
}

// DeleteEvent removes an event from raw_events. Tags cascade automatically.
func (s *EventStore) DeleteEvent(ctx context.Context, tx pgx.Tx, eventID string) error {
	_, err := tx.Exec(ctx, "DELETE FROM raw_events WHERE id = $1", eventID)
	return err
}

// HandleReplaceable checks for and handles replaceable event logic.
// Returns (shouldStore, error). If shouldStore is false, the event should be rejected.
func (s *EventStore) HandleReplaceable(ctx context.Context, tx pgx.Tx, event *nostr.Event) (bool, error) {
	if nostr.IsReplaceable(event.Kind) {
		// Replaceable: same pubkey + kind
		var existingID string
		var existingCreatedAt int64
		err := tx.QueryRow(ctx,
			"SELECT id, created_at FROM raw_events WHERE pubkey = $1 AND kind = $2",
			event.PubKey, event.Kind,
		).Scan(&existingID, &existingCreatedAt)

		if err == pgx.ErrNoRows {
			return true, nil // No existing event, store this one
		}
		if err != nil {
			return false, fmt.Errorf("check replaceable: %w", err)
		}

		if event.CreatedAt <= existingCreatedAt {
			return false, nil // Incoming event is older or same age, reject
		}

		// Delete old event (tags cascade)
		if err := s.DeleteEvent(ctx, tx, existingID); err != nil {
			return false, fmt.Errorf("delete old replaceable: %w", err)
		}

		return true, nil

	} else if nostr.IsParameterisedReplaceable(event.Kind) {
		// Parameterised replaceable: same pubkey + kind + d-tag
		dTag := event.GetDTag()
		var existingID string
		var existingCreatedAt int64
		err := tx.QueryRow(ctx, `
			SELECT re.id, re.created_at FROM raw_events re
			JOIN event_tags et ON et.event_id = re.id
			WHERE re.pubkey = $1 AND re.kind = $2 AND et.tag_name = 'd' AND et.tag_value = $3
		`, event.PubKey, event.Kind, dTag).Scan(&existingID, &existingCreatedAt)

		if err == pgx.ErrNoRows {
			return true, nil
		}
		if err != nil {
			return false, fmt.Errorf("check parameterised replaceable: %w", err)
		}

		if event.CreatedAt <= existingCreatedAt {
			return false, nil
		}

		if err := s.DeleteEvent(ctx, tx, existingID); err != nil {
			return false, fmt.Errorf("delete old parameterised replaceable: %w", err)
		}

		return true, nil
	}

	return true, nil // Not replaceable, always store
}

// HandleDeletion processes a NIP-09 Kind 5 deletion event.
// Deletes the referenced events (only if same author).
func (s *EventStore) HandleDeletion(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	if event.Kind != 5 {
		return nil
	}

	// Get all event IDs referenced in "e" tags
	eventIDs := event.GetTagValues("e")
	if len(eventIDs) == 0 {
		return nil
	}

	for _, targetID := range eventIDs {
		// Only delete if the event was authored by the same pubkey
		var targetPubkey string
		err := tx.QueryRow(ctx, "SELECT pubkey FROM raw_events WHERE id = $1", targetID).Scan(&targetPubkey)
		if err == pgx.ErrNoRows {
			continue // Event doesn't exist, skip
		}
		if err != nil {
			return fmt.Errorf("check deletion target %s: %w", targetID, err)
		}

		if targetPubkey != event.PubKey {
			log.Printf("NIP-09: rejecting deletion of %s — author mismatch", targetID)
			continue
		}

		// Delete the denorm entry first (before raw_events cascade deletes tags)
		if err := s.deleteDenormEntry(ctx, tx, targetID); err != nil {
			log.Printf("NIP-09: failed to delete denorm for %s: %v", targetID, err)
		}

		// Delete from raw_events (tags cascade)
		if err := s.DeleteEvent(ctx, tx, targetID); err != nil {
			return fmt.Errorf("delete event %s: %w", targetID, err)
		}

		log.Printf("NIP-09: deleted event %s", targetID)
	}

	return nil
}

// deleteDenormEntry removes the denormalised entry for an event.
func (s *EventStore) deleteDenormEntry(ctx context.Context, tx pgx.Tx, eventID string) error {
	var kind int
	err := tx.QueryRow(ctx, "SELECT kind FROM raw_events WHERE id = $1", eventID).Scan(&kind)
	if err != nil {
		return err
	}

	switch kind {
	case 0:
		// Could be in either table — try both
		_, err = tx.Exec(ctx, "DELETE FROM cached_artists WHERE event_id = $1", eventID)
		if err == nil {
			_, err = tx.Exec(ctx, "DELETE FROM cached_users WHERE event_id = $1", eventID)
		}
	case 1:
		_, err = tx.Exec(ctx, "DELETE FROM cached_user_feed WHERE event_id = $1", eventID)
	case 30001:
		_, err = tx.Exec(ctx, "DELETE FROM cached_user_playlists WHERE event_id = $1", eventID)
	case 30050:
		_, err = tx.Exec(ctx, "DELETE FROM cached_tracks WHERE event_id = $1", eventID)
	case 30051:
		_, err = tx.Exec(ctx, "DELETE FROM cached_albums WHERE event_id = $1", eventID)
	}
	return err
}

// QueryEvents returns raw event JSON matching the given filters.
func (s *EventStore) QueryEvents(ctx context.Context, filters []nostr.Filter) ([]json.RawMessage, error) {
	query, args := BuildEventQuery(filters, false)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query events: %w", err)
	}
	defer rows.Close()

	var events []json.RawMessage
	for rows.Next() {
		var raw json.RawMessage
		if err := rows.Scan(&raw); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		events = append(events, raw)
	}

	return events, rows.Err()
}

// CountEvents returns the count of events matching the given filters (NIP-45).
func (s *EventStore) CountEvents(ctx context.Context, filters []nostr.Filter) (int64, error) {
	query, args := BuildEventQuery(filters, true)

	var count int64
	err := s.pool.QueryRow(ctx, query, args...).Scan(&count)
	return count, err
}

// IsKnownPubkey checks if a pubkey exists in node_artists or registered_users.
func (s *EventStore) IsKnownPubkey(ctx context.Context, pubkey string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM node_artists WHERE pubkey = $1
			UNION ALL
			SELECT 1 FROM registered_users WHERE pubkey = $1
		)
	`, pubkey).Scan(&exists)
	return exists, err
}

// LogEvent records an event processing action in the event_log table.
func (s *EventStore) LogEvent(ctx context.Context, relayURL string, eventKind int, eventID string, action string) {
	_, err := s.pool.Exec(ctx,
		"INSERT INTO event_log (relay_url, event_kind, event_id, action) VALUES ($1, $2, $3, $4)",
		relayURL, eventKind, eventID, action,
	)
	if err != nil {
		log.Printf("Failed to log event: %v", err)
	}
}
