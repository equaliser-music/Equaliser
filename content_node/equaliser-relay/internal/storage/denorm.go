package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"

	"equaliser-relay/internal/nostr"

	"github.com/jackc/pgx/v5"
)

// DenormParser handles parsing events into denormalised cache tables.
type DenormParser struct{}

// NewDenormParser creates a new DenormParser.
func NewDenormParser() *DenormParser {
	return &DenormParser{}
}

// ParseEvent routes an event to the appropriate kind-specific parser.
// Parse failures are logged but do not return errors — raw event storage is the priority.
func (p *DenormParser) ParseEvent(ctx context.Context, tx pgx.Tx, event *nostr.Event) {
	var err error

	switch {
	case event.Kind == 0:
		err = p.parseArtistProfile(ctx, tx, event)
	case event.Kind == 30050:
		err = p.parseTrack(ctx, tx, event)
	case event.Kind == 30051:
		err = p.parseAlbum(ctx, tx, event)
	default:
		return // No denorm parsing for other kinds in Phase B.0
	}

	if err != nil {
		log.Printf("Denorm parse error for event %s (kind %d): %v", event.ID, event.Kind, err)
	}
}

// parseArtistProfile parses a Kind 0 event into cached_artists.
func (p *DenormParser) parseArtistProfile(ctx context.Context, tx pgx.Tx, event *nostr.Event) error {
	// Parse content JSON
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

	// Use display_name, fall back to name
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

// parseTrack parses a Kind 30050 event into cached_tracks.
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

	// Parse duration (optional)
	var duration *int
	if d := event.GetTagValue("duration"); d != "" {
		if n, err := strconv.Atoi(d); err == nil {
			duration = &n
		}
	}

	// Parse price (optional)
	var priceSats *int
	if p := event.GetTagValue("price"); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			priceSats = &n
		}
	}

	rawJSON, err := event.MarshalRaw()
	if err != nil {
		return fmt.Errorf("marshal raw event: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO cached_tracks (event_id, artist_pubkey, d_tag, title, album, genre, duration, price_sats, ipfs_manifest_cid, ipfs_preview_cid, cover_art_cid, release_date, raw_event, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
			last_updated_at = NOW()
	`, event.ID, event.PubKey, dTag, title, album, genre, duration, priceSats,
		ipfsManifest, ipfsPreview, coverArt, releaseDate, rawJSON, event.CreatedAt)

	return err
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
