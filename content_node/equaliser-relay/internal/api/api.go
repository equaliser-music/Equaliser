package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"equaliser-relay/internal/nostr"
	"equaliser-relay/internal/storage"
)

// Server serves the REST API endpoints.
type Server struct {
	userStore       *storage.UserStore
	eventStore      *storage.EventStore
	adminStore      *storage.AdminStore
	peerStore       *storage.PeerStore
	delegationStore *storage.DelegationStore
	mux             *http.ServeMux
}

// NewServer creates a new REST API server.
func NewServer(
	userStore *storage.UserStore,
	eventStore *storage.EventStore,
	adminStore *storage.AdminStore,
	peerStore *storage.PeerStore,
	delegationStore *storage.DelegationStore,
) *Server {
	s := &Server{
		userStore:       userStore,
		eventStore:      eventStore,
		adminStore:      adminStore,
		peerStore:       peerStore,
		delegationStore: delegationStore,
		mux:             http.NewServeMux(),
	}

	// Internal endpoints (Docker network only, not proxied by nginx)
	s.mux.HandleFunc("POST /api/internal/users/register", s.handleRegisterUser)

	// Cache endpoints (proxied by nginx at /api/cache/*)
	// Profiles
	s.mux.HandleFunc("GET /api/cache/profiles", s.handleGetProfiles)
	s.mux.HandleFunc("GET /api/cache/profiles/{pubkey}", s.handleGetSingleProfile)
	// User data
	s.mux.HandleFunc("GET /api/cache/users/{pubkey}/follows", s.handleGetUserFollows)
	s.mux.HandleFunc("GET /api/cache/users/{pubkey}/feed", s.handleGetUserFeed)
	// Artists
	s.mux.HandleFunc("GET /api/cache/artists", s.handleGetArtists)
	s.mux.HandleFunc("GET /api/cache/artists/{pubkey}", s.handleGetArtist)
	// Tracks & albums
	s.mux.HandleFunc("GET /api/cache/tracks", s.handleGetTracks)
	s.mux.HandleFunc("GET /api/cache/tracks/recent", s.handleGetRecentTracks)
	s.mux.HandleFunc("GET /api/cache/albums", s.handleGetAlbums)
	// General event query (replaces WebSocket REQ for reads)
	s.mux.HandleFunc("GET /api/cache/events", s.handleQueryEvents)
	// Thread external refs
	s.mux.HandleFunc("GET /api/cache/threads/{eventID}/external", s.handleThreadExternal)

	// Role resolution (internal — called by orchestrator)
	s.mux.HandleFunc("GET /api/internal/auth/role", s.handleResolveRole)

	// Admin endpoints (internal — orchestrator wraps with role checks)
	s.mux.HandleFunc("GET /api/internal/artists", s.handleAdminListArtists)
	s.mux.HandleFunc("GET /api/internal/artists/{pubkey}", s.handleAdminGetArtist)
	s.mux.HandleFunc("PATCH /api/internal/artists/{pubkey}", s.handleAdminUpdateArtist)
	s.mux.HandleFunc("GET /api/internal/access-requests", s.handleListAccessRequests)
	s.mux.HandleFunc("GET /api/internal/access-requests/{id}", s.handleGetAccessRequest)
	s.mux.HandleFunc("POST /api/internal/access-requests", s.handleCreateAccessRequest)
	s.mux.HandleFunc("POST /api/internal/access-requests/{id}/approve", s.handleApproveRequest)
	s.mux.HandleFunc("POST /api/internal/access-requests/{id}/decline", s.handleDeclineRequest)
	s.mux.HandleFunc("GET /api/internal/invite-codes", s.handleListInviteCodes)
	s.mux.HandleFunc("POST /api/internal/invite-codes", s.handleCreateInviteCode)
	s.mux.HandleFunc("GET /api/internal/invite-codes/{code}", s.handleGetInviteCode)
	s.mux.HandleFunc("POST /api/internal/invite-codes/redeem", s.handleRedeemInviteCode)
	s.mux.HandleFunc("GET /api/internal/setup-status", s.handleSetupStatus)
	s.mux.HandleFunc("POST /api/internal/operators/claim", s.handleClaimOperator)

	// Delegation lifecycle (Phase F: NIP-26)
	s.mux.HandleFunc("POST /api/internal/delegations/requests", s.handleCreateDelegationRequest)
	s.mux.HandleFunc("GET /api/internal/delegations/requests", s.handleListDelegationRequests)
	s.mux.HandleFunc("POST /api/internal/delegations/requests/{id}/grant", s.handleGrantDelegation)
	s.mux.HandleFunc("POST /api/internal/delegations/requests/{id}/decline", s.handleDeclineDelegationRequest)
	s.mux.HandleFunc("GET /api/internal/delegations/active", s.handleListActiveDelegations)
	s.mux.HandleFunc("GET /api/internal/delegations/{artist}/{label}", s.handleGetActiveDelegation)
	s.mux.HandleFunc("POST /api/internal/delegations/{artist}/{label}/revoke", s.handleRevokeDelegation)
	s.mux.HandleFunc("GET /api/internal/registered-users", s.handleListRegisteredUsers)
	s.mux.HandleFunc("GET /api/internal/stats", s.handleNodeStats)
	s.mux.HandleFunc("GET /api/internal/peer-relays", s.handleListPeerRelays)

	// Health check
	s.mux.HandleFunc("GET /api/health", s.handleHealth)

	return s
}

// Handler returns the HTTP handler for the REST API.
func (s *Server) Handler() http.Handler {
	return s.mux
}

// setCacheHeaders sets common response headers for cache endpoints.
func setCacheHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
}

// validateHexPubkey checks that a string is a valid 64-char hex pubkey.
func validateHexPubkey(pk string) bool {
	if len(pk) != 64 {
		return false
	}
	_, err := hex.DecodeString(pk)
	return err == nil
}

// handleHealth returns a simple health check response.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}

// ===== General Event Query =====

// handleQueryEvents queries raw_events with NIP-01-style filter parameters.
// GET /api/cache/events?kinds=1,7&authors=pk1,pk2&e=id1,id2&p=pk1&ids=id1&limit=50&since=ts&until=ts
func (s *Server) handleQueryEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	filter := nostr.Filter{}

	if v := q.Get("kinds"); v != "" {
		for _, k := range strings.Split(v, ",") {
			if n, err := strconv.Atoi(strings.TrimSpace(k)); err == nil {
				filter.Kinds = append(filter.Kinds, n)
			}
		}
	}
	if v := q.Get("authors"); v != "" {
		for _, pk := range strings.Split(v, ",") {
			pk = strings.TrimSpace(pk)
			if validateHexPubkey(pk) {
				filter.Authors = append(filter.Authors, pk)
			}
		}
	}
	if v := q.Get("ids"); v != "" {
		for _, id := range strings.Split(v, ",") {
			id = strings.TrimSpace(id)
			if len(id) == 64 {
				filter.IDs = append(filter.IDs, id)
			}
		}
	}
	// Tag filters: #e and #p
	if v := q.Get("e"); v != "" {
		if filter.Tags == nil {
			filter.Tags = make(map[string][]string)
		}
		for _, id := range strings.Split(v, ",") {
			id = strings.TrimSpace(id)
			if len(id) == 64 {
				filter.Tags["e"] = append(filter.Tags["e"], id)
			}
		}
	}
	if v := q.Get("p"); v != "" {
		if filter.Tags == nil {
			filter.Tags = make(map[string][]string)
		}
		for _, pk := range strings.Split(v, ",") {
			pk = strings.TrimSpace(pk)
			if validateHexPubkey(pk) {
				filter.Tags["p"] = append(filter.Tags["p"], pk)
			}
		}
	}
	if v := q.Get("since"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			filter.Since = &n
		}
	}
	if v := q.Get("until"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			filter.Until = &n
		}
	}
	limit := 100
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	filter.Limit = &limit

	// Must have at least one filter criterion
	if len(filter.IDs) == 0 && len(filter.Authors) == 0 && len(filter.Kinds) == 0 && len(filter.Tags) == 0 {
		http.Error(w, `{"error": "at least one filter parameter required (kinds, authors, ids, e, p)"}`, http.StatusBadRequest)
		return
	}

	events, err := s.eventStore.QueryEvents(r.Context(), []nostr.Filter{filter})
	if err != nil {
		log.Printf("Failed to query events: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	if events == nil {
		events = []json.RawMessage{}
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"events": events,
	})
}

// ===== Profile Endpoints =====

// handleGetProfiles returns cached profiles for a batch of pubkeys.
// GET /api/cache/profiles?pubkeys=hex1,hex2,...
func (s *Server) handleGetProfiles(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("pubkeys")
	if raw == "" {
		http.Error(w, `{"error": "pubkeys query parameter is required"}`, http.StatusBadRequest)
		return
	}

	parts := strings.Split(raw, ",")
	if len(parts) > 100 {
		http.Error(w, `{"error": "max 100 pubkeys per request"}`, http.StatusBadRequest)
		return
	}

	var pubkeys []string
	for _, pk := range parts {
		pk = strings.TrimSpace(pk)
		if !validateHexPubkey(pk) {
			continue
		}
		pubkeys = append(pubkeys, pk)
	}
	if len(pubkeys) == 0 {
		http.Error(w, `{"error": "no valid pubkeys provided"}`, http.StatusBadRequest)
		return
	}

	profiles, err := s.userStore.GetProfiles(r.Context(), pubkeys)
	if err != nil {
		log.Printf("Failed to get profiles: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	profileMap := make(map[string]storage.ProfileResult)
	for _, p := range profiles {
		profileMap[p.Pubkey] = p
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"profiles": profileMap,
	})
}

// handleGetSingleProfile returns a cached profile for a single pubkey.
// GET /api/cache/profiles/{pubkey}
func (s *Server) handleGetSingleProfile(w http.ResponseWriter, r *http.Request) {
	pubkey := r.PathValue("pubkey")
	if !validateHexPubkey(pubkey) {
		http.Error(w, `{"error": "invalid pubkey"}`, http.StatusBadRequest)
		return
	}

	profiles, err := s.userStore.GetProfiles(r.Context(), []string{pubkey})
	if err != nil {
		log.Printf("Failed to get profile for %s: %v", pubkey, err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	if len(profiles) == 0 {
		setCacheHeaders(w)
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "not found"})
		return
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(profiles[0])
}

// ===== User Data Endpoints =====

// handleGetUserFollows returns the cached follow list for a user.
// GET /api/cache/users/{pubkey}/follows
func (s *Server) handleGetUserFollows(w http.ResponseWriter, r *http.Request) {
	pubkey := r.PathValue("pubkey")
	if !validateHexPubkey(pubkey) {
		http.Error(w, `{"error": "invalid pubkey"}`, http.StatusBadRequest)
		return
	}

	follows, err := s.userStore.GetUserFollows(r.Context(), pubkey)
	if err != nil {
		log.Printf("Failed to get follows for %s: %v", pubkey, err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	if follows == nil {
		follows = []string{}
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"pubkey":  pubkey,
		"follows": follows,
		"count":   len(follows),
	})
}

// handleGetUserFeed returns cached feed posts for a user.
// GET /api/cache/users/{pubkey}/feed?limit=50
func (s *Server) handleGetUserFeed(w http.ResponseWriter, r *http.Request) {
	pubkey := r.PathValue("pubkey")
	if !validateHexPubkey(pubkey) {
		http.Error(w, `{"error": "invalid pubkey"}`, http.StatusBadRequest)
		return
	}

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}

	events, err := s.userStore.GetUserFeed(r.Context(), pubkey, limit)
	if err != nil {
		log.Printf("Failed to get feed for %s: %v", pubkey, err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	if events == nil {
		events = []storage.FeedEvent{}
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"events": events,
	})
}

// ===== Artist Endpoints =====

// handleGetArtists returns all cached artist profiles.
// GET /api/cache/artists
func (s *Server) handleGetArtists(w http.ResponseWriter, r *http.Request) {
	artists, err := s.userStore.GetAllArtists(r.Context())
	if err != nil {
		log.Printf("Failed to get artists: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	if artists == nil {
		artists = []storage.ArtistResult{}
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"artists": artists,
	})
}

// handleGetArtist returns a single cached artist profile.
// GET /api/cache/artists/{pubkey}
func (s *Server) handleGetArtist(w http.ResponseWriter, r *http.Request) {
	pubkey := r.PathValue("pubkey")
	if !validateHexPubkey(pubkey) {
		http.Error(w, `{"error": "invalid pubkey"}`, http.StatusBadRequest)
		return
	}

	profiles, err := s.userStore.GetProfiles(r.Context(), []string{pubkey})
	if err != nil {
		log.Printf("Failed to get artist %s: %v", pubkey, err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	// Find the artist profile (not user profile)
	for _, p := range profiles {
		if p.Type == "artist" {
			setCacheHeaders(w)
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(p)
			return
		}
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusNotFound)
	json.NewEncoder(w).Encode(map[string]string{"error": "not found"})
}

// ===== Track & Album Endpoints =====

// handleGetTracks returns cached tracks, optionally filtered by artist.
// GET /api/cache/tracks?artist={pubkey}
func (s *Server) handleGetTracks(w http.ResponseWriter, r *http.Request) {
	artist := r.URL.Query().Get("artist")
	if artist == "" {
		http.Error(w, `{"error": "artist query parameter is required"}`, http.StatusBadRequest)
		return
	}
	if !validateHexPubkey(artist) {
		http.Error(w, `{"error": "invalid artist pubkey"}`, http.StatusBadRequest)
		return
	}

	tracks, err := s.userStore.GetTracksByArtist(r.Context(), artist)
	if err != nil {
		log.Printf("Failed to get tracks for %s: %v", artist, err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	if tracks == nil {
		tracks = []storage.TrackResult{}
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"tracks": tracks,
	})
}

// handleGetRecentTracks returns the most recent tracks across all artists.
// GET /api/cache/tracks/recent?limit=50
func (s *Server) handleGetRecentTracks(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}

	tracks, err := s.userStore.GetRecentTracks(r.Context(), limit)
	if err != nil {
		log.Printf("Failed to get recent tracks: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	if tracks == nil {
		tracks = []storage.TrackResult{}
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"tracks": tracks,
	})
}

// handleGetAlbums returns cached albums for an artist.
// GET /api/cache/albums?artist={pubkey}
func (s *Server) handleGetAlbums(w http.ResponseWriter, r *http.Request) {
	artist := r.URL.Query().Get("artist")
	if artist == "" {
		http.Error(w, `{"error": "artist query parameter is required"}`, http.StatusBadRequest)
		return
	}
	if !validateHexPubkey(artist) {
		http.Error(w, `{"error": "invalid artist pubkey"}`, http.StatusBadRequest)
		return
	}

	albums, err := s.userStore.GetAlbumsByArtist(r.Context(), artist)
	if err != nil {
		log.Printf("Failed to get albums for %s: %v", artist, err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	if albums == nil {
		albums = []storage.AlbumResult{}
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"albums": albums,
	})
}

// ===== Thread External Refs =====

// handleThreadExternal returns the external reply count for a thread root event.
// GET /api/cache/threads/{eventID}/external
func (s *Server) handleThreadExternal(w http.ResponseWriter, r *http.Request) {
	eventID := r.PathValue("eventID")
	if eventID == "" || len(eventID) != 64 {
		http.Error(w, `{"error": "invalid event ID"}`, http.StatusBadRequest)
		return
	}

	count, found, err := s.userStore.GetThreadExternalRefs(r.Context(), eventID)
	if err != nil {
		log.Printf("Failed to get thread external refs for %s: %v", eventID, err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"root_event_id":        eventID,
		"external_reply_count": count,
		"checked":              found,
	})
}

// ===== Admin Endpoints (internal) =====

// handleAdminListArtists returns artists from node_artists, optionally filtered.
// GET /api/internal/artists?managed_by=&role=
func (s *Server) handleAdminListArtists(w http.ResponseWriter, r *http.Request) {
	managedBy := r.URL.Query().Get("managed_by")
	role := r.URL.Query().Get("role")

	if managedBy != "" && !validateHexPubkey(managedBy) {
		http.Error(w, `{"error": "invalid managed_by pubkey"}`, http.StatusBadRequest)
		return
	}

	artists, err := s.adminStore.ListArtists(r.Context(), managedBy, role)
	if err != nil {
		log.Printf("Failed to list artists: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	if artists == nil {
		artists = []storage.NodeArtist{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"artists": artists})
}

// handleAdminGetArtist returns a single node_artist by pubkey.
// GET /api/internal/artists/{pubkey}
func (s *Server) handleAdminGetArtist(w http.ResponseWriter, r *http.Request) {
	pubkey := r.PathValue("pubkey")
	if !validateHexPubkey(pubkey) {
		http.Error(w, `{"error": "invalid pubkey"}`, http.StatusBadRequest)
		return
	}

	artist, err := s.adminStore.GetArtist(r.Context(), pubkey)
	if err != nil {
		log.Printf("Failed to get artist: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	if artist == nil {
		http.Error(w, `{"error": "not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(artist)
}

// handleAdminUpdateArtist updates status, fee_model, and/or fee_value.
// PATCH /api/internal/artists/{pubkey}
// Body: { status?, fee_model?, fee_value? }
func (s *Server) handleAdminUpdateArtist(w http.ResponseWriter, r *http.Request) {
	pubkey := r.PathValue("pubkey")
	if !validateHexPubkey(pubkey) {
		http.Error(w, `{"error": "invalid pubkey"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		Status           *string  `json:"status"`
		FeeModel         *string  `json:"fee_model"`
		FeeValue         *float64 `json:"fee_value"`
		RelationshipType *string  `json:"relationship_type"` // Phase G
		ManagedBy        *string  `json:"managed_by"`        // Phase G — operator can change current label; "" clears
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error": "invalid request body"}`, http.StatusBadRequest)
		return
	}

	// Validate enums
	if req.Status != nil && *req.Status != "active" && *req.Status != "suspended" {
		http.Error(w, `{"error": "status must be 'active' or 'suspended'"}`, http.StatusBadRequest)
		return
	}
	if req.FeeModel != nil && *req.FeeModel != "free" && *req.FeeModel != "percentage" && *req.FeeModel != "flat_rate" {
		http.Error(w, `{"error": "fee_model must be 'free', 'percentage', or 'flat_rate'"}`, http.StatusBadRequest)
		return
	}
	if req.RelationshipType != nil &&
		*req.RelationshipType != "self" && *req.RelationshipType != "managed" && *req.RelationshipType != "signed" {
		http.Error(w, `{"error": "relationship_type must be 'self', 'managed', or 'signed'"}`, http.StatusBadRequest)
		return
	}

	if err := s.adminStore.UpdateArtist(r.Context(), pubkey, req.Status, req.FeeModel, req.FeeValue, req.RelationshipType, req.ManagedBy); err != nil {
		log.Printf("Failed to update artist: %v", err)
		http.Error(w, `{"error": "`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"updated": true})
}

// handleListAccessRequests returns access requests, optionally filtered by status.
// GET /api/internal/access-requests?status=pending
func (s *Server) handleListAccessRequests(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status != "" && status != "pending" && status != "approved" && status != "declined" {
		http.Error(w, `{"error": "invalid status"}`, http.StatusBadRequest)
		return
	}

	requests, err := s.adminStore.ListAccessRequests(r.Context(), status)
	if err != nil {
		log.Printf("Failed to list access requests: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	if requests == nil {
		requests = []storage.AccessRequest{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"requests": requests})
}

// handleGetAccessRequest returns a single access request by ID.
// GET /api/internal/access-requests/{id}
func (s *Server) handleGetAccessRequest(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, `{"error": "invalid id"}`, http.StatusBadRequest)
		return
	}

	req, err := s.adminStore.GetAccessRequest(r.Context(), id)
	if err != nil {
		log.Printf("Failed to get access request: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	if req == nil {
		http.Error(w, `{"error": "not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(req)
}

// handleCreateAccessRequest creates a new pending request.
// POST /api/internal/access-requests
// Body: { requested_role?, artist_name, email?, npub?, description?, links?, target_relationship_type? }
func (s *Server) handleCreateAccessRequest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RequestedRole          string `json:"requested_role"`
		ArtistName             string `json:"artist_name"`
		Email                  string `json:"email"`
		Npub                   string `json:"npub"`
		Description            string `json:"description"`
		Links                  string `json:"links"`
		TargetRelationshipType string `json:"target_relationship_type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error": "invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.ArtistName == "" {
		http.Error(w, `{"error": "artist_name is required"}`, http.StatusBadRequest)
		return
	}
	// Reject 'operator' as a self-applied role — operator must be invited by another operator.
	if req.RequestedRole != "" && req.RequestedRole != "artist" && req.RequestedRole != "label" {
		http.Error(w, `{"error": "requested_role must be 'artist' or 'label'"}`, http.StatusBadRequest)
		return
	}
	if req.TargetRelationshipType != "" &&
		req.TargetRelationshipType != "self" &&
		req.TargetRelationshipType != "managed" &&
		req.TargetRelationshipType != "signed" {
		http.Error(w, `{"error": "target_relationship_type must be 'self', 'managed', or 'signed'"}`, http.StatusBadRequest)
		return
	}

	id, err := s.adminStore.CreateAccessRequest(r.Context(), req.RequestedRole,
		req.ArtistName, req.Email, req.Npub, req.Description, req.Links,
		req.TargetRelationshipType)
	if err != nil {
		log.Printf("Failed to create access request: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "status": "pending"})
}

// handleApproveRequest approves a request and generates an invite code.
// POST /api/internal/access-requests/{id}/approve
// Body: { admin_notes?, target_role?, target_managed_by?, target_relationship_type?, issued_by? }
func (s *Server) handleApproveRequest(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, `{"error": "invalid id"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		AdminNotes             string  `json:"admin_notes"`
		TargetRole             string  `json:"target_role"`
		TargetManagedBy        *string `json:"target_managed_by"`
		TargetRelationshipType string  `json:"target_relationship_type"`
		IssuedBy               string  `json:"issued_by"`
	}
	json.NewDecoder(r.Body).Decode(&req) // body optional

	if req.TargetRelationshipType != "" &&
		req.TargetRelationshipType != "self" &&
		req.TargetRelationshipType != "managed" &&
		req.TargetRelationshipType != "signed" {
		http.Error(w, `{"error": "target_relationship_type must be 'self', 'managed', or 'signed'"}`, http.StatusBadRequest)
		return
	}

	code, err := s.adminStore.ApproveAccessRequest(r.Context(), id, req.AdminNotes,
		req.TargetRole, req.TargetManagedBy, req.TargetRelationshipType, req.IssuedBy)
	if err != nil {
		log.Printf("Failed to approve request: %v", err)
		http.Error(w, `{"error": "`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":          id,
		"status":      "approved",
		"invite_code": code,
	})
}

// handleDeclineRequest declines a request.
// POST /api/internal/access-requests/{id}/decline
// Body: { admin_notes? }
func (s *Server) handleDeclineRequest(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, `{"error": "invalid id"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		AdminNotes string `json:"admin_notes"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if err := s.adminStore.DeclineAccessRequest(r.Context(), id, req.AdminNotes); err != nil {
		log.Printf("Failed to decline request: %v", err)
		http.Error(w, `{"error": "`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "status": "declined"})
}

// handleListInviteCodes lists unused invite codes.
// GET /api/internal/invite-codes
func (s *Server) handleListInviteCodes(w http.ResponseWriter, r *http.Request) {
	codes, err := s.adminStore.ListInviteCodes(r.Context())
	if err != nil {
		log.Printf("Failed to list invite codes: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	if codes == nil {
		codes = []map[string]interface{}{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"codes": codes})
}

// handleCreateInviteCode creates an orphan invite code (no associated request).
// POST /api/internal/invite-codes
// Body: { target_role?, target_managed_by?, target_relationship_type?, issued_by? }
func (s *Server) handleCreateInviteCode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TargetRole             string  `json:"target_role"`
		TargetManagedBy        *string `json:"target_managed_by"`
		TargetRelationshipType string  `json:"target_relationship_type"`
		IssuedBy               string  `json:"issued_by"`
		ArtistName             string  `json:"artist_name"` // roster invites carry the artist's name
		Npub                   string  `json:"npub"`        // optional, for record-keeping / future notification
	}
	json.NewDecoder(r.Body).Decode(&req) // body optional

	if req.TargetRelationshipType != "" &&
		req.TargetRelationshipType != "self" &&
		req.TargetRelationshipType != "managed" &&
		req.TargetRelationshipType != "signed" {
		http.Error(w, `{"error": "target_relationship_type must be 'self', 'managed', or 'signed'"}`, http.StatusBadRequest)
		return
	}

	code, err := s.adminStore.CreateOrphanInviteCode(r.Context(),
		req.TargetRole, req.TargetManagedBy, req.TargetRelationshipType, req.IssuedBy,
		req.ArtistName, req.Npub)
	if err != nil {
		log.Printf("Failed to create invite code: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{"invite_code": code})
}

// handleListRegisteredUsers lists registered listeners with pagination.
// GET /api/internal/registered-users?limit=50&offset=0
func (s *Server) handleListRegisteredUsers(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))

	users, total, err := s.adminStore.ListRegisteredUsers(r.Context(), limit, offset)
	if err != nil {
		log.Printf("Failed to list registered users: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	if users == nil {
		users = []storage.RegisteredUser{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"users":  users,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}

// handleNodeStats returns counts for the operator overview.
// GET /api/internal/stats
func (s *Server) handleNodeStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.adminStore.NodeStats(r.Context())
	if err != nil {
		log.Printf("Failed to get node stats: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// handleListPeerRelays returns full state for all configured peer relays.
// GET /api/internal/peer-relays
func (s *Server) handleListPeerRelays(w http.ResponseWriter, r *http.Request) {
	if s.peerStore == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"peers": []interface{}{}})
		return
	}
	peers, err := s.peerStore.ListPeers(r.Context())
	if err != nil {
		log.Printf("Failed to list peer relays: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"peers": peers})
}

// ===== Role Resolution =====

// handleResolveRole returns the role and managed artists for a pubkey.
// GET /api/internal/auth/role?pubkey=hex64
func (s *Server) handleResolveRole(w http.ResponseWriter, r *http.Request) {
	pubkey := r.URL.Query().Get("pubkey")
	if !validateHexPubkey(pubkey) {
		http.Error(w, `{"error": "invalid or missing pubkey parameter"}`, http.StatusBadRequest)
		return
	}

	role, err := s.userStore.ResolveRole(r.Context(), pubkey)
	if err != nil {
		log.Printf("Failed to resolve role for %s: %v", pubkey[:16], err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	if role == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "pubkey not recognized on this node",
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(role)
}

// ===== User Registration =====

// handleRegisterUser registers a fan pubkey for data caching.
// Called by the orchestrator when a fan authenticates.
func (s *Server) handleRegisterUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Pubkey string `json:"pubkey"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error": "invalid request body"}`, http.StatusBadRequest)
		return
	}

	req.Pubkey = strings.TrimSpace(req.Pubkey)
	if !validateHexPubkey(req.Pubkey) {
		http.Error(w, `{"error": "pubkey must be 64 hex characters"}`, http.StatusBadRequest)
		return
	}

	// Convert to npub (simplified — just store hex with npub prefix for now)
	npub := "npub1" + req.Pubkey[:20] // Placeholder — proper bech32 encoding would be better

	_, err := s.userStore.RegisterUser(r.Context(), req.Pubkey, npub)
	if err != nil {
		log.Printf("Failed to register user %s: %v", req.Pubkey, err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("User registered: %s", req.Pubkey)

	// Backfill: if a Kind 0 profile already exists in raw_events (e.g. published
	// during onboarding before registration), copy it into cached_users now.
	go s.userStore.BackfillUserProfile(context.Background(), req.Pubkey, npub)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"pubkey":     req.Pubkey,
		"registered": true,
	})
}

// ===== Phase A: Access control / invite redemption =====

// handleGetInviteCode returns metadata for an invite code (for client preview).
// GET /api/internal/invite-codes/{code}
// Returns 404 if code doesn't exist or has been used.
func (s *Server) handleGetInviteCode(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	if code == "" {
		http.Error(w, `{"error": "code required"}`, http.StatusBadRequest)
		return
	}
	req, err := s.adminStore.GetInviteCode(r.Context(), code)
	if err != nil {
		log.Printf("Failed to get invite code: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	if req == nil {
		http.Error(w, `{"error": "code not found or already used"}`, http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(req)
}

// handleRedeemInviteCode atomically redeems an invite code for a pubkey.
// POST /api/internal/invite-codes/redeem
// Body: { code, pubkey, display_name }
func (s *Server) handleRedeemInviteCode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code        string `json:"code"`
		Pubkey      string `json:"pubkey"`
		DisplayName string `json:"display_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error": "invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.Code == "" || !validateHexPubkey(req.Pubkey) {
		http.Error(w, `{"error": "code and valid pubkey required"}`, http.StatusBadRequest)
		return
	}
	if req.DisplayName == "" {
		req.DisplayName = "(unnamed)"
	}

	result, err := s.adminStore.RedeemInviteCode(r.Context(), req.Code, req.Pubkey, req.DisplayName)
	if err != nil {
		var redeemErr *storage.RedeemErr
		if errors.As(err, &redeemErr) {
			status := http.StatusBadRequest
			switch redeemErr.Code {
			case "concurrent_redeem", "already_managed_by_other", "already_operator", "already_has_artist_role":
				status = http.StatusConflict
			case "invalid_code":
				status = http.StatusNotFound
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(map[string]string{
				"error":  redeemErr.Code,
				"detail": redeemErr.Message,
			})
			return
		}
		log.Printf("Failed to redeem invite: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// handleSetupStatus reports whether the node needs first-run operator claim.
// GET /api/internal/setup-status
func (s *Server) handleSetupStatus(w http.ResponseWriter, r *http.Request) {
	hasOps, err := s.adminStore.HasOperators(r.Context())
	if err != nil {
		log.Printf("Failed to check operators: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	token, err := s.adminStore.GetSetupToken(r.Context())
	if err != nil {
		log.Printf("Failed to read setup token: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{
		"needs_setup": !hasOps && token != "",
	})
}

// handleClaimOperator processes a first-run operator claim.
// POST /api/internal/operators/claim
// Body: { token, pubkey, name }
func (s *Server) handleClaimOperator(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token  string `json:"token"`
		Pubkey string `json:"pubkey"`
		Name   string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error": "invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.Token == "" || !validateHexPubkey(req.Pubkey) {
		http.Error(w, `{"error": "token and valid pubkey required"}`, http.StatusBadRequest)
		return
	}
	if req.Name == "" {
		req.Name = "Node Operator"
	}

	op, err := s.adminStore.ClaimFirstOperator(r.Context(), req.Token, req.Pubkey, req.Name)
	if err != nil {
		var redeemErr *storage.RedeemErr
		if errors.As(err, &redeemErr) {
			status := http.StatusBadRequest
			if redeemErr.Code == "already_claimed" || redeemErr.Code == "already_has_artist_role" {
				status = http.StatusConflict
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(map[string]string{
				"error":  redeemErr.Code,
				"detail": redeemErr.Message,
			})
			return
		}
		log.Printf("Failed to claim operator: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("First operator claimed: %s (%s)", op.Pubkey, op.Name)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(op)
}

// ===== Phase F: Delegation lifecycle (NIP-26) =====

// POST /api/internal/delegations/requests
// Body: {label_pubkey, artist_pubkey, requested_kinds?, requested_duration_days?, note?}
func (s *Server) handleCreateDelegationRequest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		LabelPubkey           string `json:"label_pubkey"`
		ArtistPubkey          string `json:"artist_pubkey"`
		RequestedKinds        string `json:"requested_kinds"`
		RequestedDurationDays int    `json:"requested_duration_days"`
		Note                  string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error": "invalid request body"}`, http.StatusBadRequest)
		return
	}
	if !validateHexPubkey(req.LabelPubkey) || !validateHexPubkey(req.ArtistPubkey) {
		http.Error(w, `{"error": "invalid pubkeys"}`, http.StatusBadRequest)
		return
	}
	id, err := s.delegationStore.CreateRequest(r.Context(),
		req.LabelPubkey, req.ArtistPubkey, req.RequestedKinds, req.RequestedDurationDays, req.Note)
	if err != nil {
		log.Printf("Failed to create delegation request: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]int{"id": id})
}

// GET /api/internal/delegations/requests?artist=... | ?label=...&status=...
func (s *Server) handleListDelegationRequests(w http.ResponseWriter, r *http.Request) {
	artist := r.URL.Query().Get("artist")
	label := r.URL.Query().Get("label")
	status := r.URL.Query().Get("status")

	var requests []storage.DelegationRequest
	var err error
	if artist != "" {
		if !validateHexPubkey(artist) {
			http.Error(w, `{"error": "invalid artist pubkey"}`, http.StatusBadRequest)
			return
		}
		requests, err = s.delegationStore.ListRequestsForArtist(r.Context(), artist, status)
	} else if label != "" {
		if !validateHexPubkey(label) {
			http.Error(w, `{"error": "invalid label pubkey"}`, http.StatusBadRequest)
			return
		}
		requests, err = s.delegationStore.ListRequestsForLabel(r.Context(), label, status)
	} else {
		http.Error(w, `{"error": "artist or label query param required"}`, http.StatusBadRequest)
		return
	}
	if err != nil {
		log.Printf("Failed to list delegation requests: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"requests": requests})
}

// POST /api/internal/delegations/requests/{id}/grant
// Body: {conditions, signature, granter_pubkey}
// granter_pubkey must match the request's artist_pubkey — orchestrator enforces this via NIP-98.
func (s *Server) handleGrantDelegation(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, `{"error": "invalid id"}`, http.StatusBadRequest)
		return
	}
	var body struct {
		Conditions     string `json:"conditions"`
		Signature      string `json:"signature"`
		GranterPubkey  string `json:"granter_pubkey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error": "invalid request body"}`, http.StatusBadRequest)
		return
	}
	if body.Conditions == "" || body.Signature == "" {
		http.Error(w, `{"error": "conditions and signature required"}`, http.StatusBadRequest)
		return
	}

	// Confirm the granter is the artist on the request
	req, err := s.delegationStore.GetRequest(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	if req == nil {
		http.Error(w, `{"error": "request not found"}`, http.StatusNotFound)
		return
	}
	if body.GranterPubkey != "" && body.GranterPubkey != req.ArtistPubkey {
		http.Error(w, `{"error": "granter pubkey does not match request artist"}`, http.StatusForbidden)
		return
	}

	d, err := s.delegationStore.GrantDelegation(r.Context(), id, body.Conditions, body.Signature)
	if err != nil {
		log.Printf("Grant delegation failed: %v", err)
		http.Error(w, `{"error": "`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(d)
}

// POST /api/internal/delegations/requests/{id}/decline
// Body: {granter_pubkey}
func (s *Server) handleDeclineDelegationRequest(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, `{"error": "invalid id"}`, http.StatusBadRequest)
		return
	}
	var body struct {
		GranterPubkey string `json:"granter_pubkey"`
	}
	json.NewDecoder(r.Body).Decode(&body) // optional

	req, err := s.delegationStore.GetRequest(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	if req == nil {
		http.Error(w, `{"error": "request not found"}`, http.StatusNotFound)
		return
	}
	if body.GranterPubkey != "" && body.GranterPubkey != req.ArtistPubkey {
		http.Error(w, `{"error": "granter pubkey does not match request artist"}`, http.StatusForbidden)
		return
	}

	if err := s.delegationStore.DeclineRequest(r.Context(), id); err != nil {
		http.Error(w, `{"error": "`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "declined"})
}

// GET /api/internal/delegations/active?label=PUB
func (s *Server) handleListActiveDelegations(w http.ResponseWriter, r *http.Request) {
	label := r.URL.Query().Get("label")
	if !validateHexPubkey(label) {
		http.Error(w, `{"error": "label pubkey required"}`, http.StatusBadRequest)
		return
	}
	delegations, err := s.delegationStore.ListActiveDelegationsForLabel(r.Context(), label)
	if err != nil {
		log.Printf("Failed to list active delegations: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"delegations": delegations})
}

// GET /api/internal/delegations/{artist}/{label}
func (s *Server) handleGetActiveDelegation(w http.ResponseWriter, r *http.Request) {
	artist := r.PathValue("artist")
	label := r.PathValue("label")
	if !validateHexPubkey(artist) || !validateHexPubkey(label) {
		http.Error(w, `{"error": "invalid pubkeys"}`, http.StatusBadRequest)
		return
	}
	d, err := s.delegationStore.GetActiveDelegation(r.Context(), artist, label)
	if err != nil {
		log.Printf("Failed to get delegation: %v", err)
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}
	if d == nil {
		http.Error(w, `{"error": "no active delegation"}`, http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(d)
}

// POST /api/internal/delegations/{artist}/{label}/revoke
// Body: {granter_pubkey} — must match {artist}
func (s *Server) handleRevokeDelegation(w http.ResponseWriter, r *http.Request) {
	artist := r.PathValue("artist")
	label := r.PathValue("label")
	if !validateHexPubkey(artist) || !validateHexPubkey(label) {
		http.Error(w, `{"error": "invalid pubkeys"}`, http.StatusBadRequest)
		return
	}
	var body struct {
		GranterPubkey string `json:"granter_pubkey"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.GranterPubkey != "" && body.GranterPubkey != artist {
		http.Error(w, `{"error": "granter pubkey must match artist"}`, http.StatusForbidden)
		return
	}
	if err := s.delegationStore.RevokeDelegation(r.Context(), artist, label); err != nil {
		http.Error(w, `{"error": "`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
}
