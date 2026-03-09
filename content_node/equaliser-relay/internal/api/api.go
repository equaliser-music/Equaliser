package api

import (
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
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

	// Catalogue endpoints (proxied by nginx at /relay/api/catalogue/*)
	s.mux.HandleFunc("GET /api/catalogue/threads/{eventID}/external", s.handleThreadExternal)

	// Health check
	s.mux.HandleFunc("GET /api/health", s.handleHealth)

	return s
}

// Handler returns the HTTP handler for the REST API.
func (s *Server) Handler() http.Handler {
	return s.mux
}

// handleHealth returns a simple health check response.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}

// handleThreadExternal returns the external reply count for a thread root event.
// GET /api/catalogue/threads/{eventID}/external
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

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
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
	if req.Pubkey == "" {
		http.Error(w, `{"error": "pubkey is required"}`, http.StatusBadRequest)
		return
	}

	// Validate hex format (64 char hex = 32 bytes)
	if len(req.Pubkey) != 64 {
		http.Error(w, `{"error": "pubkey must be 64 hex characters"}`, http.StatusBadRequest)
		return
	}
	if _, err := hex.DecodeString(req.Pubkey); err != nil {
		http.Error(w, `{"error": "pubkey must be valid hex"}`, http.StatusBadRequest)
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

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"pubkey":     req.Pubkey,
		"registered": true,
	})
}
