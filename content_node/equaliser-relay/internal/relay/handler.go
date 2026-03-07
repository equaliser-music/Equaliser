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

// handleEvent processes an incoming EVENT message.
func (h *Handler) handleEvent(ctx context.Context, conn *Connection, data []byte) {
	event, err := nostr.ParseEventMessage(data)
	if err != nil {
		h.sendNotice(conn, "invalid EVENT: "+err.Error())
		return
	}

	// Validate event ID and signature
	valid, reason := event.Validate()
	if !valid {
		h.sendOK(conn, event.ID, false, reason)
		return
	}

	// Check event acceptance policy
	if !h.checkEventPolicy(event) {
		h.sendOK(conn, event.ID, false, "blocked: not an Equaliser event")
		return
	}

	// Check if ephemeral — don't store
	if nostr.IsEphemeral(event.Kind) {
		// Notify subscribers but don't store
		rawJSON, _ := event.MarshalRaw()
		h.subMgr.NotifyNewEvent(event, rawJSON, conn.ID)
		h.sendOK(conn, event.ID, true, "")
		return
	}

	// Begin transaction
	tx, err := h.store.Pool().Begin(ctx)
	if err != nil {
		log.Printf("Begin transaction failed: %v", err)
		h.sendOK(conn, event.ID, false, "error: internal")
		return
	}
	defer tx.Rollback(ctx)

	// Handle replaceable events
	if nostr.IsReplaceableOrParameterised(event.Kind) {
		shouldStore, err := h.store.HandleReplaceable(ctx, tx, event)
		if err != nil {
			log.Printf("Replaceable check failed: %v", err)
			h.sendOK(conn, event.ID, false, "error: internal")
			return
		}
		if !shouldStore {
			h.sendOK(conn, event.ID, false, "duplicate: event is older than current")
			return
		}
	}

	// Handle NIP-09 deletion (Kind 5)
	if event.Kind == 5 {
		if err := h.store.HandleDeletion(ctx, tx, event); err != nil {
			log.Printf("Deletion handling failed: %v", err)
			h.sendOK(conn, event.ID, false, "error: internal")
			return
		}
	}

	// Store event (includes dedup via ON CONFLICT)
	inserted, err := h.store.StoreEvent(ctx, tx, event)
	if err != nil {
		log.Printf("Store event failed: %v", err)
		h.sendOK(conn, event.ID, false, "error: internal")
		return
	}
	if !inserted {
		h.sendOK(conn, event.ID, true, "duplicate:")
		return
	}

	// Parse into denorm tables (best-effort, only for Equaliser-tagged events)
	if event.HasEqualiserTag() {
		h.denorm.ParseEvent(ctx, tx, event)
	}

	// Commit
	if err := tx.Commit(ctx); err != nil {
		log.Printf("Commit failed: %v", err)
		h.sendOK(conn, event.ID, false, "error: internal")
		return
	}

	// Log the event (async — not in the critical path)
	go h.store.LogEvent(context.Background(), "local", event.Kind, event.ID, "inserted")

	// Notify matching subscriptions
	rawJSON, _ := event.MarshalRaw()
	h.subMgr.NotifyNewEvent(event, rawJSON, conn.ID)

	h.sendOK(conn, event.ID, true, "")
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

// checkEventPolicy checks if an event is allowed by the configured acceptance policy.
func (h *Handler) checkEventPolicy(event *nostr.Event) bool {
	switch h.cfg.EventPolicy {
	case "equaliser_only":
		return event.HasEqualiserTag()
	case "open":
		return true
	case "hybrid":
		return true // Accept all, but only denorm parse Equaliser-tagged events
	default:
		return event.HasEqualiserTag()
	}
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
