package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"equaliser-relay/internal/config"
	"equaliser-relay/internal/nostr"
	"equaliser-relay/internal/storage"

	"github.com/coder/websocket"
)

var connectionCounter atomic.Int64

// Handler handles WebSocket connections and NIP-11 requests.
type Handler struct {
	store   *storage.EventStore
	denorm  *storage.DenormParser
	subMgr  *SubscriptionManager
	cfg     *config.Config
	nip11   []byte // pre-built NIP-11 response

	// OnEventStored is called asynchronously after a new event is committed.
	// Used by the syncer for triggered external reply checking.
	OnEventStored func(event *nostr.Event)
}

// NewHandler creates a new relay handler.
func NewHandler(store *storage.EventStore, denorm *storage.DenormParser, subMgr *SubscriptionManager, cfg *config.Config) *Handler {
	h := &Handler{
		store:  store,
		denorm: denorm,
		subMgr: subMgr,
		cfg:    cfg,
	}

	// Pre-build NIP-11 response
	nip11 := map[string]interface{}{
		"name":           cfg.RelayName,
		"description":    cfg.RelayDescription,
		"supported_nips": []int{1, 9, 11, 45},
		"software":       "equaliser-relay",
		"version":        "0.1.0",
		"limitation": map[string]interface{}{
			"max_message_length": cfg.MaxMessageLength,
			"max_subscriptions":  cfg.MaxSubscriptions,
			"max_filters":        cfg.MaxFilters,
			"max_event_tags":     cfg.MaxEventTags,
			"auth_required":      false,
		},
	}
	h.nip11, _ = json.MarshalIndent(nip11, "", "  ")

	return h
}

// Store returns the event store (used by syncer for external reply checking).
func (h *Handler) Store() *storage.EventStore {
	return h.store
}

// ServeHTTP handles incoming HTTP requests.
// NIP-11: If Accept header contains "application/nostr+json", serve relay info document.
// Regular HTTP without Upgrade header: return simple status (for healthchecks).
// Otherwise, upgrade to WebSocket.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// NIP-11: Relay information document
	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "application/nostr+json") {
		w.Header().Set("Content-Type", "application/nostr+json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		w.Write(h.nip11)
		return
	}

	// If no Upgrade header, this is a plain HTTP request (healthcheck, browser, etc.)
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("Equaliser Relay is running. Use a WebSocket client or set Accept: application/nostr+json for relay info."))
		return
	}

	// WebSocket upgrade
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Allow connections from any origin (nginx handles CORS)
	})
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}

	// Use a background context for the WebSocket connection lifecycle.
	// r.Context() is tied to the HTTP request and may be cancelled by the
	// server or reverse proxy after the upgrade completes.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h.handleConnection(ctx, conn)
}

// handleConnection manages a single WebSocket connection.
func (h *Handler) handleConnection(ctx context.Context, ws *websocket.Conn) {
	connID := fmt.Sprintf("conn-%d", connectionCounter.Add(1))

	// Set read limit to match max message length
	ws.SetReadLimit(int64(h.cfg.MaxMessageLength))

	// Create connection with buffered write channel
	connection := &Connection{
		ID:      connID,
		WriteCh: make(chan []byte, 256),
		Done:    make(chan struct{}),
	}

	h.subMgr.RegisterConnection(connection)
	defer func() {
		h.subMgr.UnregisterConnection(connID)
		ws.Close(websocket.StatusNormalClosure, "")
		close(connection.Done)
	}()

	log.Printf("Client connected: %s", connID)

	// Writer goroutine — sends messages from the write channel to the WebSocket
	go func() {
		for {
			select {
			case msg, ok := <-connection.WriteCh:
				if !ok {
					return
				}
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := ws.Write(ctx, websocket.MessageText, msg)
				cancel()
				if err != nil {
					log.Printf("Write error for %s: %v", connID, err)
					return
				}
			case <-connection.Done:
				return
			}
		}
	}()

	// Reader loop
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure ||
				websocket.CloseStatus(err) == websocket.StatusGoingAway {
				log.Printf("Client disconnected: %s", connID)
			} else {
				log.Printf("Read error for %s: %v", connID, err)
			}
			return
		}

		// Check message size
		if len(data) > h.cfg.MaxMessageLength {
			h.sendNotice(connection, "message too large")
			continue
		}

		h.handleMessage(ctx, connection, data)
	}
}

// handleMessage routes incoming messages by type.
func (h *Handler) handleMessage(ctx context.Context, conn *Connection, data []byte) {
	msgType, _, err := nostr.ParseMessage(data)
	if err != nil {
		h.sendNotice(conn, "invalid message: "+err.Error())
		return
	}

	switch msgType {
	case nostr.MsgTypeEvent:
		h.handleEvent(ctx, conn, data)
	case nostr.MsgTypeReq:
		h.handleReq(ctx, conn, data)
	case nostr.MsgTypeClose:
		h.handleClose(conn, data)
	case nostr.MsgTypeCount:
		h.handleCount(ctx, conn, data)
	default:
		h.sendNotice(conn, fmt.Sprintf("unknown message type: %s", msgType))
	}
}

// ProcessResult describes the outcome of processing an inbound event.
type ProcessResult struct {
	Stored   bool   // true if event was written to the database
	Accepted bool   // true if the relay accepted the event (stored or dedup)
	Message  string // reason string for OK message (empty on success)
}

// ProcessInboundEvent runs the full event processing pipeline (validate, policy check,
// store, denorm, notify) without sending an OK response. Used by both the WebSocket
// handler and the peer syncer.
//
// sourceID is passed to NotifyNewEvent to avoid echo. relayURL is logged in event_log.
func (h *Handler) ProcessInboundEvent(ctx context.Context, event *nostr.Event, sourceID string, relayURL string) ProcessResult {
	// Validate event ID and signature
	valid, reason := event.Validate()
	if !valid {
		return ProcessResult{Accepted: false, Message: reason}
	}

	// Check event acceptance policy
	if !h.checkEventPolicy(event) {
		return ProcessResult{Accepted: false, Message: "blocked: not an Equaliser event"}
	}

	// Check if ephemeral — don't store
	if nostr.IsEphemeral(event.Kind) {
		rawJSON, _ := event.MarshalRaw()
		h.subMgr.NotifyNewEvent(event, rawJSON, sourceID)
		return ProcessResult{Accepted: true}
	}

	// Begin transaction
	tx, err := h.store.Pool().Begin(ctx)
	if err != nil {
		log.Printf("Begin transaction failed: %v", err)
		return ProcessResult{Accepted: false, Message: "error: internal"}
	}
	defer tx.Rollback(ctx)

	// Handle replaceable events
	if nostr.IsReplaceableOrParameterised(event.Kind) {
		shouldStore, err := h.store.HandleReplaceable(ctx, tx, event)
		if err != nil {
			log.Printf("Replaceable check failed: %v", err)
			return ProcessResult{Accepted: false, Message: "error: internal"}
		}
		if !shouldStore {
			return ProcessResult{Accepted: false, Message: "duplicate: event is older than current"}
		}
	}

	// Handle NIP-09 deletion (Kind 5)
	if event.Kind == 5 {
		if err := h.store.HandleDeletion(ctx, tx, event); err != nil {
			log.Printf("Deletion handling failed: %v", err)
			return ProcessResult{Accepted: false, Message: "error: internal"}
		}
	}

	// Store event (includes dedup via ON CONFLICT)
	inserted, err := h.store.StoreEvent(ctx, tx, event)
	if err != nil {
		log.Printf("Store event failed: %v", err)
		return ProcessResult{Accepted: false, Message: "error: internal"}
	}
	if !inserted {
		return ProcessResult{Accepted: true, Message: "duplicate:"}
	}

	// Parse into denorm tables (best-effort).
	// Equaliser-tagged events are always parsed. Untagged events are parsed for
	// kinds that use context-aware or known-pubkey acceptance (profiles, follows,
	// feed posts, reactions) — the denorm parser checks registration internally.
	if event.HasEqualiserTag() || event.Kind == 0 || event.Kind == 1 || event.Kind == 3 {
		h.denorm.ParseEvent(ctx, tx, event)
	}

	// Commit
	if err := tx.Commit(ctx); err != nil {
		log.Printf("Commit failed: %v", err)
		return ProcessResult{Accepted: false, Message: "error: internal"}
	}

	// Log the event (async — not in the critical path)
	go h.store.LogEvent(context.Background(), relayURL, event.Kind, event.ID, "inserted")

	// Notify matching subscriptions
	rawJSON, _ := event.MarshalRaw()
	h.subMgr.NotifyNewEvent(event, rawJSON, sourceID)

	// Trigger async post-store callback (e.g. external reply checking)
	if h.OnEventStored != nil {
		go h.OnEventStored(event)
	}

	return ProcessResult{Stored: true, Accepted: true}
}

// handleEvent processes an incoming EVENT message.
func (h *Handler) handleEvent(ctx context.Context, conn *Connection, data []byte) {
	event, err := nostr.ParseEventMessage(data)
	if err != nil {
		h.sendNotice(conn, "invalid EVENT: "+err.Error())
		return
	}

	result := h.ProcessInboundEvent(ctx, event, conn.ID, "local")
	h.sendOK(conn, event.ID, result.Accepted, result.Message)
}

// handleReq processes an incoming REQ message.
func (h *Handler) handleReq(ctx context.Context, conn *Connection, data []byte) {
	subID, filters, err := nostr.ParseReqMessage(data)
	if err != nil {
		h.sendNotice(conn, "invalid REQ: "+err.Error())
		return
	}

	// Check subscription limit
	if h.subMgr.CountSubscriptions(conn.ID) >= h.cfg.MaxSubscriptions {
		h.sendNotice(conn, fmt.Sprintf("too many subscriptions (max %d)", h.cfg.MaxSubscriptions))
		return
	}

	// Check filter count
	if len(filters) > h.cfg.MaxFilters {
		h.sendNotice(conn, fmt.Sprintf("too many filters (max %d)", h.cfg.MaxFilters))
		return
	}

	// Query stored events matching filters
	events, err := h.store.QueryEvents(ctx, filters)
	if err != nil {
		log.Printf("Query failed for sub %s: %v", subID, err)
		h.sendNotice(conn, "error: internal query failure")
		return
	}

	// Send matching events
	for _, rawEvent := range events {
		msg, err := nostr.BuildEventMessage(subID, rawEvent)
		if err != nil {
			log.Printf("Failed to build event message: %v", err)
			continue
		}
		h.send(conn, msg)
	}

	// Send EOSE
	eose, _ := nostr.BuildEOSEMessage(subID)
	h.send(conn, eose)

	// Register subscription for future events
	h.subMgr.AddSubscription(conn.ID, subID, filters)
}

// handleClose processes a CLOSE message.
func (h *Handler) handleClose(conn *Connection, data []byte) {
	subID, err := nostr.ParseCloseMessage(data)
	if err != nil {
		h.sendNotice(conn, "invalid CLOSE: "+err.Error())
		return
	}

	h.subMgr.RemoveSubscription(conn.ID, subID)
}

// handleCount processes a COUNT message (NIP-45).
func (h *Handler) handleCount(ctx context.Context, conn *Connection, data []byte) {
	subID, filters, err := nostr.ParseCountMessage(data)
	if err != nil {
		h.sendNotice(conn, "invalid COUNT: "+err.Error())
		return
	}

	count, err := h.store.CountEvents(ctx, filters)
	if err != nil {
		log.Printf("Count failed: %v", err)
		h.sendNotice(conn, "error: internal count failure")
		return
	}

	msg, _ := nostr.BuildCountMessage(subID, count)
	h.send(conn, msg)
}

// checkEventPolicy checks if an event is allowed by the tiered acceptance policy.
//
// Tiers (applied when EventPolicy is not "open"):
//   - Always accept: events with ["app", "Equaliser"] tag
//   - Strict (Kind 30050, 30051, 30001): requires app tag (rejected if not tagged)
//   - Context-aware (Kind 1, 6, 7, 5): accept if event references an existing event in raw_events
//   - Known-pubkey (Kind 0, 3): accept from pubkeys in node_artists or registered_users
//   - Default: requires ["app", "Equaliser"] tag
func (h *Handler) checkEventPolicy(event *nostr.Event) bool {
	switch h.cfg.EventPolicy {
	case "open":
		return true
	case "hybrid":
		return true // Accept all, but only denorm parse Equaliser-tagged events
	}

	// equaliser_only (default): tiered acceptance
	if event.HasEqualiserTag() {
		return true // Always accept Equaliser-tagged events
	}

	switch event.Kind {
	case 30050, 30051, 30001:
		// Strict: music metadata requires app tag — already checked above
		return false

	case 1:
		// Context-aware: accept replies/threads that reference an existing event.
		// Standalone posts without app tag are rejected (app-tagged events
		// are already accepted above at line 402).
		return h.ReferencesExistingEvent(event)

	case 7, 6, 5:
		// Context-aware: accept if the event references an existing event
		return h.ReferencesExistingEvent(event)

	case 0, 3:
		// Known-pubkey: accept from registered artists or users
		return h.isKnownPubkey(event.PubKey)

	default:
		// All other kinds require app tag — already checked above
		return false
	}
}

// ReferencesExistingEvent checks if an event references (via "e" tags) any event
// already stored in raw_events. Used for context-aware acceptance of replies/reactions.
func (h *Handler) ReferencesExistingEvent(event *nostr.Event) bool {
	eventIDs := event.GetTagValues("e")
	if len(eventIDs) == 0 {
		return false
	}

	for _, refID := range eventIDs {
		exists, err := h.store.EventExists(context.Background(), refID)
		if err != nil {
			log.Printf("Context-aware policy check failed for %s: %v", refID, err)
			continue
		}
		if exists {
			return true
		}
	}
	return false
}

// isKnownPubkey checks if a pubkey exists in node_artists or registered_users.
func (h *Handler) isKnownPubkey(pubkey string) bool {
	known, err := h.store.IsKnownPubkey(context.Background(), pubkey)
	if err != nil {
		log.Printf("Known-pubkey policy check failed for %s: %v", pubkey, err)
		return false
	}
	return known
}

// send writes a message to a connection's write channel.
func (h *Handler) send(conn *Connection, msg []byte) {
	select {
	case conn.WriteCh <- msg:
	default:
		log.Printf("Write channel full for %s, dropping message", conn.ID)
	}
}

// sendOK sends an OK response.
func (h *Handler) sendOK(conn *Connection, eventID string, accepted bool, message string) {
	msg, _ := nostr.BuildOKMessage(eventID, accepted, message)
	h.send(conn, msg)
}

// sendNotice sends a NOTICE message.
func (h *Handler) sendNotice(conn *Connection, message string) {
	msg, _ := nostr.BuildNoticeMessage(message)
	h.send(conn, msg)
}
