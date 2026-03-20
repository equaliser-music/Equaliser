package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	"equaliser-relay/internal/storage"
)

// Server serves the REST API endpoints.
type Server struct {
	userStore *storage.UserStore
	mux       *http.ServeMux
}

// NewServer creates a new REST API server.
func NewServer(userStore *storage.UserStore) *Server {
	s := &Server{
		userStore: userStore,
		mux:       http.NewServeMux(),
	}

	// Internal endpoints (Docker network only, not proxied by nginx)
	s.mux.HandleFunc("POST /api/internal/users/register", s.handleRegisterUser)

	// Cache endpoints (proxied by nginx at /api/cache/*)
	s.mux.HandleFunc("GET /api/cache/profiles", s.handleGetProfiles)
	s.mux.HandleFunc("GET /api/cache/profiles/{pubkey}", s.handleGetSingleProfile)
	s.mux.HandleFunc("GET /api/cache/users/{pubkey}/follows", s.handleGetUserFollows)
	s.mux.HandleFunc("GET /api/cache/users/{pubkey}/feed", s.handleGetUserFeed)
	s.mux.HandleFunc("GET /api/cache/threads/{eventID}/external", s.handleThreadExternal)

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
			continue // skip invalid, don't fail entire request
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

	// Build map keyed by pubkey
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
		follows = []string{} // ensure JSON array, not null
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
		events = []storage.FeedEvent{} // ensure JSON array, not null
	}

	setCacheHeaders(w)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"events": events,
	})
}

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
