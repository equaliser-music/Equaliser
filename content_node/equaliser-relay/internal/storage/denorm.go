package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"time"

	"equaliser-relay/internal/config"
	"equaliser-relay/internal/nostr"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DenormParser handles parsing events into denormalised cache tables.
type DenormParser struct {
	pool *pgxpool.Pool
	cfg  *config.Config
}

// NewDenormParser creates a new DenormParser.
func NewDenormParser(pool *pgxpool.Pool, cfg *config.Config) *DenormParser {
	return &DenormParser{pool: pool, cfg: cfg}
}

// ParseEvent routes an event to the appropriate kind-specific parser.
// Parse failures are logged but do not return errors — raw event storage is the priority.
func (p *DenormParser) ParseEvent(ctx context.Context, tx pgx.Tx, event *nostr.Event) {
	var err error

	switch {
	case event.Kind == 0:
		err = p.parseProfile(ctx, tx, event)
	case event.Kind == 3:
		err = p.parseFollowList(ctx, tx, event)
	case event.Kind == 1:
		err = p.parseFeedEvent(ctx, tx, event)
	case event.Kind == 30001:
		err = p.parsePlaylist(ctx, tx, event)
	case event.Kind == 30050:
		err = p.parseTrack(ctx, tx, event)
	case event.Kind == 30051:
		err = p.parseAlbum(ctx, tx, event)
	default:
		return
	}

	if err != nil {
		log.Printf("Denorm parse error for event %s (kind %d): %v", event.ID, event.Kind, err)
	}
}

// parseProfile routes a Kind 0 event to the right denormalised table based on
// the ["user-type", X] tag:
//   - "artist" → cached_artists
//   - "label" / "operator" → no denorm cache (lookups go through node_artists / node_operators
//     joined with raw_events directly; the role tables already track them)
//   - missing / "listener" → cached_users (only if registered)
func (p *DenormParser) parseProfile(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	userType := event.GetTagValue("user-type")

	switch userType {
	case "artist":
		return p.parseArtistProfile(ctx, tx, event)
	case "label", "operator":
		// Role-bearing identities — Kind 0 stays in raw_events only.
		// Admin pages query raw_events directly by pubkey.
		return nil
	}

	// No user-type tag (or unrecognised) → listener profile. Only cache if registered.
	return p.parseUserProfile(ctx, tx, event)
}

// parseArtistProfile parses a Kind 0 event into cached_artists.
func (p *DenormParser) parseArtistProfile(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	var profile struct {
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
		About       string `json:"about"`
		Picture     string `json:"picture"`
		Banner      string `json:"banner"`
		Website     string `json:"website"`
		NIP05       string `json:"nip05"`
		LUD16       string `json:"lud16"`
	}

	if err := json.Unmarshal([]byte(event.Content), &profile); err != nil {
		return fmt.Errorf("parse profile content: %w", err)
	}

	displayName := profile.DisplayName
	if displayName == "" {
		displayName = profile.Name
	}

	rawJSON, err := event.MarshalRaw()
	if err != nil {
		return fmt.Errorf("marshal raw event: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO cached_artists (pubkey, display_name, about, picture_url, banner_url, website, nip05, lud16, raw_event, event_id, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (pubkey) DO UPDATE SET
			display_name = EXCLUDED.display_name,
			about = EXCLUDED.about,
			picture_url = EXCLUDED.picture_url,
			banner_url = EXCLUDED.banner_url,
			website = EXCLUDED.website,
			nip05 = EXCLUDED.nip05,
			lud16 = EXCLUDED.lud16,
			raw_event = EXCLUDED.raw_event,
			event_id = EXCLUDED.event_id,
			created_at = EXCLUDED.created_at,
			last_updated_at = NOW()
	`, event.PubKey, displayName, profile.About, profile.Picture, profile.Banner,
		profile.Website, profile.NIP05, profile.LUD16, rawJSON, event.ID, event.CreatedAt)

	return err
}

// parseUserProfile parses a Kind 0 event into cached_users (only if pubkey is registered).
func (p *DenormParser) parseUserProfile(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	// Check if pubkey is a registered user
	var exists bool
	err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM registered_users WHERE pubkey = $1)", event.PubKey).Scan(&exists)
	if err != nil {
		return fmt.Errorf("check registered user: %w", err)
	}
	if !exists {
		return nil // Not a registered user, skip
	}

	var profile struct {
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
		About       string `json:"about"`
		Picture     string `json:"picture"`
		LUD16       string `json:"lud16"`
	}

	if err := json.Unmarshal([]byte(event.Content), &profile); err != nil {
		return fmt.Errorf("parse user profile content: %w", err)
	}

	displayName := profile.DisplayName
	if displayName == "" {
		displayName = profile.Name
	}

	rawJSON, err := event.MarshalRaw()
	if err != nil {
		return fmt.Errorf("marshal raw event: %w", err)
	}

	// Get npub from registered_users
	var npub string
	_ = tx.QueryRow(ctx, "SELECT npub FROM registered_users WHERE pubkey = $1", event.PubKey).Scan(&npub)

	_, err = tx.Exec(ctx, `
		INSERT INTO cached_users (pubkey, npub, display_name, name, picture, lightning_address, about, raw_event, event_id, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (pubkey) DO UPDATE SET
			display_name = EXCLUDED.display_name,
			name = EXCLUDED.name,
			picture = EXCLUDED.picture,
			lightning_address = EXCLUDED.lightning_address,
			about = EXCLUDED.about,
			raw_event = EXCLUDED.raw_event,
			event_id = EXCLUDED.event_id,
			created_at = EXCLUDED.created_at,
			cached_at = NOW()
	`, event.PubKey, npub, displayName, profile.Name, profile.Picture, profile.LUD16,
		profile.About, rawJSON, event.ID, event.CreatedAt)

	return err
}

// parseFollowList parses a Kind 3 event into cached_user_follows.
// Only processes follow lists for registered users.
func (p *DenormParser) parseFollowList(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	// Only cache follow lists for registered users
	var exists bool
	err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM registered_users WHERE pubkey = $1)", event.PubKey).Scan(&exists)
	if err != nil {
		return fmt.Errorf("check registered user: %w", err)
	}
	if !exists {
		return nil
	}

	// Delete existing follows for this user (replaceable event — full replace)
	_, err = tx.Exec(ctx, "DELETE FROM cached_user_follows WHERE pubkey = $1", event.PubKey)
	if err != nil {
		return fmt.Errorf("delete old follows: %w", err)
	}

	// Parse "p" tags into follow rows
	rows := [][]interface{}{}
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "p" {
			relayHint := ""
			if len(tag) >= 3 {
				relayHint = tag[2]
			}
			rows = append(rows, []interface{}{event.PubKey, tag[1], relayHint, event.CreatedAt})
		}
	}

	if len(rows) == 0 {
		return nil
	}

	_, err = tx.CopyFrom(
		ctx,
		pgx.Identifier{"cached_user_follows"},
		[]string{"pubkey", "follows_pubkey", "relay_hint", "updated_at"},
		pgx.CopyFromRows(rows),
	)

	return err
}

// parseFeedEvent caches a Kind 1 event in cached_user_feed for registered users
// who follow the author. Enforces USER_FEED_DAYS and USER_FEED_LIMIT thresholds.
func (p *DenormParser) parseFeedEvent(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	// Check age threshold
	cutoff := time.Now().AddDate(0, 0, -p.cfg.UserFeedDays).Unix()
	if event.CreatedAt < cutoff {
		return nil // Too old to cache
	}

	// Find registered users who follow this author
	rows, err := tx.Query(ctx, `
		SELECT cuf.pubkey FROM cached_user_follows cuf
		JOIN registered_users ru ON ru.pubkey = cuf.pubkey AND ru.enabled = TRUE
		WHERE cuf.follows_pubkey = $1
	`, event.PubKey)
	if err != nil {
		return fmt.Errorf("find followers: %w", err)
	}
	defer rows.Close()

	var followers []string
	for rows.Next() {
		var pubkey string
		if err := rows.Scan(&pubkey); err != nil {
			return fmt.Errorf("scan follower: %w", err)
		}
		followers = append(followers, pubkey)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	if len(followers) == 0 {
		return nil // Nobody on this node follows this author
	}

	for _, forUser := range followers {
		// Enforce per-user feed limit by deleting oldest if at capacity
		_, err := tx.Exec(ctx, `
			DELETE FROM cached_user_feed
			WHERE event_id IN (
				SELECT event_id FROM cached_user_feed
				WHERE for_user_pubkey = $1
				ORDER BY created_at ASC
				LIMIT GREATEST(0, (SELECT COUNT(*) FROM cached_user_feed WHERE for_user_pubkey = $1) - $2 + 1)
			)
		`, forUser, p.cfg.UserFeedLimit)
		if err != nil {
			log.Printf("Feed limit enforcement failed for %s: %v", forUser, err)
		}

		_, err = tx.Exec(ctx, `
			INSERT INTO cached_user_feed (event_id, pubkey, for_user_pubkey, content, created_at)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (event_id) DO NOTHING
		`, event.ID, event.PubKey, forUser, event.Content, event.CreatedAt)
		if err != nil {
			log.Printf("Feed insert failed for user %s: %v", forUser, err)
		}
	}

	return nil
}

// parsePlaylist parses a Kind 30001 event into cached_user_playlists.
// Only processes playlists for registered users.
func (p *DenormParser) parsePlaylist(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	// Only cache playlists for registered users
	var exists bool
	err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM registered_users WHERE pubkey = $1)", event.PubKey).Scan(&exists)
	if err != nil {
		return fmt.Errorf("check registered user: %w", err)
	}
	if !exists {
		return nil
	}

	dTag := event.GetDTag()
	if dTag == "" {
		return fmt.Errorf("missing d tag")
	}

	name := event.GetTagValue("title")
	if name == "" {
		name = event.GetTagValue("name")
	}

	// Extract track references from "a" or "e" tags
	var trackRefs []string
	for _, tag := range event.Tags {
		if len(tag) >= 2 && (tag[0] == "a" || tag[0] == "e") {
			trackRefs = append(trackRefs, tag[1])
		}
	}
	trackRefsJSON, _ := json.Marshal(trackRefs)

	rawJSON, err := event.MarshalRaw()
	if err != nil {
		return fmt.Errorf("marshal raw event: %w", err)
	}

	// Get npub from registered_users (for the FK)
	_, err = tx.Exec(ctx, `
		INSERT INTO cached_user_playlists (event_id, pubkey, playlist_id, name, track_refs, raw_event, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (pubkey, playlist_id) DO UPDATE SET
			event_id = EXCLUDED.event_id,
			name = EXCLUDED.name,
			track_refs = EXCLUDED.track_refs,
			raw_event = EXCLUDED.raw_event,
			created_at = EXCLUDED.created_at,
			cached_at = NOW()
	`, event.ID, event.PubKey, dTag, name, trackRefsJSON, rawJSON, event.CreatedAt)

	return err
}

// parseTrack parses a Kind 30050 event into cached_tracks.
//
// Attribution order (Phase F + Phase G):
//  1. NIP-26 delegation tag (`["delegation", artist_pubkey, conditions, signature]`) — Phase F:
//     manager helps independent artist publish. Attribution → delegator; signer recorded in
//     published_by + label_pubkey.
//  2. Performer tag (`["p", artist_pubkey, "", "performer"]`) — Phase G: label is the publisher
//     and rights-holder for the recording. Attribution → performer; signer recorded in
//     published_by + label_pubkey.
//  3. Self-publish (no special tags) — track attributed to event.PubKey, label_pubkey NULL.
//
// label_pubkey is the consistent "who signed this recording" column for Phase G UI badges and
// strict-mode reporting — populated in both delegation and performer-tag cases.
func (p *DenormParser) parseTrack(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	dTag := event.GetDTag()
	if dTag == "" {
		return fmt.Errorf("missing d tag")
	}

	title := event.GetTagValue("title")
	album := event.GetTagValue("album")
	genre := event.GetTagValue("genre")
	ipfsManifest := event.GetTagValue("ipfs_manifest")
	ipfsPreview := event.GetTagValue("ipfs_preview")
	coverArt := event.GetTagValue("cover_art")
	releaseDate := event.GetTagValue("release_date")

	var duration *int
	if d := event.GetTagValue("duration"); d != "" {
		if n, err := strconv.Atoi(d); err == nil {
			duration = &n
		}
	}

	var priceSats *int
	if pr := event.GetTagValue("price"); pr != "" {
		if n, err := strconv.Atoi(pr); err == nil {
			priceSats = &n
		}
	}

	// Default attribution: signer is the artist (self-publish)
	attributedPubkey := event.PubKey
	var publishedBy *string
	var labelPubkey *string

	// 1. Honour NIP-26 delegation tag if present + valid + conditions allow this event (Phase F)
	if delegationTag := findDelegationTag(event); delegationTag != nil {
		delegator := delegationTag[1]
		conditions := delegationTag[2]
		signature := delegationTag[3]
		if VerifyDelegationSignature(delegator, event.PubKey, conditions, signature) == nil &&
			ConditionsAllow(conditions, event.Kind, event.CreatedAt) {
			attributedPubkey = delegator
			signer := event.PubKey
			publishedBy = &signer
			labelPubkey = &signer
		}
	}

	// 2. Honour performer tag if present and we haven't already taken a delegation branch (Phase G).
	//    Self-tagging (performer == signer) is permitted as a no-op and doesn't set label_pubkey.
	if publishedBy == nil {
		if performer := findPerformerPubkey(event); performer != "" && performer != event.PubKey {
			attributedPubkey = performer
			signer := event.PubKey
			publishedBy = &signer
			labelPubkey = &signer
		}
	}

	rawJSON, err := event.MarshalRaw()
	if err != nil {
		return fmt.Errorf("marshal raw event: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO cached_tracks (event_id, artist_pubkey, d_tag, title, album, genre, duration, price_sats, ipfs_manifest_cid, ipfs_preview_cid, cover_art_cid, release_date, raw_event, created_at, published_by, label_pubkey)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
		ON CONFLICT (artist_pubkey, d_tag) DO UPDATE SET
			event_id = EXCLUDED.event_id,
			title = EXCLUDED.title,
			album = EXCLUDED.album,
			genre = EXCLUDED.genre,
			duration = EXCLUDED.duration,
			price_sats = EXCLUDED.price_sats,
			ipfs_manifest_cid = EXCLUDED.ipfs_manifest_cid,
			ipfs_preview_cid = EXCLUDED.ipfs_preview_cid,
			cover_art_cid = EXCLUDED.cover_art_cid,
			release_date = EXCLUDED.release_date,
			raw_event = EXCLUDED.raw_event,
			created_at = EXCLUDED.created_at,
			published_by = EXCLUDED.published_by,
			label_pubkey = EXCLUDED.label_pubkey,
			last_updated_at = NOW()
	`, event.ID, attributedPubkey, dTag, title, album, genre, duration, priceSats,
		ipfsManifest, ipfsPreview, coverArt, releaseDate, rawJSON, event.CreatedAt,
		publishedBy, labelPubkey)

	return err
}

// findDelegationTag returns the first ["delegation", delegator, conditions, signature]
// tag in the event, or nil if absent / malformed.
func findDelegationTag(event *nostr.Event) []string {
	for _, tag := range event.Tags {
		if len(tag) >= 4 && tag[0] == "delegation" {
			return tag
		}
	}
	return nil
}

// findPerformerPubkey returns the pubkey from a `["p", artist_pubkey, "", "performer"]` tag,
// or "" if absent. Per NIP-10 convention, the 4th element is the role marker.
func findPerformerPubkey(event *nostr.Event) string {
	for _, tag := range event.Tags {
		if len(tag) >= 4 && tag[0] == "p" && tag[3] == "performer" && tag[1] != "" {
			return tag[1]
		}
	}
	return ""
}

// parseAlbum parses a Kind 30051 event into cached_albums.
func (p *DenormParser) parseAlbum(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	dTag := event.GetDTag()
	if dTag == "" {
		return fmt.Errorf("missing d tag")
	}

	title := event.GetTagValue("title")
	coverArt := event.GetTagValue("cover_art")

	rawJSON, err := event.MarshalRaw()
	if err != nil {
		return fmt.Errorf("marshal raw event: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO cached_albums (event_id, artist_pubkey, d_tag, title, cover_art_cid, raw_event, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (artist_pubkey, d_tag) DO UPDATE SET
			event_id = EXCLUDED.event_id,
			title = EXCLUDED.title,
			cover_art_cid = EXCLUDED.cover_art_cid,
			raw_event = EXCLUDED.raw_event,
			created_at = EXCLUDED.created_at,
			last_updated_at = NOW()
	`, event.ID, event.PubKey, dTag, title, coverArt, rawJSON, event.CreatedAt)

	return err
}
